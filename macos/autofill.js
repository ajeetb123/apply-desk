// Apply Desk form filler, injected into the front Chrome tab by the Mac app as
//   applyDeskFill(planBase64, resumePdfBase64, resumeNameBase64)
// The plan (GET /api/fill-plan) holds only the user's own profile, saved
// answers, resume entries, and tailored skills. The filler types only into
// empty fields (job and school entries Workday read from the resume itself
// get the resume's exact text instead), answers self-identification questions only as the user chose
// in Profile (or with the form's decline option), never checks consent boxes,
// and never submits. On multi-step applications (Workday) it fills a page,
// clicks Save and Continue, and repeats until a page needs the user or the
// Review step, where it shows a review panel. Work continues after it
// returns; progress and results are in window.__applyDeskFill.
function applyDeskFill(planB64, pdfB64, nameB64) {
  const decode = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64 || ''), c => c.charCodeAt(0)));
  if (window.__applyDeskBusy && window.__applyDeskFill && !window.__applyDeskFill.done) return JSON.stringify({ started: true, already: true });
  const plan = JSON.parse(decode(planB64) || '{}');
  const state = window.__applyDeskFill = { done: false, filled: [], attached: false, learn: [], skipped: [], blocks: 0, beat: 0, stop: '', page: '', needs: [] };
  // One application can span many pages and reloads; its progress is kept in
  // this tab so the review covers every page, even after a stop.
  let run = null;
  try { run = JSON.parse(sessionStorage.getItem('applyDeskRun') || 'null'); } catch (error) { run = null; }
  const roleId = plan.role ? plan.role.id : null;
  if (!run || run.role !== roleId || Date.now() - (run.updated || 0) > 3 * 3600e3) {
    run = { id: String(Date.now()), role: roleId, items: [], pages: [], learn: [], attached: false };
  }
  run.wrote = run.wrote || {};  // entry fields this run typed: what's there now is ours or the user's edit
  Object.assign(state, { run: run.id, items: run.items, pages: run.pages, learn: run.learn, attached: run.attached });
  const saveRun = () => {
    run.attached = state.attached;
    run.updated = Date.now();
    try { sessionStorage.setItem('applyDeskRun', JSON.stringify(run)); } catch (error) { /* storage can be blocked */ }
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const norm = s => (s || '').toLowerCase().replace(/&/g, ' and ').replace(/[_*:?()\[\]]+/g, ' ').replace(/[-–]/g, ' ').replace(/\s+/g, ' ').trim();
  const textOf = el => el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
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

  // A search box: type the query and press Enter, the way a person searches
  // (Workday searches on Enter). No blur, which would clear the query first.
  function search(el, value) {
    el.focus({ preventScroll: true });
    try { el.select(); } catch (error) { /* some inputs can't select */ }
    let typed = false;
    try { typed = document.execCommand('insertText', false, value); } catch (error) { typed = false; }
    if (!typed || el.value !== value) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (value) pressEnter(el);
  }

  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      const event = new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: type === 'keypress' ? 13 : 0, bubbles: true, cancelable: true });
      // Older handlers read keyCode/which, which some browsers don't take from the options.
      for (const name of ['keyCode', 'which']) if (event[name] !== 13) Object.defineProperty(event, name, { get: () => 13 });
      el.dispatchEvent(event);
    }
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
  // Chosen values show as tags (Workday's "selectedItem") built like options; they never are.
  const chosenTag = '[data-automation-id="selectedItemList"], [data-automation-id="selectedItem"], .selected-pill';
  const openOptions = (root = document) => [...root.querySelectorAll(optionSelector)].filter(o => shown(o) && !o.querySelector(optionSelector) && !o.closest(chosenTag));
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
      // Prefix mode: options that begin with the answer ("Asian (Not Hispanic
      // or Latino)"), never ones that merely contain it ("Female" for "Male").
      if (strict === 'prefix') {
        const hit = shortest(led) || (!short && shortest(texts.filter(([, t]) => t.startsWith(variant))));
        if (hit) return hit[0];
        continue;
      }
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

  let current = null;     // the answer being filled, so the review can say where it came from
  let pageNow = '';
  function note(el, question, value = '') {
    handled.add(el);
    state.filled.push(norm(question).slice(0, 60));
    const shown = String(value || '').replace(/\s+/g, ' ').trim();
    state.items.push({ page: pageNow, question: String(question).replace(/\*\s*$/, '').trim().slice(0, 160), value: shown.slice(0, 300), flag: flagFor(current, shown) });
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
                             () => { match.focus(); pressEnter(match); }]) {
        if (!match.isConnected) break;
        attempt();
        if (await waitFor(() => !placeholderText(textOf(button)), 1200)) {
          await closeLists(button);
          note(button, question, textOf(button));
          return true;
        }
      }
    }
    await closeLists(button);
    return !placeholderText(textOf(button));
  }

  const selectedPills = el => {
    const field = el.closest('[data-automation-id^="formField"], [data-automation-id="multiselectInputContainer"]') || el.parentElement || document.createElement('div');
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
        if (await waitFor(() => chosen(count, label), 900)) return label;
        options = await freshOptions(input, before, key, 1800);
        if (!options || options.map(optionLabel).join('|') === key) return chosen(count, label) ? label : false;
      }
      return false;
    };
    const searches = (want.search || want.values).filter(Boolean).slice(0, 4);
    let previous = null;
    for (const term of searches) {
      search(input, term);
      const options = await freshOptions(input, before, previous, 2500);
      previous = options ? options.map(optionLabel).join('|') : previous;
      const picked = await choose(options);
      if (picked) {
        await closeLists(input);
        note(input, question, picked);
        return true;
      }
      search(input, '');
    }
    if (want.browse) {
      // No search hit: open the whole list and pick the most relevant entry.
      press(input);
      pressEnter(input);
      const picked = await choose(await freshOptions(input, before, null, 2500));
      if (picked) {
        await closeLists(input);
        note(input, question, picked);
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
    note(select, question, match.textContent.trim());
    return true;
  }

  const choiceLabel = r => textOf(r.labels && r.labels[0]) || r.getAttribute('aria-label') || r.value || '';
  function pickRadio(radios, variants, question, strict = false) {
    const match = best(radios, variants, choiceLabel, strict);
    if (!match) return false;
    press(match);
    note(match, question, choiceLabel(match));
    return true;
  }

  // ---------- Dates ----------
  function datePartsNear(el) {
    const field = el.closest('[data-automation-id^="formField"], [data-automation-id="dateInputWrapper"]') || el.parentElement;
    const part = name => field.querySelector(`input[data-automation-id*="dateSection${name}"]`);
    return { month: part('Month'), day: part('Day'), year: part('Year') };
  }

  // `fix` also corrects parts that hold a different date (Workday's resume reader).
  function fillDate(el, formats, question, fix = false) {
    if (!formats || !formats.year) return false;
    if (isDatePart(el)) {
      const parts = datePartsNear(el);
      let any = false;
      for (const [name, value] of [['month', formats.month], ['day', formats.day], ['year', formats.year]]) {
        const part = parts[name];
        if (!part || !value || (part.value && (!fix || Number(part.value) === Number(value)))) continue;
        if (part.value) current = { ...current, replace: true };
        typeInto(part, value); handled.add(part); any = true;
      }
      if (any) note(el, question, ['month', 'day', 'year'].filter(name => parts[name]).map(name => formats[name]).join('/'));
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
    note(el, question, value);
    return true;
  }

  // ---------- What to put in a field ----------
  const p = plan.profile || {};
  const parts = (p.name || '').trim().split(/\s+/);
  const school = (plan.education || [])[0] || {};
  const schoolNames = school.school_options && school.school_options.length ? school.school_options : [p.school];
  // Search the way a person would: the everyday name, the start of the
  // official name, then the whole official name.
  const url = link => link && !/^https?:\/\//i.test(link) ? `https://${link}` : link;
  const schoolSearch = names => [...new Set([names[names.length - 1], (names[0] || '').split(' ').slice(0, 3).join(' '), names[0]])].filter(Boolean);
  const contact = [
    ['email', /e ?mail/, [p.email]], ['phone', /phone number|^phone$|mobile|cell(ular)? number|telephone/, [p.phone]],
    ['linkedin', /linkedin/, [url(p.linkedin)]], ['github', /github/, [url(p.github)]],
    // Any other link field gets the personal site, or GitHub without one.
    ['website', /website|portfolio|personal (site|url|page)|^url$/, [url(p.website), url(p.github)]], ['first', /first name|given name|preferred name|^first$/, [parts[0]]],
    ['last', /last name|family name|surname|^last$/, [parts.length > 1 ? parts.slice(1).join(' ') : '']],
    ['name', /full name|your name|legal name|^name$/, [p.name]], ['address', /address line 1|street address|address 1|^address$/, [p.address]],
    ['city', /(^| )city( |$)|town/, [p.city]], ['state', /(^| )state( |$)|province|region/, p.state_options || [p.state], { strict: true }],
    ['postal', /zip|postal code|postcode/, [p.postal_code]],
    ['school', /school|university|college|institution/, schoolNames, { strict: true, search: schoolSearch(schoolNames) }],
    ['field', /field of study|area of study|(^| )major( |$)|academic discipline/, school.field_options || [], { strict: true, search: [school.field] }],
    ['degree', /degree/, [p.degree, ...(((plan.education || [])[0] || {}).degree_options || [])]],
  ];
  const otherPeople = /reference|emergency|supervisor|manager|guardian|parent|spouse|high school|extension|referr(al|er|ed) (name|email|by)/;
  // A start date at a past job ("Government Civilian Start Date") is not the user's to invent.
  const pastJob = /government|military|civilian|clearance|served|service|former|previous|prior/;
  const startDate = /(start|availability|available) date|when can you (start|begin)|earliest (start|date)|proposed start|date (you are )?available/;
  const graduationDate = /when (will|do) you (expect to )?graduate|graduation date|(expected|anticipated|projected) graduation|graduation (month|year|term)|date of graduation|completion date/;
  const consent = /agree|certif|acknowledg|consent|terms|attest|privacy|i understand|authori[sz]e (us|the company|.* to contact)/;
  const todayDate = /^(today'?s )?date$|^date signed$|^signature date$/;
  // Self-identification: the user's Profile answer, or the form's decline option.
  function disclosureFor(text) {
    const q = norm(text);
    const found = (plan.disclosures || []).find(d => new RegExp(d.pattern, 'i').test(q));
    return found ? { values: found.options, source: 'disclosure', strict: 'prefix', declined: !!found.declined } : null;
  }
  // Why a value deserves a second look in the review, if it does.
  function flagFor(want, value) {
    if (!want) return '';
    if (want.replace) return "Replaced the text Workday read from your resume with your resume's own";
    if (want.source === 'disclosure') return want.declined ? 'Chose the decline option for you' : 'Your self-identification answer from Profile';
    if (want.source === 'learned') return 'From an answer you gave on an earlier application';
    if (want.source === 'draft') return 'Draft by Apply Desk. Edit it in your own words';
    if (want.source === 'neutral') return `No saved answer, so Apply Desk picked "${value}". Check it`;
    if (want.browse && value && norm(value) !== norm(want.values[0])) return `Closest option to your answer: ${want.values[0]}`;
    if (want.date && want.date === plan.start && /today/i.test(plan.start.source || '')) return "Today's date: the posting gives no start date";
    return '';
  }
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
    if (!q) return null;
    const disclosure = disclosureFor(q);
    if (disclosure) return disclosure;
    if (never.test(q)) return null;
    if (el.tagName !== 'TEXTAREA' && startDate.test(q) && !pastJob.test(q)) return { date: plan.start, source: 'date' };
    if (el.tagName !== 'TEXTAREA' && todayDate.test(q) && plan.today) return { date: plan.today, source: 'date' };
    if (el.tagName !== 'TEXTAREA' && graduationDate.test(q)) {
      const dated = p.graduation_dates || {};
      return el.tagName === 'SELECT' || isListbox(el) ? { values: [dated.year, p.graduation], source: 'date' } : { date: dated, source: 'date' };
    }
    // A standard question owns its question; when its answer is blank, only
    // something the user answered on an earlier form can fill it.
    let claimed = false;
    for (const answer of plan.answers || []) {
      if (!new RegExp(answer.pattern, 'i').test(q)) continue;
      if (!answer.answer) { claimed = true; break; }
      return { values: answer.options.length ? answer.options : [answer.answer], source: 'answer', key: answer.key, open: !!answer.open,
               browse: answer.key === 'heard_about' || !!answer.open };
    }
    for (const learned of plan.learned || []) {
      if (norm(learned.question) === q || similar(learned.question, q) >= 0.8) return { values: learned.answer.split(/;\s*/), source: 'learned' };
    }
    if (claimed) return null;
    // Common short-answer questions get a plain draft from the user's own details.
    if (el.tagName === 'TEXTAREA' || isText(el)) {
      const draft = (plan.drafts || []).find(d => new RegExp(d.pattern, 'i').test(q));
      if (draft) return { values: [draft.text], source: 'draft' };
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
    current = want;
    try {
      if (want.date) return fillDate(el, want.date, question, want.fix);
      const values = want.values.filter(Boolean);
      if (!values.length) return false;
      if (el.tagName === 'SELECT') return pickSelect(el, values, question, want.strict);
      if (isListbox(el)) return await pickListbox(el, { ...want, values }, question);
      if (isPrompt(el)) return selectedPills(el).length ? false : await pickPrompt(el, { ...want, values }, question);
      // Self-identification answers are picked from the form's options, never typed.
      if ((isText(el) || (el.tagName === 'TEXTAREA' && want.source === 'draft')) && (!el.value.trim() || want.replace) && want.source !== 'disclosure') {
        typeInto(el, values[0]);
        note(el, question, values[0]);
        return true;
      }
      return false;
    } finally {
      current = null;
    }
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
        const label = `${kind === 'experience' ? 'Work experience' : 'Education'} ${i + 1}: ${questionOf(el).replace(/\*\s*$/, '')}`;
        let want = null;
        if (kind === 'experience') {
          if (el.type === 'checkbox') {
            if (/current/.test(q) && entry.current && !el.checked) { press(el); note(el, label, 'Yes'); }
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
          // Workday's own resume reader runs words together ("returnsJSON");
          // the resume's text replaces it, unless this run typed the field already.
          const typed = !want.date && isText(el) && !isDatePart(el);
          const stale = typed && !isEmpty && !run.wrote[label] && clean(el.value) !== clean(want.values[0]);
          if (isEmpty || isDatePart(el) || stale) await fillControl(el, label, stale ? { ...want, replace: true } : { ...want, fix: !run.wrote[label] });
          if ((typed && clean(el.value) === clean(want.values[0])) || (want.date && isDatePart(el))) run.wrote[label] = true;
        }
      }
      for (const el of controlsIn(blocks[i])) handled.add(el);
      state.blocks += 1;
    }
    // The reader also adds entries the resume doesn't list as jobs or schools (projects, awards).
    for (let i = entries.length; i < blocks.length; i += 1) {
      const named = controlsIn(blocks[i]).find(el => first.test(norm(questionOf(el))));
      const value = named ? answeredValue(named) : '';
      const question = `${kind === 'experience' ? 'Work experience' : 'Education'} ${i + 1}`;
      if (value && !state.items.some(item => item.question === question)) {
        state.items.push({ page: pageNow, question, value, flag: "Not on your resume as a job or school. Delete it if Workday added it" });
      }
      for (const el of controlsIn(blocks[i])) handled.add(el);
    }
    for (const el of controlsIn(section)) handled.add(el);
  }

  // ---------- Skills ----------
  // Adds the posting's most relevant skills (the plan lists them best first),
  // up to any limit the form states. Workday redraws the box after each pick,
  // so it's found again every time, and skills already added are skipped
  // (picking one again would remove it). A skill the list doesn't have is
  // skipped, never swapped for a different one.
  // "Python (Programming Language)" is Python; "Python IDLE" and "IronPython" aren't.
  const skillKey = name => String(name || '').toLowerCase().replace(/\([^)]*\)/g, ' ')
    .replace(/\b(programming|language|framework|library|package|software)\b/g, ' ')
    .replace(/[^a-z0-9+#]/g, '').replace(/^(.{2,})js$/, '$1').replace(/^postgres$/, 'postgresql');
  const skillOption = (options, skill) => options.find(o => norm(optionLabel(o)) === norm(skill)) || options.find(o => {
    const label = optionLabel(o);
    const named = [label, ...(label.match(/\(([^)]*)\)/g) || []).map(part => part.slice(1, -1))];  // "Structured Query Language (SQL)"
    return named.some(name => skillKey(name) === skillKey(skill));
  }) || null;
  const ticked = o => !!((o.closest('[role="option"], [data-automation-id="menuItem"]') || o).querySelector('input[type=checkbox]:checked'));
  async function fillSkills() {
    const findInput = () => controlsIn(document).find(el => isPrompt(el) && /skill/.test(norm(questionOf(el))));
    let input = findInput();
    if (!input || !(plan.skills || []).length) return;
    const fieldOf = el => (el && (el.closest('[data-automation-id^="formField"]') || (el.closest('[data-automation-id="multiselectInputContainer"]') || el).parentElement)) || document.body;
    const pills = () => {
      const field = fieldOf(findInput() || input);
      return [...field.querySelectorAll('[data-automation-id="selectedItem"], [data-automation-id="selectedItemList"] [role="option"], .selected-pill')].map(textOf).filter(Boolean);
    };
    const stated = textOf(fieldOf(input)).match(/(?:up to|max(?:imum)?(?: of)?|no more than|at most|limit of)\s*(\d{1,2})/i);
    const limit = stated ? Number(stated[1]) : plan.skills.length;
    const has = name => pills().some(pill => norm(pill) === norm(name) || norm(pill).startsWith(norm(name) + ' '));
    await closeLists();
    const before = new Set(openOptions());
    let previous = null;
    const names = [];
    for (const skill of plan.skills) {
      if (pills().length >= limit) break;
      if (has(skill)) continue;
      input = findInput() || input;
      if (!input.isConnected) break;
      handled.add(input);
      search(input, skill);
      const options = await freshOptions(input, before, previous, 2500);
      previous = options ? options.map(optionLabel).join('|') : previous;
      const match = options && skillOption(options, skill);
      if (match && !ticked(match) && !has(optionLabel(match))) {
        const count = pills().length;
        press(match);
        if (await waitFor(() => pills().length > count, 2000)) names.push(optionLabel(match));
      }
      // Workday keeps this list open; close it so the next search starts clean.
      await closeLists();
      input = findInput() || input;
      if (input.isConnected && input.value) search(input, '');
    }
    input = findInput() || input;
    await closeLists(input);
    if (names.length) {
      state.filled.push(`skills (${names.length})`);
      state.items.push({ page: pageNow, question: 'Skills', value: names.join(', '), flag: '' });
      glow(input);
    }
  }

  // ---------- Links ----------
  // Workday's "Websites" section starts empty: add one entry so the personal
  // site (or GitHub) has a field. The field itself is filled like any other.
  async function addWebsite() {
    if (!url(p.website || p.github)) return;
    const section = sectionFor(/^websites?$/);
    if (!section || controlsIn(section).some(isText)) return;
    const add = addButton(section);
    if (!add) return;
    press(add);
    await waitFor(() => controlsIn(section).some(isText), 3000);
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

  // ---------- One page ----------
  async function fillPage() {
    handled.clear();
    attachResume();
    await fillBlocks('experience', plan.experience);
    await fillBlocks('education', plan.education);
    await fillSkills();
    await addWebsite();
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
      if (checked) { remember(question, choiceLabel(checked)); continue; }
      const want = wanted(group[0], question) || disclosureFor(group.map(choiceLabel).join(' '));
      current = want;
      if (want && want.values) pickRadio(group, want.values, question, want.strict);
      current = null;
    }
    for (const [question, group] of Object.entries(boxes)) {
      // A lone box is usually consent ("I agree…"); only groups are preferences.
      if (group.length < 2 || consent.test(norm(question)) || group.some(box => consent.test(norm(choiceLabel(box))))) continue;
      const checked = group.filter(box => box.checked);
      if (checked.length) { remember(question, checked.map(choiceLabel).join('; ')); continue; }
      // Self-identification boxes (disability forms) are often known only by their options.
      const want = wanted(group[0], question) || disclosureFor(group.map(choiceLabel).join(' '));
      if (!want || !(['learned', 'disclosure'].includes(want.source) || want.key === 'location_preference')) continue;
      current = want;
      if (want.source === 'disclosure') {
        const match = best(group, want.values, choiceLabel, 'prefix');
        if (match && !match.checked) { press(match); note(match, question, choiceLabel(match)); }
      } else if (want.open) {
        // Open to every location: the "no preference" box when there is one, otherwise all of them.
        const any = group.find(box => /no preference|^any\b|^all\b|open to (all|any)|anywhere|flexible/i.test(choiceLabel(box)));
        const targets = any ? [any] : group;
        targets.filter(box => !box.checked).forEach(press);
        note(group[0], question, targets.map(choiceLabel).join('; '));
      } else {
        const picked = [];
        for (const value of want.values) {
          const match = best(group, [value], choiceLabel);
          if (match && !match.checked) { press(match); picked.push(choiceLabel(match)); }
        }
        if (picked.length) note(group[0], question, picked.join('; '));
      }
      current = null;
    }
    try {
      for (const [question, answer] of Object.entries(JSON.parse(sessionStorage.getItem('applyDeskSeen') || '{}'))) remember(question, answer);
    } catch (error) { /* storage can be blocked */ }
    await closeLists();
  }

  // ---------- Steps ----------
  const pageTitle = () => {
    const step = document.querySelector('[data-automation-id="progressBarActiveStep"]');
    const stepText = step && textOf(step).replace(/(current )?step \d+ of \d+/ig, '').trim();
    if (stepText) return stepText.slice(0, 80);
    const head = [...document.querySelectorAll('main h1, main h2, h1, h2, [data-automation-id*="pageHeader"]')].find(h => visible(h) && textOf(h));
    return (head ? textOf(head) : document.title).slice(0, 80);
  };
  const pageKey = () => [pageTitle(), location.pathname, ...controlsIn(document).slice(0, 6).map(questionOf)].join('|');
  const buttonText = b => (textOf(b) || b.value || b.getAttribute('aria-label') || '').trim();
  const clickable = () => [...document.querySelectorAll('button, input[type=submit], input[type=button], a[role=button], [role=button]')]
    .filter(b => visible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
  // Buttons that move to the next step; anything that submits is never pressed.
  const stepButton = /^(save (and|&) continue|continue|next|next step|proceed|save and next)$/i;
  const finalButton = /submit|apply|send|finish|complete|sign|create account|log ?in/i;
  function continueButton() {
    const known = [...document.querySelectorAll('[data-automation-id="bottom-navigation-next-button"], [data-automation-id="pageFooterNextButton"]')];
    return [...known, ...clickable()].find(b => visible(b) && !b.disabled && stepButton.test(buttonText(b)) && !finalButton.test(buttonText(b))) || null;
  }
  const applyManuallyButton = () => clickable().find(b => b.getAttribute('data-automation-id') === 'applyManually' || /^apply manually$/i.test(buttonText(b))) || null;
  const signInPage = () => [...document.querySelectorAll('input[type=password]')].some(visible);
  const onReview = () => /^review\b/i.test(pageTitle());
  const loading = () => [...document.querySelectorAll('[data-automation-id="loadingSpinner"], [aria-busy="true"], [role="progressbar"]')].some(visible);
  const isRequired = (el, question) => el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(question || '');

  // An end date in a job marked "I currently work here" isn't needed.
  function currentJob(el) {
    for (let node = el.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth += 1) {
      const box = [...node.querySelectorAll('input[type=checkbox]')].find(b => /current|work here/i.test(choiceLabel(b) + ' ' + questionOf(b)));
      if (box) return box.checked;
    }
    return false;
  }

  // Required questions on this page that are still blank after filling.
  function needsOnPage() {
    const needs = [], seen = new Set(), controls = controlsIn(document);
    for (const el of controls) {
      const question = questionOf(el);
      if (!question || seen.has(question) || !isRequired(el, question)) continue;
      if (/^to\b/.test(norm(question)) && currentJob(el)) continue;
      let empty;
      if (el.type === 'radio' || el.type === 'checkbox') {
        const group = controls.filter(o => o.type === el.type && (el.type === 'radio' && el.name ? o.name === el.name : questionOf(o) === question));
        empty = !group.some(o => o.checked);
      } else if (el.tagName === 'TEXTAREA' || isDatePart(el)) {
        empty = !el.value.trim();
      } else {
        empty = !answeredValue(el);
      }
      if (empty) {
        seen.add(question);
        needs.push({ question: question.replace(/\*\s*$/, '').trim().slice(0, 160), el });
      }
    }
    return needs;
  }

  function errorsShown() {
    const texts = [];
    for (const el of document.querySelectorAll('[data-automation-id="errorMessage"], [data-automation-id="errorBanner"] li, [data-automation-id="inputAlert"], [role="alert"]')) {
      const text = textOf(el);
      if (visible(el) && text && text.length < 300 && !texts.includes(text)) texts.push(text);
    }
    return texts.slice(0, 10);
  }

  // After Continue: true once a new page has loaded and stopped changing;
  // false if the page stayed (errors) or nothing happened.
  async function nextPage(before) {
    const started = Date.now();
    while (Date.now() - started < 30000 && pageKey() === before) {
      await sleep(300);
      state.beat += 1;
      if (Date.now() - started > 1500 && pageKey() === before && errorsShown().length) return false;
    }
    if (pageKey() === before) return false;
    let last = '', same = 0;
    for (const end = Date.now() + 12000; Date.now() < end && same < 3;) {
      await sleep(300);
      state.beat += 1;
      const now = `${pageKey()}#${controlsIn(document).length}${loading() ? '…' : ''}`;
      same = now === last ? same + 1 : 0;
      last = now;
    }
    return true;
  }

  // ---------- The review panel ----------
  // Drawn in its own shadow root so the site's styles can't touch it, and
  // its contents never count as form fields.
  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function findOnPage(text) {
    const wantText = norm(text).slice(0, 40);
    if (!wantText) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent && visible(parent) && !parent.closest('#apply-desk-panel') && norm(parent.textContent).includes(wantText)) return parent;
    }
    return null;
  }

  function reveal(target) {
    if (!target) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (target.focus && /INPUT|SELECT|TEXTAREA|BUTTON/.test(target.tagName)) target.focus({ preventScroll: true });
    glow(target);
  }

  function showPanel(title, subtitle, groups, footer, action = null, onClose = null) {
    document.querySelectorAll('#apply-desk-panel').forEach(node => node.remove());
    const host = make('div');
    host.id = 'apply-desk-panel';
    const root = host.attachShadow({ mode: 'open' });
    root.appendChild(make('style', '', `
      :host { all: initial; }
      .card { position: fixed; top: 16px; right: 16px; z-index: 2147483647; width: 344px; max-height: calc(100vh - 32px); overflow: auto; box-sizing: border-box;
        padding: 14px 14px 10px; border-radius: 14px; border: 1px solid rgba(0,0,0,.08); background: rgba(255,255,255,.97); color: #1d1d1f;
        box-shadow: 0 18px 50px rgba(0,0,0,.18); font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
      @media (prefers-color-scheme: dark) { .card { background: rgba(32,32,34,.97); color: #f5f5f7; border-color: rgba(255,255,255,.1); } }
      .top { display: flex; gap: 10px; align-items: flex-start; }
      .mark { width: 22px; height: 22px; border-radius: 7px; flex: none; background: linear-gradient(135deg, #10b77f, #2f80ed); }
      h2 { font-size: 15px; margin: 0; font-weight: 650; }
      .sub, .foot, .count, .v, .page { color: #6e6e73; }
      .sub { margin: 2px 0 10px; }
      .close { all: unset; margin-left: auto; cursor: pointer; padding: 0 4px; font-size: 18px; line-height: 1; color: #8e8e93; }
      details { border-top: 1px solid rgba(127,127,127,.2); padding: 8px 0; }
      summary { display: flex; gap: 8px; align-items: center; font-weight: 600; cursor: pointer; list-style: none; }
      summary::-webkit-details-marker { display: none; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--tone); }
      .count { margin-left: auto; font-weight: 500; }
      ul { list-style: none; margin: 6px 0 0; padding: 0; }
      li button { all: unset; display: block; box-sizing: border-box; width: 100%; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
      li button:hover, li button:focus-visible { background: rgba(127,127,127,.12); }
      .q { font-weight: 500; } .v { overflow-wrap: anywhere; } .why { color: var(--tone); font-size: 12px; }
      .page { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin: 8px 8px 2px; }
      .foot { font-size: 12px; margin: 8px 0 2px; }
      .act { all: unset; cursor: pointer; font-weight: 600; font-size: 12px; padding: 5px 10px; border-radius: 8px; background: rgba(127,127,127,.14); }`));
    const card = make('section', 'card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', title);
    const top = make('div', 'top');
    const heading = make('div');
    heading.append(make('h2', '', title), make('p', 'sub', subtitle));
    const close = make('button', 'close', '×');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => { host.remove(); if (onClose) onClose(); });
    top.append(make('span', 'mark'), heading, close);
    card.appendChild(top);
    for (const group of groups) {
      if (!group.items.length) continue;
      const details = make('details');
      details.open = !group.collapsed;
      details.style.setProperty('--tone', group.tone);
      const summary = make('summary');
      summary.append(make('span', 'dot'), make('span', '', group.title), make('span', 'count', String(group.items.length)));
      const list = make('ul');
      let page = null;
      for (const item of group.items) {
        if (group.byPage && item.page !== page) {
          page = item.page;
          list.appendChild(make('li', 'page', page || 'This page'));
        }
        const row = make('li');
        const button = make('button');
        button.append(make('div', 'q', item.question));
        if (item.value) button.appendChild(make('div', 'v', item.value.length > 140 ? item.value.slice(0, 140) + '…' : item.value));
        if (item.why) button.appendChild(make('div', 'why', item.why));
        button.addEventListener('click', () => reveal(item.el && item.el.isConnected ? item.el : findOnPage(item.value || item.question)));
        row.appendChild(button);
        list.appendChild(row);
      }
      details.append(summary, list);
      card.appendChild(details);
    }
    card.appendChild(make('p', 'foot', footer));
    if (action) {
      const button = make('button', 'act', action.label);
      button.addEventListener('click', action.onClick);
      card.appendChild(button);
    }
    root.appendChild(card);
    document.documentElement.appendChild(host);
  }

  const roleName = plan.role ? [plan.role.title, plan.role.company].filter(Boolean).join(' · ') : '';

  function showNeeds(needs, errors, waiting = false) {
    const items = needs.map(need => ({ question: need.question, el: need.el }))
      .concat(errors.filter(text => !needs.some(need => text.includes(need.question))).map(text => ({ question: text })));
    if (!waiting) {
      showPanel(`${pageNow || 'This page'} needs you`, `Apply Desk filled what it could here${roleName ? ` for ${roleName}` : ''}.`,
                [{ title: 'Answer these', tone: '#e5484d', items }], 'Then press ` to keep going. Apply Desk picks up from this page.');
      return;
    }
    const stop = () => { window.__applyDeskStop = true; };
    showPanel(items.length ? `Waiting for you on ${pageNow || 'this page'}` : 'All answered', items.length
                ? 'Apply Desk filled everything else it could. Answer these and it keeps going by itself.' : 'Continuing when you stop typing…',
              [{ title: 'Answer these', tone: '#e5484d', items }], 'Press ` or close this to stop here.', { label: 'Stop here', onClick: stop }, stop);
  }

  // Required choices with no saved answer: a neutral option when the form has one.
  const NEUTRAL = ['N/A', 'NA', 'Not applicable', 'None', 'Prefer not to say', 'Prefer not to answer', 'I prefer not to answer',
                   'I do not wish to answer', "I don't wish to answer"];
  async function fillNeutral(needs) {
    for (const need of needs) {
      const el = need.el;
      current = { source: 'neutral' };
      if (el.tagName === 'SELECT') pickSelect(el, NEUTRAL, need.question, 'prefix');
      else if (isListbox(el)) await pickListbox(el, { values: NEUTRAL, strict: 'prefix' }, need.question);
      else if (el.type === 'radio') pickRadio(controlsIn(document).filter(r => r.type === 'radio' && r.name === el.name), NEUTRAL, need.question, 'prefix');
      current = null;
    }
  }

  // Waits on the page while the user answers what's left, then carries on by
  // itself once nothing required is blank and they've stopped typing.
  async function waitForUser() {
    let lastActivity = Date.now(), shown = null;
    const touch = () => { lastActivity = Date.now(); };
    const events = ['input', 'change', 'keydown', 'pointerdown'];
    events.forEach(type => document.addEventListener(type, touch, true));
    window.__applyDeskBusy = false;     // the user's own answers can be learned
    state.waiting = true;
    try {
      for (const end = Date.now() + 20 * 60e3; Date.now() < end;) {
        await sleep(800);
        state.beat += 1;
        if (window.__applyDeskStop) return false;
        const left = needsOnPage();
        const key = left.map(need => need.question).join('|');
        if (key !== shown) { shown = key; showNeeds(left, errorsShown().filter(() => left.length), true); }
        state.needs = left.map(need => need.question);
        if (!left.length && Date.now() - lastActivity > 4000) return true;
      }
      return false;
    } finally {
      events.forEach(type => document.removeEventListener(type, touch, true));
      state.waiting = false;
      window.__applyDeskBusy = true;
    }
  }

  // Everything filled across the run, checked against what the review page shows.
  function showReview() {
    // A value counts as shown when it sits next to its own label ("State:
    // Virginia"), not just anywhere ("Virginia" inside the school's name).
    const labels = [...document.body.querySelectorAll('*')].filter(e => e.children.length <= 2 && !e.closest('#apply-desk-panel') && visible(e));
    const shows = item => {
      const value = item.value || '';
      if (!value || value.length <= 3 || /^\d{1,2}\/(\d{1,2}\/)?\d{4}$/.test(value)) return true;
      const digits = value.replace(/\D/g, '');
      const phone = digits.length >= 7 && digits.length >= value.replace(/\s/g, '').length * 0.6;
      const has = text => phone ? text.replace(/\D/g, '').includes(digits) : value.split(/,\s*/).every(part => norm(text).includes(norm(part).slice(0, 40)));
      const label = norm(item.question.replace(/^(work experience|education) \d+: /i, ''));
      const own = labels.filter(e => norm(e.textContent) === label);
      if (!own.length) return has(document.body.innerText);
      return own.some(e => [e.nextElementSibling, e.parentElement, e.parentElement && e.parentElement.parentElement]
        .some(near => near && near.textContent.length < label.length + value.length + 200 && has(near.textContent)));
    };
    const check = [];
    for (const item of state.items) {
      if (item.flag) check.push({ ...item, why: item.flag });
      else if (!shows(item)) check.push({ ...item, why: "Not on the review page. Check it took." });
    }
    const errors = errorsShown().map(text => ({ question: text }));
    const attached = state.attached ? [{ question: 'Resume', value: decode(nameB64) || 'Resume.pdf', why: '' }] : [];
    showPanel('Ready for your review', roleName || 'Everything Apply Desk filled, page by page.', [
      { title: 'Needs you', tone: '#e5484d', items: errors },
      { title: 'Check these', tone: '#d9822b', items: check, byPage: true },
      { title: 'Filled by Apply Desk', tone: '#10b77f', items: [...attached, ...state.items], byPage: true, collapsed: true },
    ], 'Look it over, then click Submit yourself. Apply Desk never submits.');
    state.checks = check.length;
  }

  const removePanel = () => document.querySelectorAll('#apply-desk-panel').forEach(node => node.remove());

  // ---------- Run: fill, continue, repeat ----------
  (async () => {
    window.__applyDeskBusy = true;
    window.__applyDeskStop = false;
    document.querySelectorAll('#apply-desk-panel').forEach(node => node.remove());
    try {
      for (let step = 0; ; step += 1) {
        pageNow = state.page = pageTitle();
        state.beat += 1;
        if (signInPage()) { state.stop = 'signin'; break; }
        if (onReview()) { showReview(); state.stop = 'review'; break; }
        if (step >= 20) { state.stop = 'limit'; break; }
        // Workday's start page: choose to fill it in here rather than upload-and-parse.
        const manual = controlsIn(document).length < 2 && !continueButton() && applyManuallyButton();
        if (manual) {
          const key = pageKey();
          press(manual);
          if (!(await nextPage(key))) { state.stop = 'stuck'; break; }
          continue;
        }
        await fillPage();
        saveRun();
        let needs = needsOnPage();
        if (needs.length) {
          await fillNeutral(needs);
          saveRun();
          needs = needsOnPage();
        }
        if (needs.length) {
          state.needs = needs.map(need => need.question);
          // A single-page form ends here; on a step, wait and then keep going.
          if (!continueButton()) { showNeeds(needs, []); state.stop = 'needs'; break; }
          if (!(await waitForUser())) { state.stop = window.__applyDeskStop ? 'stopped' : 'needs'; break; }
          removePanel();
        }
        const next = continueButton();
        if (!next) { state.stop = 'end'; break; }
        if (window.__applyDeskStop) { state.stop = 'stopped'; break; }
        if (!run.pages.includes(pageNow)) run.pages.push(pageNow);
        // Commit the last typed field before leaving the page.
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        await sleep(300);
        const key = pageKey();
        state.advancing = true;
        saveRun();
        press(next);
        const moved = await nextPage(key);
        state.advancing = false;
        if (!moved) {
          const blank = needsOnPage(), errors = errorsShown();
          if (!blank.length && !errors.length) { state.stop = 'stuck'; break; }
          // The site found something missing: wait for the user, then try again.
          state.needs = [...blank.map(need => need.question), ...errors].slice(0, 12);
          showNeeds(blank, errors, true);
          if (!(await waitForUser())) { state.stop = window.__applyDeskStop ? 'stopped' : 'errors'; break; }
          removePanel();
        }
      }
      if (!state.items.length && !state.attached) {
        const frame = [...document.querySelectorAll('iframe')].find(f => /greenhouse|lever|ashby|workday|smartrecruiters|icims|jobvite/.test(f.src || ''));
        state.embedded = frame ? frame.src : '';
      }
    } catch (error) {
      state.error = String(error && error.message || error);
    }
    // Commit the last typed field while still busy, so its change isn't learned.
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    saveRun();
    await sleep(50);
    window.__applyDeskBusy = false;
    state.done = true;
  })();
  return JSON.stringify({ started: true });
}
