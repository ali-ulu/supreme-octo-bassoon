// Pure core: CSV/lead parsing, conversion scan, routes and email drafts.
// No I/O — everything here is a pure function of its arguments, which is what
// the Rust port (rust/lead-agent-rs) mirrors unit-for-unit.
//
//   node scripts/lead-agent.mjs fetch  --query "diş kliniği İstanbul" --depth 2
//   node scripts/lead-agent.mjs analyze
//   node scripts/lead-agent.mjs draft
//   node scripts/lead-agent.mjs list | show <id> | approve <id> | send --all
//
// Tarama, kit'in yerel motorunu (http://localhost:8080, SCRAPER_BASE_URL/SCRAPER_PORT)
// kullanır; motor yoksa kit'ten çıkarılmış CSV'yi import edin. Analiz, scripts/geo-audit.mjs
// in `audit()` motorunu yeniden kullanır. Gönderim: RESEND_API_KEY veya SMTP değişkenleri.
// Tüm durum `.lead-agent/store.json` içinde tutulur.

import { site, waLink } from "./config.mjs";

// >>> rust-anything: lead-agent-rs is on. `rust-anything disable ../rust/lead-agent-rs` removes this block.
// @ts-ignore
const __rustAnything_lead_agent_rs = ((p) => p && p.env.RUST_ANYTHING_MODE !== 'old' && p.env.RUST_ANYTHING_UNIT_LEAD_AGENT !== 'original' && (() => { try { const m = p.getBuiltinModule('node:module'); const at = p.getBuiltinModule('node:path').join(import.meta.dirname, "../rust/lead-agent-rs/index.cjs"); return m.createRequire(at)(at) } catch (e) { if (p.env.RUST_ANYTHING_MODE === 'new') throw e } })())(globalThis.process)
// @ts-ignore
if (__rustAnything_lead_agent_rs) { parseCsvRows = __rustAnything_lead_agent_rs.parseCsvRows; normalizeHost = __rustAnything_lead_agent_rs.normalizeHost; extractEmails = __rustAnything_lead_agent_rs.extractEmails; leadFromRow = __rustAnything_lead_agent_rs.leadFromRow; importRows = __rustAnything_lead_agent_rs.importRows; scanConversion = __rustAnything_lead_agent_rs.scanConversion; lossPoints = __rustAnything_lead_agent_rs.lossPoints; chooseRoute = __rustAnything_lead_agent_rs.chooseRoute; topIssues = __rustAnything_lead_agent_rs.topIssues; buildDraft = __rustAnything_lead_agent_rs.buildDraft; buildMime = __rustAnything_lead_agent_rs.buildMime }
// <<< rust-anything: lead-agent-rs

export const VERSION = "1.0.0";

// ── CSV (RFC 4180) ────────────────────────────────────────────────────────────

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

// ── Analiz: dönüşüm / müşteri kaybı taraması ─────────────────────────────────

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

// ── MIME ─────────────────────────────────────────────────────────────────────

export const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
export const rfc2047 = (s) => `=?UTF-8?B?${b64(s)}?=`;

export function buildMime({ from, to, subject, body, messageId = undefined }) {
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
