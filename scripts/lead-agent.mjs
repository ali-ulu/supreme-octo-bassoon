#!/usr/bin/env node
// Lead agent: müşteri bulur, web sitesini teknik olarak inceler, e-posta taslağı
// hazırlar; onay verilenleri gönderir. Kaynak: google-maps-scraper-kit çıktıları.
//
//   node scripts/lead-agent.mjs fetch  --query "diş kliniği İstanbul" --depth 2
//   node scripts/lead-agent.mjs import --csv leads.csv
//   node scripts/lead-agent.mjs analyze
//   node scripts/lead-agent.mjs draft
//   node scripts/lead-agent.mjs list
//   node scripts/lead-agent.mjs show <id>
//   node scripts/lead-agent.mjs approve <id>
//   node scripts/lead-agent.mjs send --all            # onaylıları gönderir
//   node scripts/lead-agent.mjs send <id> --dry-run
//
// Tarama, kit'in yerel motorunu (http://localhost:8080, SCRAPER_BASE_URL/SCRAPER_PORT)
// kullanır; motor yoksa kit'ten çıkarılmış CSV'yi import edin. Analiz, scripts/geo-audit.mjs
// in `audit()` motorunu yeniden kullanır. Gönderim: RESEND_API_KEY veya SMTP değişkenleri.
// Tüm durum `.lead-agent/store.json` içinde tutulur. Bağımlılık yok; Node 22+.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { connect as tlsConnect } from "node:tls";
import { randomUUID } from "node:crypto";

import { site, waLink } from "../lib/config.mjs";
import { audit, fetchUrl } from "./geo-audit.mjs";

const VERSION = "1.0.0";
const UA = `Mozilla/5.0 (compatible; ai-ulu-lead-agent/${VERSION}; +https://ai-ulu.com/)`;
const DIR = process.env.LEAD_AGENT_DIR || ".lead-agent";
const STORE = `${DIR}/store.json`;
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

// ── CSV (RFC 4180) ───────────────────────────────────────────────────────────

export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch === "\r") { /* yoksay */ }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "" || true)
    .filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
}

export function normalizeHost(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const withScheme = /^[a-z]+:\/\//i.test(raw) || raw.startsWith("//") ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    return (u.hostname || "").replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

export function extractEmails(value) {
  if (!value) return [];
  let list = value;
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try { list = JSON.parse(value); } catch { /* ayraç olarak kullan */ }
  }
  const text = Array.isArray(list) ? list.join(",") : String(list);
  const found = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  return [...new Set(found.map((e) => e.toLowerCase()))];
}

const NUM = (v) => {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

export function leadFromRow(row, header) {
  const get = (...names) => {
    for (const name of names) {
      const idx = header.get(name);
      if (idx !== undefined && row[idx] != null && String(row[idx]).trim() !== "") return String(row[idx]).trim();
    }
    return "";
  };
  const name = get("title", "name", "business_name");
  const phone = get("phone", "phoneNumber", "phone_number");
  let address = get("address", "full_address", "complete_address");
  if (!address) {
    const parts = [get("neighborhood"), get("street"), get("city"), get("postal_code")].filter(Boolean);
    address = parts.join(", ");
  }
  if (!name) return null;
  const website = get("website", "site", "url");
  return {
    id: "",
    name,
    phone,
    emails: extractEmails(get("emails", "email")),
    website,
    category: get("category", "type", "categories"),
    address,
    reviewRating: NUM(get("review_rating", "rating", "reviews_stars")),
    reviewCount: NUM(get("review_count", "reviews", "reviews_count")),
    telegram: get("telegram") || "",
    facebook: get("facebook") || "",
    instagram: get("instagram") || "",
    sourceQuery: get("query", "search", "input_id") || "",
    createdAt: new Date().toISOString(),
  };
}

export function importRows(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return { leads: [], skipped: 0 };
  const header = new Map(rows[0].map((name, i) => [name.trim().toLowerCase(), i]));
  const leads = [], seen = new Set();
  let skipped = 0;
  for (const row of rows.slice(1)) {
    if (row.length < 2 && !row[0]) { skipped++; continue; }
    const lead = leadFromRow(row, header);
    if (!lead) { skipped++; continue; }
    const key = normalizeHost(lead.website) || `${lead.name.toLowerCase()}|${lead.phone}`;
    if (!key || seen.has(key)) { skipped++; continue; }
    seen.add(key);
    leads.push(lead);
  }
  return { leads, skipped };
}

// ── Analiz: dönüşüm / müşteri kaybı taraması ────────────────────────────────

export function scanConversion(html, finalUrl) {
  const text = String(html || "");
  const https = /^https:/i.test(finalUrl || "");
  const hasWhats = /(wa\.me|api\.whatsapp\.com|whatsapp\.com|chat\.whatsapp)/i.test(text);
  const hasTel = /href=["']tel:/i.test(text);
  const hasForm = /<form\b/i.test(text);
  const hasEmail = /href=["']mailto:/i.test(text);
  const viewport = /<meta[^>]+viewport[^>]+width\s*=\s*device-width/i.test(text);
  const lang = (text.match(/<html[^>]*\blang=["']([^"']+)["']/i) || [])[1] || "";
  return { https, hasWhats, hasTel, hasForm, hasEmail, viewport, lang };
}

export function lossPoints(analysis) {
  const conv = analysis.conversion || {};
  const auditRecs = (analysis.recommendations || [])
    .filter((r) => r.severity === "critical" || r.severity === "high")
    .map((r) => ({ point: `${r.title}: ${r.evidence || ""}`.replace(/\s+/g, " ").trim(), fix: r.fix || "" }));
  const convRecs = [];
  if (conv.https === false) convRecs.push({ point: "Site HTTPS değil; tarayıcı 'güvenli değil' uyarısı ile ziyaretçiyi kaybediyor.", fix: "TLS sertifikası kurun (Cloudflare/Let's Encrypt, ücretsiz)." });
  if (conv.hasWhats === false && conv.hasTel === false) convRecs.push({ point: "Tek dokunuşla iletişim yok: ne WhatsApp ne de tıklanabilir telefon bağlantısı var; ilgilenen ziyaretçi iletişim kurmadan çıkıyor.", fix: "Her sayfada tek dokunuşla WhatsApp ve arama bağlantısı." });
  if (conv.hasTel === false && conv.hasWhats === true) convRecs.push({ point: "Telefon bağlantısı yok; WhatsApp'tan görmeyen ziyaretçi arama yapamıyor.", fix: "tıkla-ara (tel:) bağlantısı ekleyin." });
  if (conv.hasForm === false) convRecs.push({ point: "İletişim formu yok; gelen ziyaretçiyi kaydetmenin yolu yok.", fix: "Doğrulamalı bir iletişim formu ekleyin." });
  if (conv.viewport === false) convRecs.push({ point: "Mobil görünüm ayarı (viewport) eksik; telefon açan müşteri yatay kaydırma ile uğraşıyor ve çıkıyor.", fix: "Duyarlı (mobile-first) tasarım." });
  return [...auditRecs, ...convRecs];
}

export function chooseRoute(lead, analysis) {
  if (!lead.website) return "no-site";
  if (!analysis || analysis.unreachable) return "unreachable";
  const blocking = (analysis.recommendations || []).some((r) => r.severity === "critical" || r.severity === "high");
  if (analysis.score >= 85 && !blocking) return "ai-visibility";
  return "fix";
}

export function topIssues(analysis, route) {
  if (route === "unreachable") return [{ point: "Site açılmıyor", fix: "Alan adı, DNS ve sunucu ayarlarını kontrol edin." }];
  const points = lossPoints(analysis);
  return points.slice(0, 4);
}

const CITY = (lead) => {
  const m = String(lead.address || "").split(",").map((s) => s.trim()).filter(Boolean);
  return m.length > 1 ? m[m.length - 2] : m[0] || "";
};

export function buildDraft(lead, analysis, routeArg) {
  const route = routeArg || chooseRoute(lead, analysis);
  const city = CITY(lead);
  const contact = lead.emails[0] || lead.phone || "";
  const first = String(lead.name || "").split(/\s+/)[0];
  const checkup = "https://ai-ulu.com/checkup/";
  const call = waLink(`Merhaba, ${lead.name} için görüşme talep ediyorum.`);
  const bullets = (issues) => issues.map((i) => `• ${i.point}\n  Öneri: ${i.fix}`).join("\n");
  const intro = city ? `Merhaba ${first}, ${city} içindeki kaydınızı görürken sitenize baktım.` : `Merhaba ${first}, kaydınızı görürken sitenize baktım.`;

  let subject;
  let body;
  if (route === "no-site") {
    subject = `${lead.name} için müşteri getiren bir web sitesi${city ? ` (${city})` : ""}`;
    body = `${intro}

Google Haritalar'da ${lead.name} karşısıma çıktı${lead.reviewCount ? `; ${lead.reviewCount} yorumluk gerçek bir itibarınız var${lead.reviewRating ? ` ve puanınız ${lead.reviewRating}★` : ""}` : ""}. Ama sizi bulan biri sizinle iletişim kurabileceği bir web sayfası göremiyor ve bu araştırmayı yapan müşteriyi rakibinize kaydırıyor.

ai-ulu olarak yaptığımız iş tek cümlede: sıfırdan tasarlanan, Google'da ve ChatGPT/Gemini gibi yapay zekâ aramalarında bulunan, tek dokunuşla WhatsApp'a bağlanan siteler.

  • Özgün tasarım — hazır şablon değil, işletmenize göre kodlanır
  • Teknik SEO + yapay zekâ görünürlüğü ilk günden dahil
  • Her sayfada tek dokunuşla WhatsApp ve arama
  • Alan adı ve kod sizden; yayından sonra ölçer, düzeltiriz

Ücretsiz 30 dakikalık görüşmede hedefi konuşur, ilk haftadan tıklanabilir önizleme veririz. Görüşmeden sonra 24 saat içinde yazılı teklif; tanıtım siteleri 5.000 ₺'den başlar.

Uygun olduğunuz kısa bir zaman varsa buradan yazmanız yeterli: ${call}${lead.phone ? `\nTelefon: ${lead.phone}` : ""}

Ali Ulu — ai-ulu
${site.url} · ${site.email}`;
  } else if (route === "unreachable") {
    subject = `${lead.name}: web siteniz şu an açılmıyor`;
    body = `${intro}

Sitenize şu an ulaşılamıyor (${analysis?.error || "isteğe yanıt vermedi"}); artık müşteri kaybetmenin en pahalı hâli bu: arayan kişi sayfayı göremeden çıkıyor ve Google da aynı sonucu görüyor.

Teknik SEO, hız ve yapay zekâ görünürlüğü ilk günden içinde olan bir siteyi saniyeler içinde açılır hâle getiriyoruz. Ücretsiz ve bağlayıcı olmayan kısa bir değerlendirmeyi ${checkup} adresinden kendiniz de çalıştırabilirsiniz.

Uygun olursanız 30 dakikada sorunları birlikte görürüz: ${call}

Ali Ulu — ai-ulu
${site.url} · ${site.email}`;
  } else {
    const issues = topIssues(analysis, route);
    const aiAngle = route === "ai-visibility";
    subject = aiAngle
      ? `${lead.name}: siteniz iyi durumda; yapay zekâ aramalarında eksik kaldığı yerler`
      : `${lead.name}: sitenizin teknik özeti (ücretsiz kontrol)`;
    const scoreLine = aiAngle ? "" : `Ücretsiz kontrolde sitem ${analysis?.score ?? "?"}/100 (${analysis?.grade ?? "?"}).`;
    body = `${intro}
${scoreLine}

Bulduğum başlıca noktalar:
${bullets(issues)}
${aiAngle ? `\nMüşteriler artık yalnızca Google'da aramıyor; ChatGPT, Gemini ve Perplexity de öneriliyor. Siteniz bu motorların okuyamadığı durumda sizi önermiyor; biz bu katmanı site kurarken ilk günden dahil ediyoruz (llms.txt, şema, temiz HTML).` : `\nBunlar her biri siteden gelen talebi azaltıyor: bulunmuyorsanız gelmiyorsunuz, gelip anlayamıyorsanız aramadan çıkıyorsunuz. Bu kontrolü ${checkup} adresinden dilediğiniz zaman kendiniz de çalıştırabilirsiniz.`}

Bunları nasıl kapatacağınızı 30 dakikalık ücretsiz görüşmede anlatırım; siz yine de kendiniz çözebilirsiniz. Yazmanız yeterli: ${call}

Ali Ulu — ai-ulu
${site.url} · ${site.email}`;
  }
  return { route, to: lead.emails[0] || "", contact, subject, body };
}

// ── Durum ───────────────────────────────────────────────────────────────────

const emptyStore = () => ({ leads: {}, drafts: {}, meta: { version: VERSION, createdAt: new Date().toISOString() } });

async function loadStore() {
  if (!existsSync(STORE)) return emptyStore();
  try {
    const data = JSON.parse(await readFile(STORE, "utf8"));
    return { ...emptyStore(), ...data };
  } catch (error) {
    throw new Error(`${STORE} okunamadı: ${error.message}`);
  }
}

async function saveStore(store) {
  await mkdir(DIR, { recursive: true });
  await writeFile(STORE, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

const draftId = () => randomUUID().slice(0, 8);

// ── Kit motoru istemcisi ────────────────────────────────────────────────────

async function engineBase(explicit) {
  const base = explicit || process.env.SCRAPER_BASE_URL || `http://localhost:${process.env.SCRAPER_PORT || "8080"}`;
  return base.replace(/\/+$/, "");
}

async function engineRequest(base, path, options = {}) {
  const res = await fetch(`${base}${path}`, { ...options, headers: options.headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`engine ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

async function createJob(base, args) {
  const keywords = [];
  if (args.keywordsFile) {
    keywords.push(...(await readFile(args.keywordsFile, "utf8")).split("\n").map((k) => k.trim()).filter(Boolean));
  }
  if (args.query) keywords.push(args.query);
  if (!keywords.length) throw new Error("Anahtar kelime yok: --query veya --keywords-file verin.");
  const body = {
    name: (keywords[0] || "lead").slice(0, 200),
    keywords,
    lang: args.lang || "tr",
    country: args.country || "tr",
    lat: args.lat != null ? String(args.lat) : "",
    lon: args.lon != null ? String(args.lon) : "",
    depth: args.depth ?? 2,
    max_time: args.maxTime ?? (Number(process.env.SCRAPER_MAX_TIME) || 600),
    email: args.noEmail ? false : true,
    reviews_max: 3,
  };
  const text = await engineRequest(base, "/api/v1/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return JSON.parse(text).id;
}

async function waitForJob(base, id) {
  for (let i = 0; ; i++) {
    const status = JSON.parse(await engineRequest(base, `/api/v1/jobs/${id}`));
    const p = status.Progress || {};
    process.stdout.write(`\r▶ ${status.Status} adım: ${p.keywords_done ?? "?"}/${p.keywords_total ?? "?"}, yer: ${p.places ?? "?"}  `);
    if (status.Status === "ok" || status.Status === "error" || status.Status === "stopped") {
      process.stdout.write("\n");
      if (status.Status !== "ok") throw new Error(`İş '${status.Status}' ile bitti: ${status.Error || "bilinmiyor"}`);
      return status;
    }
    if (i > 2400) throw new Error("Zaman aşımı: iş 2 saat içinde bitmedi.");
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function engineCsv(base, id) {
  return engineRequest(base, `/api/v1/jobs/${id}/download`);
}

// ── Analiz ──────────────────────────────────────────────────────────────────

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

// ── MIME / gönderim ─────────────────────────────────────────────────────────

export const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
export const rfc2047 = (s) => `=?UTF-8?B?${b64(s)}?=`;

export function buildMime({ from, to, subject, body, messageId }) {
  if (!from) throw new Error("Gönderen adresi yok (LEAD_AGENT_FROM / site.email).");
  if (!to) throw new Error("Alıcı adresi yok.");
  const lines = body.split("\n").map((l) => l.replace(/^From /, ">From ")).map((l) => (l.length > 900 ? l.slice(0, 900) : l));
  const date = new Date().toUTCString().replace("GMT", "+0000");
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject.includes("Non-ASCII") || /[^\x20-\x7E]/.test(subject) ? rfc2047(subject) : subject}`,
    `Date: ${date}`,
    `Message-ID: <${messageId || `${Date.now()}.${Math.random().toString(36).slice(2)}@lead-agent`}>`,
    "MIME-Version: 1.0",
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    "",
    ...chunk75(b64(lines.join("\r\n"))),
    "",
  ].join("\r\n");
}

const chunk75 = (s) => s.match(/.{1,76}/g) || [];

async function sendViaResend({ from, to, subject, body, apiKey }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text: body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Resend ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text).id || "resend";
}

function smtpLine(socket, expected = 250) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d.toString("utf8");
      if (/\r?\n$/.test(buf)) {
        socket.removeListener("data", onData);
        socket.removeListener("error", onErr);
        const code = Number(buf.slice(0, 3));
        if (code !== expected && code !== 354 && code !== 235 && code !== 334 && !(code >= 200 && code < 400)) {
          reject(new Error(`SMTP ${code}: ${buf.trim().slice(0, 300)}`));
        } else resolve(buf.trim());
      }
    };
    const onErr = (e) => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onErr);
      reject(e);
    };
    socket.on("data", onData);
    socket.on("error", onErr);
  });
}

async function sendViaSmtp({ from, to, subject, body, host, port, user, pass }) {
  const socket = tlsConnect({ host, port, servername: host });
  await new Promise((resolve, reject) => {
    socket.once("secureConnect", resolve);
    socket.once("error", reject);
    setTimeout(() => reject(new Error("SMTP bağlantısı zaman aşımına uğradı.")), 30_000);
  });
  const say = async (line, expected) => {
    if (line !== undefined) socket.write(`${line}\r\n`);
    return smtpLine(socket, expected);
  };
  await say(undefined);
  await say(`EHLO lead-agent.ai-ulu.com`, 250);
  if (user) {
    await say("AUTH LOGIN", 334);
    await say(b64(user), 334);
    await say(b64(pass || ""), 235);
  }
  await say(`MAIL FROM:<${from.match(/<(.+)>/)?.[1] || from}>`, 250);
  await say(`RCPT TO:<${to}>`, 250);
  await say("DATA", 354);
  await say(`${buildMime({ from, to, subject, body })}\r\n.`, 250);
  await say("QUIT", 221).catch(() => {});
  socket.end();
}

async function sendDraft(draft, { dryRun }) {
  const fromEnv = process.env.LEAD_AGENT_FROM || `${site.owner} <${site.email}>`;
  const to = draft.to || "";
  if (!to) throw new Error(`${draft.id}: alıcı e-postası yok (lead'in e-postası bulunamadı; telefon üzerinden iletişim kurun).`);
  const args = { from: fromEnv, to, subject: draft.subject, body: draft.body };
  if (dryRun) {
    console.log(buildMime({ ...args, messageId: undefined }));
    return "dry-run";
  }
  if (process.env.RESEND_API_KEY) return sendViaResend({ ...args, apiKey: process.env.RESEND_API_KEY });
  if (process.env.SMTP_HOST) {
    return sendViaSmtp({
      ...args,
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 465,
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    });
  }
  throw new Error("Gönderim yapılandırılmadı: RESEND_API_KEY veya SMTP_HOST gerekli.");
}

// ── CLI ─────────────────────────────────────────────────────────────────────

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
  console.log(`isletme: ${lead.name} · ${lead.category || ""} · ${lead.address || ""}`);
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

function addLeads(store, leads, skipped, source) {
  let added = 0, merged = 0;
  for (const lead of leads) {
    const host = normalizeHost(lead.website);
    const key = host || `${lead.name.toLowerCase()}|${lead.phone}`;
    const existing = Object.values(store.leads).find((l) => (normalizeHost(l.website) || `${l.name.toLowerCase()}|${l.phone}`) === key);
    if (existing) {
      merged++;
      for (const k of ["phone", "category", "address"]) if (!existing[k] && lead[k]) existing[k] = lead[k];
      if (!existing.emails.length && lead.emails.length) existing.emails = lead.emails;
      existing.sourceQuery = existing.sourceQuery || lead.sourceQuery;
    } else {
      store.leads[randomUUID()] = { ...lead, websiteHost: host || "", source };
      added++;
    }
  }
  console.log(`▶ ${added} yeni lead, ${merged} mevcut, ${skipped} atlanan satır.`);
  return store;
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
