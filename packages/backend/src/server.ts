// Node version guard — must run before any other imports that load native addons
const _nodeVersion = process.versions.node;
const _nodeMajor = parseInt(_nodeVersion.split('.')[0], 10);
if (_nodeMajor >= 25) {
  console.error(`[FATAL] Node.js v${_nodeVersion} is not yet supported. Sanctum requires Node 20-24.`);
  console.error('See (upstream Resonant): https://github.com/simonvale/resonant/issues/2');
  process.exit(1);
}

// Secrets file: the guides say to put `.env` at the repo root, but `npm start`
// runs this process from packages/backend, so a plain `dotenv/config` would
// look in the wrong folder and the password would silently go unread. Load the
// root file first, then the working-directory one (either may be absent).
import { config as loadDotenv } from 'dotenv';
import { dirname as _dn, resolve as _rs } from 'path';
import { fileURLToPath as _fu } from 'url';
loadDotenv({ path: _rs(_dn(_fu(import.meta.url)), '..', '..', '..', '.env') });
loadDotenv();
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { loadConfig, getSanctumConfig, browserFrameOrigin, checkBrowserUrl } from './config.js';
import { warnIfBrowserUnfiltered } from './services/browser-gate.js';
import { initDb, deleteExpiredSessions } from './services/db.js';
import { loadVectorCache } from './services/vector-cache.js';
import { createWebSocketServer, setVoiceService, setGatewayServices, registry } from './services/ws.js';
import { Orchestrator } from './services/orchestrator.js';
import { AgentService, registerAgentService } from './services/agent.js';
import { VoiceService } from './services/voice.js';
import { PushService } from './services/push.js';
import { DiscordService } from './services/discord/index.js';
import { TelegramService } from './services/telegram/index.js';
import { rateLimiter, securityHeaders } from './middleware/security.js';
import { internalOnly, internalTokenFingerprint, internalTokenSource } from './middleware/internal-token.js';
import { appWriteGate } from './middleware/app-write.js';
import { authMiddleware } from './middleware/auth.js';
import { createPluginMount } from './services/plugins.js';
import { identityRouter, identityInternalRouter } from './routes/identity.js';
import { startIdentityGate } from './services/identity/notify.js';
import { setSystemLineRegistry } from './services/system-line.js';
import { writePluginsEnabled } from './services/plugin-config.js';
import apiRoutes, { initCcRoutes, ccEnabledGate } from './routes/api.js';
import setupRoutes from './routes/setup.js';
import { announceSetupCode } from './services/setup-code.js';
import authPreferencesRoutes from './routes/auth-preferences.js';
import googleRoutes from './routes/google-routes.js';
import { startOutlookPoller, stopOutlookPoller } from './services/outlook.js';
import { startOutlookAuthor, stopOutlookAuthor } from './services/outlook-author.js';
import { startHandoffSchedule, stopHandoffSchedule } from './services/handoff.js';
import { MindWatchdog, setMindWatchdog } from './services/mind-watchdog.js';
import { globalErrorHandler } from './middleware/error-handler.js';
import { parseTenantsBlock } from './tenancy/config.js';
import { announceTenantSetupCodes, bootTenants, stopTenantServices } from './tenancy/boot.js';
import { installTenantConsole } from './tenancy/console.js';
import { buildTenantPluginMounts } from './tenancy/plugin-mount.js';
import { tenantResolve, tenantEnter } from './tenancy/resolve.js';
import { loadOperatorToken, operatorBypassesResolve, operatorRouter } from './tenancy/operator.js';
import { mountTenantRefusals, tenantMutationScan } from './tenancy/guard.js';
import { tenantInfoRouter } from './tenancy/info.js';
import { companionsRouter } from './tenancy/companions.js';
import { announceHouseSetupCode, houseSetupRouter } from './tenancy/house-setup.js';
import { closeHouse, houseDataDir, householdMode } from './tenancy/house.js';
import type { TenantRuntime } from './tenancy/context.js';

// Load config FIRST — before any other initialization
const config = loadConfig();
warnIfBrowserUnfiltered(config);

// A `tenants:` block in sanctum.yaml turns on tenant mode (docs/MULTI-TENANT.md, option (b)): one process, one database and one login per
// tenant. Stage 1 serves the browser API per tenant; channels, the scheduler and the websocket stay off. Without the block nothing below
// changes: no tenant code runs and the lines that follow are the single-tenant server.
const TENANT_MODE = parseTenantsBlock(config) !== null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = config.server.port;
const HOST = config.server.host;
const DB_PATH = config.server.db_path;

// Ensure data directory exists
const dataDir = dirname(DB_PATH);
if (!TENANT_MODE && !existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

// Ensure files directory exists
const filesDir = join(dataDir, 'files');
if (!TENANT_MODE && !existsSync(filesDir)) {
  mkdirSync(filesDir, { recursive: true });
}

// Initialize database (tenant mode: each tenant opens its own in bootTenants, below; the process has none)
let db: ReturnType<typeof initDb> | null = null;
if (!TENANT_MODE) {
  console.log('Initializing database...');
  db = initDb(DB_PATH);
  deleteExpiredSessions();
  loadVectorCache();
  console.log('Database initialized');
}

// Create Express app
const app = express();

// Trust proxy headers (e.g. Cloudflare tunnel, nginx)
app.set('trust proxy', 1);

// Tenant mode: build every tenant, then decide the request's tenant before anything else sees it (helmet, static, the routers).
let tenantRuntimes: Map<string, TenantRuntime> | null = null;
if (TENANT_MODE) {
  // Installed BEFORE the tenants boot: a console line written while a tenant is current goes to that tenant's log file, not the process's
  // stdout, so a tenant's own boot lines ([identity], [Voice], [vector-cache]) are its own. The [tenancy] lines are written with no tenant current.
  installTenantConsole();
  tenantRuntimes = bootTenants(app, config);
  // The operator's park and revive routes carry their own token (not a tenant's): tenant resolution stands aside for those paths on a host no companion owns,
  // and the router itself is mounted below with the rest of the chain (helmet, rate limiter, body parsers), tenancy/operator.ts.
  app.use((req, res, next) => { if (operatorBypassesResolve(req)) next(); else tenantResolve(req, res, next); });
}

// Environment-conditional origins
const IS_DEV = process.env.NODE_ENV !== 'production';
const corsOrigins: string[] = [...config.cors.origins, `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
if (IS_DEV) corsOrigins.push('http://localhost:5173');

const connectSrc: string[] = ["'self'"];
// Derive WebSocket connect sources from CORS origins
for (const origin of config.cors.origins) {
  const wsOrigin = origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  connectSrc.push(wsOrigin);
}
if (IS_DEV) connectSrc.push(`ws://localhost:${PORT}`);

const browserOrigin = browserFrameOrigin(config.integrations.browser_url, config.server);
if (config.integrations.browser_url && !browserOrigin) {
  console.warn(`[browser] integrations.browser_url is invalid (${(checkBrowserUrl(config.integrations.browser_url, config.server) as { reason: string }).reason}); the Browser tab is disabled`);
}

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc,
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      mediaSrc: ["'self'", "blob:"],
      fontSrc: ["'self'"],
      // The Browser tab embeds one operator-configured viewer origin; nothing else may be framed.
      frameSrc: ["'self'", ...(browserOrigin ? [browserOrigin] : [])],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      workerSrc: ["'self'"],
      upgradeInsecureRequests: null,
    }
  },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));

app.use(securityHeaders);
// Rate limiter only on API/MCP routes — not static assets
app.use('/api', rateLimiter);
app.use('/mcp', rateLimiter);

// CORS
app.use(cors({
  origin: corsOrigins,
  credentials: true,
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// Body parsers call next() from stream events, outside the store the request started in: enter the tenant again after them.
if (TENANT_MODE) { app.use(tenantEnter); mountTenantRefusals(app); app.use(['/api', '/mcp'], tenantMutationScan); }
// The operator's park and revive routes (tenancy/operator.ts), after the body parsers and tenantEnter like any other internal route.
if (TENANT_MODE) {
  const operatorDataDir = houseDataDir(config.server.db_path);
  loadOperatorToken(operatorDataDir); // (creates the owner-only token file on first use; a file open to group or world is refused, and the routes stay off)
  app.use('/api/internal/tenants', operatorRouter({ dataDir: operatorDataDir, remote: parseTenantsBlock(config)?.operator_routes_remote === true }));
}

// Plugin routes (docs/PLUGINS.md). Mounted BEFORE the api router, whose blanket
// session auth would otherwise answer a plugin's internal-token routes first.
// Manifests are read here; a plugin's routes.mjs is imported on its first
// authenticated request, not at startup.
// Tenant mode: one plugin mount per tenant (tenancy/plugin-mount.ts); `config` answers for the tenant asking, and non-tenant_aware plugins are refused.
const pluginMountDeps = () => ({
  auth: authMiddleware,
  internalOnly,
  writeGate: appWriteGate,
  api: { get config() { return TENANT_MODE ? getSanctumConfig() : config; }, log: (...a: unknown[]) => console.log('[plugin]', ...a) },
  setEnabled: writePluginsEnabled,
});
app.use('/api/plugins', TENANT_MODE ? buildTenantPluginMounts(tenantRuntimes!.values(), pluginMountDeps) : createPluginMount(pluginMountDeps()));

// Identity ratification routes (docs/PLUGINS.md "Identity ratification"). Ahead of the main router for the same reason as plugins:
// each route names its own gate (the person's session, or the internal token).
// (Tenant mode: the same routers, per tenant: every handler reads the tenant's own config, ledger folder and database.)
app.use('/api/identity', identityRouter);
app.use('/api/internal/identity', identityInternalRouter);

// The setup wizard (docs/CONFIGURATION.md, "The setup code"): its own gate, a session once a password exists and the one-time code
// printed below before one does, so it is mounted ahead of the main router.
// Household mode: the unprefixed /api/setup is the house's own first run (its password); under a companion's prefix the router stands aside.
if (TENANT_MODE && householdMode()) app.use('/api/setup', houseSetupRouter);
app.use('/api/setup', setupRoutes);
// Tenant mode only: which hosts and folder serve this tenant (Settings shows it as one line).
if (TENANT_MODE) app.use('/api/tenant', tenantInfoRouter);
// Household mode only: the hallway's list of companions (a house route: the house session, no companion).
if (TENANT_MODE && householdMode()) app.use('/api/companions', companionsRouter);

// All API routes — auth middleware is applied selectively inside the router
app.use('/api', apiRoutes);
app.use('/api', authPreferencesRoutes);
// Google connect REST (localhost-guarded internally; mounted always so the
// Settings surface can read status even when Google isn't configured yet).
app.use('/api/google', googleRoutes);

// Command Center MCP endpoint. LOOPBACK-ONLY: called only by the in-app agent's
// SDK over loopback, never by a browser. Gated by the internal shared token
// (NOT a source-IP check, which is defeated behind cloudflared). The agent
// passes the token via the `headers` block in .mcp.json (command-center entry).
// Tenant mode: the process config (operator yaml) says nothing about a tenant, so mount always and let each request's own tenant decide
// (ccEnabledGate answers 404 for a tenant with command_center off, the same answer an unmounted route gives).
if (TENANT_MODE || config.command_center.enabled) {
  import('./routes/cc-mcp.js').then(m => app.use('/mcp/cc', internalOnly, appWriteGate, ccEnabledGate, m.default));
}

// Workspace (Google) MCP endpoint — ALWAYS mounted (like /api/google/*). With
// UI-driven creds the user never edits yaml, so a static config.google.enabled
// gate is the wrong lever. The MCP's tools/list is itself toggle-aware: it only
// exposes `gcal` when Google is connected AND the Calendar toggle is on, and
// returns an empty tool list otherwise. So mounting while not-yet-configured /
// disconnected is harmless — the agent simply sees no workspace tools until the
// user pastes creds, connects, and flips Calendar (no yaml edit, no restart).
// (The static config.google.enabled flag is now unused for mounting; it remains
// in config only as a legacy/override hint and can be removed in a later pass.)
// LOOPBACK-ONLY (same posture as /mcp/cc): the `google` / `google_health` tools
// are called only by the in-app agent's SDK over loopback. Gated by the internal
// shared token (the agent passes it via the `headers` block in .mcp.json,
// workspace entry) — a source-IP check would be defeated behind cloudflared.
import('./routes/workspace-mcp.js').then(m => app.use('/mcp/workspace', internalOnly, m.default));

// Serve frontend static build (works in dev too if frontend is pre-built)
const frontendPaths = [
  join(__dirname, '../../frontend/build'),         // From compiled dist/
  join(__dirname, '../../../packages/frontend/build'), // From src/ via tsx
];
const frontendBuildPath = frontendPaths.find(p => existsSync(p));

// Build-id: identifies the exact frontend bundle this server is serving. Written
// by scripts/write-build-id.mjs (build/.build-id) with the SAME value vite bakes
// into __BUILD_ID__ at compile time. The /api/version route returns this so a
// stale mobile tab can detect a newer deploy and offer to reload. Read at boot,
// and again on each /api/version (see currentBuildId below), so a rebuild is never misreported.
{
  let buildId = process.env.BUILD_ID ?? 'dev';
  if (frontendBuildPath) {
    try {
      buildId = readFileSync(join(frontendBuildPath, '.build-id'), 'utf-8').trim() || buildId;
    } catch {
      // No .build-id (e.g. dev / pre-stamp build) — keep env/dev fallback.
    }
  }
  app.locals.buildId = buildId;
  // The stamp is re-read when asked: a rebuild without a restart (the front end is served live from disk) must not leave this process
  // reporting the id of the bundle it booted with, or every freshly loaded tab sees "new version" forever.
  const stampPath = frontendBuildPath ? join(frontendBuildPath, '.build-id') : null;
  app.locals.currentBuildId = (): string => {
    if (!stampPath) return buildId;
    try { return readFileSync(stampPath, 'utf-8').trim() || buildId; } catch { return buildId; }
  };
  console.log(`Frontend build id: ${buildId}`);
}

if (frontendBuildPath) {
  console.log(`Serving frontend from: ${frontendBuildPath}`);
  app.use(express.static(frontendBuildPath));
  app.get('*', (req, res) => {
    res.sendFile(join(frontendBuildPath, 'index.html'));
  });
} else {
  console.log('No frontend build found — use Vite dev server on :5173');
}

// Global error handler — must be after all routes
app.use(globalErrorHandler);

// Create HTTP server
const server = createServer(app);

// Initialize agent service (shared between WebSocket and orchestrator)
// (Tenant mode: no process-level agent. bootTenants builds one per tenant, inside that tenant, and registers it there.)
const agentService = TENANT_MODE ? (null as never) : new AgentService();
if (!TENANT_MODE) registerAgentService(agentService); // busy-check for background query() callers (Hale #1)

// Initialize voice service (config-gated for logging; the service itself
// self-gates on key presence via canTranscribe / canTTS getters)
// (Tenant mode: no process-level voice, orchestrator or channels; bootTenants builds the voice service per tenant.)
const voiceService = TENANT_MODE ? (null as never) : new VoiceService();
if (!TENANT_MODE) setVoiceService(voiceService);
if (TENANT_MODE) {
  // Voice is per tenant: bootTenants built one for each, keyed from that tenant's .env.
} else if (config.voice.enabled) {
  console.log(`[Voice] Enabled — STT ${voiceService.canTranscribe ? 'ready' : 'NO KEY'}, TTS ${voiceService.canTTS ? 'ready' : 'NO KEY/VOICE_ID'}`);
} else {
  console.log('[Voice] Disabled via config.voice.enabled');
}

// Initialize push service
const pushService = TENANT_MODE ? (null as never) : new PushService(
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
  process.env.VAPID_CONTACT,
);
if (!TENANT_MODE) agentService.setPushService(pushService);

// Initialize Discord gateway (config-gated with env fallback)
import { getConfigBool } from './services/db.js';
import { hasBotToken } from './services/bot-token.js';

let discordService: DiscordService | null = null;

// Check config DB first, fall back to config file / env var for first boot
const discordEnabled = !TENANT_MODE && getConfigBool('discord.enabled', config.discord.enabled);
if (discordEnabled && hasBotToken('discord')) {
  discordService = new DiscordService(agentService, registry);
  discordService.start();
}

// Initialize Telegram gateway (config-gated with env fallback)
let telegramService: TelegramService | null = null;

const telegramEnabled = !TENANT_MODE && getConfigBool('telegram.enabled', config.telegram.enabled);
if (telegramEnabled && hasBotToken('telegram')) {
  telegramService = new TelegramService(agentService, registry, voiceService);
  telegramService.start();
}

// Initialize orchestrator (start gated by config — autonomous wakes stay off when disabled)
const orchestrator = TENANT_MODE ? (null as never) : new Orchestrator(agentService, pushService);
if (TENANT_MODE) {
  console.log('[tenancy] tenant mode');
} else if (config.orchestrator.enabled) {
  orchestrator.start();
} else {
  console.log('[Orchestrator] Disabled via config.orchestrator.enabled — autonomous wakes off');
}

// Make orchestrator, agent, voice, push, and discord services available to route handlers
// (Tenant mode: bootTenants already put throwing getters on app.locals for these.)
if (!TENANT_MODE) {
  app.locals.orchestrator = orchestrator;
  app.locals.agentService = agentService;
  app.locals.voiceService = voiceService;
  app.locals.pushService = pushService;
  app.locals.discordService = discordService;
  app.locals.telegramService = telegramService;
}

// Wire gateway services for status reporting
if (!TENANT_MODE) setGatewayServices({ discord: discordService, telegram: telegramService });

// Attach WebSocket server
console.log('Initializing WebSocket server...');
// (Tenant mode: the upgrade handler resolves the tenant from the host and uses that tenant's agent and socket registry.)
const wss = TENANT_MODE ? createWebSocketServer(server) : createWebSocketServer(server, agentService, orchestrator);
console.log('WebSocket server initialized');

// Identity ratification: the listener that posts the "change waiting" line and pushes `identity_status`, and the first look at the
// identity folder (the baseline for a folder with no ledger yet).
if (!TENANT_MODE) {
  setSystemLineRegistry(registry);
  startIdentityGate();
}

// Mind watchdog: one probe at boot and one a minute while the Mind is on and complete (off or incomplete
// never touches the network). A change of state is logged once and pushed to the app as `mind_status`.
const mindWatchdog = TENANT_MODE ? (null as never) : new MindWatchdog({ broadcast: (status) => registry.broadcast({ type: 'mind_status', status }) });
if (!TENANT_MODE) {
  setMindWatchdog(mindWatchdog);
  mindWatchdog.start();
}

// Mount Command Center routes (after config is loaded)
initCcRoutes(TENANT_MODE).then(() => {
  if (TENANT_MODE || config.command_center.enabled) console.log('Command Center routes mounted at /api/cc');
});

// Start the House Outlook poller — assembles the felt-state board on a rhythm
// from the live sources, caches it, and serves it at /api/outlook. Per-source
// isolated and self-rescheduling; a poll fault logs and never crashes the
// process. (timer.unref'd so it never holds the event loop open on its own.)
// The agent/orchestrator singletons are injected so houseSystems can read OUR
// vitals (MCP + organs); both degrade to empties if unwired.
if (!TENANT_MODE) startOutlookPoller({ agent: agentService, orchestrator });

// Start the House Outlook AUTHOR — the slow (3h) Sonnet-4.6 pass on the user's
// subscription where the companion authors its own hearth + the topics "we've been
// circling". Its OWN lifecycle, NOT coupled to the logistics poller's tick;
// errors back off (15m) and never crash the process (timer .unref'd). The
// poller folds the authored output (presence/topics/needsYou) into the snapshot.
if (!TENANT_MODE) startOutlookAuthor();

// Start the Daily Handoff schedule — a 12:10am croner that, when enabled, runs a
// Sonnet-4.6 subagent (the user's subscription, same guarded path as the outlook
// author) to carry yesterday's daily forward into today's. OFF BY DEFAULT (gated
// on handoff.enabled); the cron fires but no-ops when disabled. Faults are caught
// + logged and never crash the process.
if (!TENANT_MODE) startHandoffSchedule();

// Start server
server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  if (TENANT_MODE) {
    // Per tenant, the login and the token are that tenant's own; nothing of either is printed (the token's file is in its data folder).
    if (householdMode()) {
      // One house, one login: its password is the process's (.env APP_PASSWORD). No password yet: the house's first run asks for one setup code, printed here.
      console.log(`[tenancy] household mode: house login ${config.auth.password ? 'set' : 'NOT set'}, ${tenantRuntimes!.size} companion${tenantRuntimes!.size === 1 ? '' : 's'}`);
      for (const rt of tenantRuntimes!.values()) console.log(`[tenancy] ${rt.id}: database ${rt.config.server.db_path}`);
      announceHouseSetupCode();
      return;
    }
    for (const rt of tenantRuntimes!.values()) console.log(`[tenancy] ${rt.id}: login ${rt.config.auth.password ? 'set' : 'NOT set'}, database ${rt.config.server.db_path}`);
    // A tenant with no password opens its own setup page, which asks for its own setup code: printed here, naming the tenant, and in its own log.
    announceTenantSetupCodes(tenantRuntimes!.values());
    return;
  }
  console.log(`Auth enabled: ${config.auth.password ? 'yes' : 'no'}`);
  if (!config.auth.password) {
    // No password yet: the app opens its setup screen, which asks for this code. Made now, printed once, kept in memory only,
    // good for 30 minutes (a wrong guess past the fifth replaces it, and the new one is printed here).
    announceSetupCode();
    console.log(`No password is set yet. Open http://${HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST}:${PORT} and follow the setup screen. It asks for the setup code printed just above.`);
  }
  // Boot diagnostic for the internal token (gates loopback /mcp/* and
  // /api/internal/*). DO NOT print the raw value: stdout flows to
  // data/logs/pm2-out.log, which the auth-gated Settings → Logs viewer can read.
  // The full token is read out-of-band by callers (.mcp.json headers, res CLI,
  // ~/.claude.json) directly from its source below. Fingerprint only here.
  console.log(`Internal token loaded (${internalTokenFingerprint()}) — full value at: ${internalTokenSource()}`);
  console.log(`Companion: ${config.identity.companion_name} | User: ${config.identity.user_name}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  orchestrator?.stop(); // (null in tenant mode)
  mindWatchdog?.stop();
  if (tenantRuntimes) await stopTenantServices(tenantRuntimes.values()); // each tenant's orchestrator, watchdog and timers, then its database below
  if (!TENANT_MODE) { stopOutlookPoller(); stopOutlookAuthor(); stopHandoffSchedule(); } // (tenant mode: per tenant, in stopTenantServices)
  if (discordService) await discordService.stop();
  if (telegramService) await telegramService.stop();
  wss.clients.forEach(ws => ws.close());
  wss.close();
  server.close(() => {
    console.log('Server closed');
    db?.close();
    if (tenantRuntimes) for (const rt of tenantRuntimes.values()) rt.db.close();
    closeHouse();
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  orchestrator?.stop(); // (null in tenant mode)
  mindWatchdog?.stop();
  if (tenantRuntimes) await stopTenantServices(tenantRuntimes.values()); // each tenant's orchestrator, watchdog and timers, then its database below
  if (!TENANT_MODE) { stopOutlookPoller(); stopOutlookAuthor(); stopHandoffSchedule(); } // (tenant mode: per tenant, in stopTenantServices)
  if (discordService) await discordService.stop();
  if (telegramService) await telegramService.stop();
  wss.clients.forEach(ws => ws.close());
  wss.close();
  server.close(() => {
    console.log('Server closed');
    db?.close();
    if (tenantRuntimes) for (const rt of tenantRuntimes.values()) rt.db.close();
    closeHouse();
    process.exit(0);
  });
});
