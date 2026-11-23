// Store: all agent state lives in one JSON file (`LEAD_AGENT_DIR/store.json`).
// Lead de-duplication/merging on import also lives here.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { VERSION, normalizeHost } from "./agent-core.mjs";

const DIR = process.env.LEAD_AGENT_DIR || ".lead-agent";
const STORE = `${DIR}/store.json`;

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

export { STORE, loadStore, saveStore, draftId, addLeads };
