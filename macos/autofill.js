// Apply Desk form filler, injected into the front Chrome tab by the Mac app as
//   applyDeskFill(planBase64, resumePdfBase64, resumeNameBase64)
// The plan (GET /api/fill-plan) holds only the user's own profile, saved
// answers, resume entries, and tailored skills. The filler types only into
// empty fields, never answers demographic questions, never checks consent
// boxes, and never submits. Work continues after it returns; progress and
// results are in window.__applyDeskFill.
function applyDeskFill(planB64, pdfB64, nameB64) {
  const decode = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64 || ''), c => c.charCodeAt(0)));
  if (window.__applyDeskBusy && window.__applyDeskFill && !window.__applyDeskFill.done) return JSON.stringify({ started: true, already: true });
  const plan = JSON.parse(decode(planB64) || '{}');
  const state = window.__applyDeskFill = { done: false, filled: [], attached: false, learn: [], skipped: [], blocks: 0 };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const norm = s => (s || '').toLowerCase().replace(/&/g, ' and ').replace(/[_*:?()\[\]]+/g, ' ').replace(/[-–]/g, ' ').replace(/\s+/g, ' ').trim();
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

  // ---------- Choosing from lists ----------
  // Pop-up lists (Workday and others) are often still on the page after they
  // close, or another list is open. Every pick closes stale lists first, reads
  // only the options that appeared for this field once they stop changing,
  // and checks the choice took before moving on.
  const optionSelector = '[role="option"], [data-automation-id="promptOption"], [data-automation-id="menuItem"]';
  const shown = el => visible(el) && !el.closest('[aria-hidden="true"]') && el.getBoundingClientRect().width > 0;
  // The innermost element of each option, which is the one that takes clicks.
  const openOptions = (root = document) => [...root.querySelectorAll(optionSelector)].filter(o => shown(o) && !o.querySelector(optionSelector));
  const optionLabel = o => o.getAttribute('data-automation-label') || textOf(o);
  const escape = el => el && el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));

  async function closeLists(trigger) {
    if (!openOptions().length) return;
    escape(document.activeElement);
    if (await waitFor(() => !openOptions().length, 500)) return;
    if (trigger && trigger.getAttribute('aria-expanded') === 'true') press(trigger);
    else press(document.body);
    await waitFor(() => !openOptions().length, 600);
  }

  // Options shown for `trigger` that weren't on the page before it opened,
  // once they've stayed the same for a moment (searches load in steps). When
  // several lists are showing, the one nearest the field is its own. An empty
  // result ("No Items.") in a new list comes back as no options right away.
  const listSelector = '[role="listbox"], [data-automation-id="activeListContainer"], [role="menu"]';
  const nearest = (trigger, options) => {
    const groups = new Map();
    for (const option of options) {
      const list = option.closest(listSelector) || option.parentElement;
      groups.set(list, [...(groups.get(list) || []), option]);
    }
    if (groups.size < 2) return options;
    const at = trigger.getBoundingClientRect();
    const distance = list => { const r = list.getBoundingClientRect(); return Math.min(Math.abs(r.top - at.bottom), Math.abs(r.bottom - at.top)); };
    return [...groups.entries()].sort((a, b) => distance(a[0]) - distance(b[0]))[0][1];
  };
  async function freshOptions(trigger, before, changedFrom = null, ms = 3500) {
    const started = Date.now();
    const oldLists = new Set(document.querySelectorAll(listSelector));
    const noResults = () => [...document.querySelectorAll(listSelector)]
      .some(list => !oldLists.has(list) && shown(list) && !openOptions(list).length && /^no (items|results|matches)|^nothing found/i.test(textOf(list)));
    let last = null, same = 0;
    const found = await waitFor(() => {
      const id = trigger.getAttribute('aria-controls') || trigger.getAttribute('aria-owns');
      const own = id && document.getElementById(id);
      const options = own && shown(own) && openOptions(own).length ? openOptions(own).filter(o => !before.has(o))
        : nearest(trigger, openOptions().filter(o => !before.has(o)));
      const key = options.length ? options.map(optionLabel).join('|') : (noResults() ? 'none' : '');
      same = key && key === last ? same + 1 : 0;
      last = key;
      if (same < 1 || (changedFrom !== null && key === changedFrom && Date.now() - started < 1500)) return null;
      return { options };
    }, ms);
    return found && found.options.length ? found.options : null;
  }

  // Exact match first; short answers like "No" never match "North Carolina".
  // Strict matching (schools, majors, states) also refuses a longer, different
  // name: "Computer Science" never picks "Computer Science and Engineering
  // Technology", "Virginia" never picks "West Virginia".
  function best(candidates, variants, label = optionLabel, strict = false) {
    const texts = candidates.map(c => [c, norm(label(c))]);
    const shortest = hits => hits.sort((a, b) => a[1].length - b[1].length)[0];
    for (const variant of variants.map(norm).filter(Boolean)) {
      const short = variant.length <= 3;
      const exact = texts.find(([, t]) => t === variant);
      if (exact) return exact[0];
      const led = texts.filter(([, t]) => t.startsWith(variant + ' ') || t.startsWith(variant + ','));
      if (strict) {
        const close = shortest(led.filter(([, t]) => t.length <= variant.length * 1.6));
        if (close) return close[0];
        continue;
      }
      const hit = shortest(led)
        || (!short && shortest(texts.filter(([, t]) => t.startsWith(variant))))
        || (!short && texts.find(([, t]) => t.includes(variant)))
        || (!short && texts.find(([, t]) => t.length > 3 && variant.startsWith(t)));
      if (hit) return hit[0];
    }
    if (strict) return null;
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

  // Long lists may only draw the options near the top; scroll to find more.
  async function scrollFor(options, variants, strict) {
    let box = options[0] && options[0].parentElement;
    while (box && box !== document.body && box.scrollHeight <= box.clientHeight + 4) box = box.parentElement;
    if (!box || box === document.body) return null;
    for (let y = box.clientHeight * 0.8; y < box.scrollHeight; y += box.clientHeight * 0.8) {
      box.scrollTop = y;
      await sleep(140);
      const match = best(openOptions(), variants, optionLabel, strict);
      if (match) return match;
    }
    return null;
  }

  async function pickListbox(button, want, question) {
    if (!placeholderText(textOf(button))) return false;
    await closeLists();
    const before = new Set(openOptions());
    press(button);
    const options = await freshOptions(button, before);
    let match = options && (best(options, want.values, optionLabel, want.strict) || (options.length > 7 && await scrollFor(options, want.values, want.strict)));
    if (match) {
      // A click normally chooses; some lists only take Enter on the option.
      for (const attempt of [() => press(match), () => press(match.querySelector('div, span') || match),
                             () => { match.focus(); match.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); }]) {
        if (!match.isConnected) break;
        attempt();
        if (await waitFor(() => !placeholderText(textOf(button)), 1200)) {
          await closeLists(button);
          note(button, question);
          return true;
        }
      }
    }
    await closeLists(button);
    return !placeholderText(textOf(button));
  }

  const selectedPills = el => {
    const field = el.closest('[data-automation-id^="formField"], [data-automation-id="multiselectInputContainer"]') || el.parentElement;
    return [...field.querySelectorAll('[data-automation-id="selectedItem"], [data-automation-id="selectedItemList"] [role="option"], .selected-pill')]
      .map(textOf).filter(Boolean);
  };

  // Type-to-search boxes (Workday prompts, comboboxes). Lists can be nested:
  // choosing a category ("University") shows its own options next.
  async function pickPrompt(input, want, question) {
    const field = input.closest('[data-automation-id^="formField"]') || input.parentElement;
    const chosen = (count, label) => selectedPills(input).length > count || (!!label && norm(textOf(field)).includes(norm(label)));
    await closeLists();
    const before = new Set(openOptions());
    const choose = async options => {
      for (let depth = 0; options && depth < 3; depth += 1) {
        let match = best(options, want.values, optionLabel, want.strict);
        // Inside a category the user didn't name, any option there is relevant.
        if (!match && want.browse && depth > 0) match = best(options, ['Other']) || options[0];
        if (!match) return false;
        const count = selectedPills(input).length, label = optionLabel(match), key = options.map(optionLabel).join('|');
        press(match);
        if (await waitFor(() => chosen(count, label), 900)) return true;
        options = await freshOptions(input, before, key, 1800);
        if (!options || options.map(optionLabel).join('|') === key) return chosen(count, label);
      }
      return false;
    };
    const searches = (want.search || want.values).filter(Boolean).slice(0, 4);
    let previous = null;
    for (const term of searches) {
      typeInto(input, term);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      const options = await freshOptions(input, before, previous, 2500);
      previous = options ? options.map(optionLabel).join('|') : previous;
      if (await choose(options)) {
        await closeLists(input);
        note(input, question);
        return true;
      }
      typeInto(input, '');
    }
    if (want.browse) {
      // No search hit: open the whole list and pick the most relevant entry.
      press(input);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      if (await choose(await freshOptions(input, before, null, 2500))) {
        await closeLists(input);
        note(input, question);
        return true;
      }
    }
    await closeLists(input);
    return false;
  }

  function pickSelect(select, variants, question, strict = false) {
    const options = [...select.options].filter(o => !placeholderText(o.textContent) && o.value !== '');
    const match = best(options, variants, o => o.textContent, strict);
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
  const school = (plan.education || [])[0] || {};
  const schoolNames = school.school_options && school.school_options.length ? school.school_options : [p.school];
  // Search by the official name, the user's own, then its first two words.
  const schoolSearch = names => [names[0], names[names.length - 1], (names[0] || '').split(' ').slice(0, 2).join(' ')];
  const contact = [
    ['email', /e ?mail/, [p.email]], ['phone', /phone number|^phone$|mobile|cell(ular)? number|telephone/, [p.phone]],
    ['linkedin', /linkedin/, [p.linkedin]], ['github', /github/, [p.github]],
    ['website', /website|portfolio|personal (site|url|page)/, [p.website]], ['first', /first name|given name|preferred name|^first$/, [parts[0]]],
    ['last', /last name|family name|surname|^last$/, [parts.length > 1 ? parts.slice(1).join(' ') : '']],
    ['name', /full name|your name|legal name|^name$/, [p.name]], ['address', /address line 1|street address|address 1|^address$/, [p.address]],
    ['city', /(^| )city( |$)|town/, [p.city]], ['state', /(^| )state( |$)|province|region/, p.state_options || [p.state], { strict: true }],
    ['postal', /zip|postal code|postcode/, [p.postal_code]],
    ['school', /school|university|college|institution/, schoolNames, { strict: true, search: schoolSearch(schoolNames) }],
    ['field', /field of study|area of study|(^| )major( |$)|academic discipline/, school.field_options || [], { strict: true, search: [school.field] }],
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
      if (!new RegExp(answer.pattern, 'i').test(q)) continue;
      // An unanswered standard question is the user's to answer.
      if (!answer.answer) return null;
      return { values: answer.options.length ? answer.options : [answer.answer], source: 'answer', browse: answer.key === 'heard_about' };
    }
    for (const learned of plan.learned || []) {
      if (norm(learned.question) === q || similar(learned.question, q) >= 0.8) return { values: learned.answer.split(/;\s*/), source: 'learned' };
    }
    if (otherPeople.test(q) || /\bwhy\b|describe|statement|cover letter|tell us|explain/.test(q)) return null;
    const hints = el.closest ? hintsOf(el) : q;
    for (const [, pattern, values, how] of contact) {
      if (pattern.test(q) || pattern.test(hints)) {
        const usable = values.filter(Boolean);
        return usable.length ? { ...how, values: usable, source: 'profile' } : null;
      }
    }
    return null;
  }

  async function fillControl(el, question, want) {
    if (!want) return false;
    if (want.date) return fillDate(el, want.date, question);
    const values = want.values.filter(Boolean);
    if (!values.length) return false;
    if (el.tagName === 'SELECT') return pickSelect(el, values, question, want.strict);
    if (isListbox(el)) return pickListbox(el, { ...want, values }, question);
    if (isPrompt(el)) return selectedPills(el).length ? false : pickPrompt(el, { ...want, values }, question);
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
          const names = entry.school_options && entry.school_options.length ? entry.school_options : [entry.school];
          want = /school|university|college|institution/.test(q) ? { values: names, strict: true, search: schoolSearch(names) }
            : /degree/.test(q) ? { values: entry.degree_options.length ? entry.degree_options : [entry.degree] }
            : /field of study|major|discipline/.test(q) ? { values: entry.field_options && entry.field_options.length ? entry.field_options : [entry.field], strict: true, search: [entry.field] }
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
    await closeLists();
    const before = new Set(openOptions());
    let added = 0, previous = null;
    for (const skill of plan.skills) {
      if (have.includes(norm(skill)) || added >= 10) continue;
      typeInto(input, skill);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      const options = await freshOptions(input, before, previous, 2500);
      previous = options ? options.map(optionLabel).join('|') : previous;
      const match = options && best(options, [skill]);
      const count = selectedPills(input).length;
      if (match && norm(optionLabel(match)).startsWith(norm(skill).slice(0, 3))) {
        press(match);
        if (await waitFor(() => selectedPills(input).length > count, 1200)) added += 1;
      }
      typeInto(input, '');
    }
    await closeLists(input);
    if (added) { state.filled.push(`skills (${added})`); glow(input); }
  }

  // ---------- Remembering what the user typed ----------
  // Learns only answers Apply Desk couldn't give itself: not profile fields,
  // standard answers, dates (they change per role), or consent boxes.
  const pseudo = { tagName: 'INPUT' };  // a question without a field, for learning checks
  // Fields of one job or school entry come from the resume, not from memory.
  const entryField = /^(job title|position title|title|company|employer|organization|location|from|to|role description|description|school or university|school|university|degree|field of study|major|overall result gpa|gpa|skills?|type to add skills)$/;
  function remember(question, answer) {
    const q = (question || '').trim();
    const a = (answer || '').trim();
    const n = norm(q);
    if (!q || !a || never.test(n) || consent.test(n) || startDate.test(n) || graduationDate.test(n) || entryField.test(n) || a.length > 160 || placeholderText(a)) return;
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
    // Pop-up lists and search boxes fire no change event: after the user
    // clicks, note what each one now shows.
    let pending = null;
    document.addEventListener('click', event => {
      if (window.__applyDeskBusy || !event.isTrusted) return;
      clearTimeout(pending);
      pending = setTimeout(() => {
        if (window.__applyDeskBusy) return;
        try {
          const seen = JSON.parse(sessionStorage.getItem('applyDeskSeen') || '{}');
          for (const el of document.querySelectorAll('button[aria-haspopup="listbox"], input[data-automation-id="searchBox"]')) {
            const value = visible(el) ? answeredValue(el) : '';
            if (value) seen[questionOf(el).slice(0, 300)] = value;
          }
          sessionStorage.setItem('applyDeskSeen', JSON.stringify(seen));
        } catch (error) { /* storage can be blocked */ }
      }, 600);
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
      await closeLists();
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
