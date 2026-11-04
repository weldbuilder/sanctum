import { fileURLToPath } from 'node:url';
import { defineConfig, configDefaults } from 'vitest/config';
export default defineConfig({
  test: {
    // CI runners get starved when two PRs test at once: a test that takes 200 ms alone has hit vitest's 5 s default there. The budget is for the runner, not the test.
    testTimeout: 20_000,
    setupFiles: [fileURLToPath(new URL('./vitest.setup.mjs', import.meta.url))],
    // Agent worktrees live under .claude/worktrees; a local `npm test` must never collect their suites.
    exclude: [...configDefaults.exclude, '**/.claude/**', '**/.update-stage/**', '**/.update-rollback/**', '**/.update-rollback.next/**'],
  },
});
