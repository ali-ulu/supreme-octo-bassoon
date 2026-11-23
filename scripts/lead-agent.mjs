#!/usr/bin/env node
// Lead agent CLI: scan → audit → draft → approval → send. Orchestration only;
// the pure core, store, engine client and mailer live in lib/.

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { VERSION, parseCsvRows, normalizeHost, extractEmails, leadFromRow, importRows, scanConversion, lossPoints, chooseRoute, topIssues, buildDraft, b64, rfc2047, buildMime } from "../lib/agent-core.mjs";
import { STORE, loadStore, saveStore, draftId, addLeads } from "../lib/store.mjs";
import { engineBase, createJob, waitForJob, engineCsv } from "../lib/engine.mjs";
import { sendDraft } from "../lib/mailer.mjs";
import { site } from "../lib/config.mjs";
import { audit, fetchUrl } from "./geo-audit.mjs";

export { parseCsvRows, normalizeHost, extractEmails, leadFromRow, importRows, scanConversion, lossPoints, chooseRoute, topIssues, buildDraft, b64, rfc2047, buildMime };

const UA = `Mozilla/5.0 (compatible; ai-ulu-lead-agent/${VERSION}; +https://ai-ulu.com/)`;
const AUDIT_TIMEOUT = 12_000;
const AUDIT_MAX_PAGES = 3;

const USAGE = `lead-agent v${VERSION} — lead bulma, site analizi ve onaylı e-posta gönderimi

Komutlar:
  fetch   --query "diş kliniği İstanbul" [--depth 2] [--max-time 600] [--engine http://localhost:8080]
          [--keywords-file FILE] [--lang tr] [--country tr] [--lat <lat> --lon <lon>]
          Kit motorunda tarama başlatır (veya bekleyen işi indirir) ve CSV'yi içe aktarır.
  import  --csv FILE    Kit'in CSV çıktısını lead listesine ekler.
  analyze [--limit N]   Her lead için site denetimi (site yoksa teklif rotası işaretlenir).
  draft    [--id ID]    Analizden e-posta taslakları üretir.
  list    [--status draft|approved|sent|rejected|skipped]  Özet tablo.
  show    <id>          Taslağı tam metin olarak gösterir.
  approve <id>          Taslağı gönderime onaylar.  reject <id>  |  skip <id>
  send    [id ... | --all] [--dry-run]  Yalnızca approved taslakları gönderir.

Gönderim (env):
  RESEND_API_KEY + RESEND_FROM adı@ai-ulu.com  — Resend HTTP API
  SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS      — doğrudan SMTP (STARTTLS)
  LEAD_AGENT_FROM "Ad <posta@sunucu>"          (varsayılan: ${site.owner} <${site.email}>)

Kit motoru: SCRAPER_BASE_URL veya SCRAPER_PORT (varsayılan 8080).
Veriler: ${STORE} (.gitignore'da). Her mesajı yalnızca kendi onayınızla gönderin;
KVKK ve alıcının izni sizin sorumluluğunuzdadır.
`;

// ── Analiz ───────────────────────────────────────────────────────────────────

async function analyzeLead(lead, options = {}) {
  if (!lead.website) return { route: "no-site", analyzedAt: new Date().toISOString() };
  const url = /^[a-z]+:\/\//i.test(lead.website) ? lead.website : `https://${lead.website}`;
  try {
    const result = await audit(url, { maxPages: AUDIT_MAX_PAGES, timeout: AUDIT_TIMEOUT, userAgent: UA, ...options });
    if (result.score === 0) {
      const detail = (result.recommendations || [])[0]?.evidence || "site açılmadı";
      return { route: "unreachable", unreachable: true, score: 0, grade: "F", error: detail, recommendations: result.recommendations, analyzedAt: new Date().toISOString() };
    }
    const res = await fetchUrl(url, { timeout: AUDIT_TIMEOUT, userAgent: UA, maxBytes: 1_500_000 });
    const conversion = res.ok ? scanConversion(res.body, res.finalUrl || result.url) : {};
    return {
      route: chooseRoute(lead, result),
      score: result.score,
      grade: result.grade,
      coverage: result.coverage,
      categories: (result.categories || []).map((c) => ({ id: c.id, label: c.label, points: c.points, max: c.max, score: c.score })),
      recommendations: (result.recommendations || []).slice(0, 8),
      conversion,
      analyzedAt: new Date().toISOString(),
    };
  } catch (error) {
    return { route: "unreachable", unreachable: true, error: error.message.slice(0, 200), analyzedAt: new Date().toISOString() };
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) { out[key] = true; if (next?.startsWith("--")) i--; }
      else out[key] = next;
    } else out._.push(arg);
  }
  return out;
}

function shorten(text, n = 64) {
  const one = String(text || "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function printList(store, statusFilter) {
  const rows = Object.values(store.drafts)
    .filter((d) => !statusFilter || d.status === statusFilter)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  if (!rows.length) { console.log(`Taslak yok${statusFilter ? ` (durum: ${statusFilter})` : ""}.`); return; }
  const counts = {};
  for (const d of Object.values(store.drafts)) counts[d.status] = (counts[d.status] || 0) + 1;
  console.log(`Durum: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")}\n`);
  for (const d of rows) {
    const lead = store.leads[d.leadId] || {};
    const siteNote = d.route === "no-site" ? "[site yok]" : d.route === "unreachable" ? "[site açılmıyor]" : d.route === "ai-visibility" ? "[AI görünürlük]" : `[${d.score ?? "?"}/100]`;
    console.log(`${d.id}  ${d.status.padEnd(9)} ${siteNote.padEnd(18)} ${shorten(lead.name, 28).padEnd(28)} ${lead.emails[0] || lead.phone || "—"}  ${lead.category || ""}`);
  }
}

function printDraft(store, id) {
  const d = store.drafts[id];
  if (!d) throw new Error(`Taslak bulunamadı: ${id}`);
  const lead = store.leads[d.leadId] || {};
  console.log(`id: ${d.id}   durum: ${d.status}   rota: ${d.route}   skor: ${d.score ?? "—"}   onay: ${d.approvedAt || "—"}   gönderim: ${d.sentAt || "-"}`);
  console.log(`işletme: ${lead.name} · ${lead.category || ""} · ${lead.address || ""}`);
  console.log(`iletişim: ${d.to || "e-posta yok"} ${lead.phone ? `· tel: ${lead.phone}` : ""}\n`);
  console.log(`Konu: ${d.subject}\n`);
  console.log(d.body);
}

async function cmdFetch(args, store) {
  const base = await engineBase(args.engine);
  let id = args.jobId;
  if (!id) {
    id = await createJob(base, args);
    console.log(`▶ İş oluşturuldu: ${id}`);
  }
  await waitForJob(base, id);
  const csv = await engineCsv(base, id);
  const { leads, skipped } = importRows(csv);
  return addLeads(store, leads, skipped, `kit:${id}`);
}

async function cmdImport(args, store) {
  if (!args.csv) throw new Error("CSV gerekli: import --csv leads.csv");
  const text = await readFile(args.csv, "utf8");
  const { leads, skipped } = importRows(text);
  return addLeads(store, leads, skipped, args.csv);
}

async function cmdAnalyze(args, store) {
  const leads = Object.values(store.leads)
    .filter((l) => !l.analysis || args.force)
    .slice(0, Number(args.limit) || 1000);
  if (!leads.length) { console.log("Analiz bekleyen lead yok."); return store; }
  let done = 0;
  for (const lead of leads) {
    done++;
    process.stdout.write(`▶ (${done}/${leads.length}) ${shorten(lead.name, 40)} → `);
    const analysis = await analyzeLead(lead);
    lead.analysis = analysis;
    console.log(analysis.route === "no-site" ? "site yok" : `${analysis.score ?? "?"}/100 ${analysis.grade || ""} · ${analysis.route}`);
  }
  return store;
}

function makeDrafts(store) {
  let made = 0, updated = 0;
  for (const [leadId, lead] of Object.entries(store.leads)) {
    if (!lead.analysis) continue;
    const { route, to, subject, body } = buildDraft(lead, lead.analysis);
    const existing = Object.values(store.drafts).find((d) => d.leadId === leadId);
    if (existing) {
      if (existing.status === "draft") {
        Object.assign(existing, { route, to, subject, body, score: lead.analysis.score ?? null, updatedAt: new Date().toISOString() });
        updated++;
        console.log(`~ ${existing.id} ${route.padEnd(14)} ${shorten(lead.name, 28)} ${to || lead.phone || "—"}  ${shorten(subject, 56)}`);
      }
      continue;
    }
    const id = draftId();
    store.drafts[id] = {
      id, leadId, route, to, subject, body,
      score: lead.analysis.score ?? null,
      status: "draft",
      createdAt: new Date().toISOString(),
      approvedAt: null, sentAt: null, error: null,
    };
    made++;
    console.log(`+ ${id} ${route.padEnd(14)} ${shorten(lead.name, 28)} ${to || lead.phone || "—"}  ${shorten(subject, 56)}`);
  }
  if (!made && !updated) console.log("Yeni taslak yok.");
  return store;
}

async function cmdSend(args, store) {
  const dryRun = Boolean(args.dryRun);
  const ids = args.all
    ? Object.values(store.drafts).filter((d) => d.status === "approved").map((d) => d.id)
    : args._.filter((x) => x !== "send");
  if (!ids.length) { console.log("Onaylı taslak yok. approve <id> ile onay verin."); return store; }
  let sent = 0, failed = 0;
  for (const id of ids) {
    const d = store.drafts[id];
    if (!d) { console.error(`✗ bulunamadı: ${id}`); failed++; continue; }
    if (d.status !== "approved" && !dryRun) { console.error(`✗ ${id}: onay bekliyor (şu an ${d.status}); önce approve kullanın.`); failed++; continue; }
    try {
      const ref = await sendDraft(d, { dryRun });
      if (!dryRun) {
        d.status = "sent";
        d.sentAt = new Date().toISOString();
        d.sentRef = String(ref);
      }
      sent++;
      console.log(`✓ ${id} → ${d.to || "—"}${dryRun ? " (dry-run)" : ""}`);
    } catch (error) {
      d.error = error.message.slice(0, 300);
      failed++;
      console.error(`✗ ${id}: ${error.message}`);
    }
  }
  console.log(`\n▶ Gönderilen: ${sent}, hatalı: ${failed}${dryRun ? " (dry-run)" : ""}.`);
  return store;
}

async function main() {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    process.exit(command ? 0 : 1);
  }
  const args = parseArgs(rest);
  const store = await loadStore();
  let out = store;
  try {
    switch (command) {
      case "fetch": out = await cmdFetch(args, store); break;
      case "import": out = await cmdImport(args, store); break;
      case "analyze": out = await cmdAnalyze(args, store); break;
      case "draft": out = makeDrafts(store); break;
      case "list": printList(store, args.status); break;
      case "show": printDraft(store, String(args._[0] || "")); break;
      case "approve":
      case "reject":
      case "skip": {
        const id = String(args._[0] || "");
        const d = store.drafts[id];
        if (!d) throw new Error(`Taslak bulunamadı: ${id}`);
        d.status = command === "approve" ? "approved" : command === "reject" ? "rejected" : "skipped";
        d.approvedAt = command === "approve" ? new Date().toISOString() : d.approvedAt;
        console.log(`✓ ${id} → ${d.status}`);
        out = store;
        break;
      }
      case "send": out = await cmdSend(args, store); break;
      case "status": printList(store, null); break;
      default: console.log(USAGE); process.exit(1);
    }
    if (command !== "show" && command !== "help") await saveStore(out);
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
