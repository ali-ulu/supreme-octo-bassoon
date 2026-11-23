import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCsvRows,
  importRows,
  normalizeHost,
  extractEmails,
  leadFromRow,
  scanConversion,
  lossPoints,
  chooseRoute,
  topIssues,
  buildDraft,
  b64,
  rfc2047,
  buildMime,
} from "../scripts/lead-agent.mjs";

const KIT_HEADER = [
  "input_id", "link", "title", "category", "address", "open_hours", "popular_times", "website",
  "phone", "plus_code", "review_count", "review_rating", "reviews_per_rating", "latitude",
  "longitude", "cid", "status", "descriptions", "reviews_link", "thumbnail", "timezone",
  "price_range", "data_id", "street_view_url", "place_id", "images", "reservations",
  "order_online", "menu", "owner", "complete_address", "credit_cards_accepted", "about",
  "user_reviews", "user_reviews_extended", "emails",
].join(",");

const KIT_ROW = [
  "1", "https://maps.google.com/?cid=1", "Klinik Diş", "Diş kliniği", '"Nişantaşı, İstanbul"',
  "", "", "klinikdis.com", "+905079581642", "", "41", "4.6", "", "41.03", "28.99", "1",
  "Açık", "", "", "", "", "", "", "", "", "", "", "", "", "", '"Nişantaşı, İstanbul"',
  "", "", "", "", '"bilgi@klinikdis.com,randevu@klinikdis.com"',
].join(",");

const LEAD_HEADER = "title,phone,emails,website,category,address,review_rating,review_count";
const LEAD_ROW = 'Dede Kebap,+90 0532 000 00 01,"siparis@dedekebap.com",https://dedekebap.com,Kebapçı,"Kadıköy, İstanbul",4.2,120';
const NO_SITE_ROW = 'Dede Poğaça,+90 0532 000 00 02,,,"Fatih, İstanbul",,4.8,50';

test("parseCsvRows: quoted cells with commas and escaped quotes", () => {
  const rows = parseCsvRows('a,b\n"5.000 ₺\'den","x, y"\n"say ""hi""",2\n');
  assert.deepEqual(rows, [
    ["a", "b"],
    ["5.000 ₺'den", "x, y"],
    ['say "hi"', "2"],
  ]);
});

test("normalizeHost: strip scheme, www, trailing slash, lowercase", () => {
  assert.equal(normalizeHost("https://www.KlinikDis.com/randevu/"), "klinikdis.com");
  assert.equal(normalizeHost("klinikdis.com"), "klinikdis.com");
  assert.equal(normalizeHost(""), "");
  assert.equal(normalizeHost("not a url"), "");
});

test("extractEmails: JSON list, delimited text, dedupe and lowercase", () => {
  assert.deepEqual(extractEmails('["Info@A.com","B@A.com"]'), ["info@a.com", "b@a.com"]);
  assert.deepEqual(extractEmails("a@x.com; b@x.com"), ["a@x.com", "b@x.com"]);
  assert.deepEqual(extractEmails(""), []);
  assert.deepEqual(extractEmails("yok"), []);
});

test("importRows: kit's 36-column CSV maps the 8 lead fields", () => {
  const { leads, skipped } = importRows(`${KIT_HEADER}\n${KIT_ROW}\n`);
  assert.equal(skipped, 0);
  assert.equal(leads.length, 1);
  const lead = leads[0];
  assert.equal(lead.name, "Klinik Diş");
  assert.equal(lead.website, "klinikdis.com");
  assert.equal(lead.phone, "+905079581642");
  assert.equal(lead.category, "Diş kliniği");
  assert.equal(lead.reviewRating, 4.6);
  assert.equal(lead.reviewCount, 41);
  assert.deepEqual(lead.emails, ["bilgi@klinikdis.com", "randevu@klinikdis.com"]);
});

test("importRows: dedupes on website host and skips nameless rows", () => {
  const csv = [
    LEAD_HEADER,
    LEAD_ROW,
    LEAD_ROW,
    NO_SITE_ROW,
    ",,x@y.com,z.com,Kategori,Adres,3,7",
    "Dede Kebap,başka telefon,,dedekebap.com/subpage,Kebapçı,,3,7",
  ].join("\n");
  const { leads, skipped } = importRows(csv);
  assert.equal(leads.length, 2);
  assert.equal(skipped, 3);
  assert.equal(leads[1].website, "");
});

test("leadFromRow: no-website lead keeps category and address", () => {
  const rows = importRows(`skip1\n${NO_SITE_ROW}\n`).leads;
  assert.equal(rows.length, 0);
  const header = new Map(LEAD_HEADER.split(",").map((name, i) => [name, i]));
  const lead = leadFromRow(parseCsvRows(NO_SITE_ROW)[0], header);
  assert.equal(lead.name, "Dede Poğaça");
  assert.equal(lead.website, "");
  assert.equal(lead.reviewRating, 4.8);
  assert.equal(lead.emails.length, 0);
});

test("scanConversion: WhatsApp, tel, form, https ve viewport yakalanır", () => {
  const good = scanConversion(
    `<!doctype html><html lang="tr"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
     <body><a href="https://wa.me/905079581642">WhatsApp</a><a href="tel:+905079581642">Ara</a>
     <form><input type="email" name="mail"></form></body></html>`,
    "https://example.com/",
  );
  assert.equal(good.https, true);
  assert.equal(good.hasWhats, true);
  assert.equal(good.hasTel, true);
  assert.equal(good.hasForm, true);
  assert.equal(good.viewport, true);
  assert.equal(good.lang, "tr");

  const bad = scanConversion("<html><body><h1>Merhaba</h1></body></html>", "http://example.com/");
  assert.equal(bad.https, false);
  assert.equal(bad.hasWhats, false);
  assert.equal(bad.hasTel, false);
  assert.equal(bad.hasForm, false);
  assert.equal(bad.viewport, false);
});

const mockAnalysis = (over = {}) => ({
  score: 58,
  grade: "D",
  recommendations: [
    { severity: "critical", title: "Site açılmıyor mu", evidence: "HTTP 500", fix: "Sunucuyu düzeltin" },
    { severity: "high", title: "Organization şeması yok", evidence: "Hiçbir sayfada yok", fix: "JSON-LD ekleyin" },
    { severity: "low", title: "Feed yok", evidence: "RSS bulunamadı", fix: "RSS ekleyin" },
  ],
  conversion: { https: true, hasWhats: false, hasTel: false, hasForm: false, viewport: true, lang: "tr" },
  ...over,
});

test("lossPoints: kritik/high denetim hataları + dönüşüm kayıpları", () => {
  const points = lossPoints(mockAnalysis());
  assert.equal(points.length, 4);
  assert.match(points[0].point, /HTTP 500/);
  assert.match(points[2].point, /WhatsApp/);
});

test("lossPoints: HTTPS yoksa güvenlik kaybı satırı var", () => {
  const points = lossPoints(mockAnalysis({ conversion: { https: false, hasWhats: true, hasTel: true, hasForm: true, viewport: true } }));
  assert.ok(points.some((p) => /HTTPS/.test(p.point)));
});

test("chooseRoute: site yok / açılmıyor / iyi / düzeltilmeli", () => {
  const lead = { website: "klinikdis.com", name: "Klinik Diş" };
  assert.equal(chooseRoute({ website: "", name: "x" }, null), "no-site");
  assert.equal(chooseRoute(lead, null), "unreachable");
  assert.equal(chooseRoute(lead, { unreachable: true }), "unreachable");
  assert.equal(chooseRoute(lead, mockAnalysis({ score: 90, recommendations: [] })), "ai-visibility");
  assert.equal(chooseRoute(lead, mockAnalysis({ score: 90 })), "fix");
  assert.equal(chooseRoute(lead, mockAnalysis({ score: 40, recommendations: [] })), "fix");
});

test("topIssues: en fazla 4 kayıp noktası", () => {
  const analysis = mockAnalysis({
    recommendations: Array.from({ length: 6 }, (_, i) => ({ severity: "high", title: `Sorun ${i}`, evidence: "", fix: "" })),
    conversion: { https: false, hasWhats: false, hasTel: false, hasForm: false, viewport: false },
  });
  assert.equal(topIssues(analysis, "fix").length, 4);
});

test("buildDraft: site-yok rotası vaatleri ve WhatsApp bağlantısını içerir", () => {
  const lead = { name: "Dede Poğaça", website: "", category: "Fırın", address: "Fatih, İstanbul", reviewCount: 50, reviewRating: 4.8, phone: "+90 532 000 00 02", emails: [] };
  const { route, subject, body, to } = buildDraft(lead, null);
  assert.equal(route, "no-site");
  assert.match(subject, /Dede Poğaça/);
  assert.match(subject, /Fatih/);
  for (const phrase of ["Özgün tasarım", "yapay zekâ", "5.000 ₺", "24 saat", "wa.me/905079581642", "50 yorum"]) {
    assert.ok(body.includes(phrase), `gövde eksik: ${phrase}`);
  }
  assert.equal(to, "");
});

test("buildDraft: fix rotası skoru, sorunları ve önerileri listeler", () => {
  const lead = { name: "Klinik Diş", website: "klinikdis.com", category: "Diş kliniği", address: "Nişantaşı, İstanbul", reviewCount: 41, reviewRating: 4.6, phone: "+905079581642", emails: ["bilgi@klinikdis.com"] };
  const { route, body } = buildDraft(lead, mockAnalysis({ score: 58, grade: "D" }));
  assert.equal(route, "fix");
  assert.match(body, /58\/100/);
  assert.match(body, /HTTP 500/);
  assert.match(body, /ai-ulu\.com\/checkup\//);
  assert.ok(body.includes("wa.me/905079581642"));
});

test("buildDraft: ai-visibility rotası yapay zekâ vurgusu yapar", () => {
  const lead = { name: "Ayışığı", website: "ayisigi.com", category: "Pasta", address: "Bursa", reviewCount: 9, reviewRating: 5, phone: "", emails: ["a@ayisigi.com"] };
  const { route, subject, body, to } = buildDraft(lead, mockAnalysis({ score: 92, grade: "A", recommendations: [{ severity: "medium", title: "llms.txt yok", evidence: "404", fix: "llms.txt ekleyin" }] }));
  assert.equal(route, "ai-visibility");
  assert.match(subject, /yapay zekâ/);
  assert.match(body, /llms\.txt/);
  assert.equal(to, "a@ayisigi.com");
});

test("buildMime: UTF-8 konu, base64 gövde, satır uzunlukları", () => {
  const mime = buildMime({
    from: "Ali Ulu <aliulu@ai-ulu.com>",
    to: "bilgi@klinikdis.com",
    subject: "Klinik Diş: site notu — 58/100 «ücretsiz»",
    body: "Merhaba,\n\nBirinci satır.\n\nAli Ulu — ai-ulu\nhttps://ai-ulu.com",
    messageId: "test-123",
  });
  assert.match(mime, /^From: Ali Ulu <aliulu@ai-ulu\.com>/);
  assert.match(mime, /^To: bilgi@klinikdis\.com/m);
  assert.match(mime, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(mime, /Message-ID: <test-123>/m);
  for (const line of mime.split("\r\n")) assert.ok(line.length <= 998, `satır uzun: ${line.slice(0, 40)}`);
  const bodyB64 = mime.split("\r\n\r\n")[1].replace(/\r?\n/g, "");
  assert.equal(Buffer.from(bodyB64, "base64").toString("utf8").split("\r\n")[0], "Merhaba,");
  assert.equal(b64("ş"), Buffer.from("ş", "utf8").toString("base64"));
  assert.match(rfc2047("k"), /=\?UTF-8\?B\?/);
});

test("buildMime: alıcı ve gönderen zorunlu", () => {
  assert.throws(() => buildMime({ from: "", to: "a@b.com", subject: "s", body: "b" }), /Gönderen/);
  assert.throws(() => buildMime({ from: "a@b.com", to: "", subject: "s", body: "b" }), /Alıcı/);
});
