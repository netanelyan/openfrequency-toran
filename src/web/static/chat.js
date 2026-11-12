// The chat on a store's site, inside its frame (web/widget.ts): open and close, say something, read the answers. The
// visitor is a random id kept in this frame's own storage (never a cookie); it talks only to this site. The reviews
// block (data-reviews) only tells the store's page how tall it is.
//
// Open, the panel is a dialog: focus moves in and stays in (Tab wraps), Esc closes and gives focus back to the button,
// new messages are read out by the log's aria-live. A link in a message opens: the store's own pages in the same tab
// (the visitor stays on the site, and on a desk the chat opens again on the next page), anything else in a new one.
// A visitor who already talked gets a dot on the closed button when an answer arrives; one who never did costs no
// request until they open the chat.
(function () {
  var body = document.body;
  if (body.hasAttribute('data-reviews')) {
    var tell = function () { parent.postMessage({ t: 'toran:reviews', h: document.documentElement.scrollHeight }, '*'); };
    addEventListener('load', tell);
    if (window.ResizeObserver) new ResizeObserver(tell).observe(document.documentElement);
    return;
  }
  // A logo that does not load: the store's initial in its place, never a broken image.
  var logo = document.querySelector('img.c-logo');
  if (logo) {
    var swap = function () {
      var span = document.createElement('span');
      span.className = 'c-initial';
      span.setAttribute('aria-hidden', 'true');
      span.textContent = ((document.getElementById('c-name') || {}).textContent || '?').trim().charAt(0) || '?';
      logo.replaceWith(span);
    };
    if (logo.complete && !logo.naturalWidth) swap(); else logo.addEventListener('error', swap);
  }
  // The preview on Settings needs only that: nothing there talks to anyone.
  if (body.classList.contains('pv-body')) return;
  var key = body.getAttribute('data-key');
  var base = '/w/' + key;
  var sites = (body.getAttribute('data-sites') || '').split(' ').filter(Boolean);
  var openBtn = document.querySelector('.c-open');
  var badge = document.querySelector('.c-badge');
  var panel = document.getElementById('c-panel');
  var closeBtn = document.querySelector('.c-close');
  var lines = document.querySelector('.c-lines');
  var chips = document.querySelector('.c-chips');
  var form = document.querySelector('.c-box');
  var box = document.getElementById('c-text');
  var typing = document.querySelector('.c-typing');
  var error = document.querySelector('.c-error');
  var still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var touch = window.matchMedia && matchMedia('(pointer: coarse)').matches;

  function store(kind, name) {
    try {
      return (kind === 'session' ? sessionStorage : localStorage).getItem('toran-' + name + '-' + key);
    } catch (e) { return null; }
  }
  function put(kind, name, value) {
    try {
      var s = kind === 'session' ? sessionStorage : localStorage;
      if (value == null) s.removeItem('toran-' + name + '-' + key); else s.setItem('toran-' + name + '-' + key, value);
    } catch (e) { /* storage blocked: this visit only */ }
  }

  function newId() {
    var a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return btoa(String.fromCharCode.apply(null, a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  var visitor = (function () {
    try {
      var v = localStorage.getItem('toran-' + key);
      if (v && /^[A-Za-z0-9_-]{22}$/.test(v)) return v;
      v = newId();
      localStorage.setItem('toran-' + key, v);
      return v;
    } catch (e) {
      return newId(); // storage blocked: this visit only
    }
  })();

  var last = 0;
  var seen = Number(store('local', 'seen')) || 0;
  var timer = null;
  var waitingSince = 0;
  var mine = {}; // what this visitor wrote and already sees, until the server's copy of it arrives

  // A link as the visitor reads it: the site and the page, short, never "javascript:" (only http and https are found).
  var LINK = /https?:\/\/[^\s<>"'׳״]+/g;
  // A page of the store's own site reads as its name, from its address ("/products/מיסטרי-בוקס-ילדים": "מיסטרי בוקס
  // ילדים"), not as the site's long address cut short across lines (the owner's store, 2026-11-11).
  function shortLink(u) {
    try {
      var x = new URL(u);
      var path = x.pathname;
      try { path = decodeURIComponent(path); } catch (e) { /* as it is */ }
      var page = path.replace(/\/+$/, '').split('/').pop().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (own(u) && /[^\d\s]/.test(page)) return page.length > 40 ? page.slice(0, 38) + '…' : page;
      var s = x.hostname.replace(/^www\./, '') + path.replace(/\/$/, '');
      return s.length > 42 ? s.slice(0, 40) + '…' : s;
    } catch (e) {
      return u;
    }
  }
  function own(u) {
    try { return sites.indexOf(new URL(u).origin) >= 0; } catch (e) { return false; }
  }
  function fill(p, text) {
    var at = 0, m;
    LINK.lastIndex = 0;
    while ((m = LINK.exec(text))) {
      var url = m[0].replace(/[.,!?;:)\]}]+$/, '');
      if (m.index > at) p.appendChild(document.createTextNode(text.slice(at, m.index)));
      var a = document.createElement('a');
      a.href = url;
      a.textContent = shortLink(url);
      a.dir = /[א-ת]/.test(a.textContent) ? 'auto' : 'ltr';
      a.rel = 'noopener';
      a.target = own(url) ? '_top' : '_blank';
      p.appendChild(a);
      at = m.index + url.length;
      LINK.lastIndex = at;
    }
    if (at < text.length) p.appendChild(document.createTextNode(text.slice(at)));
  }

  function add(who, text) {
    var p = document.createElement('p');
    p.className = 'c-line ' + (who === 'me' ? 'c-me' : 'c-store');
    p.dir = 'auto';
    fill(p, text);
    lines.appendChild(p);
    lines.scrollTop = lines.scrollHeight;
    if (who === 'me' && chips) chips.hidden = true;
    return p;
  }

  function markSeen() {
    if (last > seen) { seen = last; put('local', 'seen', String(seen)); }
    badge.hidden = true;
    openBtn.setAttribute('aria-label', openBtn.getAttribute('data-label') || openBtn.getAttribute('aria-label'));
  }

  function poll() {
    clearTimeout(timer);
    fetch(base + '/lines?v=' + encodeURIComponent(visitor) + '&after=' + last, { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var fresh = false;
        (d && d.lines ? d.lines : []).forEach(function (l) {
          if (l.id <= last) return;
          last = l.id;
          if (l.who === 'me' && mine[l.text]) { mine[l.text]--; return; }
          add(l.who, l.text);
          if (l.who === 'store') { waitingSince = 0; typing.hidden = true; if (l.id > seen) fresh = true; }
        });
        if (!panel.hidden) markSeen();
        else if (fresh) {
          badge.hidden = false;
          openBtn.setAttribute('aria-label', (openBtn.getAttribute('data-label') || '') + ', יש תשובה חדשה');
        }
      })
      .catch(function () {})
      .then(function () {
        if (waitingSince && Date.now() - waitingSince > 90000) { waitingSince = 0; typing.hidden = true; }
        timer = setTimeout(poll, panel.hidden ? 30000 : waitingSince ? 2000 : 6000);
      });
  }

  var closing = null;
  function show(open) {
    clearTimeout(closing);
    if (open) {
      parent.postMessage({ t: 'toran:open', open: true }, '*');
      panel.classList.remove('c-out');
      panel.hidden = false;
      openBtn.hidden = true;
      openBtn.setAttribute('aria-expanded', 'true');
      put('session', 'open', '1');
      lines.scrollTop = lines.scrollHeight;
      // On a phone the keyboard would cover half the conversation at once: there the focus goes to the conversation.
      if (touch) lines.focus(); else box.focus();
      markSeen();
      poll();
      return;
    }
    put('session', 'open', null);
    var done = function () {
      panel.hidden = true;
      panel.classList.remove('c-out');
      openBtn.hidden = false;
      openBtn.setAttribute('aria-expanded', 'false');
      parent.postMessage({ t: 'toran:open', open: false }, '*');
      openBtn.focus();
    };
    if (still) return done();
    panel.classList.add('c-out');
    closing = setTimeout(done, 140);
  }

  // The loader says when the open chat is a sheet over a phone's whole screen (it sees the page's size; the frame does not).
  window.addEventListener('message', function (e) {
    if (e.source !== parent || sites.indexOf(e.origin) < 0 || !e.data || e.data.t !== 'toran:full') return;
    document.documentElement.classList.toggle('full', Boolean(e.data.full));
  });

  openBtn.addEventListener('click', function () { show(true); });
  closeBtn.addEventListener('click', function () { show(false); });
  document.addEventListener('keydown', function (e) {
    if (panel.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); show(false); return; }
    if (e.key !== 'Tab') return;
    // The focus stays in the open chat: Tab from the last control goes to the first, Shift+Tab the other way.
    var all = Array.prototype.filter.call(panel.querySelectorAll('a[href], button:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])'), function (el) { return el.getClientRects().length > 0; });
    if (!all.length) return;
    var first = all[0], end = all[all.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === lines)) { e.preventDefault(); end.focus(); }
    else if (!e.shiftKey && document.activeElement === end) { e.preventDefault(); first.focus(); }
  });

  function grow() { box.style.height = 'auto'; box.style.height = Math.min(box.scrollHeight, 120) + 'px'; }
  box.addEventListener('input', grow);
  box.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  function send() { if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event('submit', { cancelable: true })); }
  if (chips) chips.addEventListener('click', function (e) {
    var b = e.target.closest('.c-chip');
    if (!b) return;
    box.value = b.textContent;
    send();
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = box.value.trim();
    if (!text) return;
    var line = add('me', text);
    mine[text] = (mine[text] || 0) + 1;
    put('local', 'talked', '1');
    box.value = '';
    grow();
    error.hidden = true;
    waitingSince = Date.now();
    typing.hidden = false;
    // A message the server did not take (twelve a minute, no connection) is not left in the chat as if it went: it goes
    // back into the box, to send again (the audit of 2026-11-12, P2-8).
    function unsent(message) {
      if (line.parentNode) line.parentNode.removeChild(line);
      mine[text] = Math.max(0, (mine[text] || 1) - 1);
      if (!box.value) { box.value = text; grow(); }
      error.textContent = message;
      error.hidden = false;
      typing.hidden = true;
      waitingSince = 0;
    }
    fetch(base + '/say', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ v: visitor, text: text }) })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (d) {
        if (d && d.ok) return;
        unsent((d && d.message) || 'ההודעה לא נשלחה. אפשר לנסות שוב.');
      })
      .catch(function () { unsent('אין חיבור כרגע. אפשר לנסות שוב בעוד רגע.'); })
      .then(poll);
  });

  // Back on the site after a link: a desk opens the chat again where it was; a phone does not cover the new page.
  if (store('session', 'open') === '1' && window.innerWidth >= 520 && !touch) show(true);
  else if (store('local', 'talked') === '1') poll();
})();
