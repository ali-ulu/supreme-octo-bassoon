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
import {
  buildFollowUp,
  buildWhatsapp,
  reportOf,
  parseSchedule,
  isDue,
  matchReplies,
} from "../lib/agent-core.mjs";


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

// ── feature: follow-up / whatsapp / report / schedule / inbox ────────────────

test("buildFollowUp: konu Re: öneki alır (çift olmaz), metin isim+link+imza içerir", () => {
  const lead = { name: "Ay Işığı Pastanesi", emails: ["a@ayisigi.com"], phone: "+90 212 555 01 01", website: "", address: "Kadıköy, İstanbul" };
  const sent = { id: "abc12345", to: "a@ayisigi.com", subject: "Ay Işığı Pastanesi için müşteri getiren bir web sitesi (Kadıköy)", route: "no-site" };
  const f = buildFollowUp(lead, sent);
  assert.equal(f.route, "follow-up");
  assert.equal(f.to, "a@ayisigi.com");
  assert.match(f.subject, /^Re: /);
  assert.equal(f.subject, `Re: ${sent.subject}`);
  const again = buildFollowUp(lead, { ...sent, subject: f.subject });
  assert.equal(again.subject, f.subject);
  assert.match(f.body, /Ay Işığı Pastanesi/);
  assert.match(f.body, /wa\.me\/905079581642/);
  assert.match(f.body, /aliulu@ai-ulu\.com/);
  assert.ok(f.body.length < 900);
});

test("buildWhatsapp: 300 karakter altı, wa.me derin linki, 0'lı telefon 90'a çevrilir", () => {
  const lead = { name: "Kadıköy Kuaför", phone: "0216 444 02 02", emails: [], website: "", address: "Fikirtepe, İstanbul", reviewCount: 54, reviewRating: 4.2 };
  const m = buildWhatsapp(lead, null);
  assert.equal(m.route, "no-site");
  assert.match(m.subject, /^WhatsApp/);
  assert.ok(m.body.length <= 300, `uzunluk ${m.body.length}`);
  assert.match(m.body, /Kadıköy Kuaför/);
  assert.ok(m.link.startsWith("https://wa.me/902164440202?text="));
  const long = buildWhatsapp({ ...lead, name: "Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun Uzun" }, null);
  assert.ok(long.body.length <= 300);
});

test("reportOf: sayaçlar, rota dağılımı, ortalama skor", () => {
  const store = {
    leads: {
      l1: { name: "A", emails: ["a@a.com"], phone: "", website: "s1.com", analysis: { route: "fix", score: 40, grade: "E", recommendations: [] } },
      l2: { name: "B", emails: ["b@b.com"], phone: "", website: "", analysis: { route: "no-site", analyzedAt: "x" } },
      l3: { name: "C", emails: [], phone: "1", website: "s3.com", analysis: null },
    },
    drafts: {
      d1: { id: "d1", leadId: "l1", route: "fix", status: "sent", score: 40, sentAt: "t", sentRef: "r" },
      d2: { id: "d2", leadId: "l2", route: "no-site", status: "approved", score: null, sentAt: null },
      d3: { id: "d3", leadId: "l3", route: "fix", status: "draft", score: null, sentAt: null },
      d4: { id: "d4", leadId: "l1", route: "follow-up", status: "draft", score: null, sentAt: null },
    },
  };
  const r = reportOf(store);
  assert.equal(r.leads.total, 3);
  assert.equal(r.leads.analyzed, 2);
  assert.equal(r.leads.noSite, 1);
  assert.equal(r.drafts.total, 4);
  assert.equal(r.drafts.byStatus.sent, 1);
  assert.equal(r.drafts.byStatus.approved, 1);
  assert.equal(r.drafts.byRoute["follow-up"], 1);
  assert.equal(r.avgScore, 40);
  assert.equal(r.sent, 1);
});

test("parseSchedule: 'yarın 09:00', 'HH:MM' ve ISO; geçersiz -> hata", () => {
  const base = new Date("2026-01-20T10:00:00");
  const soon = parseSchedule("yarın 09:00", base);
  assert.equal(soon, new Date("2026-01-21T09:00:00").toISOString());
  const today = parseSchedule("23:30", base);
  assert.equal(today, new Date("2026-01-20T23:30:00").toISOString());
  const passed = parseSchedule("05:00", base);
  assert.equal(passed, new Date("2026-01-21T05:00:00").toISOString());
  const iso = parseSchedule("2026-02-01T08:15:00Z", base);
  assert.equal(iso, "2026-02-01T08:15:00.000Z");
  assert.throws(() => parseSchedule("bazı zaman", base), /schedule/);
});

test("isDue + matchReplies: takvit/zamanlama ve iptal kuralları", () => {
  const now = "2026-01-20T10:00:00.000Z";
  const lead = { name: "A", emails: ["a@a.com"], phone: "" };
  const draft = (over = {}) => ({ id: "d1", leadId: "l1", to: "a@a.com", status: "scheduled", sendAt: "2026-01-20T09:59:00.000Z", ...over });
  assert.equal(isDue(draft({ leadId: "l1" }), { l1: lead }, now), true);
  assert.equal(isDue(draft({ leadId: "l1" }).status === "scheduled" ? draft({ status: "sent" }) : draft(), { l1: lead }, now), false);
  assert.equal(isDue(draft({ leadId: "l1" }), { l1: { ...lead, replied: true } }, now), false);
  assert.equal(isDue(draft({ leadId: "l1" }), { lX: lead }, now), false);
  const store = { leads: { l1: { name: "A", emails: ["a@a.com"], phone: "" } }, drafts: { d1: draft({ followUpAt: "2026-01-20T12:00:00.000Z" }) } };
  const replies = [
    { from: "b@b.com", subject: "Hello", date: "2026-01-20T10:30:00.000Z" },
    { from: "a@a.com", subject: "Re: teklif (ücretsiz kontrol)", date: "2026-01-20T11:00:00.000Z" },
    { from: "a@a.com", subject: "Re: teklif (ücretsiz kontrol)", date: "2026-01-19T11:00:00.000Z" },
  ];
  const matched = matchReplies(store, replies);
  assert.equal(matched, true);
  assert.equal(store.leads.l1.replied, true);
  assert.equal(store.leads.l1.lastReplyAt, "2026-01-20T11:00:00.000Z");
});

test("imapSearchReplies: minimal IMAP oturumu (loopback sunucu)", async () => {
  const net = await import("node:net");
  const { imapSearchReplies } = await import("../lib/imap.mjs");
  const server = net.createServer((sock) => {
    let buf = "";
    sock.write("* OK IMAP ready\r\n");
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const t = line.split(" ")[0];
        if (/SEARCH/.test(line)) sock.write("* SEARCH 3 7\r\n" + t + " OK done\r\n");
        else if (/FETCH/.test(line)) sock.write("* 1 FETCH (BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {58}\r\nFrom: Ali Test <carlici@ornek.com>\r\nSubject: Re: teklif\r\nDate: 20 Jan 2026 11:00:00 GMT\r\n\r\n)\r\n" + t + " OK done\r\n");
        else sock.write(t + " OK\r\n");
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.IMAP_SECURE = "0";
  try {
    const port = server.address().port;
    const messages = await imapSearchReplies({ host: "127.0.0.1", port, user: "u", pass: "p", folder: "INBOX", since: "2026-01-01T00:00:00Z" });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].from, "Ali Test <carlici@ornek.com>");
    assert.equal(messages[0].subject, "Re: teklif");
    await assert.rejects(() => imapSearchReplies({ host: "", port: 993, user: "x", pass: "", since: new Date() }), /IMAP yapılandırılmadı/);
  } finally {
    delete process.env.IMAP_SECURE;
    server.close();
  }
});
