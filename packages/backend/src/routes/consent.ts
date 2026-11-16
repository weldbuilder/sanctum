// /api/consent: the Permissions tab's backend. Every route needs a session (authMiddleware); the PIN rules are in services/consent/gate.ts.
// Nothing here ever returns the PIN, its hash or the salt.
import { Router, type Request, type Response } from 'express';
import { authMiddleware, passwordConfigured, requestSessionId, verifyPassword } from '../middleware/auth.js';
import { loginRateLimiter } from '../middleware/security.js';
import { registry } from '../services/ws.js';
import {
  CAPABILITIES, WINDOW_CHOICES, grant, isCapability, listState, mode, normalizeWindow, onConsentChanged, pinNeededForGrant, pinNeededForRevoke,
  revoke, setMode, turnOff, askWouldChange, type Capability, type Entry,
} from '../services/consent/gate.js';
import { clearPin, consumeToken, issueToken, lockedUntil, pinFormatOk, pinIsSet, setPin, tokenValid, verifyPin } from '../services/consent/pin.js';
import { RECEIPT_OUTCOMES, listReceipts } from '../services/consent/receipts.js';
import { getApproval } from '../services/db.js';

// Open tabs hear about every change (same pattern as approval_request).
onConsentChanged((c) => {
  try { registry.broadcast({ type: 'consent_changed', mode: c.mode, ...(c.capability ? { capability: c.capability } : {}), change: c.change }); } catch { /* no socket yet */ }
});

const router = Router();
router.use(authMiddleware);

const pinRequired = (res: Response) => res.status(403).json({ error: 'pin_required', message: 'This change needs the PIN (Settings → Permissions).' });

router.get('/', (_req, res) => {
  const s = listState();
  const lock = lockedUntil();
  res.json({
    mode: s.mode,
    capabilities: s.capabilities,
    windows: WINDOW_CHOICES,
    pin_set: pinIsSet(),
    locked_until: lock ? new Date(lock).toISOString() : null,
  });
});

router.get('/receipts', (req, res) => {
  const q = req.query;
  const capability = typeof q.capability === 'string' && q.capability ? q.capability : undefined;
  const outcome = typeof q.outcome === 'string' && q.outcome ? q.outcome : undefined;
  if (capability && capability !== '*' && !isCapability(capability)) { res.status(400).json({ error: `capability must be one of ${CAPABILITIES.join(', ')}` }); return; }
  if (outcome && !(RECEIPT_OUTCOMES as readonly string[]).includes(outcome)) { res.status(400).json({ error: `outcome must be one of ${RECEIPT_OUTCOMES.join(', ')}` }); return; }
  const before = typeof q.before === 'string' && q.before !== '' ? Number(q.before) : undefined;
  if (before !== undefined && !Number.isFinite(before)) { res.status(400).json({ error: 'before must be a receipt id' }); return; }
  const limit = typeof q.limit === 'string' && q.limit !== '' ? Number(q.limit) : undefined;
  res.json(listReceipts({ capability, outcome, before, limit }));
});

// ── PIN ─────────────────────────────────────────────────────────────────────
// Set (or reset, or clear): the session AND the app password typed again. Resetting is the way back from a forgotten PIN and from a lockout.
router.post('/pin', loginRateLimiter, (req, res) => {
  const { password, pin, clear } = req.body ?? {};
  if (!passwordConfigured()) { res.status(400).json({ error: 'no_password', message: 'Set an app password first; the PIN is set with it.' }); return; }
  if (!verifyPassword(password)) { res.status(403).json({ error: 'wrong_password', message: 'That is not the app password.' }); return; }
  if (clear === true) {
    if (mode() === 'guard') { res.status(409).json({ error: 'guard_on', message: 'Turn Guard mode off before removing the PIN.' }); return; }
    clearPin();
    res.json({ pin_set: false });
    return;
  }
  if (!pinFormatOk(pin)) { res.status(400).json({ error: 'bad_pin', message: 'The PIN is 4 to 8 digits.' }); return; }
  setPin(pin);
  res.json({ pin_set: true });
});

router.post('/pin/verify', (req, res) => {
  const r = verifyPin(req.body?.pin);
  if (r.ok) { res.json(issueToken(requestSessionId(req))); return; }
  if (r.reason === 'not_set') { res.status(409).json({ error: 'pin_not_set', message: 'No PIN is set yet.' }); return; }
  if (r.reason === 'locked') {
    res.status(423).json({ error: 'locked', locked_until: new Date(r.locked_until!).toISOString(), message: 'Too many wrong PINs. Try again later, or reset it with the app password.' });
    return;
  }
  res.status(403).json({ error: 'wrong_pin', attempts_left: r.attempts_left });
});

// ── mode and switches ───────────────────────────────────────────────────────
router.post('/mode', (req, res) => {
  const next = req.body?.mode;
  if (next !== 'open' && next !== 'guard') { res.status(400).json({ error: 'mode must be open or guard' }); return; }
  if (next === mode()) { res.json({ mode: next }); return; }
  if (next === 'guard' && !pinIsSet()) { res.status(409).json({ error: 'pin_not_set', message: 'Set a PIN before switching Guard mode on.' }); return; }
  if (!consumeToken(req.body?.pin_token, requestSessionId(req))) { pinRequired(res); return; }
  setMode(next, { harness: 'app', route: 'POST /api/consent/mode' });
  res.json({ mode: next });
});

/** The grant, with the PIN rule applied. Shared by POST /grant and an approved ask card. */
export function applyGrant(cap: Capability, windowMinutes: number | null, note: string | undefined, pinToken: unknown, route: string, sessionId: string):
  { ok: true; entry: Entry } | { ok: false; status: number; body: Record<string, unknown> } {
  if (pinNeededForGrant(cap, Date.now(), windowMinutes) === 'pin' && !consumeToken(pinToken, sessionId)) {
    return { ok: false, status: 403, body: { error: 'pin_required', message: 'This change needs the PIN (Settings → Permissions).' } };
  }
  return { ok: true, entry: grant(cap, windowMinutes, note, { harness: 'app', route }) };
}

router.post('/grant', (req: Request, res: Response) => {
  const { capability, window_minutes, note, pin_token } = req.body ?? {};
  if (!isCapability(capability)) { res.status(400).json({ error: `capability must be one of ${CAPABILITIES.join(', ')}` }); return; }
  const w = normalizeWindow(window_minutes === undefined ? null : window_minutes);
  if (w === undefined) { res.status(400).json({ error: 'window_minutes must be a whole number of minutes, or null to leave it on' }); return; }
  const r = applyGrant(capability, w, typeof note === 'string' ? note : undefined, pin_token, 'POST /api/consent/grant', requestSessionId(req));
  if (!r.ok) { res.status(r.status).json(r.body); return; }
  res.json({ grant: r.entry });
});

router.post('/off', (req, res) => {
  const { capability, note } = req.body ?? {};
  if (!isCapability(capability)) { res.status(400).json({ error: `capability must be one of ${CAPABILITIES.join(', ')}` }); return; }
  res.json({ grant: turnOff(capability, typeof note === 'string' ? note : undefined, { harness: 'app', route: 'POST /api/consent/off' }) });
});

router.post('/revoke', (req, res) => {
  const id = req.body?.grant_id;
  if (typeof id !== 'string' || !id) { res.status(400).json({ error: 'grant_id is required' }); return; }
  if (pinNeededForRevoke(id) === 'pin' && !consumeToken(req.body?.pin_token, requestSessionId(req))) { pinRequired(res); return; }
  const hit = revoke(id, { harness: 'app', route: 'POST /api/consent/revoke' });
  if (!hit) { res.status(404).json({ error: 'No such grant' }); return; }
  res.json({ revoked: hit });
});

export default router;

// ── the ask card ────────────────────────────────────────────────────────────
// `res ask --capability web --window 30` stores the capability and window on the approval; approving it (the existing decide route) comes
// here. The person may pick another window on the card (`window_minutes` in the decide body; null = leave on). Nothing else creates a grant.
export type AskPlan = { ok: true; apply: () => Entry | null } | { ok: false; status: number; body: Record<string, unknown> };

export function planAskGrant(approvalId: string, body: unknown, sessionId: string): AskPlan {
  const a = getApproval(approvalId);
  const cap = a?.capability;
  if (!a || !isCapability(cap)) return { ok: true, apply: () => null };
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const w = normalizeWindow(Object.prototype.hasOwnProperty.call(b, 'window_minutes') ? b.window_minutes : a.window_minutes ?? null);
  if (w === undefined) return { ok: false, status: 400, body: { error: 'window_minutes must be a whole number of minutes, or null to leave it on' } };
  if (!askWouldChange(cap)) return { ok: true, apply: () => null }; // already on with no end: a window would only put an end on it
  const needsPin = pinNeededForGrant(cap, Date.now(), w) === 'pin';
  if (needsPin && !tokenValid(b.pin_token, sessionId)) {
    return { ok: false, status: 403, body: { error: 'pin_required', message: 'Approving this needs the PIN (Settings → Permissions).' } };
  }
  // The token is spent when the grant is made (the card may still turn out to be already decided).
  return { ok: true, apply: () => needsPin && !consumeToken(b.pin_token, sessionId) ? null : grant(cap, w, `asked for: ${a.what}`.slice(0, 200), { harness: 'app', route: 'ask card' }) };
}
