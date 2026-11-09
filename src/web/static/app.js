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
      // A form with a file goes as it is (multipart); every other as a plain form.
      const multipart = form.enctype === 'multipart/form-data';
      const res = await fetch(form.action, {
        method: 'POST',
        headers: multipart ? { 'x-tn-ajax': '1' } : { 'x-tn-ajax': '1', 'content-type': 'application/x-www-form-urlencoded' },
        body: multipart ? new FormData(form) : new URLSearchParams(new FormData(form)),
        credentials: 'same-origin',
      });
      const out = await res.json().catch(() => ({ ok: false, message: 'תשובה לא צפויה מהשרת' }));
      const kind = form.dataset.ajax;
      // An answer to a customer that did not go: the reason inside its box, and the text left where it was typed.
      const err = form.querySelector('[data-error]');
      if (kind === 'reply' && err) {
        err.hidden = out.ok;
        err.textContent = out.ok ? '' : out.message || 'לא נשלח.';
        if (!out.ok) return;
      }
      say(out.message, !out.ok);
      if (!out.ok) return;
      if (kind === 'reply') location.href = out.redirect || location.href;
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

  // A file over the size a form takes is refused before it is sent (data-max, in bytes), with the form's own words.
  document.addEventListener('change', (e) => {
    const input = e.target.closest('input[type=file][data-max]');
    if (!input) return;
    const big = [...(input.files || [])].some((f) => f.size > Number(input.dataset.max));
    input.setCustomValidity(big ? input.dataset.tooBig || '' : '');
    if (big) input.reportValidity();
    // The answer box's paperclip (pages/home.ts) says which file is attached, where it said "לצרף קובץ".
    const name = input.closest('.cmp-file')?.querySelector('[data-file-name]');
    if (name) {
      name.dataset.empty ??= name.textContent;
      const f = input.files?.[0];
      name.textContent = f ? f.name : name.dataset.empty;
      input.closest('.cmp-file').classList.toggle('has', !!f);
    }
  });

  // The inbox's list beside an open conversation: the open one in view, wherever it sits in the list.
  document.querySelector('.ib-list a[aria-current="page"]')?.scrollIntoView({ block: 'nearest' });

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    const target = a && a.getAttribute('href').length > 1 ? document.querySelector(a.getAttribute('href')) : null;
    if (target?.tagName === 'DETAILS') target.open = true;
  });

  // A page that waits for a job (ingest, page build) loads itself again when the job ends (PRA-FE-006). It asks every 2
  // seconds for the first minute, then every 10; after 3 minutes it says the reading takes longer than usual, with the
  // job's own progress line; after 15 it stops asking and says so, with the way to write to us (data-help). Nothing is
  // asked while the tab is hidden. A job that is gone, a session that ended or a redirect end the waiting too, with a
  // link to load the page again.
  const wait = document.querySelector('[data-wait-job]');
  if (wait) {
    const started = Date.now();
    let timer = null;
    let over = false;
    const note = document.createElement('p');
    note.className = 'small mt8 m0';
    note.setAttribute('role', 'status');
    const tell = (text, { reload = false, help = false } = {}) => {
      note.textContent = text;
      if (reload) {
        const a = document.createElement('a');
        a.href = location.href;
        a.textContent = ' לטעון את הדף מחדש';
        note.append(a);
      }
      if (help && wait.dataset.help) {
        const a = document.createElement('a');
        a.href = wait.dataset.help;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = ' לכתוב לנו';
        note.append(a);
      }
      if (!note.isConnected) (wait.querySelector('div') || wait).append(note);
    };
    const stop = (text, opts) => {
      over = true;
      clearTimeout(timer);
      tell(text, opts);
    };
    const next = () => {
      if (over || document.hidden) return;
      const spent = Date.now() - started;
      if (spent > 15 * 60_000) return stop('זה לוקח הרבה יותר מהרגיל, אז הדף הפסיק לבדוק לבד.', { reload: true, help: true });
      timer = setTimeout(poll, spent < 60_000 ? 2000 : 10_000);
    };
    const poll = async () => {
      if (over || document.hidden) return;
      try {
        const r = await fetch(`${document.documentElement.dataset.base || ''}/jobs/${wait.dataset.waitJob}.json`, { credentials: 'same-origin', redirect: 'manual' });
        if (r.type === 'opaqueredirect' || r.redirected || r.status === 401 || r.status === 403) return stop('החיבור לדף נקטע.', { reload: true });
        const j = await r.json();
        if (j.status === 'missing') return stop('העבודה הזו כבר לא כאן.', { reload: true });
        if (j.status === 'done' || j.status === 'failed') return location.reload();
        const line = wait.querySelector('[data-progress]');
        if (line && j.progress) line.textContent = j.progress;
        if (Date.now() - started > 3 * 60_000) tell(`הקריאה לוקחת יותר מהרגיל. אפשר להשאיר את הדף פתוח, הוא יתעדכן לבד.${!line && j.progress ? ` עכשיו: ${j.progress}` : ''}`);
      } catch {}
      next();
    };
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && !over) {
        clearTimeout(timer);
        poll();
      }
    });
    timer = setTimeout(poll, 1500);
  }

  // The email card waiting for Gmail's confirmation (pages/mailSetup.ts): it asks where the card stands every 5 seconds
  // while the tab is open, and loads the page again when that changes, so the code shows up by itself. It stops after
  // 20 minutes, and never asks while the tab is hidden.
  const mailWait = document.querySelector('[data-wait-mail]');
  if (mailWait) {
    const started = Date.now();
    let timer = null;
    const ask = async () => {
      if (document.hidden || Date.now() - started > 20 * 60_000) return;
      try {
        const r = await fetch(`${document.documentElement.dataset.base || ''}${mailWait.dataset.waitMail}`, { credentials: 'same-origin', redirect: 'manual' });
        if (r.ok) {
          const j = await r.json();
          if (j.v && j.v !== mailWait.dataset.v) return location.reload();
        }
      } catch {}
      timer = setTimeout(ask, 5000);
    };
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        clearTimeout(timer);
        ask();
      }
    });
    timer = setTimeout(ask, 3000);
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

  // The parts that fold away on a phone (ui.ts fold, as Teder's): folded as a phone opens the page, except the one a link
  // points into and one that was open before the page came back (each page keeps which, for this tab only); from 700px
  // every one is open, and a phone turned wide opens them.
  const folds = [...document.querySelectorAll('details[data-mfold]')];
  if (folds.length) {
    const phone = window.matchMedia('(max-width: 699px)');
    const KEPT = `tn-mfold:${location.pathname}`;
    let kept = [];
    try { kept = JSON.parse(sessionStorage.getItem(KEPT)) || []; } catch { kept = []; }
    const target = () => (location.hash.length > 1 ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null);
    const unfold = (el) => { for (let d = el?.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true; };
    if (phone.matches) {
      for (const d of folds) d.open = Array.isArray(kept) && kept.includes(d.dataset.mfold);
      const t = target();
      if (t?.closest('details[data-mfold]')) {
        unfold(t);
        requestAnimationFrame(() => t.scrollIntoView({ block: 'start' }));
      }
    }
    const keep = () => { try { sessionStorage.setItem(KEPT, JSON.stringify(folds.filter((d) => d.open).map((d) => d.dataset.mfold))); } catch { /* a browser that keeps nothing */ } };
    for (const d of folds) d.addEventListener('toggle', () => { if (phone.matches) keep(); });
    phone.addEventListener?.('change', () => { if (!phone.matches) for (const d of folds) d.open = true; });
    window.addEventListener('hashchange', () => unfold(target()));
  }

  // Notifications on this device (Settings, owners/push.ts), as Teder's: the service worker at the root, the browser's
  // permission, its subscription with the server's key, then the form posts its endpoint. A device already subscribed is
  // offered the off button instead.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-push-enable]');
    if (!btn) return;
    const form = btn.closest('form[data-push]');
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return say('הדפדפן הזה לא תומך בהתראות. בטלפון: מוסיפים את תורן למסך הבית ומנסים משם.', true);
    try {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      if ((await Notification.requestPermission()) !== 'granted') return say('ההתראות לא אושרו בדפדפן.', true);
      const raw = atob(form.dataset.push.replace(/-/g, '+').replace(/_/g, '/'));
      const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
      form.querySelector('[name=endpoint]').value = sub.endpoint;
      form.requestSubmit();
    } catch {
      say('לא הצלחנו להפעיל התראות בדפדפן הזה.', true);
    }
  });
  const pushOn = document.querySelector('form[data-push]');
  const pushOff = document.querySelector('form[data-push-off]');
  const thisSub = async () => {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration('/') : null;
    return reg?.pushManager ? reg.pushManager.getSubscription() : null;
  };
  if (pushOn && pushOff) {
    thisSub().then((sub) => {
      if (!sub) return;
      pushOn.hidden = true;
      pushOff.hidden = false;
    }).catch(() => {});
  }
  document.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-push-disable]') || !pushOff) return;
    try {
      const sub = await thisSub();
      if (!sub) return say('ההתראות כבר כבויות במכשיר הזה.');
      pushOff.querySelector('[name=endpoint]').value = sub.endpoint;
      await sub.unsubscribe();
      pushOff.requestSubmit();
    } catch {
      say('לא הצלחנו לכבות את ההתראות.', true);
    }
  });

  // Adding Toran to the phone (src/web/install.ts; the owner, 2026-11-09: "add a little tutorial on how to add the
  // website as an app to the phone"). Inside the installed app none of it shows, and the browser remembers the app was
  // opened, so Today's card stays away there too. An iPad that says it is a Mac gets Safari's steps by its touch screen.
  // Where Chrome offers to install (beforeinstallprompt), its steps become one button that asks it; installed, the
  // card goes. The x closes Today's card for good in this browser (the cookie tn_install, read by the server).
  const installs = [...document.querySelectorAll('[data-install]')];
  if (installs.length) {
    const keep = (v) => {
      try {
        document.cookie = `tn_install=${v}; Path=/; Max-Age=31536000; SameSite=Lax`;
      } catch {}
    };
    const standalone = window.matchMedia?.('(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)').matches || navigator.standalone === true;
    const show = (key) => {
      for (const box of installs) for (const v of box.querySelectorAll('[data-for]')) v.hidden = v.dataset.for !== key;
    };
    if (standalone) {
      keep('app');
      for (const box of installs) box.remove();
    } else {
      for (const f of document.querySelectorAll('[data-install-url]')) f.value = `${location.origin}/`;
      if (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1) show('ios-safari');
      // The steps shown before Chrome's offer, for when its dialog is dismissed: the button would then ask nothing.
      const steps = installs[0].querySelector('[data-for]:not([hidden])')?.dataset.for;
      let asked = null;
      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        asked = e;
        show('prompt');
      });
      document.addEventListener('click', async (e) => {
        if (e.target.closest('[data-install-close]')) {
          keep('hide');
          e.target.closest('[data-install]')?.remove();
          return;
        }
        if (!e.target.closest('[data-install-go]') || !asked) return;
        const ask = asked;
        asked = null;
        try {
          await ask.prompt();
          if ((await ask.userChoice).outcome !== 'accepted' && steps) show(steps);
        } catch {
          if (steps) show(steps);
        }
      });
      window.addEventListener('appinstalled', () => {
        keep('app');
        document.querySelector('[data-install="card"]')?.remove();
        say('תורן נוסף למסך הבית');
      });
    }
  }

  // The waiting count, live (TORAN-READINESS.md P1-13): while the page is visible, /waiting.json every 45 seconds keeps
  // the Chats badge (side bar and tab bar) and the tab's title true. A conversation that started waiting since the page
  // loaded is said once, with the way to it; an open conversation's own page is left as it is.
  const chatsLinks = [...document.querySelectorAll('a[href="/chats"]')].filter((a) => a.closest('.nav, .tabbar'));
  if (chatsLinks.length && !document.body.classList.contains('ro')) {
    const title = document.title.replace(/^\(\d+\) /, '');
    const shown = () => Number(chatsLinks[0].querySelector('.badge')?.textContent || 0);
    let last = shown();
    const paint = (n) => {
      for (const a of chatsLinks) {
        let b = a.querySelector('.badge');
        if (!n) {
          b?.remove();
          continue;
        }
        if (!b) {
          b = document.createElement('b');
          b.className = 'badge num';
          a.append(b);
        }
        b.textContent = String(n);
        b.setAttribute('aria-label', `${n} מחכים`);
      }
      document.title = n ? `(${n}) ${title}` : title;
    };
    paint(last);
    const ask = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const r = await fetch(`${base}/waiting.json`, { credentials: 'same-origin', redirect: 'manual' });
        if (!r.ok) return;
        const n = Number((await r.json()).chats) || 0;
        if (n > last && !/^\/chat\/\d+/.test(location.pathname)) say(n - last === 1 ? 'שאלה חדשה מחכה לכם בשיחות' : `${n - last} שאלות חדשות מחכות לכם בשיחות`);
        if (n !== last) paint(n);
        last = n;
      } catch {
        /* offline for a moment: the next tick asks again */
      }
    };
    setInterval(ask, 45_000);
    document.addEventListener('visibilitychange', ask);
  }

  // The web chat's look on Settings (pages/webchat.ts): the preview redraws as the owner picks, before saving. Picking a
  // colour picks "צבע אחר" with it.
  document.querySelectorAll('form[data-look]').forEach((form) => {
    const frame = document.querySelector(form.dataset.look);
    if (!frame) return;
    const path = (frame.getAttribute('src') || '').split('?')[0];
    let t = null;
    const draw = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const f = new FormData(form);
        frame.src = `${path}?${new URLSearchParams({ use: String(f.get('use') || 'site'), color: String(f.get('color') || ''), mode: String(f.get('mode') || 'site') })}`;
      }, 160);
    };
    form.querySelector('input[type="color"]')?.addEventListener('input', () => {
      const own = form.querySelector('input[name="use"][value="own"]');
      if (own) own.checked = true;
    });
    form.addEventListener('input', draw);
    form.addEventListener('change', draw);
  });
})();
