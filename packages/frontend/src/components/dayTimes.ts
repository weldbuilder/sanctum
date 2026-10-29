// When the house's scheduled wakes fall in the person's day. The scheduler fires a wake's cron in the house's time zone
// (identity.timezone); the Command center's timeline is drawn in the browser's, so a wake is read in the first and placed
// in the second (they differ when the person travels, or the house is set to another zone).
import { parseCron } from './settings/cron';

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function partsIn(tz: string, at: Date): Record<string, string> {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
  return Object.fromEntries(f.formatToParts(at).map(x => [x.type, x.value]));
}

/** The instant a wall-clock time names in `tz` (two passes settle a daylight-saving change). */
export function zonedInstant(y: number, month: number, d: number, hh: number, mm: number, tz: string): Date {
  const want = Date.UTC(y, month, d, hh, mm);
  let t = want;
  for (let i = 0; i < 2; i++) {
    const p = partsIn(tz, new Date(t));
    t += want - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  }
  return new Date(t);
}

/** Every time a once-a-day cron fires within the browser's local day holding `now`, the cron read in `tz` (the browser's
 *  own when null or unknown). Empty when it does not fire that day, or is not a once-a-day schedule. */
export function cronRunsToday(expr: string, now: Date, tz: string | null | undefined): Date[] {
  const f = parseCron(expr);
  if (!f) return [];
  const [hh, mm] = f.time.split(':').map(Number);
  const runsOn = (dow: number) => f.frequency === 'daily'
    || (f.frequency === 'weekdays' && dow >= 1 && dow <= 5)
    || (f.frequency === 'weekends' && (dow === 0 || dow === 6))
    || (f.frequency === 'custom' && f.customDays.includes(dow));
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const local = () => { const at = new Date(start); at.setHours(hh, mm, 0, 0); return runsOn(start.getDay()) ? [at] : []; };
  if (!tz) return local();
  try {
    // The house's dates around the local day: a run on any of them may land inside it.
    const out: Date[] = [];
    for (const shift of [-1, 0, 1]) {
      const p = partsIn(tz, new Date(start.getTime() + shift * 86_400_000 + 12 * 3_600_000));
      if (!runsOn(WEEKDAY.indexOf(p.weekday))) continue;
      const at = zonedInstant(+p.year, +p.month - 1, +p.day, hh, mm, tz);
      if (at >= start && at < end && !out.some(o => o.getTime() === at.getTime())) out.push(at);
    }
    return out;
  } catch {
    return local(); // an unknown zone name: read the cron as local, as before
  }
}
