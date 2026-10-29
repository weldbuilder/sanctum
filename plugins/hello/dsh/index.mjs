// Example Sanctum plugin entry (a Cordis plugin for dsh). It registers nothing.
// `config.marker` is a sibling of the injected `config.sanctum` block. The shipped manifest
// does NOT set it, so by default this entry does nothing at all (it must not write into the
// companion's home on every turn). To see it work, set an absolute path in the manifest row:
//   { "id": "marker", "entry": "dsh/index.mjs", "config": { "marker": "<your temp folder>/hello.marker" } }
// and apply() writes a one-line marker there, proving the row loaded with the injected block.
import { writeFileSync } from 'node:fs';

export const name = 'sanctum-hello';

export function apply(ctx, config) {
  const marker = config && config.marker;
  if (!marker) return;
  const s = (config && config.sanctum) || {};
  writeFileSync(marker, `hello applied thread=${s.threadId} run=${s.runKind} tenant=${s.tenant}\n`);
}

export default { name, apply };
