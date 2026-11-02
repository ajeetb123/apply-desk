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

    def test_upload_rejects_unsupported_extension(self):
        response = self.client.post("/", data={"resume": (io.BytesIO(b"bad"), "resume.exe")}, content_type="multipart/form-data")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Upload a PDF", response.data)
        self.assertFalse(self.client.get("/api/health").json["resume_loaded"])

    def test_wrong_host_is_rejected(self):
        response = self.client.get("/api/profile", headers={"Host": "attacker.example"})
        self.assertEqual(response.status_code, 421)


if __name__ == "__main__":
    unittest.main()
