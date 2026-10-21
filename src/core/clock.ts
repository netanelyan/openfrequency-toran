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
