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
