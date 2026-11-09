import type { App } from '../../app.ts';
import { forgetStorePrompt } from '../../agent/loop.ts';
import { choiceOf, NOTE_MAX, PRESET_KEYS, PRESETS, profileOf, SAMPLE_Q, saveChoice } from '../../agent/voice.ts';
import { ActionError, type DashReq, type Route } from '../server.ts';
import { csrfField, esc, icon } from '../ui.ts';

// "איך תורן מדבר" in Settings (agent/voice.ts): one choice, the way Toran talks, each option with the same question
// answered in its voice so the owner hears the difference before choosing; "כמו באתר שלכם" shows what was learned from
// the site. Emoji, the owner's own line and the learned description wait behind "עוד אפשרויות". The workspace's owner
// changes it (a team member sees it); the operator outside view-as too.

type Store = { id: number; name: string; config?: any };

const bubble = (q: string, a: string) => `<div class="chat voice-chat"><div class="b customer">${esc(q)}</div><div class="b agent">${esc(a)}</div></div>`;

export function voicePanel(r: DashReq, s: Store): string {
  const choice = choiceOf(s.config);
  const prof = profileOf(s.config);
  const may = !r.ctx.readOnly && r.user.role !== 'client_member';
  const off = may ? '' : ' disabled';
  const option = (key: (typeof PRESET_KEYS)[number]) => {
    const p = PRESETS[key];
    const sample = key === 'site'
      ? prof?.samples[0] ? bubble(prof.samples[0].q, prof.samples[0].a) : '<p class="small muted m0">תורן עוד לא קרא מספיק טקסט באתר כדי ללמוד ממנו. עד אז הוא כותב בעברית פשוטה וחמה.</p>'
      : bubble(SAMPLE_Q, p.sample || '');
    return `<label class="voice-opt"><input type="radio" name="preset" value="${key}"${choice.preset === key ? ' checked' : ''}${off}><span class="vo-head"><b>${esc(p.he)}</b>${key === 'site' ? ' <span class="chip ok">מומלץ</span>' : ''}</span><span class="small muted">${esc(p.line)}</span>${sample}</label>`;
  };
  const learned = prof
    ? `<h3 class="small mt16">מה תורן למד מהאתר</h3><p class="small m0">${esc(choice.summary || prof.summary)}</p>${prof.phrases.length ? `<p class="small muted mt8 m0">מילים שלכם שהוא משתמש בהן: ${prof.phrases.map((x) => `<bdi>"${esc(x)}"</bdi>`).join(', ')}</p>` : ''}
  <label class="f mt12">אם התיאור לא מדויק, אפשר לתקן אותו<textarea name="summary" rows="3" maxlength="600" dir="auto"${off}>${esc(choice.summary || '')}</textarea></label>`
    : '';
  const emojiSel = (v: string, label: string) => `<option value="${v}"${choice.emoji === v ? ' selected' : ''}>${label}</option>`;
  const form = `<form method="post" action="/lead/${s.id}/voice">${csrfField(r.ctx)}
  <div class="voice-opts">${PRESET_KEYS.map(option).join('')}</div>
  <details class="mt12"><summary class="small">עוד אפשרויות</summary>
    <label class="f mt12">אימוג׳י<select name="emoji"${off}>${emojiSel('site', 'לפי הסגנון')}${emojiSel('on', 'כן, פה ושם')}${emojiSel('off', 'בלי')}</select></label>
    <label class="f mt12">משהו שתורן צריך לדעת על איך אתם מדברים<small>למשל: "פונים ללקוחות בשם הפרטי", או "כותבים 'קישור' ולא 'לינק'".</small><textarea name="note" rows="2" maxlength="${NOTE_MAX}" dir="auto"${off}>${esc(choice.note)}</textarea></label>
    ${learned}
  </details>
  ${may ? `<div class="row mt12"><button class="btn primary sm" type="submit">${icon('check')}לשמור</button></div>` : ''}
</form>`;
  return `<section class="panel" id="voice"><header><h2>איך תורן מדבר</h2></header>
  <p class="small muted m0">תורן למד מהאתר של ${esc(s.name)} איך אתם כותבים, ועונה ככה ללקוחות. אפשר לבחור סגנון אחר, וכאן רואים איך כל אחד נשמע.</p>
  ${form}
</section>`;
}

export function voiceRoutes(app: App): Route<DashReq>[] {
  return [
    // The store is the session's (server.ts checks /lead/<id>); the workspace's owner only, never view-as.
    ['POST', /^\/lead\/(\d+)\/voice$/, async (r, m) => {
      if (r.user.role === 'client_member') throw new ActionError('רק מי שפתח את החשבון יכול לשנות איך תורן מדבר.', 403);
      const id = Number(m[1]);
      const c = await saveChoice(app.db, id, r.form, r.user.name);
      forgetStorePrompt(id);
      return { redirect: '/settings#voice', message: `נשמר. מההודעה הבאה תורן מדבר ${c.preset === 'site' ? 'כמו באתר שלכם' : `בסגנון "${PRESETS[c.preset].he}"`}.` };
    }],
  ];
}
