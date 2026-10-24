// "לחבר את הוואטסאפ של החנות" (pages/whatsapp.ts): Meta's Embedded Signup for a number already on the WhatsApp
// Business app (coexistence). Meta's SDK opens the popup; the popup posts the number's ids to this window
// (WA_EMBEDDED_SIGNUP), and FB.login hands back a code. Both go to the server, which turns the code into the store's
// token (channels/waStore.ts). The code is single-use and worthless without our app secret.
(() => {
  const root = document.querySelector('[data-wa-connect]');
  if (!root) return;
  const { appId, configId, version, action, csrf } = root.dataset;
  const btn = root.querySelector('button');
  const msg = root.querySelector('[data-msg]');
  const say = (text, bad = false) => {
    msg.textContent = text;
    msg.classList.toggle('bad', bad);
  };
  let session = null;

  window.addEventListener('message', (e) => {
    let host = '';
    try {
      host = new URL(e.origin).hostname;
    } catch {
      return;
    }
    if (!/(^|\.)facebook\.com$/.test(host)) return;
    let d = e.data;
    if (typeof d === 'string') {
      try {
        d = JSON.parse(d);
      } catch {
        return;
      }
    }
    if (d && d.type === 'WA_EMBEDDED_SIGNUP') session = { event: String(d.event || ''), ...(d.data || {}) };
  });

  window.fbAsyncInit = () => {
    window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version });
    btn.disabled = false;
  };
  const sdk = document.createElement('script');
  sdk.src = 'https://connect.facebook.net/en_US/sdk.js';
  sdk.async = true;
  sdk.crossOrigin = 'anonymous';
  sdk.onerror = () => say('החלון של Meta לא נטען. אולי חוסם פרסומות חוסם אותו. אפשר לנסות מדפדפן אחר.', true);
  document.head.appendChild(sdk);

  const send = (code, tries = 0) => {
    // The popup's message can land just after the login callback.
    if (!session && tries < 20) return setTimeout(() => send(code, tries + 1), 250);
    if (!session || !session.phone_number_id) {
      btn.disabled = false;
      return say('Meta לא החזירה את פרטי המספר. אפשר לנסות שוב.', true);
    }
    say('מחבר...');
    const body = new URLSearchParams({ _csrf: csrf, code, phone_number_id: session.phone_number_id || '', waba_id: session.waba_id || '', event: session.event || '' });
    fetch(action, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-tn-ajax': '1' }, body })
      .then((r) => r.json())
      .then((j) => {
        say(j.message || (j.ok ? 'מחובר.' : 'החיבור לא הצליח.'), !j.ok);
        if (j.ok) setTimeout(() => location.reload(), 1500);
        else btn.disabled = false;
      })
      .catch(() => {
        btn.disabled = false;
        say('החיבור לא הגיע אלינו. אפשר לנסות שוב.', true);
      });
  };

  btn.addEventListener('click', () => {
    btn.disabled = true;
    session = null;
    say('החלון של Meta נפתח. אם הוא לא נפתח, צריך לאפשר חלונות קופצים לאתר הזה.');
    window.FB.login(
      (resp) => {
        if (resp && resp.authResponse && resp.authResponse.code) return send(resp.authResponse.code);
        btn.disabled = false;
        say(session && session.event === 'ERROR' ? 'Meta עצרה את החיבור. בדקו את הרשימה למעלה ונסו שוב.' : 'החלון נסגר בלי חיבור. אפשר לנסות שוב.', true);
      },
      { config_id: configId, response_type: 'code', override_default_response_type: true, extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' } },
    );
  });
})();
