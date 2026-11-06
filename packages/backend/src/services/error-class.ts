// A failure reduced to a short class that is safe to show and to log: never the message, a path or a stack.

/** The classes this app itself raises (AgentTurnError, PublicRunError, the dsh adapter), plus the two generic ones. Nothing
 *  else is ever passed through: a provider or a library puts whatever it likes in `kind` and `name` (a key prefix, a token,
 *  a path), and a pattern cannot tell a class from a secret. */
const KINDS = new Set([
  'provider_error', 'timeout', 'queue_full', 'queue_timeout', 'max_turns', 'harness_unsupported',
  'identity', 'identity_missing', 'record_failed', 'api_key_missing', 'transport', 'harness_hung', 'error',
]);
/** The only error names that are a class on their own (built-ins, which carry no data). */
const NAMES = new Set(['TypeError', 'RangeError', 'SyntaxError', 'AbortError']);

// ─── Failure classes (the brain router) ───────────────────────────────────────────────────────────────────────────
// What went wrong with a provider call, in one word the router can act on. The word is a fixed label: the text it was
// read from (a message, a stderr tail, an upstream body) is inspected and never returned.

export const FAIL_CLASSES = [
  'AUTH', 'CREDIT', 'RATE_LIMIT', 'TIMEOUT', 'NETWORK', 'SERVER', 'HARNESS_MISSING', 'HARNESS_HUNG', 'CANCELLED', 'OTHER',
] as const;
export type FailClass = typeof FAIL_CLASSES[number];

/** The classes that move a turn to the other brain. Never CANCELLED (the person pressed stop) and never OTHER (a bug or a
 *  bad request would fail the same way on the fallback, and nothing says the primary is at fault). */
export const FALLOVER_CLASSES: ReadonlySet<FailClass> = new Set<FailClass>([
  'AUTH', 'CREDIT', 'RATE_LIMIT', 'TIMEOUT', 'NETWORK', 'SERVER', 'HARNESS_MISSING', 'HARNESS_HUNG',
]);
export const isFalloverClass = (c: FailClass): boolean => FALLOVER_CLASSES.has(c);

/** The Claude Agent SDK's assistant-message `error` field. */
const SDK_ASSISTANT_ERROR: Record<string, FailClass> = {
  authentication_failed: 'AUTH', oauth_org_not_allowed: 'AUTH', billing_error: 'CREDIT', rate_limit: 'RATE_LIMIT', server_error: 'SERVER',
  invalid_request: 'OTHER', unknown: 'OTHER', max_output_tokens: 'OTHER',
};
/** The coarse classes services/providers/openai-compat.ts raises (ChatCompletionError.cls). */
const CHAT_CLS: Record<string, FailClass> = {
  auth: 'AUTH', billing: 'CREDIT', rate_limit: 'RATE_LIMIT', timeout: 'TIMEOUT', network: 'NETWORK', server: 'SERVER', bad_request: 'OTHER',
};
const KIND_CLASS: Record<string, FailClass> = { api_key_missing: 'AUTH', timeout: 'TIMEOUT', transport: 'NETWORK', harness_hung: 'HARNESS_HUNG' };

// Ordered: the first row that matches wins, so the narrow ones (a missing binary, a hung run) come before the broad ones
// (a timeout, a 5xx). Written against what the three harnesses actually print:
//   Claude  : Error "Claude Code executable not found at ...", "Claude Code process exited with code N", assistant.error codes,
//             "Invalid API key · Please run /login", "Credit balance is too low", "529 overloaded_error"
//   Codex   : "Unable to locate Codex CLI binaries", "codex exec exited with code N: <stderr>", "You've hit your usage limit",
//             "401 Unauthorized", "stream disconnected before completion"
//   dsh     : "dsh exited with code N: <stderr>", "dsh timed out after Nms", "spawn dsh ENOENT"
//   chat API: HTTP status, "insufficient_quota", "rate_limit_exceeded", "ECONNRESET", "fetch failed"
const RULES: Array<[FailClass, RegExp]> = [
  ['HARNESS_MISSING', /spawn\s+\S*\s*ENOENT|ENOENT[^\n]{0,80}\bspawn\b|command not found|not found in (your )?PATH|executable not found|unable to locate (the )?\S* ?(cli|codex|dsh|claude)\b|native binary not found|exited with code 127\b|is not recognized as an internal or external command/i],
  ['HARNESS_HUNG', /went silent|no output (for|in|after|within)|produced no output|stopped responding|watchdog|\b(dsh|codex|claude)\b[^\n]{0,40}timed out after \d+\s*ms|\bhung\b/i],
  ['CREDIT', /billing_error|credit balance|insufficient[ _-]?(credit|quota|fund|balance)|payment[ _-]?required|out of credits|add (more )?credits|purchase (more )?credits|exceeded your current quota|\b402\b/i],
  ['AUTH', /authentication_failed|oauth_org_not_allowed|invalid[ _-]?(x-)?api[ _-]?key|api key (is )?(missing|not set|invalid)|missing[ _-]?api[ _-]?key|unauthori[sz]ed|\bforbidden\b|not (logged|signed) in|please run \/login|run `?codex login|login required|authentication (failed|error|required)|invalid[ _-]?(token|credentials)|token (has )?expired|permission[ _-]?denied \(api|(?:http|status|code)\D{0,3}40[13]\b|\b40[13]\s+(unauthori[sz]ed|forbidden)/i],
  ['RATE_LIMIT', /rate[ _-]?limit|too many requests|usage limit|hit your (usage )?limit|throttl|quota (will )?reset|try again (in|later at)|(?:http|status|code)\D{0,3}429\b|\b429\b/i],
  ['TIMEOUT', /timed? ?out|timeout|ETIMEDOUT|deadline exceeded|\b(408|504)\b/i],
  ['NETWORK', /ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|socket hang up|fetch failed|network (error|is unreachable)|getaddrinfo|connection (was )?(reset|refused|closed|lost)|stream (disconnected|closed)|\bTLS\b|certificate|econnection|und_err/i],
  ['SERVER', /server_error|api_error|internal server error|overloaded|bad gateway|service unavailable|gateway time|upstream|(?:http|status|code)\D{0,3}5\d\d\b|\b(500|502|503|529)\b/i],
];

/** Everything about a failure worth reading, as one lowercase-insensitive string. Bounded: a stderr tail is long. */
function failureText(x: unknown): string {
  if (x == null) return '';
  if (typeof x === 'string') return x.slice(-2000);
  if (Array.isArray(x)) return x.map(failureText).join('\n').slice(-2000);
  if (typeof x !== 'object') return String(x);
  const o = x as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of ['message', 'stderr', 'result', 'code', 'syscall', 'status', 'statusCode']) {
    const v = o[k];
    if (typeof v === 'string' || typeof v === 'number') parts.push(String(v));
  }
  if (Array.isArray(o.errors)) parts.push(...o.errors.map((e) => failureText(e)));
  const cause = (o as { cause?: unknown }).cause;
  if (cause && cause !== x) parts.push(failureText(cause));
  return parts.join('\n').slice(-2000);
}

/** The class of a failure: a thrown error, a result message (`{ errors: [...] }` / `{ result }`), an assistant message with
 *  an SDK `error` code, a ChatCompletionError, or plain text (a stderr tail). Anything unrecognised is OTHER. */
export function classifyFailure(x: unknown): FailClass {
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    if (typeof o.error === 'string' && SDK_ASSISTANT_ERROR[o.error]) {
      const c = SDK_ASSISTANT_ERROR[o.error];
      if (c !== 'OTHER') return c;
    }
    if (typeof o.cls === 'string' && CHAT_CLS[o.cls]) {
      const c = CHAT_CLS[o.cls];
      if (c !== 'OTHER') return c;
    }
    if (typeof o.kind === 'string' && KIND_CLASS[o.kind]) return KIND_CLASS[o.kind];
    // The person pressed stop (or a park ended the turn): never a reason to switch brains.
    if (o.name === 'AbortError' || o.name === 'ParkedBeforeQuery') return 'CANCELLED';
    if (o.syscall && typeof o.syscall === 'string' && /^spawn/.test(o.syscall) && o.code === 'ENOENT') return 'HARNESS_MISSING';
  }
  const text = failureText(x);
  if (!text) return 'OTHER';
  for (const [cls, re] of RULES) if (re.test(text)) return cls;
  return 'OTHER';
}

export function errorClass(err: unknown): string {
  const kind = err && typeof err === 'object' ? (err as { kind?: unknown }).kind : undefined;
  if (typeof kind === 'string' && KINDS.has(kind)) return kind;
  const name = err instanceof Error ? err.name : '';
  // A provider failure reads as its class ('auth', 'rate_limit', ...), in lower case like the other classes here.
  const c = classifyFailure(err);
  if (c !== 'OTHER' && c !== 'CANCELLED' && !NAMES.has(name)) return c.toLowerCase();
  return NAMES.has(name) ? name : 'error';
}
