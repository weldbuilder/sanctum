// `node dist/boot.js` is kept only for anyone who still launches it: it hands over to the real entry, packages/backend/boot.mjs, which is tracked and lives outside every directory a
// swap moves (this file is inside dist, which a swap renames away and back, so it cannot be the documented entry). See that file for why.
const entry = '../boot.mjs';
await import(entry);
export {};
