// The desk's one script. Everything works without it; this makes the common actions one tap without a page load.
// Ported from Teder's app.js (toast, two-tap confirm, toggles, ajax forms, the sidebar, developer mode), plus copy:
// the dashboard prepares a message and copies it; it never sends one.
(() => {
  document.documentElement.classList.add('js');
  const toast = document.getElementById('toast');
  let toastTimer = null;
  const say = (msg, bad = false) => {
    if (!toast || !msg) return;
    toast.textContent = msg;
    toast.classList.toggle('bad', bad);
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
  };
  if (toast?.dataset.flash) say(toast.dataset.flash);

  document.querySelector('[data-side]')?.addEventListener('click', (e) => {
    const mini = document.documentElement.classList.toggle('side-mini');
    const b = e.currentTarget;
    b.setAttribute('aria-expanded', String(!mini));
    b.setAttribute('aria-label', mini ? 'הרחבת סרגל הצד' : 'כיווץ סרגל הצד');
    document.cookie = `tn_side=${mini ? 'mini' : 'full'}; Path=/; Max-Age=31536000; SameSite=Strict`;
  });

  const lift = () => document.documentElement.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', lift, { passive: true });
  lift();

  // Two taps for anything that cannot be undone in one.
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-confirm]');
    if (!b || b.dataset.armed === '1') return;
    e.preventDefault();
    b.dataset.armed = '1';
    b.dataset.label = b.innerHTML;
    b.classList.add('armed');
    b.textContent = b.dataset.confirm;
    setTimeout(() => {
      if (b.dataset.armed === '1') {
        b.dataset.armed = '';
        b.classList.remove('armed');
        b.innerHTML = b.dataset.label;
      }
    }, 3500);
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-toggle]');
    if (!b) return;
    const box = document.querySelector(b.dataset.toggle);
    if (!box) return;
    const open = box.classList.toggle('open');
    b.setAttribute('aria-expanded', String(open));
    if (open) box.querySelector('select, input, textarea')?.focus();
  });

  // Copy a prepared message (and open the contact, for the "copy and open" buttons). The copy runs inside the
  // click, where browsers allow it; execCommand first because it works on more phones.
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    const src = document.querySelector(b.dataset.copy);
    const text = src ? ('value' in src ? src.value : src.textContent) : b.dataset.text || '';
    let ok = false;
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.className = 'sr';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch {}
    if (!ok) {
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {}
    }
    say(ok ? (b.dataset.done || 'הועתק') : 'לא הצלחתי להעתיק. אפשר לסמן ולהעתיק ידנית.', !ok);
    if (ok) {
      b.classList.add('copied');
      setTimeout(() => b.classList.remove('copied'), 1600);
    }
    if (ok && b.dataset.open) window.open(b.dataset.open, '_blank', 'noopener');
  });

  // Forms marked data-ajax post in the background.
  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-ajax]');
    if (!form) return;
    const btn = form.querySelector('[data-confirm]');
    if (btn && btn.dataset.armed !== '1') return;
    e.preventDefault();
    const submit = form.querySelector('button[type=submit]');
    submit?.setAttribute('aria-busy', 'true');
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { 'x-tn-ajax': '1', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(form)),
        credentials: 'same-origin',
      });
      const out = await res.json().catch(() => ({ ok: false, message: 'תשובה לא צפויה מהשרת' }));
      say(out.message, !out.ok);
      if (!out.ok) return;
      const kind = form.dataset.ajax;
      if (kind === 'remove') {
        const card = form.closest('[data-item]');
        if (card) {
          card.style.maxHeight = `${card.scrollHeight}px`;
          card.classList.add('leaving');
          setTimeout(() => card.classList.add('gone'), 220);
          setTimeout(() => card.remove(), 600);
        }
      } else if (kind === 'reload') setTimeout(() => location.reload(), 400);
      else if (kind === 'go' && out.redirect) location.href = out.redirect;
    } catch {
      say('אין חיבור. כדאי לנסות שוב.', true);
    } finally {
      submit?.removeAttribute('aria-busy');
    }
  });

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    const target = a && a.getAttribute('href').length > 1 ? document.querySelector(a.getAttribute('href')) : null;
    if (target?.tagName === 'DETAILS') target.open = true;
  });

  // A page that waits for a job (ingest, page build) refreshes itself until the job is done.
  const wait = document.querySelector('[data-wait-job]');
  if (wait) {
    const poll = async () => {
      try {
        const r = await fetch(`${document.documentElement.dataset.base || ''}/jobs/${wait.dataset.waitJob}.json`, { credentials: 'same-origin' });
        const j = await r.json();
        const line = wait.querySelector('[data-progress]');
        if (line && j.progress) line.textContent = j.progress;
        if (j.status === 'done' || j.status === 'failed') return location.reload();
      } catch {}
      setTimeout(poll, 2000);
    };
    setTimeout(poll, 1500);
  }

  // Developer mode opens from the settings' version line, tapped seven times in a row.
  let taps = 0;
  let lastTap = 0;
  document.addEventListener('click', (e) => {
    const line = e.target.closest('[data-devtap]');
    if (!line) return;
    const t = Date.now();
    taps = t - lastTap < 800 ? taps + 1 : 1;
    lastTap = t;
    if (taps >= 7) line.submit();
  });

  // Loading: a tap never sits still. ~120ms after a link or a form is used (and not handled above), a bar runs along
  // the top; a link also turns the page under the header into the skeleton of the page that is coming, and a form's
  // button spins, until the next page paints. A quick page never shows any of it. Downloads, new tabs, other sites,
  // in-page anchors and the background forms (data-ajax) are left alone; Back to a page kept in memory gets it as it was.
  const root = document.documentElement;
  const main = document.getElementById('main');
  const base = root.dataset.base || '';
  const SHAPES = [
    [/^\/$/, 'today'],
    [/^\/(leads|chats|followups)$/, 'list'],
    [/^\/review$/, 'cards'],
    [/^\/(chat\/\d+|assistant|lead\/\d+\/assistant)$/, 'thread'],
    [/^\/(lead\/\d+(\/(knowledge|review))?|knowledge|settings|plan|brand)$/, 'cols'],
  ];
  const DOWNLOAD = /\.(csv|json|pdf|zip|png|jpe?g|webp|gif|svg)$|\/file\/\d+$/i;
  const shapeOf = (path) => {
    const p = base && path.startsWith(base) ? path.slice(base.length) || '/' : path;
    return (SHAPES.find(([re]) => re.test(p)) || [null, 'page'])[1];
  };
  const div = (cls, ...kids) => {
    const d = document.createElement('div');
    d.className = cls;
    d.append(...kids);
    return d;
  };
  const W = [78, 52, 88, 40, 66, 82, 46, 70];
  const line = (i, cls = '') => {
    const s = div(`sk ${cls}`);
    s.style.width = `${W[i % W.length]}%`;
    return s;
  };
  const lines = (n, from = 0) => div('sk-lines', ...Array.from({ length: n }, (_, i) => line(from + i)));
  const row = (i) => div('sk-row', div('sk dot'), div('sk-lines', line(i), line(i + 3, 'sub')), div('sk pill'));
  const rows = (n) => div('list', ...Array.from({ length: n }, (_, i) => row(i)));
  const panel = (n, from = 0) => div('panel', lines(n, from));
  const BUILD = {
    today: () => [div('kpis', div('kpi lead', line(1), line(4, 'big')), div('kpi side', line(3), line(6, 'big'))), rows(4)],
    list: () => [div('sk-tabs', div('sk'), div('sk'), div('sk')), rows(7)],
    cards: () => [div('cards', ...[0, 1, 2, 3].map((i) => div('card panel', lines(4, i), div('sk-acts', div('sk btn'), div('sk btn')))))],
    thread: () => [div('panel sk-thread', ...['in', 'out', 'in', 'out', 'in'].map((side, i) => line(i, side)))],
    cols: () => [div('cols', div('grid12', panel(6), panel(4, 2)), div('grid12', panel(5, 1)))],
    page: () => [panel(5), panel(3, 3)],
  };
  const skeleton = (shape) => {
    const page = div('sk-page', div('sk-head', line(0, 'h1'), line(5, 'sub')), ...BUILD[shape]());
    page.setAttribute('role', 'status');
    page.prepend(Object.assign(document.createElement('span'), { className: 'sk-say', textContent: 'טוען…' }));
    return page;
  };

  let bar = null;
  let timer = 0;
  let busy = null;
  let navWas = null;
  let scrolled = null;
  const stop = () => {
    clearTimeout(timer);
    root.classList.remove('is-loading', 'sk-on');
    main?.querySelector(':scope > .sk-page')?.remove();
    main?.removeAttribute('aria-busy');
    busy?.removeAttribute('aria-busy');
    busy = null;
    if (navWas) for (const [a, cur] of navWas) cur ? a.setAttribute('aria-current', cur) : a.removeAttribute('aria-current');
    navWas = null;
    if (scrolled != null) window.scrollTo(0, scrolled);
    scrolled = null;
  };
  const start = (shape, button) => {
    stop();
    if (button) setTimeout(() => button.setAttribute('aria-busy', 'true')); // after the submit, so its name still goes
    busy = button;
    timer = setTimeout(() => {
      bar ??= document.body.appendChild(div('loadbar'));
      root.classList.add('is-loading');
      if (!shape || !main) return;
      main.prepend(skeleton(shape));
      main.setAttribute('aria-busy', 'true');
      root.classList.add('sk-on');
      scrolled = window.scrollY;
      window.scrollTo(0, 0);
    }, 120);
  };
  const leaves = (url) => url.origin === location.origin && !DOWNLOAD.test(url.pathname) && !(url.pathname === location.pathname && url.search === location.search && url.hash);

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if ((a.target && a.target !== '_self') || a.hasAttribute('download') || a.hasAttribute('data-no-wait')) return;
    const url = new URL(a.href, location.href);
    if (!leaves(url)) return;
    // The tab you tapped lights up now, not when its page arrives.
    const nav = a.closest('nav.nav, nav.tabbar');
    if (nav) {
      navWas = [...document.querySelectorAll('nav.nav a, nav.tabbar a')].map((x) => [x, x.getAttribute('aria-current')]);
      const keep = navWas;
      start(shapeOf(url.pathname));
      navWas = keep;
      for (const [x] of navWas) x.toggleAttribute('aria-current', x.getAttribute('href') === a.getAttribute('href'));
      for (const [x] of navWas) if (x.hasAttribute('aria-current')) x.setAttribute('aria-current', 'page');
    } else start(shapeOf(url.pathname));
  });
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (e.defaultPrevented || (form.target && form.target !== '_self') || form.hasAttribute('data-no-wait')) return;
    const url = new URL(form.getAttribute('action') || location.href, location.href);
    if (url.origin !== location.origin || DOWNLOAD.test(url.pathname)) return;
    if ((form.getAttribute('method') || 'get').toLowerCase() === 'get') start(shapeOf(url.pathname));
    else start(null, e.submitter || form.querySelector('[type=submit], button:not([type])'));
  });
  window.addEventListener('pageshow', (e) => e.persisted && stop());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && root.classList.contains('is-loading') && stop());

  // Images on their way keep their box (style.css) until they are in.
  const mark = (img) => img.classList.add('ok');
  for (const img of document.querySelectorAll('main img')) {
    if (img.complete) mark(img);
    else for (const ev of ['load', 'error']) img.addEventListener(ev, () => mark(img), { once: true });
  }
})();
