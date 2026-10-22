import { COLORS, TOKENS, ofMark, tederMark, toranMark } from '../../brand.ts';
import { layout, type PageCtx } from '../ui.ts';

// /brand, owner-only: the three marks at the sizes they are used, the colours, and the
// rules, to check the family at a glance in light and dark.

const SIZES = [16, 24, 32, 48, 64, 128];

function row(fn: (s: number, o?: any) => string, sizes = SIZES) {
  return `<div class="markrow">${sizes.map((s) => `<figure>${fn(s, { label: null })}<figcaption class="num">${s}px</figcaption></figure>`).join('')}</div>`;
}

export function brandPage(ctx: PageCtx): string {
  const swatch = (cls: string, name: string, hex: string, use: string) => `<div class="swatch"><i class="${cls}"></i><b>${name}</b><span class="ltr num">${hex}</span><span class="muted">${use}</span></div>`;
  return layout(
    { ...ctx, title: 'המותג', active: 'brand' },
    `<div class="head"><h1>המותג</h1><p class="sub">שלושת הסימנים של המשפחה, בגדלים שבהם הם מופיעים. הקבצים ב־<span class="ltr">assets/brand/</span>, כמו שהם.</p></div>
<div class="marks">
  <section class="panel"><header><h2>תורן</h2><span class="chip">${COLORS.toran}</span></header>
    ${row(toranMark)}
    <p class="small muted m0">אייקון האפליקציה, הפביקון, הכותרת של הדשבורד, דפי הדמו ומסך הכניסה.</p>
  </section>
  <section class="panel"><header><h2><span class="ltr">OpenFrequency</span></h2><span class="chip">${COLORS.openfrequency}</span></header>
    ${row(ofMark)}
    <p class="small muted m0">רק בתחתית הדף ובשורת "נבנה על ידי". ב־48 פיקסלים ומטה, גרסת ה־small: הנקודות הקטנות של הגרסה המלאה נעלמות.</p>
  </section>
  <section class="panel"><header><h2>תדר</h2><span class="chip">${COLORS.teder}</span></header>
    ${row(tederMark)}
    <p class="small muted m0">לא מופיע בתורן. כאן רק כדי לראות את המשפחה ביחד.</p>
  </section>
</div>
<section class="panel mt24"><header><h2>על רקע בהיר ועל רקע כהה</h2></header>
  <div class="cols even">
    <div class="onwall light">${toranMark(48)}${ofMark(48)}${tederMark(48)}${toranMark(24)}${ofMark(24)}${tederMark(24)}</div>
    <div class="onwall dark">${toranMark(48)}${ofMark(48)}${tederMark(48)}${toranMark(24)}${ofMark(24)}${tederMark(24)}</div>
  </div>
</section>
<section class="panel mt24"><header><h2>צבעים</h2></header>
  <div class="swatches">
    ${swatch('c-toran', 'ירוק תורן', COLORS.toran, 'הסימן, וכפתור הוואטסאפ בדפי הדמו')}
    ${swatch('c-accent', 'כחול', COLORS.accent, 'כפתורים וקישורים')}
    ${swatch('c-of', 'OpenFrequency', COLORS.openfrequency, 'הסימן בתחתית בלבד')}
    ${swatch('c-teder', 'תדר', COLORS.teder, 'לא בשימוש כאן')}
    ${swatch('c-ink', 'דיו', 'var(--ink)', 'טקסט')}
    ${swatch('c-bg', 'רקע', 'var(--bg)', 'הטפט הכסוף')}
  </div>
</section>
<section class="panel mt24"><header><h2>מידות וגופנים</h2></header>
  <dl class="kv">
    <dt>אריח</dt><dd class="ltr">${TOKENS.radius}</dd>
    <dt>שדה, חלונית פנימית</dt><dd class="ltr">${TOKENS.radiusM}</dd>
    <dt>פינת הסימן</dt><dd class="ltr">rx 24 / 100</dd>
    <dt>כפתור</dt><dd class="ltr">pill</dd>
    <dt>גופן</dt><dd>גופן המערכת: <span class="ltr">SF</span> במכשירי אפל, <span class="ltr">Segoe UI</span> ו־<span class="ltr">Noto Sans Hebrew</span> בשאר</dd>
  </dl>
  <p class="small muted mt16 m0">הכללים: לא מותחים, לא צובעים מחדש ולא מציירים מחדש סימן. הכחול לכפתורים ולקישורים. הירוק רק לסימן של תורן ולכפתור הדמו. בדף דמו, הבועות של שיחת הדוגמה והאות הראשונה של החנות בצבע של החנות עצמה.</p>
</section>`,
  );
}
