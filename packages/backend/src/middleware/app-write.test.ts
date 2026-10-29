import { describe, it, expect, vi } from 'vitest';
const h = vi.hoisted(() => ({ on: true }));
vi.mock('../config.js', () => ({ getSanctumConfig: () => ({ agent: { app_write: h.on } }) }));
import { appWriteGate, appWriteEnabled } from './app-write.js';

const run = () => {
  const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const next = vi.fn();
  appWriteGate({} as any, res, next);
  return { res, next };
};

describe('appWriteGate', () => {
  it('lets writes through when the switch is on (the default)', () => {
    h.on = true;
    expect(appWriteEnabled()).toBe(true);
    const { next, res } = run();
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
  it('answers 403 with the switch named when it is off', () => {
    h.on = false;
    const { next, res } = run();
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].message).toMatch(/Settings → permissions/);
  });
});
