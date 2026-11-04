from __future__ import annotations

import atexit
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import time
import unicodedata
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, Response, flash, redirect, render_template, request, send_file, url_for
from markupsafe import Markup, escape
from werkzeug.utils import secure_filename

import applying
import tailoring

ROOT = Path(__file__).resolve().parent
# The Mac app keeps data in ~/Library/Application Support/Apply Desk so the
# bundled service stays read-only; running app.py from a checkout uses ./instance.
INSTANCE = Path(os.environ.get("APPLY_DESK_DATA") or ROOT / "instance").expanduser()
INSTANCE.mkdir(parents=True, exist_ok=True)
DB = INSTANCE / "resume_tailor.sqlite3"
# The Mac app passes a private token; when set, every request must carry it so
# other local software and web pages can't read or change the profile.
APP_TOKEN = os.environ.get("APPLY_DESK_TOKEN", "")
ALLOWED = {"pdf", "docx", "txt", "tex"}
app = Flask(__name__)
app.secret_key = APP_TOKEN or "local-resume-tailor-session"
app.config["MAX_CONTENT_LENGTH"] = 12 * 1024 * 1024

CONTACT_FIELDS = [("name", "Full name"), ("email", "Email"), ("phone", "Mobile phone"), ("address", "Street address"),
                  ("city", "City"), ("state", "State"), ("postal_code", "ZIP code")]
EDUCATION_FIELDS = [("school", "School"), ("degree", "Degree"), ("graduation", "Expected graduation"), ("gpa", "GPA"),
                    ("work_authorization", "Work authorization")]
LINK_FIELDS = [("linkedin", "LinkedIn"), ("github", "GitHub"), ("website", "Portfolio or website")]
# Values the Mac app may type into clearly labeled, empty application fields.
AUTOFILL_FIELDS = [key for key, _ in CONTACT_FIELDS + EDUCATION_FIELDS + LINK_FIELDS]
PROFILE_FIELDS = AUTOFILL_FIELDS + ["target_roles", "skills", "career_goals", "role_campaigns", "larp"] + [
    key for key in applying.STANDARD_KEYS if key not in AUTOFILL_FIELDS] + applying.DISCLOSURE_KEYS


@app.before_request
def restrict_to_loopback():
    """Reject non-local clients and Host headers, including DNS-rebinding hosts."""
    try:
        remote_is_local = ipaddress.ip_address(request.remote_addr or "").is_loopback
    except ValueError:
        remote_is_local = False
    host = request.host.split(":", 1)[0].strip("[]").lower()
    if not remote_is_local or host not in {"127.0.0.1", "localhost"}:
        return "Local Apply Desk accepts requests from this computer only.", 421
    if APP_TOKEN:
        supplied = request.headers.get("X-Apply-Desk-Token") or request.cookies.get("apply_desk_token") or ""
        if not hmac.compare_digest(supplied, APP_TOKEN):
            return "Open Apply Desk from the Mac app.", 403


def db():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS profile (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS resume (id INTEGER PRIMARY KEY, filename TEXT, text TEXT NOT NULL, uploaded TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, company TEXT, title TEXT, url TEXT, description TEXT, saved TEXT NOT NULL, wave TEXT NOT NULL DEFAULT '', sector TEXT NOT NULL DEFAULT '', funding_stage TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, summary TEXT NOT NULL, created TEXT NOT NULL);
        -- The exact resume Apply Desk attached or saved for a role, kept even if
        -- the resume changes later.
        -- Short answers the user typed on application forms, reused when the
        -- same question comes up again.
        CREATE TABLE IF NOT EXISTS answers (id INTEGER PRIMARY KEY, question TEXT NOT NULL UNIQUE, label TEXT NOT NULL, answer TEXT NOT NULL, updated TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS applications (id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL, created TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', attached INTEGER NOT NULL DEFAULT 0, filled TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, extension TEXT NOT NULL, pdf BLOB, pages INTEGER NOT NULL DEFAULT 1, changes TEXT NOT NULL DEFAULT '[]');
        """)
        # Personal contact details live only in the ignored local database. Do
        # not put an individual's address, phone, or email into tracked code.
        defaults = {
            "name": "", "email": "", "school": "", "degree": "",
            "graduation": "", "phone": "", "city": "", "state": "",
            "postal_code": "", "address": "", "work_authorization": "",
            "linkedin": "", "github": "", "website": "",
            "watch_path": "", "watch_hash": "",
            "target_roles": "Software Engineering Intern, Backend Engineer Intern",
            "skills": "",
            "career_goals": "",
            "role_campaigns": "Wave 1, Wave 2, Defense, Seed-stage startups",
            "larp": "2", "gpa": "",
        }
        defaults.update({spec["key"]: spec["default"] for spec in applying.STANDARD_QUESTIONS if spec["key"] not in defaults})
        for key, value in defaults.items():
            conn.execute("INSERT OR IGNORE INTO profile(key,value) VALUES(?,?)", (key, value))
        # Additive migration for databases created by earlier Apply Desk versions.
        columns = {row[1] for row in conn.execute("PRAGMA table_info(jobs)")}
        for column in ("wave", "sector", "funding_stage"):
            if column not in columns:
                conn.execute(f"ALTER TABLE jobs ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")
        # One fill run (every page of an application) is one record, with its review.
        columns = {row[1] for row in conn.execute("PRAGMA table_info(applications)")}
        for column, default in (("run", "''"), ("review", "'[]'")):
            if column not in columns:
                conn.execute(f"ALTER TABLE applications ADD COLUMN {column} TEXT NOT NULL DEFAULT {default}")
        # Earlier versions read only a page's first heading, so some roles have
        # no company or a site banner ("Careers at ...") as their title.
        for row in conn.execute("SELECT id, title, company, url, description FROM jobs WHERE company='' OR title LIKE 'Careers%'").fetchall():
            title, company = applying.identify_role({"url": row[3], "title": row[1], "company": row[2]}, row[4] or "")
            if (title, company) != (row[1], row[2]):
                conn.execute("UPDATE jobs SET title=?, company=? WHERE id=?", (title or row[1], company or row[2], row[0]))
        # Workday's legal entity names ("00100 LEIDOS, INC.") become company names.
        for row in conn.execute("SELECT id, company, url, description FROM jobs WHERE company != ''").fetchall():
            name = applying.company_name(row[1], row[2] or "", row[3] or "")
            if name and name != row[1]:
                conn.execute("UPDATE jobs SET company=? WHERE id=?", (name, row[0]))
        # Split legacy "City, ST" profile entries so a browser form helper
        # won't put the whole string in a city-only field.
        values = {row["key"]: row["value"] for row in conn.execute("SELECT * FROM profile")}
        if not values.get("state") and "," in values.get("city", ""):
            parts = [part.strip() for part in values["city"].rsplit(",", 1)]
            if len(parts) == 2 and re.fullmatch(r"[A-Za-z]{2}", parts[1]):
                conn.execute("UPDATE profile SET value=? WHERE key='city'", (parts[0],))
                conn.execute("UPDATE profile SET value=? WHERE key='state'", (parts[1].upper(),))
                values["city"], values["state"] = parts[0], parts[1].upper()
        address = values.get("address", "").strip()
        city, state = values.get("city", "").strip(), values.get("state", "").strip()
        suffix = f", {city}, {state}" if city and state else ""
        if suffix and address.lower().endswith(suffix.lower()):
            conn.execute("UPDATE profile SET value=? WHERE key='address'", (address[:-len(suffix)].strip(),))
    merge_duplicates()


def refresh_pdf_resume():
    """Re-read the current resume from its saved PDF when an older reader
    imported it: before layout mode (columns run together) or before PDFKit
    repaired word spacing ("anunintended")."""
    resume = resume_row()
    path = INSTANCE / "resume_upload.pdf"
    if not resume or not resume["filename"].lower().endswith(".pdf") or not path.is_file():
        return
    if "    " in resume["text"] and not os.environ.get("APPLY_DESK_PDFTEXT"):
        return
    # Only when the saved file is this exact upload (same minute).
    if datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="minutes") != resume["uploaded"][:16]:
        return
    try:
        text = extract_text(path, "pdf").strip()
    except Exception:
        return
    if text and text != resume["text"] and 0.7 < len(text) / max(1, len(resume["text"])) < 1.5:
        with db() as conn:
            conn.execute("UPDATE resume SET text=? WHERE id=?", (text, resume["id"]))


def profile():
    with db() as conn:
        return {r["key"]: r["value"] for r in conn.execute("SELECT * FROM profile")}


def resume_row():
    with db() as conn:
        row = conn.execute("SELECT * FROM resume ORDER BY id DESC LIMIT 1").fetchone()
        return dict(row) if row else None


def log_activity(kind: str, summary: str):
    with db() as conn:
        conn.execute("INSERT INTO activity(kind,summary,created) VALUES(?,?,?)", (kind, summary[:300], datetime.now().isoformat(timespec="minutes")))


def sync_watched_resume_once() -> bool:
    """Import a changed resume only when its exact path was configured."""
    p = profile()
    source = p.get("watch_path", "").strip()
    if not source:
        return False
    path = Path(source).expanduser()
    try:
        if not path.is_file() or path.stat().st_size > 12 * 1024 * 1024:
            return False
        ext = path.suffix.lower().lstrip(".")
        if ext not in ALLOWED:
            return False
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest == p.get("watch_hash", ""):
            return False
        text = extract_text(path, ext).strip()
        if not text:
            return False
        with db() as conn:
            conn.execute("INSERT INTO resume(filename,text,uploaded) VALUES(?,?,?)", (path.name, text, datetime.now().isoformat(timespec="minutes")))
            conn.execute("INSERT INTO profile(key,value) VALUES('watch_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (digest,))
            conn.execute("INSERT INTO activity(kind,summary,created) VALUES(?,?,?)", ("Resume updated", f"A saved change to {path.name} was recorded locally.", datetime.now().isoformat(timespec="minutes")))
        return True
    except Exception:
        return False


def watch_resume_loop():
    """Poll only the single resume file path explicitly chosen by the user."""
    while True:
        sync_watched_resume_once()
        time.sleep(4)


def pdfkit_words(path: Path) -> set[str]:
    """Words as macOS PDFKit reads them, via the helper bundled with the Mac
    app (APPLY_DESK_PDFTEXT). Empty when running outside the app."""
    helper = os.environ.get("APPLY_DESK_PDFTEXT", "")
    if not helper or not os.access(helper, os.X_OK):
        return set()
    try:
        output = subprocess.run([helper, str(path)], capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return set()
    return set(unicodedata.normalize("NFKC", output).split())


def respace(text: str, words: set[str]) -> str:
    """Repair word spacing in layout-mode text using PDFKit's words: split
    glued words ("anunintended" → "an unintended") and join split ones
    ("V A" → "VA"). Lines, columns, and every other character stay as they are."""
    def split(token: str) -> str:
        if token in words or len(token) > 80:
            return token
        best = [None] * (len(token) + 1)
        best[0] = []
        for end in range(1, len(token) + 1):
            for start in range(max(0, end - 40), end):
                if best[start] is not None and token[start:end] in words and (best[end] is None or len(best[start]) + 1 < len(best[end])):
                    best[end] = best[start] + [token[start:end]]
        return " ".join(best[-1]) if best[-1] and len(best[-1]) > 1 else token

    lines = []
    for line in text.splitlines():
        parts = re.split(r"( +)", line)
        # Join a single-space split when only the joined form is a real word.
        i = 0
        while i + 2 < len(parts):
            left, gap, right = parts[i], parts[i + 1], parts[i + 2]
            if gap == " " and left and right and left + right in words and (left not in words or right not in words):
                parts[i:i + 3] = [left + right]
            else:
                i += 2
        lines.append("".join(split(part) if part.strip() else part for part in parts))
    return "\n".join(lines)


def extract_text(path: Path, ext: str) -> str:
    if ext == "pdf":
        from pypdf import PdfReader
        pages = []
        for page in PdfReader(str(path)).pages:
            try:
                # Layout mode keeps right-aligned dates and locations apart
                # from the text on their left, as in Jake's resume.
                pages.append(page.extract_text(extraction_mode="layout") or "")
            except Exception:
                pages.append(page.extract_text() or "")
        # PDFs often store "fi"/"fl" as single ligature characters, which would
        # hide words like "configuration" or "workflow" from matching.
        text = unicodedata.normalize("NFKC", "\n".join(pages))
        # Mark a wide gap between columns with four spaces (see header_columns)
        # and fold the double spaces layout mode leaves inside text.
        lines = (re.sub(r"(?<=\S) {3,}(?=\S)", "    ", line.strip()) for line in text.splitlines())
        text = "\n".join(re.sub(r"(?<=\S) {2}(?=\S)", " ", line) for line in lines)
        words = pdfkit_words(path)
        return respace(text, words) if words else text
    if ext == "docx":
        from docx import Document
        doc = Document(path)
        lines = []
        for paragraph in doc.paragraphs:
            # Word stores bullets as list formatting, not text; keep a marker
            # so resume tuning can tell bullets from entry headings.
            style = (paragraph.style.name or "").lower() if paragraph.style is not None else ""
            numbered = paragraph._p.pPr is not None and paragraph._p.pPr.numPr is not None
            lines.append(("• " + paragraph.text) if paragraph.text.strip() and (style.startswith("list") or numbered) else paragraph.text)
        return "\n".join(lines)
    return path.read_text(errors="replace")


STOP = set("a an and are as at be by for from in into is it of on or that the their then this to we with will you your using use our including experience ability required preferred plus years internship internship summer engineer engineering computer software skills work team strong develop build".split())


def keywords(text: str) -> list[str]:
    words = re.findall(r"[A-Za-z][A-Za-z0-9+#.\-/]{1,}", text.lower())
    counts: dict[str, int] = {}
    for word in words:
        word = word.strip(".-/")
        if len(word) > 2 and word not in STOP and not word.isdigit():
            counts[word] = counts.get(word, 0) + 1
    return [k for k, _ in sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))[:40]]


# ---------------------------------------------------------------------------
# Resume structure. Tuning only reorders the user's own lines; it never adds
# words, so every claim in a tuned resume already appears in the source.

BULLET = re.compile(r"^\s*(?:[•●▪◦‣∙·*–—-]|\d{1,2}[.)])\s+")
KNOWN_HEADINGS = {
    "education", "experience", "work experience", "professional experience", "relevant experience", "employment",
    "projects", "personal projects", "technical projects", "academic projects", "selected projects",
    "skills", "technical skills", "skills and interests", "skills and tools", "languages", "interests",
    "leadership", "leadership experience", "activities", "leadership and activities", "involvement",
    "campus involvement", "awards", "honors", "honors and awards", "awards and honors", "certifications",
    "publications", "research", "research experience", "relevant coursework", "coursework", "summary",
    "objective", "volunteer", "volunteering", "volunteer experience", "extracurriculars", "extracurricular activities",
    "honors and competitions", "competitions", "achievements", "awards and achievements", "hackathons", "honors and activities",
}
LATEX_COMMANDS = re.compile(r"\\(section|resumeSubheading|resumeSubSubheading|resumeProjectHeading|resumeSubItem|resumeItem|textbf)\b")
LATEX_ARGS = {"section": 1, "resumeSubheading": 4, "resumeSubSubheading": 2, "resumeProjectHeading": 2, "resumeItem": 1, "resumeSubItem": 1}


def is_latex(text: str) -> bool:
    return "\\resumeItem" in text or "\\documentclass" in text or "\\section{" in text


def heading_kind(title: str) -> str:
    lower = title.lower()
    if "skill" in lower or lower in {"languages", "interests"}:
        return "skills"
    if "project" in lower:
        return "projects"
    if "education" in lower or "coursework" in lower:
        return "education"
    if lower in {"summary", "objective"}:
        return "summary"
    return "experience"


def as_heading(line: str) -> str | None:
    text = line.strip().rstrip(":").strip()
    if not text or len(text) > 42 or BULLET.match(line) or re.search(r"\d", text):
        return None
    normalized = re.sub(r"\s+", " ", text.lower().replace("&", "and"))
    return text if normalized in KNOWN_HEADINGS else None


def read_groups(source: str, index: int, count: int):
    """Read `count` consecutive {…} groups from a LaTeX string."""
    groups = []
    for _ in range(count):
        while index < len(source) and source[index].isspace():
            index += 1
        if index >= len(source) or source[index] != "{":
            return None, index
        depth, start = 0, index
        while index < len(source):
            char = source[index]
            if char == "\\":
                index += 2
                continue
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    break
            index += 1
        if depth:
            return None, index
        groups.append(source[start + 1:index])
        index += 1
    return groups, index


def latex_plain(value: str) -> str:
    value = re.sub(r"(?<!\\)%.*", "", value)
    value = re.sub(r"\\(?:vspace|hspace)\*?\{[^{}]*\}", " ", value)
    value = re.sub(r"\\(?:begin|end)\{[^{}]*\}(?:\{[^{}]*\})?", " ", value)
    value = re.sub(r"\\href\{[^{}]*\}", "", value)
    value = value.replace("\\\\", " ").replace("$|$", "|").replace("--", "–").replace("~", " ")
    value = re.sub(r"(?<!\\)\$", "", value)
    for escaped in "&%$#_":
        value = value.replace("\\" + escaped, escaped)
    value = re.sub(r"\\[a-zA-Z]+\*?(?:\[[^\]]*\])?", " ", value)
    value = value.replace("{", "").replace("}", "")
    return re.sub(r"\s+", " ", value).strip()


def latex_outline(source: str):
    """Turn a Jake's-style LaTeX resume into header lines and sections."""
    body = source.split("\\begin{document}", 1)[-1].split("\\end{document}", 1)[0]
    body = re.sub(r"(?<!\\)%.*", "", body)
    first = body.find("\\section")
    header = body[:first] if first >= 0 else ""
    preamble = [line for line in (latex_plain(part) for part in header.split("\\\\")) if line]
    sections, current, pos = [], None, max(first, 0)
    while True:
        match = LATEX_COMMANDS.search(body, pos)
        if not match:
            break
        command = match.group(1)
        if command == "textbf":
            groups, end = read_groups(body, match.end(), 2)
            if not groups or not groups[1].lstrip().startswith(":"):
                pos = match.end()
                continue
            line = f"{latex_plain(groups[0])}: {latex_plain(groups[1].lstrip()[1:])}"
            if current is not None:
                current["entries"].append({"header": [line], "bullets": []})
            pos = end
            continue
        groups, end = read_groups(body, match.end(), LATEX_ARGS[command])
        if groups is None:
            pos = match.end()
            continue
        plain = [latex_plain(group) for group in groups]
        if command == "section":
            current = {"title": plain[0], "kind": heading_kind(plain[0]), "entries": []}
            sections.append(current)
        elif current is not None and command in {"resumeItem", "resumeSubItem"}:
            if not current["entries"]:
                current["entries"].append({"header": [], "bullets": []})
            current["entries"][-1]["bullets"].append(plain[0])
        elif current is not None:
            pairs = ["    ".join(part for part in plain[i:i + 2] if part) for i in range(0, len(plain), 2)]
            current["entries"].append({"header": [pair for pair in pairs if pair], "bullets": []})
        pos = end
    return preamble, sections


def text_outline(text: str):
    """Split plain resume text into header lines and section → entry → bullets."""
    preamble, sections, current = [], [], None
    last_length = 0
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        title = as_heading(line)
        if title:
            current = {"title": title, "kind": heading_kind(title), "entries": []}
            sections.append(current)
            continue
        if current is None:
            preamble.append(line)
            continue
        entries = current["entries"]
        bullet = BULLET.match(raw)
        if bullet:
            if not entries:
                entries.append({"header": [], "bullets": []})
            entries[-1]["bullets"].append(BULLET.sub("", line, count=1).strip())
            last_length = len(line)
        elif entries and entries[-1]["bullets"] and (line[:1].islower() or (
                last_length >= 72 and "|" not in line and not re.search(r"\b(?:19|20)\d{2}\b|present\b", line, re.IGNORECASE))):
            # A wrapped bullet from PDF extraction continues on the next line.
            entries[-1]["bullets"][-1] += " " + line
            last_length = len(line)
        else:
            if not entries or entries[-1]["bullets"]:
                entries.append({"header": [], "bullets": []})
            entries[-1]["header"].append(line)
    return preamble, sections


def resume_outline(text: str):
    return latex_outline(text) if is_latex(text) else text_outline(text)


def outline_text(preamble, sections) -> str:
    parts = ["\n".join(preamble)] if preamble else []
    for section in sections:
        lines = [section["title"].upper()]
        for entry in section["entries"]:
            lines += entry["header"] + ["• " + bullet for bullet in entry["bullets"]]
        parts.append("\n".join(lines))
    return "\n\n".join(parts)


def resume_plain(text: str) -> str:
    """Resume text for matching; LaTeX markup would otherwise read as skills."""
    return outline_text(*latex_outline(text)) if is_latex(text) else text


def term_hits(text: str, terms) -> list[str]:
    lower = text.lower()
    return [term for term in terms if re.search(r"(?<![a-z0-9])" + re.escape(term) + r"(?![a-z0-9])", lower)]


# Posting boilerplate that says nothing about a candidate's evidence.
TUNING_NOISE = set("intern interns students student graduating graduate candidates candidate role roles company join help new who looking opportunity".split())


def tuning_terms(description: str, title: str = "") -> list[str]:
    terms = [term for term in keywords(f"{title} {description}") if term not in TUNING_NOISE]
    skills = [x.strip().lower() for x in re.split(r"[,;\n]", profile().get("skills", "")) if x.strip()]
    body = f"{title} {description}".lower()
    return list(dict.fromkeys(terms + term_hits(body, skills)))


def reorder_list_items(items: str, terms) -> tuple[str, list[str]]:
    parts = [part.strip() for part in items.split(",") if part.strip()]
    if len(parts) < 2:
        return items, []
    lead = [part for part in parts if term_hits(part, terms)]
    if not lead or parts[:len(lead)] == lead:
        return items, []
    return ", ".join(lead + [part for part in parts if part not in lead]), lead


def relevance_sort(lines, terms):
    """Stable sort by matched job terms; returns new order and whether it moved."""
    scored = sorted(enumerate(lines), key=lambda pair: -len(term_hits(pair[1], terms)))
    order = [line for _, line in scored]
    return order, order != list(lines)


def entry_label(entry) -> str:
    first = entry["header"][0] if entry["header"] else ""
    return re.split(r"\s{2,}| \| | · |\s+(?:[A-Z][a-z]{2}\.? )?(?:19|20)\d{2}\b", first)[0].strip()[:60]


def section_name(section) -> str:
    return section["title"].title() if section["title"].isupper() else section["title"]


def change(kind: str, label: str, note: str, before: str | None = None, after: str | None = None) -> dict:
    """One reviewable tuning edit; `kind` is order, wording, title, or skills."""
    return {"kind": kind, "label": label, "note": note, "before": before, "after": after}


def latex_escape(text: str) -> str:
    return re.sub(r"([#$%&_{}])", r"\\\1", text)


def tailor_skill_lists(lists, terms, rules, resume_text: str, changes, spell, escape=lambda text: text):
    """Spell, reorder, and extend skill lists given as (label or None, items)."""
    labeled = [i for i, (label, _) in enumerate(lists) if label]
    additions = rules.skills_to_add(resume_text) if labeled else []
    placed = tailoring.place_skills([lists[i][0] for i in labeled], additions)
    out = []
    for i, (label, items) in enumerate(lists):
        name = label or "Skills"
        spelled = spell(items)
        if spelled != items:
            changes.append(change("wording", name, "Matched the posting's spelling.", latex_plain(items), latex_plain(spelled)))
        ordered, lead = reorder_list_items(spelled, terms)
        extra = placed.get(labeled.index(i), []) if i in labeled else []
        if extra:
            parts = [part.strip() for part in ordered.split(",") if part.strip()]
            parts[len(lead):len(lead)] = [escape(skill) for skill in extra]
            ordered = ", ".join(parts)
            changes.append(change("skills", name, f"Added {', '.join(extra)} from your profile; the posting asks for {'it' if len(extra) == 1 else 'them'}."))
        if lead:
            changes.append(change("order", name, f"Led with {', '.join(latex_plain(x) for x in lead[:4])}."))
        out.append(ordered)
    return out


def tune_text_resume(text: str, terms, rules):
    preamble, sections = text_outline(text)
    changes = []
    style = tailoring.period_style([b for s in sections if s["kind"] in {"experience", "projects"} for e in s["entries"] for b in e["bullets"]])
    for section in sections:
        if section["kind"] in {"education", "summary"}:
            continue
        if section["kind"] == "skills":
            slots = [(entry, key, index) for entry in section["entries"] for key in ("header", "bullets") for index in range(len(entry[key]))]
            lists = []
            for entry, key, index in slots:
                label, colon, items = entry[key][index].partition(":")
                lists.append((label.strip(), items) if colon else (None, entry[key][index]))
            tuned = tailor_skill_lists(lists, terms, rules, text, changes, rules.spell)
            for (entry, key, index), (label, _), items in zip(slots, lists, tuned):
                entry[key][index] = f"{label}: {items.strip()}" if label else items
            continue
        for entry in section["entries"]:
            label = entry_label(entry) or section_name(section)
            if section["kind"] == "experience":
                titled = [tailoring.expand_title(line) for line in entry["header"]]
                for before, after in zip(entry["header"], titled):
                    if before != after:
                        changes.append(change("title", label, "Spelled out the job title.", before.split("    ")[0], after.split("    ")[0]))
                entry["header"] = titled
            if section["kind"] == "projects" and entry["header"]:
                name, bar, rest = entry["header"][0].partition(" | ")
                if bar and rules.spell(rest) != rest:
                    changes.append(change("wording", name.strip(), "Matched the posting's spelling.", rest.split("    ")[0], rules.spell(rest).split("    ")[0]))
                    entry["header"][0] = name + bar + rules.spell(rest)
            edited = []
            for bullet in entry["bullets"]:
                after, reasons = tailoring.reword(bullet, rules, style)
                if reasons:
                    changes.append(change("wording", label, tailoring.describe(reasons), bullet, after))
                edited.append(after)
            entry["bullets"], moved = relevance_sort(edited, terms)
            if moved:
                lead = term_hits(entry["bullets"][0], terms)[:3]
                changes.append(change("order", label, f"Opened with the bullet on {', '.join(lead)}."))
    return outline_text(preamble, sections), changes


def latex_section_at(source: str, index: int) -> str:
    """Kind of the \section that contains position `index`."""
    start = source.rfind("\\section{", 0, index)
    if start < 0:
        return "other"
    groups, _ = read_groups(source, start + len("\\section"), 1)
    return heading_kind(latex_plain(groups[0])) if groups else "other"


def tune_latex_resume(source: str, terms, rules):
    changes = []
    body_start = source.find("\\begin{document}")
    items = [read_groups(source, m.end(), 1)[0] for m in re.finditer(r"\\resume(?:Sub)?Item\b", source) if m.start() > body_start]
    style = tailoring.period_style([latex_plain(item[0]) for item in items if item])

    def reword_items(body: str, label: str) -> str:
        pos = 0
        pattern = re.compile(r"\\resume(?:Sub)?Item\b")
        rebuilt, last = [], 0
        while True:
            item = pattern.search(body, pos)
            if not item:
                break
            groups, end = read_groups(body, item.end(), 1)
            if groups is None:
                return body
            brace = body.index("{", item.end())
            edited, reasons = tailoring.edit_latex_bullet(groups[0], rules, style)
            if reasons:
                changes.append(change("wording", label or "Bullet", tailoring.describe(reasons), latex_plain(groups[0]), latex_plain(edited)))
            rebuilt.append(body[last:brace + 1] + edited + "}")
            last = pos = end
        rebuilt.append(body[last:])
        return "".join(rebuilt)

    def heading_label(before: str) -> str:
        heading = max(before.rfind("\\resumeSubheading"), before.rfind("\\resumeProjectHeading"))
        if heading < 0:
            return ""
        groups, _ = read_groups(before, before.index("{", heading), 1)
        return latex_plain(groups[0]).split("|")[0].strip() if groups else ""

    def tune_block(match):
        if latex_section_at(source, match.start()) in {"education", "summary"}:
            return match.group(0)
        label = heading_label(source[:match.start()])
        body = reword_items(match.group(2), label)
        spans, pos = [], 0
        while True:
            item = re.compile(r"\\resume(?:Sub)?Item\b").search(body, pos)
            if not item:
                break
            groups, end = read_groups(body, item.end(), 1)
            if groups is None:
                return match.group(1) + body + match.group(3)
            spans.append((item.start(), end))
            pos = end
        gaps = [body[spans[i][1]:spans[i + 1][0]] for i in range(len(spans) - 1)]
        if len(spans) < 2 or any(gap.strip() for gap in gaps):
            return match.group(1) + body + match.group(3)
        ordered, moved = relevance_sort([body[start:end] for start, end in spans], terms)
        if moved:
            lead = term_hits(latex_plain(ordered[0]), terms)[:3]
            changes.append(change("order", label or "Bullet list", f"Opened with the bullet on {', '.join(lead)}."))
            body = body[:spans[0][0]] + "".join(ordered[i] + (gaps[i] if i < len(gaps) else "") for i in range(len(ordered))) + body[spans[-1][1]:]
        return match.group(1) + body + match.group(3)

    def tune_heading(match):
        kind = latex_section_at(source, match.start())
        count = 4 if match.group(1) == "Subheading" else 2
        groups, end = read_groups(source, match.end(), count)
        if groups is None or kind == "education":
            return None
        if match.group(1) == "Subheading":
            edited = [tailoring.expand_title(g) if i in (0, 2) else g for i, g in enumerate(groups)]
            note = "Spelled out the job title."
            kind_name = "title"
        else:
            edited = [tailoring.map_latex_text(groups[0], rules.spell, protect=("href", "url", "textbf"))] + groups[1:]
            note = "Matched the posting's spelling."
            kind_name = "wording"
        for before, after in zip(groups, edited):
            if before != after:
                changes.append(change(kind_name, latex_plain(groups[0]).split("|")[0].strip(), note, latex_plain(before), latex_plain(after)))
        return end, edited

    # Headings first (titles, project tech lists), editing only their arguments.
    out, pos = [], 0
    for match in re.finditer(r"\\resume(Subheading|ProjectHeading)\b", source):
        if match.start() < body_start or match.start() < pos:
            continue
        result = tune_heading(match)
        if not result:
            continue
        end, edited = result
        out.append(source[pos:match.end()] + "".join("{" + g + "}" for g in edited))
        pos = end
    out.append(source[pos:])
    tuned = "".join(out)

    source = tuned  # section lookups below read the heading-edited text
    tuned = re.sub(r"(\\resumeItemListStart)(.*?)(\\resumeItemListEnd)", tune_block, tuned, flags=re.S)

    skills = [m for m in re.finditer(r"\\textbf\{([^{}]*)\}\{:\s*([^{}]*)\}", tuned) if latex_section_at(tuned, m.start()) == "skills"]
    if skills:
        lists = [(latex_plain(m.group(1)), m.group(2)) for m in skills]
        new_items = tailor_skill_lists(lists, terms, rules, latex_plain(tuned), changes,
                                       lambda items: tailoring.map_latex_text(items, rules.spell), latex_escape)
        pieces, last = [], 0
        for m, items in zip(skills, new_items):
            pieces.append(tuned[last:m.start()] + "\\textbf{" + m.group(1) + "}{: " + items.strip() + "}")
            last = m.end()
        pieces.append(tuned[last:])
        tuned = "".join(pieces)
    return tuned, changes


def tune_resume(text: str, description: str, title: str = ""):
    """Tune the user's own resume for one role without touching its layout:
    relevant bullets lead, wording mirrors the posting's spelling and opens
    with an action, and skills the posting asks for (that the user listed in
    their profile) are added to the skills section."""
    terms = tuning_terms(description, title)
    declared = [x.strip() for x in re.split(r"[,;\n]", profile().get("skills", "")) if x.strip()]
    rules = tailoring.Rules(f"{title}\n{description}", declared)
    latex = is_latex(text)
    tuned, changes = tune_latex_resume(text, terms, rules) if latex else tune_text_resume(text, terms, rules)
    preamble, sections = resume_outline(tuned)
    plain = outline_text(preamble, sections)
    present = term_hits(plain, terms)
    for section in sections:
        for entry in section["entries"]:
            entry["bullets"] = [{"text": bullet, "hits": len(term_hits(bullet, present))} for bullet in entry["bullets"]]
    return {"text": tuned, "extension": "tex" if latex else "txt", "preamble": preamble, "sections": sections,
            "changes": changes, "terms": present}


def highlight(text: str, terms) -> Markup:
    """Escape resume text and mark job terms that it already contains."""
    safe = str(escape(text))
    if not terms:
        return Markup(safe)
    pattern = re.compile(r"(?<![a-z0-9&#])(" + "|".join(re.escape(str(escape(t))) for t in sorted(terms, key=len, reverse=True)) + r")(?![a-z0-9])", re.IGNORECASE)
    return Markup(pattern.sub(r"<mark>\1</mark>", safe))


def header_columns(line: str) -> tuple[str, str]:
    """Split an entry heading into its left text and right-aligned date or place."""
    left, gap, right = line.rpartition("    ")
    return (left.strip(), right.strip()) if gap and left.strip() else (line.strip(), "")


def word_diff(before: str, after: str) -> tuple[Markup, Markup]:
    """Before/after text with removed words struck and added words marked."""
    import difflib
    a, b = re.findall(r"\S+|\s+", before or ""), re.findall(r"\S+|\s+", after or "")
    old, new = [], []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
        left, right = str(escape("".join(a[i1:i2]))), str(escape("".join(b[j1:j2])))
        old.append(left if op == "equal" else f"<del>{left}</del>" if left.strip() else left)
        new.append(right if op == "equal" else f"<ins>{right}</ins>" if right.strip() else right)
    return Markup("".join(old)), Markup("".join(new))


def tier(score) -> str:
    score = int(score or 0)
    return "high" if score >= 60 else "mid" if score >= 40 else "low"


app.jinja_env.filters["highlight"] = highlight
app.jinja_env.filters["tier"] = tier
app.jinja_env.filters["columns"] = header_columns
app.jinja_env.globals["word_diff"] = word_diff


def analyze(description: str):
    resume = resume_row()
    if not resume:
        return {"score": 0, "matched": [], "missing": [], "terms": []}
    terms = keywords(description)
    rtext = resume_plain(resume["text"]).lower()
    matched = [term for term in terms if term in rtext]
    missing = [term for term in terms if term not in rtext]
    score = round(100 * len(matched) / max(1, len(terms)))
    return {"score": score, "matched": matched[:12], "missing": missing[:12], "terms": terms}


# Rough, blunt odds of an offer for one application, from the posting's wording
# and how internship hiring usually goes. Points move a role between tiers;
# blockers end it. Kept separate from the fit score, which is not a probability.
BIG_TECH = r"\b(google|alphabet|meta|facebook|apple|amazon|aws|microsoft|netflix|nvidia|openai|anthropic|stripe|airbnb|uber|lyft|linkedin|salesforce|adobe|databricks|snowflake|palantir|tesla|spacex|bloomberg|coinbase|robinhood|doordash|pinterest|snap|spotify|shopify|roblox|figma|ramp|scale ai|anduril)\b"
QUANT = r"\b(jane street|citadel|two sigma|hudson river|jump trading|optiver|imc trading|d\.? ?e\.? shaw|five rings|akuna|susquehanna|drw|tower research|virtu|arrowstreet|aqr|bridgewater|renaissance|point72|millennium|balyasny|squarepoint|old mission|peak6|wolverine|flow traders|xtx|g-research|voleon)\b"
DEFENSE = r"\b(leidos|booz allen|saic|northrop|lockheed|raytheon|rtx|general dynamics|gdit|bae systems|caci|mitre|peraton|l3harris|mantech|parsons|huntington ingalls|boeing|jhu ?apl|johns hopkins applied physics)\b"
ODDS_TIERS = [(-99, "Long shot", "under 1%"), (-3, "Unlikely", "1–3%"), (-1, "Possible", "3–6%"), (1, "Decent shot", "6–12%"), (4, "Good shot", "12–20%")]


def role_odds(job: dict, match: dict, p: dict, resume_text: str) -> dict:
    text = f"{job.get('title', '')} {job.get('company', '')} {job.get('description', '')}".lower()
    # Who's hiring comes from the company name, or the posting introducing
    # itself ("At Leidos, …", "Northrop Grumman is …"); a mention like
    # "deploys to AWS" isn't Amazon.
    company = (job.get("company") or "").lower()
    opening = (job.get("description") or "")[:300].lower()
    def employer(kinds: str) -> bool:
        return bool(re.search(kinds, company) or re.search(rf"(?:^|\bat |\babout ){kinds}|{kinds}(?: is| has|'s|,)", opening))
    year = (p.get("class_year") or "").strip().lower()
    early = year in {"freshman", "sophomore"}
    points, reasons, blockers = 0, [], []

    def note(delta, reason):
        nonlocal points
        points += delta
        reasons.append({"delta": delta, "text": reason})

    if re.search(r"(must|required to) (have|possess|hold) an? (active|current)[^.]{0,30}clearance|(active|current) (secret|top secret|ts(/sci)?|security) clearance (is )?(required|needed)", text):
        blockers.append("It needs an active security clearance, which you don't have. Interns are rarely sponsored for one this fast.")
    if re.search(r"(must be|currently) (enrolled in|pursuing) an? (master|ph\.?d|doctoral|graduate)|(ms|phd|graduate) students only", text):
        blockers.append("It's for graduate students only.")
    if match.get("eligibility") == "possible mismatch":
        blockers.append("Your graduation date is outside the window they list.")
    upper = re.search(r"rising (junior|senior)|(junior|senior) (standing|year|class)|juniors? (or|and|&) seniors?|third[- ]year|fourth[- ]year|final[- ]year|penultimate|(sophomore|junior) or (above|higher)|completed (at least )?(two|2|three|3) years", text)
    under = re.search(r"freshm[ae]n|first[- ]year (student|undergrad)|sophomores?|second[- ]year (student|undergrad)|all (class )?years|any (class )?year|underclass|explore (program|intern)|step intern", text)

    cap = len(ODDS_TIERS) - 1
    if employer(QUANT):
        note(-4, "Quant and trading firms take almost no freshmen; their intern classes are mostly juniors and seniors picked from a huge pool.")
        cap = 1
    elif employer(BIG_TECH):
        note(-3, "Big tech SWE internships take a few percent of applicants, and most offers go to juniors and seniors.")
        cap = 1 if not (early and under) else 2
    elif employer(DEFENSE):
        note(1, "Defense contractors hire students earlier than big tech and value U.S. citizens who can get a clearance.")
    if early and under:
        note(2, "They explicitly welcome first- or second-year students. That's the right door, but these spots are still competitive.")
    elif early and upper:
        note(-3, "They ask for juniors or seniors. As a freshman you'll likely be screened out before a person reads your resume.")
    elif year == "freshman":
        note(-2, "Most SWE internships quietly favor juniors and seniors, even when the posting doesn't say so. Freshman offers are rare.")
    elif year == "sophomore":
        note(-1, "Most SWE internships quietly favor juniors and seniors, even when the posting doesn't say so.")
    if match.get("eligibility") == "likely eligible":
        note(1, "Your graduation date fits the window they list.")
    if re.search(r"u\.?s\.? citizen(ship)?[^.]{0,20}(required|only)|must be an? u\.?s\.? citizen|requires? u\.?s\.? citizenship|citizenship is required", text) and (p.get("us_citizen") or "").lower() == "yes":
        note(1, "It requires U.S. citizenship, which shrinks the applicant pool, and you qualify.")
    if re.search(r"\bintern(ship)?\b", resume_text or "", re.I):
        note(1, "You already have a software internship on your resume, which most freshmen don't.")
    if re.search(r"(minimum|min\.?)( cumulative)? gpa|gpa of (at least )?[23]\.\d|[23]\.\d\s*(/\s*4(\.0)?)?\s*(gpa )?(or (higher|above|better)|\+|minimum)", text) and (p.get("gpa") or "").strip().lower() in {"", "n/a", "na", "none"}:
        note(-2, "They set a minimum GPA and you don't have one yet. Many screens drop applications without one automatically.")
    skills = (match.get("breakdown") or {}).get("skills", 0)
    if skills >= 60:
        note(1, "Your resume covers most of the skills they list.")
    elif skills <= 20:
        note(-1, "Your resume covers few of the skills they list.")
    state = (p.get("state") or "").strip()
    state_name = applying.STATES.get(state.upper(), state)
    if state and re.search(rf"\b{re.escape(state_name.lower())}\b|,\s*{re.escape(state.lower())}\b", text):
        note(1, "It's in your state, and local candidates are easier to hire.")

    if blockers:
        label, odds = "Very unlikely", "under 1%"
    else:
        index = max(i for i, tier in enumerate(ODDS_TIERS) if points >= tier[0])
        label, odds = ODDS_TIERS[min(index, cap)][1:]
    helps = ("Find someone at the company for a referral; it beats any resume change."
             if not blockers else "Spend this time on roles that fit your year instead.")
    return {"label": label, "odds": odds, "blockers": blockers, "reasons": sorted(reasons, key=lambda r: r["delta"]), "helps": helps,
            "year": p.get("class_year") or "", "points": points}


def match_role(description: str, title: str = "", wave: str = "", sector: str = "", funding_stage: str = ""):
    """Explainable candidate-to-role triage; never a hiring probability."""
    p = profile()
    resume = resume_row()
    if not resume:
        return {"score": 0, "status": "Add a resume", "eligibility": "unknown", "breakdown": {"skills": 0, "role": 0, "goals": 0, "campaign": 0, "graduation": 0}, "matched_skills": [], "reasons": ["Add a resume to compare role requirements with your experience."]}
    body = f"{title} {description}".lower()
    explicit_skills = [x.strip().lower() for x in re.split(r"[,;\n]", p.get("skills", "")) if x.strip()]
    inferred_skills = keywords(resume_plain(resume["text"]))
    candidate_skills = list(dict.fromkeys(explicit_skills + inferred_skills))
    # Whole-word matches, so "C" doesn't match every posting and "Java" doesn't match "JavaScript".
    matched_skills = term_hits(body, candidate_skills)
    skill_score = round(100 * len(matched_skills) / max(1, min(8, len(candidate_skills)))) if candidate_skills else 0
    targets = [x.strip().lower() for x in re.split(r"[,;\n]", p.get("target_roles", "")) if x.strip()]
    role_hits = [target for target in targets if target in title.lower() or (len(target.split()) > 1 and target in body)]
    role_score = 100 if role_hits else (35 if any(word in body for word in ("intern", "internship", "early career", "new grad")) else 0)
    goals = [x.strip().lower() for x in re.split(r"[,;\n]", p.get("career_goals", "")) if x.strip()]
    goal_hits = term_hits(body, goals)
    goal_score = round(100 * len(goal_hits) / len(goals)) if goals else 50
    campaigns = [x.strip() for x in re.split(r"[,;\n]", p.get("role_campaigns", "")) if x.strip()]
    campaign_text = " ".join([wave, sector, funding_stage, title, description]).lower()
    campaign_hits = [campaign for campaign in campaigns if campaign.lower() in campaign_text]
    campaign_score = 100 if (wave and any(wave.lower() == c.lower() for c in campaigns)) else (70 if campaign_hits else 30)

    grad = re.search(r"\b(20\d{2})\b", p.get("graduation", ""))
    graduation_context_years = []
    for marker in re.finditer(r"graduat\w*|class\s+of", description, flags=re.IGNORECASE):
        snippet = description[max(0, marker.start() - 50):min(len(description), marker.end() + 100)]
        graduation_context_years.extend(int(y) for y in re.findall(r"\b20\d{2}\b", snippet))
    grad_year = int(grad.group(1)) if grad else None
    # A listing often repeats its one graduation year; repeats are not a window.
    graduation_context_years = sorted(set(graduation_context_years))
    eligibility = "unknown"
    grad_score = 50
    reasons = []
    if grad_year and len(graduation_context_years) >= 2:
        low, high = min(graduation_context_years), max(graduation_context_years)
        if low <= grad_year <= high:
            eligibility, grad_score = "likely eligible", 100
            reasons.append(f"Your {grad_year} graduation year falls within the listed {low}–{high} window.")
        elif grad_year < low or grad_year > high:
            eligibility, grad_score = "possible mismatch", 0
            reasons.append(f"The listing mentions {low}–{high}; verify whether your {grad_year} graduation year is eligible.")
    elif grad_year and graduation_context_years:
        year = graduation_context_years[0]
        if year == grad_year:
            eligibility, grad_score = "likely eligible", 100
            reasons.append(f"The listing mentions your {grad_year} graduation year.")
        elif abs(year - grad_year) <= 1:
            eligibility, grad_score = "verify", 35
            reasons.append(f"The listing mentions {year}; check the employer's exact graduation rules for your {grad_year} year.")
        else:
            eligibility, grad_score = "possible mismatch", 0
            reasons.append(f"The listing mentions {year}, while your profile says {grad_year}; verify eligibility before applying.")

    breakdown = {"skills": skill_score, "role": role_score, "goals": goal_score, "campaign": campaign_score, "graduation": grad_score}
    score = round(skill_score * .40 + role_score * .25 + goal_score * .15 + campaign_score * .10 + grad_score * .10)
    if eligibility == "possible mismatch":
        status = "Check eligibility"
    elif score >= 60:
        status = "Strong match — review application"
    elif score >= 40:
        status = "Potential match — review details"
    else:
        status = "Low match"
    if matched_skills:
        reasons.append("Resume evidence found for: " + ", ".join(matched_skills[:5]) + ".")
    if role_hits:
        reasons.append("Target role alignment: " + ", ".join(role_hits[:3]) + ".")
    if goal_hits:
        reasons.append("Career goal terms found: " + ", ".join(goal_hits[:3]) + ".")
    if wave:
        reasons.append(f"Campaign: {wave}" + (f" · {sector}" if sector else "") + (f" · {funding_stage}" if funding_stage else "") + ".")
    if not reasons:
        reasons.append("Few configured role, skill, or goal signals matched this listing.")
    return {"score": score, "status": status, "eligibility": eligibility, "breakdown": breakdown, "matched_skills": matched_skills[:12], "reasons": reasons[:5]}


def safe_http_url(value: str) -> str:
    value = str(value or "").strip()[:2000]
    try:
        parsed = urlparse(value)
        if parsed.scheme in {"http", "https"} and parsed.hostname:
            return value
    except ValueError:
        pass
    return ""


# A fill run's record and a resume saved as a PDF are different kinds of
# record; each role keeps the latest of each.
FILL_RECORD = "(run != '' OR attached = 1 OR filled != '')"


def find_role(conn, role: dict):
    """The saved role (id, url) for this posting, if it was saved before."""
    for row in conn.execute("SELECT id, url, title, company, description FROM jobs ORDER BY saved DESC, id DESC"):
        if applying.same_posting(role, dict(row)):
            return row
    return None


def unique_review(items: list[dict]) -> list[dict]:
    """One line per question on a page, the latest answer winning: a second
    press refills the page, and a redo adds to what the first run filled."""
    latest = {}
    for item in items:
        latest[(item.get("page"), item.get("question"))] = item
    return list(latest.values())


def fields_filled(review: list[dict]) -> str:
    return f"{len(review)} field{'s' if len(review) != 1 else ''}"


def merge_duplicates():
    """Earlier versions saved a posting again when its URL was written another
    way, and every redo of an application as a new record. Merge them into one
    role (the latest scan) and one record of each kind per role, keeping a copy
    of the data from before the first merge."""
    with db() as conn:
        jobs = [dict(row) for row in conn.execute("SELECT id, url, title, company, description FROM jobs ORDER BY saved DESC, id DESC")]
        kept, moves = [], []
        for job in jobs:
            same = next((other for other in kept if applying.same_posting(job, other)), None)
            if same:
                moves.append((job["id"], same["id"]))
                same["url"] = applying.better_url(same["url"], job["url"])
            else:
                kept.append(job)
        records = conn.execute(f"SELECT id, job_id, {FILL_RECORD} AS fill, review FROM applications ORDER BY id DESC").fetchall()
        target = dict(moves)
        latest, stale, reviews, repeated = {}, [], {}, False
        for record in records:
            key = (target.get(record["job_id"], record["job_id"]), record["fill"])
            review = json.loads(record["review"] or "[]")
            if key in latest:
                stale.append(record["id"])
                reviews[latest[key]] = review + reviews[latest[key]]  # older runs' answers first
            else:
                latest[key] = record["id"]
                reviews[record["id"]] = review
            repeated = repeated or len(unique_review(review)) != len(review)
    if not moves and not stale and not repeated:
        return
    backup = INSTANCE / "resume_tailor.before-merge.sqlite3"
    if not backup.exists():
        shutil.copy2(DB, backup)
    with db() as conn:
        for old, new in moves:
            conn.execute("UPDATE applications SET job_id=? WHERE job_id=?", (new, old))
            conn.execute("DELETE FROM jobs WHERE id=?", (old,))
        for job in kept:
            conn.execute("UPDATE jobs SET url=? WHERE id=? AND url!=?", (job["url"], job["id"], job["url"]))
        conn.executemany("DELETE FROM applications WHERE id=?", [(record_id,) for record_id in stale])
        for record_id, review in reviews.items():
            if review and record_id not in stale:
                merged = unique_review(review)
                conn.execute("UPDATE applications SET review=?, filled=? WHERE id=?", (json.dumps(merged), fields_filled(merged), record_id))


def campaign_options(p=None):
    return [x.strip() for x in re.split(r"[,;\n]", (p or profile()).get("role_campaigns", "")) if x.strip()]


def scored_jobs():
    with db() as conn:
        jobs = [dict(r) for r in conn.execute("SELECT jobs.*, (SELECT MAX(attached) FROM applications WHERE job_id=jobs.id) AS sent FROM jobs ORDER BY id DESC")]
    for item in jobs:
        item["match"] = match_role(item["description"], item["title"], item.get("wave", ""), item.get("sector", ""), item.get("funding_stage", ""))
        item["score"] = item["match"]["score"]
    jobs.sort(key=lambda item: (item["score"], item["saved"]), reverse=True)
    return jobs


@app.context_processor
def navigation_counts():
    with db() as conn:
        roles = conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
        has_resume = conn.execute("SELECT COUNT(*) FROM resume").fetchone()[0] > 0
    return {"nav": {"roles": roles, "resume": has_resume}}


def save_resume_upload():
    """Store an uploaded resume version; every outcome returns to the resume page."""
    file = request.files.get("resume")
    if not file or not file.filename:
        flash("Choose a resume file to import.", "error")
        return redirect(url_for("resume_page"))
    filename = secure_filename(file.filename)
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in ALLOWED:
        flash("Upload a PDF, DOCX, TXT, or LaTeX resume.", "error")
        return redirect(url_for("resume_page"))
    path = INSTANCE / ("resume_upload." + ext)
    file.save(path)
    try:
        text = extract_text(path, ext).strip()
    except Exception:
        flash("That file could not be read. Try a valid text-based PDF, DOCX, TXT, or LaTeX file.", "error")
        return redirect(url_for("resume_page"))
    if not text:
        flash("I could not read text from this file. Try a text-based PDF or DOCX.", "error")
        return redirect(url_for("resume_page"))
    with db() as conn:
        conn.execute("INSERT INTO resume(filename,text,uploaded) VALUES(?,?,?)", (filename, text, datetime.now().isoformat(timespec="minutes")))
    log_activity("Resume imported", f"Imported {filename}")
    flash("Resume imported. It stays on this Mac.", "success")
    return redirect(url_for("resume_page"))


@app.route("/", methods=["GET", "POST"])
def home():
    if request.method == "POST":
        if "resume" in request.files:
            return save_resume_upload()
        company, title = request.form.get("company", "").strip(), request.form.get("title", "").strip()
        description = request.form.get("description", "").strip()
        if description:
            wave = request.form.get("wave", "").strip()[:80]
            sector = request.form.get("sector", "").strip()[:80]
            funding_stage = request.form.get("funding_stage", "").strip()[:80]
            url = safe_http_url(request.form.get("url", ""))
            values = (company, title, url, description, datetime.now().isoformat(timespec="minutes"), wave, sector, funding_stage)
            with db() as conn:
                # A posting saved before is updated, not added again.
                same = find_role(conn, {"url": url, "title": title, "description": description})
                if same:
                    job_id = same["id"]
                    conn.execute("UPDATE jobs SET company=?,title=?,url=?,description=?,saved=?,wave=?,sector=?,funding_stage=? WHERE id=?",
                                 (company, title, applying.better_url(same["url"], url), *values[3:], job_id))
                else:
                    job_id = conn.execute("INSERT INTO jobs(company,title,url,description,saved,wave,sector,funding_stage) VALUES(?,?,?,?,?,?,?,?)", values).lastrowid
            log_activity("Role saved", f"Added {title or 'role'} at {company or 'company not set'}")
            return redirect(url_for("job", job_id=job_id))
    p = profile()
    jobs = scored_jobs()
    with db() as conn:
        activity = [dict(r) for r in conn.execute("SELECT * FROM activity ORDER BY id DESC LIMIT 8")]
    resume = resume_row()
    stats = {"count": len(jobs), "strong": sum(1 for j in jobs if j["score"] >= 60),
             "average": round(sum(j["score"] for j in jobs) / len(jobs)) if jobs else 0}
    setup = [("Add your resume", bool(resume), "/resume"),
             ("Fill in your details", bool(p.get("name") and p.get("email")), "/profile"),
             ("Open a job listing in Chrome", bool(jobs), "")]
    constellation = [{"id": j["id"], "title": j["title"] or "Untitled role", "company": j["company"] or "", "score": j["score"]} for j in jobs[:24]]
    return render_template("index.html", page="today", title="Today", profile=p, resume=resume, jobs=jobs, activity=activity,
                           stats=stats, setup=setup, constellation=constellation, campaign_options=campaign_options(p),
                           first_name=(p.get("name", "").split() or [""])[0])


@app.route("/resume", methods=["GET", "POST"])
def resume_page():
    if request.method == "POST":
        return save_resume_upload()
    resume = resume_row()
    with db() as conn:
        versions = [dict(r) for r in conn.execute("SELECT id,filename,uploaded,length(text) AS size FROM resume ORDER BY id DESC LIMIT 6")]
    outline = None
    if resume:
        preamble, sections = resume_outline(resume["text"])
        outline = {"preamble": preamble, "sections": sections,
                   "words": len(re.findall(r"\w+", outline_text(preamble, sections))),
                   "bullets": sum(len(e["bullets"]) for s in sections for e in s["entries"])}
    p = profile()
    watch_path = p.get("watch_path", "").strip()
    watch_missing = bool(watch_path) and not Path(watch_path).expanduser().is_file()
    return render_template("resume.html", page="resume", title="Resume", resume=resume, outline=outline, versions=versions,
                           profile=p, watch_missing=watch_missing)


@app.route("/profile", methods=["GET", "POST"])
def profile_page():
    if request.method == "GET":
        with db() as conn:
            learned = [dict(r) for r in conn.execute("SELECT id, label, answer, updated FROM answers ORDER BY updated DESC")]
        return render_template("profile.html", page="profile", title="Profile", profile=profile(), learned=learned,
                               standard=applying.STANDARD_QUESTIONS, disclosures=applying.DISCLOSURE_QUESTIONS,
                               groups=[("Contact", "Used to fill application forms.", CONTACT_FIELDS),
                                       ("Education", "Checked against graduation windows.", EDUCATION_FIELDS),
                                       ("Links", "Filled into LinkedIn, GitHub, and portfolio fields.", LINK_FIELDS)],
                               autofill_fields=CONTACT_FIELDS + EDUCATION_FIELDS + LINK_FIELDS)
    old_profile = profile()
    with db() as conn:
        for field in PROFILE_FIELDS:
            if field in request.form:
                value = request.form.get(field, "").strip()[:2000]
                conn.execute("INSERT INTO profile(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (field, value))
        if "watch_path" in request.form:
            watch_path = request.form.get("watch_path", "").strip()
            conn.execute("INSERT INTO profile(key,value) VALUES('watch_path',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (watch_path,))
            if watch_path != old_profile.get("watch_path", ""):
                conn.execute("INSERT INTO profile(key,value) VALUES('watch_hash','') ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    log_activity("Profile updated", "Updated application details or resume watch settings")
    flash("Saved on this Mac.", "success")
    return redirect(url_for("resume_page") if request.form.get("next") == "resume" else url_for("profile_page"))


@app.route("/memory/add", methods=["POST"])
def add_memory():
    task = request.form.get("task", "").strip()
    if task:
        log_activity("Task noted", task)
        flash("Note saved.", "success")
    return redirect(url_for("home"))


@app.route("/job/<int:job_id>")
def job(job_id):
    with db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if not row:
        return "Job not found", 404
    item = dict(row)
    report = analyze(item["description"])
    match = match_role(item["description"], item.get("title", ""), item.get("wave", ""), item.get("sector", ""), item.get("funding_stage", ""))
    resume = resume_row()
    tuned = tune_resume(resume["text"], item["description"], item.get("title", "")) if resume else None
    voice = "Direct" if report["score"] < 35 else "Confident" if report["score"] < 70 else "Assertive"
    voice_note = {"Direct": "The current resume has limited direct keyword evidence for this posting. Keep wording plain and claims tightly scoped.",
                  "Confident": "Lead with the strongest relevant work already on the resume; use clear action and outcome language where the source supports it.",
                  "Assertive": "Several posting terms already appear in the resume. Put those proven skills and outcomes first, without inflating scope or metrics."}[voice]
    p = profile()
    with db() as conn:
        sent = [dict(r) for r in conn.execute("SELECT id, created, url, attached, filled, extension, pages, review, pdf IS NOT NULL AS has_pdf FROM applications WHERE job_id=? ORDER BY id DESC", (job_id,))]
    for application in sent:
        application["host"] = urlparse(application["url"]).netloc
        application["review"] = json.loads(application["review"] or "[]")
        application["checks"] = sum(1 for item in application["review"] if item.get("flag"))
    odds = role_odds(item, match, p, resume_plain(resume["text"]) if resume else "")
    return render_template("job.html", page="job", title=item["title"] or "Role", job=item, report=report, match=match, resume=resume, odds=odds,
                           tuned=tuned, profile=p, voice=voice, voice_note=voice_note, campaign_options=campaign_options(p),
                           applications=sent, pdf_name=resume_pdf_name())


@app.route("/job/<int:job_id>/delete", methods=["POST"])
def delete_job(job_id):
    with db() as conn:
        conn.execute("DELETE FROM jobs WHERE id=?", (job_id,))
        conn.execute("DELETE FROM applications WHERE job_id=?", (job_id,))
    log_activity("Role removed", "Removed a saved role")
    return redirect(url_for("home"))


@app.route("/job/<int:job_id>/campaign", methods=["POST"])
def update_job_campaign(job_id):
    wave = request.form.get("wave", "").strip()[:80]
    sector = request.form.get("sector", "").strip()[:80]
    funding_stage = request.form.get("funding_stage", "").strip()[:80]
    with db() as conn:
        updated = conn.execute("UPDATE jobs SET wave=?,sector=?,funding_stage=? WHERE id=?", (wave, sector, funding_stage, job_id)).rowcount
        for field in ("company", "title"):
            if request.form.get(field, "").strip():
                conn.execute(f"UPDATE jobs SET {field}=? WHERE id=?", (request.form[field].strip()[:200], job_id))
    if not updated:
        return "Job not found", 404
    log_activity("Role campaign updated", "Updated a role's campaign, sector, or funding notes")
    flash("Role tags saved.", "success")
    return redirect(url_for("job", job_id=job_id))


@app.get("/api/health")
def api_health():
    current = resume_row()
    # "protected" tells the Mac app this service is its own, not an older copy.
    return {"ok": True, "protected": bool(APP_TOKEN), "resume_loaded": bool(current), "resume_filename": current["filename"] if current else None}


@app.get("/api/profile")
def api_profile():
    # This endpoint is reachable only through the loopback app.
    p = profile()
    return {key: p.get(key, "") for key in AUTOFILL_FIELDS}


@app.post("/api/evaluate")
def api_evaluate():
    data = request.get_json(silent=True) or {}
    description = str(data.get("description", ""))[:50000].strip()
    if len(description) < 80:
        return {"error": "The job description is too short to evaluate. Select or paste more of the posting."}, 400
    report = analyze(description)
    resume = resume_row()
    relevant = []
    if resume:
        for line in resume_plain(resume["text"]).splitlines():
            clean = line.strip(" •*-\t")
            if clean and any(term in clean.lower() for term in report["matched"]):
                relevant.append(clean)
    voice = "Direct" if report["score"] < 35 else "Confident" if report["score"] < 70 else "Assertive"
    url = safe_http_url(data.get("url", ""))
    # The page's title, company, and structured job data, read together.
    title, company = applying.identify_role({**data, "url": url}, description)
    wave = str(data.get("wave", ""))[:80].strip()
    sector = str(data.get("sector", ""))[:80].strip()
    funding_stage = str(data.get("funding_stage", ""))[:80].strip()
    saved = datetime.now().isoformat(timespec="minutes")
    with db() as conn:
        # The same posting under another URL (Workday writes one several ways) is the same role.
        existing = find_role(conn, {"url": url, "title": title, "description": description})
        if existing:
            saved_job_id = existing["id"]
            conn.execute("UPDATE jobs SET company=?,title=?,url=?,description=?,saved=?,wave=?,sector=?,funding_stage=? WHERE id=?",
                         (company, title, applying.better_url(existing["url"], url), description, saved, wave, sector, funding_stage, saved_job_id))
        else:
            cursor = conn.execute("INSERT INTO jobs(company,title,url,description,saved,wave,sector,funding_stage) VALUES(?,?,?,?,?,?,?,?)", (company, title, url, description, saved, wave, sector, funding_stage))
            saved_job_id = cursor.lastrowid
    match = match_role(description, title, wave, sector, funding_stage)
    log_activity("Role scanned", f"Reviewed {title or 'role'} at {company or 'company not set'}")
    return {
        "title": title, "company": company, "url": url, "saved_job_id": saved_job_id,
        "score": report["score"], "voice": voice,
        "fit_score": match["score"], "fit_status": match["status"], "eligibility": match["eligibility"],
        "fit_breakdown": match["breakdown"], "fit_reasons": match["reasons"], "matched_skills": match["matched_skills"],
        "matched": report["matched"], "missing": report["missing"], "evidence": relevant[:12],
        "resume_loaded": bool(resume),
        "note": "Keyword overlap is a rough triage signal, not a hiring probability. Verify each claim against your experience.",
    }


@app.get("/api/jobs")
def api_rank_jobs():
    try:
        limit = max(1, min(int(request.args.get("limit", "10")), 50))
    except ValueError:
        limit = 10
    with db() as conn:
        items = [dict(row) for row in conn.execute("SELECT * FROM jobs")]
    for item in items:
        match = match_role(item["description"], item.get("title", ""), item.get("wave", ""), item.get("sector", ""), item.get("funding_stage", ""))
        item["score"] = match["score"]
        item["fit_status"] = match["status"]
        item["eligibility"] = match["eligibility"]
    items.sort(key=lambda item: (item["score"], item["saved"]), reverse=True)
    return {"jobs": [{key: item.get(key, "") for key in ("id", "company", "title", "url", "saved", "score", "fit_status", "eligibility")} for item in items[:limit]], "count": len(items)}


def printable(preamble, sections) -> dict:
    """An outline with plain-string bullets for resume_print.html."""
    return {"preamble": preamble, "sections": [{**section, "entries": [{"header": entry["header"], "bullets": [
        bullet["text"] if isinstance(bullet, dict) else bullet for bullet in entry["bullets"]]} for entry in section["entries"]]}
        for section in sections]}


def resume_pdf_name() -> str:
    name = profile().get("name", "").strip()
    return f"{secure_filename(name).replace('_', ' ')} Resume.pdf" if secure_filename(name) else "Resume.pdf"


def render_resume(text: str, title: str):
    preamble, sections = resume_outline(text)
    return render_template("resume_print.html", title=title, outline=printable(preamble, sections), raw=resume_plain(text),
                           preview=request.args.get("preview") == "1")


@app.route("/resume/print")
def resume_print():
    resume = resume_row()
    if not resume:
        return "No resume yet", 404
    return render_resume(resume["text"], resume_pdf_name()[:-4])


@app.route("/job/<int:job_id>/resume/print")
def tuned_resume_print(job_id):
    with db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    resume = resume_row()
    if not row or not resume:
        return "Job or resume not found", 404
    tuned = tune_resume(resume["text"], row["description"], row["title"] or "")
    return render_resume(tuned["text"], resume_pdf_name()[:-4])


@app.route("/job/<int:job_id>/applications/<int:application_id>/print")
def application_print(job_id, application_id):
    with db() as conn:
        row = conn.execute("SELECT source FROM applications WHERE id=? AND job_id=?", (application_id, job_id)).fetchone()
    if not row:
        return "Not found", 404
    return render_resume(row["source"], resume_pdf_name()[:-4])


@app.post("/api/applications")
def api_save_application():
    """Keep the role-tuned resume the Mac app attached to (or saved for) an application."""
    data = request.get_json(silent=True) or {}
    try:
        job_id = int(data.get("job_id") or 0)
        pdf = base64.b64decode(data.get("pdf") or "", validate=True) or None
    except (TypeError, ValueError):
        return {"error": "Send a job_id and a base64 PDF."}, 400
    if pdf is not None and not pdf.startswith(b"%PDF"):
        return {"error": "The attachment is not a PDF."}, 400
    with db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    resume = resume_row()
    if not row or not resume:
        return {"error": "Job or resume not found."}, 404
    tuned = tune_resume(resume["text"], row["description"], row["title"] or "")
    attached = bool(data.get("attached"))
    run = str(data.get("run") or "")[:40]
    review = unique_review([{key: str(item.get(key) or "")[:300] for key in ("page", "question", "value", "flag")}
                            for item in (data.get("review") if isinstance(data.get("review"), list) else [])[:200] if isinstance(item, dict)])
    filled = fields_filled(review) if review else ", ".join(str(field) for field in (data.get("fields") or [])[:30])
    try:
        pages = max(1, min(int(data.get("pages") or 1), 9))
    except (TypeError, ValueError):
        pages = 1
    with db() as conn:
        # Later pages of the same application update its record.
        existing = conn.execute("SELECT id, attached FROM applications WHERE job_id=? AND run=?", (job_id, run)).fetchone() if run else None
        if existing:
            conn.execute("UPDATE applications SET attached=?, filled=?, review=?, url=? WHERE id=?",
                         (int(attached or existing["attached"]), filled, json.dumps(review), safe_http_url(data.get("url", "")), existing["id"]))
            return {"id": existing["id"], "filename": resume_pdf_name(), "company": row["company"] or "", "title": row["title"] or ""}
        # Redoing an application (or saving the PDF again) replaces the role's
        # earlier record of the same kind instead of adding another.
        kind = FILL_RECORD if run or attached or filled else f"NOT {FILL_RECORD}"
        earlier = conn.execute(f"SELECT id, review FROM applications WHERE job_id=? AND {kind} ORDER BY id DESC", (job_id,)).fetchone()
        if earlier:
            if review:
                review = unique_review(json.loads(earlier["review"] or "[]") + review)
                filled = fields_filled(review)
            conn.execute("UPDATE applications SET created=?, url=?, attached=?, filled=?, source=?, extension=?, pdf=?, pages=?, changes=?, run=?, review=? WHERE id=?",
                         (datetime.now().isoformat(timespec="minutes"), safe_http_url(data.get("url", "")), int(attached), filled,
                          tuned["text"], tuned["extension"], pdf, pages, json.dumps(tuned["changes"]), run, json.dumps(review), earlier["id"]))
            return {"id": earlier["id"], "filename": resume_pdf_name(), "company": row["company"] or "", "title": row["title"] or ""}
        cursor = conn.execute("INSERT INTO applications(job_id,created,url,attached,filled,source,extension,pdf,pages,changes,run,review) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                              (job_id, datetime.now().isoformat(timespec="minutes"), safe_http_url(data.get("url", "")), int(attached), filled,
                               tuned["text"], tuned["extension"], pdf, pages, json.dumps(tuned["changes"]), run, json.dumps(review)))
        application_id = cursor.lastrowid
    log_activity("Resume attached" if attached else "Resume saved",
                 f"{'Attached' if attached else 'Saved'} a resume tuned for {row['title'] or 'a role'} at {row['company'] or 'company not set'}")
    return {"id": application_id, "filename": resume_pdf_name(), "company": row["company"] or "", "title": row["title"] or ""}


@app.route("/job/<int:job_id>/applications/<int:application_id>.<ext>")
def download_application(job_id, application_id, ext):
    with db() as conn:
        row = conn.execute("SELECT * FROM applications WHERE id=? AND job_id=?", (application_id, job_id)).fetchone()
    if not row or ext not in {"pdf", "tex", "txt"} or (ext == "pdf" and not row["pdf"]) or (ext == "tex" and row["extension"] != "tex"):
        return "Not found", 404
    stem = resume_pdf_name()[:-4]
    if ext == "pdf":
        return Response(row["pdf"], mimetype="application/pdf", headers={"Content-Disposition": f'attachment; filename="{stem}.pdf"'})
    body = row["source"] if ext == "tex" else resume_plain(row["source"])
    return Response(body, mimetype="application/x-tex" if ext == "tex" else "text/plain",
                    headers={"Content-Disposition": f'attachment; filename="{secure_filename(stem)}.{ext}"'})


@app.get("/api/role-for-url")
def api_role_for_url():
    """The saved role an application page belongs to: a role the user just
    looked at (`hints`, best first) when the page can belong to it, otherwise
    the role whose URL matches."""
    url = safe_http_url(request.args.get("url", ""))
    if not url:
        return {"job_id": None}
    hints = [int(part) for part in request.args.get("hints", "").split(",") if part.strip().isdigit()]
    with db() as conn:
        for hint in hints:
            row = conn.execute("SELECT id, url, title, company FROM jobs WHERE id=?", (hint,)).fetchone()
            if row and applying.page_belongs(dict(row), url):
                return {"job_id": row["id"], "title": row["title"]}
    target = urlparse(url)
    target_tokens = set(re.findall(r"[A-Za-z0-9_-]{5,}", target.path + " " + target.query))
    best = (0, "", None)
    with db() as conn:
        rows = conn.execute("SELECT id, url, title, saved FROM jobs WHERE url != ''").fetchall()
    for row in rows:
        listing = urlparse(row["url"])
        if listing.netloc.lower() != target.netloc.lower():
            continue
        path = listing.path.rstrip("/")
        if url == row["url"] or applying.posting_key(url) == applying.posting_key(row["url"]) or (len(path) > 1 and target.path.startswith(path)):
            score = 3
        elif {t for t in re.findall(r"[A-Za-z0-9_-]{5,}", listing.path + " " + listing.query) if any(c.isdigit() for c in t)} & target_tokens:
            score = 2
        else:
            continue
        if (score, row["saved"]) > best[:2]:
            best = (score, row["saved"], row)
    row = best[2]
    return {"job_id": row["id"], "title": row["title"]} if row else {"job_id": None}


def tailored_skills(sections, posting: str, declared: list[str], limit: int = 10) -> list[str]:
    """Skills for an application's skills field: the resume's and profile's,
    the ones the posting asks for first."""
    names = []
    for section in sections:
        if section["kind"] != "skills":
            continue
        for entry in section["entries"]:
            for line in entry["header"] + [b["text"] if isinstance(b, dict) else b for b in entry["bullets"]]:
                items = line.partition(":")[2] if ":" in line else line
                names += [re.sub(r"\s*\(.*?\)", "", item).strip() for item in items.split(",")]
    seen, unique = set(), []
    for name in names + declared:
        if name and len(name) <= 40 and name.lower() not in seen:
            seen.add(name.lower())
            unique.append(name)
    if posting:
        unique.sort(key=lambda name: tailoring.skill_relevance(name, posting))
    return unique[:limit]


@app.get("/api/fill-plan")
def api_fill_plan():
    """Everything the Mac app's form filler needs for one application."""
    p = profile()
    resume = resume_row()
    row = None
    try:
        job_id = int(request.args.get("job_id") or 0)
    except ValueError:
        job_id = 0
    if job_id:
        with db() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    posting = f"{row['title']}\n{row['description']}" if row else ""
    sections = []
    if resume:
        text = tune_resume(resume["text"], row["description"], row["title"] or "")["text"] if row else resume["text"]
        sections = resume_outline(text)[1]
    declared = [x.strip() for x in re.split(r"[,;\n]", p.get("skills", "")) if x.strip()]
    start, start_source = applying.program_start(row["description"] if row else "")
    with db() as conn:
        learned = [{"question": r["question"], "answer": r["answer"]} for r in conn.execute("SELECT question, answer FROM answers")]
    contact = {key: p.get(key, "") for key in AUTOFILL_FIELDS}
    contact["state_options"] = applying.state_options(p.get("state", ""))
    contact["graduation_dates"] = applying.date_formats(applying.parse_month_year(p.get("graduation", "")))
    education = applying.education_entries(sections, p)
    experience = applying.experience_entries(sections)
    role = {"id": row["id"], "title": row["title"], "company": row["company"]} if row else None
    # Answers the resume already gives: enrollment status from the degree, and
    # the current job ("Procedura", employed: Yes). Profile answers win.
    derived = {"degree": education[0]["degree"]} if education and not p.get("enrollment_status") else {}
    current = next((entry for entry in experience if entry.get("current")), None)
    if current:
        derived.update({"currently_employed": "Yes", "current_employer": current["company"], "current_title": current["title"]})
        if role and role["company"] and re.sub(r"\W", "", current["company"].lower()) in re.sub(r"\W", "", role["company"].lower()):
            derived["previously_employed"] = "Yes"  # applying where they already work
    hints = {**p, **{key: value for key, value in derived.items() if not p.get(key) or key == "previously_employed" or key == "degree"}}
    today = date.today()
    # All of them, best first: the form adds them in order up to any limit it states.
    skills = tailored_skills(sections, posting, declared, limit=20)
    # The listing answers some questions itself, and gives "open to all" its places.
    facts = applying.listing_facts(row["title"], row["description"], row["url"]) if row else {"locations": []}
    answers = applying.standard_answers(hints) + (applying.listing_answers(facts) if row else [])
    for answer in answers:
        if answer["key"] == "location_preference" and answer["answer"]:
            answer["open"] = answer["options"][0] == "No preference"
            if answer["open"]:  # with no "no preference" option, the listing's own places
                answer["options"] = answer["options"] + facts["locations"] + applying.state_options(p.get("state", ""))[:1]
    return {"profile": contact, "answers": answers, "learned": learned,
            "disclosures": applying.disclosure_answers(p), "today": applying.date_formats((today.year, today.month, today.day)),
            "experience": experience, "education": education, "skills": skills, "start": {**start, "source": start_source},
            "drafts": applying.drafts(p, education, experience, skills, role, posting),
            "never": applying.NEVER, "role": role}


@app.post("/api/answers")
def api_learn_answers():
    """Remember short answers the user typed on an application form."""
    items = (request.get_json(silent=True) or {}).get("answers") or []
    p = profile()
    saved = 0
    with db() as conn:
        for item in items[:60]:
            question, answer = str(item.get("question", ""))[:300], str(item.get("answer", "")).strip()[:160]
            if not applying.learnable(question, answer):
                continue
            key = applying.standard_key(question)
            if key:
                # A standard question fills in its Profile answer once, if blank.
                if not p.get(key):
                    conn.execute("UPDATE profile SET value=? WHERE key=?", (answer, key))
                    p[key] = answer
                    saved += 1
                continue
            if any(answer.strip().lower() == str(v).strip().lower() for v in p.values() if v):
                continue  # already known from the profile
            conn.execute("INSERT INTO answers(question,label,answer,updated) VALUES(?,?,?,?) ON CONFLICT(question) DO UPDATE SET answer=excluded.answer, label=excluded.label, updated=excluded.updated",
                         (applying.normalize_question(question), question.strip()[:300], answer, datetime.now().isoformat(timespec="minutes")))
            saved += 1
    if saved:
        log_activity("Answers learned", f"Remembered {saved} answer{'s' if saved != 1 else ''} from an application form")
    return {"saved": saved}


@app.route("/answers/<int:answer_id>/delete", methods=["POST"])
def delete_answer(answer_id):
    with db() as conn:
        conn.execute("DELETE FROM answers WHERE id=?", (answer_id,))
    flash("Answer forgotten.", "success")
    return redirect(url_for("profile_page") + "#answers")


@app.route("/job/<int:job_id>/tuned")
def download_tuned_resume(job_id):
    with db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    resume = resume_row()
    if not row or not resume:
        return "Job or resume not found", 404
    tuned = tune_resume(resume["text"], row["description"], row["title"] or "")
    name = f"{secure_filename(row['company'] or 'role')}-{secure_filename(row['title'] or 'role')}-resume.{tuned['extension']}"
    log_activity("Resume tuned", f"Exported a tuned resume for {row['title'] or 'a role'}")
    return Response(tuned["text"], mimetype="application/x-tex" if tuned["extension"] == "tex" else "text/plain",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.route("/job/<int:job_id>/resume.txt")
def download_resume(job_id):
    with db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    resume = resume_row()
    if not row or not resume:
        return "Job or resume not found", 404
    report = analyze(row["description"])
    lines = ["ROLE REVIEW NOTES — NOT A REWRITTEN RESUME", f"Role: {row['title']} at {row['company']}", f"Text overlap: {report['score']}% (rough heuristic, not a hiring probability)", "", "Existing resume text (unchanged):", resume["text"].strip(), "", "Relevant existing resume lines:"]
    lines += ["• " + line for line in [l.strip(" •*-\t") for l in resume["text"].splitlines() if l.strip() and any(t in l.lower() for t in report["matched"])][:12]]
    lines += ["", "Potential keywords to add only if supported by your actual experience:", ", ".join(report["missing"][:12])]
    path = INSTANCE / "tailored_draft.txt"
    path.write_text("\n".join(lines))
    return send_file(path, as_attachment=True, download_name=f"{secure_filename(row['company'] or 'role')}-{secure_filename(row['title'] or 'role')}-review-notes.txt")


init_db()
refresh_pdf_resume()

if __name__ == "__main__":
    pid_file = INSTANCE / "app.pid"
    pid_file.write_text(str(os.getpid()))
    atexit.register(lambda: pid_file.unlink(missing_ok=True) if pid_file.exists() and pid_file.read_text().strip() == str(os.getpid()) else None)
    threading.Thread(target=watch_resume_loop, daemon=True, name="resume-file-watch").start()
    app.run(host="127.0.0.1", port=int(os.environ.get("APPLY_DESK_PORT", "8787")), debug=False)
