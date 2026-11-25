# Apply Desk — a private job-search assistant for your Mac

Apply Desk is a native Mac app that runs quietly in the background. It knows only what you give it — your resume and your details — and keeps all of it on this Mac. While you browse jobs in Chrome, it notices listings, scores each one against your resume and goals, fills applications on a keyboard shortcut, and builds a tuned version of your resume for every role.

## Download and install

**You need:** a Mac with Apple Silicon (M1 or newer), macOS 14 Sonoma or newer, and Google Chrome. Nothing else: Apply Desk carries its own Python, so there are no developer tools to install.

1. **Download** the `Apply-Desk-<version>-mac-arm64.zip` file (about 30 MB) from the [latest release](https://github.com/ajeetb123/apply-desk/releases/latest).
2. **Unzip it** (double-click the zip) and drag **Apply Desk** into **Applications**.
3. **Clear the download mark, once.** Apply Desk isn't notarized by Apple (that takes a paid Apple Developer account), so macOS blocks it, and the Python inside it, until you allow it. Open **Terminal** (⌘Space, type "Terminal"), paste this line, and press Return:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Apply Desk.app"
   ```

   It only removes the "downloaded from the internet" mark from Apply Desk's own files. If you skip it, macOS says *"Apple could not verify 'Apply Desk' is free of malware"*, and even after **Open Anyway** (System Settings → Privacy & Security) it still stops the built-in Python; Apply Desk then shows this same command to copy.
4. **Open Apply Desk** from Applications. It lives in the menu bar and opens at login (turn that off with **Open at Login** in its menu). Closing the window leaves it running; quit from the menu bar icon or with ⌘Q.
5. **Let it use Chrome.** The first time it reads a listing or you press `, macOS asks *"Apply Desk wants access to control Google Chrome"*: choose **OK**. Then in Chrome choose **View → Developer → Allow JavaScript from Apple Events**. Details are under [First-time Chrome setup](#first-time-chrome-setup).
6. **Add your resume, then your Profile** ([Setup](#setup)). Drop your resume on the Resume page; Profile fills in its name, contact details, school, and dates. Then answer the common questions in Profile (work authorization, sponsorship, and so on). A question you leave blank is left for you on every form, and nothing is guessed; answer it once and Apply Desk remembers it. If you don't share LinkedIn, set Profile → Links → **LinkedIn on forms**.
7. **Optional: essay drafts from a model on your Mac.** Install [Ollama](https://ollama.com), run `ollama pull gemma4:12b` in Terminal (a download of several GB), and turn on Profile → **A model on this Mac**. It never leaves your computer.

Press ` (top left, under Esc) on any application open in Chrome, review what it filled, and submit it yourself.

- **Check the download (optional):** the release lists a SHA-256; `shasum -a 256 ~/Downloads/Apply-Desk-*-mac-arm64.zip` should print the same.
- **Update:** quit Apply Desk, download the new zip, replace the app in Applications, and run the step 3 line again. Your data stays where it is.
- **Uninstall:** quit Apply Desk, delete it from Applications, and delete `~/Library/Application Support/Apply Desk` to erase your resume, profile, roles, and answers.

## What it does

- **Watches the tab you're on.** With many tabs and windows open, Apply Desk only reads the active tab of Chrome's front window, and only while Chrome is in front. It waits until the tab has finished loading, stayed in front for a moment, and its text has stopped changing, so it reads the whole posting once. Each tab remembers its role, and the sidebar shows the one you're viewing. A strong match (60+) slides in as a notification. Pause watching from the menu bar icon or the switch in the sidebar.
- **Fills whole applications with one key: `** (top left, under Esc). Press it once on the first page of an application in Chrome. Apply Desk fills the page, clicks **Save and Continue**, and keeps going page by page (on Workday it also picks **Apply Manually** on the start page). It stops:
  - at **Review**, where a review panel opens on the page, and never clicks Submit;
  - never for long on a page with a question it can't answer. First it drafts plain answers to "plans after graduation" and "why this role" from your own details, and picks a neutral option (N/A, Prefer not to say) when a required dropdown has one. Anything still blank (a terms checkbox, a fact only you know) is listed in a panel on the page; answer it there and Apply Desk keeps going by itself, no key press needed. On a single-page form it just lists them;
  - on sign-in pages (it never types passwords), or when a page doesn't change after Continue.

  Press ` while it's running to stop right there, and press it again whenever you like: it continues, fills only what's still blank, and never changes what's already in a field. What you change by hand is learned for that exact question, and Apply Desk uses your answer from then on. On each page it fills every empty field it can answer truthfully:
  - contact details, school, degree, GPA (Profile's GPA range only for a required list with no N/A; optional ones stay blank), when you started college (Profile → Started college) and graduate, "Current Degree Program", program length ("4 years": fall and spring semesters from start to graduation), and the credit hours you'll have when an internship starts (as a number, or the range holding it, like "90 or more"), in text boxes, dropdowns, Workday-style pop-up lists, type-to-search pickers, Yes/No buttons, and date boxes. Schools are matched by their official name ("Georgia Tech" → "Georgia Institute of Technology"), and schools, majors, and states only take a close match ("Computer Science", never "Computer Science and Engineering Technology"; "Virginia", never "West Virginia");
  - your **application answers** from Profile: work authorization, citizenship, sponsorship, clearance (held, or eligible to obtain), polygraph, U.S. government and DoD employment, foreign-official ties, current student, year in school, recent degree, how you heard, whether you worked there before (or work there now), current employment, other or outside employment, phone type, country, enrollment status, relatives employed, relocation, location preference, and working on-site. Your current employer and job title come from your resume's current job, so they stay up to date. A question you haven't answered in Profile is left for you. When "How did you hear about us?" has no option matching yours, it picks the closest one (career center, campus, university, career fair, job board…), opening categories when the list has them;
  - **links**: your GitHub goes in GitHub fields and in any website, portfolio, or URL field when you have no personal site (with `https://`). Workday's empty "Websites" section gets one entry for it;
  - **work experience and education** blocks, adding as many as your resume has, with each role description taken from your resume tuned for this job. When Workday has already filled them by reading your resume itself (its copy often runs words together, like "returnsJSON", or gets dates wrong), the text and dates are replaced with your resume's exact ones and marked in the review. Entries Workday added that aren't jobs or schools on your resume (a project read as a job) are listed in the review for you to delete;
  - **skills**: every skill your resume names (the Skills section, each project's tech list, tools in your bullets like "SQL and Excel", and your coursework like "Data Structures"), every skill the posting asks for that your work shows, then your Profile's, most important first for the kind of job, up to the form's own limit (every skill when it states none), skipping any already added. A skill must match by name: "Python (Programming Language)" and "Microsoft Excel" count, "Python IDLE" and "Biopython (Python Package)" never do, and a skill the form's list doesn't have is skipped for the next one. When a form's list names a skill differently, its other names are tried ("Retrieval-Augmented Generation" for RAG). Slow searches get more time and one retry;
  - **answers the listing gives**: the position and term you're applying for ("Summer 2027"), the requisition ID, and location preference. If you're open to all locations, it ticks "No preference" (or every location when there's no such option); otherwise it uses the listing's locations;
  - a **start date** from the posting's program dates ("May 24th, 2027 – July 30th, 2027" → 05/24/2027), or today if it gives none (never a start date at a past job, like "Government Civilian Start Date");
  - your **resume tuned for that role**, as a PDF, in the resume upload (never cover letter, transcript, or portfolio uploads);
  - **voluntary self-identification** (race, ethnicity, gender, pronouns, veteran, disability): your answers from Profile → Voluntary self-identification, or the form's "I don't wish to answer" option if you leave them blank. Disability forms also get your name and today's date.

  - **follow-up answers** from what you've already said: export-control questions (a U.S. citizen is a U.S. person), "If you answered No, list your countries" (N/A), "Can you start within 3 weeks?" (No, while you're in school), "If you selected Other, please specify" (N/A), intern or co-op (from the listing), and "graduating between December 2027 and June 2028?" (from your graduation date). Work-authorization questions about another country (UK, Canada) are left for you;
  - **terms and signatures**, only if you turn on Profile → Terms and signatures: terms, certification, and promise boxes are ticked and signature fields get your name, each marked in the review. Marketing and job-alert boxes and optional data sharing never are. Other boxes are ticked only when your own answers make the statement true.

  It works on Workday, Greenhouse (including its searchable dropdowns), Lever, Ashby (Yes/No buttons), Jobvite, JazzHR, Pinpoint, Paylocity, and Oracle's first step. On BambooHR and Rippling it opens the application from the listing and fills the text fields, but their custom dropdowns are still yours. Hidden spam-trap fields are never filled. Dell's Oracle site emails you a code, and iCIMS and Workday need you signed in, so those steps are yours.

  - **background questions**, only with your own answers: criminal record, non-compete or NDA, ever fired, military service, background checks, travel, hours, the languages you speak, and the rest under Profile → Background questions. A new install answers none of them, so a form leaves them for you; answer one once, on any form or in Profile, and Apply Desk uses it for every wording of that question ("Ever been terminated?", "Were you ever discharged?"). Nothing about you is guessed, and the local model is never asked these;
  - **answers that follow from your Profile**, each marked in the review: born in the U.S. means never naturalized, a student returns to school after the internship, a first-year's internship isn't their last, degrees completed (none yet), years of experience (from your resume's dates). Your own Profile answers and answers you gave on earlier forms always win;
  - **salary**: "Negotiable", or the posting's own stated pay when it gives one. A number is typed only when the posting states it;
  - **essay questions get a draft, not a finished answer**: why this role, about yourself, your strongest accomplishments, a project, a cover letter, and "describe your X experience" (honestly: "I haven't used C++ in a project yet" when your resume doesn't show it). Drafts are your resume's own lines in plain first person. A prompt Apply Desk doesn't recognize gets the closest story from your resume, marked as a starting point to rewrite.

  **Optional: a model on this Mac.** With [Ollama](https://ollama.com) running and Profile → "A model on this Mac" turned on, Apply Desk asks a model installed on your computer (Gemma, if you have it) about what its rules left open: essay drafts written for the exact question, and unusual multiple-choice questions like "which team interests you most?". It runs entirely on your Mac. It sees your resume, your Profile answers, and the posting, and is never asked about self-identification, contact details, pay, GPA, or consent. It leaves a question blank when your information doesn't settle it. Every answer is checked first (an option must be one the form offers; an essay loses any sentence with a number or a claim like "led" that your resume doesn't make) and is marked in the review. With the model off or Ollama closed, the built-in drafts are used instead.

  **Every page is filled, reviewed, and filled again.** Apply Desk reads each answer back from its field, re-enters any the site dropped, fills whatever is still empty, and only then moves on. If the site rejects the page it fills and checks it once more before asking you. Anything still blank is listed in the review, required ones first.

  **Several applications at once.** Press ` in one tab, switch to another, and press ` there. Each tab runs its own fill and the notifications name the company. A tab in the background fills more slowly, because Chrome slows background tabs. Pressing ` in a tab that's being filled stops that one.

  **A resume always goes with it.** If you open an application without having looked at its listing first, Apply Desk finds the posting from the application page (Workday, Lever) so the resume is still tuned for it. If it can't find the posting, it attaches your resume as it is and says so.

  Search boxes (school, skills, how you heard) are searched the way you would: type the name, press Enter. Schools are searched by their everyday name first ("Georgia Tech"), then the official one.

  **The review panel** lists, page by page, everything Apply Desk filled, and puts first what deserves a second look: drafts it wrote, neutral picks, decline answers it chose for you, closest-option picks (like "How did you hear"), today's date used as a start date, answers reused from earlier applications, and any value that isn't shown beside its label on the review page (a pick that didn't take). Click a line to jump to it. Each question appears once, even if you press ` again. The same review is saved with the role under **What you sent**: one entry per role, so redoing an application updates it and keeps the answers from both runs.

  Each pop-up list is checked after picking: Apply Desk closes leftover lists first, reads only the list that opened for that field, and confirms the choice took. It never answers salary questions, never checks consent or terms boxes, never writes essays, and never submits. Answers you type or pick yourself are remembered the next time you press ` (see **Remembered answers** in Profile, where you can forget any of them). The key only fills while a job board, careers site, or application page is in front in Chrome; everywhere else it types a backtick as usual. Apply Desk knows the role from the tab you scanned the listing in, the application's URL, or the role you viewed last. Forms embedded in another site (for example a Greenhouse iframe) need to be opened on their own page first.
- **Applies to a whole list: ⇧`.** On a page of many postings in Chrome (an internship list, a job board search, a careers page), press **Shift-`**. Apply Desk reads every posting on the page and skips quant and trading roles, roles that need an active clearance you don't hold, anything that isn't an internship or co-op, and postings you've already applied to. It opens each of the rest in its own tab, two at a time, saves and tunes it, and fills it up to Review, with a note as each one is ready (or needs you: a sign-in, a question only you can answer). **Batch** in the sidebar lists every posting with where it stands and why any were skipped.

  You submit each one. Apply Desk keeps a record: after 10 batch applications in a row that you submit exactly as it filled them, it asks once whether to submit fully clean ones itself (every answer your own; nothing drafted, guessed, or left blank; resume attached). Anything else still waits for you, and Profile → Submitting batch applications turns it on or off. It never types a password or creates an account.
- **Honest odds.** Each role page shows your rough odds of an offer from that one application, for your year in school (Profile → Application answers → Year in school), with the blunt reasons: class-year language in the posting, big tech and quant caps, clearance or GPA requirements, citizenship, location, your internship, and skill match. It's an estimate from the posting and typical internship hiring, not employer data, and separate from the fit score.
- **Knows who's hiring.** Each listing's title and company come from the whole page: the job data sites embed for search engines, Workday's job header, headings, the page title, and the posting text. Fix either one under **Edit this role's company, title, and campaign tags** on the role page.
- **Tunes your resume for the kind of job, not each posting.** Like keeping a frontend, a backend, and an ML version of one resume: the title (or, for a plain "Software Engineering Intern", the posting) says whether the job is frontend, backend, full-stack, ML and AI, data, mobile, systems, or general. Tuning then:
  - orders the skills on each Skills line most important first for that kind of job (skills the posting names break ties; the rest keep your order);
  - orders your projects most relevant first (the kind of work each one shows, the posting's own terms, then the skills it uses);
  - keeps experience in your order, and every bullet exactly as you wrote it. Nothing is reworded;
  - reads the skills the posting asks for (its required and preferred qualifications count most) and matches each to the experience or project that shows it best. Up to two the posting wants, that your work shows, but your resume never names are added: a tool to the tech list of the project that uses it ("HTML" for a React app), anything else to your Skills line ("REST APIs" when a project has an Express API). A skill nothing on your resume shows (AWS with no cloud work) is never added. The role page lists every skill with where it stands.

  Every move appears under **What changed**. The preview is the exact page that gets sent.
- **A new resume replaces the old one everywhere.** Upload it on the Resume page (or let Apply Desk watch its file): every fill and tuned resume uses it from then on, and the Profile facts it states (name, email, phone, GitHub, website, school, degree, when you started college, graduation) are replaced, with a note saying which. Your answers to questions like clearance and citizenship, your self-identification, your home address, and LinkedIn are never taken from a resume.
- **Keeps what you sent.** The tuned resume renders in Jake's layout (Letter, 0.5in margins) as a one-page PDF with selectable text. **Save PDF** puts it in Downloads, and the ` key attaches it. Either way, the exact copy is kept with the role under **What you sent**, as PDF, `.tex` (for LaTeX resumes), and `.txt`, even if your resume changes later. Saving again replaces that role's earlier copy.
- **Explains every score.** Fit weights resume skill overlap (40%), target-role alignment (25%), career-goal terms (15%), campaign alignment (10%), and graduation-window evidence (10%). It is a triage aid, not an ATS score or hiring probability.

### First-time Chrome setup

Apply Desk needs two things to read and fill Chrome tabs:

1. **macOS Automation access.** The first time you turn on watching or press `, macOS asks "Apply Desk wants access to control Google Chrome" — choose **OK**. If macOS has an old "Don't Allow" saved (an earlier build can leave one behind), the sidebar shows **Chrome access is off**; click **Ask macOS Again** and Apply Desk clears that one saved answer (`tccutil reset AppleEvents com.ajeet.applydesk`) so macOS asks again. You can also turn on **Google Chrome** under **Apply Desk** in System Settings → Privacy & Security → Automation.
2. **One Chrome setting.** In Chrome, choose **View → Developer → Allow JavaScript from Apple Events**.

Watching stays on while either is missing; the sidebar and menu bar say what's left, and Apply Desk resumes on its own once it's fixed. Apply Desk checks the Chrome setting itself, so it only asks you to turn it on when it's really off; if Chrome refuses a tab for another reason, Apply Desk tells you what Chrome said. It only reads the front tab, only when it looks like a job listing or when you press `.

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

Tuning follows these rules. It puts your own lines in order and adds at most two skills your work already shows; wording is yours (adding numbers, rewriting a weak bullet).

- **Jake's Resume is the template.** A LaTeX resume keeps its preamble, every command, and every word; only the order of skills and projects changes. PDFs are drawn with Jake's measurements (11pt base, 10pt items, small-caps 12pt section titles over a rule, 0.5in margins) in Computer Modern when installed, otherwise Charter.
- **One page, at least 10pt.** Spacing tightens before content spills to a second page, and the role page warns when it still does.
- **Tailor to the kind of job, not each posting.** One version per job type, applied widely, beats hours of per-posting edits: what matters most for the type leads, and nothing is reworded or added.
- **Lead with an action, in an active voice** in your own edits; aim for accomplishment, action, and measurable result (Google's XYZ formula).
- **Grouped skills.** Skills stay grouped as you wrote them (Languages, Frameworks, Developer Tools, Libraries).
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

## Build from source

For changing Apply Desk itself. You need the Xcode Command Line Tools (`xcode-select --install`). Double-click **Build Apply Desk App.command** once. It builds **Apply Desk.app** with the project's `.venv` Python, installs it in `/Applications` (or `~/Applications`), and carries over any data from earlier versions. **Start Apply Desk.command** rebuilds first when the source has changed, then opens the app.

### Make a release

1. Raise `VERSION` and `BUILD` at the top of **Build Apply Desk App.command**.
2. Double-click **Package Apply Desk.command** (or run `./"Package Apply Desk.command"`). It builds the downloadable copy into `dist/`: a pinned standalone Python 3.12 ([python-build-standalone](https://github.com/astral-sh/python-build-standalone), checked against its SHA-256 and cached in `.cache/`) with Flask, pypdf, and python-docx inside, every program in it signed, and the zip's SHA-256 beside it. It installs nothing.
3. Publish it: `gh release create v<VERSION> dist/Apply-Desk-<VERSION>-mac-arm64.zip dist/Apply-Desk-<VERSION>-mac-arm64.zip.sha256 --title "Apply Desk <VERSION>"`, with the SHA-256 in the notes.

The package holds only the app's code: no profile, resume, or answers (those live in `~/Library/Application Support/Apply Desk`). It's signed ad hoc, so macOS asks the step 3 question above; signing with a Developer ID and notarizing (`notarytool`) would make it open with no warning.

## Tests

Run `.venv/bin/python -m unittest discover -s tests -v` for the local API, profile, upload, matcher, role-review, and resume-tuning tests. Run **Build Apply Desk App.command** to compile and install the Mac app, and **Package Apply Desk.command** for the downloadable copy.

## License

MIT. See [LICENSE](LICENSE).
