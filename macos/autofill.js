// Apply Desk form filler, injected into the front Chrome tab by the Mac app as
//   applyDeskFill(planBase64, resumePdfBase64, resumeNameBase64)
// The plan (GET /api/fill-plan) holds only the user's own profile, saved
// answers, resume entries, and tailored skills. The filler types only into
// empty fields (job and school entries Workday read from the resume itself
// get the resume's exact text instead), answers self-identification
// questions only as the user chose in Profile (or with the form's decline
// option), ticks required terms boxes and signs only when the user turned
// that on in Profile (never optional sign-ups), and never submits. On multi-step applications (Workday) it fills a page,
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
  // Chrome slows a background tab's timers to a crawl. Every wait is also
  // kept in `naps`, and the Mac app wakes the ones that are due each time it
  // checks on this tab (window.__applyDeskPump), so a run keeps moving while
  // the user works in another tab.
  const naps = new Set();
  const sleep = ms => new Promise(resolve => {
    state.beat += 1;   // every wait shows the Mac app this run is alive
    const nap = { due: Date.now() + ms, wake: () => { naps.delete(nap); resolve(); } };
    naps.add(nap);
    setTimeout(nap.wake, ms);
  });
  window.__applyDeskPump = () => { const now = Date.now(); for (const nap of [...naps]) if (nap.due <= now) nap.wake(); };
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

  // A place typed into a box with a suggestion list (Lever's location, Google's
  // place picker) only sticks once a suggestion is chosen: type it, nudge the
  // search with a key, and pick the suggestion that starts with the city.
  async function typeAndPick(el, value) {
    el.focus({ preventScroll: true });
    try { el.select(); } catch (error) { /* some inputs can't select */ }
    if (!document.execCommand('insertText', false, value) || el.value !== value) {
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
      input.focus();
      if (!document.execCommand('insertText', false, term)) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, term);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      options = await settle(before);
      picked = await take(options);
      if (!picked) {
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

  // `fix` also corrects parts that hold a different date (Workday's resume reader).
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  async function fillDate(el, formats, question, fix = false) {
    if (!formats || !formats.year) return false;
    // One part of a date ("Start date month", "End date year"), as the field asks for it.
    const q = norm(String(question).replace(/^(work experience|education) \d+ /i, ''));
    const part = /\bmonth$/.test(q) ? 'month' : /\byear$/.test(q) ? 'year' : /\bday$/.test(q) ? 'day' : '';
    if (el.tagName === 'SELECT' || isCombo(el) || isListbox(el)) {
      const month = MONTHS[Number(formats.month) - 1] || '';
      const values = part === 'month' ? [month, month.slice(0, 3), formats.month, String(Number(formats.month))]
        : part === 'year' ? [formats.year] : part === 'day' ? [formats.day, String(Number(formats.day))]
        : [formats.mm_dd_yyyy, formats.mm_yyyy, formats.year];
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
    ['school', /^(current |name of (your )?)?(school|university|college|institution)( name| attended)?$|school or university|college\/university|university\/college|(school|university|college) (name|attended|attending|enrolled)|(which|what) (school|university|college)|(school|university|college).{0,50}(enrolled|attend|study|studying|graduat)|name of (your )?(school|university|college|institution)/,
     schoolNames, { strict: true, search: schoolSearch(schoolNames) }],
    ['field', /field of study|area of study|\bmajors?\b|academic discipline/, school.field_options || [], { strict: true, search: [school.field] }],
    // The degree itself, not any question that mentions one ("credit hours toward your degree").
    ['degree', /^(highest |type of |current )?degree( type| level| earned| obtained| pursuing| sought)?$|(what|which) degree|degree (type|level)|type of degree/, [p.degree, ...(((plan.education || [])[0] || {}).degree_options || [])]],
  ];
  // Other people's details, and second contacts ("Alternate Phone Number") the user has none of.
  const otherPeople = /\breferences?\b|emergency|supervisor|manager|guardian|parent|spouse|high school|extension|\breferr(al|er|ed) (name|email|by)|\b(alternate|alternative|secondary|additional|backup) (phone|email|contact|number)/;
  // A start date at a past job ("Government Civilian Start Date") is not the user's to invent.
  const pastJob = /government|military|civilian|clearance|served|service|former|previous|prior/;
  const startDate = /(start|availability|available) date|when can you (start|begin)|earliest (start|date)|proposed start|date (you are )?available/;
  const graduationDate = /when (will|do) you (expect to )?graduate|graduation date|(expected|anticipated|projected) graduation|graduation (month|year|term)|date of graduation|completion date/;
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
    if (el.tagName !== 'TEXTAREA' && startDate.test(q) && !pastJob.test(q)) return { date: plan.start, source: 'date' };
    if (el.tagName !== 'TEXTAREA' && todayDate.test(q) && plan.today) return { date: plan.today, source: 'date' };
    if (el.tagName !== 'TEXTAREA' && graduationDate.test(q)) {
      const dated = p.graduation_dates || {};
      return el.tagName === 'SELECT' || isListbox(el) ? { values: [dated.year, p.graduation], source: 'date' } : { date: dated, source: 'date' };
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
    // Questions that need writing get a draft from the user's own resume lines.
    if (el.tagName === 'TEXTAREA' || isText(el)) {
      const draft = (plan.drafts || []).find(d => new RegExp(d.pattern, 'i').test(q));
      // Dates, a cover letter, and the user's own plans keep their rule-written
      // form (a model would guess intentions); other essays wait for the model when it's on.
      if (draft && holdDrafts && el.tagName === 'TEXTAREA' && !['availability', 'cover', 'plans'].includes(draft.key)) return null;
      if (draft) return { values: [el.tagName === 'TEXTAREA' ? draft.text : draft.short || draft.text], source: 'draft' };
    }
    if (otherPeople.test(q)) return null;
    if (el.tagName === 'TEXTAREA' && !sideNote.test(q)) {
      const skill = skillExperience(q);
      const story = !skill && essayPrompt.test(q) ? storyFor(q) : '';
      if (skill) return { values: [skill], source: 'draft' };
      if (story && holdDrafts) return null;
      if (story) return { values: [story], source: 'draft', loose: true };
    }
    if (/\bwhy\b|describe|statement|cover letter|tell us|explain/.test(q)) return null;
    const hints = el.closest ? hintsOf(el) : q;
    for (const [field, pattern, values, how] of contact) {
      if (pattern.test(q) || pattern.test(hints)) {
        const usable = values.filter(Boolean);
        return usable.length ? { ...how, field, values: usable, source: 'profile' } : null;
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
  const controlsIn = root => [...root.querySelectorAll('input:not([type=hidden]):not([type=file]), select, textarea, button[aria-haspopup="listbox"]')]
    .filter(el => visible(el) && !el.disabled && !el.readOnly && !isTrap(el));

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

  const addsTried = new Set();
  async function fillBlocks(kind, entries) {
    if (!entries || !entries.length) return;
    const first = kind === 'experience' ? /job title|position title|^title$|role title/ : /school|university|college|institution/;
    const second = kind === 'experience' ? /company|employer|organization/ : /degree|field of study|major/;
    // Greenhouse shows its school fields with no "Education" heading: the page
    // itself is the section when a school field sits beside a degree field.
    const section = sectionFor(kind === 'experience' ? /^(work )?experience|^employment( history)?|^work history/ : /^education/)
      || (kind === 'education' && entryBlocks(document.body, first, second).length ? document.body : null);
    if (!section) return;
    const find = section === document.body ? entryBlocks : blocksIn;
    let blocks = find(section, first, second);
    // Entries are added once per page; a second pass only fills what's there.
    const addKey = `${pageNow}|${kind}`;
    for (let guard = addsTried.has(addKey) ? Infinity : 0; blocks.length < entries.length && guard <= entries.length; guard += 1) {
      addsTried.add(addKey);
      const add = addButton(section);
      if (!add) break;
      const before = blocks.length;
      press(add);
      await waitFor(() => find(section, first, second).length > before, 3000);
      blocks = find(section, first, second);
    }
    for (let i = 0; i < Math.min(blocks.length, entries.length); i += 1) {
      const entry = entries[i];
      for (const el of controlsIn(blocks[i])) {
        if (handled.has(el)) continue;
        const q = norm(questionOf(el));
        const label = `${kind === 'experience' ? 'Work experience' : 'Education'} ${i + 1}: ${questionOf(el).replace(/[*✱]\s*$/, '')}`;
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
          // Choices (Yes/No, "What degree are you pursuing?") go to the answers below.
          if (el.type === 'radio' || el.type === 'checkbox') continue;
          const names = entry.school_options && entry.school_options.length ? entry.school_options : [entry.school];
          // Dates first: "When did you begin your current degree program?" is a date, not a degree.
          want = /when did you (begin|start)|(start|begin)(ning)? (date|month|year)|^from\b|^start/.test(q) ? { date: entry.start }
            : /when (do|will) you (expect to )?(complete|graduate|finish)|^to\b|^end|graduat|expected|complet/.test(q) ? { date: entry.end }
            : /school|university|college|institution/.test(q) ? { values: names, strict: true, search: schoolSearch(names) }
            : /degree/.test(q) ? { values: entry.degree_options.length ? entry.degree_options : [entry.degree] }
            : /field of study|major|discipline/.test(q) ? { values: entry.field_options && entry.field_options.length ? entry.field_options : [entry.field], strict: true, search: [entry.field] }
            : /gpa|grade|overall result/.test(q) ? { values: [entry.gpa, p.gpa_range], key: 'gpa' } : null;
        }
        // Not one of the entry's own fields ("If you selected Other, please specify"): answered like any other question.
        if (!want) continue;
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
  const skillKey = name => String(name || '').toLowerCase().replace(/\([^)]*\)/g, ' ')
    .replace(/\b(programming|language|framework|library|package|software)\b/g, ' ')
    .replace(/[^a-z0-9+#]/g, '').replace(/^(.{2,})js$/, '$1').replace(/^postgres$/, 'postgresql');
  const skillOption = (options, skill) => options.find(o => norm(optionLabel(o)) === norm(skill)) || options.find(o => {
    const label = optionLabel(o);
    const named = [label, ...(label.match(/\(([^)]*)\)/g) || []).map(part => part.slice(1, -1))];  // "Structured Query Language (SQL)"
    return named.some(name => skillKey(name) === skillKey(skill));
  }) || null;
  const ticked = o => !!((o.closest('[role="option"], [data-automation-id="menuItem"]') || o).querySelector('input[type=checkbox]:checked'));
  const skillsMissed = new Set();
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
      if (has(skill) || skillsMissed.has(skill)) continue;
      input = findInput() || input;
      if (!input.isConnected) break;
      handled.add(input);
      search(input, skill);
      const options = await freshOptions(input, before, previous, 2500);
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
  let attachedHere = false;   // once per page: a second pass must not feed another upload box
  function attachResume() {
    if (!pdfB64 || attachedHere) return;
    const uploads = [...document.querySelectorAll('input[type=file]')].filter(i => !i.disabled && !(i.files && i.files.length));
    const other = /cover|transcript|portfolio|writing sample|photo|headshot/;
    const named = i => hintsOf(i);
    const fits = i => (!i.accept || /pdf|application\/|\*/.test(i.accept)) && !other.test(named(i));
    const resumes = uploads.filter(i => fits(i) && /resume|(^| )cv( |$)|curriculum/.test(named(i)));
    // The application's own resume field, not an "autofill from resume" importer
    // (Ashby has both; the importer would overwrite what's been filled).
    const importer = i => /autofill|auto fill|parse|import|prefill|pre fill/.test(named(i)) || /autofill|parse/i.test(textOf(i.closest('section, div[class*="autofill" i]') || i.parentElement).slice(0, 200));
    const target = resumes.find(i => !importer(i)) || resumes[0] || (uploads.length === 1 && fits(uploads[0]) ? uploads[0] : null);
    if (!target) return;
    const files = new DataTransfer();
    files.items.add(new File([Uint8Array.from(atob(pdfB64), c => c.charCodeAt(0))], decode(nameB64) || 'Resume.pdf', { type: 'application/pdf' }));
    target.files = files.files;
    for (const type of ['input', 'change']) target.dispatchEvent(new Event(type, { bubbles: true }));
    state.attached = attachedHere = true;
  }

  // Required terms and certification boxes, when the user turned on "agree
  // to required terms" in Profile. Optional sign-ups are never ticked.
  function agreeTo(group, question) {
    for (const box of group) {
      const text = norm(`${question} ${choiceLabel(box)}`);
      if (box.checked || marketing.test(text) || !(isRequired(box, question) || isRequired(box, choiceLabel(box)))) continue;
      current = { source: 'terms' };
      press(box);
      note(box, question, choiceLabel(box) || 'Agreed');
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
      if (isConsent && plan.agree_terms) agreeTo(group, question);
      if (group.length < 2 || isConsent) continue;
      const checked = group.filter(box => box.checked);
      if (checked.length) { remember(question, checked.map(choiceLabel).join('; ')); continue; }
      // Self-identification boxes (disability forms) are often known only by their options.
      const want = wanted(group[0], question) || disclosureFor(group.map(choiceLabel).join(' '));
      if (!want || !want.values || want.source === 'draft') continue;
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
  async function fillButtonChoices() {
    const groups = new Map();
    for (const choice of document.querySelectorAll('button[aria-pressed], [role="radio"]:not(input)')) {
      if (!visible(choice) || choice.disabled) continue;
      const box = choice.closest('[role="radiogroup"]') || choice.parentElement;
      groups.set(box, [...(groups.get(box) || []), choice]);
    }
    for (const [box, choices] of groups) {
      if (choices.length < 2 || choiceGroups.has(box)) continue;
      choiceGroups.add(box);
      const chosen = choices.find(c => c.getAttribute('aria-pressed') === 'true' || c.getAttribute('aria-checked') === 'true');
      let question = byIds(box.getAttribute('aria-labelledby'));
      for (let node = box, depth = 0; !question && node && node !== document.body && depth < 5; node = node.parentElement, depth += 1) {
        const text = textWithout(node, part => choices.includes(part));
        if (text.length >= 3) question = text.slice(0, 300);
      }
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
      } else if (el.tagName === 'TEXTAREA' || isDatePart(el)) {
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
    && !/linkedin|url|link|website|twitter|e ?mail|phone|date|zip|postal|social security|\bssn\b|birth|password|gpa|name$|year|how many|number/.test(norm(question));
  // The user doesn't share LinkedIn: a required box says N/A (a URL-only box can't), an optional one stays out of the review.
  const noLinkedIn = question => !p.linkedin && /linkedin/.test(norm(question));
  async function fillNeutral(needs) {
    for (const need of needs) {
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
    : el.tagName === 'TEXTAREA' || isDatePart(el) ? !!el.value.trim() : !!answeredValue(el));
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
        if (!el.value.trim() && !sideNote.test(q)) add('essay', `${label}${detail ? ` ${detail}` : ''}`, [], { el });
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
    for (const entry of filledEls.values()) {
      const el = entry.el;
      if (lost(entry) && entry.value && isText(el) && !isCombo(el) && !isPrompt(el) && !isDatePart(el)) setValue(el, entry.value);
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
        attachedHere = false;
        holdDrafts = !!plan.model;
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
