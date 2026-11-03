// Apply Desk form filler, injected into the front Chrome tab by the Mac app as
//   applyDeskFill(planBase64, resumePdfBase64, resumeNameBase64)
// The plan (GET /api/fill-plan) holds only the user's own profile, saved
// answers, resume entries, and tailored skills. The filler types only into
// empty fields, never answers demographic questions, never checks consent
// boxes, and never submits. Work continues after it returns; progress and
// results are in window.__applyDeskFill.
function applyDeskFill(planB64, pdfB64, nameB64) {
  const decode = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64 || ''), c => c.charCodeAt(0)));
  const plan = JSON.parse(decode(planB64) || '{}');
  const state = window.__applyDeskFill = { done: false, filled: [], attached: false, learn: [], skipped: [], blocks: 0 };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const norm = s => (s || '').toLowerCase().replace(/[_*:?()\[\]]+/g, ' ').replace(/[-–]/g, ' ').replace(/\s+/g, ' ').trim();
  const textOf = el => el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  const visible = el => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const never = new RegExp(plan.never || 'race|ethnic|gender|veteran|disab|password', 'i');
  const handled = new Set();

  const waitFor = async (check, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const value = check();
      if (value) return value;
      await sleep(120);
    }
    return null;
  };

  // ---------- Reading the form ----------
  const byIds = ids => (ids || '').split(/\s+/).map(id => textOf(document.getElementById(id))).filter(Boolean).join(' ');
  const isDatePart = el => /dateSection/.test(el.getAttribute('data-automation-id') || '');

  // The question a control answers, as the user reads it on the page.
  function questionOf(el) {
    const legend = el.closest('fieldset') && el.closest('fieldset').querySelector('legend');
    const group = el.closest('[role="radiogroup"], [role="group"][aria-labelledby]');
    const field = el.closest('[data-automation-id^="formField"]');
    const fieldLabel = field && textOf(field.querySelector('label, legend'));
    if ((el.type === 'radio' || el.type === 'checkbox') && legend && textOf(legend)) return textOf(legend);
    if ((el.type === 'radio') && group && byIds(group.getAttribute('aria-labelledby'))) return byIds(group.getAttribute('aria-labelledby'));
    if (isDatePart(el) && fieldLabel) return fieldLabel;
    const own = [...(el.labels || [])].map(textOf).filter(Boolean).join(' ');
    if (own && el.type !== 'radio' && el.type !== 'checkbox') return own;
    const labelled = byIds(el.getAttribute('aria-labelledby'));
    if (labelled) return labelled;
    if (fieldLabel) return fieldLabel;
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const wrap = el.closest('label');
    if (wrap && textOf(wrap)) return textOf(wrap);
    // A wrapper's label counts only when the wrapper holds this one field.
    for (let node = el.parentElement, depth = 0; node && depth < 3; node = node.parentElement, depth += 1) {
      if (node.querySelectorAll('input:not([type=hidden]), select, textarea, button[aria-haspopup]').length > 1) break;
      const label = node.querySelector('label, legend, .application-label');
      if (label && textOf(label)) return textOf(label);
    }
    return own || el.placeholder || '';
  }

  // Extra hints (name, id, autocomplete) for matching, not for learning.
  const hintsOf = el => norm([questionOf(el), el.getAttribute('autocomplete'), el.name, el.id, el.placeholder,
                              el.getAttribute('data-automation-id')].filter(Boolean).join(' '));

  const isText = el => el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && ['text', 'email', 'tel', 'url', 'number', 'search', ''].includes((el.type || 'text').toLowerCase()));
  const isPrompt = el => el.tagName === 'INPUT' && (el.getAttribute('data-automation-id') === 'searchBox'
    || !!el.closest('[data-automation-id="multiselectInputContainer"]') || (el.getAttribute('role') === 'combobox' && el.getAttribute('aria-autocomplete') === 'list'));
  const isListbox = el => el.tagName === 'BUTTON' && el.getAttribute('aria-haspopup') === 'listbox';
  const placeholderText = s => /^(select( one)?|choose( one)?|please select|--.*|)$/.test(norm(s));

  // ---------- Acting like a person ----------
  function glow(el) {
    const target = el.closest('[data-automation-id^="formField"]') || el;
    const before = target.style.boxShadow;
    target.style.transition = 'box-shadow .4s ease';
    target.style.boxShadow = '0 0 0 3px rgba(16, 183, 127, .55)';
    setTimeout(() => { target.style.boxShadow = before; }, 2600);
  }

  // Typed with insertText so React, Workday, and other frameworks see real input.
  function typeInto(el, value) {
    el.focus({ preventScroll: true });
    try { el.select(); } catch (error) { /* some inputs can't select */ }
    let typed = false;
    try { typed = document.execCommand('insertText', false, value); } catch (error) { typed = false; }
    if (!typed || el.value !== value) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }

  function press(el) {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    el.click();
  }

  const openOptions = () => [...document.querySelectorAll('[role="option"], [data-automation-id="promptOption"], [data-automation-id="menuItem"]')].filter(visible);

  // Exact match first; short answers like "No" never match "North Carolina".
  function best(candidates, variants, label = c => c.getAttribute('data-automation-label') || textOf(c)) {
    const texts = candidates.map(c => [c, norm(label(c))]);
    for (const variant of variants.map(norm).filter(Boolean)) {
      const short = variant.length <= 3;
      const hit = texts.find(([, t]) => t === variant)
        || texts.find(([, t]) => t.startsWith(variant + ' ') || t.startsWith(variant + ','))
        || (!short && texts.find(([, t]) => t.startsWith(variant)))
        || (!short && texts.find(([, t]) => t.includes(variant)))
        || (!short && texts.find(([, t]) => t.length > 3 && variant.startsWith(t)));
      if (hit) return hit[0];
    }
    // Last resort for longer answers: most shared words ("Career Center/Campus
    // Posting" → "University Career Center"), never for Yes/No.
    const words = t => new Set(t.split(/[^a-z0-9+#]+/).filter(w => w.length > 2));
    let top = null, score = 0;
    for (const variant of variants.map(norm).filter(v => v.length > 3)) {
      const want = words(variant);
      for (const [candidate, t] of texts) {
        const have = words(t);
        const shared = [...want].filter(w => have.has(w)).length;
        const ratio = shared / Math.max(1, Math.min(want.size, have.size));
        if (shared >= 2 && ratio >= 0.6 && ratio > score) { top = candidate; score = ratio; }
      }
    }
    return top;
  }

  function note(el, question) {
    handled.add(el);
    state.filled.push(norm(question).slice(0, 60));
    glow(el);
  }

  async function pickListbox(button, variants, question) {
    if (!placeholderText(textOf(button))) return false;
    press(button);
    const options = await waitFor(() => { const o = openOptions(); return o.length ? o : null; }, 2500);
    const match = options && best(options, variants);
    if (match) {
      press(match);
      await sleep(350);
      note(button, question);
      return true;
    }
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    await sleep(200);
    return false;
  }

  const selectedPills = el => {
    const field = el.closest('[data-automation-id^="formField"], [data-automation-id="multiselectInputContainer"]') || el.parentElement;
    return [...field.querySelectorAll('[data-automation-id="selectedItem"], [data-automation-id="selectedItemList"] [role="option"], .selected-pill')]
      .map(textOf).filter(Boolean);
  };

  async function pickPrompt(input, variants, question) {
    for (const variant of variants.slice(0, 3)) {
      typeInto(input, variant);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      const options = await waitFor(() => { const o = openOptions(); return o.length ? o : null; }, 2500);
      const match = options && best(options, [variant, ...variants]);
      if (match) {
        press(match);
        await sleep(450);
        note(input, question);
        return true;
      }
      typeInto(input, '');
    }
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    return false;
  }

  function pickSelect(select, variants, question) {
    const options = [...select.options].filter(o => !placeholderText(o.textContent) && o.value !== '');
    const match = best(options, variants, o => o.textContent);
    if (!match) return false;
    select.value = match.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    note(select, question);
    return true;
  }

  function pickRadio(radios, variants, question) {
    const match = best(radios, variants, r => textOf(r.labels && r.labels[0]) || r.getAttribute('aria-label') || r.value);
    if (!match) return false;
    press(match);
    note(match, question);
    return true;
  }

  // ---------- Dates ----------
  function datePartsNear(el) {
    const field = el.closest('[data-automation-id^="formField"], [data-automation-id="dateInputWrapper"]') || el.parentElement;
    const part = name => field.querySelector(`input[data-automation-id*="dateSection${name}"]`);
    return { month: part('Month'), day: part('Day'), year: part('Year') };
  }

  function fillDate(el, formats, question) {
    if (!formats || !formats.year) return false;
    if (isDatePart(el)) {
      const parts = datePartsNear(el);
      let any = false;
      for (const [name, value] of [['month', formats.month], ['day', formats.day], ['year', formats.year]]) {
        if (parts[name] && !parts[name].value && value) { typeInto(parts[name], value); handled.add(parts[name]); any = true; }
      }
      if (any) note(el, question);
      return any;
    }
    const type = (el.type || '').toLowerCase();
    const shape = norm(el.placeholder || el.getAttribute('aria-label') || '');
    const value = type === 'date' ? formats.iso : type === 'month' ? formats.iso_month
      : /mm dd yyyy|mm\/dd\/yyyy|dd/.test(shape) ? formats.mm_dd_yyyy
      : /mm yyyy|mm\/yyyy/.test(shape) ? formats.mm_yyyy
      : /^yyyy$|year/.test(shape) ? formats.year : formats.mm_dd_yyyy;
    if (type === 'date' || type === 'month') {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      typeInto(el, value);
    }
    note(el, question);
    return true;
  }

  // ---------- What to put in a field ----------
  const p = plan.profile || {};
  const parts = (p.name || '').trim().split(/\s+/);
  const contact = [
    ['email', /e ?mail/, [p.email]], ['phone', /phone number|^phone$|mobile|cell(ular)? number|telephone/, [p.phone]],
    ['linkedin', /linkedin/, [p.linkedin]], ['github', /github/, [p.github]],
    ['website', /website|portfolio|personal (site|url|page)/, [p.website]], ['first', /first name|given name|preferred name|^first$/, [parts[0]]],
    ['last', /last name|family name|surname|^last$/, [parts.length > 1 ? parts.slice(1).join(' ') : '']],
    ['name', /full name|your name|legal name|^name$/, [p.name]], ['address', /address line 1|street address|address 1|^address$/, [p.address]],
    ['city', /(^| )city( |$)|town/, [p.city]], ['state', /(^| )state( |$)|province|region/, p.state_options || [p.state]],
    ['postal', /zip|postal code|postcode/, [p.postal_code]], ['school', /school|university|college|institution/, [p.school]],
    ['degree', /degree/, [p.degree, ...(((plan.education || [])[0] || {}).degree_options || [])]],
  ];
  const otherPeople = /reference|emergency|supervisor|manager|guardian|parent|spouse|high school|extension|referr(al|er|ed) (name|email|by)/;
  const startDate = /(start|availability|available) date|when can you (start|begin)|earliest (start|date)|proposed start|date (you are )?available/;
  const graduationDate = /when (will|do) you (expect to )?graduate|graduation date|(expected|anticipated|projected) graduation|graduation (month|year|term)|date of graduation|completion date/;
  const consent = /agree|certif|acknowledg|consent|terms|attest|privacy|i understand|authori[sz]e (us|the company|.* to contact)/;
  const tokens = s => new Set(norm(s).split(' ').filter(w => w.length > 2));
  const similar = (a, b) => {
    const x = tokens(a), y = tokens(b);
    if (!x.size || !y.size) return 0;
    let same = 0;
    for (const w of x) if (y.has(w)) same += 1;
    return same / Math.max(x.size, y.size);
  };

  // Returns {values, date} for a field, or null to leave it alone.
  function wanted(el, question) {
    const q = norm(question);
    if (!q || never.test(q)) return null;
    if (el.tagName !== 'TEXTAREA' && startDate.test(q)) return { date: plan.start, source: 'date' };
    if (el.tagName !== 'TEXTAREA' && graduationDate.test(q)) {
      const dated = p.graduation_dates || {};
      return el.tagName === 'SELECT' || isListbox(el) ? { values: [dated.year, p.graduation], source: 'date' } : { date: dated, source: 'date' };
    }
    for (const answer of plan.answers || []) {
      if (new RegExp(answer.pattern, 'i').test(q)) return { values: answer.options.length ? answer.options : [answer.answer], source: 'answer' };
    }
    for (const learned of plan.learned || []) {
      if (norm(learned.question) === q || similar(learned.question, q) >= 0.8) return { values: learned.answer.split(/;\s*/), source: 'learned' };
    }
    if (otherPeople.test(q) || /\bwhy\b|describe|statement|cover letter|tell us|explain/.test(q)) return null;
    const hints = el.closest ? hintsOf(el) : q;
    for (const [, pattern, values] of contact) {
      if (pattern.test(q) || pattern.test(hints)) {
        const usable = values.filter(Boolean);
        return usable.length ? { values: usable, source: 'profile' } : null;
      }
    }
    return null;
  }

  async function fillControl(el, question, want) {
    if (!want) return false;
    if (want.date) return fillDate(el, want.date, question);
    const values = want.values.filter(Boolean);
    if (!values.length) return false;
    if (el.tagName === 'SELECT') return pickSelect(el, values, question);
    if (isListbox(el)) return pickListbox(el, values, question);
    if (isPrompt(el)) return selectedPills(el).length ? false : pickPrompt(el, values, question);
    if (isText(el) && !el.value.trim()) {
      typeInto(el, values[0]);
      note(el, question);
      return true;
    }
    return false;
  }

  // ---------- Work experience and education blocks ----------
  const controlsIn = root => [...root.querySelectorAll('input:not([type=hidden]):not([type=file]), select, textarea, button[aria-haspopup="listbox"]')]
    .filter(el => visible(el) && !el.disabled && !el.readOnly);

  function sectionFor(pattern) {
    const heads = [...document.querySelectorAll('h1, h2, h3, h4, h5, legend, [role="heading"], [data-automation-id$="Header"]')]
      .filter(h => visible(h) && pattern.test(norm(textOf(h))));
    for (const head of heads) {
      for (let node = head.parentElement; node && node !== document.body; node = node.parentElement) {
        if (controlsIn(node).length || [...node.querySelectorAll('button')].some(b => /^add/i.test(textOf(b) || b.getAttribute('aria-label') || ''))) return node;
      }
    }
    return null;
  }

  function blocksIn(section, firstField, secondField) {
    const blocks = [];
    for (const el of controlsIn(section)) {
      if (!firstField.test(norm(questionOf(el)))) continue;
      let block = el.parentElement;
      while (block && block !== section && !controlsIn(block).some(other => other !== el && secondField.test(norm(questionOf(other))))) block = block.parentElement;
      if (block && !blocks.includes(block)) blocks.push(block);
    }
    return blocks;
  }

  const addButton = section => [...section.querySelectorAll('button, [role="button"]')]
    .filter(visible).find(b => /^(\+\s*)?add( another)?\b/i.test(textOf(b) || b.getAttribute('aria-label') || ''));

  async function fillBlocks(kind, entries) {
    if (!entries || !entries.length) return;
    const first = kind === 'experience' ? /job title|position title|^title$|role title/ : /school|university|college|institution/;
    const second = kind === 'experience' ? /company|employer|organization/ : /degree|field of study|major/;
    const section = sectionFor(kind === 'experience' ? /^(work )?experience|^employment( history)?|^work history/ : /^education/);
    if (!section) return;
    let blocks = blocksIn(section, first, second);
    for (let guard = 0; blocks.length < entries.length && guard <= entries.length; guard += 1) {
      const add = addButton(section);
      if (!add) break;
      const before = blocks.length;
      press(add);
      await waitFor(() => blocksIn(section, first, second).length > before, 3000);
      blocks = blocksIn(section, first, second);
    }
    for (let i = 0; i < Math.min(blocks.length, entries.length); i += 1) {
      const entry = entries[i];
      for (const el of controlsIn(blocks[i])) {
        if (handled.has(el)) continue;
        const q = norm(questionOf(el));
        let want = null;
        if (kind === 'experience') {
          if (el.type === 'checkbox') {
            if (/current/.test(q) && entry.current && !el.checked) { press(el); note(el, q); }
            handled.add(el);
            continue;
          }
          want = /job title|position|^title$|role title/.test(q) ? { values: [entry.title] }
            : /company|employer|organization/.test(q) ? { values: [entry.company] }
            : /location|city/.test(q) ? { values: [entry.location] }
            : /^from|start/.test(q) ? { date: entry.start }
            : /^to\b|^to$|end/.test(q) ? (entry.current ? null : { date: entry.end })
            : el.tagName === 'TEXTAREA' || /description|responsibilit|summary|duties/.test(q) ? { values: [entry.description] } : null;
        } else {
          want = /school|university|college|institution/.test(q) ? { values: [entry.school] }
            : /degree/.test(q) ? { values: entry.degree_options.length ? entry.degree_options : [entry.degree] }
            : /field of study|major|discipline/.test(q) ? { values: [entry.field] }
            : /gpa|grade|overall result/.test(q) ? { values: [entry.gpa] }
            : /^from|start/.test(q) ? { date: entry.start }
            : /^to\b|^to$|end|graduat|expected/.test(q) ? { date: entry.end } : null;
        }
        handled.add(el);
        if (want && (want.date ? want.date && want.date.year : want.values.some(Boolean))) {
          const isEmpty = el.tagName === 'SELECT' ? el.selectedIndex <= 0 : isListbox(el) ? placeholderText(textOf(el)) : !el.value;
          if (isEmpty || isDatePart(el)) await fillControl(el, q, want);
        }
      }
      for (const el of controlsIn(blocks[i])) handled.add(el);
      state.blocks += 1;
    }
    for (const el of controlsIn(section)) handled.add(el);
  }

  // ---------- Skills ----------
  async function fillSkills() {
    const input = controlsIn(document).find(el => isPrompt(el) && /skill/.test(norm(questionOf(el))));
    if (!input || !(plan.skills || []).length) return;
    handled.add(input);
    const have = selectedPills(input).map(norm);
    let added = 0;
    for (const skill of plan.skills) {
      if (have.includes(norm(skill)) || added >= 10) continue;
      typeInto(input, skill);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      const options = await waitFor(() => { const o = openOptions(); return o.length ? o : null; }, 2500);
      const match = options && best(options, [skill]);
      if (match && norm(textOf(match)).startsWith(norm(skill).slice(0, 3))) {
        press(match);
        added += 1;
        await sleep(450);
      } else {
        typeInto(input, '');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
        await sleep(150);
      }
    }
    if (added) { state.filled.push(`skills (${added})`); glow(input); }
  }

  // ---------- Remembering what the user typed ----------
  // Learns only answers Apply Desk couldn't give itself: not profile fields,
  // standard answers, dates (they change per role), or consent boxes.
  const pseudo = { tagName: 'INPUT' };  // a question without a field, for learning checks
  function remember(question, answer) {
    const q = (question || '').trim();
    const a = (answer || '').trim();
    const n = norm(q);
    if (!q || !a || never.test(n) || consent.test(n) || startDate.test(n) || graduationDate.test(n) || a.length > 160 || placeholderText(a)) return;
    if (/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$|^\d{4}(-\d{2}){0,2}$/.test(a)) return;
    const known = wanted(pseudo, q);
    if (known && known.source !== 'learned') return;
    if (!state.learn.some(item => norm(item.question) === n)) state.learn.push({ question: q.slice(0, 300), answer: a });
  }

  function answeredValue(el) {
    if (el.tagName === 'SELECT') return el.selectedIndex > 0 ? el.options[el.selectedIndex].textContent.trim() : '';
    if (isListbox(el)) return placeholderText(textOf(el)) ? '' : textOf(el);
    if (isPrompt(el)) return selectedPills(el).join('; ');
    if (isText(el) && el.tagName !== 'TEXTAREA') return el.value;
    return '';
  }

  // Answers typed on earlier pages of this application (e.g. Workday steps).
  if (!window.__applyDeskListening) {
    window.__applyDeskListening = true;
    document.addEventListener('change', event => {
      const el = event.target;
      // Ignore everything while Apply Desk is filling: the browser marks the
      // change events its typing causes as trusted too.
      if (window.__applyDeskBusy || !event.isTrusted || !el || !el.closest || el.type === 'file' || el.type === 'password') return;
      try {
        const seen = JSON.parse(sessionStorage.getItem('applyDeskSeen') || '{}');
        const value = el.type === 'radio' ? (el.checked ? textOf(el.labels && el.labels[0]) : '')
          : el.type === 'checkbox' ? [...document.querySelectorAll(`input[type=checkbox]`)].filter(box => box.checked && questionOf(box) === questionOf(el)).map(box => textOf(box.labels && box.labels[0])).join('; ')
          : answeredValue(el);
        if (value) seen[questionOf(el).slice(0, 300)] = value;
        sessionStorage.setItem('applyDeskSeen', JSON.stringify(seen));
      } catch (error) { /* storage can be blocked */ }
    }, true);
  }

  // ---------- Resume upload ----------
  function attachResume() {
    if (!pdfB64) return;
    const uploads = [...document.querySelectorAll('input[type=file]')].filter(i => !i.disabled && !(i.files && i.files.length));
    const other = /cover|transcript|portfolio|writing sample|photo|headshot/;
    const named = i => hintsOf(i);
    const target = uploads.find(i => /resume|(^| )cv( |$)|curriculum/.test(named(i)) && !other.test(named(i)))
      || (uploads.length === 1 && !other.test(named(uploads[0])) ? uploads[0] : null);
    if (!target || (target.accept && !/pdf|application\/|\*/.test(target.accept))) return;
    const files = new DataTransfer();
    files.items.add(new File([Uint8Array.from(atob(pdfB64), c => c.charCodeAt(0))], decode(nameB64) || 'Resume.pdf', { type: 'application/pdf' }));
    target.files = files.files;
    for (const type of ['input', 'change']) target.dispatchEvent(new Event(type, { bubbles: true }));
    state.attached = true;
  }

  // ---------- Run ----------
  (async () => {
    window.__applyDeskBusy = true;
    try {
      attachResume();
      await fillBlocks('experience', plan.experience);
      await fillBlocks('education', plan.education);
      await fillSkills();
      const all = controlsIn(document);
      const radios = {};
      const boxes = {};
      for (const el of all) {
        if (handled.has(el)) continue;
        const question = questionOf(el);
        if (el.type === 'radio') {
          (radios[el.name || question] = radios[el.name || question] || []).push(el);
          continue;
        }
        if (el.type === 'checkbox') {
          (boxes[question] = boxes[question] || []).push(el);
          continue;
        }
        const value = answeredValue(el);
        if (value) { remember(question, value); continue; }
        await fillControl(el, question, wanted(el, question));
      }
      for (const group of Object.values(radios)) {
        const question = questionOf(group[0]);
        const checked = group.find(r => r.checked);
        if (checked) { remember(question, textOf(checked.labels && checked.labels[0]) || checked.value); continue; }
        const want = wanted(group[0], question);
        if (want && want.values) pickRadio(group, want.values, question);
      }
      for (const [question, group] of Object.entries(boxes)) {
        // A lone box is usually consent ("I agree…"); only groups are preferences.
        const label = box => textOf(box.labels && box.labels[0]) || box.getAttribute('aria-label') || '';
        if (group.length < 2 || consent.test(norm(question)) || group.some(box => consent.test(norm(label(box))))) continue;
        const checked = group.filter(box => box.checked);
        if (checked.length) { remember(question, checked.map(label).join('; ')); continue; }
        const want = wanted(group[0], question);
        if (!want || want.source !== 'learned') continue;
        let any = false;
        for (const value of want.values) {
          const match = best(group, [value], label);
          if (match && !match.checked) { press(match); any = true; }
        }
        if (any) note(group[0], question);
      }
      try {
        for (const [question, answer] of Object.entries(JSON.parse(sessionStorage.getItem('applyDeskSeen') || '{}'))) remember(question, answer);
      } catch (error) { /* storage can be blocked */ }
      if (!state.filled.length && !state.attached) {
        const frame = [...document.querySelectorAll('iframe')].find(f => /greenhouse|lever|ashby|workday|smartrecruiters|icims|jobvite/.test(f.src || ''));
        state.embedded = frame ? frame.src : '';
      }
    } catch (error) {
      state.error = String(error && error.message || error);
    }
    // Commit the last typed field while still busy, so its change isn't learned.
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    await sleep(50);
    window.__applyDeskBusy = false;
    state.done = true;
  })();
  return JSON.stringify({ started: true });
}
