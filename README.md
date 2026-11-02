# Apply Desk — Resume and application studio

A local-first resume and job tracker with a Chrome side panel. Import a resume, save your skills, graduation date, career goals and target campaigns, compare roles against that profile, and fill a conservative set of clearly labelled application fields.

## Run it

Double-click `Start Apply Desk.command` in Finder to start the local service in the background and open the main dashboard. Use `Stop Apply Desk.command` to stop the service. The dashboard is the main application; the Chrome side panel is a helper for scanning a listing while you browse.

Apply Desk remembers resume versions, saved roles, profile edits, and notes in its local database. To watch a resume you edit in another app, open **Profile & memory settings**, enter the full path to that one file, and save. Only that selected file is checked for changes. Add other work notes explicitly with **Add note**; Apply Desk does not watch general computer activity.

For terminal use:

```bash
cd "Apply Desk"
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open <http://127.0.0.1:8787>. The app binds to localhost only. Uploaded files and the database are kept under `instance/`, which is excluded from Git. Remove that folder to delete the local profile, imported resume, and saved roles. Chrome side panel setup and commands are in [extension/README.md](extension/README.md).

## Current workflow

1. Import a text PDF, DOCX, TXT, or LaTeX source resume.
2. In Profile & matching preferences, set graduation, skills, goals, target roles, and editable campaign names such as Wave 1, Wave 2, Defense, or Seed-stage startups.
3. Install the unpacked Chrome side panel and open a job listing. Type `scan` or `tailor` to save it; type `top 5` to rank the roles you have scanned.
4. Add campaign, sector, and funding-stage notes when known. These fields are editable because job listings often omit them.
5. Review the role fit breakdown and eligibility hints. On an application page, type `fill` to fill clearly labelled empty fields after confirmation; check every value and submit the application yourself.

The fit score weights resume skill overlap (40%), target-role alignment (25%), career-goal terms (15%), campaign alignment (10%), and graduation-window evidence (10%). It is a transparent triage aid, not an ATS score, recruiter ranking, or hiring probability. Keyword matching does not establish proficiency; graduation parsing only flags explicit year clues and can miss employer-specific rules. Confirm eligibility and each answer against your actual records. The app ranks roles you paste or scan while browsing; it does not discover listings across job boards or submit applications automatically. Strong matches are queued for your review. It does not generate a polished rewritten resume.

“Save & review role” saves the description locally and opens a comparison page. That page shows matching resume terms, terms to verify, and source resume lines that may be relevant. It does not tailor or rewrite the resume yet.

## Profile data

Contact and education details are saved in the ignored local database after you enter them in the profile form. They are not embedded in tracked source files. Use an email you expect to keep after graduation; keep a street address in the local profile only if an employer form requests it. Family members' birthplaces are not collected because they are unrelated to work authorization.

The resume-voice recommendation is per role and based only on the crude overlap measure: Direct for lower overlap, Confident for middle overlap, Assertive for high overlap. It changes emphasis, never facts. “Bold” is not recommended. No numbers, skills, titles, employers, responsibilities, or outcomes may be invented.

## Resume-writing choices

- Keep Jake's Resume as the user's selected, single-column LaTeX output format; do not copy other candidates' resume text.
- Use concise action + context + outcome bullets when the source resume supports them; quantify only with supplied evidence.
- Surface education and relevant technical work early for a current student.
- Match job-description terminology only where it truthfully describes the candidate.
- Do not place a street address on the resume by default.
- Treat online resume feedback as anecdotal. Prefer repeated, specific critique from r/EngineeringResumes' posting rules/wiki and successful posts over isolated claims, and prefer employer career guidance for recruiter expectations.

## Research links informing the first version

- [Simplify: install and use Copilot](https://help.simplify.jobs/help/articles/1749022-install-and-set-up-copilot) describes choosing a supported application, autofilling it, reviewing its fields, and submitting it yourself.
- [Simplify: Copilot autofill](https://simplifyjobs.featurebase.app/en/help/articles/2415391-use-copilot-to-autofill-applications) describes supported forms and review before submission.
- [Early Career Radar](https://earlycareerradar.com/) describes internship/new-grad discovery and links to employer sources; its [terms](https://earlycareerradar.com/terms) say jobseekers should verify details on the employer page.
- [Google resume writing tips](https://services.google.com/fh/files/misc/resume-writing-tips-for-veterans-2021.pdf) recommends concise, consistent bullets, action words and impact, a short resume for limited experience, and no physical address requirement.
- [Google interns' resume tips](https://students.googleblog.com/2015/07/google-interns-top-5-resume-tips.html) encourages concrete metrics when appropriate and within confidentiality limits.
- [MIT CAPD first-year resume guidance](https://capd.mit.edu/blog/2023/09/01/enhance-your-resume-a-guide-for-first-year-undergraduates/) recommends action + relevant task + result, with quantification when supportable.
- [MIT ATS-friendly resume guide](https://capd.mit.edu/resources/make-your-resume-ats-friendly/) recommends job-specific language and checking the plain-text extraction. These structural patterns are used as guidance; the app does not copy another applicant's resume wording.
- [Jake's Resume on Overleaf](https://www.overleaf.com/latex/templates/jakes-resume/syzfjbzwjncs) identifies Jake Gutierrez as the template author and links the source repository.
- [r/EngineeringResumes](https://www.reddit.com/r/EngineeringResumes/) is an anecdotal peer-feedback source, useful for concrete critiques but not a representative hiring study.

## Tests

Run `npm test` for command parsing, field classification, and safe fill-plan edge cases. Run `.venv/bin/python -m unittest discover -s tests -v` for API/profile/upload behavior and local-host restrictions. These tests cover supported behavior; they cannot establish compatibility with every employer form or predict hiring outcomes.

## Data handling

This app is for local use, not deployed hosting. Do not expose it to a network or commit `instance/`. The UI uses system fonts and makes no third-party requests.
