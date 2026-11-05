// Google OAuth2 foundation — the single owner of the OAuth2Client, the
// ENCRYPTED-at-rest token store, auto-refresh, and the per-app bindings.
// Everything Google (the workspace MCP, a later Outlook poll, the Settings
// surface) imports from here.
//
// Local-first / installed-app flow: a Desktop OAuth client with a localhost
// loopback redirect. No public URL, no hosting — the user is sovereign over their own
// Google connection. The refresh token is the standing key to a whole Google
// account, so it is encrypted (AES-256-GCM) with a key derived from a secret
// that lives in env/config, NOT in plaintext beside the chat logs.
//
// MULTI-ACCOUNT model (refactored 2026-06):
//   - ONE Google Cloud OAuth client (client_id/client_secret) — SINGLETON,
//     stored on the legacy `google_auth` id=1 row. It authorizes ALL accounts.
//   - MANY connected Google accounts — one row per account in `google_accounts`,
//     keyed by `email` (the account identity). Each row holds its OWN encrypted
//     refresh token + access token. Tokens are FULLY isolated between accounts:
//     getValidClient(A) loads only A's row, can never return B's client.
//   - Per-app BINDING — each app → { enabled, account_id }. Which account powers
//     Calendar may differ from which powers Gmail. Stored as JSON on the
//     singleton row (`app_bindings` column).
//
// Synchronous `getDb()` style, mirroring services/cc.ts and services/db.ts.

import crypto from 'crypto';
import { existsSync } from 'fs';
import { ownChmod, ownMkdir, ownWriteFile, readOwnOrApp } from '../tenancy/own-files.js';
import { dirname, join } from 'path';
import { google } from 'googleapis';
import { getDb } from './db.js';
import { getSanctumConfig } from '../config.js';
import { tenantLocal, envFor, tenantOrNull } from '../tenancy/context.js';
import { issueTenantState, parseTenantState, consumeNonce } from '../tenancy/google-state.js';
import { resolveSetting, resolveSecret } from './settings/index.js';

// Derive the OAuth2Client / Credentials types from `google.auth.OAuth2` itself,
// NOT from a direct `google-auth-library` import. googleapis bundles its own
// nested copy of google-auth-library; a top-level import resolves to a DIFFERENT
// copy whose OAuth2Client is structurally identical but nominally incompatible
// (private `redirectUri`). Pulling the type from the constructor googleapis
// actually uses keeps everything on one copy.
type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;
type Credentials = Parameters<OAuth2Client['setCredentials']>[0];

// ---------------------------------------------------------------------------
// Apps + scopes
// ---------------------------------------------------------------------------

// Identity scopes — ALWAYS requested (cheap, needed for the userinfo email
// lookup). Granted on every consent regardless of which apps are bound.
const BASE_SCOPES = ['openid', 'email', 'profile'];

/** Every Workspace app the UI can select. `health` is the Google Health API app
 *  (RESTRICTED scope, wired 2026-06 once the API was confirmed real + enabled in
 *  the Cloud Console). Its DATA consumer (Health REST read / cycle inference) is a
 *  separate later build — this file only makes the app connectable + grantable. */
export type GoogleApp =
  | 'calendar'
  | 'tasks'
  | 'gmail'
  | 'drive'
  | 'docs'
  | 'sheets'
  | 'youtube'
  | 'search_console'
  | 'health';

/** All apps, in display order. */
export const ALL_APPS: readonly GoogleApp[] = [
  'calendar', 'tasks', 'gmail', 'drive', 'docs', 'sheets', 'youtube', 'search_console', 'health',
];

// Per-app scope SETS. The requested scope set for an account = BASE_SCOPES ∪
// (ALL scopes of every app bound to that account AND enabled). So binding Gmail to
// an account and reconnecting is what actually grants Gmail for that account.
//
// MULTI-SCOPE (2026-06): each app maps to an ARRAY of scopes — an app is only
// "granted" when EVERY scope in its set is present in the account's granted set.
// This is what lets us upgrade read-only → read+write. Gmail uses gmail.modify
// ONLY (read + draft + trash); send was removed for security. One re-grant per
// account requests the FULL union, so all an account's scopes land in one consent.
//
// Sensitivity tiers (consent-screen / token-lifetime implications):
//   - calendar            → SENSITIVE. Full read+write of the user's calendars.
//   - tasks               → SENSITIVE. Full read+write of task-lists/tasks.
//   - drive.metadata.readonly → SENSITIVE. Metadata ONLY — never file CONTENT
//                           (kept read-only; Docs/Sheets carry content writes).
//   - documents           → SENSITIVE. Read + write Doc content via the Docs API.
//   - spreadsheets        → SENSITIVE. Read + write Sheet values via the Sheets API.
//   - youtube             → SENSITIVE (manage). Create playlists, add items.
//   - webmasters.readonly → SENSITIVE. Read-only view of Search Console data
//                           (verified properties, search-analytics rows, URL
//                           inspection, sitemaps). NO write scope — we never mutate
//                           Search Console (no sitemap submit, no property add/verify).
//                           Consumed by the read-only `google_search_console` MCP
//                           tool in routes/workspace-mcp.ts.
//   - gmail.modify        → RESTRICTED. Read messages + create DRAFTS + move to
//                           Trash (NEVER permanent delete, NEVER send). In Testing
//                           mode the refresh token expires every 7 days (weekly
//                           re-consent) until the app passes Google's
//                           restricted-scope verification / CASA. This is the ONLY
//                           Gmail scope — gmail.send was removed (Ward hardening):
//                           the assistant drafts; the user sends from Gmail.
//   - googlehealth.health_metrics_and_measurements.readonly
//                         → RESTRICTED. Read-only metrics (HRV, resting heart
//                           rate, sleep/skin temp derivations).
//   - googlehealth.sleep.readonly
//                         → RESTRICTED. Read-only sleep sessions (stages +
//                           summaries). Both health scopes are consumed by the
//                           `google_health` MCP tool (read-only vitals + heuristic
//                           cycle inference) in routes/workspace-mcp.ts.
//
// APP_SCOPES stays a PARTIAL record over GoogleApp so any FUTURE scope-less app
// can simply have no entry — `scopesForApp` returns [] and `hasScopeKnown` reports
// false for it.
const APP_SCOPES: Partial<Record<GoogleApp, string[]>> = {
  calendar: ['https://www.googleapis.com/auth/calendar'],
  tasks: ['https://www.googleapis.com/auth/tasks'],
  // Gmail = gmail.modify ONLY (read + draft + trash). SEND IS REMOVED (Ward
  // exfiltration hardening, 2026-06): the assistant drafts, the user sends from
  // Gmail. gmail.send is NOT requested — no scope, no send code path.
  gmail: [
    'https://www.googleapis.com/auth/gmail.modify',
  ],
  // Drive stays metadata-readonly — no content write happens here (Docs/Sheets do).
  drive: ['https://www.googleapis.com/auth/drive.metadata.readonly'],
  docs: ['https://www.googleapis.com/auth/documents'],
  sheets: ['https://www.googleapis.com/auth/spreadsheets'],
  youtube: ['https://www.googleapis.com/auth/youtube'],
  // Search Console = webmasters.readonly ONLY. Read-only view of properties,
  // search-analytics, URL inspection, and sitemaps. There is NO write scope — we
  // never mutate Search Console (Ward posture: read-only telemetry, no submit/verify
  // path exists). Rides the account's MAIN token union like the other workspace apps.
  search_console: ['https://www.googleapis.com/auth/webmasters.readonly'],
  // health → RESTRICTED, read-only. The metrics scope covers HRV / resting HR /
  // temperature; the sleep scope is REQUIRED for the `sleep` metric (sleep stages +
  // summaries). Both must be granted for the `google_health` tool to advertise.
  // Adding the sleep scope correctly flips health to needs-regrant (one re-grant on
  // the bound account requests the FULL union).
  health: [
    'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
    'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  ],
};

/** The scope SET for an app (possibly empty for a future unwired app). An app is
 *  "granted" only when EVERY scope here is present in the account's granted set. */
export function scopesForApp(app: GoogleApp): string[] {
  return APP_SCOPES[app] ?? [];
}

// ISOLATED HEALTH consent scopes (2026-06). Health authenticates with its OWN
// token whose ONLY scopes are these two googlehealth scopes plus BASE identity.
// The Google Health API 403s ("disallowed OAuth scope(s)") on ANY token that also
// carries youtube/workspace scopes, so health is NEVER folded into the main union
// (`requestedScopes` skips it) — it gets a separate consent + a separate stored
// token. Defined off APP_SCOPES.health so the two lists can never drift.
const HEALTH_SCOPES: string[] = APP_SCOPES.health ?? [];

/** The FULL scope set the isolated health consent requests: BASE identity scopes
 *  plus ONLY the googlehealth scopes — nothing else, ever. */
export function healthConsentScopes(): string[] {
  return Array.from(new Set([...BASE_SCOPES, ...HEALTH_SCOPES]));
}

/** Back-compat single-scope accessor: the FIRST/primary scope of an app, or null.
 *  Most callers want `scopesForApp`; this is kept for any consumer that only needs
 *  a representative scope string. */
export function scopeForApp(app: GoogleApp): string | null {
  return APP_SCOPES[app]?.[0] ?? null;
}

/** Apps whose scope set contains a RESTRICTED scope (weekly-reauth-in-Testing,
 *  verification required for production). Exposed so the UI/report can flag it.
 *  gmail = modify (restricted; send removed); health = restricted metrics. youtube,
 *  docs, sheets, calendar full scopes are SENSITIVE (not restricted). */
export const RESTRICTED_APPS: readonly GoogleApp[] = ['gmail', 'health'];

/** Per-app binding: whether the app is enabled, and which connected account
 *  powers it (the `google_accounts.id` of that account, or null = unbound). */
export interface AppBinding {
  enabled: boolean;
  account_id: string | null;
}

const DEFAULT_BINDING: AppBinding = { enabled: false, account_id: null };

type AppBindings = Record<GoogleApp, AppBinding>;

function defaultBindings(): AppBindings {
  const out = {} as AppBindings;
  for (const app of ALL_APPS) out[app] = { ...DEFAULT_BINDING };
  return out;
}

// ---------------------------------------------------------------------------
// Exported status shapes — THE CONTRACT the frontend mirrors
// ---------------------------------------------------------------------------

/** One connected Google account, as the UI lists it. `connected` is always true
 *  for rows that appear here (a row exists ⇒ it has a usable refresh token).
 *  `grantedScopes` is the full set Google actually granted this account. */
export interface GoogleAccount {
  id: string;
  email: string;
  connected: true;
  error?: string;
  grantedScopes: string[];
}

/** Per-app status the Settings UI consumes to drive the accounts-list +
 *  per-service-dropdown + "reconnect to grant" prompt.
 *   - enabled:       the app's toggle is on.
 *   - accountId:     the bound account's id, or null if unbound.
 *   - hasScope:      the bound account has this app's scope granted in its token.
 *   - hasScopeKnown: true when the app has a wired scope (all apps today,
 *                    including `health`). False only for a future unwired app, in
 *                    which case `hasScope` is meaningless and reported false.
 *   - restricted:    true for RESTRICTED-scope apps (gmail, health) — weekly
 *                    re-consent in Testing mode. */
export interface GoogleAppStatus {
  enabled: boolean;
  accountId: string | null;
  hasScope: boolean;
  hasScopeKnown: boolean;
  restricted: boolean;
}

/** A concrete "this app, bound to this account, is missing this scope" item the
 *  UI grant-prompt can act on directly (open consent for that account). */
export interface GoogleGrantNeed {
  app: GoogleApp;
  accountId: string;
  scope: string;
}

/** The full status object. `configured` = OAuth creds present (the service can
 *  run at all). EXPORTED so the frontend mirrors it verbatim. */
export interface GoogleStatus {
  configured: boolean;
  accounts: GoogleAccount[];
  apps: Record<GoogleApp, GoogleAppStatus>;
  needsGrant: GoogleGrantNeed[];
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------
//
// `google_auth` (id = 1) — the SINGLETON. After the multi-account refactor it
// holds ONLY the OAuth client creds (client_id / client_secret_enc) and the
// per-app bindings JSON. Its legacy token columns (refresh_token_enc, email,
// etc.) are kept for the one-time migration, then nulled out.
//
// `google_accounts` — one row per connected Google account, keyed by email
// (UNIQUE). Holds that account's OWN encrypted refresh token + access token.

const tableReady = tenantLocal(() => false);

function ensureTable(): void {
  if (tableReady.get()) return;
  const db = getDb();

  // Legacy singleton — created if absent (fresh installs), preserved if present
  // (existing installs carry the live connection in its token columns).
  db.exec(`
    CREATE TABLE IF NOT EXISTS google_auth (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      refresh_token_enc TEXT,
      access_token TEXT,
      expiry_date INTEGER,
      email TEXT,
      scope TEXT,
      integrations TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      connected_at TEXT,
      updated_at TEXT NOT NULL,
      client_id TEXT,
      client_secret_enc TEXT
    )
  `);
  // Additive migrations for older rows.
  for (const col of ['client_id TEXT', 'client_secret_enc TEXT', "app_bindings TEXT NOT NULL DEFAULT '{}'"]) {
    try {
      db.exec(`ALTER TABLE google_auth ADD COLUMN ${col}`);
    } catch {
      // Column already exists — ignore.
    }
  }
  db.prepare(
    `INSERT OR IGNORE INTO google_auth (id, integrations, app_bindings, updated_at) VALUES (1, '{}', '{}', ?)`
  ).run(new Date().toISOString());

  // Multi-account token store. id is a stable random string; email is the
  // account identity (UNIQUE so an upsert keyed by email can never duplicate).
  db.exec(`
    CREATE TABLE IF NOT EXISTS google_accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      refresh_token_enc TEXT,
      access_token TEXT,
      expiry_date INTEGER,
      scope TEXT,
      error TEXT,
      connected_at TEXT,
      updated_at TEXT NOT NULL
    )
  `);

  // ISOLATED HEALTH TOKEN columns (2026-06). The Google Health API REJECTS any
  // OAuth token that also carries youtube/workspace scopes ("Request contains
  // disallowed OAuth scope(s)"). So Health gets its OWN token per account — a
  // refresh/access token granted from a consent that requested ONLY the two
  // googlehealth scopes (+ base openid/email/profile), never unioned with the
  // account's other apps. health_refresh_token_enc is encrypted with the SAME
  // AES-256-GCM mechanism as the main refresh token. Additive + idempotent so
  // existing rows simply get NULLs (health shows "needs grant" until re-consent).
  for (const col of [
    'health_refresh_token_enc TEXT',
    'health_access_token TEXT',
    'health_expiry_date INTEGER',
    'health_scope TEXT',
    // Health-token death gets its OWN slot (2026-07-02): writing it to the shared
    // account `error` made the UI's generic "reconnect needed" misdirect the user to a
    // main-account reconnect, which CLEARED the shared error and hid the health
    // Grant door while the health token stayed dead. Only a successful HEALTH
    // refresh/grant clears this.
    'health_error TEXT',
  ]) {
    try {
      db.exec(`ALTER TABLE google_accounts ADD COLUMN ${col}`);
    } catch {
      // Column already exists — ignore.
    }
  }

  tableReady.set(true);

  // One-time migration of the live single-account connection → first account row.
  migrateLegacyConnection();
}

interface SingletonRow {
  id: number;
  refresh_token_enc: string | null;
  access_token: string | null;
  expiry_date: number | null;
  email: string | null;
  scope: string | null;
  integrations: string;
  error: string | null;
  connected_at: string | null;
  updated_at: string;
  client_id: string | null;
  client_secret_enc: string | null;
  app_bindings: string;
}

interface AccountRow {
  id: string;
  email: string;
  refresh_token_enc: string | null;
  access_token: string | null;
  expiry_date: number | null;
  scope: string | null;
  error: string | null;
  connected_at: string | null;
  updated_at: string;
  // Isolated Health token (see ensureTable). Null until the user runs the
  // dedicated health-only consent. Never unioned with the main-token scopes.
  health_refresh_token_enc: string | null;
  health_access_token: string | null;
  health_expiry_date: number | null;
  health_scope: string | null;
  health_error: string | null;
}

function readSingleton(): SingletonRow {
  ensureTable();
  return getDb().prepare('SELECT * FROM google_auth WHERE id = 1').get() as unknown as SingletonRow;
}

function newAccountId(): string {
  return `gacc_${crypto.randomBytes(9).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// One-time migration: legacy single-account row → google_accounts
// ---------------------------------------------------------------------------
//
// CRITICAL: if there is a live, working legacy connection (an account with
// Calendar granted). If the legacy id=1 row still carries a non-null
// refresh_token_enc, MOVE it into google_accounts as the first account —
// copying the CIPHERTEXT blob verbatim (same key, do NOT decrypt/re-encrypt) —
// then null out the singleton's token columns (creds stay). Idempotent: once the
// token columns are nulled (or the email already exists as an account), it's a
// no-op. The per-app calendar=true binding (if set) is migrated to point at the
// new account in migrateLegacyBindings(), called right after.

function migrateLegacyConnection(): void {
  const db = getDb();
  const row = db.prepare('SELECT * FROM google_auth WHERE id = 1').get() as unknown as SingletonRow;
  if (!row || !row.refresh_token_enc) return; // nothing to migrate (fresh install or already migrated)

  const email = (row.email || '').trim();
  if (!email) {
    // No email to key on — we can't form a proper account identity. Leave the
    // legacy row intact rather than create an unkeyable account. (In practice
    // the live row HAS an email; this guard is defensive.)
    return;
  }

  const now = new Date().toISOString();
  const migrate = db.transaction(() => {
    // Does an account already exist for this email? If so, the move already
    // happened on a prior boot — just ensure the legacy token columns are clear.
    const existing = db.prepare('SELECT id FROM google_accounts WHERE email = ?').get(email) as { id: string } | undefined;
    let accountId = existing?.id;
    if (!accountId) {
      accountId = newAccountId();
      // Copy CIPHERTEXT verbatim — refresh_token_enc is the same encrypted blob.
      db.prepare(
        `INSERT INTO google_accounts
           (id, email, refresh_token_enc, access_token, expiry_date, scope, error, connected_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        accountId,
        email,
        row.refresh_token_enc,
        row.access_token ?? null,
        row.expiry_date ?? null,
        row.scope ?? null,
        row.error ?? null,
        row.connected_at ?? now,
        now
      );
    }

    // Migrate the legacy `integrations` bool-map → `app_bindings`, pointing every
    // currently-enabled app at the migrated account. Only do this if app_bindings
    // is still empty (idempotency — don't clobber bindings set post-migration).
    migrateLegacyBindings(accountId);

    // Null out the singleton's token columns — creds (client_id/secret) STAY.
    db.prepare(
      `UPDATE google_auth
         SET refresh_token_enc = NULL, access_token = NULL, expiry_date = NULL,
             email = NULL, scope = NULL, error = NULL, connected_at = NULL, updated_at = ?
       WHERE id = 1`
    ).run(now);
  });
  migrate();
}

/** Migrate the legacy `integrations` JSON bool-map into `app_bindings`, binding
 *  every enabled app that has a scope to `accountId`. No-op if `app_bindings` is
 *  already populated (post-migration writes win). Any future scope-less app would
 *  be carried as enabled+bound only if the legacy map had it on, contributing
 *  nothing operationally; all apps today (incl. health) carry a scope. */
function migrateLegacyBindings(accountId: string): void {
  const db = getDb();
  const row = db.prepare('SELECT integrations, app_bindings FROM google_auth WHERE id = 1').get() as
    | { integrations: string; app_bindings: string }
    | undefined;
  if (!row) return;

  // Only migrate if app_bindings hasn't been populated yet.
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(row.app_bindings || '{}');
  } catch {
    existing = {};
  }
  if (Object.keys(existing).length > 0) return; // already has bindings — leave them

  let legacy: Record<string, unknown> = {};
  try {
    legacy = JSON.parse(row.integrations || '{}');
  } catch {
    legacy = {};
  }

  const bindings = defaultBindings();
  for (const app of ALL_APPS) {
    if (legacy[app] === true) {
      bindings[app] = { enabled: true, account_id: accountId };
    }
  }
  db.prepare('UPDATE google_auth SET app_bindings = ?, updated_at = ? WHERE id = 1')
    .run(JSON.stringify(bindings), new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Encryption — AES-256-GCM, key derived (scrypt) from a secret in env/config
// ---------------------------------------------------------------------------
//
// PRESERVED VERBATIM from the single-account version. The refresh token never
// touches disk in plaintext. The key-deriving secret precedence:
//   1. GOOGLE_TOKEN_SECRET env  (power user opted in)
//   2. the auto-generated key file  (data/.google-key)
//   3. generate-and-write the key file, then use it

const ENC_VERSION = 'v1';
const SALT = 'sanctum.google-auth.v1'; // fixed salt: single secret; rotation = reconnect

/** Absolute path to the key file: a sibling of the DB file, named `.google-key`. */
function keyFilePath(): string {
  const dbPath = getSanctumConfig().server.db_path;
  return join(dirname(dbPath), '.google-key');
}

/** Read the auto-generated key secret, creating it on first call. */
function autoKeySecret(): string {
  const path = keyFilePath();
  try {
    if (existsSync(path)) {
      const existing = readOwnOrApp(path).trim();
      if (existing.length > 0) return existing;
    }
  } catch {
    // Fall through to (re)generate.
  }
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    ownMkdir(dirname(path), { recursive: true });
  } catch {
    // Directory likely exists.
  }
  ownWriteFile(path, secret, { encoding: 'utf8', mode: 0o600 });
  try {
    ownChmod(path, 0o600); // best-effort lockdown (no-op semantics on Windows)
  } catch {
    // chmod is advisory on some platforms — ignore.
  }
  return secret;
}

/** The key-deriving secret. Always returns a usable value: env override, else
 *  the auto-managed key file (created on demand). Never null. */
function tokenSecret(): string {
  const fromEnv = envFor('google token secret').GOOGLE_TOKEN_SECRET;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return autoKeySecret();
}

function deriveKey(secret: string): Buffer {
  return crypto.scryptSync(secret, SALT, 32);
}

/** Encrypt plaintext → "v1:<iv b64>:<tag b64>:<ciphertext b64>". */
function encrypt(plaintext: string): string {
  const secret = tokenSecret();
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/** Decrypt "v1:iv:tag:ct" → plaintext. Returns null on any failure. */
function decrypt(blob: string): string | null {
  try {
    const secret = tokenSecret();
    const parts = blob.split(':');
    if (parts.length !== 4 || parts[0] !== ENC_VERSION) return null;
    const [, ivB64, tagB64, ctB64] = parts;
    const key = deriveKey(secret);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
    return dec.toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// OAuth2 client construction (creds are SINGULAR — one client for all accounts)
// ---------------------------------------------------------------------------

interface GoogleCreds {
  clientId: string;
  clientSecret: string;
}

/** Read creds the user saved via Settings (POST /api/google/config). clientId
 *  plain; clientSecret encrypted. PRESERVED precedence. */
function readStoredCreds(): GoogleCreds | null {
  const row = readSingleton();
  const clientId = (row.client_id || '').trim();
  if (!clientId || !row.client_secret_enc) return null;
  const clientSecret = decrypt(row.client_secret_enc);
  if (!clientSecret) return null;
  return { clientId, clientSecret };
}

/** The creds saved through Settings (the typed google_auth row), for the settings service; null unless both halves are there and decrypt. */
export function storedGoogleCreds(): GoogleCreds | null {
  return readStoredCreds();
}

/** Effective creds through the settings service: the Settings-saved pair (google_auth) first, then GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from
 *  .env (the tenant's own in tenant mode), then sanctum.yaml's google.client_id / client_secret. Both halves must be there. */
function readCreds(): GoogleCreds | null {
  const clientId = String(resolveSetting('google.client_id').value ?? '');
  const clientSecret = resolveSecret('google.client_secret') ?? '';
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Persist UI-supplied creds. clientId plain; clientSecret ENCRYPTED. */
export function setConfig(clientId: string, clientSecret: string): { configured: true } {
  ensureTable();
  const enc = encrypt(clientSecret);
  getDb()
    .prepare('UPDATE google_auth SET client_id = ?, client_secret_enc = ?, updated_at = ? WHERE id = 1')
    .run(clientId.trim(), enc, new Date().toISOString());
  return { configured: true };
}

/** Clear UI-supplied creds (env/config fallback, if any, remains). */
export function clearConfig(): void {
  ensureTable();
  getDb()
    .prepare('UPDATE google_auth SET client_id = NULL, client_secret_enc = NULL, updated_at = ? WHERE id = 1')
    .run(new Date().toISOString());
}

/** The localhost loopback callback URI this server listens on. */
export function redirectUri(): string {
  const port = getSanctumConfig().server.port;
  return `http://localhost:${port}/api/google/auth/callback`;
}

/** True if client_id + client_secret are present (the service can run at all). */
export function isConfigured(): boolean {
  return readCreds() !== null;
}

/** Build a bare OAuth2Client (no creds loaded). Throws if not configured. */
function makeClient(): OAuth2Client {
  const creds = readCreds();
  if (!creds) {
    throw new Error('Google is not configured — set client_id/client_secret');
  }
  return new google.auth.OAuth2(creds.clientId, creds.clientSecret, redirectUri());
}

// ---------------------------------------------------------------------------
// Account rows — read helpers
// ---------------------------------------------------------------------------

function readAccountById(id: string): AccountRow | null {
  ensureTable();
  const row = getDb().prepare('SELECT * FROM google_accounts WHERE id = ?').get(id) as unknown as
    | AccountRow
    | undefined;
  return row ?? null;
}

function readAccountByEmail(email: string): AccountRow | null {
  ensureTable();
  const row = getDb().prepare('SELECT * FROM google_accounts WHERE email = ?').get(email) as unknown as
    | AccountRow
    | undefined;
  return row ?? null;
}

function readAllAccounts(): AccountRow[] {
  ensureTable();
  return getDb()
    .prepare('SELECT * FROM google_accounts ORDER BY connected_at ASC, email ASC')
    .all() as unknown as AccountRow[];
}

/** The scopes Google granted a specific account, parsed from its stored `scope`
 *  field (space-delimited). Empty if the account doesn't exist / no scope. */
export function grantedScopesForAccount(accountId: string): string[] {
  const row = readAccountById(accountId);
  if (!row?.scope) return [];
  return row.scope.split(/\s+/).filter(Boolean);
}

/** The scopes granted on an account's ISOLATED HEALTH token, parsed from the
 *  `health_scope` column (space-delimited). Empty if the account doesn't exist or
 *  has never completed the health-only consent. This — NOT the main `scope` — is
 *  what health gating/status reads. */
export function grantedHealthScopesForAccount(accountId: string): string[] {
  const row = readAccountById(accountId);
  if (!row?.health_scope) return [];
  return row.health_scope.split(/\s+/).filter(Boolean);
}

function setAccountError(accountId: string, message: string | null): void {
  getDb()
    .prepare('UPDATE google_accounts SET error = ?, updated_at = ? WHERE id = ?')
    .run(message, new Date().toISOString(), accountId);
}

/** Health-token failures live in their OWN slot — never the shared account
 *  `error` (whose "reconnect needed" UI prompt misdirects to a main-account
 *  reconnect that can't heal a dead health token). Cleared ONLY by a
 *  successful health refresh or a fresh health grant. */
function setHealthError(accountId: string, message: string | null): void {
  getDb()
    .prepare('UPDATE google_accounts SET health_error = ?, updated_at = ? WHERE id = ?')
    .run(message, new Date().toISOString(), accountId);
}

// ---------------------------------------------------------------------------
// App bindings (enabled + which account powers each app)
// ---------------------------------------------------------------------------

/** All per-app bindings, defaults filled in for any missing app. */
export function getBindings(): AppBindings {
  const row = readSingleton();
  let parsed: Partial<Record<GoogleApp, Partial<AppBinding>>> = {};
  try {
    parsed = JSON.parse(row.app_bindings || '{}');
  } catch {
    parsed = {};
  }
  const out = defaultBindings();
  for (const app of ALL_APPS) {
    const b = parsed[app];
    if (b && typeof b === 'object') {
      out[app] = {
        enabled: b.enabled === true,
        account_id: typeof b.account_id === 'string' ? b.account_id : null,
      };
    }
  }
  return out;
}

function writeBindings(bindings: AppBindings): void {
  ensureTable();
  getDb()
    .prepare('UPDATE google_auth SET app_bindings = ?, updated_at = ? WHERE id = 1')
    .run(JSON.stringify(bindings), new Date().toISOString());
}

/** Set one app's binding. Pass `enabled` and/or `accountId` (each optional; only
 *  provided fields change). Passing accountId=null unbinds. Returns all bindings.
 *  Validates that a provided accountId refers to a real account (else throws). */
export function setBinding(
  app: GoogleApp,
  patch: { enabled?: boolean; accountId?: string | null }
): AppBindings {
  const bindings = getBindings();
  const current = bindings[app];
  let nextAccount = current.account_id;
  if (patch.accountId !== undefined) {
    if (patch.accountId !== null && !readAccountById(patch.accountId)) {
      throw new Error(`No connected Google account with id ${patch.accountId}`);
    }
    nextAccount = patch.accountId;
  }
  bindings[app] = {
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
    account_id: nextAccount,
  };
  writeBindings(bindings);
  return bindings;
}

/** When an account is removed, any binding pointing at it must be released so a
 *  stale account_id can never leak a different account's client. */
function detachAccountFromBindings(accountId: string): void {
  const bindings = getBindings();
  let changed = false;
  for (const app of ALL_APPS) {
    if (bindings[app].account_id === accountId) {
      bindings[app] = { enabled: false, account_id: null };
      changed = true;
    }
  }
  if (changed) writeBindings(bindings);
}

// ---------------------------------------------------------------------------
// Scope coordination — per ACCOUNT
// ---------------------------------------------------------------------------

/** The OAuth scopes to REQUEST for a given account = identity scopes ∪ the scope
 *  of every app that is enabled AND bound to THIS account AND has a scope. Apps
 *  with no wired scope contribute nothing (none today). With no accountId (a
 *  brand-new account with nothing bound yet) this is just BASE_SCOPES. */
export function requestedScopes(accountId?: string | null): string[] {
  const scopes = [...BASE_SCOPES];
  if (!accountId) return scopes;
  const bindings = getBindings();
  for (const app of ALL_APPS) {
    // HEALTH IS NEVER IN THE MAIN UNION. The Health API rejects any token that
    // also carries youtube/workspace scopes, so googlehealth gets its OWN
    // isolated token via the health consent flow — never bundled here.
    if (app === 'health') continue;
    const b = bindings[app];
    if (!b.enabled || b.account_id !== accountId) continue;
    for (const scope of scopesForApp(app)) scopes.push(scope);
  }
  // De-dup (apps could share a scope; keep the union clean). This union is what
  // ONE re-grant requests — so all of an account's write scopes land at once.
  return Array.from(new Set(scopes));
}

/** Whether ALL of an app's scopes are present in its bound account's granted set.
 *  False if the app is unbound, has no wired scopes, or the account is missing ANY
 *  required scope. This is the gate that makes a calendar-readonly grant correctly
 *  show "needs grant" once the app's scope set changed to the read+write scope. */
export function isScopeGranted(app: GoogleApp): boolean {
  const scopes = scopesForApp(app);
  if (scopes.length === 0) return false; // no wired scopes ⇒ never "granted"
  const binding = getBindings()[app];
  if (!binding.account_id) return false;
  // HEALTH reads its ISOLATED token's scope set, NOT the main token. The main
  // token's googlehealth scope (if a legacy union ever granted it) does NOT count
  // — the Health API only accepts the isolated token, so grant state must reflect
  // exactly that token.
  if (app === 'health') {
    const granted = new Set(grantedHealthScopesForAccount(binding.account_id));
    return scopes.every((s) => granted.has(s));
  }
  const granted = new Set(grantedScopesForAccount(binding.account_id));
  return scopes.every((s) => granted.has(s));
}

/** Whether a SPECIFIC write scope for an app is granted on its bound account.
 *  Used by write actions to give a precise "needs re-grant for this capability"
 *  signal (e.g. the documents scope may be missing on a Docs-bound account).
 *  Returns false if the app is unbound or the scope isn't in the app's wired set. */
export function isWriteScopeGranted(app: GoogleApp, scope: string): boolean {
  if (!scopesForApp(app).includes(scope)) return false;
  const binding = getBindings()[app];
  if (!binding.account_id) return false;
  return grantedScopesForAccount(binding.account_id).includes(scope);
}

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

/** True if at least one account is connected (has a stored refresh token). */
export function isConnected(): boolean {
  ensureTable();
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM google_accounts WHERE refresh_token_enc IS NOT NULL')
    .get() as { c: number };
  return row.c > 0;
}

/** True if a SPECIFIC account is connected. */
export function isAccountConnected(accountId: string): boolean {
  return !!readAccountById(accountId)?.refresh_token_enc;
}

// ---------------------------------------------------------------------------
// Auth flow
// ---------------------------------------------------------------------------

/** Build the Google consent URL.
 *   - For RE-consenting / adding-scope to a KNOWN account, pass its `accountId`:
 *     scopes resolve to that account's bound apps, and `login_hint` is set to its
 *     email so Google pre-selects it.
 *   - For a BRAND-NEW account (nothing bound yet), pass no accountId (optionally
 *     an `email` to pre-select): only BASE_SCOPES are requested. The account row
 *     is created on callback; scopes are granted later via the grant flow.
 *  access_type=offline + prompt=consent are BOTH mandatory (no refresh token
 *  otherwise). include_granted_scopes=true keeps previously-granted scopes. */
export function startAuth(opts: { accountId?: string; email?: string } = {}): { url: string } {
  const client = makeClient();

  // Resolve a login_hint: explicit email wins, else the known account's email.
  let loginHint: string | undefined = opts.email;
  if (!loginHint && opts.accountId) {
    loginHint = readAccountById(opts.accountId)?.email ?? undefined;
  }

  const url = client.generateAuthUrl({
    access_type: 'offline', // MANDATORY — yields a refresh token
    prompt: 'consent', // MANDATORY — forces refresh token even on re-consent
    scope: requestedScopes(opts.accountId), // BASE for new; BASE∪bound for known
    // incremental — keep previously-granted scopes. CORRECT for the common case.
    // Health is NEVER requested here (requestedScopes skips it), so this main
    // consent can never bundle googlehealth into the main token.
    include_granted_scopes: true,
    state: stateFor(MAIN_STATE),
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return { url };
}

// OAuth `state` markers — the callback uses these to route the returned tokens to
// the right slot (main token columns vs the isolated health_* columns). The health
// marker also carries the target accountId so the callback can persist health
// tokens onto the EXACT account that asked, keyed independently of email lookup.
const MAIN_STATE = 'main';
const HEALTH_STATE_PREFIX = 'health:';

/** The state for a consent URL: the marker itself with tenancy off (unchanged), `<tenantId>:<nonce>:<marker>` inside a tenant (tenancy/google-state.ts). */
function stateFor(marker: string): string {
  const rt = tenantOrNull('a Google consent state');
  return rt ? issueTenantState(rt.id, marker) : marker;
}

/** Begin the ISOLATED HEALTH consent for a known account. Requests ONLY the
 *  googlehealth scopes (+ BASE identity) — NEVER the account's other apps, and
 *  NEVER include_granted_scopes (which would pull youtube/workspace into the
 *  token and make the Health API 403). The returned token is persisted into the
 *  account's health_* columns on callback. Requires a KNOWN accountId (health is
 *  only grantable on an already-connected account).
 *
 *  CRITICAL: `include_granted_scopes: false` is the whole fix. With it true, Google
 *  unions previously-granted scopes (youtube, etc.) into the issued token and the
 *  Health API rejects it. False forces a token carrying ONLY the requested health
 *  scopes. */
export function startHealthAuth(accountId: string): { url: string } {
  const client = makeClient();
  const account = readAccountById(accountId);
  if (!account) {
    throw new Error(`Google account ${accountId} does not exist`);
  }
  const loginHint = account.email;

  const url = client.generateAuthUrl({
    access_type: 'offline', // MANDATORY — yields a refresh token
    prompt: 'consent', // MANDATORY — forces a refresh token even on re-consent
    scope: healthConsentScopes(), // ONLY base + googlehealth — nothing else
    include_granted_scopes: false, // CRITICAL — no youtube/workspace in the token
    state: stateFor(`${HEALTH_STATE_PREFIX}${accountId}`),
    login_hint: loginHint,
  });
  return { url };
}

/** Exchange an authorization code for tokens, look up the userinfo email, and
 *  UPSERT the matching `google_accounts` row keyed by email. If a refresh token
 *  is present it's encrypted+stored; if not (a re-consent that returned none) the
 *  existing one is kept. Returns full status. */
export async function handleCallback(
  code: string,
  opts: { state?: string } = {}
): Promise<GoogleStatus> {
  ensureTable();
  // Tenant mode: the state must name THIS tenant and carry a nonce this tenant issued; it is spent before the code is exchanged.
  let marker = opts.state || MAIN_STATE;
  const rt = tenantOrNull('the Google callback');
  if (rt) {
    const parsed = parseTenantState(opts.state);
    if (!parsed || parsed.tenantId !== rt.id || !consumeNonce(parsed.nonce)) {
      throw new Error('This Google sign-in did not start here, or it has expired — please start it again.');
    }
    marker = parsed.marker;
  }
  const client = makeClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  // ROUTE by the OAuth `state` marker. A HEALTH consent ("health:<accountId>")
  // lands its tokens in the isolated health_* columns of that exact account; a
  // MAIN consent upserts the main token columns keyed by the userinfo email.
  const state = marker;
  if (state.startsWith(HEALTH_STATE_PREFIX)) {
    const accountId = state.slice(HEALTH_STATE_PREFIX.length);
    const account = readAccountById(accountId);
    if (!account) {
      throw new Error('Health consent returned for an unknown account — please retry.');
    }
    persistHealthTokens(accountId, tokens);
    return getStatus();
  }

  // MAIN consent — resolve the connected account email (the identity we key on).
  let email: string | undefined;
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const me = await oauth2.userinfo.get();
    email = me.data.email || undefined;
  } catch {
    // Email lookup is best-effort but we NEED it to key the account. If it fails
    // we fall through to the no-email branch below.
  }

  if (!email) {
    // Without an email we cannot form an account identity. Surface a clear error
    // rather than persist an unkeyable token.
    throw new Error('Could not determine the Google account email — please retry.');
  }

  upsertAccountTokens(email, tokens);
  return getStatus();
}

/** UPSERT a google_accounts row by email. Refresh token (if present) encrypted;
 *  access token + expiry + scope stored. On an existing row with no new refresh
 *  token, the existing refresh token is preserved (re-consent that returned none
 *  still refreshes access/scope). */
function upsertAccountTokens(email: string, tokens: Credentials): void {
  ensureTable();
  const db = getDb();
  const now = new Date().toISOString();
  const existing = readAccountByEmail(email);

  if (existing) {
    if (tokens.refresh_token) {
      const enc = encrypt(tokens.refresh_token);
      db.prepare(
        `UPDATE google_accounts
           SET refresh_token_enc = ?, access_token = ?, expiry_date = ?, scope = ?, error = NULL, updated_at = ?
         WHERE id = ?`
      ).run(enc, tokens.access_token ?? null, tokens.expiry_date ?? null, tokens.scope ?? existing.scope, now, existing.id);
    } else {
      db.prepare(
        `UPDATE google_accounts
           SET access_token = ?, expiry_date = ?, scope = COALESCE(?, scope), error = NULL, updated_at = ?
         WHERE id = ?`
      ).run(tokens.access_token ?? null, tokens.expiry_date ?? null, tokens.scope ?? null, now, existing.id);
    }
    return;
  }

  // New account row.
  const id = newAccountId();
  const enc = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;
  db.prepare(
    `INSERT INTO google_accounts
       (id, email, refresh_token_enc, access_token, expiry_date, scope, error, connected_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  ).run(id, email, enc, tokens.access_token ?? null, tokens.expiry_date ?? null, tokens.scope ?? null, now, now);
}

/** Persist a refreshed token bundle onto a SPECIFIC account row. The refresh
 *  token is re-encrypted only if the library rotated a new one in. */
function persistAccountTokens(accountId: string, tokens: Credentials): void {
  const db = getDb();
  const now = new Date().toISOString();
  if (tokens.refresh_token) {
    const enc = encrypt(tokens.refresh_token);
    db.prepare(
      `UPDATE google_accounts
         SET refresh_token_enc = ?, access_token = ?, expiry_date = ?, scope = COALESCE(?, scope), error = NULL, updated_at = ?
       WHERE id = ?`
    ).run(enc, tokens.access_token ?? null, tokens.expiry_date ?? null, tokens.scope ?? null, now, accountId);
  } else {
    db.prepare(
      `UPDATE google_accounts
         SET access_token = ?, expiry_date = ?, scope = COALESCE(?, scope), updated_at = ?
       WHERE id = ?`
    ).run(tokens.access_token ?? null, tokens.expiry_date ?? null, tokens.scope ?? null, now, accountId);
  }
}

/** Persist the ISOLATED HEALTH token bundle onto an account's health_* columns.
 *  The refresh token is encrypted (same AES-256-GCM as the main token); it is
 *  re-encrypted only when the library rotated a new one in. NEVER touches the main
 *  token columns. The granted `scope` is stored so health gating reads it. */
function persistHealthTokens(accountId: string, tokens: Credentials): void {
  const db = getDb();
  const now = new Date().toISOString();
  if (tokens.refresh_token) {
    const enc = encrypt(tokens.refresh_token);
    db.prepare(
      `UPDATE google_accounts
         SET health_refresh_token_enc = ?, health_access_token = ?, health_expiry_date = ?,
             health_scope = COALESCE(?, health_scope), error = NULL, health_error = NULL, updated_at = ?
       WHERE id = ?`
    ).run(enc, tokens.access_token ?? null, tokens.expiry_date ?? null, tokens.scope ?? null, now, accountId);
  } else {
    db.prepare(
      `UPDATE google_accounts
         SET health_access_token = ?, health_expiry_date = ?, health_scope = COALESCE(?, health_scope), health_error = NULL, updated_at = ?
       WHERE id = ?`
    ).run(tokens.access_token ?? null, tokens.expiry_date ?? null, tokens.scope ?? null, now, accountId);
  }
}

/** Return an authed OAuth2Client backed by the account's ISOLATED HEALTH token —
 *  the token granted from the health-only consent (googlehealth scopes only). Auto-
 *  refreshes within ~60s of expiry and re-persists rotation to the health_* columns.
 *  Throws clearly if the account doesn't exist or has never completed the health
 *  consent (no isolated refresh token). NEVER reads or writes the main token. */
export async function getValidHealthClient(accountId: string): Promise<OAuth2Client> {
  if (!accountId) {
    throw new Error('getValidHealthClient requires an accountId');
  }
  const row = readAccountById(accountId);
  if (!row) {
    throw new Error(`Google account ${accountId} does not exist`);
  }
  if (!row.health_refresh_token_enc) {
    throw new Error(`Google account ${accountId} has not granted Health — run the Health consent`);
  }
  const refreshToken = decrypt(row.health_refresh_token_enc);
  if (!refreshToken) {
    setHealthError(accountId, 'Health token could not be decrypted — re-grant Health');
    throw new Error('Google Health token unreadable — re-grant Health');
  }

  const client = makeClient();
  client.setCredentials({
    refresh_token: refreshToken,
    access_token: row.health_access_token ?? undefined,
    expiry_date: row.health_expiry_date ?? undefined,
  });

  // Persist any token the library rotates in — onto THIS account's health_* slot.
  client.on('tokens', (t) => {
    try {
      persistHealthTokens(accountId, t);
    } catch {
      // Persist failure must not break the in-flight request.
    }
  });

  const needsRefresh =
    !row.health_access_token ||
    !row.health_expiry_date ||
    row.health_expiry_date - Date.now() < 60_000;

  if (needsRefresh) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      persistHealthTokens(accountId, credentials);
      setHealthError(accountId, null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setHealthError(accountId, `Health refresh failed: ${msg} — re-grant Health`);
      throw new Error('Google Health token refresh failed — re-grant Health');
    }
  }

  return client;
}

/** Return an authed OAuth2Client for ONE specific account, auto-refreshing if the
 *  access token is within ~60s of expiry, and re-persisting rotation to THAT row.
 *  REQUIRES an accountId. Throws clearly if the account doesn't exist / isn't
 *  connected / token unreadable / refresh failed.
 *
 *  ISOLATION: only `accountId`'s row is ever read. The returned client is loaded
 *  exclusively with that account's credentials — it can never act as another
 *  account. */
export async function getValidClient(accountId: string): Promise<OAuth2Client> {
  if (!accountId) {
    throw new Error('getValidClient requires an accountId');
  }
  const row = readAccountById(accountId);
  if (!row) {
    throw new Error(`Google account ${accountId} does not exist`);
  }
  if (!row.refresh_token_enc) {
    throw new Error(`Google account ${accountId} is not connected`);
  }
  const refreshToken = decrypt(row.refresh_token_enc);
  if (!refreshToken) {
    setAccountError(accountId, 'Token could not be decrypted — reconnect needed');
    throw new Error('Google token unreadable — reconnect needed');
  }

  const client = makeClient();
  client.setCredentials({
    refresh_token: refreshToken,
    access_token: row.access_token ?? undefined,
    expiry_date: row.expiry_date ?? undefined,
  });

  // Persist any token the library rotates in — onto THIS account's row only.
  client.on('tokens', (t) => {
    try {
      persistAccountTokens(accountId, t);
    } catch {
      // Persist failure must not break the in-flight request.
    }
  });

  const needsRefresh =
    !row.access_token ||
    !row.expiry_date ||
    row.expiry_date - Date.now() < 60_000;

  if (needsRefresh) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      persistAccountTokens(accountId, credentials);
      setAccountError(accountId, null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setAccountError(accountId, `Refresh failed: ${msg} — reconnect needed`);
      throw new Error('Google token refresh failed — reconnect needed');
    }
  }

  return client;
}

/** Resolve the authed client for an APP by following its binding to an account.
 *  Throws GoogleAppNotBoundError if the app is disabled/unbound (callers in the
 *  MCP / google.ts translate that to a friendly "enable + bind in Settings"). */
export async function getClientForApp(app: GoogleApp): Promise<OAuth2Client> {
  const binding = getBindings()[app];
  if (!binding.enabled || !binding.account_id) {
    throw new GoogleAppNotBoundError(app);
  }
  // HEALTH resolves to its ISOLATED token (googlehealth-only). All OTHER apps use
  // the account's main token. This is the seam that keeps youtube/workspace scopes
  // out of the token the Health API sees.
  if (app === 'health') {
    return getValidHealthClient(binding.account_id);
  }
  return getValidClient(binding.account_id);
}

/** The account id currently powering an app (enabled + bound), or null. */
export function accountForApp(app: GoogleApp): string | null {
  const binding = getBindings()[app];
  return binding.enabled ? binding.account_id : null;
}

/** Thrown when an app has no enabled+bound account to act through. */
export class GoogleAppNotBoundError extends Error {
  constructor(public readonly app: GoogleApp) {
    super(`Google ${app} is not bound to a connected account`);
    this.name = 'GoogleAppNotBoundError';
  }
}

// ---------------------------------------------------------------------------
// Status / disconnect
// ---------------------------------------------------------------------------

export function getStatus(): GoogleStatus {
  ensureTable();
  const accountsRaw = readAllAccounts().filter((a) => a.refresh_token_enc);
  const accounts: GoogleAccount[] = accountsRaw.map((a) => ({
    id: a.id,
    email: a.email,
    connected: true as const,
    error: a.error ?? undefined,
    grantedScopes: a.scope ? a.scope.split(/\s+/).filter(Boolean) : [],
  }));

  // Pre-index granted scopes per account for the per-app rollup.
  const grantedByAccount = new Map<string, Set<string>>();
  for (const a of accounts) grantedByAccount.set(a.id, new Set(a.grantedScopes));

  // Health reads its ISOLATED token's scopes, not the main token's. Index those
  // separately so the health row's hasScope/needsGrant reflect the health token.
  const healthGrantedByAccount = new Map<string, Set<string>>();
  for (const a of accountsRaw) {
    healthGrantedByAccount.set(
      a.id,
      new Set(grantedHealthScopesForAccount(a.id))
    );
  }

  const bindings = getBindings();
  const apps = {} as Record<GoogleApp, GoogleAppStatus>;
  const needsGrant: GoogleGrantNeed[] = [];

  for (const app of ALL_APPS) {
    const binding = bindings[app];
    const scopes = scopesForApp(app);
    const hasScopeKnown = scopes.length > 0;
    const restricted = RESTRICTED_APPS.includes(app);

    // "hasScope" now means ALL of the app's scopes are granted on the bound
    // account. An app whose set grew (e.g. calendar readonly → calendar full, or
    // gmail → modify+send) reports hasScope=false until a re-grant supplies the
    // FULL set — which is the correct, intended UI re-grant prompt.
    let hasScope = false;
    let missing: string[] = [];
    if (hasScopeKnown && binding.account_id) {
      // HEALTH checks the isolated health token's scopes; everything else the main.
      const granted =
        app === 'health'
          ? healthGrantedByAccount.get(binding.account_id) ?? new Set<string>()
          : grantedByAccount.get(binding.account_id) ?? new Set<string>();
      missing = scopes.filter((s) => !granted.has(s));
      hasScope = missing.length === 0;

      // A PRESENT health token can still be DEAD: Google revokes restricted-scope
      // grants server-side (invalid_grant on refresh — seen 2026-07-02, token had
      // been dead since ~Jun 29 while the UI showed "okay" because only token
      // PRESENCE was checked). Death lives in the DEDICATED health_error slot —
      // NOT the shared account error (v1 of this fix used the shared field; a
      // main-account reconnect cleared it and the Grant door vanished while the
      // health token stayed dead — the user hit exactly that). Only a successful
      // health refresh/grant clears health_error.
      if (app === 'health' && hasScope) {
        const acctRow = accountsRaw.find((a) => a.id === binding.account_id);
        if (acctRow?.health_error) {
          hasScope = false;
          missing = [...scopes]; // full health re-consent needed
        }
      }
    }

    apps[app] = {
      enabled: binding.enabled,
      accountId: binding.account_id,
      hasScope,
      hasScopeKnown,
      restricted,
    };

    // A grant is needed when: app is enabled, bound to a connected account, has
    // wired scopes, but ANY required scope isn't granted yet. One GoogleGrantNeed
    // is emitted per missing scope so the UI can show exactly what's outstanding.
    if (
      binding.enabled &&
      binding.account_id &&
      hasScopeKnown &&
      grantedByAccount.has(binding.account_id) && // bound account is actually connected
      !hasScope
    ) {
      for (const scope of missing) {
        needsGrant.push({ app, accountId: binding.account_id, scope });
      }
    }
  }

  return {
    configured: isConfigured(),
    accounts,
    apps,
    needsGrant,
  };
}

/** Remove ONE account: clear its token row and release any bindings pointing at
 *  it. Local-only — does not call Google's revoke endpoint this slice. Returns
 *  true if a row was removed. */
export function removeAccount(accountId: string): boolean {
  ensureTable();
  const db = getDb();
  const run = db.transaction(() => {
    detachAccountFromBindings(accountId);
    const res = db.prepare('DELETE FROM google_accounts WHERE id = ?').run(accountId);
    return res.changes > 0;
  });
  return run();
}

/** Back-compat: clear ALL accounts and release every binding. The old
 *  single-account disconnect cleared the one connection; here it clears them all. */
export function disconnect(): void {
  ensureTable();
  const db = getDb();
  const run = db.transaction(() => {
    db.prepare('DELETE FROM google_accounts').run();
    writeBindings(defaultBindings());
  });
  run();
}

// ---------------------------------------------------------------------------
// Generic secret crypto — thin exported wrappers over the same AES-256-GCM pair
// used for Google refresh tokens. Reused by services/bot-token.ts so bot tokens
// are encrypted at rest with the same derived key (GOOGLE_TOKEN_SECRET / .google-key
// + the v1 salt). Accepted tradeoff for a local single-user app: rotating the key
// requires re-entering both the Google creds and the bot tokens.
// ---------------------------------------------------------------------------

/** Encrypt an arbitrary secret string → "v1:iv:tag:ct". */
export function encryptSecret(plaintext: string): string {
  return encrypt(plaintext);
}

/** Decrypt a secret blob produced by encryptSecret → plaintext, or null on failure. */
export function decryptSecret(blob: string): string | null {
  return decrypt(blob);
}
