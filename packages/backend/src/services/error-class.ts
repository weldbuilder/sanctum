// A failure reduced to a short class that is safe to show and to log: never the message, a path or a stack.

/** The classes this app itself raises (AgentTurnError, PublicRunError, the dsh adapter), plus the two generic ones. Nothing
 *  else is ever passed through: a provider or a library puts whatever it likes in `kind` and `name` (a key prefix, a token,
 *  a path), and a pattern cannot tell a class from a secret. */
const KINDS = new Set([
  'provider_error', 'timeout', 'queue_full', 'queue_timeout', 'max_turns', 'harness_unsupported',
  'identity', 'identity_missing', 'record_failed', 'api_key_missing', 'transport', 'error',
]);
/** The only error names that are a class on their own (built-ins, which carry no data). */
const NAMES = new Set(['TypeError', 'RangeError', 'SyntaxError', 'AbortError']);

export function errorClass(err: unknown): string {
  const kind = err && typeof err === 'object' ? (err as { kind?: unknown }).kind : undefined;
  if (typeof kind === 'string' && KINDS.has(kind)) return kind;
  const name = err instanceof Error ? err.name : '';
  return NAMES.has(name) ? name : 'error';
}
