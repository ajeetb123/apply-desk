# Apply Desk

Native Mac app (Swift, `macos/`) that bundles a local Flask service (`app.py`, `tailoring.py`, `applying.py`, `templates/`, `static/`). It watches the front Chrome tab, scores listings, tunes the resume in Jake's layout, and fills applications with the ` key. See README.md for features.

## Commands
- Unit tests: `.venv/bin/python -m unittest discover -s tests`
- Build + install to /Applications: `./"Build Apply Desk App.command"` (quits the running app; reopen it with `open "/Applications/Apply Desk.app"`)
- Verify the bundle signature after a build: `codesign --verify --deep --strict "/Applications/Apply Desk.app"`
- JS syntax check: `node -e "new (require('vm').Script)(require('fs').readFileSync('macos/autofill.js','utf8'))"`

## Rules
- The user's data lives only in `~/Library/Application Support/Apply Desk/resume_tailor.sqlite3`. Never put personal details in tracked files or test fixtures.
- Answers come from Profile. A standard question with a blank answer is left for the user, never guessed. Never answer race, gender, veteran, disability, or salary; never check consent boxes; never submit.
- Resume tuning stays truthful: reword and reorder the user's own lines, never change the Jake's template.

## Lessons
- `applying.STANDARD_QUESTIONS`: the first matching pattern owns a question, so specific patterns go before general ones (`clearance_eligible` before `has_clearance`, `government_employee` before `previously_employed`). Patterns run as JS `RegExp` on normalized text, so keep them JS-compatible; `.` stays in "u.s.", so use `[\w.]` or `.{0,n}` rather than `\w+` around it. New yes/no keys also go in the `yesno` tuple in `templates/profile.html`.
- `macos/autofill.js` pop-up lists: Workday leaves closed lists on the page. Always `closeLists()` first, read options with `freshOptions()` (new lists only, nearest the field, settled), and confirm the pick before `note()`. Use `strict` matching for schools, majors, and states.
- PDF text: pypdf layout mode keeps columns but glues words; `respace()` in `app.py` repairs it with words from the bundled PDFKit helper (`macos/tools/pdftext.swift`, passed as `APPLY_DESK_PDFTEXT` by `Backend.swift`). Without the helper (plain Python, tests) text is unrepaired.
- Build signing: sign `Contents/MacOS/pdftext` before the app, without `--deep`, or `codesign --verify` fails with "nested code is modified".
- Keep the designated requirement pinned to `identifier "com.ajeet.applydesk"`; changing it resets the user's Chrome automation permission.
