// Runs before every test file. The config loader lets these environment variables win over sanctum.yaml
// (by design), so a developer who has one exported in their shell would otherwise change what the suite
// sees: AGENT_PROVIDER=dsh alone fails ~180 tests. Tests that want one set it themselves.
// This is every AGENT_* and DSH_* variable that config.ts, plugins.ts, plugin-paths.ts, plugin-ratify.ts
// and scripts/setup-lib.mjs read. (TMPDIR is read too, but it is a system variable the tests save and
// set themselves.) MIND_API_KEY is cleared too: it supplies the Mind's bearer when the card has none.
for (const name of ['AGENT_PROVIDER', 'AGENT_CWD', 'AGENT_MODEL', 'DSH_HOME', 'DSH_PERMISSION_MODE', 'DSH_TELEMETRY_MODE', 'MIND_API_KEY']) delete process.env[name];
