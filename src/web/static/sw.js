// Toran's service worker, as Teder's: a push wakes it with no words in it, and it asks Toran, behind the owner's session,
// what to show (src/owners/push.ts). Nothing about a customer's message travels through the push service.
self.addEventListener('push', (e) => {
  e.waitUntil(
    fetch('/notifications/latest.json', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((n) => self.registration.showNotification(n?.title || 'תורן', { body: n?.body || 'שאלה של לקוח מחכה לכם', data: { url: n?.url || '/chats?state=waiting' }, lang: 'he', dir: 'rtl', icon: '/static/brand/toran-180.png', tag: n ? `n-${n.id}` : 'toran' })),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((list) => {
      const open = list.find((c) => new URL(c.url).origin === self.location.origin);
      return open ? open.navigate(url).then((c) => c?.focus()) : self.clients.openWindow(url);
    }),
  );
});
