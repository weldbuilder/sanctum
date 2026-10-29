// What the "nothing outside services/discord reads the public transcript" test looks for. Pure, so the matcher itself is tested.

import { relative, isAbsolute, sep, join } from 'node:path';

/** True when `file` is inside `<servicesDir>/discord/`. A sibling that merely starts with "discord"
 *  (`services/discord-zz.ts`, `services/discord.ts`) is NOT inside it, so it is scanned. */
export function isInsideDiscordFolder(file: string, servicesDir: string): boolean {
  const r = relative(join(servicesDir, 'discord'), file);
  return r !== '' && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r);
}

/** Text that reaches the public transcript: the module, the data path written out, or the path built from its parts
 *  (`join(dir, 'discord', 'public')`, `[a, 'discord', 'public'].join('/')`, with any quotes and across lines). */
export function touchesPublicTranscript(code: string): boolean {
  return /public-transcript/.test(code)
    || /discord\/public/.test(code)
    || /(['"`])discord\1\s*,\s*(['"`])public\2/.test(code);
}
