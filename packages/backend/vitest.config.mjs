// Same setup as the root config, for `vitest` run from inside this workspace.
import { fileURLToPath } from 'node:url';
import { defineConfig, configDefaults } from 'vitest/config';
export default defineConfig({
  test: {
    setupFiles: [fileURLToPath(new URL('../../vitest.setup.mjs', import.meta.url))],
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
