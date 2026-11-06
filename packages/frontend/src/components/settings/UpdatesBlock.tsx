import React, { useEffect } from 'react';
import { Eyebrow, Group, FieldRow, Btn } from './primitives';
import { canSelfUpdate, jobActive, selfUpdateWhy, stateWord, useUpdateStore, type UpdateJob } from '../../store/update';

/** The log as the person reads it: time and line, the last few dozen. */
export function logText(job: UpdateJob | null, max = 40): string {
  if (!job) return '';
  return job.log.slice(-max).map(l => `${l.t.slice(11, 19)}  ${l.line}`).join('\n');
}

/** Settings → Status → Updates: the version, Check now, Update and restart, Roll back, and what the last job said. */
export function UpdatesBlock() {
  const snapshot = useUpdateStore(s => s.snapshot);
  const unavailable = useUpdateStore(s => s.unavailable);
  const refresh = useUpdateStore(s => s.refresh);
  const openDialog = useUpdateStore(s => s.openDialog);
  useEffect(() => { void refresh(); }, [refresh]);

  const job = snapshot?.job ?? null;
  const running = jobActive(job);
  const canUpdate = canSelfUpdate(snapshot) && !!snapshot?.update_available && !running;
  return (
    <>
      <Eyebrow label="updates" sub="the app updates itself, keeps a copy to roll back to, and restarts" />
      <Group>
        {unavailable && !snapshot ? (
          <span className="sp-empty-text">
            This address cannot update the app from inside (a host-per-person install has no house to ask). In the app's folder, run <code>npm run update</code>, then restart it.
          </span>
        ) : (
          <>
            <FieldRow label="installed" value={snapshot?.version} mono />
            <FieldRow
              label="newest"
              value={snapshot?.latest}
              mono
              hint={snapshot?.error ? `could not check: ${snapshot.error}` : snapshot?.update_available ? 'a newer version is out' : snapshot?.latest ? 'you have the newest' : undefined}
            />
            {snapshot && !canSelfUpdate(snapshot) && (
              <span className="sp-empty-text">{snapshot.self_update.ok
                ? `${selfUpdateWhy(snapshot)}, then restart the app.`
                : <>{selfUpdateWhy(snapshot)} In the app's folder, run <code>npm run update</code>, then restart it.</>}</span>
            )}
            <div className="sp-btn-row" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
              <Btn variant="muted" onClick={() => void refresh(true)} disabled={running}>Check now</Btn>
              <Btn variant="primary" onClick={() => openDialog('update')} disabled={!canUpdate}>Update and restart</Btn>
              {snapshot?.rollback.available && (
                <Btn variant="muted" onClick={() => openDialog('rollback')} disabled={running}>Roll back to {snapshot.rollback.version}</Btn>
              )}
            </div>
            {snapshot?.household && (
              <span className="sp-empty-text">One update restarts every companion in the house ({snapshot.companions}).</span>
            )}
          </>
        )}
        {job && (
          <>
            <FieldRow
              label={job.kind === 'rollback' ? 'last roll back' : 'last update'}
              value={`${stateWord(job.state)}${job.to ? `, ${job.from} to ${job.to}` : ''}`}
              hint={job.error ?? undefined}
            />
            {job.dirty && job.dirty.length > 0 && <pre className="sp-log" style={{ whiteSpace: 'pre-wrap', fontSize: '0.75rem' }}>{job.dirty.join('\n')}</pre>}
            <pre className="sp-log" style={{ whiteSpace: 'pre-wrap', fontSize: '0.75rem', maxHeight: '16rem', overflow: 'auto' }}>{logText(job)}</pre>
          </>
        )}
      </Group>
    </>
  );
}
