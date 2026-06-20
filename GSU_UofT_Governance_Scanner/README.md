# Governance Monitor

Automatically tracks **meeting agenda packages & reports** across all University of Toronto
governing bodies, summarizes new ones with AI, and shows them on a dashboard. Runs itself once a month.

```
   GitHub Action (1st of month, 08:00 UTC)
        │  runs backend/scan.py
        ▼
   scrapes each body's listing → opens each new meeting page → reads the PDF → Claude summarizes
        │  writes
        ▼
     data.json  ──read by──►  index.html  (the dashboard)
```

You never have to open the page for the scan to happen. The dashboard just reads `data.json`,
which the monthly job rewrites and commits.

---

## Files

| File | What it is |
|------|------------|
| `index.html` | The dashboard people look at. (A copy of `Governance Monitor.dc.html` — the editable source.) |
| `support.js` | Runtime the dashboard needs. Keep it next to `index.html`. |
| `data.json` | The data the dashboard shows. The scanner overwrites this every month. |
| `execs.json` | The 6 UTGSU executive portfolios + matching keywords (Bylaw 7). Powers the **By Executive** page. Edit to tune what shows under each VP. |
| `config.json` | Roadmap items + the suggestion-form settings for the **Roadmap & Ideas** page. |
| `backend/scan.py` | The scanner. |
| `backend/bodies.json` | The list of governing bodies to track — edit to add/remove. |
| `backend/requirements.txt` | Python dependencies. |
| `.github/workflows/monthly-scan.yml` | The monthly schedule. |

---

## The three pages

- **Meetings** — every tracked body, newest items as **collapsible cards** (click to expand the full summary, what-was-discussed bullets, grad-student relevance, and each linked report/presentation). Search box, a "grad-relevant only" filter, body chips, and expand/collapse-all.
- **By Executive** — governance items automatically matched to each of the 6 UTGSU executives' portfolios. Matching is done in the browser from `execs.json` (no API cost), using each portfolio's keywords plus the bodies that VP explicitly watches under Bylaw 7. Edit `execs.json` to tune it.
- **Roadmap & Ideas** — what's planned (e.g. emailing each exec their portfolio digest) and a form for members to submit suggestions. See "Collecting suggestions" below.

---

## Collecting suggestions (Roadmap page form)

By default the form opens the visitor's email app addressed to `contactEmail` in `config.json`. To collect
submissions silently instead (recommended), create a free form at <https://formspree.io>, copy its id (the part
after `/f/` in the endpoint), and paste it into `config.json` as `formspreeId`. Change `contactEmail` to your
real address either way.

---

## Deploy checklist (one-time, ~15 min)

### 1. Get an Anthropic API key
This powers the summaries. Go to <https://console.anthropic.com> → **API Keys** → create one.
It's pay-as-you-go; a monthly scan of a handful of PDFs costs a few cents. Copy the key (`sk-ant-…`).

### 2. Create a GitHub repo and upload these files
Keep the folder structure exactly as it is. (New repo → "uploading an existing file" → drag everything in.)

### 3. Add the key as a secret
Repo **Settings → Secrets and variables → Actions → New repository secret**
- Name: `ANTHROPIC_API_KEY`
- Value: your key from step 1

The key stays private — it's never written into any file.

### 4. Run it once by hand to fill in real data
**Actions** tab → **Monthly governance scan** → **Run workflow**.
Watch the log: it scrapes every body, summarizes each current-year package, and commits a fresh `data.json`.
(The first run summarizes everything posted this academic year; later runs only do new items.)

> If the Actions tab says workflows are disabled, click **"I understand my workflows, enable them"**.

### 5. Turn on the dashboard
**Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / root → Save.**
After a minute your dashboard is live at the URL GitHub shows (e.g. `https://<you>.github.io/<repo>/`).
Every monthly commit updates it automatically.

That's it — it now runs on the **1st of every month** with no further action.

---

## Editing what gets tracked
Open `backend/bodies.json`. Each body has an `id`, `name`, page `url`, and `agendaUrl`
(the "Meeting Agendas and Reports" listing the scanner reads). All 23 bodies are already in there.
Full list: <https://governingcouncil.utoronto.ca/secretariat/page/governance-bodies>

## Changing the schedule
Edit the `cron` line in `.github/workflows/monthly-scan.yml`. It's UTC. `"0 8 1 * *"` = 08:00 on the 1st.

## Changing the AI model
The scanner defaults to **`claude-haiku-4-5`** (cheapest). To use a different one without editing code,
add/update a repo variable (**Settings → Secrets and variables → Actions → Variables**) named `CLAUDE_MODEL`
with the model id (e.g. `claude-sonnet-4-6` for higher quality). The workflow passes it through automatically.

## What each summary contains
For every meeting the scanner produces: a plain-language synthesis of what happened (or will happen),
a **"why it matters to graduate students"** note, the key agenda items, and a per-document list of every
linked **report/presentation** — each with its own short summary, a grad-student-relevance line, and a link.
Bumping `SCHEMA_VERSION` in `scan.py` forces a full re-summarize on the next run.

---

## Honest caveats

- **Always verify against the original.** AI summaries can miss nuance — every card links to its source
  document and says so. Treat it as a "what's new this month" radar, not the official record.
- **How documents are found:** each body's listing is a table where every meeting links to a per-meeting
  page (e.g. `.../business-board/agenda-packages/jun-18-2026`). The scanner collects those links for the
  **current academic year**, opens each, and pulls the real PDF. If U of T changes their site layout, the
  logic in `find_packages()` / `resolve_pdf_url()` in `scan.py` may need a small tweak.
- **Only page 1 of each listing is read** (newest first), which covers a normal year. If a body posts 20+
  items in one year, extend the scanner to follow the "Next page" link.
- **Meeting cadence varies** — some bodies meet monthly, others a few times a year. The scan runs monthly
  regardless and only shows what's new.
- **Scheduled Actions pause after 60 days of repo inactivity** (a GitHub rule). The monthly commit from the
  scan keeps it alive; if you ever pause it, re-enable from the Actions tab.

## Run locally (optional, to test)
```bash
pip install -r backend/requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
python backend/scan.py        # writes a fresh data.json
```
Then open `index.html` in a browser.

---

*Note: the `data.json` shipped here contains sample/illustrative entries so the dashboard looks complete
before the first real scan. Business Board's links are real; the rest fill in once the scan runs.*
