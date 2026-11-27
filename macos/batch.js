// Apply Desk's batch helpers, injected into Chrome tabs by the Mac app.
//   collect()   the postings on a page of many (a job board search, a careers
//               page, an internship list): [{url, text}], one per posting
//   confirmed() whether this tab shows an application-submitted confirmation
//   submit()    presses the final Submit on a Review page. The Mac app calls it
//               only when the user turned on submitting fully clean
//               applications and this run left nothing blank or flagged.
(() => {
  const text = el => (el ? (el.innerText || el.textContent || '') : '').replace(/\s+/g, ' ').trim();
  const visible = el => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  // Application systems: a link to one is a posting or its application.
  const ATS = /(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|myworkdaysite\.com|icims\.com|smartrecruiters\.com|workable\.com|jobvite\.com|taleo\.net|successfactors\.(com|eu)|bamboohr\.com|recruitee\.com|breezy\.hr|applytojob\.com|rippling\.com|paylocity\.com|ultipro\.com|dayforcehcm\.com|oraclecloud\.com|eightfold\.ai|avature\.net|teamtailor\.com|pinpointhq\.com|wellfound\.com|workatastartup\.com)/i;
  // A posting on a careers site or job board: /jobs/<something>, /careers/<something>...
  const POSTING_PATH = /\/(jobs?|careers?|positions?|openings?|postings?|job-?details?|requisitions?|vacanc\w*)\/[^/?#]{3,}/i;
  const NOT_POSTING = /\/(search|login|signin|sign-in|signup|account|saved|alerts?|apply-?with|categories|teams|locations|departments)(\/|$)/i;

  function collect() {
    const here = location.href.replace(/#.*$/, '');
    const rows = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      let url;
      try { url = new URL(a.getAttribute('href'), location.href); } catch (error) { continue; }
      if (!/^https?:$/.test(url.protocol)) continue;
      const clean = url.href.replace(/#.*$/, '');
      if (clean === here || NOT_POSTING.test(url.pathname)) continue;
      const ats = ATS.test(url.host + url.pathname);
      if (!ats && !POSTING_PATH.test(url.pathname)) continue;
      // One posting per row: an internship list links both the company's
      // application and an aggregator's page; the application wins.
      const row = a.closest('tr, li, article, [role="row"], [role="listitem"], [data-job-id], [data-testid*="job" i]') || a;
      const before = rows.get(row);
      if (before && (before.ats || !ats)) continue;
      rows.set(row, { url: clean, text: text(row).slice(0, 400), ats });
    }
    const seen = new Set();
    return [...rows.values()].filter(row => !seen.has(row.url) && seen.add(row.url)).slice(0, 150).map(({ url, text }) => ({ url, text }));
  }

  const CONFIRM = /thank(s| you) for (applying|your application|submitting)|application (has been |was )?(submitted|received|complete)|we('ve| have) received your application|successfully (submitted|applied)|your application is (complete|in)|you('ve| have) (successfully )?applied/i;
  // Not a submission yet: a page asking for an emailed code or an email check, or an application left open.
  const NOT_YET = /verification code|one.time pass ?code|confirm your (identity|email)|verify your (email|account|identity)|check your (email|inbox) to (continue|finish|complete)|(continue|finish|complete) (to apply|your application|applying)|application is incomplete|incomplete application|thank you for starting|you('ve| have) started (your|an) (job )?application/i;
  const confirmed = () => {
    const page = text(document.body).slice(0, 20000);
    return CONFIRM.test(page) && !NOT_YET.test(page);
  };

  function submit() {
    const label = b => (text(b) || b.value || b.getAttribute('aria-label') || '').trim();
    const buttons = [...document.querySelectorAll('button, input[type=submit], [role=button]')]
      .filter(b => visible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
    const button = buttons.find(b => /^submit( (my |your )?application)?$/i.test(label(b)));
    if (!button) return 'none';
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    button.click();
    return 'pressed';
  }

  window.__applyDeskBatch = { collect, confirmed, submit };
})();
