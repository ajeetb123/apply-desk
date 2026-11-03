// Apply Desk workspace behavior: motion, the fit constellation, and the
// bridge to the Mac app (window.webkit.messageHandlers.applyDesk).
(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.applyDesk;
  const send = (action, extra = {}) => bridge && bridge.postMessage({ action, ...extra });
  const SVG = 'http://www.w3.org/2000/svg';
  const make = (tag, attrs = {}, parent) => {
    const node = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (parent) parent.appendChild(node);
    return node;
  };
  const tierOf = score => (score >= 60 ? 'high' : score >= 40 ? 'mid' : 'low');

  // Greeting and date use the Mac's clock, not the server's.
  const hour = new Date().getHours();
  const greeting = hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  $$('[data-greeting-text]').forEach(node => { node.textContent = greeting; });
  const dateLine = $('[data-greeting]');
  if (dateLine) dateLine.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  // Numbers count up alongside the ring animation.
  $$('[data-count]').forEach(node => {
    const target = Number(node.dataset.count) || 0;
    if (reduceMotion || !target) return;
    const start = performance.now() + 150;
    const duration = 1300 + Math.min(target, 100) * 5;
    node.textContent = '0';
    const tick = now => {
      const t = Math.max(0, Math.min(1, (now - start) / duration));
      node.textContent = String(Math.round(target * (1 - Math.pow(1 - t, 4))));
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  // The page title slides into the toolbar once the heading scrolls away.
  const main = $('#main');
  if (main) main.addEventListener('scroll', () => main.classList.toggle('is-scrolled', main.scrollTop > 60), { passive: true });

  // Friendly relative times.
  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  $$('time[datetime]').forEach(node => {
    const date = new Date(node.getAttribute('datetime'));
    if (Number.isNaN(date.getTime())) return;
    const minutes = Math.round((date - Date.now()) / 60000);
    const size = Math.abs(minutes);
    node.title = date.toLocaleString();
    node.textContent = size < 1 ? 'Just now'
      : size < 60 ? relative.format(minutes, 'minute')
      : size < 1440 ? relative.format(Math.round(minutes / 60), 'hour')
      : size < 10080 ? relative.format(Math.round(minutes / 1440), 'day')
      : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  });

  // Fit constellation: you at the center, each role placed at 100 − fit.
  const cosmos = $('[data-cosmos]');
  if (cosmos) {
    let seed = 11;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const stars = $('.cosmos-stars', cosmos);
    for (let i = 0; i < 52; i += 1) {
      const angle = random() * Math.PI * 2;
      const radius = 56 + random() * 168;
      make('circle', { cx: (Math.cos(angle) * radius).toFixed(1), cy: (Math.sin(angle) * radius).toFixed(1), r: (random() * 1.1 + 0.3).toFixed(2), style: `animation-delay:${(-random() * 4).toFixed(2)}s` }, stars);
    }
    const roles = JSON.parse(($('#cosmos-data') || {}).textContent || '[]');
    const links = $('.cosmos-links', cosmos);
    const nodes = $('.cosmos-nodes', cosmos);
    const tip = $('.cosmos-tip');
    const wrap = cosmos.parentElement;
    if (!roles.length) {
      [104, 150, 196].forEach((radius, i) => {
        const orbit = make('g', { class: 'cosmos-ghost-orbit', style: `animation-duration:${36 + i * 16}s;animation-direction:${i % 2 ? 'reverse' : 'normal'}` }, nodes);
        make('circle', { class: 'cosmos-ghost', cx: radius, cy: 0, r: 3.2 - i * 0.6 }, orbit);
      });
    }
    roles.forEach((role, i) => {
      const score = Math.max(0, Math.min(100, Number(role.score) || 0));
      const radius = 40 + (100 - score) * 1.6;
      const angle = ((i * 137.508) - 90) * Math.PI / 180;
      const x = +(Math.cos(angle) * radius).toFixed(1);
      const y = +(Math.sin(angle) * radius).toFixed(1);
      const tier = tierOf(score);
      const line = make('line', { x1: 0, y1: 0, x2: x, y2: y, class: `tier-${tier}`, style: `animation-delay:${(-i * 0.37).toFixed(2)}s` }, links);
      const link = make('a', { href: `/job/${role.id}`, class: `cosmos-node tier-${tier}`, tabindex: '0', 'aria-label': `${role.title}, ${score} fit` }, nodes);
      const placed = make('g', { transform: `translate(${x} ${y})` }, link);
      const inner = make('g', { class: 'cosmos-node-inner', style: `--x:${x};--y:${y};--d:${(i * 0.08).toFixed(2)}s` }, placed);
      const size = 4.5 + score / 22;
      make('circle', { class: 'halo', r: (size * 2.3).toFixed(1) }, inner);
      make('circle', { class: 'dot', r: size.toFixed(1) }, inner);
      const show = () => {
        line.classList.add('is-hot');
        tip.replaceChildren();
        const value = document.createElement('em');
        value.textContent = `${score}`;
        value.style.color = `var(--${tier === 'high' ? 'mint' : tier === 'mid' ? 'amber' : 'ink-3'})`;
        const title = document.createElement('b');
        title.textContent = role.title;
        const company = document.createElement('span');
        company.textContent = role.company || 'Company not set';
        tip.append(value, title, company);
        const box = link.getBoundingClientRect();
        const host = wrap.getBoundingClientRect();
        tip.style.left = `${box.left + box.width / 2 - host.left}px`;
        tip.style.top = `${box.top - host.top}px`;
        tip.hidden = false;
      };
      const hide = () => { line.classList.remove('is-hot'); tip.hidden = true; };
      link.addEventListener('mouseenter', show);
      link.addEventListener('focus', show);
      link.addEventListener('mouseleave', hide);
      link.addEventListener('blur', hide);
    });
  }

  // Radar of the five fit signals.
  $$('svg.radar').forEach(svg => {
    const labels = svg.dataset.labels.split(',');
    const values = svg.dataset.values.split(',').map(Number);
    const radius = 96;
    const point = (i, r) => {
      const angle = (-90 + i * 360 / labels.length) * Math.PI / 180;
      return [+(Math.cos(angle) * r).toFixed(1), +(Math.sin(angle) * r).toFixed(1)];
    };
    [0.25, 0.5, 0.75, 1].forEach(step => make('polygon', { class: 'grid', points: labels.map((_, i) => point(i, radius * step).join(',')).join(' ') }, svg));
    labels.forEach((_, i) => { const [x, y] = point(i, radius); make('line', { class: 'spoke', x1: 0, y1: 0, x2: x, y2: y }, svg); });
    const reach = values.map(value => radius * Math.max(value, 5) / 100);
    make('polygon', { class: 'area', points: reach.map((r, i) => point(i, r).join(',')).join(' ') }, svg);
    reach.forEach((r, i) => { const [x, y] = point(i, r); make('circle', { class: 'vertex', cx: x, cy: y, r: 4, style: `--i:${i};transform-box:fill-box;transform-origin:center` }, svg); });
    labels.forEach((label, i) => {
      const [x, y] = point(i, radius + 14);
      const anchor = x > 4 ? 'start' : x < -4 ? 'end' : 'middle';
      make('text', { x, y: y + (Math.abs(x) < 4 ? (y < 0 ? -4 : 6) : 0), 'text-anchor': anchor }, svg).textContent = label;
    });
  });

  // Segmented control with a sliding thumb.
  $$('[data-tabs]').forEach(tabs => {
    const buttons = $$('[data-tab]', tabs);
    const thumb = $('.segmented-thumb', tabs);
    const scope = tabs.parentElement;
    const select = button => {
      buttons.forEach(other => other.setAttribute('aria-selected', String(other === button)));
      $$('[data-panel]', scope).forEach(panel => { panel.hidden = panel.dataset.panel !== button.dataset.tab; });
      thumb.style.width = `${button.offsetWidth}px`;
      thumb.style.transform = `translateX(${button.offsetLeft - 3}px)`;
    };
    buttons.forEach(button => button.addEventListener('click', () => select(button)));
    requestAnimationFrame(() => select(buttons[0]));
  });

  // Copy uses the native pasteboard inside the Mac app.
  $$('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    const text = document.getElementById(button.dataset.copy).value;
    if (bridge) send('copy', { text });
    else {
      try { await navigator.clipboard.writeText(text); } catch (error) { return; }
    }
    const label = $('span', button);
    label.textContent = 'Copied';
    setTimeout(() => { label.textContent = 'Copy'; }, 1800);
  }));

  $$('[data-autosize]').forEach(area => {
    const fit = () => { area.style.height = 'auto'; area.style.height = `${Math.min(area.scrollHeight + 2, 440)}px`; };
    area.addEventListener('input', fit);
  });

  // Resume drop zone submits as soon as a file arrives.
  $$('[data-dropzone]').forEach(zone => {
    const input = $('input[type=file]', zone);
    const submit = () => {
      if (!input.files.length) return;
      zone.classList.add('is-busy');
      $('b', zone).textContent = 'Reading your resume…';
      zone.submit();
    };
    input.addEventListener('change', submit);
    ['dragenter', 'dragover'].forEach(type => zone.addEventListener(type, event => { event.preventDefault(); zone.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach(type => zone.addEventListener(type, () => zone.classList.remove('is-over')));
    zone.addEventListener('drop', event => {
      event.preventDefault();
      if (event.dataTransfer && event.dataTransfer.files.length) { input.files = event.dataTransfer.files; submit(); }
    });
  });

  // Profile: live autofill preview, skill chips, tone label, and save state.
  const tones = ['', 'Direct', 'Confident', 'Assertive', 'Bold'];
  $$('[data-tone]').forEach(range => {
    const label = $('[data-tone-label]');
    const update = () => { label.textContent = tones[range.value] || 'Confident'; };
    range.addEventListener('input', update);
    update();
  });
  const chipSource = $('[data-chips-source]');
  const chipTarget = $('[data-chips]');
  const renderChips = () => {
    if (!chipSource || !chipTarget) return;
    chipTarget.replaceChildren(...chipSource.value.split(/[,;\n]/).map(part => part.trim()).filter(Boolean).map(part => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = part;
      return chip;
    }));
  };
  if (chipSource) { chipSource.addEventListener('input', renderChips); renderChips(); }
  $$('[data-dirty-form]').forEach(form => {
    const bar = $('[data-savebar]', form);
    const state = $('[data-save-state]', form);
    const snapshot = () => JSON.stringify([...new FormData(form)]);
    const initial = snapshot();
    form.addEventListener('input', event => {
      const key = event.target.dataset && event.target.dataset.fillSource;
      if (key) { const row = $(`[data-fill-for="${key}"]`); if (row) row.classList.toggle('is-set', Boolean(event.target.value.trim())); }
      const dirty = snapshot() !== initial;
      bar.classList.toggle('is-dirty', dirty);
      state.textContent = dirty ? 'Unsaved changes' : 'All changes saved';
    });
    document.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); form.requestSubmit(); }
    });
  });

  $$('form[data-confirm]').forEach(form => form.addEventListener('submit', event => {
    if (!window.confirm(form.dataset.confirm)) event.preventDefault();
  }));

  // Flash messages float in, then leave on their own.
  $$('.toast').forEach((toast, i) => setTimeout(() => {
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), 420);
  }, 3600 + i * 300));

  // Background agent card. The Mac app pushes state via ApplyDesk.native().
  const agent = $('[data-agent]');
  window.ApplyDesk = {
    native(state) {
      if (!agent) return;
      agent.dataset.state = state.watching ? 'watching' : 'paused';
      $('[data-agent-title]', agent).textContent = state.title || (state.watching ? 'Watching Chrome' : 'Watching paused');
      $('[data-agent-detail]', agent).textContent = state.detail || (state.watching ? 'Spots job listings as you browse' : 'Turn on to spot listings as you browse');
      const toggle = $('.switch', agent);
      toggle.hidden = false;
      toggle.setAttribute('aria-checked', String(Boolean(state.watching)));
      const last = $('[data-agent-last]', agent);
      last.textContent = state.lastResult || '';
      last.hidden = !state.lastResult;
    },
  };
  if (bridge && agent) {
    agent.dataset.state = 'paused';
    $('[data-agent-title]', agent).textContent = 'Connecting…';
  }
  // A Mac app has no "Reload" or "Back" context menu; keep it for text only.
  if (bridge) {
    document.addEventListener('contextmenu', event => {
      if (!event.target.closest('input, textarea, .paper, .events') && !String(window.getSelection())) event.preventDefault();
    });
  }
  $$('[data-native-action]').forEach(button => button.addEventListener('click', () => {
    if (button.getAttribute('role') === 'switch') {
      button.setAttribute('aria-checked', String(button.getAttribute('aria-checked') !== 'true'));
    }
    send(button.dataset.nativeAction);
  }));
})();
