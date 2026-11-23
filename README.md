# supreme-octo-bassoon — ai-ulu lead agent

Handles ai-ulu.com (customer-generating website) with an end-to-end customer acquisition agent:
it extracts leads via [google-maps-scraper-kit](https://github.com/ali-ulu/google-maps-scraper-kit),
audits each website technically, prepares a Turkish outreach email, and **sends only the ones you
approve.** It has no dependencies (stdlib, Node 22+).

## Flow

1. **Scan** — you open the scraper-kit engine (`python3 scripts/engine.py start` in the kit's directory,
   port 8080). Then:
   ```bash
   npm run lead -- fetch --query "dental clinic Kadıköy" --depth 2
   ```
   For each result, name, phone, email, website, category, address and rating information are saved to
   `.lead-agent/store.json` (gitignored). Prefer to use the kit's CLI? Download the CSV and take it from
   there: `npm run lead -- import --csv leads.csv`.
2. **Audit** — `npm run lead -- analyze`; for each website, the same scoring engine as `scripts/geo-audit.mjs`
   (technical SEO, schema, content, AI-search access, brand) + the conversion layer runs. Records of
   loss points: no HTTPS, no clickable phone/WhatsApp, no contact form, missing mobile viewport, etc.
   If there is no website, the proposal route is registered directly.
3. **Draft** — `npm run lead -- draft` prepares an email draft for each lead according to their route:
   - `fix` — site exists but has serious issues: score, 3–4 main issues, each with suggestions.
   - `unreachable` — the site is down: the most expensive customer loss.
   - `ai-visibility` — if the site is good (≥85) but weak in AI-search visibility: ChatGPT/Gemini/Perplexity layer.
   - `no-site` — no website: site proposals with the promises made on our site (custom code, Google +
     AI visibility, WhatsApp integration, written proposal within 24h, starting from 5 000 ₺).
   Each draft includes a personalized WhatsApp link; the signature is `Ali Ulu — ai-ulu`.
4. **Review and approval** — `list`, `show <id>` shows the full text; **`approve <id>`** indicates permission
   to send. `reject`/`skip` for the ones you don't want.
5. **Sending** — `npm run lead -- send --all` (only approved ones). If you want to preview first:
   `send --all --dry-run` prints the MIME. If sending fails for drafts without an email
   address, it reports it clearly — use the phone number in the `show` output.
6. **Follow-up** — every sent draft gets `followUpAt` (+2 days, `LEAD_AGENT_FOLLOWUP_DAYS`).
   `npm run lead -- follow` creates a short reminder draft for sent-and-not-answered leads;
   it stays approval-gated. When `inbox` marks a lead as answered, pending follow-ups cancel.
7. **Scheduling** — `send --all --schedule "yarın 09:00"` queues drafts (`scheduled`);
   `send --due [--rate 20]` sends what is due with an hourly cap (`LEAD_AGENT_RATE`).
8. **WhatsApp channel** — `draft --channel whatsapp` builds the short (≤300 char) message
   plus a `wa.me` deep link; those drafts are delivered as copyable text (approval still required).
9. **Report** — `npm run lead -- report` one-glance summary: leads analyzed, drafts by
   status/route, average score, sent/scheduled/replied.

```bash
npm run lead -- list
npm run lead -- show fe65a2c1
npm run lead -- approve fe65a2c1
npm run lead -- send --all --dry-run
npm run lead -- send --all
npm run lead -- follow
npm run lead -- send --all --schedule "yarın 09:00"
npm run lead -- send --due
npm run lead -- report
```

## Sending configuration (environment variables)

| Variable             | Description                                                            |
|----------------------|------------------------------------------------------------------------|
| `RESEND_API_KEY` + `RESEND_FROM adı@ai-ulu.com` | Resend HTTP API (recommended)                        |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Direct SMTP (STARTTLS)                        |
| `LEAD_AGENT_FROM`    | Sender line; default: `Ali Ulu <aliulu@ai-ulu.com>`                     |
| `SCRAPER_BASE_URL` / `SCRAPER_PORT` `SCRAPER_API_KEY` | Kit engine address (default `http://localhost:8080`) |
| `LEAD_AGENT_DIR`     | Data directory (default `.lead-agent`)                                  |
| `LEAD_AGENT_FOLLOWUP_DAYS` | Follow-up reminder delay (default 2)                                  |
| `LEAD_AGENT_RATE`    | Scheduled sends per hour (default 20)                                  |
| `IMAP_HOST` `IMAP_USER` `IMAP_PASS` [`IMAP_PORT`/`IMAP_FOLDER`] | Reply detection (`inbox`)         |

## Independent audit

`npm run geo:audit -- example.com --json` scores a single site with the same engine —
the same scoring as the free test at ai-ulu.com/checkup/.

## Structure

```
scripts/lead-agent.mjs   lead agent CLI: scan, audit, draft, approval, sending
scripts/geo-audit.mjs    GEO audit (AI-search case)
lib/agent-core.mjs       pure core (CSV, leads, routes, drafts, MIME) + Rust binding
lib/store.mjs            JSON store (.lead-agent/store.json) and lead merging
lib/engine.mjs           scraper kit HTTP client
lib/mailer.mjs           Resend / SMTP / WhatsApp delivering
lib/imap.mjs             minimal IMAP client for reply detection
lib/checkup.mjs          shared scoring checks
lib/config.mjs           brand / sender configuration
test/                    unit tests (node --test)
```

## Compliance

Only send emails to people you have permission to contact. KVKK and spam rules —
your responsibility. The design of this agent with the approval step is to ensure that
nothing goes out without your confirmation.
