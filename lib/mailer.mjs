// Sending: Resend HTTP API or direct SMTP (STARTTLS via implicit TLS socket).
// sendDraft is the single entry point; configuration comes from environment.

import { connect as tlsConnect } from "node:tls";

import { site } from "./config.mjs";
import { b64, buildMime } from "./agent-core.mjs";

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

export { sendDraft, sendViaResend, sendViaSmtp };
