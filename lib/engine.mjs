// Scraper kit engine client (google-maps-scraper-kit HTTP API):
//   POST /api/v1/jobs → GET /api/v1/jobs/{id} → GET /api/v1/jobs/{id}/download

import { readFile } from "node:fs/promises";

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

export { engineBase, engineRequest, createJob, waitForJob, engineCsv };
