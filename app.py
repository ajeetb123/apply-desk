from __future__ import annotations

import atexit
import hashlib
import os
import re
import ipaddress
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, flash, redirect, render_template, request, send_file, url_for
from werkzeug.utils import secure_filename

ROOT = Path(__file__).resolve().parent
INSTANCE = ROOT / "instance"
INSTANCE.mkdir(exist_ok=True)
DB = INSTANCE / "resume_tailor.sqlite3"
ALLOWED = {"pdf", "docx", "txt", "tex"}
app = Flask(__name__)
app.secret_key = "local-resume-tailor-session"
app.config["MAX_CONTENT_LENGTH"] = 12 * 1024 * 1024


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


def db():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS profile (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS resume (id INTEGER PRIMARY KEY, filename TEXT, text TEXT NOT NULL, uploaded TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, company TEXT, title TEXT, url TEXT, description TEXT, saved TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, summary TEXT NOT NULL, created TEXT NOT NULL);
        """)
        # Personal contact details live only in the ignored local database. Do
        # not put an individual's address, phone, or email into tracked code.
        defaults = {
            "name": "", "email": "", "school": "", "degree": "",
            "graduation": "", "phone": "", "city": "", "state": "",
            "postal_code": "", "address": "", "work_authorization": "",
            "watch_path": "", "watch_hash": "",
            "target_roles": "Software Engineering Intern, Backend Engineer Intern",
            "larp": "2",
        }
        for key, value in defaults.items():
            conn.execute("INSERT OR IGNORE INTO profile(key,value) VALUES(?,?)", (key, value))
        # Split legacy "City, ST" profile entries so the extension doesn't
        # put the whole string in a city-only field.
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


def extract_text(path: Path, ext: str) -> str:
    if ext == "pdf":
        from pypdf import PdfReader
        return "\n".join(page.extract_text() or "" for page in PdfReader(str(path)).pages)
    if ext == "docx":
        from docx import Document
        doc = Document(path)
        return "\n".join(p.text for p in doc.paragraphs)
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


def analyze(description: str):
    resume = resume_row()
    if not resume:
        return {"score": 0, "matched": [], "missing": [], "terms": []}
    terms = keywords(description)
    rtext = resume["text"].lower()
    matched = [term for term in terms if term in rtext]
    missing = [term for term in terms if term not in rtext]
    score = round(100 * len(matched) / max(1, len(terms)))
    return {"score": score, "matched": matched[:12], "missing": missing[:12], "terms": terms}


def safe_http_url(value: str) -> str:
    value = str(value or "").strip()[:2000]
    try:
        parsed = urlparse(value)
        if parsed.scheme in {"http", "https"} and parsed.hostname:
            return value
    except ValueError:
        pass
    return ""


@app.route("/", methods=["GET", "POST"])
def home():
    if request.method == "POST":
        file = request.files.get("resume")
        if file and file.filename:
            filename = secure_filename(file.filename)
            ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
            if ext not in ALLOWED:
                flash("Upload a PDF, DOCX, TXT, or LaTeX resume.", "error")
            else:
                path = INSTANCE / ("resume_upload." + ext)
                file.save(path)
                try:
                    text = extract_text(path, ext).strip()
                except Exception:
                    flash("That file could not be read. Try a valid text-based PDF, DOCX, TXT, or LaTeX file.", "error")
                    return redirect(url_for("home"))
                if not text:
                    flash("I could not read text from this file. Try a text-based PDF or DOCX.", "error")
                else:
                    with db() as conn:
                        conn.execute("INSERT INTO resume(filename,text,uploaded) VALUES(?,?,?)", (filename, text, datetime.now().isoformat(timespec="minutes")))
                    log_activity("Resume imported", f"Imported {filename}")
                    flash("Resume imported. It is stored locally on this computer.", "success")
                    return redirect(url_for("home"))
        company, title = request.form.get("company", "").strip(), request.form.get("title", "").strip()
        description = request.form.get("description", "").strip()
        if description:
            with db() as conn:
                cursor = conn.execute("INSERT INTO jobs(company,title,url,description,saved) VALUES(?,?,?,?,?)", (company, title, safe_http_url(request.form.get("url", "")), description, datetime.now().isoformat(timespec="minutes")))
                job_id = cursor.lastrowid
            log_activity("Role saved", f"Added {title or 'role'} at {company or 'company not set'}")
            return redirect(url_for("job", job_id=job_id))
    current = resume_row()
    with db() as conn:
        jobs = [dict(r) for r in conn.execute("SELECT * FROM jobs ORDER BY id DESC")]
        activity = [dict(r) for r in conn.execute("SELECT * FROM activity ORDER BY id DESC LIMIT 8")]
    for item in jobs:
        item["score"] = analyze(item["description"])["score"]
    jobs.sort(key=lambda item: (item["score"], item["saved"]), reverse=True)
    return render_template("index.html", profile=profile(), resume=current, jobs=jobs, activity=activity)


@app.route("/profile", methods=["POST"])
def save_profile():
    fields = ["name", "email", "school", "degree", "graduation", "phone", "city", "state", "postal_code", "address", "work_authorization", "target_roles", "larp"]
    old_profile = profile()
    watch_path = request.form.get("watch_path", "").strip()
    with db() as conn:
        for field in fields:
            value = request.form.get(field, "").strip()
            if value:
                conn.execute("INSERT INTO profile(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (field, value))
        conn.execute("INSERT INTO profile(key,value) VALUES('watch_path',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (watch_path,))
        if watch_path != old_profile.get("watch_path", ""):
            conn.execute("INSERT INTO profile(key,value) VALUES('watch_hash','') ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    log_activity("Profile updated", "Updated application details or resume watch settings")
    flash("Profile saved locally.", "success")
    return redirect(url_for("home"))


@app.route("/memory/add", methods=["POST"])
def add_memory():
    task = request.form.get("task", "").strip()
    if task:
        log_activity("Task noted", task)
        flash("Added to local memory.", "success")
    return redirect(url_for("home"))


@app.route("/job/<int:job_id>")
def job(job_id):
    with db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if not row:
        return "Job not found", 404
    item = dict(row)
    report = analyze(item["description"])
    resume = resume_row()
    relevant = []
    if resume:
        for line in resume["text"].splitlines():
            clean = line.strip(" •*-\t")
            if clean and any(term in clean.lower() for term in report["matched"]):
                relevant.append(clean)
    voice = "Direct" if report["score"] < 35 else "Confident" if report["score"] < 70 else "Assertive"
    voice_note = {"Direct": "The current resume has limited direct keyword evidence for this posting. Keep wording plain and claims tightly scoped.",
                  "Confident": "Lead with the strongest relevant work already on the resume; use clear action and outcome language where the source supports it.",
                  "Assertive": "Several posting terms already appear in the resume. Put those proven skills and outcomes first, without inflating scope or metrics."}[voice]
    return render_template("job.html", job=item, report=report, resume=resume, profile=profile(), relevant=relevant[:12], voice=voice, voice_note=voice_note)


@app.route("/job/<int:job_id>/delete", methods=["POST"])
def delete_job(job_id):
    with db() as conn:
        conn.execute("DELETE FROM jobs WHERE id=?", (job_id,))
    log_activity("Role removed", "Removed a saved role")
    return redirect(url_for("home"))


@app.get("/api/health")
def api_health():
    current = resume_row()
    return {"ok": True, "resume_loaded": bool(current), "resume_filename": current["filename"] if current else None}


@app.get("/api/profile")
def api_profile():
    # This endpoint is reachable only through the loopback app and is called by
    # the user's explicitly installed extension when they request field fill.
    p = profile()
    return {key: p.get(key, "") for key in (
        "name", "email", "phone", "city", "state", "postal_code", "address",
        "school", "degree", "graduation", "work_authorization"
    )}


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
        for line in resume["text"].splitlines():
            clean = line.strip(" •*-\t")
            if clean and any(term in clean.lower() for term in report["matched"]):
                relevant.append(clean)
    voice = "Direct" if report["score"] < 35 else "Confident" if report["score"] < 70 else "Assertive"
    title = str(data.get("title", ""))[:200]
    company = str(data.get("company", ""))[:200]
    url = safe_http_url(data.get("url", ""))
    saved = datetime.now().isoformat(timespec="minutes")
    with db() as conn:
        existing = conn.execute("SELECT id FROM jobs WHERE url=? AND url!=''", (url,)).fetchone() if url else None
        if existing:
            saved_job_id = existing["id"]
            conn.execute("UPDATE jobs SET company=?,title=?,description=?,saved=? WHERE id=?", (company, title, description, saved, saved_job_id))
        else:
            cursor = conn.execute("INSERT INTO jobs(company,title,url,description,saved) VALUES(?,?,?,?,?)", (company, title, url, description, saved))
            saved_job_id = cursor.lastrowid
    log_activity("Role scanned", f"Reviewed {title or 'role'} at {company or 'company not set'}")
    return {
        "title": title, "company": company, "url": url, "saved_job_id": saved_job_id,
        "score": report["score"], "voice": voice,
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
        items = [dict(row) for row in conn.execute("SELECT id,company,title,url,description,saved FROM jobs")]
    for item in items:
        item["score"] = analyze(item["description"])["score"]
    items.sort(key=lambda item: (item["score"], item["saved"]), reverse=True)
    return {"jobs": [{key: item[key] for key in ("id", "company", "title", "url", "saved", "score")} for item in items[:limit]], "count": len(items)}


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

if __name__ == "__main__":
    pid_file = INSTANCE / "app.pid"
    pid_file.write_text(str(os.getpid()))
    atexit.register(lambda: pid_file.unlink(missing_ok=True) if pid_file.exists() and pid_file.read_text().strip() == str(os.getpid()) else None)
    threading.Thread(target=watch_resume_loop, daemon=True, name="resume-file-watch").start()
    app.run(host="127.0.0.1", port=8787, debug=False)
