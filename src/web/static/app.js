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
})();
