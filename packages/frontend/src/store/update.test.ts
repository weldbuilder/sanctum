import { describe, it, expect, vi, afterEach } from 'vitest';
import { _resetCheckedDone, barModel, canSelfUpdate, dialogBody, failureDetail, shouldReload, useUpdateStore, type UpdateJob, type UpdateSnapshot } from './update';

const job = (state: UpdateJob['state'], extra: Partial<UpdateJob> = {}): UpdateJob => ({
  id: 'j1', kind: 'update', state, from: '1.3.0', to: null, started_at: '2026-11-03T10:00:00Z', finished_at: null, error: null, dirty: null, restart_pending: false, log: [], ...extra,
});
const snap = (extra: Partial<UpdateSnapshot> = {}): UpdateSnapshot => ({
  version: '1.3.0', latest: '1.4.0', update_available: true, repo: 'echo/sanctum', branch: 'main', checked_at: null,
  self_update: { ok: true, mode: 'git' }, restart_mode: 'respawn', household: false, companions: 1, job: null,
  rollback: { available: false, version: null, created_at: null }, ...extra,
});

describe('the update bar', () => {
  it('is hidden with no status, or no update', () => {
    expect(barModel(null, null).phase).toBe('hidden');
    expect(barModel(snap({ update_available: false }), null).phase).toBe('hidden');
  });
  it('offers "Update and restart" with the version', () => {
    expect(barModel(snap(), null)).toMatchObject({ phase: 'offer', text: 'Sanctum 1.4.0 is out.', dismissible: true });
  });
  it('stays closed for the version the person dismissed this session, and comes back for a newer one', () => {
    expect(barModel(snap(), '1.4.0').phase).toBe('hidden');
    expect(barModel(snap({ latest: '1.5.0' }), '1.4.0').phase).toBe('offer');
  });
  it('shows the state and the last log line while a job runs, and cannot be dismissed', () => {
    const m = barModel(snap({ job: job('building', { to: '1.4.0', log: [{ t: 'a', line: 'npm ci' }, { t: 'b', line: 'npm run build' }] }) }), '1.4.0');
    expect(m).toEqual({ phase: 'progress', text: 'Updating to 1.4.0: building', detail: 'npm run build', dismissible: false });
  });
  it('says Restarting while the app is down for the restart', () => {
    expect(barModel(snap({ job: job('restarting') }), null).text).toBe('Updating to 1.4.0: restarting');
    expect(barModel(null, null, true)).toMatchObject({ phase: 'progress', text: 'Restarting' });
  });
  it('says a roll back is a roll back', () => {
    expect(barModel(snap({ job: job('installing', { kind: 'rollback' }) }), null).text).toBe('Rolling back: installing');
  });
  it('shows a failure with its first line, until dismissed', () => {
    const failed = snap({ update_available: false, job: job('failed', { error: 'This folder has local changes\n?? notes.txt', dirty: ['?? notes.txt'] }) });
    expect(barModel(failed, null)).toMatchObject({ phase: 'failed', detail: 'This folder has local changes' });
    expect(barModel(failed, 'job:j1').phase).toBe('hidden');
  });
  it('asks for a manual restart when the update installed but the restart did not happen', () => {
    expect(barModel(snap({ update_available: false, job: job('done', { to: '1.4.0', restart_pending: true }) }), null))
      .toMatchObject({ phase: 'finished', text: '1.4.0 is installed. Restart the app to finish.' });
  });
  it('falls back to plain text when the platform cannot update itself', () => {
    const m = barModel(snap({ self_update: { ok: false, mode: 'git', reason: 'This folder is a git checkout and git is not installed here.' } }), null);
    expect(m.phase).toBe('fallback');
    expect(m.detail).toContain('git is not installed');
    expect(m.detail).toContain('npm run update');
  });
});

describe('reload after the restart', () => {
  it('only when the server serves another build than this page was built as', () => {
    expect(shouldReload('abc-1', 'abc-2')).toBe(true);
    expect(shouldReload('abc-1', 'abc-1')).toBe(false);
    expect(shouldReload('abc-1', undefined)).toBe(false);
    expect(shouldReload('dev', 'abc-2')).toBe(false);
  });
});

describe('the dialog says what happens', () => {
  it('names the restart, and every companion in household mode', () => {
    expect(dialogBody('update', snap())).toMatch(/The app restarts\. /);
    expect(dialogBody('update', snap())).toContain('roll back');
    expect(dialogBody('update', snap({ household: true, companions: 3 }))).toContain('every companion in the house (3)');
    expect(dialogBody('rollback', snap())).toContain('kept before the last update');
  });
});

describe('dev-open: no password set', () => {
  it('shows the terminal fallback instead of the dialog, with the one-line reason', () => {
    const open = snap({ password_set: false });
    expect(canSelfUpdate(open)).toBe(false);
    expect(barModel(open, null)).toMatchObject({ phase: 'fallback', detail: 'Set a password, or run npm run update' });
    expect(canSelfUpdate(snap({ password_set: true }))).toBe(true);
    expect(barModel(snap({ password_set: true }), null).phase).toBe('offer');
  });
});

describe('a failure names the failing step\'s last output', () => {
  it('first line plus the last line of the excerpt; a dirty-tree list stays as the first line only', () => {
    expect(failureDetail(job('failed', { error: 'npm run build failed (exit 1):\nTS2304: cannot find name x\nFound 1 error' }))).toBe('npm run build failed (exit 1): Found 1 error');
    expect(failureDetail(job('failed', { error: 'This folder has local changes\n?? notes.txt', dirty: ['?? notes.txt'] }))).toBe('This folder has local changes');
  });
});

describe('after a finished update the page checks /api/version, whether or not it saw "restarting"', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { vi.unstubAllGlobals(); globalThis.fetch = realFetch; _resetCheckedDone(); useUpdateStore.setState({ snapshot: null, waiting: false }); });

  it('reloads on a new build id, once per finished job', async () => {
    const reload = vi.fn();
    vi.stubGlobal('window', { location: { reload } });
    vi.stubGlobal('__BUILD_ID__', 'old-1');
    let build = 'new-2';
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      if (url.includes('/api/version')) return { ok: true, json: async () => ({ buildId: build }) };
      return { ok: true, status: 200, json: async () => snap({ update_available: false, job: job('done', { to: '1.4.0' }) }) };
    });
    vi.useFakeTimers();
    try {
      await useUpdateStore.getState().refresh(); // the status says done; this page never saw restarting
      expect(useUpdateStore.getState().waiting).toBe(true);
      await vi.advanceTimersByTimeAsync(1600);
      expect(urls.some((u) => u.includes('/api/version'))).toBe(true);
      expect(reload).toHaveBeenCalledTimes(1);
      // the same build id: no reload, and the same job is not checked again
      reload.mockClear(); build = 'old-1';
      useUpdateStore.setState({ waiting: false });
      await useUpdateStore.getState().refresh();
      await vi.advanceTimersByTimeAsync(1000);
      expect(reload).not.toHaveBeenCalled();
      expect(useUpdateStore.getState().waiting).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});
