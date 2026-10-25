// One clock for the whole engine, so tests can move time (binding expiry, follow-ups,
// daily re-scrapes) without waiting for it.

let fixed: number | null = null;

export const now = (): number => fixed ?? Date.now();
export const nowIso = (): string => new Date(now()).toISOString();
export const setNow = (t: number | string | Date | null) => {
  fixed = t == null ? null : new Date(t).getTime();
};
export const DAY = 86_400_000;
export const HOUR = 3_600_000;

const TZ = 'Asia/Jerusalem';

/** The calendar date in Israel, YYYY-MM-DD. */
export function israelDate(t: number | string | Date = now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}

/** Weekday in Israel, 0 = Sunday ... 6 = Saturday, and the hour (0-23). */
export function israelWeekdayHour(t: number | string | Date = now()): { weekday: number; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(t))
      .map((p) => [p.type, p.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(String(parts.weekday));
  return { weekday, hour: Number(parts.hour) };
}

/**
 * A follow-up never lands on Shabbat: from Friday 13:00 to Saturday night the due time
 * moves to Sunday 09:00 Israel time. A business message on a Friday afternoon or a
 * Saturday reads as careless to an Israeli shop owner, whatever their observance.
 */
export function notOnShabbat(t: number): number {
  let x = t;
  for (let i = 0; i < 3; i++) {
    const { weekday, hour } = israelWeekdayHour(x);
    if ((weekday === 5 && hour >= 13) || weekday === 6) x += (24 - hour) * 3_600_000;
    else break;
  }
  const { hour } = israelWeekdayHour(x);
  return hour < 9 ? x + (9 - hour) * 3_600_000 : x;
}

// ---- When a store's customers are not written to (auto/send.ts): the night, Shabbat and the holidays.
//
// A message Toran starts for a store (an abandoned cart, a payment, a shipment, a review) waits while it is quiet in
// Israel: from 21:00 to 09:00, and from 13:00 on the eve of Shabbat or of a holiday until the night after it. Candle
// lighting is never before 13:00, in any city at any time of year, and nightfall after Shabbat is never after 21:00,
// so the fixed hours hold the whole of Shabbat without working out sunset (notOnShabbat above keeps the same 13:00).
// The holidays are Israel's days of rest, one day each as in Israel: Rosh Hashana (two days), Yom Kippur, the first
// day of Sukkot, Shemini Atzeret, the first and seventh days of Pesach, and Shavuot, read from the Hebrew calendar
// that Intl already has.

const YOM_TOV = new Set(['1 Tishri', '2 Tishri', '10 Tishri', '15 Tishri', '22 Tishri', '15 Nisan', '21 Nisan', '6 Sivan']);
const HEBREW = new Intl.DateTimeFormat('en-u-ca-hebrew', { timeZone: TZ, day: 'numeric', month: 'long' });

/** Is this day, in Israel, a holiday on which work stops? */
export function israelHoliday(t: number | string | Date = now()): boolean {
  const p = HEBREW.formatToParts(new Date(t));
  return YOM_TOV.has(`${p.find((x) => x.type === 'day')?.value} ${p.find((x) => x.type === 'month')?.value}`);
}

/** Is it a time a store's customer is not written to: the night, Shabbat, a holiday, or the afternoon before one? */
export function customerQuiet(t: number = now()): boolean {
  const { weekday, hour } = israelWeekdayHour(t);
  if (hour < 9 || hour >= 21) return true;
  if (weekday === 6 || israelHoliday(t)) return true;
  return hour >= 13 && (weekday === 5 || israelHoliday(t + DAY));
}

/** The first whole hour from t that is not quiet (t itself when it is not). */
export function afterQuiet(t: number = now()): number {
  let x = t;
  // Rosh Hashana beside Shabbat is the longest stretch, three days and their nights; a week is far past it.
  for (let i = 0; i < 24 * 7 && customerQuiet(x); i++) x = Math.floor(x / HOUR) * HOUR + HOUR;
  return x;
}
