// Google connect REST — the OAuth handshake + status + per-app toggles.
//
// AUTH MODEL (Ward hardening 2026-06-24): these surfaces are driven by the
// Settings UI in a LOGGED-IN BROWSER, so they require a real session
// (authMiddleware) — NOT a source-IP "localhost" check (which is defeated behind
// cloudflared, where public requests arrive FROM loopback).
//
// THE ONE EXCEPTION: GET /auth/callback is the OAuth loopback REDIRECT target.
// Google redirects the user's browser to http://localhost:{port}/api/google/
// auth/callback (the redirect URI registered with the client) — at that point
// there is NO session cookie yet, and the request genuinely originates on the
// same machine's loopback. So the callback keeps a true loopback guard
// (loopbackOnly) and is NEVER reachable through the tunnel.

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import {
  startAuth,
  startHealthAuth,
  handleCallback,
  getStatus,
  disconnect,
  removeAccount,
  setBinding,
  accountForApp,
  isConfigured,
  setConfig,
  clearConfig,
  ALL_APPS,
  type GoogleApp,
} from '../services/google-auth.js';

/** Type-guard: is `x` one of the known GoogleApp keys? */
function isGoogleApp(x: unknown): x is GoogleApp {
  return typeof x === 'string' && (ALL_APPS as readonly string[]).includes(x);
}

const router = Router();
// Tenant mode: every route here runs as one tenant. The session-gated ones by host and cookie; the loopback callback by the tenant carried in
// the OAuth `state` (tenancy/resolve.ts reads it, services/google-auth.ts checks and spends the nonce).

// Every Google route EXCEPT the OAuth callback requires a real session. Applied
// here as router-level middleware. The callback opts OUT below (it's the loopback
// redirect target, hit with no session) — Express runs middleware in order, so we
// register the callback's own loopback guard as its FIRST handler and this
// router-wide authMiddleware is added AFTER the callback route is defined... but
// to keep ordering simple we instead apply authMiddleware PER-ROUTE on the
// session-gated routes, and a loopbackOnly guard on the callback. (Per-route is
// explicit and avoids a global-then-exempt dance.)

/** True loopback guard — kept ONLY for the OAuth redirect callback, which lands
 *  on http://localhost:{port}/... from the user's own browser with no session.
 *  This route is never exposed through the tunnel (it's a localhost redirect URI
 *  registered with Google), so source-IP is acceptable here specifically. */
function loopbackOnly(req: any, res: any): boolean {
  const ip = req.socket.remoteAddress || '';
  const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLoopback) {
    res.status(404).json({ error: 'Not found' });
    return false;
  }
  return true;
}

// POST /api/google/config → { configured: boolean }
// Accepts { clientId, clientSecret } from the Settings UI. clientId is stored
// plain; clientSecret is ENCRYPTED at rest (AES-256-GCM, same mechanism as the
// refresh token) in the google_auth table — never written to yaml in plaintext.
// Takes effect immediately (read on demand by startAuth / client construction —
// no restart needed). Stored creds take precedence over env/config.
router.post('/config', authMiddleware, (req, res) => {
  const { clientId, clientSecret } = (req.body || {}) as { clientId?: string; clientSecret?: string };
  if (!clientId || !clientId.trim() || !clientSecret || !clientSecret.trim()) {
    res.status(400).json({ error: 'clientId and clientSecret are required.' });
    return;
  }
  try {
    setConfig(clientId.trim(), clientSecret.trim());
    res.json({ configured: isConfigured() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/google/config → clear UI-saved creds (env/config fallback remains).
router.delete('/config', authMiddleware, (req, res) => {
  clearConfig();
  res.json({ configured: isConfigured() });
});

// POST /api/google/accounts/add → { url }
// Begin connecting a BRAND-NEW Google account. Requests BASE_SCOPES only (the
// account row is created on callback, keyed by the userinfo email; per-app scopes
// are granted later via /accounts/grant). Optional body { email } sets login_hint
// so Google pre-selects that account in the chooser.
router.post('/accounts/add', authMiddleware, (req, res) => {
  if (!isConfigured()) {
    res.status(400).json({ error: 'Google is not configured — set client_id/client_secret in config/env.' });
    return;
  }
  const email = typeof (req.body || {}).email === 'string' ? (req.body.email as string) : undefined;
  try {
    const { url } = startAuth({ email });
    res.json({ url });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/google/accounts/grant → { url }
// Open consent to GRANT a specific account the scopes for its bound+enabled apps.
// Resolve the target account from body { accountId } directly, or from body
// { app } (→ the account that app is bound to). The consent URL's scope set is
// that account's union of bound-app scopes; login_hint pre-selects it.
router.post('/accounts/grant', authMiddleware, (req, res) => {
  if (!isConfigured()) {
    res.status(400).json({ error: 'Google is not configured — set client_id/client_secret in config/env.' });
    return;
  }
  const body = (req.body || {}) as { accountId?: string; app?: string };
  const isHealth = body.app === 'health';
  let accountId = typeof body.accountId === 'string' ? body.accountId : undefined;
  if (!accountId && isGoogleApp(body.app)) {
    accountId = accountForApp(body.app) ?? undefined;
  }
  if (!accountId) {
    res.status(400).json({ error: 'Provide an accountId, or an app bound to a connected account.' });
    return;
  }
  try {
    // HEALTH grants run the ISOLATED health-only consent (googlehealth scopes
    // only, include_granted_scopes:false) so the issued token never carries
    // youtube/workspace scopes the Health API rejects. All other apps use the
    // normal union consent.
    const { url } = isHealth ? startHealthAuth(accountId) : startAuth({ accountId });
    res.json({ url });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/google/accounts/reconnect → { url }
// Re-consent an existing account (e.g. after a lapsed/expired refresh token).
// Body { accountId }. Scopes resolve to that account's bound apps; login_hint
// pre-selects its email.
router.post('/accounts/reconnect', authMiddleware, (req, res) => {
  if (!isConfigured()) {
    res.status(400).json({ error: 'Google is not configured — set client_id/client_secret in config/env.' });
    return;
  }
  const accountId = typeof (req.body || {}).accountId === 'string' ? (req.body.accountId as string) : undefined;
  if (!accountId) {
    res.status(400).json({ error: 'accountId is required.' });
    return;
  }
  try {
    const { url } = startAuth({ accountId });
    res.json({ url });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/google/accounts/:id → remove one connected account (clears its
// token row and releases any bindings pointing at it).
router.delete('/accounts/:id', authMiddleware, (req, res) => {
  const id = String(req.params.id);
  const removed = removeAccount(id);
  res.json({ removed, status: getStatus() });
});

// PATCH /api/google/apps → set ONE app binding. Body { app, enabled?, accountId? }.
// `app` is required and must be a known GoogleApp. `enabled` toggles the app on/off;
// `accountId` assigns which connected account powers it (null unbinds). Returns
// the full status so the UI re-renders from one source of truth.
router.patch('/apps', authMiddleware, (req, res) => {
  const body = (req.body || {}) as { app?: unknown; enabled?: unknown; accountId?: unknown };
  if (!isGoogleApp(body.app)) {
    res.status(400).json({ error: 'A valid `app` is required.' });
    return;
  }
  const patch: { enabled?: boolean; accountId?: string | null } = {};
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (body.accountId === null || typeof body.accountId === 'string') {
    patch.accountId = body.accountId as string | null;
  }
  try {
    setBinding(body.app, patch);
    res.json({ status: getStatus() });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/google/auth/callback?code=... → exchange, UPSERT the matching
// google_accounts row (keyed by the userinfo email), show a self-closing page.
// This is the localhost loopback redirect URI registered with the Google client.
// Same route for add / grant / reconnect — they differ only in the scopes the
// consent URL requested; the callback always upserts by email.
router.get('/auth/callback', async (req, res) => {
  // LOOPBACK guard (not session) — this is the OAuth redirect target; the browser
  // arrives here with no session cookie yet, from localhost. Never tunnel-exposed.
  if (!loopbackOnly(req, res)) return;
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const oauthError = typeof req.query.error === 'string' ? req.query.error : '';

  if (oauthError) {
    res.status(400).send(callbackPage(`Google sign-in was cancelled or denied (${oauthError}).`, false));
    return;
  }
  if (!code) {
    res.status(400).send(callbackPage('No authorization code returned.', false));
    return;
  }

  try {
    const status = await handleCallback(code, { state });
    // Name the just-connected account in the success page when we can. The
    // callback upserts by email; the freshest row is the last connected account.
    const newest = status.accounts[status.accounts.length - 1];
    res.send(callbackPage(`Connected${newest ? ` as ${newest.email}` : ''}. You can close this tab.`, true));
  } catch (err: any) {
    res.status(500).send(callbackPage(`Connection failed: ${err.message}`, false));
  }
});

// GET /api/google/auth/status → full GoogleStatus (see services/google-auth.ts):
//   {
//     configured: boolean,
//     accounts: Array<{ id, email, connected, error?, grantedScopes }>,
//     apps: Record<GoogleApp, { enabled, accountId, hasScope, hasScopeKnown, restricted }>,
//     needsGrant: Array<{ app, accountId, scope }>
//   }
// `getStatus()` already includes `configured`. The UI drives the accounts list,
// per-service account dropdown, and grant prompt from this single object.
router.get('/auth/status', authMiddleware, (req, res) => {
  res.json(getStatus());
});

// POST /api/google/disconnect → back-compat: clear ALL connected accounts and
// release every binding. (Single-account installs had one connection; this now
// clears them all.) Per-account removal lives at DELETE /accounts/:id.
router.post('/disconnect', authMiddleware, (req, res) => {
  disconnect();
  res.json({ ok: true, status: getStatus() });
});

/** Minimal HTML for the OAuth callback tab. */
function callbackPage(message: string, ok: boolean): string {
  const safe = message.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  return `<!doctype html><html><head><meta charset="utf-8"><title>Google</title>
<style>body{font-family:system-ui,sans-serif;background:#1a1a1f;color:#e8e8ec;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{text-align:center;max-width:32rem;padding:2rem}.dot{font-size:2rem}</style></head>
<body><div class="card"><div class="dot">${ok ? '✓' : '✕'}</div><p>${safe}</p></div></body></html>`;
}

export default router;
