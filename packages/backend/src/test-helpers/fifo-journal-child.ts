// Child process for tenancy/own-files-r7.test.ts (item 1): runs checkIdentity inside a tenant whose journal.jsonl is a FIFO with NO writer. A plain open of that
// path would block this process forever, so the parent runs it with a hard timeout and a hang is a failure. Prints one JSON line: { state, detail }.
import { join } from 'node:path';
import { enableTenancy, runInTenant } from '../tenancy/context.js';
import { fakeRuntime } from '../tenancy/test-runtime.js';
import { checkIdentity } from '../services/identity/ledger.js';

const tenantDir = process.argv[2];
enableTenancy(true);
const rt = fakeRuntime('ada', { dir: tenantDir, dataDir: join(tenantDir, 'data'), homeDir: join(tenantDir, 'home') });
const result = runInTenant(rt, () => checkIdentity(join(tenantDir, 'home'), { ledgerDir: join(tenantDir, 'data', 'identity') }));
console.log(JSON.stringify({ state: result.state, detail: result.detail ?? '' }));
