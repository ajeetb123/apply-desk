# Apply Desk — a private job-search assistant for your Mac

Apply Desk is a native Mac app that runs quietly in the background. It knows only what you give it — your resume and your details — and keeps all of it on this Mac. While you browse jobs in Chrome, it notices listings, scores each one against your resume and goals, fills applications on a keyboard shortcut, and builds a tuned version of your resume for every role.

## Install and open

Double-click **Build Apply Desk App.command** once. It builds **Apply Desk.app**, installs it in `/Applications` (or `~/Applications`), and carries over any data from earlier versions. After that, open Apply Desk like any other app — from Launchpad, Spotlight, or the Dock. **Start Apply Desk.command** rebuilds first when the source has changed, then opens the app.

Apply Desk opens at login by default and lives in the menu bar. Closing the window leaves it running in the background; quit it from the menu bar icon or with ⌘Q. Turn off **Open at Login** in the Apply Desk menu or the menu bar icon.

## What it does

- **Watches the tab you're on.** With many tabs and windows open, Apply Desk only reads the active tab of Chrome's front window, and only while Chrome is in front. It waits until the tab has finished loading, stayed in front for a moment, and its text has stopped changing, so it reads the whole posting once. Each tab remembers its role, and the sidebar shows the one you're viewing. A strong match (60+) slides in as a notification. Pause watching from the menu bar icon or the switch in the sidebar.
- **Fills whole applications with one key: `** (top left, under Esc). Press it once on the first page of an application in Chrome. Apply Desk fills the page, clicks **Save and Continue**, and keeps going page by page (on Workday it also picks **Apply Manually** on the start page). It stops:
  - at **Review**, where a review panel opens on the page, and never clicks Submit;
  - never for long on a page with a question it can't answer. First it drafts plain answers to "plans after graduation" and "why this role" from your own details, and picks a neutral option (N/A, Prefer not to say) when a required dropdown has one. Anything still blank (a terms checkbox, a fact only you know) is listed in a panel on the page; answer it there and Apply Desk keeps going by itself, no key press needed. On a single-page form it just lists them;
  - on sign-in pages (it never types passwords), or when a page doesn't change after Continue.

  Press ` while it's running to stop after the current page. On each page it fills every empty field it can answer truthfully:
  - contact details, school, degree, GPA, and graduation date, in text boxes, dropdowns, Workday-style pop-up lists, type-to-search pickers, Yes/No buttons, and date boxes. Schools are matched by their official name ("Virginia Tech" → "Virginia Polytechnic Institute and State University"), and schools, majors, and states only take a close match ("Computer Science", never "Computer Science and Engineering Technology"; "Virginia", never "West Virginia");
  - your **application answers** from Profile: work authorization, citizenship, sponsorship, clearance (held, or eligible to obtain), polygraph, U.S. government and DoD employment, foreign-official ties, current student, year in school, recent degree, how you heard, whether you worked there before (or work there now), current employment, other or outside employment, phone type, country, enrollment status, relatives employed, relocation, location preference, and working on-site. Your current employer and job title come from your resume's current job, so they stay up to date. A question you haven't answered in Profile is left for you. When "How did you hear about us?" has no option matching yours, it picks the closest one (career center, campus, university, career fair, job board…), opening categories when the list has them;
  - **links**: your GitHub goes in GitHub fields and in any website, portfolio, or URL field when you have no personal site (with `https://`). Workday's empty "Websites" section gets one entry for it;
  - **work experience and education** blocks, adding as many as your resume has, with each role description taken from your resume tuned for this job. When Workday has already filled them by reading your resume itself (its copy often runs words together, like "returnsJSON", or gets dates wrong), the text and dates are replaced with your resume's exact ones and marked in the review. Entries Workday added that aren't jobs or schools on your resume (a project read as a job) are listed in the review for you to delete;
  - **skills**, picked from your resume and Profile with the ones the posting asks for first, up to the form's own limit (every skill when it states none), skipping any already added. A skill must match by name: "Python (Programming Language)" counts as Python, "Python IDLE" never does, and a skill the form's list doesn't have is skipped for the next one;
  - **answers the listing gives**: the position and term you're applying for ("Summer 2027"), the requisition ID, and location preference. If you're open to all locations, it ticks "No preference" (or every location when there's no such option); otherwise it uses the listing's locations;
  - a **start date** from the posting's program dates ("May 24th, 2027 – July 30th, 2027" → 05/24/2027), or today if it gives none (never a start date at a past job, like "Government Civilian Start Date");
  - your **resume tuned for that role**, as a PDF, in the resume upload (never cover letter, transcript, or portfolio uploads);
  - **voluntary self-identification** (race, ethnicity, gender, veteran, disability): your answers from Profile → Voluntary self-identification, or the form's "I don't wish to answer" option if you leave them blank. Disability forms also get your name and today's date.

  - **follow-up answers** from what you've already said: export-control questions (a U.S. citizen is a U.S. person), "If you answered No, list your countries" (N/A), "Can you start within 3 weeks?" (No, while you're in school), "If you selected Other, please specify" (N/A), intern or co-op (from the listing), and "graduating between December 2027 and June 2028?" (from your graduation date). Work-authorization questions about another country (UK, Canada) are left for you;
  - **terms and signatures**, only if you turn on Profile → Terms and signatures: required terms and certification boxes are ticked and signature fields get your name, each marked in the review. Optional boxes (texts, newsletters, job alerts) are never ticked.

  It works on Workday, Greenhouse (including its searchable dropdowns), Lever, Ashby (Yes/No buttons), Jobvite, JazzHR, Pinpoint, Paylocity, and Oracle's first step. On BambooHR and Rippling it opens the application from the listing and fills the text fields, but their custom dropdowns are still yours. Hidden spam-trap fields are never filled. Dell's Oracle site emails you a code, and iCIMS and Workday need you signed in, so those steps are yours.

  - **standard screening answers**, each marked in the review so you can change it: no criminal record, non-compete, or prior termination; no military service; yes to a background check, the full program dates, and returning to school; languages (English); degrees completed (none yet); years of experience (from your resume's dates). Your own Profile answers and answers you gave on earlier forms always win;
  - **salary**: "Negotiable", or the posting's own stated pay when it gives one. A number is typed only when the posting states it;
  - **essay questions get a draft, not a finished answer**: why this role, about yourself, your strongest accomplishments, a project, a cover letter, and "describe your X experience" (honestly: "I haven't used C++ in a project yet" when your resume doesn't show it). Drafts are your resume's own lines in plain first person. A prompt Apply Desk doesn't recognize gets the closest story from your resume, marked as a starting point to rewrite.

  **Optional: a model on this Mac.** With [Ollama](https://ollama.com) running and Profile → "A model on this Mac" turned on, Apply Desk asks a model installed on your computer (Gemma, if you have it) about what its rules left open: essay drafts written for the exact question, and unusual multiple-choice questions like "which team interests you most?". It runs entirely on your Mac. It sees your resume, your Profile answers, and the posting, and is never asked about self-identification, contact details, pay, GPA, or consent. It leaves a question blank when your information doesn't settle it. Every answer is checked first (an option must be one the form offers; an essay loses any sentence with a number or a claim like "led" that your resume doesn't make) and is marked in the review. With the model off or Ollama closed, the built-in drafts are used instead.

  **Every page is filled, reviewed, and filled again.** Apply Desk reads each answer back from its field, re-enters any the site dropped, fills whatever is still empty, and only then moves on. If the site rejects the page it fills and checks it once more before asking you. Anything still blank is listed in the review, required ones first.

  **Several applications at once.** Press ` in one tab, switch to another, and press ` there. Each tab runs its own fill and the notifications name the company. A tab in the background fills more slowly, because Chrome slows background tabs. Pressing ` in a tab that's being filled stops that one.

  **A resume always goes with it.** If you open an application without having looked at its listing first, Apply Desk finds the posting from the application page (Workday, Lever) so the resume is still tuned for it. If it can't find the posting, it attaches your resume as it is and says so.

  Search boxes (school, skills, how you heard) are searched the way you would: type the name, press Enter. Schools are searched by their everyday name first ("Virginia Tech"), then the official one.

  **The review panel** lists, page by page, everything Apply Desk filled, and puts first what deserves a second look: drafts it wrote, neutral picks, decline answers it chose for you, closest-option picks (like "How did you hear"), today's date used as a start date, answers reused from earlier applications, and any value that isn't shown beside its label on the review page (a pick that didn't take). Click a line to jump to it. Each question appears once, even if you press ` again. The same review is saved with the role under **What you sent**: one entry per role, so redoing an application updates it and keeps the answers from both runs.

  Each pop-up list is checked after picking: Apply Desk closes leftover lists first, reads only the list that opened for that field, and confirms the choice took. It never answers salary questions, never checks consent or terms boxes, never writes essays, and never submits. Answers you type or pick yourself are remembered the next time you press ` (see **Remembered answers** in Profile, where you can forget any of them). The key only fills while a job board, careers site, or application page is in front in Chrome; everywhere else it types a backtick as usual. Apply Desk knows the role from the tab you scanned the listing in, the application's URL, or the role you viewed last. Forms embedded in another site (for example a Greenhouse iframe) need to be opened on their own page first.
- **Honest odds.** Each role page shows your rough odds of an offer from that one application, for your year in school (Profile → Application answers → Year in school), with the blunt reasons: class-year language in the posting, big tech and quant caps, clearance or GPA requirements, citizenship, location, your internship, and skill match. It's an estimate from the posting and typical internship hiring, not employer data, and separate from the fit score.
- **Knows who's hiring.** Each listing's title and company come from the whole page: the job data sites embed for search engines, Workday's job header, headings, the page title, and the posting text. Fix either one under **Edit this role's company, title, and campaign tags** on the role page.
- **Tunes your resume per role, without touching the template.** The layout, sections, and facts stay the same. Tuning:
  - puts the bullets most relevant to the posting first within each entry;
  - spells technologies the way the posting does ("Postgres" or "PostgreSQL") and fixes their capitals ("Github" → "GitHub");
  - opens bullets with an action ("Responsible for building" → "Built") and keeps bullet punctuation consistent;
  - spells out title abbreviations ("SWE Intern" → "Software Engineering Intern");
  - adds up to four skills to the matching Technical Skills line, only when you listed them in your Profile and the posting asks for them.

  Every edit appears under **What changed** with the old and new wording. The preview is the exact page that gets sent.
- **Keeps what you sent.** The tuned resume renders in Jake's layout (Letter, 0.5in margins) as a one-page PDF with selectable text. **Save PDF** puts it in Downloads, and the ` key attaches it. Either way, the exact copy is kept with the role under **What you sent**, as PDF, `.tex` (for LaTeX resumes), and `.txt`, even if your resume changes later. Saving again replaces that role's earlier copy.
- **Explains every score.** Fit weights resume skill overlap (40%), target-role alignment (25%), career-goal terms (15%), campaign alignment (10%), and graduation-window evidence (10%). It is a triage aid, not an ATS score or hiring probability.

### First-time Chrome setup

Apply Desk needs two things to read and fill Chrome tabs:

1. **macOS Automation access.** The first time you turn on watching or press `, macOS asks "Apply Desk wants access to control Google Chrome" — choose **OK**. If macOS has an old "Don't Allow" saved (an earlier build can leave one behind), the sidebar shows **Chrome access is off**; click **Ask macOS Again** and Apply Desk clears that one saved answer (`tccutil reset AppleEvents com.ajeet.applydesk`) so macOS asks again. You can also turn on **Google Chrome** under **Apply Desk** in System Settings → Privacy & Security → Automation.
2. **One Chrome setting.** In Chrome, choose **View → Developer → Allow JavaScript from Apple Events**.

Watching stays on while either is missing; the sidebar and menu bar say what's left, and Apply Desk resumes on its own once it's fixed. It only reads the front tab, only when it looks like a job listing or when you press `.

## Setup

1. Open **Resume** and drop in your resume (PDF, DOCX, TXT, or LaTeX). Optionally set a file to watch so saved edits import automatically.
2. Open **Profile** and fill in your contact details, education, links, target roles, skills, goals, and search campaigns. The autofill preview shows exactly what the ` key will type.
3. Browse jobs in Chrome. Review roles on **Today**, where each saved role orbits you — closer means a better fit. Companies show by the name people know them by, not Workday's legal entity ("00100 ACME, INC." → "Acme"). A posting is saved once: the same Workday listing under another URL (`/en-US/`, `Arlington%2C-VA`), its application pages, or the same posting on a job board all count as one role.
   The ` key uses the role you last looked at only when the application is on that role's site, the company's own site, or comes from a job board listing, so another company's form never gets that role's resume.

## How it's built

- `macos/` — the Swift app: `AppDelegate.swift` (menus, menu bar, Chrome watching, autofill), `Backend.swift` (starts and supervises the bundled local service), `WorkspaceWindow.swift` (the window, over native vibrancy), `ResumePDF.swift` (renders the PDF offscreen), `Chrome.swift`, `Autofill.swift` with `autofill.js` (the form filler injected into Chrome), `Toast.swift`, `HotKey.swift`, `tools/make_icon.swift` (draws the app icon at build time), and `tools/pdftext.swift` (a helper bundled as `Contents/MacOS/pdftext` that reads PDF words with PDFKit, so resume text keeps correct spacing; pypdf alone glues some words together).
- `app.py`, `tailoring.py`, `applying.py`, `templates/`, `static/` — the local Flask service, the resume tuning rules, application answers and form data, and the workspace UI (`templates/resume_print.html` is the Jake's-layout PDF page), bundled inside the app with its Python packages. It listens on `127.0.0.1:8787` only and requires a private per-install token, so other software and web pages can't read your profile through the port.

## Local data and privacy

Your resume versions, profile, saved roles, and notes live in `~/Library/Application Support/Apply Desk`. Quit Apply Desk and delete that folder to erase them. Resume watching checks only the one file path you set. Apply Desk doesn't monitor general computer activity or send anything to a remote service. The optional model runs in Ollama on this Mac and is reached only at `127.0.0.1`. Running `app.py` directly from a checkout uses the project's `instance/` folder instead.

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
