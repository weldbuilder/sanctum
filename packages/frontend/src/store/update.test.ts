import { describe, it, expect } from 'vitest';
import { barModel, dialogBody, shouldReload, type UpdateJob, type UpdateSnapshot } from './update';

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
    const failed = snap({ update_available: false, job: job('failed', { error: 'This folder has local changes\n?? notes.txt' }) });
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
