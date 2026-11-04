import base64
import io
import re
import tempfile
import unittest
from pathlib import Path

import app as application


class ApplyDeskApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        # Keep uploads and the database out of the real data folder.
        application.INSTANCE = Path(self.temp.name)
        application.DB = Path(self.temp.name) / "test.sqlite3"
        application.APP_TOKEN = ""
        application.init_db()
        application.app.config.update(TESTING=True)
        self.client = application.app.test_client()

    def tearDown(self):
        self.temp.cleanup()

    def add_resume(self, text):
        import sqlite3
        with sqlite3.connect(application.DB) as conn:
            conn.execute("INSERT INTO resume(filename,text,uploaded) VALUES(?,?,?)", ("resume.txt", text, "2026-11-02"))

    def test_health_reports_resume_absent_and_present(self):
        self.assertFalse(self.client.get("/api/health").json["resume_loaded"])
        self.add_resume("Python software engineering student project")
        response = self.client.get("/api/health")
        self.assertTrue(response.json["resume_loaded"])
        self.assertEqual(response.json["resume_filename"], "resume.txt")

    def test_profile_returns_only_extension_fields_and_keeps_defaults(self):
        result = self.client.get("/api/profile").json
        self.assertEqual(result["email"], "")
        self.assertEqual(result["phone"], "")
        self.assertEqual(result["city"], "")
        self.assertEqual(result["state"], "")
        self.assertNotIn("larp", result)

    def test_migrates_combined_city_state_and_address(self):
        import sqlite3
        with sqlite3.connect(application.DB) as conn:
            conn.execute("UPDATE profile SET value='Springfield, IL' WHERE key='city'")
            conn.execute("UPDATE profile SET value='' WHERE key='state'")
            conn.execute("UPDATE profile SET value='123 Main St, Springfield, IL' WHERE key='address'")
        application.init_db()
        result = self.client.get("/api/profile").json
        self.assertEqual(result["city"], "Springfield")
        self.assertEqual(result["state"], "IL")
        self.assertEqual(result["address"], "123 Main St")

    def test_evaluate_rejects_short_or_wrong_content(self):
        response = self.client.post("/api/evaluate", json={"description": "SWE intern"})
        self.assertEqual(response.status_code, 400)
        self.assertIn("too short", response.json["error"])

    def test_evaluate_returns_evidence_and_score_with_resume(self):
        resume = "Built a Python API using Flask and PostgreSQL\nImproved test coverage for a student project"
        self.add_resume(resume)
        description = ("We seek an engineering intern to build Python APIs, work with Flask and PostgreSQL, "
                       "write automated tests, collaborate with a product team, and improve reliable backend services. " * 2)
        response = self.client.post("/api/evaluate", json={"title": "Software Engineering Intern", "company": "Example", "url": "https://example.com/job", "description": description})
        self.assertEqual(response.status_code, 200)
        data = response.json
        self.assertTrue(data["resume_loaded"])
        self.assertGreater(data["score"], 0)
        self.assertIn("python", data["matched"])
        self.assertTrue(any("Python API" in line for line in data["evidence"]))
        self.assertIn(data["voice"], {"Direct", "Confident", "Assertive"})
        self.assertIn("not a hiring probability", data["note"])

    def test_evaluate_without_resume_fails_closed_to_zero(self):
        description = "Backend engineering intern working with Python APIs and data systems. " * 8
        response = self.client.post("/api/evaluate", json={"description": description})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json["resume_loaded"])
        self.assertEqual(response.json["score"], 0)
        self.assertEqual(response.json["evidence"], [])

    def test_evaluate_saves_and_updates_same_job_without_duplicates(self):
        description = "Python backend internship using Flask and SQL in a collaborative team. " * 3
        first = self.client.post("/api/evaluate", json={"title": "Backend Intern", "company": "Example", "url": "https://example.com/role", "description": description})
        second = self.client.post("/api/evaluate", json={"title": "Backend Intern (Updated)", "company": "Example", "url": "https://example.com/role", "description": description})
        self.assertEqual(first.json["saved_job_id"], second.json["saved_job_id"])
        result = self.client.get("/api/jobs?limit=10").json
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["jobs"][0]["title"], "Backend Intern (Updated)")

    def test_evaluate_discards_non_http_job_urls(self):
        description = "Software engineering internship working on Python backend systems. " * 3
        response = self.client.post("/api/evaluate", json={"url": "javascript:alert(1)", "description": description})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["url"], "")
        self.assertEqual(self.client.get("/api/jobs").json["jobs"][0]["url"], "")

    def test_ranked_job_limit_is_clamped_and_bad_value_is_safe(self):
        for number in range(3):
            description = f"Backend software internship with skill marker{number} and engineering team. " * 3
            self.client.post("/api/evaluate", json={"title": f"Role {number}", "url": f"https://example.com/{number}", "description": description})
        self.assertEqual(len(self.client.get("/api/jobs?limit=0").json["jobs"]), 1)
        self.assertEqual(len(self.client.get("/api/jobs?limit=bad").json["jobs"]), 3)

    def test_rank_places_synthetic_skill_match_above_unrelated_role(self):
        self.add_resume("Built Python services with Flask and PostgreSQL; wrote automated tests.")
        good = "Python Flask PostgreSQL backend services automated tests internship. " * 8
        poor = "CNC machining casting welding manufacturing robotics internship. " * 8
        self.client.post("/api/evaluate", json={"title": "Backend intern", "url": "https://example.com/backend", "description": good})
        self.client.post("/api/evaluate", json={"title": "Manufacturing intern", "url": "https://example.com/factory", "description": poor})
        ranked = self.client.get("/api/jobs?limit=2").json["jobs"]
        self.assertEqual(ranked[0]["title"], "Backend intern")
        self.assertGreater(ranked[0]["score"], ranked[1]["score"])

    def test_profile_saves_editable_matching_preferences_and_can_clear_them(self):
        response = self.client.post("/profile", data={
            "graduation": "December 2028", "skills": "Python, C++, SQL",
            "career_goals": "backend infrastructure, cybersecurity",
            "target_roles": "Software Engineering Intern", "role_campaigns": "Wave 2, Defense, Seed-stage startups",
        })
        self.assertEqual(response.status_code, 302)
        saved = application.profile()
        self.assertEqual(saved["graduation"], "December 2028")
        self.assertEqual(saved["skills"], "Python, C++, SQL")
        self.assertEqual(saved["career_goals"], "backend infrastructure, cybersecurity")
        self.assertEqual(saved["role_campaigns"], "Wave 2, Defense, Seed-stage startups")
        self.client.post("/profile", data={"skills": "", "career_goals": "", "role_campaigns": ""})
        saved = application.profile()
        self.assertEqual(saved["skills"], "")
        self.assertEqual(saved["career_goals"], "")
        self.assertEqual(saved["role_campaigns"], "")

    def test_match_uses_skills_campaign_and_graduation_window(self):
        self.add_resume("Python, C++, cybersecurity and backend infrastructure project experience")
        self.client.post("/profile", data={"graduation": "December 2028", "skills": "Python, C++, cybersecurity",
                                           "career_goals": "cybersecurity", "target_roles": "Software Engineering Intern",
                                           "role_campaigns": "Wave 2, Defense, Seed-stage startups"})
        description = "Software Engineering Intern for graduating students in 2027 to 2029. Build cybersecurity infrastructure with Python and C++. " * 2
        response = self.client.post("/api/evaluate", json={"title": "Software Engineering Intern", "company": "DefenseCo",
            "url": "https://example.com/defense", "description": description, "wave": "Defense", "sector": "cybersecurity", "funding_stage": "Seed"})
        self.assertEqual(response.status_code, 200)
        data = response.json
        self.assertEqual(data["eligibility"], "likely eligible")
        self.assertGreaterEqual(data["fit_breakdown"]["skills"], 60)
        self.assertEqual(data["fit_breakdown"]["campaign"], 100)
        self.assertIn("review", data["fit_status"].lower())
        with application.db() as conn:
            job = conn.execute("SELECT wave,sector,funding_stage FROM jobs WHERE id=?", (data["saved_job_id"],)).fetchone()
        self.assertEqual(tuple(job), ("Defense", "cybersecurity", "Seed"))

    def test_match_flags_explicit_graduation_year_mismatch_for_review(self):
        self.add_resume("Python software engineering intern project")
        self.client.post("/profile", data={"graduation": "December 2028", "target_roles": "Software Engineering Intern"})
        description = "Software Engineering Intern for students graduating in 2025. Build software systems. " * 4
        response = self.client.post("/api/evaluate", json={"title": "Software Engineering Intern", "description": description})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["eligibility"], "possible mismatch")
        self.assertEqual(response.json["fit_status"], "Check eligibility")

    def test_saved_role_campaign_tags_can_be_changed_after_scan(self):
        description = "Software engineering intern building Python backend services and APIs. " * 4
        created = self.client.post("/api/evaluate", json={"title": "Backend Intern", "description": description})
        job_id = created.json["saved_job_id"]
        response = self.client.post(f"/job/{job_id}/campaign", data={"wave": "Wave 2", "sector": "AI infrastructure", "funding_stage": "Seed"})
        self.assertEqual(response.status_code, 302)
        with application.db() as conn:
            saved = conn.execute("SELECT wave,sector,funding_stage FROM jobs WHERE id=?", (job_id,)).fetchone()
        self.assertEqual(tuple(saved), ("Wave 2", "AI infrastructure", "Seed"))
        page = self.client.get(f"/job/{job_id}")
        self.assertEqual(page.status_code, 200)
        self.assertIn(b"Edit this role", page.data)
        self.assertIn(b"AI infrastructure", page.data)
        self.assertEqual(self.client.post("/job/999/campaign", data={}).status_code, 404)

    def test_upload_rejects_unsupported_extension(self):
        response = self.client.post("/", data={"resume": (io.BytesIO(b"bad"), "resume.exe")}, content_type="multipart/form-data", follow_redirects=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Upload a PDF", response.data)
        self.assertFalse(self.client.get("/api/health").json["resume_loaded"])

    def test_upload_rejects_corrupt_pdf_without_server_error(self):
        response = self.client.post("/", data={"resume": (io.BytesIO(b"not a pdf"), "resume.pdf")}, content_type="multipart/form-data")
        self.assertEqual(response.status_code, 302)
        self.assertFalse(self.client.get("/api/health").json["resume_loaded"])

    def test_manual_memory_note_is_saved_and_bounded(self):
        response = self.client.post("/memory/add", data={"task": "Finished the database lab" + "x" * 500})
        self.assertEqual(response.status_code, 302)
        import sqlite3
        with sqlite3.connect(application.DB) as conn:
            kind, summary = conn.execute("SELECT kind,summary FROM activity ORDER BY id DESC LIMIT 1").fetchone()
        self.assertEqual(kind, "Task noted")
        self.assertLessEqual(len(summary), 300)

    def test_watched_resume_versions_only_record_content_changes(self):
        import sqlite3
        source = Path(self.temp.name) / "source.txt"
        source.write_text("Built a small Python project")
        with sqlite3.connect(application.DB) as conn:
            conn.execute("UPDATE profile SET value=? WHERE key='watch_path'", (str(source),))
        self.assertTrue(application.sync_watched_resume_once())
        self.assertFalse(application.sync_watched_resume_once())
        source.write_text("Built a larger Python project and added tests")
        self.assertTrue(application.sync_watched_resume_once())
        self.assertFalse(application.sync_watched_resume_once())
        with sqlite3.connect(application.DB) as conn:
            versions = conn.execute("SELECT COUNT(*) FROM resume").fetchone()[0]
            latest = conn.execute("SELECT text FROM resume ORDER BY id DESC LIMIT 1").fetchone()[0]
            updates = conn.execute("SELECT COUNT(*) FROM activity WHERE kind='Resume updated'").fetchone()[0]
        self.assertEqual(versions, 2)
        self.assertIn("added tests", latest)
        self.assertEqual(updates, 2)

    def test_watcher_ignores_missing_unsupported_and_oversized_paths(self):
        import sqlite3
        with sqlite3.connect(application.DB) as conn:
            conn.execute("UPDATE profile SET value=? WHERE key='watch_path'", (str(Path(self.temp.name) / "missing.txt"),))
        self.assertFalse(application.sync_watched_resume_once())
        unsupported = Path(self.temp.name) / "file.rtf"
        unsupported.write_text("text")
        with sqlite3.connect(application.DB) as conn:
            conn.execute("UPDATE profile SET value=? WHERE key='watch_path'", (str(unsupported),))
        self.assertFalse(application.sync_watched_resume_once())
        large = Path(self.temp.name) / "large.txt"
        with large.open("wb") as stream:
            stream.truncate(13 * 1024 * 1024)
        with sqlite3.connect(application.DB) as conn:
            conn.execute("UPDATE profile SET value=? WHERE key='watch_path'", (str(large),))
        self.assertFalse(application.sync_watched_resume_once())

    def test_role_review_download_preserves_source_and_labels_it_not_a_rewrite(self):
        source = "Built a Python API for a student project."
        self.add_resume(source)
        description = "Python API intern building backend tools and writing automated tests with a small team. " * 3
        created = self.client.post("/api/evaluate", json={"title": "Backend Intern", "company": "Example Co", "url": "https://example.com/role", "description": description})
        self.assertEqual(created.status_code, 200)
        response = self.client.get(f"/job/{created.json['saved_job_id']}/resume.txt")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"ROLE REVIEW NOTES", response.data)
        self.assertIn(b"NOT A REWRITTEN RESUME", response.data)
        self.assertIn(source.encode(), response.data)
        self.assertIn(b"Relevant existing resume lines", response.data)
        self.assertIn("review-notes.txt", response.headers["Content-Disposition"])
        response.close()

    def test_resume_upload_versions_txt_and_docx_content(self):
        from docx import Document
        document = Document()
        document.add_paragraph("Implemented a search endpoint in Python")
        buffer = io.BytesIO()
        document.save(buffer)
        for file_bytes, filename in [(b"Designed a cache in Go", "resume.txt"), (buffer.getvalue(), "resume.docx")]:
            response = self.client.post("/", data={"resume": (io.BytesIO(file_bytes), filename)}, content_type="multipart/form-data")
            self.assertEqual(response.status_code, 302)
        current = application.resume_row()
        self.assertIn("search endpoint", current["text"])
        import sqlite3
        with sqlite3.connect(application.DB) as conn:
            self.assertIn("cache in Go", conn.execute("SELECT text FROM resume ORDER BY id ASC LIMIT 1").fetchone()[0])

    def test_app_token_is_required_when_configured(self):
        application.APP_TOKEN = "secret-token"
        self.assertEqual(self.client.get("/api/profile").status_code, 403)
        self.assertEqual(self.client.get("/api/profile", headers={"X-Apply-Desk-Token": "wrong"}).status_code, 403)
        self.assertEqual(self.client.get("/api/profile", headers={"X-Apply-Desk-Token": "secret-token"}).status_code, 200)
        self.client.set_cookie("apply_desk_token", "secret-token", domain="localhost")
        self.assertEqual(self.client.get("/").status_code, 200)

    def test_pages_render_with_and_without_data(self):
        for path in ("/", "/resume", "/profile"):
            self.assertEqual(self.client.get(path).status_code, 200, path)
        self.add_resume("EDUCATION\nState University\nEXPERIENCE\nLab Assistant\n• Built Python tools")
        created = self.client.post("/api/evaluate", json={"title": "Backend Intern", "description": "Python backend internship building APIs and tools. " * 4})
        for path in ("/", "/resume", "/profile", f"/job/{created.json['saved_job_id']}"):
            self.assertEqual(self.client.get(path).status_code, 200, path)

    def test_profile_saves_links_without_clearing_watch_path(self):
        import sqlite3
        with sqlite3.connect(application.DB) as conn:
            conn.execute("UPDATE profile SET value='/tmp/resume.pdf' WHERE key='watch_path'")
        self.client.post("/profile", data={"linkedin": "linkedin.com/in/example", "github": "github.com/example"})
        saved = application.profile()
        self.assertEqual(saved["watch_path"], "/tmp/resume.pdf")
        self.assertEqual(self.client.get("/api/profile").json["linkedin"], "linkedin.com/in/example")

    def test_tuning_reorders_only_existing_lines(self):
        resume = ("Jordan Lee\nEXPERIENCE\nHelp Desk  Sep 2024 – Present\n• Resolved weekly tickets\n"
                  "• Wrote a Python script with Flask and PostgreSQL\nTECHNICAL SKILLS\nLanguages: Java, Python, SQL")
        tuned = application.tune_resume(resume, "Python Flask PostgreSQL backend internship. " * 4, "Backend Intern")
        lines = tuned["text"].splitlines()
        self.assertLess(lines.index("• Wrote a Python script with Flask and PostgreSQL"), lines.index("• Resolved weekly tickets"))
        self.assertIn("Languages: Python, Java, SQL", lines)
        source_words = sorted(re.findall(r"\w+", resume.lower()))
        tuned_words = sorted(w for w in re.findall(r"\w+", tuned["text"].lower()))
        self.assertEqual(source_words, tuned_words)
        self.assertTrue(tuned["changes"])

    def test_latex_tuning_keeps_jakes_resume_structure(self):
        source = (r"\begin{document}\section{Experience}\resumeSubheading{Lab}{2024}{Assistant}{Austin}"
                  "\n\\resumeItemListStart\n  \\resumeItem{Answered tickets}\n  \\resumeItem{Built \\textbf{Python} Flask APIs}\n\\resumeItemListEnd\n"
                  r"\section{Technical Skills}\textbf{Languages}{: Java, Python}\end{document}")
        tuned = application.tune_resume(source, "Python Flask API internship. " * 4)
        self.assertEqual(tuned["extension"], "tex")
        self.assertLess(tuned["text"].index("Flask APIs"), tuned["text"].index("Answered tickets"))
        self.assertIn(r"\textbf{Languages}{: Python, Java}", tuned["text"])
        self.assertEqual(len(tuned["text"]), len(source) + 0)

    def test_tuned_resume_download(self):
        self.add_resume("EXPERIENCE\nLab\n• Answered tickets\n• Built Python APIs")
        created = self.client.post("/api/evaluate", json={"title": "Intern", "company": "Example", "description": "Python API internship building services. " * 4})
        response = self.client.get(f"/job/{created.json['saved_job_id']}/tuned")
        self.assertEqual(response.status_code, 200)
        self.assertIn("attachment", response.headers["Content-Disposition"])
        self.assertLess(response.data.index(b"Built Python APIs"), response.data.index(b"Answered tickets"))

    def test_repeated_graduation_year_is_not_a_window(self):
        self.add_resume("Python software engineering intern project")
        self.client.post("/profile", data={"graduation": "May 2028"})
        description = "Software Engineering Intern for students graduating in 2027. Build Python services. " * 3
        response = self.client.post("/api/evaluate", json={"title": "Software Engineering Intern", "description": description})
        self.assertEqual(response.json["eligibility"], "verify")

    def test_skills_match_whole_words_only(self):
        self.add_resume("Built tools in C and Java")
        self.client.post("/profile", data={"skills": "C, Java, Go"})
        nurse = "Registered nurse providing patient care. JavaScript not required. Good communication skills. " * 3
        response = self.client.post("/api/evaluate", json={"title": "Registered Nurse", "description": nurse})
        self.assertEqual(response.json["matched_skills"], [])
        backend = "Backend intern writing Go and C services; Java is a plus. " * 3
        response = self.client.post("/api/evaluate", json={"title": "Backend Intern", "description": backend})
        self.assertEqual(sorted(response.json["matched_skills"])[:3], ["c", "go", "java"])

    def test_resume_page_warns_about_missing_watched_file(self):
        self.client.post("/profile", data={"watch_path": str(Path(self.temp.name) / "missing.pdf"), "next": "resume"})
        self.assertIn(b"can't find a file at this path", self.client.get("/resume").data)
        present = Path(self.temp.name) / "resume.txt"
        present.write_text("Built Python tools")
        self.client.post("/profile", data={"watch_path": str(present), "next": "resume"})
        self.assertNotIn(b"can't find a file at this path", self.client.get("/resume").data)

    def test_pdf_ligatures_are_normalized(self):
        from unittest import mock
        page = mock.Mock()
        page.extract_text.return_value = "Presented ﬁndings on a CI workﬂow"
        with mock.patch("pypdf.PdfReader", return_value=mock.Mock(pages=[page])):
            text = application.extract_text(Path("resume.pdf"), "pdf")
        self.assertEqual(text, "Presented findings on a CI workflow")

    JAKE = (r"\documentclass{article}" "\n" r"\newcommand{\resumeItem}[1]{\item\small{{#1}}}" "\n" r"\begin{document}" "\n"
            r"\begin{center}\textbf{\Huge \scshape Riley Chen} \\ \small \href{mailto:r@x.edu}{\underline{r@x.edu}}\end{center}" "\n"
            r"\section{Education}\resumeSubHeadingListStart\resumeSubheading{State University}{Austin, TX}{B.S. Computer Science}{May 2028}\resumeSubHeadingListEnd" "\n"
            r"\section{Experience}\resumeSubHeadingListStart\resumeSubheading{SWE Intern}{2025}{Acme}{Austin, TX}" "\n"
            r"\resumeItemListStart" "\n" r"  \resumeItem{Answered support tickets}" "\n"
            r"  \resumeItem{Responsible for building a Postgres API with \textbf{Python}}" "\n" r"  \resumeItem{Wrote docs}" "\n" r"\resumeItemListEnd" "\n"
            r"\resumeSubHeadingListEnd" "\n" r"\section{Technical Skills}\begin{itemize}\small{\item{\textbf{Languages}{: Java, Python} \\ \textbf{Developer Tools}{: Git, Docker}}}\end{itemize}" "\n"
            r"\end{document}")
    POSTING = "Backend intern building PostgreSQL APIs in Python on Kubernetes. Terraform a plus. Engineers react quickly to incidents. " * 3

    def test_tailoring_keeps_the_latex_template_and_edits_wording_and_skills(self):
        self.client.post("/profile", data={"skills": "Python, Kubernetes, React, Rust"})
        tuned = application.tune_resume(self.JAKE, self.POSTING, "Backend Intern")
        text = tuned["text"]
        self.assertEqual(text.split(r"\begin{document}")[0], self.JAKE.split(r"\begin{document}")[0])
        self.assertEqual(sorted(re.findall(r"\\[a-zA-Z]+", text)), sorted(re.findall(r"\\[a-zA-Z]+", self.JAKE)))
        self.assertEqual(text.count("{"), text.count("}"))
        self.assertIn(r"\resumeItem{Built a PostgreSQL API with \textbf{Python}}", text)
        self.assertLess(text.index("Built a PostgreSQL API"), text.index("Answered support tickets"))
        self.assertIn("{Software Engineering Intern}", text)
        self.assertIn(r"\textbf{Developer Tools}{: Kubernetes, Git, Docker}", text)
        self.assertNotIn("React", text)  # "react quickly" is not the framework
        self.assertNotIn("Rust", text)   # declared, but the posting doesn't ask for it
        education = lambda t: t[t.index(r"\section{Education}"):t.index(r"\section{Experience}")]
        self.assertEqual(education(text), education(self.JAKE))
        kinds = {change["kind"] for change in tuned["changes"]}
        self.assertTrue({"wording", "title", "skills", "order"} <= kinds)

    def test_tailoring_text_resume_rewords_without_inventing(self):
        resume = ("Riley Chen\nEXPERIENCE\nSWE Intern    2025\n• Responsible for building a Postgres API.\n• Answered tickets.\n• Wrote docs.\n"
                  "TECHNICAL SKILLS\nLanguages: Java, Python")
        self.client.post("/profile", data={"skills": "Go, Rust"})
        tuned = application.tune_resume(resume, "Backend intern using PostgreSQL and Go. " * 4, "Backend Intern")
        self.assertIn("• Built a PostgreSQL API.", tuned["text"])
        self.assertIn("Software Engineering Intern    2025", tuned["text"])
        self.assertIn("Languages: Go, Java, Python", tuned["text"])
        self.assertNotIn("Rust", tuned["text"])

    def test_print_pages_render_jakes_layout(self):
        self.assertEqual(self.client.get("/resume/print").status_code, 404)
        self.add_resume(self.JAKE)
        created = self.client.post("/api/evaluate", json={"title": "Backend Intern", "company": "Acme", "description": self.POSTING})
        for path in ("/resume/print", f"/job/{created.json['saved_job_id']}/resume/print?preview=1"):
            page = self.client.get(path)
            self.assertEqual(page.status_code, 200, path)
            self.assertIn(b'class="name">Riley Chen', page.data)
            self.assertIn(b"<h2>Experience</h2>", page.data)
            self.assertIn(b'<span class="right">Austin, TX</span>', page.data)
            self.assertNotIn(b"\\resumeItem", page.data)

    def test_one_fill_run_is_one_record_with_its_review(self):
        self.add_resume(self.JAKE)
        job_id = self.client.post("/api/evaluate", json={"title": "Backend Intern", "company": "Acme", "description": self.POSTING}).json["saved_job_id"]
        pdf = base64.b64encode(b"%PDF-1.4 test resume").decode()
        first = [{"page": "My Information", "question": "State", "value": "Virginia", "flag": ""}]
        later = first + [{"page": "Voluntary Disclosures", "question": "Gender", "value": "I do not wish to answer", "flag": "Chose the decline option for you"}]
        one = self.client.post("/api/applications", json={"job_id": job_id, "run": "r1", "review": first, "attached": False, "pdf": pdf}).json["id"]
        two = self.client.post("/api/applications", json={"job_id": job_id, "run": "r1", "review": later, "attached": True, "pdf": pdf}).json["id"]
        self.assertEqual(one, two)  # later pages update the same record
        page = self.client.get(f"/job/{job_id}").data.decode()
        self.assertEqual(page.count("Attached to your application"), 1)
        self.assertIn("filled 2 fields", page)
        self.assertIn("Review · 1 to check", page)
        self.assertIn("Chose the decline option for you", page)

    def test_self_identification_defaults_to_declining(self):
        plan = self.client.get("/api/fill-plan").json
        disclosures = {d["key"]: d for d in plan["disclosures"]}
        self.assertTrue(disclosures["eeo_gender"]["declined"])
        self.assertIn("I do not wish to answer", disclosures["eeo_gender"]["options"])
        self.assertEqual(len(plan["today"]["year"]), 4)
        self.client.post("/profile", data={"eeo_gender": "Male", "eeo_race": "Asian", "eeo_hispanic": "No", "eeo_veteran": "I am not a protected veteran"})
        disclosures = {d["key"]: d for d in self.client.get("/api/fill-plan").json["disclosures"]}
        self.assertEqual(disclosures["eeo_gender"]["options"][:2], ["Male", "Man"])
        self.assertFalse(disclosures["eeo_gender"]["declined"])
        self.assertIn("Asian (Not Hispanic or Latino)", disclosures["eeo_race"]["options"])
        self.assertIn("Not Hispanic or Latino", disclosures["eeo_hispanic"]["options"])
        self.assertTrue(disclosures["eeo_disability"]["declined"])
        self.assertIn(b"Voluntary self-identification", self.client.get("/profile").data)
        # Self-identification answers are never learned from forms.
        self.assertEqual(self.client.post("/api/answers", json={"answers": [{"question": "Are you Hispanic or Latino?", "answer": "No"}]}).json["saved"], 0)

    def test_drafts_and_year_in_school(self):
        self.add_resume(self.JAKE)
        self.client.post("/profile", data={"school": "Virginia Tech", "graduation": "December 2028", "class_year": "Freshman"})
        job_id = self.client.post("/api/evaluate", json={"title": "Backend Intern", "company": "Acme", "description": self.POSTING}).json["saved_job_id"]
        plan = self.client.get(f"/api/fill-plan?job_id={job_id}").json
        drafts = {d["key"]: d["text"] for d in plan["drafts"]}
        self.assertIn("Virginia Tech in December 2028", drafts["plans"])
        self.assertIn("Backend Intern role at Acme", drafts["why"])
        self.assertTrue(re.search(plan["drafts"][0]["pattern"], "what are your plans after graduation"))
        self.assertEqual(application.applying.standard_key("What is your current year in school?"), "class_year")
        self.assertIn("First Year", {a["key"]: a for a in plan["answers"]}["class_year"]["options"])

    def test_odds_are_blunt_and_capped(self):
        self.add_resume(self.JAKE)
        self.client.post("/profile", data={"class_year": "Freshman", "us_citizen": "Yes", "state": "VA", "gpa": "N/A"})
        p = application.profile()
        match = {"eligibility": "unknown", "breakdown": {"skills": 70}}
        resume = "Software Engineering Intern"
        big = application.role_odds({"title": "SWE Intern", "company": "Google", "description": "Build services on AWS."}, match, p, resume)
        self.assertEqual(big["label"], "Unlikely")  # capped for a freshman, whatever else fits
        aws = application.role_odds({"title": "SWE Intern", "company": "Acme Logistics", "description": "We deploy to AWS and Microsoft Azure."}, match, p, resume)
        self.assertNotIn("Big tech", " ".join(r["text"] for r in aws["reasons"]))
        upper = application.role_odds({"title": "SWE Intern", "company": "Acme", "description": "Open to rising juniors and seniors only."}, match, p, resume)
        self.assertIn("screened out", " ".join(r["text"] for r in upper["reasons"]))
        cleared = application.role_odds({"title": "SWE Intern", "company": "Acme", "description": "Must have an active Secret clearance."}, match, p, resume)
        self.assertEqual((cleared["label"], cleared["odds"]), ("Very unlikely", "under 1%"))
        local = application.role_odds({"title": "Software Engineering Intern", "company": "Leidos",
                                       "description": "Reston, VA. U.S. citizenship is required."}, match, p, resume)
        self.assertEqual(local["label"], "Decent shot")
        job_id = self.client.post("/api/evaluate", json={"title": "Backend Intern", "company": "Acme", "description": self.POSTING}).json["saved_job_id"]
        self.assertIn(b"Honest odds as a freshman", self.client.get(f"/job/{job_id}").data)

    def test_background_answers_and_current_job_from_resume(self):
        ask = application.applying.standard_key
        self.assertEqual(ask("Have you ever taken a polygraph examination?"), "polygraph")
        self.assertEqual(ask("Are you willing to undergo a polygraph and obtain a clearance?"), "clearance_eligible")
        self.assertEqual(ask("Are you currently employed?"), "currently_employed")
        self.assertEqual(ask("Are you currently employed by Acme or its subsidiaries?"), "previously_employed")
        self.assertEqual(ask("Are you currently employed by the U.S. Government?"), "government_employee")
        self.assertEqual(ask("Do you have any other employment or outside business activities?"), "other_employment")
        self.assertEqual(ask("Do you have any relatives employed by Acme?"), "relatives")
        self.add_resume(self.JAKE.replace(r"\resumeSubheading{SWE Intern}{2025}", r"\resumeSubheading{SWE Intern}{Jan. 2026 -- Present}"))
        self.client.post("/profile", data={"relatives": "None", "polygraph": "No"})
        job_id = self.client.post("/api/evaluate", json={"title": "Backend Intern", "company": "Northwind", "description": self.POSTING}).json["saved_job_id"]
        answers = {a["key"]: a for a in self.client.get(f"/api/fill-plan?job_id={job_id}").json["answers"]}
        self.assertEqual(answers["relatives"]["options"][:2], ["None", "No"])  # "None" in a text box, "No" in a Yes/No list
        self.assertEqual(answers["polygraph"]["options"][0], "No")
        self.assertEqual((answers["current_employer"]["answer"], answers["current_title"]["answer"]), ("Acme", "Software Engineering Intern"))  # from the tuned resume
        self.assertEqual(answers["currently_employed"]["answer"], "Yes")
        self.assertEqual(answers["previously_employed"]["answer"], "")  # Northwind isn't where they work
        same = self.client.post("/api/evaluate", json={"title": "Backend Intern", "company": "Acme Corp", "description": self.POSTING}).json["saved_job_id"]
        answers = {a["key"]: a for a in self.client.get(f"/api/fill-plan?job_id={same}").json["answers"]}
        self.assertEqual(answers["previously_employed"]["answer"], "Yes")

    def test_listing_answers_and_open_locations(self):
        facts = application.applying.listing_facts("Software Engineer Intern, Summer 2027", "Locations: Reston, VA; Huntsville, AL. Hybrid.",
                                                   "https://acme.wd5.myworkdayjobs.com/External/job/Reston-VA/Software-Engineer-Intern_R-00157321")
        self.assertEqual((facts["term"], facts["job_id"], facts["locations"]), ("Summer 2027", "R-00157321", ["Reston, VA", "Huntsville, AL"]))
        ask = application.applying.standard_key
        self.assertEqual(ask("Please indicate your location preference."), "location_preference")
        self.assertEqual(ask("Are you able to work on-site in Reston, VA?"), "work_onsite")
        self.assertEqual(ask("Are you willing to relocate?"), "relocate")
        self.add_resume(self.JAKE)
        self.client.post("/profile", data={"location_preference": "Open to all", "state": "VA"})
        job_id = self.client.post("/api/evaluate", json={"title": "Software Engineer Intern, Summer 2027", "company": "Acme",
                                                         "url": "https://acme.wd5.myworkdayjobs.com/External/job/Reston-VA/Intern_R-00157321",
                                                         "description": self.POSTING + " Location: Reston, VA."}).json["saved_job_id"]
        answers = {a["key"]: a for a in self.client.get(f"/api/fill-plan?job_id={job_id}").json["answers"]}
        self.assertTrue(answers["location_preference"]["open"])
        self.assertEqual(answers["location_preference"]["options"][0], "No preference")
        self.assertIn("Reston, VA", answers["location_preference"]["options"])
        self.assertEqual(answers["listing_term"]["answer"], "Summer 2027")
        self.assertEqual(answers["listing_job_id"]["answer"], "R-00157321")

    def test_application_copy_is_saved_downloaded_and_removed_with_role(self):
        self.add_resume(self.JAKE)
        job_id = self.client.post("/api/evaluate", json={"title": "Backend Intern", "company": "Acme", "url": "https://boards.example.com/acme/jobs/4012345",
                                                         "description": self.POSTING}).json["saved_job_id"]
        pdf = b"%PDF-1.4 test resume"
        bad = self.client.post("/api/applications", json={"job_id": job_id, "pdf": base64.b64encode(b"not a pdf").decode()})
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(self.client.post("/api/applications", json={"job_id": 999}).status_code, 404)
        saved = self.client.post("/api/applications", json={"job_id": job_id, "url": "https://boards.example.com/acme/jobs/4012345/apply",
                                                            "attached": True, "fields": ["email", "phone"], "pages": 1, "pdf": base64.b64encode(pdf).decode()})
        self.assertEqual(saved.status_code, 200)
        copy_id = saved.json["id"]
        self.assertEqual(self.client.get(f"/job/{job_id}/applications/{copy_id}.pdf").data, pdf)
        self.assertIn(b"Software Engineering Intern", self.client.get(f"/job/{job_id}/applications/{copy_id}.tex").data)
        self.assertNotIn(b"\\resumeItem", self.client.get(f"/job/{job_id}/applications/{copy_id}.txt").data)
        self.assertEqual(self.client.get(f"/job/{job_id + 1}/applications/{copy_id}.pdf").status_code, 404)
        page = self.client.get(f"/job/{job_id}").data
        self.assertIn(b"What you sent", page)
        self.assertIn(b"Attached to your application", page)
        self.assertIn(b"Resume sent", self.client.get("/").data)
        self.client.post(f"/job/{job_id}/delete")
        import sqlite3
        with sqlite3.connect(application.DB) as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM applications").fetchone()[0], 0)

    def test_application_url_maps_back_to_its_role(self):
        listing = self.client.post("/api/evaluate", json={"title": "Backend Intern", "url": "https://boards.example.com/acme/jobs/4012345",
                                                          "description": self.POSTING}).json["saved_job_id"]
        self.client.post("/api/evaluate", json={"title": "Other", "url": "https://boards.example.com/acme/jobs/999888", "description": self.POSTING})
        lookup = lambda url: self.client.get("/api/role-for-url", query_string={"url": url}).json["job_id"]
        self.assertEqual(lookup("https://boards.example.com/acme/jobs/4012345/apply"), listing)
        self.assertEqual(lookup("https://boards.example.com/acme/application?gh_jid=4012345"), listing)
        self.assertIsNone(lookup("https://elsewhere.example.com/acme/jobs/4012345"))
        self.assertIsNone(lookup("javascript:alert(1)"))

    def test_role_and_company_are_read_from_the_whole_page(self):
        identify = application.applying.identify_role
        workday = "Careers at JM Family\nSign In\nSoftware Engineer Intern page is loaded\nSoftware Engineer Intern\nApply\n"
        self.assertEqual(identify({"url": "https://jmfamily.wd1.myworkdayjobs.com/x/job/y", "heading": "Careers at JM Family"}, workday),
                         ("Software Engineer Intern", "JM Family"))
        self.assertEqual(identify({"url": "https://jobs.lever.co/shieldai/1", "title": "Shield AI - Summer 2027 Intern - Embedded Firmware"},
                                  "Shield AI is a venture-backed defense company."), ("Summer 2027 Intern - Embedded Firmware", "Shield AI"))
        self.assertEqual(identify({"url": "https://jobs.ashbyhq.com/astro-mechanica/1", "title": "Software Engineering Intern"},
                                  "ABOUT US: Astro Mechanica is an aerospace company."), ("Software Engineering Intern", "Astro Mechanica"))
        self.assertEqual(identify({"url": "https://boards.greenhouse.io/acme/jobs/1", "page_title": "Job Application for Backend Intern at Acme Robotics"}, ""),
                         ("Backend Intern", "Acme Robotics"))
        self.assertEqual(identify({"url": "https://x.example.com/job", "ld_title": "Data Intern", "ld_company": "Example Corp"}, ""), ("Data Intern", "Example Corp"))

    def test_roles_saved_without_a_company_are_repaired(self):
        import sqlite3
        with sqlite3.connect(application.DB) as conn:
            conn.execute("INSERT INTO jobs(company,title,url,description,saved) VALUES('', 'Careers at JM Family', 'https://jmfamily.wd1.myworkdayjobs.com/a/job/b', ?, '2026-11-03')",
                         ("Careers at JM Family\nSoftware Engineer Intern page is loaded\nResponsibilities: build things.",))
        application.init_db()
        with sqlite3.connect(application.DB) as conn:
            self.assertEqual(conn.execute("SELECT title, company FROM jobs").fetchone(), ("Software Engineer Intern", "JM Family"))
        job_id = 1
        self.client.post(f"/job/{job_id}/campaign", data={"company": "JM Family Enterprises", "title": "Software Engineer Intern"})
        self.assertIn(b"JM Family Enterprises", self.client.get(f"/job/{job_id}").data)

    def test_start_date_comes_from_the_posting_or_today(self):
        start = application.applying.program_start
        self.assertEqual(start("Summer Internship Program (May 24th, 2027 - July 30th, 2027).")[0]["mm_dd_yyyy"], "05/24/2027")
        self.assertEqual(start("The program begins on June 7, 2027 for semester schools.")[0]["mm_dd_yyyy"], "06/07/2027")
        from datetime import date
        self.assertEqual(start("No dates here.")[0]["iso"], date.today().isoformat())

    def test_fill_plan_has_tailored_experience_skills_and_answers(self):
        self.add_resume(self.JAKE)
        self.client.post("/profile", data={"name": "Riley Chen", "state": "VA", "gpa": "N/A", "degree": "B.S. Computer Science",
                                           "authorized_us": "Yes", "needs_sponsorship": "No", "has_clearance": "No", "skills": "Kubernetes, Rust"})
        job_id = self.client.post("/api/evaluate", json={"title": "Backend Intern", "company": "Acme", "description": self.POSTING}).json["saved_job_id"]
        plan = self.client.get(f"/api/fill-plan?job_id={job_id}").json
        self.assertEqual(plan["profile"]["state_options"], ["Virginia", "VA"])
        experience = plan["experience"][0]
        self.assertEqual((experience["title"], experience["company"]), ("Software Engineering Intern", "Acme"))
        self.assertIn("Built a PostgreSQL API", experience["description"])
        self.assertEqual(plan["skills"][:2], ["Python", "Kubernetes"])
        self.assertNotIn("Rust", plan["skills"][:2])
        answers = {a["key"]: a["options"] for a in plan["answers"]}
        self.assertEqual(answers["needs_sponsorship"][0], "No")
        self.assertIn("None", answers["has_clearance"])
        self.assertEqual(answers["enrollment_status"][0], "Bachelor's")
        self.assertEqual(plan["education"][0]["field"], "Computer Science")
        self.assertIn("gender", plan["never"])

    def test_fill_plan_lists_every_skill_best_first(self):
        # The form adds them in order up to its own limit, so a skill Workday
        # doesn't list is replaced by the next one rather than lost.
        self.add_resume(self.JAKE)
        many = "Kubernetes, Rust, Go, Docker, AWS, Linux, Bash, Terraform, Redis, Kafka, GraphQL, Swift"
        self.client.post("/profile", data={"skills": many})
        job_id = self.client.post("/api/evaluate", json={"title": "Backend Intern", "company": "Acme", "description": self.POSTING}).json["saved_job_id"]
        skills = self.client.get(f"/api/fill-plan?job_id={job_id}").json["skills"]
        self.assertGreater(len(skills), 10)
        self.assertIn("Swift", skills)
        self.assertEqual(skills[0], "Python")

    LONG_POSTING = ("Our platform team builds reliable services for millions of customers across banking, retail, shipping, "
                    "healthcare, logistics, education, energy, travel, insurance, media, gaming, telecom, and manufacturing. "
                    "Interns design features, write tests, review pull requests, monitor dashboards, improve latency, document "
                    "systems, present demos, collaborate with mentors, and learn production practices like deployment, rollback, "
                    "observability, security reviews, capacity planning, and incident response during a twelve week summer program.")
    WORKDAY = "https://acme.wd5.myworkdayjobs.com/External/job/Austin-TX/Software-Engineering-Intern_R-00012345"

    def evaluate(self, url, title="Software Engineering Intern", description=None):
        return self.client.post("/api/evaluate", json={"title": title, "company": "Acme", "url": url,
                                                        "description": description or self.LONG_POSTING}).json["saved_job_id"]

    def test_one_posting_written_several_ways_is_one_role(self):
        first = self.evaluate(self.WORKDAY)
        again = self.evaluate("https://acme.wd5.myworkdayjobs.com/en-US/External/job/Austin%2C-TX/Software-Engineering-Intern_R-00012345")
        board = self.evaluate("https://www.linkedin.com/jobs/view/4100000001")  # the same text on a job board
        self.assertEqual({first, again, board}, {first})
        other = self.evaluate("https://acme.wd5.myworkdayjobs.com/External/job/Boston-MA/Software-Engineering-Intern_R-00099999")
        self.assertNotEqual(other, first)  # another opening on the same site stays its own role
        self.assertEqual(len(application.scored_jobs()), 2)
        apply = self.client.get("/api/role-for-url", query_string={"url": self.WORKDAY.replace("External/", "en-US/External/") + "/apply/applyManually"}).json
        self.assertEqual(apply["job_id"], first)

    def test_workday_legal_entities_become_company_names(self):
        text = "Globex Systems is a space pioneer. At ACME Robotics we build arms. Initech makes software."
        cases = [("00100 ACME ROBOTICS, INC.", "https://acme.wd5.myworkdayjobs.com/External/job/X/Intern_R-1", "ACME Robotics"),
                 ("1000 Initech Corporation", "", "Initech"),
                 ("Arrow Capital, Limited Partnership", "", "Arrow Capital"),
                 ("0090 CORP-Corporate Office", "https://gx.wd1.myworkdayjobs.com/en-US/globex_systems_external_site/job/X/Intern_R10", "Globex Systems"),
                 ("Corporate Office Properties Trust", "", "Corporate Office Properties Trust")]
        for raw, url, name in cases:
            self.assertEqual(application.applying.company_name(raw, url, text), name)
            self.assertEqual(application.applying.company_name(name, url, text), name)  # already clean stays put
        self.assertEqual(application.applying.company_name("00100 LEIDOS, INC.", "", "At Leidos, we build."), "Leidos")
        # Roles saved by earlier versions are renamed at startup.
        import sqlite3
        with sqlite3.connect(application.DB) as conn:
            conn.execute("INSERT INTO jobs(company,title,url,description,saved) VALUES('0090 CORP-Corporate Office','Intern',?,?,'2026-11-03')",
                         (cases[3][1], text))
        application.init_db()
        with sqlite3.connect(application.DB) as conn:
            self.assertEqual(conn.execute("SELECT company FROM jobs").fetchone()[0], "Globex Systems")

    def test_redoing_an_application_keeps_one_record_with_one_line_per_question(self):
        self.add_resume(self.JAKE)
        job_id = self.evaluate(self.WORKDAY)
        line = {"page": "My Information", "question": "Phone Number", "value": "555", "flag": ""}
        skills = {"page": "My Experience", "question": "Skills", "value": "Python", "flag": ""}
        self.client.post("/api/applications", json={"job_id": job_id, "attached": True, "run": "1", "review": [line, line]})
        # The redo only filled what was still blank; the record keeps both runs' answers.
        self.client.post("/api/applications", json={"job_id": job_id, "attached": True, "run": "2", "review": [skills]})
        self.client.post("/api/applications", json={"job_id": job_id, "attached": False})  # saved as a PDF
        self.client.post("/api/applications", json={"job_id": job_id, "attached": False})
        import sqlite3
        with sqlite3.connect(application.DB) as conn:
            rows = conn.execute("SELECT run, attached, review FROM applications WHERE job_id=?", (job_id,)).fetchall()
        self.assertEqual(sorted(row[0] for row in rows), ["", "2"])
        review = application.json.loads(next(row[2] for row in rows if row[0] == "2"))
        self.assertEqual([item["question"] for item in review], ["Phone Number", "Skills"])

    def test_startup_merges_duplicates_saved_by_earlier_versions(self):
        import sqlite3
        with sqlite3.connect(application.DB) as conn:
            for url, saved in ((self.WORKDAY, "2026-11-03T02:15"), (self.WORKDAY.replace("Austin-TX", "en-US/Austin%2C-TX"), "2026-11-03T19:30")):
                conn.execute("INSERT INTO jobs(company,title,url,description,saved) VALUES('Acme','Software Engineering Intern',?,?,?)", (url, self.LONG_POSTING, saved))
            for job_id, run in ((1, ""), (1, ""), (2, "9")):
                conn.execute("INSERT INTO applications(job_id,created,attached,filled,source,extension,run) VALUES(?,?,1,'1 field','x','txt',?)", (job_id, "2026-11-03", run))
        application.init_db()
        with sqlite3.connect(application.DB) as conn:
            self.assertEqual(conn.execute("SELECT id FROM jobs").fetchall(), [(2,)])
            self.assertEqual(conn.execute("SELECT job_id, run FROM applications").fetchall(), [(2, "9")])
        self.assertTrue((application.INSTANCE / "resume_tailor.before-merge.sqlite3").exists())

    def test_application_page_gets_a_hinted_role_only_when_it_can_belong_to_it(self):
        listing = self.evaluate(self.WORKDAY)
        page = "https://apply.careers.example.com/careers/apply?pid=1970393557044764"
        self.assertIsNone(self.client.get("/api/role-for-url", query_string={"url": page, "hints": str(listing)}).json["job_id"])
        own_site = self.WORKDAY + "/apply"
        self.assertEqual(self.client.get("/api/role-for-url", query_string={"url": own_site, "hints": str(listing)}).json["job_id"], listing)
        board = self.evaluate("https://www.linkedin.com/jobs/view/1", title="Data Intern", description=self.LONG_POSTING.replace("platform", "data"))
        self.assertEqual(self.client.get("/api/role-for-url", query_string={"url": page, "hints": f"{board},{listing}"}).json["job_id"], board)

    def test_learned_answers_are_reused_but_never_sensitive_or_essays(self):
        answers = [{"question": "Have you previously worked for this organization?", "answer": "No"},
                   {"question": "Which of our teams interests you most?", "answer": "Texas; Utah"},
                   {"question": "Gender", "answer": "Male"}, {"question": "Salary expectations", "answer": "$40/hour"},
                   {"question": "Why do you want to work here?", "answer": "Because"}, {"question": "Email", "answer": ""}]
        self.assertEqual(self.client.post("/api/answers", json={"answers": answers}).json["saved"], 2)
        self.assertEqual(application.profile()["previously_employed"], "No")
        # A location preference typed on a form becomes the Profile answer, one place at a time.
        self.client.post("/api/answers", json={"answers": [{"question": "Please indicate your location preference.", "answer": "Texas; Utah"}]})
        prefs = next(a for a in self.client.get("/api/fill-plan").json["answers"] if a["key"] == "location_preference")
        self.assertEqual((prefs["options"], prefs.get("open")), (["Texas", "Utah"], False))
        plan = self.client.get("/api/fill-plan").json
        self.assertEqual([a["answer"] for a in plan["learned"]], ["Texas; Utah"])
        page = self.client.get("/profile").data
        self.assertIn(b"Remembered answers", page)
        self.assertIn(b"Texas; Utah", page)
        self.client.post("/answers/1/delete")
        self.assertEqual(self.client.get("/api/fill-plan").json["learned"], [])

    def test_government_degree_and_clearance_questions_route_to_their_answers(self):
        ask = application.applying.standard_key
        self.assertEqual(ask("Are you legally eligible for employment in the United States?"), "authorized_us")
        self.assertEqual(ask("Are you currently or have you ever been employed by the U.S. Government (including military)?"), "government_employee")
        self.assertEqual(ask("Are you a current or former Department of Defense (DoD) official?"), "dod_official")
        self.assertEqual(ask("Are you currently working towards a Bachelor's or Master's degree?"), "currently_student")
        self.assertEqual(ask("What degree are you currently pursuing?"), "enrollment_status")
        self.assertEqual(ask("Did you or will you obtain this degree in the last 24 months?"), "degree_recent")
        self.assertEqual(ask("Are you eligible to obtain and maintain a U.S. security clearance?"), "clearance_eligible")
        self.assertEqual(ask("Do you currently possess an active U.S. Government security clearance?"), "has_clearance")
        self.assertEqual(ask("Are you a non-U.S. government official, or closely related to one?"), "foreign_official")
        self.assertEqual(ask("Have you previously worked for Leidos?"), "previously_employed")
        self.client.post("/profile", data={"government_employee": "No", "heard_about": "Career Center/Campus Posting", "school": "Virginia Tech",
                                           "degree": "B.S. in Computer Science"})
        plan = self.client.get("/api/fill-plan").json
        answers = {a["key"]: a for a in plan["answers"]}
        self.assertEqual(answers["government_employee"]["options"][:2], ["No", "I have never"])
        self.assertEqual(answers["foreign_official"]["answer"], "")  # unanswered: left for the user
        self.assertIn("University", answers["heard_about"]["options"])
        self.assertEqual(answers["heard_about"]["options"][0], "Career Center/Campus Posting")
        education = plan["education"][0]
        self.assertEqual(education["school_options"][0], "Virginia Polytechnic Institute and State University")
        self.assertIn("Virginia Tech", education["school_options"])
        self.assertEqual(education["field_options"][0], "Computer Science")
        self.assertNotIn("Computer Science and Engineering Technology", education["field_options"])

    def test_pdf_words_repair_glued_and_split_layout_text(self):
        words = {"an", "unintended", "write", "on", "a", "read", "Fairfax,", "VA", "call-recording", "test", "double"}
        text = "Diagnosed anunintended write\nResearch Assistant    Fairfax, V A\ncall-recordingtest double"
        fixed = application.respace(text, words)
        self.assertEqual(fixed.splitlines(), ["Diagnosed an unintended write", "Research Assistant    Fairfax, VA", "call-recording test double"])
        self.assertEqual(application.respace("Python    Remote", words), "Python    Remote")  # unknown words stay

    def test_skills_follow_named_tools_then_posting_themes(self):
        skills = ["TypeScript", "JavaScript", "Java", "SQL", "React", "Vite", "deck.gl", "Mapbox", "pandas", "Python"]
        data_ai = "Develop Power BI reports, contribute to AI agents, support automation, and work with data for reporting."
        ranked = sorted(skills, key=lambda s: application.tailoring.skill_relevance(s, data_ai))
        self.assertEqual(ranked[:3], ["Python", "pandas", "SQL"])  # Python fits three themes
        self.assertEqual(set(ranked[-3:]), {"Vite", "deck.gl", "Mapbox"})
        web = "Build web app features in React with TypeScript."
        self.assertEqual(sorted(skills, key=lambda s: application.tailoring.skill_relevance(s, web))[:2], ["TypeScript", "React"])

    def test_wrong_host_is_rejected(self):
        response = self.client.get("/api/profile", headers={"Host": "attacker.example"})
        self.assertEqual(response.status_code, 421)


if __name__ == "__main__":
    unittest.main()
