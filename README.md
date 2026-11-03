# Apply Desk — a private job-search assistant for your Mac

Apply Desk is a native Mac app that runs quietly in the background. It knows only what you give it — your resume and your details — and keeps all of it on this Mac. While you browse jobs in Chrome, it notices listings, scores each one against your resume and goals, fills applications on a keyboard shortcut, and builds a tuned version of your resume for every role.

## Install and open

Double-click **Build Apply Desk App.command** once. It builds **Apply Desk.app**, installs it in `/Applications` (or `~/Applications`), and carries over any data from earlier versions. After that, open Apply Desk like any other app — from Launchpad, Spotlight, or the Dock. **Start Apply Desk.command** rebuilds first when the source has changed, then opens the app.

Apply Desk opens at login by default and lives in the menu bar. Closing the window leaves it running in the background; quit it from the menu bar icon or with ⌘Q. Turn off **Open at Login** in the Apply Desk menu or the menu bar icon.

## What it does

- **Watches Chrome for listings.** When the front Chrome tab is a job posting, Apply Desk saves it and scores it. A strong match (60+) slides in as a notification you can open. Pause watching from the menu bar icon or the switch in the sidebar.
- **Fills applications on ⌃⌥F.** On an employer application in Chrome, press Control-Option-F. Apply Desk types your saved contact, education, and link details into empty, clearly labeled fields and highlights them in green. It skips sponsorship, work-authorization, demographic, referral, and screening questions, and it never submits. Forms embedded in another site (for example a Greenhouse iframe) need to be opened on their own page first.
- **Tunes your resume per role.** Each role page shows your resume reordered so the bullets and skills that match the posting come first, with matching terms highlighted. Nothing is added or reworded. Copy it, or download it as `.txt` — or as `.tex` when your resume is a Jake's-style LaTeX file, so you can compile it in Overleaf.
- **Explains every score.** Fit weights resume skill overlap (40%), target-role alignment (25%), career-goal terms (15%), campaign alignment (10%), and graduation-window evidence (10%). It is a triage aid, not an ATS score or hiring probability.

### First-time Chrome setup

Chrome protects page text from other apps. Enable **View → Developer → Allow JavaScript from Apple Events** in Chrome, and allow Apply Desk when macOS asks to let it control Chrome (System Settings → Privacy & Security → Automation). Apply Desk only reads the front tab, only when it looks like a job listing or when you press ⌃⌥F.

## Setup

1. Open **Resume** and drop in your resume (PDF, DOCX, TXT, or LaTeX). Optionally set a file to watch so saved edits import automatically.
2. Open **Profile** and fill in your contact details, education, links, target roles, skills, goals, and search campaigns. The autofill preview shows exactly what ⌃⌥F will type.
3. Browse jobs in Chrome. Review roles on **Today**, where each saved role orbits you — closer means a better fit.

## How it's built

- `macos/` — the Swift app: `AppDelegate.swift` (menus, menu bar, Chrome watching, autofill), `Backend.swift` (starts and supervises the bundled local service), `WorkspaceWindow.swift` (the window, over native vibrancy), `Chrome.swift`, `Autofill.swift`, `Toast.swift`, `HotKey.swift`, and `tools/make_icon.swift` (draws the app icon at build time).
- `app.py`, `templates/`, `static/` — the local Flask service and workspace UI, bundled inside the app with its Python packages. It listens on `127.0.0.1:8787` only and requires a private per-install token, so other software and web pages can't read your profile through the port.

## Local data and privacy

Your resume versions, profile, saved roles, and notes live in `~/Library/Application Support/Apply Desk`. Quit Apply Desk and delete that folder to erase them. Resume watching checks only the one file path you set. Apply Desk doesn't monitor general computer activity or send anything to a remote service. Running `app.py` directly from a checkout uses the project's `instance/` folder instead.

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

Run `.venv/bin/python -m unittest discover -s tests -v` for the local API, profile, upload, matcher, role-review, and resume-tuning tests. Run **Build Apply Desk App.command** to compile and install the Mac app.
