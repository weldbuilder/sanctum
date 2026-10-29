/** Cron helpers shared by Settings' schedule editor and the Command center's automations: a simple cron to and from
 *  the friendly picker's state, and a readable line for any cron. */

/** Days abbreviations indexed by JS getDay() order (0=Sun) */
export const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export type FrequencyKey = 'daily' | 'weekdays' | 'weekends' | 'custom';

export interface FriendlySchedule {
  time: string;          // "HH:MM"
  frequency: FrequencyKey;
  customDays: number[];  // 0-6 (Sun-Sat), only used when frequency === 'custom'
}

/** Build a cron expression from friendly picker state */
export function buildCron(s: FriendlySchedule): string {
  const [hh, mm] = s.time.split(':');
  const h = parseInt(hh, 10);
  const m = parseInt(mm, 10);

  let dow: string;
  switch (s.frequency) {
    case 'daily':    dow = '*';     break;
    case 'weekdays': dow = '1-5';   break;
    case 'weekends': dow = '0,6';   break;
    case 'custom':
      dow = s.customDays.length > 0
        ? [...s.customDays].sort((a, b) => a - b).join(',')
        : '*';
      break;
  }
  return `${m} ${h} * * ${dow}`;
}

/**
 * Parse a simple cron back into friendly picker state.
 * Returns null if the cron is too complex to represent.
 */
export function parseCron(expr: string): FriendlySchedule | null {
  if (!expr) return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const [min, hr, dom, mon, dow] = parts;

  // Must be "minute hour * * dow"
  if (dom !== '*' || mon !== '*') return null;

  const h = parseInt(hr, 10);
  const m = parseInt(min, 10);
  if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;

  const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

  if (dow === '*') return { time, frequency: 'daily', customDays: [] };
  if (dow === '1-5') return { time, frequency: 'weekdays', customDays: [] };
  if (dow === '0,6' || dow === '6,0') return { time, frequency: 'weekends', customDays: [] };

  // Try to parse as comma-separated day numbers
  const nums = dow.split(',').map(d => parseInt(d, 10));
  if (nums.every(n => !isNaN(n) && n >= 0 && n <= 6)) {
    return { time, frequency: 'custom', customDays: nums };
  }

  return null; // too complex
}

export function cronSummary(expr: string): string {
  if (!expr) return '';
  const friendly = parseCron(expr);
  if (friendly) {
    const [h, m] = friendly.time.split(':').map(Number);
    const suffix = h >= 12 ? 'pm' : 'am';
    const display = h % 12 === 0 ? 12 : h % 12;
    const timeStr = `${display}:${String(m).padStart(2, '0')}${suffix}`;

    switch (friendly.frequency) {
      case 'daily':    return `every day at ${timeStr}`;
      case 'weekdays': return `weekdays at ${timeStr}`;
      case 'weekends': return `weekends at ${timeStr}`;
      case 'custom': {
        const days = friendly.customDays.sort((a, b) => a - b).map(d => DAY_ABBR[d]).join(', ');
        return `${days} at ${timeStr}`;
      }
    }
  }
  // Fallback: minimal human-readable pass-through
  const parts = expr.trim().split(/\s+/);
  if (parts.length >= 5) {
    const [min, hr, , , dow] = parts;
    if (dow === '*') {
      const h = parseInt(hr, 10);
      if (!isNaN(h)) {
        const suffix = h >= 12 ? 'pm' : 'am';
        const display = h % 12 === 0 ? 12 : h % 12;
        return `${display}:${min.padStart(2, '0')}${suffix} daily`;
      }
    }
  }
  return expr;
}
