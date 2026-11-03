# Apply Desk — a private job-search assistant for your Mac

Apply Desk is a native Mac app that runs quietly in the background. It knows only what you give it — your resume and your details — and keeps all of it on this Mac. While you browse jobs in Chrome, it notices listings, scores each one against your resume and goals, fills applications on a keyboard shortcut, and builds a tuned version of your resume for every role.

## Install and open

Double-click **Build Apply Desk App.command** once. It builds **Apply Desk.app**, installs it in `/Applications` (or `~/Applications`), and carries over any data from earlier versions. After that, open Apply Desk like any other app — from Launchpad, Spotlight, or the Dock. **Start Apply Desk.command** rebuilds first when the source has changed, then opens the app.

Apply Desk opens at login by default and lives in the menu bar. Closing the window leaves it running in the background; quit it from the menu bar icon or with ⌘Q. Turn off **Open at Login** in the Apply Desk menu or the menu bar icon.

## What it does

- **Watches the tab you're on.** With many tabs and windows open, Apply Desk only reads the active tab of Chrome's front window, and only while Chrome is in front. It waits until the tab has finished loading, stayed in front for a moment, and its text has stopped changing, so it reads the whole posting once. Each tab remembers its role, and the sidebar shows the one you're viewing. A strong match (60+) slides in as a notification. Pause watching from the menu bar icon or the switch in the sidebar.
- **Fills applications with one key: `** (top left, under Esc). On an employer application in Chrome, press it. Apply Desk types your saved contact, education, and link details into empty, clearly labeled fields and highlights them in green, and attaches your resume tuned for that role, as a PDF, to the resume upload field (never to cover letter, transcript, or portfolio uploads). It skips sponsorship, work-authorization, demographic, referral, and screening questions, and it never submits. The key only does this while a job board, careers site, or application page is in front in Chrome; everywhere else it types a backtick as usual. Apply Desk knows the role from the tab you scanned the listing in, the application's URL, or the role you viewed last. Forms embedded in another site (for example a Greenhouse iframe) need to be opened on their own page first.
- **Tunes your resume per role, without touching the template.** The layout, sections, and facts stay the same. Tuning:
  - puts the bullets most relevant to the posting first within each entry;
  - spells technologies the way the posting does ("Postgres" or "PostgreSQL") and fixes their capitals ("Github" → "GitHub");
  - opens bullets with an action ("Responsible for building" → "Built") and keeps bullet punctuation consistent;
  - spells out title abbreviations ("SWE Intern" → "Software Engineering Intern");
  - adds up to four skills to the matching Technical Skills line, only when you listed them in your Profile and the posting asks for them.

  Every edit appears under **What changed** with the old and new wording. The preview is the exact page that gets sent.
- **Keeps what you sent.** The tuned resume renders in Jake's layout (Letter, 0.5in margins) as a one-page PDF with selectable text. **Save PDF** puts it in Downloads, and the ` key attaches it. Either way, the exact copy is kept with the role under **What you sent**, as PDF, `.tex` (for LaTeX resumes), and `.txt`, even if your resume changes later.
- **Explains every score.** Fit weights resume skill overlap (40%), target-role alignment (25%), career-goal terms (15%), campaign alignment (10%), and graduation-window evidence (10%). It is a triage aid, not an ATS score or hiring probability.

### First-time Chrome setup

Apply Desk needs two things to read and fill Chrome tabs:

1. **macOS Automation access.** The first time you turn on watching or press `, macOS asks "Apply Desk wants access to control Google Chrome" — choose **OK**. If macOS has an old "Don't Allow" saved (an earlier build can leave one behind), the sidebar shows **Chrome access is off**; click **Ask macOS Again** and Apply Desk clears that one saved answer (`tccutil reset AppleEvents com.ajeet.applydesk`) so macOS asks again. You can also turn on **Google Chrome** under **Apply Desk** in System Settings → Privacy & Security → Automation.
2. **One Chrome setting.** In Chrome, choose **View → Developer → Allow JavaScript from Apple Events**.

Watching stays on while either is missing; the sidebar and menu bar say what's left, and Apply Desk resumes on its own once it's fixed. It only reads the front tab, only when it looks like a job listing or when you press `.

## Setup

1. Open **Resume** and drop in your resume (PDF, DOCX, TXT, or LaTeX). Optionally set a file to watch so saved edits import automatically.
2. Open **Profile** and fill in your contact details, education, links, target roles, skills, goals, and search campaigns. The autofill preview shows exactly what the ` key will type.
3. Browse jobs in Chrome. Review roles on **Today**, where each saved role orbits you — closer means a better fit.

## How it's built

- `macos/` — the Swift app: `AppDelegate.swift` (menus, menu bar, Chrome watching, autofill), `Backend.swift` (starts and supervises the bundled local service), `WorkspaceWindow.swift` (the window, over native vibrancy), `ResumePDF.swift` (renders the PDF offscreen), `Chrome.swift`, `Autofill.swift`, `Toast.swift`, `HotKey.swift`, and `tools/make_icon.swift` (draws the app icon at build time).
- `app.py`, `tailoring.py`, `templates/`, `static/` — the local Flask service, the resume tuning rules, and the workspace UI (`templates/resume_print.html` is the Jake's-layout PDF page), bundled inside the app with its Python packages. It listens on `127.0.0.1:8787` only and requires a private per-install token, so other software and web pages can't read your profile through the port.

## Local data and privacy

Your resume versions, profile, saved roles, and notes live in `~/Library/Application Support/Apply Desk`. Quit Apply Desk and delete that folder to erase them. Resume watching checks only the one file path you set. Apply Desk doesn't monitor general computer activity or send anything to a remote service. Running `app.py` directly from a checkout uses the project's `instance/` folder instead.

## Resume-writing choices

Tuning follows these rules, gathered from the sources below. Everything it can't do truthfully on its own (adding numbers, rewriting a weak bullet) is left to you.

- **Jake's Resume is the template.** A LaTeX resume keeps its preamble and every command; only bullet text, title abbreviations, and skill lists change. PDFs are drawn with Jake's measurements (11pt base, 10pt items, small-caps 12pt section titles over a rule, 0.5in margins) in Computer Modern when installed, otherwise Charter.
- **One page, at least 10pt.** Spacing tightens before content spills to a second page, and the role page warns when it still does.
- **Mirror the posting's wording.** ATS keyword matching is often literal, so a technology you already list is spelled the posting's way. Skills are added only from your own Profile, capped at four, to avoid keyword stuffing.
- **Lead with an action, in an active voice.** Weak openers become past-tense verbs; aim for accomplishment, action, and measurable result (Google's XYZ formula) in your own edits.
- **Standard titles and grouped skills.** Spell out abbreviated job titles, and keep skills grouped as Languages, Frameworks, Developer Tools, and Libraries.
- **Education first while you're a student.** Section order is never changed.

## Research references

- [Tech Interview Handbook: resume guide](https://www.techinterviewhandbook.org/resume/) — one page, PDF, 0.5in margins, 10pt minimum, imitate the posting's language without keyword stuffing.
- [Jake's Resume source (jakegut/resume)](https://github.com/jakegut/resume) — layout measurements and section structure.
- [Jobscan: ATS resume guide](https://www.jobscan.co/blog/ats-resume/) — mirror the posting's exact terms.
- [Google XYZ formula (Inc.)](https://www.inc.com/bill-murphy-jr/google-recruiters-say-these-5-resume-tips-including-x-y-z-formula-will-improve-your-odds-of-getting-hired-at-google.html)
- [Google resume writing tips](https://services.google.com/fh/files/misc/resume-writing-tips-for-veterans-2021.pdf)
- [MIT ATS-friendly resume guide](https://capd.mit.edu/resources/make-your-resume-ats-friendly/)
- [Jake's Resume on Overleaf](https://www.overleaf.com/latex/templates/jakes-resume/syzfjbzwjncs)
- [r/EngineeringResumes](https://www.reddit.com/r/EngineeringResumes/) — XYZ/STAR/CAR bullets and Bitstream Charter as a font; useful peer feedback, not a representative hiring study.

## Tests

Run `.venv/bin/python -m unittest discover -s tests -v` for the local API, profile, upload, matcher, role-review, and resume-tuning tests. Run **Build Apply Desk App.command** to compile and install the Mac app.
