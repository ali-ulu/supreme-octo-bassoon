// Minimal IMAP client (zero deps): LOGIN → SELECT → UID SEARCH SINCE → UID FETCH
// headers (FROM/SUBJECT/DATE) — enough for reply detection. IMAP_SECURE=0 Plain TCP
// for tests; default TLS 993.

import { connect as tlsConnect } from "node:tls";
import { connect as netConnect } from "node:net";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function imapSince(d) {
  const t = d instanceof Date ? d : new Date(d);
  return `${String(t.getUTCDate()).padStart(2, "0")}-${MONTHS[t.getUTCMonth()]}-${t.getUTCFullYear()}`;
}

function reader(socket) {
  let buf = "";
  const waiters = [];
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buf += chunk;
    const w = waiters.splice(0);
    for (const fn of w) fn();
  });
  socket.on("error", (e) => {
    for (const fn of waiters.splice(0)) fn();
    socket.destroy();
    throw e;
  });
  const more = () => new Promise((r) => waiters.push(r));
  return {
    readLine: async () => {
      for (;;) {
        const i = buf.indexOf("\r\n");
        if (i >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); return line; }
        await more();
      }
    },
  };
}

export function imapHeaders(raw) {
  const out = [];
  for (const block of raw.split(/\*\s+\d+\s+FETCH\s+\(/)) {
    if (!block) continue;
    const lit = block.match(/\{(\d+)\}\r\n([\s\S]*?)(?=\r\n\)\r?\n|$)/);
    if (!lit) continue;
    const text = lit[2].replace(/\r\n([ \t])/g, " $1");
    const get = (name) => {
      const m = text.match(new RegExp(`^${name}:(.*)$`, "mi"));
      return m ? m[1].trim() : "";
    };
    if (text) out.push({ from: get("From"), subject: get("Subject"), date: get("Date") });
  }
  return out.filter((m) => m.from || m.subject);
}

async function imapSearchReplies({ host, port = 993, user, pass, folder = "INBOX", since, max = 200 }) {
  if (!host || !user) throw new Error("IMAP yapılandırılmadı: IMAP_HOST, IMAP_USER, IMAP_PASS gerekli.");
  const secure = process.env.IMAP_SECURE !== "0" && port !== 143;
  const socket = secure ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
  await new Promise((resolve, reject) => {
    const done = () => { socket.removeListener("error", onErr); resolve(); };
    const onErr = (e) => { socket.removeListener(secure ? "secureConnect" : "connect", done); reject(e); };
    socket.once(secure ? "secureConnect" : "connect", done);
    socket.once("error", onErr);
    setTimeout(() => onErr(new Error("IMAP bağlantısı zaman aşımına uğradı.")), 30_000);
  });
  const { readLine } = reader(socket);
  let tag = 0;
  const cmd = async (line) => {
    const t = `A${String(++tag).padStart(3, "0")}`;
    socket.write(`${t} ${line}\r\n`);
    const out = [];
    for (;;) {
      const l = await readLine();
      out.push(l);
      if (l.startsWith(`${t} `)) break;
    }
    if (!out.at(-1).startsWith(`${t} OK`)) throw new Error(`IMAP ${t}: ${out.at(-1).slice(0, 300)}`);
    return out;
  };
  try {
    await readLine();
    await cmd(`LOGIN "${user}" "${pass || ""}"`);
    await cmd(`SELECT "${folder}"`);
    const search = await cmd(`UID SEARCH SINCE ${imapSince(since)}`);
    const uids = search.find((l) => l.startsWith("* SEARCH"))?.slice("* SEARCH".length).trim().split(/\s+/).filter(Boolean) || [];
    const picked = uids.slice(-max).join(",");
    if (!picked) return [];
    const fetch = await cmd(`UID FETCH ${picked} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`);
    const messages = imapHeaders(fetch.join("\r\n"));
    await cmd("LOGOUT").catch(() => {});
    return messages;
  } finally {
    socket.destroy();
  }
}

export { imapSearchReplies };
