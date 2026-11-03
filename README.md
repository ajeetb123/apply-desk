# Apply Desk — local job search app

Apply Desk is a Mac menu bar app with a local dashboard. It watches the active Chrome tab for job listings, compares them with your saved resume and preferences, and opens a role review when it finds a strong match. It does not need a Chrome extension.

## Start the app

Double-click **Start Apply Desk.command**. It starts the local matcher and launches **Apply Desk.app**, which stays available from the Mac menu bar. Open the menu bar icon to:

- pause or resume background matching
- scan the current Chrome tab immediately
- fill clearly labeled, empty contact and education fields after confirmation
- open your Apply Desk workspace
- quit the background app

Use **Stop Apply Desk.command** to stop the app and local matcher. The dashboard is at <http://127.0.0.1:8787>.

### First-time Chrome setup

Chrome protects webpage text from background apps. The first time Apply Desk needs to read a listing, enable **View → Developer → Allow JavaScript from Apple Events** in Chrome. macOS may also ask you to allow Apply Desk to control Chrome. Apply Desk checks the active tab locally; its watcher looks for job-listing URLs and reads page text only when a likely listing is open. It saves scanned roles in the local database.

The menu bar app only opens Apply Desk’s review page for a strong match. You still check the listing and submit applications yourself. It does not click an employer’s Apply button or submit forms.

## Setup

1. Upload your resume from the dashboard.
2. In **Matching preferences**, set graduation, skills, goals, target roles, and campaigns such as Wave 1, Wave 2, Defense, or Seed-stage startups.
3. Keep Chrome open on a job listing. Apply Desk will save and score a recognized posting. Choose **Scan current Chrome tab** from the menu bar to run it immediately.
4. Review the fit breakdown, role eligibility, campaign tags, and evidence. Confirm all details on the employer page.

To build or refresh the native app manually, double-click **Build Apply Desk App.command**. This creates `Apply Desk.app` in the project folder. The app binds its web service to localhost only.

## Matching behavior

The fit score weights resume skill overlap (40%), target-role alignment (25%), career-goal terms (15%), campaign alignment (10%), and graduation-window evidence (10%). It is a triage aid, not an ATS score or hiring probability. Keyword matching does not establish proficiency. Graduation parsing can miss employer-specific rules, and campaign/funding details may be absent from listings, so verify them from company sources.

Strong matches open the Apply Desk review page. If no resume is loaded, it opens the review as a reminder to add one. Lower scoring roles remain in the saved list. On an employer application form, **Fill empty application fields** copies only safe, clearly labeled contact and education values after your confirmation. It does not fill screening questions or submit applications. The app does not crawl job boards or write a polished resume.

## Local data and privacy

Resume versions, profile information, saved roles, and notes stay in the ignored `instance/` folder. Remove that folder to erase local Apply Desk data. Resume watching checks only the one file path you explicitly set in profile preferences. The app does not monitor general computer activity or send page content to a remote service.

## Resume-writing choices

- Keep Jake's Resume as the selected single-column LaTeX output format; do not copy another applicant's resume text.
- Use concise action + context + outcome bullets when the source resume supports them.
- Quantify only with supplied evidence and surface education and relevant technical work early for a current student.
- Match job-description terms only when they truthfully describe the candidate.
- Treat online resume feedback as anecdotal; prefer specific, repeated critiques and employer guidance.

## Research references

- [Google resume writing tips](https://services.google.com/fh/files/misc/resume-writing-tips-for-veterans-2021.pdf)
- [Google interns' resume tips](https://students.googleblog.com/2015/07/google-interns-top-5-resume-tips.html)
- [MIT first-year resume guidance](https://capd.mit.edu/blog/2023/09/01/enhance-your-resume-a-guide-for-first-year-undergraduates/)
- [MIT ATS-friendly resume guide](https://capd.mit.edu/resources/make-your-resume-ats-friendly/)
- [Jake's Resume on Overleaf](https://www.overleaf.com/latex/templates/jakes-resume/syzfjbzwjncs)
- [r/EngineeringResumes](https://www.reddit.com/r/EngineeringResumes/) — useful peer feedback, not a representative hiring study.

## Tests

Run `.venv/bin/python -m unittest discover -s tests -v` for local API, profile, upload, matcher, and role-review tests. Run **Build Apply Desk App.command** to compile the macOS menu bar application.
