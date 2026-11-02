# Apply Desk Chrome side panel

## Install locally

1. Start the local Flask app from the repository root: `.venv/bin/python app.py`.
2. Open `chrome://extensions` in Chrome and turn on **Developer mode**.
3. Choose **Load unpacked** and select this `extension/` folder.
4. Click the Apply Desk toolbar icon to open its side panel. The default shortcut is `Ctrl+Shift+Y` (`Command+Shift+Y` on Mac); change it at `chrome://extensions/shortcuts` if you prefer another available shortcut.

The extension is unpacked source for local use; it is not signed, published, or installed automatically.

## Commands

- `scan` or `scan this job`: read the visible job page and compare it with the resume imported in the local app.
- `tailor this job`: show the same evidence-oriented role review.
- `fill` or `fill my details`: ask for confirmation, then fill only empty, editable, clearly labelled contact/education text fields. Existing values are left alone. It never submits the page.
- `help`: show supported commands.

Use Fill only on an employer's application page. Confirm the values on that page yourself. Radio buttons, select menus, essay questions, eligibility/sponsorship questions, demographic questions, file uploads, passwords, and submit buttons are skipped.

## Permissions and data

The extension requests `sidePanel`, `activeTab`, and `scripting`. It does not request access to all websites, cookies, browsing history, storage, or clipboard. It reads the active page only after a command and makes requests only to `http://127.0.0.1:8787`, where the local app runs. The app refuses non-loopback clients and unexpected Host headers. Your profile and uploaded resume are stored locally in `instance/` and are not sent to an AI service.

## Current limits

The extension can evaluate and fill selected fields; it does not discover jobs, create a rewritten resume, generate a PDF, answer screening questions, or submit applications. Job overlap is a text heuristic, not a hiring predictor. Form labelling varies between employers, so an unmatched field must be handled manually. Review every application before submission.
