// Words for the Mind watchdog's record, kept apart from the components so they can be tested.
import type { MindStatus, MindState } from '@sanctum/shared';

const STATES: MindState[] = ['ok', 'offline', 'unauthorized', 'forbidden', 'incomplete', 'off'];

export function isMindStatus(v: unknown): v is MindStatus {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.state === 'string' && (STATES as string[]).includes(r.state) && typeof r.checkedAt === 'string';
}

/** The chat header's line: only while the Mind is switched on and not answering. */
export function mindHeaderNotice(status: MindStatus | null): string | null {
  if (!status) return null;
  if (status.state === 'offline') return 'Mind offline';
  if (status.state === 'unauthorized') return 'Mind offline: key refused';
  if (status.state === 'forbidden') return 'Mind offline: this mind id is not allowed for this key';
  return null;
}

const sentence = (t: string): string => {
  const x = t.trim().replace(/^url\b/, 'URL');
  return x ? `${x[0]!.toUpperCase()}${x.slice(1)}${/[.!?]$/.test(x) ? '' : '.'}` : '';
};

/** The Test connection result in plain words. */
export function mindTestSummary(status: MindStatus): { tone: 'ok' | 'bad' | 'neutral'; text: string } {
  switch (status.state) {
    case 'ok': {
      const ms = status.latencyMs != null ? `${Math.round(status.latencyMs)} ms` : null;
      if (status.version && ms) return { tone: 'ok', text: `Connected. sanctum-mind ${status.version} answered in ${ms}.` };
      if (ms) return { tone: 'ok', text: `Connected. It answered in ${ms}.` };
      return { tone: 'ok', text: 'Connected.' };
    }
    case 'offline': return { tone: 'bad', text: `Offline: ${(status.error ?? 'no answer from the Mind').replace(/\.$/, '')}.` };
    case 'unauthorized': return { tone: 'bad', text: `Key refused: ${(status.error ?? 'the Mind refused the key').replace(/\.$/, '')}.` };
    case 'forbidden': return { tone: 'bad', text: `Not allowed: ${(status.error ?? 'this mind id is not allowed for this key').replace(/\.$/, '')}.` };
    case 'incomplete': return { tone: 'bad', text: sentence(status.error ?? 'something is missing') };
    default: return { tone: 'neutral', text: 'The Mind is switched off.' };
  }
}

/** "Last check: connected (2.0.0), 2:31 PM" for Settings. */
export function mindLastCheckLine(status: MindStatus | null, formatTime: (iso: string) => string = defaultTime): string | null {
  if (!status) return null;
  const what = status.state === 'ok' ? `connected${status.version ? ` (${status.version})` : ''}`
    : status.state === 'offline' ? 'offline'
    : status.state === 'unauthorized' ? 'key refused'
    : status.state === 'forbidden' ? 'mind id not allowed'
    : status.state === 'incomplete' ? 'not set up'
    : 'off';
  return `Last check: ${what}, ${formatTime(status.checkedAt)}`;
}

function defaultTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The URL Test connection posts: what is typed in the card, else the one in effect from sanctum.yaml or .mcp.json. */
export function effectiveMindUrl(cardUrl: string, effective: string | null | undefined): string {
  return cardUrl.trim() || (effective ?? '').trim();
}

const SOURCE_WORDS: Record<string, Record<string, string>> = {
  URL: { settings: 'Settings', yaml: 'sanctum.yaml', mcp_json: '.mcp.json' },
  key: { settings: 'Settings', environment: 'MIND_API_KEY in .env', mcp_json: '.mcp.json' },
};

/** "URL: from .mcp.json" / "Key: from MIND_API_KEY in .env"; null when there is no source to name. */
export function mindSourceLine(what: 'URL' | 'key', source: string | null | undefined): string | null {
  const word = source ? SOURCE_WORDS[what]?.[source] : undefined;
  return word ? `${what === 'key' ? 'Key' : 'URL'}: from ${word}` : null;
}
