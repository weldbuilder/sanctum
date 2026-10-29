import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSkinsCss } from '../src/theme/skins-css';

const out = fileURLToPath(new URL('../src/theme/skins.generated.css', import.meta.url));
writeFileSync(out, buildSkinsCss());
console.log('wrote', out);
