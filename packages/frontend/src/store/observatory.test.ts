import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchObservatory, fetchObservatoryHealth, OBSERVATORY_UNAVAILABLE } from './observatory';

afterEach(() => { vi.unstubAllGlobals(); });

describe('the observatory calls have no backend in this version', () => {
  it('fail quietly: no request, a 404-shaped result that says so in one line', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    for (const path of ['/health', '/graph', '/entities', '/observations/3', '/observations', '/active/threads', '/compass', '/spine', '/episodes/journals', '/weather/trend', '/dreams/last', '/dreams/patterns']) {
      expect(await fetchObservatory(path, { days: 7 })).toEqual({ ok: false, error: 'not available in this version', status: 404 });
    }
    expect(await fetchObservatoryHealth()).toMatchObject({ ok: false, error: OBSERVATORY_UNAVAILABLE });
    expect(f).not.toHaveBeenCalled();
  });
});
