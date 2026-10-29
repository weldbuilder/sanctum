/** What the Browser tab should show, decided from GET /api/preferences. Pure, so it is testable. */
export type BrowserViewState =
  | { kind: 'error' }
  | { kind: 'empty' }
  | { kind: 'invalid' }
  | { kind: 'restart' }
  | { kind: 'frame'; url: string };

export function browserViewState(prefs: unknown | null): BrowserViewState {
  if (!prefs || typeof prefs !== 'object') return { kind: 'error' };
  const i = (prefs as { integrations?: Record<string, unknown>; error?: unknown }).integrations;
  if (!i || typeof i !== 'object') return { kind: 'error' };
  const saved = typeof i.browser_url === 'string' ? i.browser_url.trim() : '';
  if (!saved) return { kind: 'empty' };
  if (i.browser_url_valid !== true) return { kind: 'invalid' };
  let origin = '';
  try { origin = new URL(saved).origin; } catch { return { kind: 'invalid' }; }
  // The server's CSP is fixed at startup; a different saved origin would render a blocked frame.
  if (i.browser_active_origin !== origin) return { kind: 'restart' };
  return { kind: 'frame', url: saved };
}
