// The chat on a store's site, inside its frame (web/widget.ts): open and close, say something, read the answers. The
// visitor is a random id kept in this frame's own storage (never a cookie); it talks only to this site. The reviews
// block (data-reviews) only tells the store's page how tall it is.
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
  var key = body.getAttribute('data-key');
  var base = '/w/' + key;
  var openBtn = document.querySelector('.c-open');
  var panel = document.getElementById('c-panel');
  var closeBtn = document.querySelector('.c-close');
  var lines = document.querySelector('.c-lines');
  var form = document.querySelector('.c-box');
  var box = document.getElementById('c-text');
  var typing = document.querySelector('.c-typing');
  var error = document.querySelector('.c-error');

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
  var timer = null;
  var waitingSince = 0;
  var mine = {}; // what this visitor wrote and already sees, until the server's copy of it arrives

  function add(who, text) {
    var p = document.createElement('p');
    p.className = 'c-line ' + (who === 'me' ? 'c-me' : 'c-store');
    p.dir = 'auto';
    p.textContent = text;
    lines.appendChild(p);
    lines.scrollTop = lines.scrollHeight;
  }

  function poll() {
    clearTimeout(timer);
    fetch(base + '/lines?v=' + encodeURIComponent(visitor) + '&after=' + last, { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        (d && d.lines ? d.lines : []).forEach(function (l) {
          if (l.id <= last) return;
          last = l.id;
          if (l.who === 'me' && mine[l.text]) { mine[l.text]--; return; }
          add(l.who, l.text);
          if (l.who === 'store') { waitingSince = 0; typing.hidden = true; }
        });
      })
      .catch(function () {})
      .then(function () {
        if (waitingSince && Date.now() - waitingSince > 90000) { waitingSince = 0; typing.hidden = true; }
        timer = setTimeout(poll, panel.hidden ? 30000 : waitingSince ? 2000 : 6000);
      });
  }

  function show(open) {
    panel.hidden = !open;
    openBtn.hidden = open;
    openBtn.setAttribute('aria-expanded', String(open));
    parent.postMessage({ t: 'toran:open', open: open }, '*');
    if (open) { box.focus(); poll(); } else openBtn.focus();
  }

  openBtn.addEventListener('click', function () { show(true); });
  closeBtn.addEventListener('click', function () { show(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) show(false); });

  function grow() { box.style.height = 'auto'; box.style.height = Math.min(box.scrollHeight, 120) + 'px'; }
  box.addEventListener('input', grow);
  box.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit')); }
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = box.value.trim();
    if (!text) return;
    add('me', text);
    mine[text] = (mine[text] || 0) + 1;
    box.value = '';
    grow();
    error.hidden = true;
    waitingSince = Date.now();
    typing.hidden = false;
    fetch(base + '/say', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ v: visitor, text: text }) })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (d) {
        if (d && d.ok) return;
        error.textContent = (d && d.message) || 'ההודעה לא נשלחה. אפשר לנסות שוב.';
        error.hidden = false;
        typing.hidden = true;
        waitingSince = 0;
      })
      .catch(function () { error.textContent = 'אין חיבור כרגע. אפשר לנסות שוב בעוד רגע.'; error.hidden = false; typing.hidden = true; waitingSince = 0; })
      .then(poll);
  });
})();
