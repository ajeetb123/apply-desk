// Apply Desk form filler, injected into the front Chrome tab by the Mac app as
//   applyDeskFill(planBase64, resumePdfBase64, resumeNameBase64)
// The plan (GET /api/fill-plan) holds only the user's own profile, saved
// answers, resume entries, and tailored skills. The filler types only into
// empty fields (job and school entries Workday read from the resume itself
// get the resume's exact text instead), answers self-identification
// questions only as the user chose in Profile (or with the form's decline
// option), ticks terms boxes and signs only when the user turned that on in
// Profile (never marketing sign-ups), and never submits. Pressing ` stops it
// at once; pressing again continues and leaves what's already there alone. On multi-step applications (Workday) it fills a page,
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
  if (!run || run.role !== roleId || Date.now() - (run.updated || 0) > 14 * 24 * 3600e3) {
    run = { id: String(Date.now()), role: roleId, items: [], pages: [], learn: [], attached: false };
  }
  // What Apply Desk has been through here (field and page names, never answers)
  // outlives the tab, so a press tomorrow continues instead of redoing.
  const marksKey = `applyDeskMarks:${roleId || location.pathname}`;
  let marks = {};
  try { marks = JSON.parse(localStorage.getItem(marksKey) || '{}') || {}; } catch (error) { marks = {}; }
  if (Date.now() - (marks.updated || 0) > 30 * 24 * 3600e3) marks = {};
  run.wrote = { ...marks.wrote, ...run.wrote };  // entry fields this run typed: what's there now is ours or the user's edit
  run.first = { ...marks.first, ...run.first };  // a fingerprint of what each entry field held when first seen
  run.adds = { ...marks.adds, ...run.adds };  // sections it has already added entries to
  Object.assign(state, { run: run.id, items: run.items, pages: run.pages, learn: run.learn, attached: run.attached });
  const saveRun = () => {
    run.attached = state.attached;
    run.updated = Date.now();
    try { sessionStorage.setItem('applyDeskRun', JSON.stringify(run)); } catch (error) { /* storage can be blocked */ }
    try { localStorage.setItem(marksKey, JSON.stringify({ wrote: run.wrote, first: run.first, adds: run.adds, updated: run.updated })); } catch (error) { /* storage can be blocked */ }
  };
  // Chrome slows a background tab's timers to a crawl. Every wait is also
  // kept in `naps`, and the Mac app wakes the ones that are due each time it
  // checks on this tab (window.__applyDeskPump), so a run keeps moving while
  // the user works in another tab.
  // Pressing ` stops the run wherever it is: the next wait or field throws STOPPED.
  const STOPPED = new Error('stopped');
  let finishing = false;
  const stopCheck = () => { if (window.__applyDeskStop && !finishing) throw STOPPED; };
  const naps = new Set();
  const sleep = ms => new Promise((resolve, reject) => {
    state.beat += 1;   // every wait shows the Mac app this run is alive
    const nap = { due: Date.now() + ms, wake: () => { naps.delete(nap); if (window.__applyDeskStop && !finishing) reject(STOPPED); else resolve(); } };
    naps.add(nap);
    setTimeout(nap.wake, ms);
  });
  window.__applyDeskPump = () => { const now = Date.now(); for (const nap of [...naps]) if (window.__applyDeskStop || nap.due <= now) nap.wake(); };
  // "✱" is Lever's required mark.
  const norm = s => (s || '').toLowerCase().replace(/&/g, ' and ').replace(/[_*✱:?()\[\]]+/g, ' ').replace(/[-–]/g, ' ').replace(/\s+/g, ' ').trim();
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

  // A label's own words, without the options of a dropdown it wraps (Lever:
  // "Gender Select ... Male Female" is the question "Gender").
  // Visible text inside `root`, leaving out any element `skip` rejects (and
  // hidden helper text like Lever's "No location found").
  function textWithout(root, skip) {
    const parts = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let keep = !!node.parentElement && visible(node.parentElement);
      for (let up = node.parentElement; keep && up && up !== root; up = up.parentElement) if (skip(up)) keep = false;
      if (keep) parts.push(node.textContent);
    }
    return clean(parts.join(' '));
  }
  const controlPart = el => el.matches('select, option, textarea, button, [role="listbox"], [role="option"]')
    || (el.matches('ul, ol') && !!el.querySelector('input, [role="option"]'));
  function labelText(label) {
    if (!label || !label.querySelector('select, option, textarea, input, ul, button')) return textOf(label);
    return textWithout(label, controlPart);
  }

  // For a Yes/No or pick-several group whose options are labels of their own
  // (Lever, Greenhouse, Ashby), the question is the text around the whole
  // group with the options taken out.
  // The inputs that are one question's choices. Radios share a name; tick
  // boxes often don't (Ashby names each after its own label), so those are
  // the boxes sitting together in the nearest container that holds only them.
  // A container's text without its options: option labels (wrapping an option
  // or pointing at it) aren't the question.
  function textAround(node, options) {
    const ids = new Set(options.length > 1 ? options.map(option => option.id).filter(Boolean) : []);
    return textWithout(node, part => controlPart(part) || part.matches('[role="radio"], [role="checkbox"]')
      || (part.matches('label') && (!!part.querySelector('input') || ids.has(part.htmlFor))));
  }
  const controlCount = node => node.querySelectorAll('input:not([type=hidden]), select, textarea').length;
  function choiceGroup(el) {
    const named = el.name ? [...document.getElementsByName(el.name)].filter(o => o.type === el.type) : [];
    if (el.type === 'radio' && named.length) return named;
    // Tick boxes go by where they sit: a form can repeat a question, names and all.
    const same = node => [...node.querySelectorAll(`input[type="${el.type}"]`)];
    for (let node = el.parentElement, depth = 0; node && node !== document.body && depth < 6; node = node.parentElement, depth += 1) {
      let group = same(node);
      if (group.length < 2) continue;
      if (controlCount(node) > group.length + 1) break;
      // Options laid out in columns: widen to the container that also holds the question.
      while (textAround(node, group).length < 3 && node.parentElement && node.parentElement !== document.body
             && controlCount(node.parentElement) <= same(node.parentElement).length + 1) {
        node = node.parentElement;
        group = same(node);
      }
      return group;
    }
    return named.length > 1 ? named : [el];
  }

  function groupQuestion(el) {
    const options = choiceGroup(el);
    for (let node = el.parentElement, depth = 0; node && node !== document.body && depth < 7; node = node.parentElement, depth += 1) {
      if (!options.every(option => node.contains(option))) continue;
      if (controlCount(node) > options.length + 1) return '';
      const text = textAround(node, options);
      if (text.length >= 3) return text.slice(0, 300);
    }
    return '';
  }

  // The question a control answers, as the user reads it on the page.
  function questionOf(el) {
    const legend = el.closest('fieldset') && el.closest('fieldset').querySelector('legend');
    const group = el.closest('[role="radiogroup"], [role="group"][aria-labelledby]');
    const field = el.closest('[data-automation-id^="formField"]');
    const fieldLabel = field && textOf(field.querySelector('label, legend'));
    if ((el.type === 'radio' || el.type === 'checkbox') && legend && textOf(legend)) return textOf(legend);
    if ((el.type === 'radio') && group && byIds(group.getAttribute('aria-labelledby'))) return byIds(group.getAttribute('aria-labelledby'));
    if (isDatePart(el) && fieldLabel) return fieldLabel;
    const own = [...(el.labels || [])].map(labelText).filter(Boolean).join(' ');
    if (own && el.type !== 'radio' && el.type !== 'checkbox') return own;
    const labelled = byIds(el.getAttribute('aria-labelledby'));
    if (labelled) return labelled;
    if (fieldLabel) return fieldLabel;
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const choice = el.type === 'radio' || el.type === 'checkbox';
    const around = choice ? groupQuestion(el) : '';
    if (around) return around;
    const wrap = el.closest('label');
    if (wrap && labelText(wrap)) return labelText(wrap);
    // A wrapper's label counts only when the wrapper holds this one field.
    for (let node = el.parentElement, depth = 0; node && depth < 3; node = node.parentElement, depth += 1) {
      if (node.querySelectorAll('input:not([type=hidden]), select, textarea, button[aria-haspopup]').length > 1) break;
      const label = node.querySelector('label, legend, .application-label');
      if (label && textOf(label)) return textOf(label);
    }
    return own || el.placeholder || '';
  }

  // The helper text between a field's label and the field: on some forms
  // (Ashby) the label is a title ("Values") and this is the real question.
  function detailOf(el) {
    const label = el.labels && el.labels[0];
    const next = label && label.nextElementSibling;
    if (!next || next === el || next.contains(el) || next.querySelector('input, select, textarea, button')) return '';
    const text = textOf(next);
    return text.length >= 20 && text.length <= 700 ? text : '';
  }

  // Extra hints (name, id, autocomplete) for matching, not for learning.
  const hintsOf = el => norm([questionOf(el), el.getAttribute('autocomplete'), el.name, el.id, el.placeholder,
                              el.getAttribute('data-automation-id')].filter(Boolean).join(' '));

  const isText = el => el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && ['text', 'email', 'tel', 'url', 'number', 'search', ''].includes((el.type || 'text').toLowerCase()));
  const isPrompt = el => el.tagName === 'INPUT' && (el.getAttribute('data-automation-id') === 'searchBox'
    || !!el.closest('[data-automation-id="multiselectInputContainer"]') || (el.getAttribute('role') === 'combobox' && el.getAttribute('aria-autocomplete') === 'list'));
  const isListbox = el => el.tagName === 'BUTTON' && el.getAttribute('aria-haspopup') === 'listbox';
  // Searchable dropdowns built with react-select (Greenhouse's new forms and
  // many others): a combobox input inside a "...__control" box.
  const comboControl = el => el.closest('.select__control, [class*="select__control"], [class*="-control"]');
  // Ashby's are a plain combobox input with its own arrow button beside it.
  const comboToggle = el => el.getAttribute('aria-haspopup') === 'listbox' && el.parentElement ? el.parentElement.querySelector('button') : null;
  const isCombo = el => el.tagName === 'INPUT' && el.getAttribute('role') === 'combobox' && !isPromptBox(el) && (!!comboControl(el) || !!comboToggle(el));
  const isPromptBox = el => el.getAttribute('data-automation-id') === 'searchBox' || !!el.closest('[data-automation-id="multiselectInputContainer"]');
  const placeholderText = s => /^(select( one)?|choose( one)?|please select|--.*|)$/.test(norm(s));

  // ---------- Acting like a person ----------
  function glow(el) {
    const target = el.closest('[data-automation-id^="formField"]') || el;
    const before = target.style.boxShadow;
    target.style.transition = 'box-shadow .4s ease';
    target.style.boxShadow = '0 0 0 3px rgba(16, 183, 127, .55)';
    setTimeout(() => { target.style.boxShadow = before; }, 2600);
  }

  // Real typing lands in whatever has focus, so it only happens once this field
  // truly has it. A field that can't take focus (just redrawn, hidden) gets its
  // value set directly, and the text can never end up in another box.
  function focusedOn(el) {
    el.focus({ preventScroll: true });
    let active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
    return active === el;
  }
  function insertText(el, value) {
    if (!focusedOn(el)) return false;
    try { el.select(); } catch (error) { /* some inputs can't select */ }
    try { return document.execCommand('insertText', false, value); } catch (error) { return false; }
  }

  // A search box: type the query and press Enter, the way a person searches
  // (Workday searches on Enter). No blur, which would clear the query first.
  function search(el, value) {
    if (!insertText(el, value) || el.value !== value) {
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

  // A place typed into a box with a suggestion list (Lever's location, Google's
  // place picker) only sticks once a suggestion is chosen: type it, nudge the
  // search with a key, and pick the suggestion that starts with the city.
  async function typeAndPick(el, value) {
    if (!insertText(el, value) || el.value !== value) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    for (const type of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: 'a', bubbles: true }));
    const city = norm(value.split(',')[0]);
    const suggestion = await waitFor(() => [...document.querySelectorAll('.dropdown-location, .pac-item, [role="option"]')]
      .find(option => visible(option) && !option.closest(chosenTag) && norm(textOf(option)).startsWith(city)), 4000);
    if (suggestion) {
      press(suggestion);
      await sleep(300);
    }
    return !!el.value.trim();
  }

  // Typed with insertText so React, Workday, and other frameworks see real input.
  function typeInto(el, value) {
    if (!insertText(el, value) || el.value !== value) {
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

  // A form's GPA bracket as [low, high]: "3.5 - 3.99", "3.5 and above", "Below 2.5", "4.0".
  const GPA_RANGE = /^(\d\.\d+) (?:to )?(\d\.\d+)$/;
  function gpaBracket(text) {
    const found = text.replace(/(\/|out of|on an?|scale of) ?[45](\.0+)?( scale)?/g, ' ').match(/\b[0-5](\.\d+)?\b/g);
    if (!found) return null;
    const [a, b] = found.map(Number);
    if (found.length > 1) return [Math.min(a, b), Math.max(a, b)];
    if (/below|under|less than|lower than|</.test(text)) return [0, a];
    if (/\+|above|over|higher|greater|more than|at least|>/.test(text)) return [a, 4];
    return [a, a];
  }
  // The bracket sharing most of the range, then the narrowest, then the lowest: a claim is never rounded up.
  function closestBracket(texts, low, high) {
    const ranked = texts.map(([candidate, t]) => ({ candidate, bracket: gpaBracket(t) })).filter(o => o.bracket)
      .map(o => ({ ...o, shared: Math.round((Math.min(high, o.bracket[1]) - Math.max(low, o.bracket[0])) * 100), width: o.bracket[1] - o.bracket[0] }))
      .filter(o => o.shared >= 0)
      .sort((a, b) => b.shared - a.shared || a.width - b.width || a.bracket[0] - b.bracket[0]);
    return ranked.length ? ranked[0].candidate : null;
  }

  // A date against a form's own list: the exact month, a range or
  // term holding it ("July 2028 - December 2028", "Spring 2029"), then the year.
  function closestDate(texts, year, month) {
    const months = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');
    const when = (y, m) => Number(y) * 12 + m;
    const wanted_ = when(year, month);
    const terms = { spring: [1, 5], summer: [6, 8], fall: [9, 12], autumn: [9, 12], winter: [12, 14] };
    const score = t => {
      const named = [...t.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,? (20\d{2})\b/g)].map(m => when(m[2], months.indexOf(m[1]) + 1));
      const numeric = [...t.matchAll(/\b(\d{1,2})\/(20\d{2})\b/g)].map(m => when(m[2], Number(m[1])));
      const dates = named.length ? named : numeric;
      if (dates.length === 1) return dates[0] === wanted_ ? 3 : 0;
      if (dates.length > 1) return wanted_ >= Math.min(...dates) && wanted_ <= Math.max(...dates) ? 2 : 0;
      const term = t.match(/\b(spring|summer|fall|autumn|winter)(?: of)? (20\d{2})\b/);
      if (term) return wanted_ >= when(term[2], terms[term[1]][0]) && wanted_ <= when(term[2], terms[term[1]][1]) ? 2 : 0;
      return new RegExp(`^(class of )?${year}$`).test(t) ? 1 : 0;
    };
    const top = texts.map(([candidate, t]) => [candidate, score(t)]).sort((a, b) => b[1] - a[1])[0];
    return top && top[1] ? top[0] : null;
  }
  const DATE_VARIANT = /^month of (\d{4}) (\d{2})$/;
  // "Did not obtain high school diploma" never answers "High School Diploma".
  const saysNo = t => /^(did not|didn.t|do not|don.t|not |no |never |without |none)/.test(t);

  // Exact match first; short answers like "No" never match "North Carolina".
  // Strict matching (schools, majors, states) also refuses a longer, different
  // name: "Computer Science" never picks "Computer Science and Engineering
  // Technology", "Virginia" never picks "West Virginia".
  function best(candidates, variants, label = optionLabel, strict = false) {
    const texts = candidates.map(c => [c, norm(label(c))]);
    const shortest = hits => hits.sort((a, b) => a[1].length - b[1].length)[0];
    for (const variant of variants.map(norm).filter(Boolean)) {
      const range = variant.match(GPA_RANGE);
      if (range) {
        const bracket = closestBracket(texts, Number(range[1]), Number(range[2]));
        if (bracket) return bracket;
        continue;
      }
      const dated = variant.match(DATE_VARIANT);
      if (dated) {
        const option = closestDate(texts, Number(dated[1]), Number(dated[2]));
        if (option) return option;
        continue;
      }
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
        || (!short && texts.find(([, t]) => t.includes(variant) && (!saysNo(t) || saysNo(variant))))
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
        if (saysNo(t) && !saysNo(variant)) continue;
        const have = words(t);
        const shared = [...want].filter(w => have.has(w)).length;
        const ratio = shared / Math.max(1, Math.min(want.size, have.size));
        if (shared >= 2 && ratio >= 0.6 && ratio > score) { top = candidate; score = ratio; }
      }
    }
    return top;
  }

  // "How did you hear about us?": an option that starts with the answer
  // ("Campus Recruiting"), or a short one naming it, never a specific event
  // somewhere else ("Singapore HP Campus Week").
  const heardPick = (options, values, label = optionLabel) => best(options, values, label, 'prefix')
    || best(options.filter(o => norm(label(o)).split(' ').length <= 3), values, label);
  const pickFor = (options, want, label = optionLabel) => want.key === 'heard_about' ? heardPick(options, want.values, label) : best(options, want.values, label, want.strict);

  let current = null;     // the answer being filled, so the review can say where it came from
  let pageNow = '';
  // One review line per question on a page; a refill or a second press replaces it.
  function record(item) {
    const at = state.items.findIndex(old => old.page === item.page && old.question === item.question);
    if (at >= 0) state.items[at] = item; else state.items.push(item);
  }
  const filledEls = new Map();   // this page's review lines → the field each one filled
  function note(el, question, value = '') {
    handled.add(el);
    filledEls.set(String(question).replace(/[*✱]\s*$/, '').trim().slice(0, 160), { el, value: String(value || '') });
    state.filled.push(norm(question).slice(0, 60));
    const shown = String(value || '').replace(/\s+/g, ' ').trim();
    record({ page: pageNow, question: String(question).replace(/[*✱]\s*$/, '').trim().slice(0, 160), value: shown.slice(0, 300), flag: flagFor(current, shown) });
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
    let match = options && (pickFor(options, want) || (options.length > 7 && await scrollFor(options, want.values, want.strict)));
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
        let match = pickFor(options, want);
        // Inside a category the user didn't name, only a general option fits.
        if (!match && want.browse && depth > 0) match = best(options, ['Other', 'General', 'United States', 'Online', 'Virtual'], optionLabel, 'prefix');
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

  // A react-select dropdown opens from its arrow button (typing alone doesn't
  // open it); its options are role="option" with ids built from the input's.
  const comboValue = el => {
    const control = comboControl(el);
    const shown = control && control.querySelector('[class*="singleValue"], [class*="single-value"], [class*="multiValue"] [class*="label"], [class*="multi-value__label"]');
    return shown ? textOf(shown) : control ? '' : el.value.trim();
  };
  // With `readOnly`, opens the dropdown, returns its option labels, and closes it.
  async function pickCombo(input, want, question, readOnly = false) {
    if (comboValue(input)) return readOnly ? [] : false;
    const control = comboControl(input) || input.parentElement;
    const shell = control.parentElement && control.parentElement.parentElement || control;
    // Its options carry its instance id ("react-select-2-option-0" or
    // "react-select-question_123-option-0"), named in the input's aria links.
    const links = [input.getAttribute('aria-controls'), input.getAttribute('aria-owns'), input.getAttribute('aria-describedby'), `react-select-${input.id}-listbox`].join(' ');
    const instance = (links.match(/react-select-(.+?)-(listbox|placeholder|live-region)\b/) || [])[1];
    const own = () => [...document.querySelectorAll('[role="option"], [class*="__option"]')].filter(o => shown(o) && !o.closest(chosenTag) && !/iti__/.test(o.className)
      && !o.querySelector('[role="option"], [class*="__option"]') && (instance && o.id.startsWith('react-select-') ? o.id.startsWith(`react-select-${instance}-option`) : shell.contains(o) || !o.id.startsWith('react-select-')));
    const open = async () => {
      if (input.getAttribute('aria-expanded') === 'true' && own().length) return true;
      const toggle = shell.querySelector('button[aria-label*="flyout" i], button[aria-label*="toggle" i], [class*="dropdown-indicator"], [class*="dropdownIndicator"], [class*="indicatorContainer"], [class*="indicator-container"]');
      if (toggle || comboToggle(input)) press(toggle || comboToggle(input));
      if (!(await waitFor(() => input.getAttribute('aria-expanded') === 'true', 700))) {
        input.focus();
        press(control);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true }));
      }
      return !!(await waitFor(() => input.getAttribute('aria-expanded') === 'true' || own().length, 1500));
    };
    const settle = async previous => {
      let last = '', same = 0;
      return await waitFor(() => {
        const options = own();
        const key = options.map(optionLabel).join('|');
        same = key && key === last && key !== previous ? same + 1 : 0;
        last = key;
        return same >= 1 ? options : null;
      }, 3000);
    };
    const take = async options => {
      const match = options && pickFor(options, want);
      if (!match) return '';
      const label = optionLabel(match);
      press(match);
      return (await waitFor(() => norm(comboValue(input)).includes(norm(label).slice(0, 20)) || !input.isConnected, 1200)) ? label : '';
    };
    if (!(await open())) return readOnly ? [] : false;
    // Short lists (Yes/No, months): read them as they are. Long ones: search.
    let options = await settle(null);
    if (readOnly) {
      const labels = (options || []).map(optionLabel);
      if (input.getAttribute('aria-expanded') === 'true') escape(input);
      await sleep(150);
      return labels;
    }
    let picked = await take(options);
    for (const term of (want.search || want.values).filter(Boolean).slice(0, 3)) {
      if (picked) break;
      const before = (options || []).map(optionLabel).join('|');
      if (!input.isConnected && input.id) input = document.getElementById(input.id) || input;   // redrawn when it opened
      if (!insertText(input, term)) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, term);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      options = await settle(before);
      picked = await take(options);
      if (!picked && focusedOn(input)) {
        input.select();
        document.execCommand('delete');
      }
    }
    if (input.getAttribute('aria-expanded') === 'true') escape(input);
    if (!picked) return false;
    note(input, question, picked);
    return true;
  }

  function pickSelect(select, variants, question, strict = false) {
    const options = [...select.options].filter(o => !placeholderText(o.textContent) && o.value !== '');
    const match = current && current.key === 'heard_about' ? heardPick(options, variants, o => o.textContent) : best(options, variants, o => o.textContent, strict);
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
  // Workday shows each part's value in a "-display" element over the input.
  const partDisplay = part => (part.closest('[data-automation-id="dateInputWrapper"]') || part.parentElement)
    .querySelector(`[data-automation-id="${(part.getAttribute('data-automation-id') || '').replace(/-input$/, '-display')}"]`);
  const datePartValue = part => {
    const display = partDisplay(part);
    const shown = display ? textOf(display) : '';
    return String(part.value || part.getAttribute('aria-valuenow') || (/^\d+$/.test(shown) ? shown : '')).trim();
  };
  // One part of a Workday date, typed the way a person types: click the date,
  // press each digit (its boxes take key presses), and only if that didn't
  // take, insert the text.
  async function typeDatePart(part, value) {
    const display = partDisplay(part);
    press(display && visible(display) ? display : part);
    focusedOn(part);
    for (const digit of value) {
      const code = 48 + Number(digit);
      for (const type of ['keydown', 'keypress', 'keyup']) {
        const event = new KeyboardEvent(type, { key: digit, code: `Digit${digit}`, keyCode: code, which: code, charCode: type === 'keypress' ? code : 0, bubbles: true, cancelable: true });
        for (const name of ['keyCode', 'which']) if (event[name] !== code) Object.defineProperty(event, name, { get: () => code });
        part.dispatchEvent(event);
      }
    }
    await sleep(60);
    if (Number(datePartValue(part)) === Number(value)) return;
    if (!insertText(part, value) || Number(part.value) !== Number(value)) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(part, value);
      part.dispatchEvent(new Event('input', { bubbles: true }));
    }
    part.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // `fix` also corrects parts that hold a different date (Workday's resume reader).
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  async function fillDate(el, formats, question, fix = false) {
    if (!formats || !formats.year) return false;
    // One part of a date ("Start date month", "End date year"), as the field asks for it.
    const q = norm(String(question).replace(/^(work experience|education) \d+ /i, ''));
    const part = /month( and |\/)year/.test(q) ? '' : /\bmonth$/.test(q) ? 'month' : /\byear$|graduation year|year of graduation/.test(q) ? 'year' : /\bday$/.test(q) ? 'day' : '';
    if (el.tagName === 'SELECT' || isCombo(el) || isListbox(el)) {
      const month = MONTHS[Number(formats.month) - 1] || '';
      const values = part === 'month' ? [month, month.slice(0, 3), formats.month, String(Number(formats.month))]
        : part === 'year' ? [formats.year] : part === 'day' ? [formats.day, String(Number(formats.day))]
        : [formats.mm_dd_yyyy, formats.mm_yyyy, `month of ${formats.year} ${formats.month}`, formats.year];
      return fillControl(el, question, { values, strict: true });
    }
    if (part && isText(el) && !el.value.trim()) {
      const value = part === 'month' ? formats.month : part === 'year' ? formats.year : formats.day;
      typeInto(el, value);
      note(el, question, value);
      return true;
    }
    if (isDatePart(el)) {
      const parts = datePartsNear(el);
      const names = ['month', 'day', 'year'].filter(name => parts[name]);
      const wantedDate = names.map(name => formats[name]).join('/');
      let any = false;
      for (const name of names) {
        const part = parts[name], value = formats[name], now = datePartValue(part);
        handled.add(part);
        if (!value || (now && (!fix || Number(now) === Number(value)))) continue;
        if (now) current = { ...current, replace: true };
        await typeDatePart(part, value);
        any = true;
      }
      if (!any) return false;
      // Commit it the way leaving the field does, then read back what the page shows.
      const last = parts[names[names.length - 1]];
      last.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
      last.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      if (document.activeElement && isDatePart(document.activeElement)) document.activeElement.blur();
      await sleep(250);
      if (names.every(name => Number(datePartValue(parts[name])) === Number(formats[name]))) note(el, question, wantedDate);
      else record({ page: pageNow, question: String(question).replace(/[*✱]\s*$/, '').trim().slice(0, 160), value: '', flag: `The date box didn't take ${wantedDate}. Type it in` });
      return true;
    }
    const type = (el.type || '').toLowerCase();
    // A format the question spells out ("Please answer in MM/YYYY format") wins.
    const asked = (String(question).match(/\b(mm\/dd\/yyyy|mm\/yyyy|mm-yyyy|mm yyyy|month and year|month\/year)\b/i) || [])[1] || '';
    const shape = norm(asked || el.placeholder || el.getAttribute('aria-label') || '');
    const value = type === 'date' ? formats.iso : type === 'month' ? formats.iso_month
      : /mm dd yyyy|mm\/dd\/yyyy|dd/.test(shape) ? formats.mm_dd_yyyy
      : /mm yyyy|mm\/yyyy|month and year|month\/year/.test(shape) ? formats.mm_yyyy
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
    ['name', /full name|your name|legal name|^name$/, [p.name]],
    ['address', /address line 1|street address|address 1|^address$|^(mailing|home|current|permanent|residential) address( line 1)?$/, [p.address]],
    // "Current location": city and state together.
    ['location', /^(current )?location$|where are you (currently )?(located|based)|^city,? state$/, [[p.city, p.state].filter(Boolean).join(', ')]],
    ['city', /(^| )city( |$)|town/, [p.city]], ['state', /(^| )state( |$)|province|region/, p.state_options || [p.state], { strict: true }],
    ['postal', /zip|postal code|postcode|^postal$/, [p.postal_code]],
    // The school field itself, never any label that mentions one ("Technical Accomplishments - School/Internships").
    ['school', /(which|what) (university|school|college|institution) (are|do|will|did)|^(current |name of (your )?)?(school|university|college|institution)( name| attended)?$|school or university|college\/university|university\/college|(school|university|college) (name|attended|attending|enrolled)|(which|what) (school|university|college)|(school|university|college).{0,50}(enrolled|attend|study|studying|graduat)|name of (your )?(school|university|college|institution)/,
     schoolNames, { strict: true, search: schoolSearch(schoolNames) }],
    ['field', /field of study|area of study|\bmajors?\b|academic discipline/, school.field_options || [], { strict: true, search: [school.field] }],
    // The degree itself, not any question that mentions one ("credit hours toward your degree").
    ['degree', /^(highest |type of |current )?degree( type| level| earned| obtained| pursuing| sought)?$|(what|which) degree|degree (type|level)|type of degree/, [school.degree || p.degree, p.degree, ...(school.degree_options || [])]],
  ];
  // Other people's details, and second contacts ("Alternate Phone Number") the user has none of.
  const otherPeople = /\breferences?\b|emergency|supervisor|manager|guardian|parent|spouse|high school|extension|\breferr(al|er|ed) (name|email|by)|\b(alternate|alternative|secondary|additional|backup) (phone|email|contact|number)/;
  // A start date at a past job ("Government Civilian Start Date") is not the user's to invent.
  const pastJob = /government|military|civilian|clearance|served|service|former|previous|prior/;
  const startDate = /(start|availability|available|work) date|(preferred|desired) (start|work) (month|time)|when can you (start|begin)|earliest (start|date)|proposed start|date (you are )?available/;
  const graduationDate = /when .{0,25}graduate|anticipated graduation|graduation date|(expected|anticipated|projected) graduation|graduation (month|year|term)|date of graduation|completion date/;
  // Marketing's exception: contact a form requires, about this application.
  const aboutThisApplication = /(regarding|about|related to|concerning|for) (my|your|this|the) (application|candidacy|interview)/;
  // Optional boxes that give data away are left for the user.
  const optionalSharing = /third part|affiliate|partner|share my|sell my|retain|retention|additional \d+ years?|future/;
  const AGREE = ['Yes', 'I agree', 'Agree', 'I consent', 'I accept', 'Accept', 'I acknowledge', 'Acknowledge', 'I understand', 'True'];
  const consent = /agree|certif|acknowledg|consent|terms|attest|privacy|i understand|authori[sz]e (us|the company|.* to contact)|process (my |your )?personal (information|data)|data processing/;
  // Optional sign-ups that are never ticked, even with "agree to terms" on.
  const marketing = /newsletter|marketing|promotion|sms|text message|texts|job alerts?|updates|subscribe|talent (community|network|pool)|future (opportunities|roles|openings)|other (roles|positions|opportunities)|contact me about/;
  const todayDate = /^(today'?s )?date$|^date signed$|^signature date$/;
  // "gemma4:12b" → "Gemma"
  const modelName = (plan.model || '').split(':')[0].replace(/[\d.-]+$/, '').replace(/^[a-z]/, letter => letter.toUpperCase()) || 'The local model';
  // While true, essay boxes are left for the local model to draft; the
  // templates below fill whatever it doesn't.
  let holdDrafts = false;
  const salaryAsk = /salary|compensation|pay (expectation|requirement|rate|range)|desired (pay|rate|wage)|hourly rate|expected (pay|wage|rate)/;
  // Questions that want a few sentences, and boxes that are only for extra notes.
  const essayPrompt = /\b(describe|tell us|tell me|explain|share|discuss|what|how|why|example|a time|which of)\b/;
  // A resume story answers these. "What do you hope to learn?" it doesn't, and a wrong draft is worse than a blank.
  const storyPrompt = /\b(experience|project|a time|an example|built|worked on|challeng|proud|accomplish|achievement)\b/;
  const CODE_LANGUAGE = /^(python|java|javascript|typescript|c\+\+|c#|c|go|golang|rust|kotlin|swift|ruby|php|sql|r|matlab|scala|bash)$/i;
  const sideNote = /additional (information|comments|details)|anything else|comments?$|notes?$|accommodat|if (yes|no|so|other|you (answered|selected))|^if\b.{0,80}(provide|specify|explain|elaborate)|more details/;

  // The job or project from the resume that fits an essay question best.
  function storyFor(q) {
    const stories = plan.stories || [];
    const prefer = /team|collaborat|group|others/.test(q) ? /team|co authored|with /
      : /challeng|difficult|problem|obstacle|fail|mistake|bug|hard/.test(q) ? /bug|fix|debug|problem|issue|prevent/ : null;
    let top = null, score = -1;
    for (const story of stories) {
      const text = norm(story.text);
      let points = [...tokens(q)].filter(word => word.length > 3 && text.includes(word)).length;
      if (prefer && prefer.test(text)) points += 3;
      if (/project|built|build|made/.test(q) && story.kind === 'project') points += 2;
      if (points > score) { top = story; score = points; }
    }
    return top ? top.text : '';
  }

  // "Describe your C++ experience": what the resume shows, or plainly that it shows none.
  function skillExperience(q) {
    const found = q.match(/describe your (.{1,30}?) experience|experience (?:with|in|using) ([a-z0-9+#.]{1,20})(?:$| )/);
    const name = found ? (found[1] || found[2] || '').trim() : '';
    if (!name || /work|relevant|professional|technical|previous|past|prior|leadership|research|internship|team|the|this|our|a /.test(name + ' ')) return '';
    const stories = plan.stories || [];
    const known = (plan.skills || []).find(skill => norm(skill) === name);
    const shown = known || name.replace(/(^| )[a-z]/g, letter => letter.toUpperCase());
    const mentions = new RegExp(`(^|[^a-z0-9+#])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9+#]|$)`, 'i');
    const story = stories.find(item => mentions.test(item.text));
    if (story) return `I've used ${shown} in real work. ${story.text}`;
    if (known) return `I've used ${shown} in my projects.${stories[0] ? ' ' + stories[0].text : ''}`;
    const top = (plan.skills || []).slice(0, 3);
    const most = top.length > 1 ? `${top.slice(0, -1).join(', ')} and ${top[top.length - 1]}` : top[0] || '';
    return `I haven't used ${shown} in a project yet.${most ? ` Most of my work so far has been in ${most}.` : ''}${stories[0] ? ' ' + stories[0].text : ''}`;
  }
  // Self-identification: the user's Profile answer, or the form's decline option.
  function disclosureFor(text) {
    const q = norm(text);
    const found = (plan.disclosures || []).find(d => new RegExp(d.pattern, 'i').test(q));
    if (!found) return null;
    // "Ethnicity" is sometimes only "Hispanic or Latino / Not Hispanic or Latino".
    const hispanic = found.key === 'eeo_race' ? (plan.disclosures || []).find(d => d.key === 'eeo_hispanic') : null;
    const values = found.options.concat(hispanic && !hispanic.declined ? hispanic.options.filter(o => /hispanic/i.test(o)) : []);
    return { values, source: 'disclosure', strict: 'prefix', declined: !!found.declined, typed: found.key === 'eeo_pronouns' && !found.declined };
  }
  // Why a value deserves a second look in the review, if it does.
  function flagFor(want, value) {
    if (!want) return '';
    if (want.replace) return "Replaced the text Workday read from your resume with your resume's own";
    if (want.source === 'disclosure') return want.declined ? 'Chose the decline option for you' : 'Your self-identification answer from Profile';
    if (want.source === 'learned') return 'From an answer you gave on an earlier application';
    if (want.source === 'draft') return want.loose ? "Starting point from your resume. It doesn't answer the question yet: rewrite it" : 'Draft from your resume. Read it and make it yours';
    if (want.source === 'presumed') return "Standard answer picked for you. Change it if it's wrong";
    if (want.source === 'model') return want.essay ? `Draft written by ${modelName} on this Mac from your resume. Read it and make it yours` : `Picked by ${modelName} on this Mac. Check it`;
    if (want.source === 'salary') return 'Salary answer picked for you. Change it if you want something else';
    if (want.source === 'terms') return 'Ticked for you. Read what you agreed to before you submit';
    if (want.source === 'signature') return 'Signed with your name for you. Read what it certifies before you submit';
    if (want.source === 'neutral') return `No saved answer, so Apply Desk picked "${value}". Check it`;
    if (want.source === 'no_linkedin') return "You don't share LinkedIn, so this says N/A";
    if (want.key === 'gpa' && p.gpa_range && (want.floor || gpaBracket(norm(value)))) return 'From the GPA range in your Profile. Check it before you submit';
    if (want.open && want.key !== 'location_preference') return /^yes\b/i.test(value) ? '' : "You said you're open to all locations. Change this if you'd rather not";
    if (want.key === 'location_preference') return want.open ? "You said you're open to all locations. Change this if you'd rather not" : '';
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

  // "Are you graduating between December 2027 and June 2028?" → "Yes"/"No"
  // from the user's own graduation date.
  function graduatingBetween(q) {
    const grad = p.graduation_dates || {};
    const found = q.match(/graduat\w* (?:between|from) ([a-z]+) (\d{4}) (?:and|to|through) ([a-z]+) (\d{4})/);
    if (!found || !grad.year) return '';
    const month = name => MONTHS.findIndex(m => m.toLowerCase().startsWith(name.slice(0, 3))) + 1;
    const at = (y, m) => Number(y) * 12 + m;
    const when = at(grad.year, Number(grad.month || 1));
    if (!month(found[1]) || !month(found[3])) return '';
    return when >= at(found[2], month(found[1])) && when <= at(found[4], month(found[3])) ? 'Yes' : 'No';
  }

  // "Do you have a GPA of 3.0 or higher?" → Yes or No, only when the user's range settles it.
  function gpaFloor(q) {
    const range = norm(p.gpa_range).match(GPA_RANGE);
    if (!range || !/\bgpa\b|grade point/.test(q)) return '';
    const found = q.match(/(?:at least|minimum(?: of)?|above|over|greater than|exceed\w*) (?:an? )?(?:cumulative |overall )?(?:gpa )?(?:of )?([0-5]\.\d+)|([0-5]\.\d+) ?(?:\/ ?4(?:\.0+)? ?)?(?:cumulative |overall )?(?:gpa )?(?:\+|or (?:higher|above|better|greater)|and above)/);
    if (!found) return '';
    const minimum = Number(found[1] || found[2]);
    return Number(range[1]) >= minimum ? 'Yes' : Number(range[2]) < minimum ? 'No' : '';
  }

  // Returns {values, date} for a field, or null to leave it alone.
  function wanted(el, question) {
    const q = norm(question);
    if (!q) return null;
    const disclosure = disclosureFor(q);
    if (disclosure) return disclosure;
    // A signature box, signed with the user's name only when they turned that on.
    if (plan.agree_terms && p.name && isText(el) && /\b(e.?)?signature\b|sign (here|your (full )?name)|type your (full )?name/.test(q) && !/date/.test(q)) {
      return { values: [p.name], source: 'signature' };
    }
    // Salary: "Negotiable" (or the posting's stated pay), and a number only when the posting gives one.
    if (salaryAsk.test(q) && plan.salary && !/history|current|previous|last/.test(q)) {
      const numeric = el.type === 'number' || /numbers? only|numeric|digits only/.test(q);
      if (isText(el) && !numeric) return { values: [plan.salary.text], source: 'salary' };
      const amount = /hour/.test(q) ? plan.salary.hourly : plan.salary.annual;
      return isText(el) && amount ? { values: [String(amount)], source: 'salary' } : null;
    }
    if (never.test(q)) return null;
    // What the user chose on a form for this exact question beats every rule below.
    const chosen = (plan.learned || []).find(learned => norm(learned.question) === q);
    if (chosen) return { values: chosen.answer.split(/;\s*/), source: 'learned' };
    if (el.tagName !== 'TEXTAREA' && startDate.test(q) && !pastJob.test(q)) return { date: plan.start, source: 'date' };
    if (el.tagName !== 'TEXTAREA' && todayDate.test(q) && plan.today) return { date: plan.today, source: 'date' };
    if (el.tagName !== 'TEXTAREA' && graduationDate.test(q) && !/high school/.test(q)) {
      const dated = p.graduation_dates || {};
      const picks = el.tagName === 'SELECT' || isListbox(el) || isCombo(el) || el.type === 'radio' || el.tagName === 'BUTTON';
      return picks ? { values: [`month of ${dated.year} ${dated.month}`], source: 'date' } : { date: dated, source: 'date' };
    }
    const window_ = graduatingBetween(q);
    if (window_) return { values: [window_], source: 'answer' };
    const floor = gpaFloor(q);
    if (floor && (!isText(el) || isCombo(el) || isPrompt(el))) return { values: [floor, p.gpa_range], source: 'answer', key: 'gpa', floor: true };
    // A standard question owns its question; when its answer is blank, only
    // something the user answered on an earlier form can fill it.
    let claimed = false;
    for (const answer of plan.answers || []) {
      if (!new RegExp(answer.pattern, 'i').test(q)) continue;
      if (!answer.answer) { claimed = true; break; }
      // A text box asking which location gets the listing's own place.
      if (answer.text && isText(el) && !isCombo(el) && !isPrompt(el)) return { values: [answer.text], source: 'answer', key: answer.key };
      return { values: answer.options.length ? answer.options : [answer.answer], source: 'answer', key: answer.key, open: !!answer.open,
               browse: answer.key === 'heard_about' || !!answer.open };
    }
    for (const learned of plan.learned || []) {
      if (norm(learned.question) === q || similar(learned.question, q) >= 0.8) return { values: learned.answer.split(/;\s*/), source: 'learned' };
    }
    if (claimed) return null;
    // Screening questions with one sensible answer for the user's profile.
    for (const answer of plan.presumed || []) {
      if (!new RegExp(answer.pattern, 'i').test(q)) continue;
      const number = answer.number && isText(el) && (el.type === 'number' || /^how many|number of years/.test(q));
      return { values: number ? [answer.number] : answer.options, source: answer.assumed ? 'presumed' : 'answer', key: answer.key };
    }
    // A required consent question with choices ("Yes, I consent"), once the user agreed to terms in Profile.
    if (plan.agree_terms && (!isText(el) || isCombo(el)) && consent.test(q) && !marketing.test(q) && isRequired(el, question)) {
      return { values: AGREE, source: 'terms', strict: 'prefix' };
    }
    // Questions that need writing get a draft from the user's own resume lines.
    if (el.tagName === 'TEXTAREA' || isText(el)) {
      const draft = (plan.drafts || []).find(d => new RegExp(d.pattern, 'i').test(q));
      // Dates, a cover letter, and the user's own plans keep their rule-written
      // form (a model would guess intentions); other essays wait for the model when it's on.
      if (draft && holdDrafts && el.tagName === 'TEXTAREA' && !['availability', 'cover', 'plans'].includes(draft.key)) return null;
      if (draft) return { values: [el.tagName === 'TEXTAREA' ? draft.text : draft.short || draft.text], source: 'draft' };
    }
    if (otherPeople.test(q)) return null;
    if (isText(el) && /(programming|coding) languages?/.test(q)) {
      const languages = (plan.skills || []).filter(skill => CODE_LANGUAGE.test(skill.replace(/\s*\(.*\)/, '')));
      if (languages.length) return { values: [languages.join(', ')], source: 'profile' };
    }
    // A one-line question in a big box ("What is your preferred name?") is still that question.
    const contactInBigBox = el.tagName === 'TEXTAREA' && q.length < 60 && contact.some(([, pattern]) => pattern.test(q));
    if (el.tagName === 'TEXTAREA' && !sideNote.test(q) && !contactInBigBox) {
      const skill = skillExperience(q);
      const story = !skill && essayPrompt.test(q) && storyPrompt.test(q) && !/not on your resume/.test(q) ? storyFor(q) : '';
      if (skill) return { values: [skill], source: 'draft' };
      if (story && holdDrafts) return null;
      if (story) return { values: [story], source: 'draft', loose: true };
    }
    if (/\bwhy\b|describe|statement|cover letter|tell us|explain/.test(q)) return null;
    const hints = el.closest ? hintsOf(el) : q;
    for (const [field, pattern, values, how] of contact) {
      if (field === 'state' && /\bcounty\b/.test(q)) continue;  // Workday's county field has "region" in its name
      if (pattern.test(q) || pattern.test(hints)) {
        const usable = values.filter(Boolean);
        if (field === 'school' && /\bother\b/.test(q)) usable.push('Other (School Not Listed)', 'Other');
        return usable.length ? { ...how, field, values: usable, source: 'profile' } : null;
      }
    }
    return null;
  }

  async function fillControl(el, question, want) {
    stopCheck();
    if (!want) return false;
    current = want;
    try {
      if (want.date) return fillDate(el, want.date, question, want.fix);
      // The Profile's GPA range answers only a required GPA list with no N/A; an optional one stays blank.
      const optionalGpa = want.key === 'gpa' && !want.floor && !isRequired(el, question);
      const values = want.values.filter(value => value && !(optionalGpa && GPA_RANGE.test(norm(value))));
      if (!values.length) return false;
      if (el.tagName === 'SELECT') return pickSelect(el, values, question, want.strict);
      if (isListbox(el)) return await pickListbox(el, { ...want, values }, question);
      if (isCombo(el)) return await pickCombo(el, { ...want, values }, question);
      if (isPrompt(el)) return selectedPills(el).length ? false : await pickPrompt(el, { ...want, values }, question);
      // Self-identification answers are picked from the form's options, never typed (pronouns are often a text box).
      if (want.field === 'location' && isText(el) && !el.value.trim()) {
        if (!(await typeAndPick(el, values[0]))) return false;
        note(el, question, el.value);
        return true;
      }
      if ((isText(el) || (el.tagName === 'TEXTAREA' && want.source === 'draft')) && (!el.value.trim() || want.replace) && (want.source !== 'disclosure' || want.typed)) {
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
  // Hidden traps for bots ("honeypot", "leave this blank", a box moved off
  // screen): filling one marks the application as spam, so they're never touched.
  const isTrap = el => isText(el) && el.getAttribute('role') !== 'combobox' && (/honeypot|hp[-_]?field|bot[-_]?(trap|check)|leave (this|it) (field )?(blank|empty)|do not (fill|enter)/i
    .test([el.name, el.id, el.className, el.getAttribute('aria-label'), el.placeholder, ...[...(el.labels || [])].map(textOf)].join(' '))
    || (rect => rect.right + scrollX <= 0 || rect.bottom + scrollY <= 0 || rect.left + scrollX >= document.documentElement.scrollWidth + 500
      || (rect.width <= 2 && rect.height <= 2))(el.getBoundingClientRect())
    || el.getAttribute('tabindex') === '-1' && el.getAttribute('aria-hidden') === 'true');
  // Workday draws its date boxes (month, day, year) as tiny inputs under the date
  // it shows, so they're judged by that shown date, never taken for bot traps.
  const dateWrapper = el => el.closest('[data-automation-id="dateInputWrapper"]') || el.parentElement;
  const controlsIn = root => [...root.querySelectorAll('input:not([type=hidden]):not([type=file]), select, textarea, button[aria-haspopup="listbox"]')]
    .filter(el => !el.disabled && !el.readOnly && (isDatePart(el) ? visible(dateWrapper(el)) : visible(el) && !isTrap(el)));

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
      // An entry starts at a field you type or pick in, never at a Yes/No
      // question that mentions a university ("...GPA at your university?").
      if (el.type === 'radio' || el.type === 'checkbox' || !firstField.test(norm(questionOf(el)))) continue;
      let block = el.parentElement;
      while (block && block !== section && !controlsIn(block).some(other => other !== el && secondField.test(norm(questionOf(other))))) block = block.parentElement;
      if (block && !blocks.includes(block)) blocks.push(block);
    }
    return blocks;
  }

  // Without a section heading, only a small group of entry fields with short
  // labels ("School", "Degree", "Discipline") counts, never a long question
  // that mentions a school ("Which school will you attend during the internship?").
  const entryBlocks = (root, firstField, secondField) => blocksIn(root, firstField, secondField)
    .filter(block => controlsIn(block).length <= 12 && controlsIn(block).some(el => firstField.test(norm(questionOf(el))) && norm(questionOf(el)).length <= 40));

  const addButton = section => [...section.querySelectorAll('button, [role="button"]')]
    .filter(visible).find(b => /^(\+\s*)?add( another)?\b/i.test(textOf(b) || b.getAttribute('aria-label') || ''));

  // The school field itself, never one that only mentions a school
  // ("Technical Accomplishments - School/Internships", "High School Name").
  const SCHOOL_FIELD = /^(?!.*(high school|secondary school|accomplishment|internship|club|activit|award|honor)).*(school|university|college|institution)/;
  // Only Workday reads the resume into its own fields.
  const workdayForm = () => !!document.querySelector('[data-automation-id]');
  const squash = text => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const fingerprint = text => { let hash = 0; for (const c of squash(text)) hash = (hash * 31 + c.charCodeAt(0)) | 0; return hash; };
  const entryLabel = (kind, i, el) => `${kind === 'experience' ? 'Work experience' : 'Education'} ${i + 1}: ${questionOf(el).replace(/[*✱]\s*$/, '')}`;
  async function fillBlocks(kind, entries) {
    if (!entries || !entries.length) return;
    const first = kind === 'experience' ? /job title|position title|^title$|role title/ : SCHOOL_FIELD;
    const second = kind === 'experience' ? /company|employer|organization/ : /degree|field of study|major/;
    // Greenhouse shows its school fields with no "Education" heading: the page
    // itself is the section when a school field sits beside a degree field.
    const section = sectionFor(kind === 'experience' ? /^(work )?experience|^employment( history)?|^work history/ : /^education/)
      || (kind === 'education' && entryBlocks(document.body, first, second).length ? document.body : null);
    if (!section) return;
    const find = section === document.body ? entryBlocks : blocksIn;
    let blocks = find(section, first, second);
    // Entries are added once per page; a later pass or press only fills what's there.
    const addKey = `${pageNow}|${kind}`;
    // (An empty section is a fresh form, not entries the user deleted.)
    for (let guard = run.adds[addKey] && blocks.length ? Infinity : 0; blocks.length < entries.length && guard <= entries.length; guard += 1) {
      const add = addButton(section);
      if (!add) break;
      const before = blocks.length;
      press(add);
      await waitFor(() => find(section, first, second).length > before, 3000);
      blocks = find(section, first, second);
    }
    run.adds[addKey] = true;
    // Before touching anything, note what every field holds. A field that still
    // holds that later hasn't been edited by the user since.
    blocks.slice(0, entries.length).forEach((block, i) => controlsIn(block).forEach(el => {
      const label = entryLabel(kind, i, el);
      if (!(label in run.first)) run.first[label] = fingerprint(el.value);
    }));
    saveRun();
    for (let i = 0; i < Math.min(blocks.length, entries.length); i += 1) {
      const entry = entries[i];
      for (const el of controlsIn(blocks[i])) {
        if (handled.has(el)) continue;
        const q = norm(questionOf(el));
        const label = entryLabel(kind, i, el);
        let want = null;
        if (kind === 'experience') {
          if (el.type === 'checkbox') {
            if (/current/.test(q) && entry.current && !el.checked) { press(el); note(el, label, 'Yes'); }
            handled.add(el);
            continue;
          }
          want = /job title|position|^title$|role title/.test(q) ? { values: [entry.title] }
            : /location|city/.test(q) ? { values: [entry.location] }
            : /country|state|province|zip|postal|phone|address/.test(q) ? null
            : /company|employer|organization/.test(q) ? { values: [entry.company] }
            : /^from|start/.test(q) ? { date: entry.start }
            : /^to\b|^to$|end/.test(q) ? (entry.current ? null : { date: entry.end })
            : el.tagName === 'TEXTAREA' || /description|responsibilit|summary|duties/.test(q) ? { values: [entry.description] } : null;
        } else {
          // Choices (Yes/No, "What degree are you pursuing?") go to the answers below.
          if (el.type === 'radio' || el.type === 'checkbox') continue;
          const names = entry.school_options && entry.school_options.length ? entry.school_options : [entry.school];
          // Dates first: "When did you begin your current degree program?" is a date, not a degree.
          want = /when did you (begin|start)|(start|begin)(ning)? (date|month|year)|^from\b|^start/.test(q) ? { date: entry.start }
            : /when (do|will) you (expect to )?(complete|graduate|finish)|^to\b|^end|graduat|expected|complet/.test(q) ? { date: entry.end }
            : SCHOOL_FIELD.test(q) ? { values: names, strict: true, search: schoolSearch(names) }
            : /degree/.test(q) ? { values: entry.degree_options.length ? entry.degree_options : [entry.degree] }
            : /field of study|major|discipline/.test(q) ? { values: entry.field_options && entry.field_options.length ? entry.field_options : [entry.field], strict: true, search: [entry.field] }
            : /gpa|grade|overall result/.test(q) ? { values: [entry.gpa, p.gpa_range], key: 'gpa' } : null;
        }
        // Not one of the entry's own fields ("If you selected Other, please specify"): answered like any other question.
        if (!want) continue;
        handled.add(el);
        if (want && (want.date ? want.date && want.date.year : want.values.some(Boolean))) {
          const isEmpty = isCombo(el) || isPrompt(el) ? !answeredValue(el) : el.tagName === 'SELECT' ? el.selectedIndex <= 0 : isListbox(el) ? placeholderText(textOf(el)) : !el.value;
          // Workday's own resume reader runs words together ("returnsJSON"), so the resume's
          // text replaces what it put there. Never in a field Apply Desk typed, and never
          // one that has changed since it was first seen: that's the user's.
          const typed = !want.date && isText(el) && !isDatePart(el);
          const reader = workdayForm() && !run.wrote[label] && run.first[label] === fingerprint(el.value);
          const stale = typed && !isEmpty && reader && clean(el.value) !== clean(want.values[0]);
          if (isEmpty || isDatePart(el) || stale) await fillControl(el, label, stale ? { ...want, replace: true } : { ...want, fix: reader });
          if ((typed && clean(el.value) === clean(want.values[0])) || (want.date && isDatePart(el))) { run.wrote[label] = true; saveRun(); }
          // (A search box empties once its pick shows as a tag: that's no edit.)
          else if (typed && !isEmpty && !stale && clean(el.value)) record({ page: pageNow, question: label, value: clean(el.value).slice(0, 300), flag: 'Your edit. Left as you wrote it' });
        }
      }
      state.blocks += 1;
    }
    // The reader also adds entries the resume doesn't list as jobs or schools (projects, awards).
    for (let i = entries.length; i < blocks.length; i += 1) {
      const named = controlsIn(blocks[i]).find(el => first.test(norm(questionOf(el))));
      const value = named ? answeredValue(named) : '';
      const question = `${kind === 'experience' ? 'Work experience' : 'Education'} ${i + 1}`;
      if (value) record({ page: pageNow, question, value, flag: "Not on your resume as a job or school. Delete it if Workday added it" });
      // Its fields are an entry's, never something to fill from the profile.
      for (const el of controlsIn(blocks[i])) if (el.type !== 'radio' && el.type !== 'checkbox') handled.add(el);
    }
  }

  // ---------- Skills ----------
  // Adds the posting's most relevant skills (the plan lists them best first),
  // up to any limit the form states. Workday redraws the box after each pick,
  // so it's found again every time, and skills already added are skipped
  // (picking one again would remove it). A skill the list doesn't have is
  // skipped, never swapped for a different one.
  // "Python (Programming Language)" is Python; "Python IDLE" and "IronPython" aren't.
  // "Microsoft Excel" is Excel and "Apache Kafka" is Kafka.
  const skillKey = name => String(name || '').toLowerCase().replace(/\([^)]*\)/g, ' ')
    .replace(/^\s*(microsoft|apache|adobe)\s+(?=\S)/, '')
    .replace(/\b(programming|language|framework|library|package|software)\b/g, ' ')
    .replace(/[^a-z0-9+#]/g, '').replace(/^(.{2,})js$/, '$1').replace(/^postgres$/, 'postgresql');
  // A note in parentheses is another name ("Structured Query Language (SQL)")
  // only when it isn't a category: "Biopython (Python Package)" is never Python.
  const CATEGORY = /\b(programming|language|framework|library|package|software|tool|platform|database|module)s?\b/i;
  const skillOption = (options, skill) => {
    const key = skillKey(skill);
    return options.find(o => norm(optionLabel(o)) === norm(skill))
      || options.find(o => skillKey(optionLabel(o)) === key)
      || options.find(o => (optionLabel(o).match(/\(([^)]*)\)/g) || []).map(part => part.slice(1, -1))
        .some(alias => !CATEGORY.test(alias) && skillKey(alias) === key))
      || null;
  };
  const ticked = o => !!((o.closest('[role="option"], [data-automation-id="menuItem"]') || o).querySelector('input[type=checkbox]:checked'));
  const skillsMissed = new Set();
  const skillsDoneBefore = !!run.wrote.Skills;
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
    if (skillsDoneBefore && pills().length) return;   // finished on an earlier press; the user may have removed some
    await closeLists();
    const before = new Set(openOptions());
    let previous = null;
    const names = [];
    for (const skill of plan.skills) {
      if (pills().length >= limit) break;
      if (has(skill) || skillsMissed.has(skill)) continue;
      input = findInput() || input;
      if (!input.isConnected) break;
      handled.add(input);
      search(input, skill);
      // Big tenants search slowly: wait longer, and search once more when nothing came back.
      let options = await freshOptions(input, before, previous, 6000);
      if (!options) {
        await closeLists();
        input = findInput() || input;
        if (!input.isConnected) break;
        search(input, '');
        search(input, skill);
        options = await freshOptions(input, before, previous, 6000);
      }
      previous = options ? options.map(optionLabel).join('|') : previous;
      const match = options && skillOption(options, skill);
      if (!match) skillsMissed.add(skill);  // the form's list doesn't have it; don't search again on the second pass
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
    run.wrote.Skills = true;
    saveRun();
    if (names.length) {
      state.filled.push(`skills (${names.length})`);
      // Everything in the field now, so a second press doesn't shrink the review line.
      record({ page: pageNow, question: 'Skills', value: (pills().length ? pills() : names).join(', '), flag: '' });
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
  // A question without a field of its own, for learning checks and button choices.
  const stand = tagName => ({ tagName, getAttribute: () => null, hasAttribute: () => false, closest: () => null });
  const pseudo = stand('INPUT');
  // Fields of one job or school entry come from the resume, not from memory.
  const entryField = /^(job title|position title|title|company|employer|organization|location|from|to|role description|description|school or university|school|university|degree|field of study|major|overall result gpa|gpa|skills?|type to add skills)$/;
  const learnFix = (q, a) => {
    const at = state.learn.findIndex(item => norm(item.question) === norm(q));
    if (at >= 0) state.learn.splice(at, 1);
    state.learn.push({ question: q.slice(0, 300), answer: a, corrected: 'yes' });
  };
  const notLearned = (n, a) => !n || !a || never.test(n) || consent.test(n) || startDate.test(n) || graduationDate.test(n) || entryField.test(n) || a.length > 160 || placeholderText(a)
    || /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$|^\d{4}(-\d{2}){0,2}$/.test(a);
  function remember(question, answer) {
    const q = (question || '').trim().replace(/[*✱]\s*$/, '').trim();
    const a = (answer || '').trim();
    const n = norm(q);
    if (notLearned(n, a)) return;
    // Apply Desk's own answers (the model's too) aren't the user's. One that
    // reads differently now is: the user corrected it, and that's learned.
    const line = state.items.find(item => norm(item.question) === n && item.value);
    if (line) {
      const was = squash(line.value), now = squash(a);
      if (was === now || was.startsWith(now) || now.startsWith(was)) return;
      learnFix(q, a);
      record({ ...line, value: a, flag: 'Your correction. Apply Desk uses it from now on' });
      return;
    }
    const known = wanted(pseudo, q);
    if (known && known.source !== 'learned') return;
    if (!state.learn.some(item => norm(item.question) === n)) state.learn.push({ question: q.slice(0, 300), answer: a });
  }

  function answeredValue(el) {
    if (el.tagName === 'SELECT') return el.selectedIndex > 0 ? el.options[el.selectedIndex].textContent.trim() : '';
    if (isListbox(el)) return placeholderText(textOf(el)) ? '' : textOf(el);
    if (isCombo(el)) return comboValue(el);
    if (isPrompt(el)) return selectedPills(el).join('; ');
    // Any other input a person types or picks in, date and month pickers included.
    if (el.tagName === 'INPUT' && !['radio', 'checkbox', 'file'].includes(el.type)) return el.value;
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
        if (!notLearned(norm(questionOf(el)), value)) seen[questionOf(el).slice(0, 300)] = value;
        sessionStorage.setItem('applyDeskSeen', JSON.stringify(seen));
      } catch (error) { /* storage can be blocked */ }
    }, true);
    // Pop-up lists and search boxes fire no change event: after the user
    // clicks, note what each one now shows.
    let pending = null;
    const shownBefore = new WeakMap();
    const lists = () => controlsIn(document).filter(el => isListbox(el) || isCombo(el) || isPrompt(el));
    const snapshot = () => lists().forEach(el => shownBefore.set(el, answeredValue(el)));
    document.addEventListener('pointerdown', event => { if (!window.__applyDeskBusy && event.isTrusted && !pending) snapshot(); }, true);
    document.addEventListener('click', event => {
      if (window.__applyDeskBusy || !event.isTrusted) return;
      clearTimeout(pending);
      const choice = event.target.closest && event.target.closest('button[aria-pressed], [role="radio"]:not(input)');
      pending = setTimeout(() => {
        pending = null;
        if (window.__applyDeskBusy) return;
        try {
          const seen = JSON.parse(sessionStorage.getItem('applyDeskSeen') || '{}');
          for (const el of lists()) {
            const value = visible(el) ? answeredValue(el) : '';
            if (shownBefore.has(el) && shownBefore.get(el) !== value && !notLearned(norm(questionOf(el)), value)) seen[questionOf(el).slice(0, 300)] = value;
          }
          if (choice) {
            const box = choice.closest('[role="radiogroup"]') || choice.parentElement;
            const question = buttonQuestion(box, [...box.querySelectorAll('button[aria-pressed], [role="radio"]:not(input)')]);
            if (question && !notLearned(norm(question), textOf(choice))) seen[question.slice(0, 300)] = textOf(choice);
          }
          sessionStorage.setItem('applyDeskSeen', JSON.stringify(seen));
        } catch (error) { /* storage can be blocked */ }
      }, 600);
    }, true);
  }

  // ---------- Resume upload ----------
  // Once per page, through every pass and press. Sites empty the upload box and
  // list the file beside it, so a filename there means the resume is already in.
  const attachedPages = window.__applyDeskAttached = window.__applyDeskAttached || new Set();
  function showsFile(input) {
    for (let node = input.parentElement, up = 0; node && node !== document.body && up < 6; node = node.parentElement, up += 1) {
      const text = textOf(node);
      if (text.length > 1500) return false;
      if (/[\w)\]-]\.(pdf|docx?|rtf|odt)\b/i.test(text)) return true;
    }
    return false;
  }
  function attachResume() {
    if (!pdfB64 || attachedPages.has(pageNow)) return;
    const inputs = [...document.querySelectorAll('input[type=file]')].filter(i => !i.disabled);
    const uploads = inputs.filter(i => !(i.files && i.files.length));
    const other = /cover|transcript|portfolio|writing sample|photo|headshot/;
    const named = i => hintsOf(i);
    const fits = i => (!i.accept || /pdf|application\/|\*/.test(i.accept)) && !other.test(named(i));
    const resumes = uploads.filter(i => fits(i) && /resume|(^| )cv( |$)|curriculum/.test(named(i)));
    // The application's own resume field, not an "autofill from resume" importer
    // (Ashby has both; the importer would overwrite what's been filled).
    const importer = i => /autofill|auto fill|parse|import|prefill|pre fill/.test(named(i)) || /autofill|parse/i.test(textOf(i.closest('section, div[class*="autofill" i]') || i.parentElement).slice(0, 200));
    if (inputs.some(i => !other.test(named(i)) && !importer(i) && ((i.files && i.files.length) || showsFile(i)))) return;
    const target = resumes.find(i => !importer(i)) || resumes[0] || (uploads.length === 1 && fits(uploads[0]) ? uploads[0] : null);
    if (!target) return;
    const files = new DataTransfer();
    files.items.add(new File([Uint8Array.from(atob(pdfB64), c => c.charCodeAt(0))], decode(nameB64) || 'Resume.pdf', { type: 'application/pdf' }));
    target.files = files.files;
    for (const type of ['input', 'change']) target.dispatchEvent(new Event(type, { bubbles: true }));
    state.attached = true;
    attachedPages.add(pageNow);
    saveRun();
  }

  // Terms, certification, and promise boxes, when the user turned on "agree to
  // terms" in Profile. Marketing sign-ups and optional data sharing never are.
  function agreeTo(group, question) {
    for (const box of group) {
      const label = choiceLabel(box), text = norm(`${question} ${label}`);
      const required = isRequired(box, question) || isRequired(box, label);
      if (box.checked || /^(no\b|i do not|i don.t|i disagree|disagree|decline)/i.test(label)) continue;
      if (marketing.test(text) && !(required && aboutThisApplication.test(text))) continue;
      if (!required && optionalSharing.test(text)) continue;
      current = { source: 'terms' };
      press(box);
      note(box, question, choiceLabel(box) || 'Agreed');
      current = null;
    }
  }

  // A box that states something ("I am authorized to work in the U.S.", "I will
  // not disclose confidential information"): ticked only when the user's own
  // answers make that statement true.
  function statementHolds(box, label) {
    const q = norm(label);
    const want = q ? wanted(box, label) : null;
    if (!want || !want.values || want.source === 'disclosure' || want.source === 'draft') return false;
    if (want.key === 'confidentiality_promise') return true;
    const negated = /\b(not|never|no|cannot|without)\b|n.t\b/.test(q);
    return norm(want.values[0]) === (negated ? 'no' : 'yes');
  }
  // "What type of opportunities are you interested in?" iOS, Backend, Android...: the one in this role's title.
  function tickRole(group, question) {
    const title = norm(plan.role && plan.role.title);
    if (!title || group.some(box => box.checked) || !isRequired(group[0], question) || !/opportunit|area|interest|team|function|role|field/.test(norm(question))) return;
    const match = group.filter(box => { const label = norm(choiceLabel(box)); return label.length > 1 && new RegExp(`(^| )${label.replace(/[^a-z0-9 ]/g, '')}( |$)`).test(title); });
    current = { source: 'answer' };
    match.forEach(press);
    if (match.length) note(match[0], question, match.map(choiceLabel).join('; '));
    current = null;
  }
  function tickTrue(group, question) {
    for (const box of group) {
      const own = choiceLabel(box);
      const label = /^(on|yes|true|1)?$/i.test(own) ? question : own;
      if (box.checked || !statementHolds(box, label)) continue;
      current = { source: 'answer' };
      press(box);
      note(box, question, label);
      current = null;
    }
  }

  // ---------- One page ----------
  async function fillControls(all) {
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
      const detail = detailOf(el);
      await fillControl(el, question, wanted(el, question) || (detail ? wanted(el, `${question} ${detail}`) : null));
    }
    for (const group of Object.values(radios)) {
      stopCheck();
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
      const isConsent = consent.test(norm(question)) || group.some(box => consent.test(norm(choiceLabel(box))));
      stopCheck();
      if (isConsent && plan.agree_terms) agreeTo(group, question);
      if (isConsent) continue;
      if (group.length < 2) { tickTrue(group, question); continue; }
      const checked = group.filter(box => box.checked);
      if (checked.length) { remember(question, checked.map(choiceLabel).join('; ')); continue; }
      // Self-identification boxes (disability forms) are often known only by their options.
      const want = wanted(group[0], question) || disclosureFor(group.map(choiceLabel).join(' '));
      if (!want || !want.values || want.source === 'draft') {
        tickTrue(group, question);
        tickRole(group, question);
        continue;
      }
      current = want;
      if (want.source === 'disclosure') {
        const match = best(group, want.values, choiceLabel, 'prefix');
        if (match && !match.checked) { press(match); note(match, question, choiceLabel(match)); }
      } else if (want.open) {
        // Open to every location: the "no preference" box when there is one, otherwise all of them.
        const any = group.find(box => /no preference|^any\b|^all\b|open to (all|any)|anywhere|flexible/i.test(choiceLabel(box)));
        const targets = any ? [any] : group.filter(box => !/^(other|none|international|not |n\/a)/i.test(choiceLabel(box)));
        targets.filter(box => !box.checked).forEach(press);
        if (targets.length) note(targets[0], question, targets.map(choiceLabel).join('; '));
      } else if (want.source === 'learned') {
        // What the user ticked on an earlier form: every one of them.
        const picked = [];
        for (const value of want.values) {
          const match = best(group, [value], choiceLabel);
          if (match && !match.checked) { press(match); picked.push(match); }
        }
        if (picked.length) note(picked[0], question, picked.map(choiceLabel).join('; '));
      } else {
        // One answer ("English", "I have not yet completed a degree"): its box only.
        const match = best(group, want.values, choiceLabel, want.strict || 'prefix') || best(group, want.values.slice(0, 1), choiceLabel);
        if (match && !match.checked) { press(match); note(match, question, choiceLabel(match)); }
      }
      current = null;
    }
  }

  // Choices drawn as buttons (Ashby's Yes/No: <button aria-pressed>) or as
  // custom radios that aren't inputs (role="radio"). The question is the text
  // around the group with the choices taken out.
  const choiceGroups = new Set();
  function buttonQuestion(box, choices) {
    let question = byIds(box.getAttribute('aria-labelledby'));
    for (let node = box, depth = 0; !question && node && node !== document.body && depth < 5; node = node.parentElement, depth += 1) {
      const text = textWithout(node, part => choices.includes(part));
      if (text.length >= 3) question = text.slice(0, 300);
    }
    return question;
  }
  async function fillButtonChoices() {
    const groups = new Map();
    for (const choice of document.querySelectorAll('button[aria-pressed], [role="radio"]:not(input)')) {
      if (!visible(choice) || choice.disabled) continue;
      const box = choice.closest('[role="radiogroup"]') || choice.parentElement;
      groups.set(box, [...(groups.get(box) || []), choice]);
    }
    for (const [box, choices] of groups) {
      stopCheck();
      if (choices.length < 2 || choiceGroups.has(box)) continue;
      choiceGroups.add(box);
      const chosen = choices.find(c => c.getAttribute('aria-pressed') === 'true' || c.getAttribute('aria-checked') === 'true');
      const question = buttonQuestion(box, choices);
      if (!question) continue;
      if (chosen) { remember(question, textOf(chosen)); continue; }
      const want = wanted(stand('BUTTON'), question);
      if (!want || !want.values) continue;
      current = want;
      const match = best(choices, want.values, textOf, want.strict);
      if (match) {
        press(match);
        await sleep(150);
        note(match, question, textOf(match));
      }
      current = null;
    }
  }

  async function fillPage() {
    handled.clear();
    attachResume();
    await fillBlocks('experience', plan.experience);
    await fillBlocks('education', plan.education);
    await fillSkills();
    await addWebsite();
    // Answers can reveal more questions (a disability answer shows its Name
    // and Date), so look again after each pass.
    const seen = new Set();
    for (let pass = 0; pass < 3; pass += 1) {
      const all = controlsIn(document).filter(el => !handled.has(el) && !seen.has(el));
      if (!all.length) break;
      all.forEach(el => seen.add(el));
      await fillControls(all);
      await fillButtonChoices();
    }
    await fillButtonChoices();
    try {
      // What the user changed by hand since the last press (the Mac app also collects this while they review).
      for (const [question, answer] of Object.entries(JSON.parse(sessionStorage.getItem('applyDeskSeen') || '{}'))) {
        if (!notLearned(norm(question), answer)) learnFix(question.replace(/[*✱]\s*$/, '').trim(), answer);
      }
      sessionStorage.removeItem('applyDeskSeen');
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
  // A job listing's own "Apply" (BambooHR, Rippling, Lever, Ashby): pressed only
  // on the first step, on a page with no form that reads like a posting, so it
  // can never be a final "Apply" that submits.
  const openApplicationButton = () => {
    if (!/responsibilit|qualification|requirements|about (the|this) (role|job|position)|what you('|’)ll do/i.test(textOf(document.body).slice(0, 20000))) return null;
    return [...clickable(), ...document.querySelectorAll('a[href]')].filter(visible)
      .find(b => /^(apply( now| for this (job|position|role))?|apply to (this )?(job|position|role)|i'?m interested|start (my |your )?application)$/i.test(buttonText(b))) || null;
  };
  const signInPage = () => [...document.querySelectorAll('input[type=password]')].some(visible);
  const onReview = () => /^review\b/i.test(pageTitle());
  const loading = () => [...document.querySelectorAll('[data-automation-id="loadingSpinner"], [aria-busy="true"], [role="progressbar"]')].some(visible);
  const isRequired = (el, question) => el.required || el.getAttribute('aria-required') === 'true' || /[*✱]\s*$/.test(question || '');

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
      } else if (isDatePart(el)) {
        empty = !datePartValue(el);
      } else if (el.tagName === 'TEXTAREA') {
        empty = !el.value.trim();
      } else {
        empty = !answeredValue(el);
      }
      if (empty) {
        seen.add(question);
        needs.push({ question: question.replace(/[*✱]\s*$/, '').trim().slice(0, 160), el });
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
  // A required text box that can take "N/A": not a link, contact detail, name, number, or date.
  const noAnswerNeeded = (el, question) => !['email', 'tel', 'url', 'number', 'date', 'password'].includes((el.type || '').toLowerCase())
    && /^if\b|if applicable|please (enter|put|write) .?n.?a\b/.test(norm(question))
    && !/linkedin|url|link|website|twitter|e ?mail|phone|date|zip|postal|social security|\bssn\b|birth|password|gpa|name$|year|how many|number/.test(norm(question));
  // The user doesn't share LinkedIn: a required box says N/A (a URL-only box can't), an optional one stays out of the review.
  const noLinkedIn = question => !p.linkedin && /linkedin/.test(norm(question));
  async function fillNeutral(needs) {
    for (const need of needs) {
      stopCheck();
      const el = need.el;
      const skipLink = noLinkedIn(need.question) && el.type !== 'url';
      current = { source: skipLink ? 'no_linkedin' : 'neutral' };
      if (el.tagName === 'SELECT') pickSelect(el, NEUTRAL, need.question, 'prefix');
      else if (isListbox(el)) await pickListbox(el, { values: NEUTRAL, strict: 'prefix' }, need.question);
      else if (el.type === 'radio') pickRadio(controlsIn(document).filter(r => r.type === 'radio' && r.name === el.name), NEUTRAL, need.question, 'prefix');
      else if (isText(el) && !isCombo(el) && !isPrompt(el) && !isDatePart(el) && !el.value.trim() && (skipLink || noAnswerNeeded(el, need.question))) {
        typeInto(el, 'N/A');
        note(el, need.question, 'N/A');
      }
      current = null;
    }
  }

  // ---------- Reviewing a page ----------
  // Once a page is filled, it's checked and filled again: every answer is
  // read back from its field (a typed value the site threw away is set a
  // second way), the whole page gets a second pass for whatever is still
  // empty, required leftovers get a neutral answer, and what stays blank is
  // listed in the review.
  const pressed = el => el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true';
  const holdsValue = el => (el.type === 'radio' || el.type === 'checkbox' ? el.checked
    : el.hasAttribute('aria-pressed') || el.getAttribute('role') === 'radio' ? pressed(el)
    : isDatePart(el) ? !!datePartValue(el) : el.tagName === 'TEXTAREA' ? !!el.value.trim() : !!answeredValue(el));
  function setValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    el.focus({ preventScroll: true });
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    for (const type of ['input', 'change']) el.dispatchEvent(new Event(type, { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }
  const lost = entry => entry.el.isConnected && visible(entry.el) && !holdsValue(entry.el);

  function noteBlanks() {
    const seen = new Set(), controls = controlsIn(document);
    let optional = 0;
    for (const el of controls) {
      const asked = questionOf(el);
      const question = asked.replace(/[*✱]\s*$/, '').trim().slice(0, 160);
      if (!question || seen.has(question)) continue;
      seen.add(question);
      let empty;
      if (el.type === 'radio' || el.type === 'checkbox') {
        const group = controls.filter(o => o.type === el.type && (el.type === 'radio' && el.name ? o.name === el.name : questionOf(o) === asked));
        empty = !group.some(o => o.checked);
        if (el.type === 'checkbox' && group.length < 2 && !isRequired(el, asked)) continue;  // an optional lone box (sign-ups)
      } else {
        empty = !holdsValue(el);
      }
      if (!empty || (/^to\b/.test(norm(question)) && currentJob(el))) continue;
      const required = isRequired(el, asked);
      if (!required && (optional >= 15 || otherPeople.test(norm(question)) || noLinkedIn(question))) continue;
      optional += required ? 0 : 1;
      record({ page: pageNow, question, value: '', flag: required ? 'Required and still blank. This one needs you' : 'Left blank (optional)' });
    }
  }

  // ---------- Questions for the model on this Mac ----------
  // What the rules above left open goes to the local model, through the Mac
  // app: essay boxes, and multiple-choice or short questions with no answer.
  // Never self-identification, contact details, pay, GPA, or consent.
  const modelSkip = q => never.test(q) || !!disclosureFor(q) || consent.test(q) || otherPeople.test(q) || salaryAsk.test(q)
    || /\bgpa\b|grade point/.test(q) || contact.some(([, pattern]) => pattern.test(q));

  async function readOptions(el) {
    if (isCombo(el)) return pickCombo(el, { values: [] }, '', true);
    await closeLists();
    const before = new Set(openOptions());
    press(el);
    const options = await freshOptions(el, before, null, 2500);
    await closeLists(el);
    return (options || []).map(optionLabel);
  }

  async function openQuestions() {
    const out = [], controls = controlsIn(document);
    const add = (kind, question, options, target) => {
      const same = out.find(item => item.question === question.slice(0, 700) && item.kind === kind);
      if (same) return same.targets.push(target);
      if (out.length < 12) out.push({ id: out.length + 1, kind, question: question.slice(0, 700), options: [...new Set(options.map(clean).filter(Boolean))], targets: [target] });
    };
    const counted = new Set();
    for (const el of controls) {
      const asked = questionOf(el), q = norm(asked);
      const label = asked.replace(/[*✱]\s*$/, '').trim();
      if (q.length < 4 || counted.has(el) || modelSkip(q)) continue;
      if (el.type === 'radio' || el.type === 'checkbox') {
        const group = el.type === 'radio' && el.name ? controls.filter(o => o.type === 'radio' && o.name === el.name) : choiceGroup(el).filter(o => controls.includes(o));
        group.forEach(o => counted.add(o));
        if (group.length >= 2 && group.length <= 40 && !group.some(o => o.checked)) add(el.type === 'radio' ? 'choice' : 'multi', label, group.map(choiceLabel), { group });
      } else if (el.tagName === 'SELECT') {
        const options = [...el.options].filter(o => !placeholderText(o.textContent) && o.value !== '').map(o => o.textContent);
        if (el.selectedIndex <= 0 && options.length >= 2 && options.length <= 40) add('choice', label, options, { el });
      } else if (isListbox(el) || isCombo(el)) {
        if (answeredValue(el)) continue;
        const options = await readOptions(el);
        if (options.length >= 2 && options.length <= 40) add('choice', label, options, { el });
      } else if (el.tagName === 'TEXTAREA') {
        const detail = detailOf(el);
        // "Have you built an app? If yes, tell us about one" is a question of its own when the form requires it.
        if (!el.value.trim() && (!sideNote.test(q) || (isRequired(el, asked) && /^(have|did|do|are|can|what|which)\b/.test(q)))) add('essay', `${label}${detail ? ` ${detail}` : ''}`, [], { el });
      } else if (isText(el) && !isPrompt(el) && !isDatePart(el) && !el.value.trim() && (isRequired(el, asked) || /\?\s*$/.test(label)) && noAnswerNeeded(el, asked)) {
        add('text', label, [], { el });
      }
    }
    return out;
  }

  async function applyAnswer(item, answer) {
    for (const { el, group } of item.targets) {
      current = { source: 'model', essay: item.kind === 'essay' };
      try {
        if (item.kind === 'multi') {
          const picked = (answer.choices || []).map(choice => best(group, [choice], choiceLabel)).filter(box => box && !box.checked);
          picked.forEach(press);
          if (picked.length) note(picked[0], item.question, picked.map(choiceLabel).join('; '));
        } else if (!answer.answer) {
          continue;
        } else if (group) {
          pickRadio(group, [answer.answer], item.question);
        } else if (item.kind === 'choice') {
          await fillControl(el, item.question, { values: [answer.answer], source: 'model' });
        } else if (el.isConnected && !el.value.trim()) {
          typeInto(el, answer.answer);
          note(el, item.question, answer.answer);
        }
      } finally {
        current = null;
      }
    }
  }

  // Posts the open questions in this run's status (`ask`); the Mac app sends
  // them to the local service and puts the checked answers in
  // window.__applyDeskAnswers[id]. No answer in time means carry on without.
  async function askModel() {
    const open = await openQuestions();
    if (!open.length) return;
    const id = String(Date.now());
    state.ask = { id, questions: open.map(({ id: number, kind, question, options }) => ({ id: number, kind, question, options })) };
    const answers = await waitFor(() => (window.__applyDeskAnswers || {})[id], 160000);
    state.ask = null;
    for (const answer of answers || []) {
      const item = open.find(question => question.id === answer.id);
      if (item) await applyAnswer(item, answer);
    }
  }

  async function reviewPage() {
    for (const [question, entry] of filledEls) {
      const el = entry.el;
      if (!entry.value || !isText(el) || isCombo(el) || isPrompt(el) || isDatePart(el)) continue;
      if (lost(entry)) setValue(el, entry.value);
      // Reading each answer back: a name or email with anything stuck to it goes back to what was typed.
      else if (el.isConnected && /name|e ?mail/.test(norm(question)) && clean(el.value) !== clean(entry.value) && clean(el.value).includes(clean(entry.value))) setValue(el, entry.value);
    }
    await fillPage();   // the second pass
    if (plan.model && holdDrafts) {
      await askModel();
      holdDrafts = false;
      await fillPage();   // templates for any essay the model didn't draft
    }
    let needs = needsOnPage();
    if (needs.length) {
      await fillNeutral(needs);
      needs = needsOnPage();
    }
    for (const [question, entry] of filledEls) {
      const item = lost(entry) && state.items.find(known => known.page === pageNow && known.question === question);
      if (item) item.flag = "Didn't take. Check this field";
    }
    noteBlanks();
    return needs;
  }

  // Presses Continue; true once the next page has loaded.
  async function advance() {
    const next = continueButton();
    if (!next) return false;
    // Commit the last typed field before leaving the page.
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    await sleep(300);
    const key = pageKey();
    state.advancing = true;
    saveRun();
    press(next);
    const moved = await nextPage(key);
    state.advancing = false;
    return moved;
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
  // `onForm`: a one-page form that's just been filled, where there is no
  // separate review page to compare against.
  function showReview(onForm = false) {
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
    const check = [], blank = [], optional = [];
    for (const item of state.items) {
      if (!item.value) (/^Required/.test(item.flag) ? blank : optional).push({ ...item, why: item.flag });
      else if (item.flag) check.push({ ...item, why: item.flag });
      else if (!onForm && !shows(item)) check.push({ ...item, why: "Not on the review page. Check it took." });
    }
    const errors = errorsShown().map(text => ({ question: text })).concat(blank);
    const attached = state.attached ? [{ question: 'Resume', value: decode(nameB64) || 'Resume.pdf', why: '' }] : [];
    showPanel(blank.length ? `${blank.length} left for you` : 'Ready for your review', roleName || 'Everything Apply Desk filled, page by page.', [
      { title: 'Needs you', tone: '#e5484d', items: errors },
      { title: 'Check these', tone: '#d9822b', items: check, byPage: true },
      { title: 'Filled by Apply Desk', tone: '#10b77f', items: [...attached, ...state.items.filter(item => item.value)], byPage: true, collapsed: true },
      { title: 'Left blank (optional)', tone: '#8e8e93', items: optional, byPage: true, collapsed: true },
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
        filledEls.clear();
        holdDrafts = !!plan.model;
        stopCheck();
        if (signInPage()) { state.stop = 'signin'; break; }
        if (onReview()) { showReview(); state.stop = 'review'; break; }
        if (step >= 20) { state.stop = 'limit'; break; }
        // Workday's start page: choose to fill it in here rather than upload-and-parse.
        const manual = controlsIn(document).length < 2 && !continueButton() && (applyManuallyButton() || (step === 0 && !run.pages.length && openApplicationButton()));
        if (manual) {
          const key = pageKey();
          press(manual);
          if (!(await nextPage(key))) { state.stop = 'stuck'; break; }
          continue;
        }
        await fillPage();
        saveRun();
        const needs = await reviewPage();
        saveRun();
        state.needs = needs.map(need => need.question);
        // A single-page form ends here, with anything still blank listed.
        if (!continueButton()) {
          if (state.items.length) showReview(true);
          state.stop = needs.length ? 'needs' : 'end';
          break;
        }
        if (window.__applyDeskStop) { state.stop = 'stopped'; break; }
        if (!run.pages.includes(pageNow)) run.pages.push(pageNow);
        // Move on even with a blank: forms mark fields required that aren't.
        // If the site objects, fill and review the page once more and retry.
        let moved = await advance();
        if (!moved) {
          await fillPage();
          await reviewPage();
          saveRun();
          moved = await advance();
        }
        if (!moved) {
          const blank = needsOnPage(), errors = errorsShown();
          if (!blank.length && !errors.length) { state.stop = 'stuck'; break; }
          // The site still wants something: wait for the user, then try again.
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
      if (error === STOPPED) state.stop = 'stopped';
      else state.error = String(error && error.message || error);
    }
    finishing = true;
    current = null;
    if (state.stop === 'stopped') {
      removePanel();
      try { await closeLists(); } catch (error) { /* the page may have moved on */ }
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
