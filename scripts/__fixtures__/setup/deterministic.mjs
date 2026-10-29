// Preloaded (node --import) by scripts/setup-proof.mjs: crypto.randomBytes returns a fixed counter, so a made-up
// password is the same on every run and can be compared byte for byte.
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
let n = 0;
crypto.randomBytes = (size) => Buffer.from(Array.from({ length: size }, (_v, i) => (i * 7 + 3 + n++ * 0) % 256));
syncBuiltinESMExports();
