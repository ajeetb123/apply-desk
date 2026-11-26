// Apply Desk's sign-in helper, injected by the Mac app only when a fill stops
// at a sign-in page and the user chose Profile → Signing in. It never stores
// anything: the Mac app passes the password for this one call, from the
// Keychain, and nothing here is saved, logged, or learned.
//   look()  what this page asks for: 'signin', 'create', 'google', 'verify',
//           'code', 'exists', 'captcha', or 'none' (no sign-in here)
//   act(a)  one step with a = {email, password, known, google, name, agree}:
//           returns 'google', 'created', 'signed_in', 'opened_create',
//           'no_account', or what look() says when there's nothing to do
//   google(email)  on accounts.google.com: picks the account and continues
//           only when Google shares nothing beyond name, email, and picture
(() => {
  const text = el => (el ? (el.innerText || el.textContent || '') : '').replace(/\s+/g, ' ').trim();
  const visible = el => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const body = () => text(document.body).slice(0, 20000);
  const buttons = () => [...document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]')].filter(visible);
  const label = b => (text(b) || b.value || b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
  const find = pattern => buttons().find(b => pattern.test(label(b)));
  const labelOf = el => [...(el.labels || [])].map(text).join(' ') || el.getAttribute('aria-label') || el.placeholder || el.name || el.id || '';
  const inputs = () => [...document.querySelectorAll('input')].filter(el => visible(el) && !el.disabled && !el.readOnly);
  const passwords = () => inputs().filter(el => el.type === 'password');
  const emails = () => inputs().filter(el => el.type === 'email' || /e-?mail|user ?name|login/i.test(labelOf(el)) && el.type !== 'password' && el.type !== 'checkbox');

  const GOOGLE = /^(sign (in|up)|log ?in|continue|register) with google$|^google$/i;
  const CREATE_LINK = /^(create (an |your )?account|sign up|register( now)?|new user\b.*|don.t have an account\b.*|create one)$/i;
  const CREATE_BUTTON = /^(create (an |your )?account|sign up|register|create|submit|continue)$/i;
  const SIGN_IN_BUTTON = /^(sign ?in|log ?in|continue|next|submit)$/i;
  const CODE = /verification code|one.time (pass(word|code)?|code)|security code|enter (the )?code|\d.digit code|passcode/i;
  const VERIFY = /verify your (email|account)|check your (email|inbox)|we('ve| have)? (just )?sent (you )?(an? )?(email|link|verification)|confirm your email|activate your account|verification (email|link)/i;
  const EXISTS = /already (exists|registered|in use|have an account|associated)|account (with|for) this email (already )?exists/i;
  const captcha = () => [...document.querySelectorAll('iframe')].some(f => visible(f) && /recaptcha\/api2\/(anchor|bframe)|hcaptcha|challenges\.cloudflare|captcha-delivery|datadome|arkoselabs|funcaptcha|px-captcha|perimeterx/i.test(f.src || ''))
    || /verify (that )?you('re| are) (a )?human|are you a robot/i.test(body());

  function press(el) {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    el.click();
  }
  // Typed so React and Workday register it; set directly when the box can't take focus.
  function type(el, value) {
    el.focus({ preventScroll: true });
    if (document.activeElement === el) {
      el.select && el.select();
      document.execCommand('insertText', false, value);
    }
    if (el.value !== value) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('blur'));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }

  function look() {
    const pw = passwords();
    if (captcha()) return 'captcha';
    if (inputs().some(el => el.type !== 'password' && CODE.test(labelOf(el)))) return 'code';
    if (!pw.length && VERIFY.test(body())) return 'verify';
    if (pw.length && EXISTS.test(body())) return 'exists';
    if (pw.length >= 2) return 'create';
    if (pw.length === 1) return 'signin';
    // Oracle's email check: one email box and Next, then a code by email or the form.
    if (emails().length === 1 && inputs().filter(el => !['checkbox', 'radio'].includes(el.type)).length <= 2
        && /authentication screen|simply using your email|enter your email (address )?to (continue|get started|apply|begin)|sign in or create an account/i.test(body())) return 'email';
    if (find(GOOGLE)) return 'google';
    return 'none';
  }

  function act(a) {
    const kind = look();
    if (['captcha', 'code', 'verify', 'exists'].includes(kind)) return kind;
    const google = find(GOOGLE);
    if (a.google && google && kind !== 'create') { press(google); return 'google'; }
    if (kind === 'create') {
      if (!a.password) return 'no_account';
      emails().forEach(el => type(el, a.email));
      passwords().forEach(el => type(el, a.password));
      // Names on a sign-up form (iCIMS); nothing else is typed here.
      const [first, ...rest] = (a.name || '').split(' ');
      for (const el of inputs()) {
        if (el.value) continue;
        if (/first name|given name/i.test(labelOf(el))) type(el, first || '');
        else if (/last name|family name|surname/i.test(labelOf(el))) type(el, rest.join(' '));
      }
      // Required terms boxes only when the user agreed to terms in Profile; never sign-ups for news.
      for (const box of inputs().filter(el => el.type === 'checkbox' && !el.checked)) {
        const about = labelOf(box) + ' ' + text(box.closest('label, div'));
        const required = box.required || box.getAttribute('aria-required') === 'true' || /\*/.test(about);
        if (a.agree && required && /agree|accept|terms|privacy|consent|acknowledg/i.test(about) && !/newsletter|marketing|job alerts?|updates|offers/i.test(about)) press(box);
      }
      const button = find(CREATE_BUTTON);
      if (!button) return 'no_button';
      press(button);
      return 'created';
    }
    if (kind === 'email') {
      emails().forEach(el => type(el, a.email));
      for (const box of inputs().filter(el => el.type === 'checkbox' && !el.checked)) {
        const about = labelOf(box) + ' ' + text(box.closest('label, div'));
        if (a.agree && /agree|accept|terms|privacy|consent|acknowledg/i.test(about) && !/newsletter|marketing|job alerts?|updates|offers/i.test(about)) press(box);
      }
      const next = find(/^(next|continue|submit|get started|sign in|verify)$/i);
      if (!next) return 'no_button';
      press(next);
      return 'email_sent';
    }
    if (kind === 'signin') {
      // Without a password Apply Desk made for this site, make an account here.
      if (!a.known) {
        const link = find(CREATE_LINK);
        if (link) { press(link); return 'opened_create'; }
        return 'no_account';
      }
      emails().forEach(el => type(el, a.email));
      passwords().forEach(el => type(el, a.password));
      const button = find(SIGN_IN_BUTTON);
      if (!button) return 'no_button';
      press(button);
      return 'signed_in';
    }
    return kind;
  }

  // Google's own pages (in a pop-up or the same tab).
  function google(email) {
    const want = String(email || '').toLowerCase();
    const account = [...document.querySelectorAll('[data-identifier], [data-email]')]
      .find(el => visible(el) && (el.getAttribute('data-identifier') || el.getAttribute('data-email') || '').toLowerCase() === want);
    if (account) { press(account.closest('[role="link"], li, div') || account); return 'chose'; }
    if (passwords().length || /2-step|verify it.s you|enter your password/i.test(body())) return 'password';
    const go = find(/^(continue|allow|confirm)$/i);
    // Only sign-in: "Google will share your name, email address, ... and profile picture".
    if (go && /google will share your name, email address/i.test(body()) && !/wants (additional )?access to your google account|see, edit|read, compose|manage your/i.test(body())) {
      press(go);
      return 'continued';
    }
    if (go) return 'asks_more';
    if (find(/^use another account$/i) && !account) return 'no_account';
    return 'waiting';
  }

  window.__applyDeskAccount = { look, act, google };
})();
