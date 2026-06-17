#!/usr/bin/env python3
"""
Governance Monitor — monthly scanner.

For each governing body in bodies.json:
  1. Fetch the body's page on the U of T Governing Council site.
  2. Find links to meeting agenda packages / reports (PDFs) for the current year.
  3. Compare against what we saw last run (state.json) to detect NEW packages.
  4. Download each new PDF and extract its text.
  5. Ask Claude to write a short summary + key items.
  6. Write data.json (the file the dashboard reads) and update state.json.

Designed to run unattended in GitHub Actions once a month.
Set ANTHROPIC_API_KEY in the environment (GitHub repo secret).
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
ROOT = os.path.dirname(HERE)                      # repo root (where data.json lives)
BODIES_FILE = os.path.join(HERE, "bodies.json")
STATE_FILE = os.path.join(HERE, "state.json")     # remembers which packages we've already seen
DATA_FILE = os.path.join(ROOT, "data.json")       # what the dashboard reads

HEADERS = {"User-Agent": "GovernanceMonitor/1.0 (UTGSU meeting tracker; contact: your-email@example.com)"}
# Which Claude model to use. Override by setting CLAUDE_MODEL in the environment
# (e.g. a repo variable) — no code change needed. Falls back to a current Sonnet.
MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-6")
MAX_PDF_CHARS = 60000                             # trim very long packages before sending to the model


# ---------------------------------------------------------------- academic year

def current_academic_year(today=None):
    """U of T academic year runs Sep–Aug. Returns e.g. '2025–2026'."""
    today = today or dt.date.today()
    start = today.year if today.month >= 9 else today.year - 1
    return f"{start}\u2013{start + 1}"


# ---------------------------------------------------------------- scraping

def find_packages(body, session):
    """Return [{title, docType, docUrl, meetingDate}] for the current academic year.

    The listing page (body['agendaUrl']) is a table; each row links to a per-meeting
    'View' page at .../<slug>/agenda-packages/<mon-dd-yyyy> or .../<slug>/reports/<...>.
    We collect those View-page links (NOT the listing itself) and keep current-year ones.
    """
    listing = body.get("agendaUrl") or body["url"]
    try:
        resp = session.get(listing, headers=HEADERS, timeout=30)
        resp.raise_for_status()
    except Exception as e:
        print(f"  ! could not fetch {listing}: {e}")
        return []

    soup = BeautifulSoup(resp.text, "html.parser")
    year_start = int(current_academic_year().split("\u2013")[0])   # e.g. 2025 for 2025-2026
    out = []
    seen = set()
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
        # keep only the current academic year (Sep year_start .. Aug year_start+1)
        if meeting:
            mo = int(meeting[5:7]); yr = int(meeting[0:4])
            in_year = (yr == year_start and mo >= 9) or (yr == year_start + 1 and mo <= 8)
            if not in_year:
                continue
        doc_type = "Report" if "/reports/" in href else "Agenda Package"
        out.append({"title": text or (body["name"] + " \u2014 " + doc_type),
                    "docType": doc_type, "docUrl": url, "meetingDate": meeting})
    return out


def resolve_pdf_url(view_url, session):
    """A meeting 'View' page embeds/links the real PDF. Return the first PDF/media link."""
    try:
        resp = session.get(view_url, headers=HEADERS, timeout=30)
        resp.raise_for_status()
    except Exception:
        return None
    ctype = resp.headers.get("Content-Type", "")
    if "application/pdf" in ctype:
        return view_url
    soup = BeautifulSoup(resp.text, "html.parser")
    for a in soup.find_all("a", href=True):
        href = a["href"].lower()
        if href.endswith(".pdf") or "/media/" in href or "/system/files" in href:
            return urljoin(view_url, a["href"])
    return None


def extract_pdf_text(url, session):
    """Resolve a meeting View page to its PDF, download it, return its text (trimmed)."""
    pdf_url = resolve_pdf_url(url, session) or url
    try:
        resp = session.get(pdf_url, headers=HEADERS, timeout=60)
        resp.raise_for_status()
        if "application/pdf" not in resp.headers.get("Content-Type", "") and not pdf_url.lower().endswith(".pdf"):
            # not a PDF — fall back to the page's visible text
            return " ".join(BeautifulSoup(resp.text, "html.parser").get_text().split())[:MAX_PDF_CHARS]
        path = os.path.join(HERE, "_tmp.pdf")
        with open(path, "wb") as f:
            f.write(resp.content)
        reader = PdfReader(path)
        text = "\n".join((p.extract_text() or "") for p in reader.pages)
        os.remove(path)
        return text[:MAX_PDF_CHARS]
    except Exception as e:
        print(f"  ! could not read document {url}: {e}")
        return ""


# ---------------------------------------------------------------- summarizing

def summarize(client, body_name, doc_text):
    """Ask Claude for a 2–3 sentence summary + 3–5 key items. Returns dict."""
    if not doc_text.strip():
        return {"summary": "Package detected, but no readable text could be extracted. Open the source document for details.",
                "keyItems": []}

    prompt = f"""You are summarizing a meeting agenda package for the University of Toronto's {body_name}.
Write a concise, neutral summary for a student-government audience.

Return ONLY valid JSON in this exact shape:
{{"summary": "<2-3 sentence overview>", "keyItems": ["<short item>", "<short item>", "..."]}}

Rules:
- 3 to 5 key items, each a short phrase (not a full sentence).
- Focus on decisions, approvals, reports, and items of interest to students.
- No preamble, no markdown, JSON only.

DOCUMENT:
{doc_text}"""

    msg = client.messages.create(
        model=MODEL,
        max_tokens=700,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = msg.content[0].text.strip()
    # be forgiving if the model wraps JSON in a code fence
    raw = re.sub(r"^```(?:json)?|```$", "", raw, flags=re.M).strip()
    try:
        data = json.loads(raw)
        return {"summary": data.get("summary", ""), "keyItems": data.get("keyItems", [])[:5]}
    except Exception:
        return {"summary": raw[:600], "keyItems": []}


# ---------------------------------------------------------------- state

def load_json(path, default):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return default


# ---------------------------------------------------------------- main

def main():
    bodies_cfg = load_json(BODIES_FILE, {"bodies": []})["bodies"]
    state = load_json(STATE_FILE, {"seen": {}})          # {docUrl: detectedOn}
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
        pkg_out = []
        has_new = False

        for pkg in packages:
            url = pkg["docUrl"]
            is_new = url not in seen
            detected_on = seen.get(url, today)
            if is_new:
                seen[url] = today
                detected_on = today
                has_new = True
                print(f"  + NEW package: {pkg['title'][:70]}")
                text = extract_pdf_text(url, session)
                summary = summarize(client, body["name"], text)
                time.sleep(1)  # be polite to the site + API
            else:
                # reuse the summary we already wrote last time, if present
                summary = find_previous_summary(url)

            pkg_out.append({
                "title": pkg["title"],
                "docType": pkg.get("docType", "Agenda Package"),
                "meetingDate": pkg.get("meetingDate") or detected_on,
                "detectedOn": detected_on,
                "isNew": is_new,
                "docUrl": url,
                "summary": summary.get("summary", ""),
                "keyItems": summary.get("keyItems", []),
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
    state["seen"] = seen
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)

    new_total = sum(1 for b in out_bodies for p in b["packages"] if p["isNew"])
    print(f"\nDone. {new_total} new package(s) summarized. Wrote {DATA_FILE}.")


def guess_meeting_date(title):
    """Try to pull a date like 'May 28, 2026' out of the link text."""
    m = re.search(r"([A-Z][a-z]+ \d{1,2},? \d{4})", title)
    if m:
        try:
            return dt.datetime.strptime(m.group(1).replace(",", ""), "%B %d %Y").date().isoformat()
        except Exception:
            return None
    return None


def find_previous_summary(url):
    """Reuse a summary we already generated for this URL (so we don't re-call the API)."""
    prev = load_json(DATA_FILE, {"bodies": []})
    for b in prev.get("bodies", []):
        for p in b.get("packages", []):
            if p.get("docUrl") == url:
                return {"summary": p.get("summary", ""), "keyItems": p.get("keyItems", [])}
    return {"summary": "", "keyItems": []}


if __name__ == "__main__":
    main()
