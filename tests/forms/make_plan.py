"""Make a fill plan for the mock forms with a made-up identity (never the user's data)."""
import json, os, sqlite3, sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import app as application

out = Path(sys.argv[1])
temp = tempfile.mkdtemp()
application.INSTANCE = Path(temp)
application.DB = Path(temp) / "mock.sqlite3"
application.APP_TOKEN = ""
application.init_db()
client = application.app.test_client()
RESUME = """Riley Test
Austin, TX | 555-010-0100 | riley@example.com | github.com/rileytest

EDUCATION
Texas State University    San Marcos, TX
B.S. in Computer Science    Expected December 2028

EXPERIENCE
Example Labs    Oct. 2026 – Present
Software Engineering Intern    Remote
• Built a Python/FastAPI endpoint that returns capped JSON for downstream services
• Added schema validation and 20 unittest cases
Acme Research    May 2025 – Oct. 2025
Research Assistant    Austin, TX
• Analyzed survey data in SQL and Excel

PROJECTS
Trail Map | TypeScript, React, Express, Mapbox | Sept. 2026
• Built a web app that draws hiking trails on a map with a React/Vite frontend
Churn Study | Python, pandas, statsmodels | Sept. 2026
• Tested whether usage drops predict churn

TECHNICAL SKILLS
Languages: Python, TypeScript, JavaScript, Java, SQL
Frameworks & Libraries: React, Node.js, Express, FastAPI, pandas
Tools & Databases: PostgreSQL, Git, pytest
"""
with sqlite3.connect(application.DB) as conn:
    conn.execute("INSERT INTO resume(filename,text,uploaded) VALUES(?,?,?)", ("resume.txt", RESUME, "2026-11-12"))
client.post("/profile", data={"name": "Riley Test", "email": "riley@example.com", "phone": "555-010-0100", "address": "1 Example Way",
                              "city": "Austin", "state": "TX", "postal_code": "78701", "school": "Texas State University",
                              "degree": "B.S. in Computer Science", "graduation": "December 2028", "college_start": "August 2026",
                              "gpa": "N/A", "gpa_range": "3.5-4.0", "credits_by_start": "75", "class_year": "Freshman", "currently_student": "Yes",
                              "authorized_us": "Yes", "needs_sponsorship": "No", "us_citizen": "Yes", "has_clearance": "No",
                              "government_employee": "No", "previously_employed": "No", "heard_about": "LinkedIn"})
posting = ("Backend Engineer Intern, Summer 2027. Build REST APIs and services in Python and Java with PostgreSQL. "
           "You will design endpoints, write tests, and work with databases. ") * 3
job = client.post("/api/evaluate", json={"title": "Backend Engineer Intern", "company": "Example Corp", "description": posting,
                                         "url": "https://example.wd5.myworkdayjobs.com/External/job/Austin-TX/Backend-Engineer-Intern_R-00012345"}).json
plan = client.get(f"/api/fill-plan?job_id={job['saved_job_id']}").json
plan["model"] = ""  # no local model in the mock runs
out.write_text(json.dumps(plan))
print("skills:", plan["skills"])
print("experience dates:", [(e["company"], e["start"].get("mm_yyyy"), e["end"].get("mm_yyyy"), e["current"]) for e in plan["experience"]])
print("education dates:", [(e["school"], e["start"].get("mm_yyyy"), e["end"].get("mm_yyyy")) for e in plan["education"]])
