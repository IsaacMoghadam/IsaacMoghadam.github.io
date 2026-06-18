#!/usr/bin/env python3
"""
Governance Monitor — monthly scanner (UTGSU).

For each governing body in bodies.json:
  1. Read the body's "Meeting Agendas and Reports" listing and find this academic
     year's meeting pages (agenda packages + reports).
  2. For each NEW meeting page: read the agenda/report text straight off the page,
     and collect every linked report/presentation (the /media/... item documents).
  3. Open those linked documents and pull their text.
  4. Ask Claude (Haiku by default) to synthesize, for a GRADUATE-STUDENT audience:
       - what happened / will happen at the meeting,
       - why it matters to grad students,
       - a per-document summary + grad-student relevance, with links.
  5. Write data.json (what the dashboard reads) and remember what we've seen.

Runs unattended in GitHub Actions monthly. Needs ANTHROPIC_API_KEY in the env.
"""

import os
import re
import json
import sys
import time
import datetime as dt
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup
from pypdf import PdfReader
import anthropic

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BODIES_FILE = os.path.join(HERE, "bodies.json")
STATE_FILE = os.path.join(HERE, "state.json")
DATA_FILE = os.path.join(ROOT, "data.json")

HEADERS = {"User-Agent": "GovernanceMonitor/2.0 (UTGSU meeting tracker)"}

# Model: override with a CLAUDE_MODEL repo variable. `or` so a blank value still falls back.
MODEL = os.environ.get("CLAUDE_MODEL") or "claude-haiku-4-5"

SCHEMA_VERSION = 2          # bump this to force a full re-summarize on the next run
MAX_PAGE_CHARS = 16000      # agenda/report page text fed to the model
MAX_DOC_CHARS = 14000       # per attached document fed to the model
MAX_DOCS_PER_MEETING = 8    # cap how many linked docs we open per meeting (cost/time)


# ---------------------------------------------------------------- academic year

def current_academic_year(today=None):
    """U of T academic year runs Sep–Aug. Returns e.g. '2025–2026'."""
    today = today or dt.date.today()
    start = today.year if today.month >= 9 else today.year - 1
    return f"{start}\u2013{start + 1}"


def guess_meeting_date(text):
    """Pull a date like 'May 28, 2026' out of a string -> ISO, else None."""
    m = re.search(r"([A-Z][a-z]+ \d{1,2},? \d{4})", text or "")
    if m:
        try:
            return dt.datetime.strptime(m.group(1).replace(",", ""), "%B %d %Y").date().isoformat()
        except Exception:
            return None
    return None


# ---------------------------------------------------------------- scraping

def get_main(soup):
    """Return the page's main content element (so we skip the site nav menus)."""
    return (soup.find("main")
            or soup.find(id="main-content")
            or soup.find(attrs={"role": "main"})
            or soup.find("article")
            or soup)


def find_packages(body, session):
    """Return [{title, docType, docUrl, meetingDate}] for the current academic year.

    The listing is a table; each row links to a per-meeting page at
    .../<slug>/agenda-packages/<mon-dd-yyyy> or .../<slug>/reports/<...>.
    """
    listing = body.get("agendaUrl") or body["url"]
    try:
        resp = session.get(listing, headers=HEADERS, timeout=30)
        resp.raise_for_status()
    except Exception as e:
        print(f"  ! could not fetch {listing}: {e}")
        return []

    soup = BeautifulSoup(resp.text, "html.parser")
    year_start = int(current_academic_year().split("\u2013")[0])
    out, seen = [], set()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if "/agenda-packages/" not in href and "/reports/" not in href:
            continue
        url = urljoin(listing, href)
        if url in seen:
            continue
        seen.add(url)
        text = " ".join(a.get_text().split()).replace(" - View", "").strip()
        meeting = guess_meeting_date(text) or guess_meeting_date(href)
        if meeting:                                   # keep only the current academic year
            yr, mo = int(meeting[0:4]), int(meeting[5:7])
            in_year = (yr == year_start and mo >= 9) or (yr == year_start + 1 and mo <= 8)
            if not in_year:
                continue
        doc_type = "Report" if "/reports/" in href else "Agenda Package"
        out.append({"title": text or (body["name"] + " \u2014 " + doc_type),
                    "docType": doc_type, "docUrl": url, "meetingDate": meeting})
    return out


def fetch_doc_text(url, session):
    """Download a linked /media or .pdf document and return its text (trimmed)."""
    try:
        resp = session.get(url, headers=HEADERS, timeout=60)
        resp.raise_for_status()
    except Exception as e:
        print(f"    ! doc fetch failed {url}: {e}")
        return ""
    ctype = resp.headers.get("Content-Type", "").lower()
    if "pdf" in ctype or url.lower().endswith(".pdf"):
        try:
            p = os.path.join(HERE, "_tmp.pdf")
            with open(p, "wb") as f:
                f.write(resp.content)
            txt = "\n".join((pg.extract_text() or "") for pg in PdfReader(p).pages)
            os.remove(p)
            return txt[:MAX_DOC_CHARS]
        except Exception as e:
            print(f"    ! pdf parse failed {url}: {e}")
            return ""
    # otherwise it's an HTML doc — take its main text
    return " ".join(get_main(BeautifulSoup(resp.text, "html.parser")).get_text().split())[:MAX_DOC_CHARS]


def extract_meeting(view_url, session):
    """Read a meeting page: return {pageText, docs:[{title,url}]}.

    pageText is the agenda/report itself (from the main content, not the nav menu).
    docs are the linked reports/presentations for the meeting's items.
    """
    try:
        resp = session.get(view_url, headers=HEADERS, timeout=30)
        resp.raise_for_status()
    except Exception as e:
        print(f"  ! could not fetch {view_url}: {e}")
        return {"pageText": "", "docs": []}

    main = get_main(BeautifulSoup(resp.text, "html.parser"))
    page_text = " ".join(main.get_text().split())
    docs, seen = [], set()
    for a in main.find_all("a", href=True):
        href = a["href"]
        if ("/media/" in href) or href.lower().endswith(".pdf") or "/system/files" in href:
            url = urljoin(view_url, href)
            if url in seen:
                continue
            seen.add(url)
            title = " ".join(a.get_text().split()) or "Document"
            docs.append({"title": title, "url": url})
    return {"pageText": page_text[:MAX_PAGE_CHARS], "docs": docs[:MAX_DOCS_PER_MEETING]}


# ---------------------------------------------------------------- summarizing

def summarize_meeting(client, body_name, doc_type, meeting_date, page_text, docs):
    """One Claude call per meeting: grad-student synthesis + per-document summaries."""
    if not page_text.strip() and not docs:
        return {"summary": "Meeting page detected, but no readable content was found. Open the source for details.",
                "gradRelevance": "", "keyItems": [], "documents": []}

    docs_block = ""
    for i, d in enumerate(docs):
        docs_block += f"\n--- DOCUMENT {i + 1}: {d['title']} | {d['url']} ---\n{(d.get('text') or '')[:MAX_DOC_CHARS]}\n"

    today = dt.date.today().isoformat()
    prompt = f"""You are briefing the University of Toronto Graduate Students' Union (UTGSU) on a meeting of the university's {body_name}. Your audience is graduate students.

Today is {today}. This is the meeting's {doc_type}, dated {meeting_date or "unknown"}.
If the meeting date is in the future, describe what WILL be considered; if it is past, what WAS decided or presented.

You are given the meeting's agenda/report text, plus the full text of its attached reports and presentations.

Return ONLY valid JSON in exactly this shape (no markdown, no preamble):
{{
  "summary": "<4-6 plain-language sentences: what happened or will happen at this meeting>",
  "gradRelevance": "<2-3 sentences: why this meeting matters specifically to graduate students — funding, tuition/fees, housing, TA/RA work and unionized labour, academic policy, student services, safety, accessibility, etc. If relevance is limited, say so briefly and honestly.>",
  "keyItems": ["<short phrase>", "... 3 to 6 of the most important agenda items or decisions"],
  "documents": [
    {{"title": "<clear document name>", "url": "<the document's url>", "summary": "<1-2 sentence summary of THIS document>", "gradRelevance": "<1 sentence on why it matters to grad students, or an empty string>"}}
  ]
}}

Rules:
- Include one "documents" entry for each attached report/presentation that has real content; use the URLs given above.
- Be factual and specific (names, dollar amounts, policies, dates). Do not invent anything.

MEETING TEXT:
{page_text}
{docs_block}"""

    try:
        msg = client.messages.create(model=MODEL, max_tokens=2200,
                                      messages=[{"role": "user", "content": prompt}])
        raw = msg.content[0].text.strip()
        raw = re.sub(r"^```(?:json)?|```$", "", raw, flags=re.M).strip()
        d = json.loads(raw)
        return {
            "summary": d.get("summary", ""),
            "gradRelevance": d.get("gradRelevance", ""),
            "keyItems": (d.get("keyItems") or [])[:6],
            "documents": (d.get("documents") or [])[:MAX_DOCS_PER_MEETING],
        }
    except Exception as e:
        print(f"    ! summarize failed: {e}")
        return {"summary": "", "gradRelevance": "", "keyItems": [], "documents": []}


# ---------------------------------------------------------------- state

def load_json(path, default):
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return default
    return default


def find_previous(url):
    """Reuse what we already generated for this meeting (avoid re-spending)."""
    prev = load_json(DATA_FILE, {"bodies": []})
    for b in prev.get("bodies", []):
        for p in b.get("packages", []):
            if p.get("docUrl") == url:
                return {"summary": p.get("summary", ""), "gradRelevance": p.get("gradRelevance", ""),
                        "keyItems": p.get("keyItems", []), "documents": p.get("documents", [])}
    return {"summary": "", "gradRelevance": "", "keyItems": [], "documents": []}


# ---------------------------------------------------------------- main

def main():
    bodies_cfg = load_json(BODIES_FILE, {"bodies": []})["bodies"]

    state = load_json(STATE_FILE, {})
    if state.get("schema") != SCHEMA_VERSION:        # schema changed -> re-summarize everything
        print(f"State schema {state.get('schema')} != {SCHEMA_VERSION}; doing a full refresh.")
        state = {"schema": SCHEMA_VERSION, "seen": {}}
    seen = state.get("seen", {})

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY not set.")
        sys.exit(1)
    client = anthropic.Anthropic(api_key=api_key)
    session = requests.Session()

    today = dt.date.today().isoformat()
    out_bodies = []

    for body in bodies_cfg:
        print(f"Scanning {body['name']} …")
        packages = find_packages(body, session)
        pkg_out, has_new = [], False

        for pkg in packages:
            url = pkg["docUrl"]
            is_new = url not in seen
            detected_on = seen.get(url, today)

            if is_new:
                seen[url] = today
                detected_on = today
                has_new = True
                print(f"  + NEW: {pkg['title'][:70]}")
                extracted = extract_meeting(url, session)
                for d in extracted["docs"]:
                    d["text"] = fetch_doc_text(d["url"], session)
                    time.sleep(0.3)
                print(f"      read {len(extracted['docs'])} linked document(s); summarizing…")
                summary = summarize_meeting(client, body["name"], pkg.get("docType"),
                                            pkg.get("meetingDate"), extracted["pageText"], extracted["docs"])
                time.sleep(0.5)
            else:
                summary = find_previous(url)

            pkg_out.append({
                "title": pkg["title"],
                "docType": pkg.get("docType", "Agenda Package"),
                "meetingDate": pkg.get("meetingDate") or detected_on,
                "detectedOn": detected_on,
                "isNew": is_new,
                "docUrl": url,
                "summary": summary.get("summary", ""),
                "gradRelevance": summary.get("gradRelevance", ""),
                "keyItems": summary.get("keyItems", []),
                "documents": summary.get("documents", []),
            })

        out_bodies.append({
            "id": body["id"],
            "name": body["name"],
            "url": body["url"],
            "lastChecked": dt.datetime.utcnow().isoformat() + "Z",
            "status": "new" if has_new else ("unchanged" if pkg_out else "empty"),
            "packages": pkg_out,
        })

    data = {
        "generatedAt": dt.datetime.utcnow().isoformat() + "Z",
        "academicYear": current_academic_year(),
        "source": "https://governingcouncil.utoronto.ca/secretariat/page/governance-bodies",
        "bodies": out_bodies,
    }
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump({"schema": SCHEMA_VERSION, "seen": seen}, f, indent=2)

    new_total = sum(1 for b in out_bodies for p in b["packages"] if p["isNew"])
    print(f"\nDone. {new_total} new meeting(s) summarized. Wrote {DATA_FILE}.")


if __name__ == "__main__":
    main()
