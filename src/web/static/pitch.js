// The pitch page's one script: the docked button on a phone, and four things for the dashboard: how far down the page
// was read (25/50/75/100), whether the demo button was tapped, and whether "take this page down" was. Sent with
// sendBeacon, no cookies of ours beyond an anonymous visitor id, nothing about the reader. The page works without it.
(() => {
  const page = document.querySelector('[data-slug]');
  if (!page) return;
  const slug = page.dataset.slug;
  // A product photo that does not load is removed rather than shown broken; in the strip, with its tile.
  document.querySelectorAll('img[data-hide-on-error]').forEach((img) => {
    const hide = () => (img.closest('.shelf li') || img).remove();
    if (img.complete && !img.naturalWidth) hide();
    else img.addEventListener('error', hide);
  });
  const send = (kind, data = {}) => {
    const body = JSON.stringify({ slug, kind, ...data });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon('/t', new Blob([body], { type: 'application/json' }))) return;
    } catch {}
    fetch('/t', { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true, credentials: 'same-origin' }).catch(() => {});
  };

  const seen = new Set();
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const d = Number(e.target.dataset.depth);
          if (seen.has(d)) continue;
          seen.add(d);
          send('scroll', { depth: d });
        }
      },
      { threshold: 0.35 },
    );
    document.querySelectorAll('[data-depth]').forEach((el) => io.observe(el));
    const first = document.querySelector('.hero .wa');
    const dock = document.querySelector('.dock');
    if (first && dock) new IntersectionObserver(([e]) => dock.classList.toggle('show', !e.isIntersecting && e.boundingClientRect.top < 0), { threshold: 0 }).observe(first);
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-demo]')) send('demo_click');
    else if (e.target.closest('[data-takedown]')) send('takedown_click');
  });
})();
