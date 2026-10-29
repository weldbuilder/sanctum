// No process-level AgentService in tenant mode, and no process AGENT_MODEL read in tenant mode (stage 2b pass 2). Source-level pins: the
// boot-time behaviour (a null agent that nothing may call) cannot be told apart from a built one without a running server.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');
const text = (p: string) => readFileSync(join(SRC, p), 'utf8');

describe('tenant mode builds no process-level agent', () => {
  it('server.ts constructs it only outside tenant mode, and never hands it the push service in tenant mode', () => {
    const s = text('server.ts');
    expect(s).toMatch(/const agentService = TENANT_MODE \? \(null as never\) : new AgentService\(\);/);
    expect(s).toMatch(/if \(!TENANT_MODE\) agentService\.setPushService\(pushService\);/);
    expect(s.match(/new AgentService\(\)/g)).toHaveLength(1);
  });

  it('the per-tenant agent is built in boot, inside runInTenant', () => {
    const b = text('tenancy/boot.ts');
    expect(b).toMatch(/runInTenant\(rt, \(\) => \{[\s\S]*new AgentService\(\)[\s\S]*registerAgentService\(agent\)[\s\S]*startIdentityGate\(\)/);
  });

  it('nothing on a turn path reads the process AGENT_MODEL (envFor answers the tenant\'s own .env)', () => {
    for (const f of ['services/agent.ts', 'services/discord/public-runtime.ts']) {
      expect(text(f), f).not.toMatch(/process\.env\.AGENT_MODEL/);
      expect(text(f), f).toMatch(/envFor\('[^']+'\)\.AGENT_MODEL/);
    }
  });
});
