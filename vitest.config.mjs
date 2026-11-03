import { fileURLToPath } from 'node:url';
import { defineConfig, configDefaults } from 'vitest/config';
export default defineConfig({
  test: {
    setupFiles: [fileURLToPath(new URL('./vitest.setup.mjs', import.meta.url))],
    // Agent worktrees live under .claude/worktrees; a local `npm test` must never collect their suites.
    exclude: [...configDefaults.exclude, '**/.claude/**', '**/.update-stage/**', '**/.update-rollback/**'],
  },
});
