# Apply Desk

Native Mac app (Swift, `macos/`) that bundles a local Flask service (`app.py`, `tailoring.py`, `applying.py`, `templates/`, `static/`). It watches the front Chrome tab, scores listings, tunes the resume in Jake's layout, and fills applications with the ` key. See README.md for features.

## Commands
- Unit tests: `.venv/bin/python -m unittest discover -s tests`
- Build + install to /Applications: `./"Build Apply Desk App.command"` (quits the running app; reopen it with `open "/Applications/Apply Desk.app"`)
- Verify the bundle signature after a build: `codesign --verify --deep --strict "/Applications/Apply Desk.app"`
- JS syntax check: `node -e "new (require('vm').Script)(require('fs').readFileSync('macos/autofill.js','utf8'))"`

## Rules
- The user's data lives only in `~/Library/Application Support/Apply Desk/resume_tailor.sqlite3`. Never put personal details in tracked files or test fixtures.
- Answers come from Profile. A standard question with a blank answer is left for the user, never guessed. Self-identification (race, ethnicity, gender, veteran, disability) uses the Profile answer or the form's decline option, and is never learned from forms. Never answer salary, never check consent/terms boxes, never press Submit.
- Resume tuning stays truthful: reword and reorder the user's own lines, never change the Jake's template.

## Lessons
- `applying.STANDARD_QUESTIONS`: the first matching pattern owns a question, so specific patterns go before general ones (`clearance_eligible` before `has_clearance`, `government_employee` before `previously_employed`). Patterns run as JS `RegExp` on normalized text, so keep them JS-compatible; `.` stays in "u.s.", so use `[\w.]` or `.{0,n}` rather than `\w+` around it. New yes/no keys also go in the `yesno` tuple in `templates/profile.html`.
- `macos/autofill.js` pop-up lists: Workday leaves closed lists on the page. Always `closeLists()` first, read options with `freshOptions()` (new lists only, nearest the field, settled), and confirm the pick before `note()`. Use `strict` matching for schools, majors, and states.
- Multi-page runs (`macos/autofill.js`, "Run" section): progress lives in the tab's `sessionStorage` (`applyDeskRun`, keyed by role) so a second press or a full page reload continues the same run; `AppDelegate.waitForFill` re-injects the script after a reload. `continueButton()` must never match submit-like text. Test on the mocks in `tests/forms/` (`steps.html`: start page, validation errors, a terms box, a disability form, and a Review page whose Submit must stay unpressed; `workday.html`: stale lists, nested categories, look-alike options; `greenhouse.html`). Serve the folder with `python3 -m http.server`, save a plan from `/api/fill-plan` next to them, then in the browser eval `autofill.js` and call `applyDeskFill(btoa(plan), btoa(pdf), btoa(name))`.
- Search boxes: use `search()` in `macos/autofill.js` (type, then keydown/keypress/keyup Enter, no blur). `typeInto()` blurs, and Workday clears a search box on focus out.
- Workday redraws a search box after each pick. Never hold an input across picks: re-find it (`fillSkills` uses `findInput()`), count pills from the field container, and never pick an option that's already a pill (picking it again removes it). `tests/forms/steps.html` redraws boxes to catch this.
- Workday draws chosen values as tags (`selectedItem`, `role="option"`, inside a `selectedItemList` listbox) right by the box. `openOptions()` must skip them (`chosenTag`), or a slow search reads the tag as its results (a real run added only "Python IDLE"). Skills match by `skillKey()` ("Python (Programming Language)" is Python, "Python IDLE" never is); a skill the list lacks is skipped, not swapped.
- Workday's "Autofill with Resume" garbles entries ("returnsJSON", wrong dates). `fillBlocks` replaces job/school text and dates that differ from the resume unless this run already wrote that field (`run.wrote`, so the user's edits survive a refill). Test with `tests/forms/steps.html#parsed`.
- Link fields: GitHub goes in any website/portfolio/URL field when there's no personal site, with `https://` added. Workday's empty "Websites" section gets one entry (`addWebsite`).
- When a step has required blanks, the run waits (`waitForUser`) instead of stopping, with `__applyDeskBusy` off so the user's answers are learned; single-page forms just list them.
- `role_odds()` in `app.py`: company type comes from the company name or the posting introducing itself, never any mention ("deploys to AWS"). Big tech and quant are capped at "Unlikely" for freshmen. Keep it separate from the fit score.
- Review checks a value beside its own label, not anywhere on the page ("Virginia" also appears inside the school's name).
- PDF text: pypdf layout mode keeps columns but glues words; `respace()` in `app.py` repairs it with words from the bundled PDFKit helper (`macos/tools/pdftext.swift`, passed as `APPLY_DESK_PDFTEXT` by `Backend.swift`). Without the helper (plain Python, tests) text is unrepaired.
- Build signing: sign `Contents/MacOS/pdftext` before the app, without `--deep`, or `codesign --verify` fails with "nested code is modified".
- Keep the designated requirement pinned to `identifier "com.ajeet.applydesk"`; changing it resets the user's Chrome automation permission.
