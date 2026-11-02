import io
import tempfile
import unittest
from pathlib import Path

import app as application


class ApplyDeskApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        application.DB = Path(self.temp.name) / "test.sqlite3"
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
        response = self.client.post("/", data={"resume": (io.BytesIO(b"bad"), "resume.exe")}, content_type="multipart/form-data")
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

    def test_wrong_host_is_rejected(self):
        response = self.client.get("/api/profile", headers={"Host": "attacker.example"})
        self.assertEqual(response.status_code, 421)


if __name__ == "__main__":
    unittest.main()
