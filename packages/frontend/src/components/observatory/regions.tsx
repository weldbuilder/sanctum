/**
 * Region browsers — one component per mind region, Hearth grammar:
 * mono where data, serif where prose. All READ-ONLY (v1 doctrine — no
 * delete/edit/ack anywhere; instruments, not a scalpel).
 *
 * Honesty rules:
 *  - Filters exist ONLY where the upstream supports the param (READ-API MAP);
 *    no fake client-side search over partial pages. Client-side paging is
 *    used only where the upstream returns the COMPLETE set (entities, compass,
 *    spine) — paging over full data is presentation, not fabrication.
 *  - Every region carries its read stamp; unreachable renders as words.
 */
import React, { useMemo, useState } from 'react';
import {
  fetchObservatory,
  type ObsEntity,
  type ObsObservation,
  type ObsThread,
  type CompassResponse,
  type SpineResponse,
  type SpineEntry,
  type JournalEntry,
  type WeatherTrendResponse,
  type DreamLastResponse,
  type PatternsResponse,
  type Telemetry,
} from '../../store/observatory';
import { useMindStore } from '../../store/mind';
import {
  Panel,
  Pager,
  ProseCell,
  Unreachable,
  QuietNote,
  LoadingPulse,
  ageOf,
  useObsData,
} from './primitives';

const PAGE = 50;

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso).slice(0, 10);
  return new Date(t).toISOString().slice(0, 10);
}

// ─── entities · people · nodes ──────────────────────────────────────────────
// Upstream dumps the whole table (no pagination param exists); type/context
// are real upstream filters. Paging here is client-side over the FULL set.

export function EntitiesRegion() {
  const [type, setType] = useState('');
  const [context, setContext] = useState('');
  const [applied, setApplied] = useState({ type: '', context: '' });
  const [offset, setOffset] = useState(0);

  const { data, at, error, loading, refetch } = useObsData<ObsEntity[]>(
    () => fetchObservatory<ObsEntity[]>('/entities', {
      type: applied.type || undefined,
      context: applied.context || undefined,
    }),
    [applied.type, applied.context],
  );

  const rows = useMemo(() => {
    const all = Array.isArray(data) ? [...data] : [];
    all.sort((a, b) => (b.observation_count ?? 0) - (a.observation_count ?? 0));
    return all;
  }, [data]);

  const pageRows = rows.slice(offset, offset + PAGE);

  return (
    <Panel label="entities · people · nodes" age={ageOf(at)} onRefetch={refetch}>
      <form
        className="ob-filters"
        onSubmit={e => { e.preventDefault(); setOffset(0); setApplied({ type, context }); }}
      >
        <input className="ob-filter-input" placeholder="type (person / node / …)" value={type} onChange={e => setType(e.target.value)} />
        <input className="ob-filter-input" placeholder="context" value={context} onChange={e => setContext(e.target.value)} />
        <button type="submit" className="ob-page-btn">filter</button>
      </form>
      {loading ? <LoadingPulse /> : error ? <Unreachable error={error} /> : (
        <>
          {rows.length === 0 ? <QuietNote>no entities match.</QuietNote> : (
            <div className="ob-table-wrap">
              <table className="ob-table">
                <thead>
                  <tr><th>id</th><th>name</th><th>type</th><th>context</th><th>salience</th><th>obs</th><th>updated</th></tr>
                </thead>
                <tbody>
                  {pageRows.map(e => (
                    <tr key={e.id}>
                      <td className="ob-num">{e.id}</td>
                      <td>{e.name}</td>
                      <td>{e.entity_type}</td>
                      <td>{e.primary_context ?? '—'}</td>
                      <td>{e.salience ?? '—'}</td>
                      <td>{e.observation_count}</td>
                      <td>{fmtDate(e.updated_at ?? e.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager offset={offset} limit={PAGE} count={pageRows.length} total={rows.length} onPage={setOffset} />
        </>
      )}
    </Panel>
  );
}

// ─── observations ───────────────────────────────────────────────────────────
// Real upstream pagination (?limit&offset) + real filters (entity_id, weight,
// charge). Supersede chains rendered VISIBLE: superseded_by / supersedes chips
// link to an inline read-only peek of the other end (poison-hunting needs the
// chains on the surface, not in a tooltip).

function ObsPeek({ id, onClose }: { id: number; onClose: () => void }) {
  const { data, error, loading } = useObsData<ObsObservation>(
    () => fetchObservatory<ObsObservation>(`/observations/${id}`),
    [id],
  );
  return (
    <div className="ob-peek">
      <div className="ob-peek-head">
        <span className="ob-eyebrow">observation #{id}</span>
        <button type="button" className="ob-refetch" onClick={onClose}>close</button>
      </div>
      {loading ? <LoadingPulse /> : error ? <Unreachable error={error} /> : data ? (
        <>
          <div className="ob-prose">{data.content}</div>
          <div className="ob-peek-meta">
            {data.entity_name && <span className="ob-chip">{data.entity_name}</span>}
            {data.weight && <span className="ob-chip">{data.weight}</span>}
            {data.charge && <span className="ob-chip">{data.charge}</span>}
            <span className="ob-chip">{fmtDate(data.added_at)}</span>
            {data.archived_at && <span className="ob-chip ob-chip-warn">archived {fmtDate(data.archived_at)}</span>}
            {data.superseded_by != null && <span className="ob-chip ob-chip-warn">superseded by #{data.superseded_by}</span>}
            {data.supersedes != null && <span className="ob-chip">supersedes #{data.supersedes}</span>}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function ObservationsRegion() {
  const [entityId, setEntityId] = useState('');
  const [weight, setWeight] = useState('');
  const [charge, setCharge] = useState('');
  const [applied, setApplied] = useState({ entityId: '', weight: '', charge: '' });
  const [offset, setOffset] = useState(0);
  const [peek, setPeek] = useState<number | null>(null);

  const { data, at, error, loading, refetch } = useObsData<ObsObservation[]>(
    () => fetchObservatory<ObsObservation[]>('/observations', {
      entity_id: applied.entityId || undefined,
      weight: applied.weight || undefined,
      charge: applied.charge || undefined,
      limit: PAGE,
      offset,
    }),
    [applied.entityId, applied.weight, applied.charge, offset],
  );

  const rows = Array.isArray(data) ? data : [];
  // Reverse markers computed over the loaded page (honest scope); the
  // superseded_by/supersedes columns themselves come straight from the rows.
  const idsOnPage = useMemo(() => new Set(rows.map(r => r.id)), [rows]);

  return (
    <Panel label="observations" age={ageOf(at)} onRefetch={refetch}>
      <form
        className="ob-filters"
        onSubmit={e => { e.preventDefault(); setOffset(0); setApplied({ entityId, weight, charge }); }}
      >
        <input className="ob-filter-input" placeholder="entity id" value={entityId} onChange={e => setEntityId(e.target.value)} inputMode="numeric" />
        <input className="ob-filter-input" placeholder="weight" value={weight} onChange={e => setWeight(e.target.value)} />
        <input className="ob-filter-input" placeholder="charge" value={charge} onChange={e => setCharge(e.target.value)} />
        <button type="submit" className="ob-page-btn">filter</button>
      </form>
      {peek !== null && <ObsPeek id={peek} onClose={() => setPeek(null)} />}
      {loading ? <LoadingPulse /> : error ? <Unreachable error={error} /> : (
        <>
          {rows.length === 0 ? <QuietNote>no observations on this page.</QuietNote> : (
            <div className="ob-table-wrap">
              <table className="ob-table">
                <thead>
                  <tr><th>id</th><th>content</th><th>entity</th><th>weight</th><th>context</th><th>date</th><th>chain</th></tr>
                </thead>
                <tbody>
                  {rows.map(o => (
                    <tr key={o.id} className={o.archived_at ? 'archived' : undefined}>
                      <td className="ob-num">{o.id}</td>
                      <td style={{ minWidth: '16rem' }}><ProseCell text={o.content} /></td>
                      <td>{o.entity_name ?? '—'}</td>
                      <td>{o.weight ?? '—'}{o.charge ? ` · ${o.charge}` : ''}</td>
                      <td>{o.context ?? '—'}</td>
                      <td>{fmtDate(o.added_at)}</td>
                      <td>
                        <span style={{ display: 'inline-flex', gap: '0.3rem', flexWrap: 'wrap' }}>
                          {o.superseded_by != null && (
                            <button type="button" className="ob-chip ob-chip-link" onClick={() => setPeek(o.superseded_by!)}>
                              → superseded by #{o.superseded_by}{idsOnPage.has(o.superseded_by) ? ' (on page)' : ''}
                            </button>
                          )}
                          {o.supersedes != null && (
                            <button type="button" className="ob-chip ob-chip-link" onClick={() => setPeek(o.supersedes!)}>
                              ↰ supersedes #{o.supersedes}{idsOnPage.has(o.supersedes) ? ' (on page)' : ''}
                            </button>
                          )}
                          {o.archived_at && <span className="ob-chip ob-chip-warn">archived</span>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager offset={offset} limit={PAGE} count={rows.length} onPage={setOffset} />
        </>
      )}
    </Panel>
  );
}

// ─── threads ────────────────────────────────────────────────────────────────
// ?status= is the real upstream filter. Age tier follows the mind's own
// tiering (fresh <14d / stale 14–30d / graveyard 30d+ on last touch).

function threadTier(t: ObsThread): 'fresh' | 'stale' | 'graveyard' {
  const touch = Date.parse(String(t.updated_at ?? t.created_at));
  if (!Number.isFinite(touch)) return 'graveyard';
  const days = (Date.now() - touch) / 86_400_000;
  return days < 14 ? 'fresh' : days < 30 ? 'stale' : 'graveyard';
}

export function ThreadsRegion() {
  const [status, setStatus] = useState('active');
  const [offset, setOffset] = useState(0);

  const { data, at, error, loading, refetch } = useObsData<ObsThread[]>(
    () => fetchObservatory<ObsThread[]>('/active/threads', {
      status: status === 'all' ? undefined : status,
    }),
    [status],
  );

  const rows = Array.isArray(data) ? data : [];
  const pageRows = rows.slice(offset, offset + PAGE);

  return (
    <Panel label="threads" age={ageOf(at)} onRefetch={refetch}>
      <div className="ob-filters">
        <select className="ob-filter-select" value={status} onChange={e => { setOffset(0); setStatus(e.target.value); }}>
          <option value="active">active</option>
          <option value="resolved">resolved</option>
          <option value="all">all</option>
        </select>
      </div>
      {loading ? <LoadingPulse /> : error ? <Unreachable error={error} /> : (
        <>
          {rows.length === 0 ? <QuietNote>no threads with this status.</QuietNote> : (
            <div className="ob-table-wrap">
              <table className="ob-table">
                <thead>
                  <tr><th>id</th><th>content</th><th>type</th><th>priority</th><th>state</th><th>tier</th><th>opened</th></tr>
                </thead>
                <tbody>
                  {pageRows.map(t => {
                    const tier = threadTier(t);
                    return (
                      <tr key={t.id}>
                        <td className="ob-num">{t.id}</td>
                        <td style={{ minWidth: '16rem' }}><ProseCell text={t.content} /></td>
                        <td>{t.thread_type ?? '—'}</td>
                        <td>{t.priority ?? '—'}</td>
                        <td>{t.status}{t.resolved_at ? ` ${fmtDate(t.resolved_at)}` : ''}</td>
                        <td>
                          <span className={`ob-chip${tier === 'graveyard' ? ' ob-chip-warn' : ''}`}>{tier}</span>
                        </td>
                        <td>{fmtDate(t.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Pager offset={offset} limit={PAGE} count={pageRows.length} total={rows.length} onPage={setOffset} />
        </>
      )}
    </Panel>
  );
}

// ─── compass ────────────────────────────────────────────────────────────────
// Full list ({count, rows}) with per-row provenance counts (asserted_count)
// and the mind's own freshness bucket. Edges total (compass_provenance) rides
// in from telemetry when the caller has it.

export function CompassRegion({ telemetry }: { telemetry: Telemetry | null }) {
  const { data, at, error, loading, refetch } = useObsData<CompassResponse>(
    () => fetchObservatory<CompassResponse>('/compass'),
  );

  const rows = data?.rows ?? [];
  const edges = telemetry?.compass?.edges;

  return (
    <Panel
      label="compass"
      age={ageOf(at)}
      onRefetch={refetch}
      extra={typeof edges === 'number' ? <span className="ob-age">{edges} provenance edges</span> : undefined}
    >
      {loading ? <LoadingPulse /> : error ? <Unreachable error={error} /> : (
        rows.length === 0 ? <QuietNote>the compass has no rows.</QuietNote> : (
          <div className="ob-table-wrap">
            <table className="ob-table">
              <thead>
                <tr><th>kind</th><th>content</th><th>weight</th><th>asserted</th><th>freshness</th><th>last asserted</th></tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}>
                    <td>{r.kind}</td>
                    <td style={{ minWidth: '16rem' }}><ProseCell text={r.content} /></td>
                    <td>{r.weight ?? '—'}</td>
                    <td>×{r.asserted_count ?? 0}</td>
                    <td>
                      <span className={`ob-chip${r.freshness === 'unexercised' ? ' ob-chip-warn' : ''}`}>{r.freshness}</span>
                    </td>
                    <td>{fmtDate(r.last_asserted_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </Panel>
  );
}

// ─── spine ──────────────────────────────────────────────────────────────────

export function SpineRegion() {
  const { data, at, error, loading, refetch } = useObsData<SpineResponse>(
    () => fetchObservatory<SpineResponse>('/spine'),
  );

  const groups = useMemo(() => {
    const entries: SpineEntry[] = Array.isArray(data?.entries) ? data.entries : [];
    const byRoot = new Map<string, SpineEntry[]>();
    for (const e of entries) {
      const root = String(e.section ?? '').split('.')[0] || '(unrooted)';
      const list = byRoot.get(root) ?? [];
      list.push(e);
      byRoot.set(root, list);
    }
    return [...byRoot.entries()];
  }, [data]);

  return (
    <Panel label="spine" age={ageOf(at)} onRefetch={refetch}>
      {loading ? <LoadingPulse /> : error ? <Unreachable error={error} /> : (
        groups.length === 0 ? <QuietNote>the spine has no entries.</QuietNote> : (
          groups.map(([root, entries]) => (
            <div key={root} style={{ marginBottom: '1rem' }}>
              <div className="ob-eyebrow" style={{ marginBottom: '0.4rem' }}>{root} · {entries.length}</div>
              <div className="ob-table-wrap">
                <table className="ob-table">
                  <tbody>
                    {entries.map(e => (
                      <tr key={e.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{e.section}</td>
                        <td style={{ minWidth: '16rem' }}><ProseCell text={e.content} /></td>
                        <td>{e.weight ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        )
      )}
    </Panel>
  );
}

// ─── episodes · journal ─────────────────────────────────────────────────────

export function JournalsRegion() {
  const { data, at, error, loading, refetch } = useObsData<JournalEntry[]>(
    () => fetchObservatory<JournalEntry[]>('/episodes/journals'),
  );
  const rows = Array.isArray(data) ? data : [];
  const [offset, setOffset] = useState(0);
  const pageRows = rows.slice(offset, offset + 20);

  return (
    <Panel label="episodes · journal" age={ageOf(at)} onRefetch={refetch}>
      {loading ? <LoadingPulse /> : error ? <Unreachable error={error} /> : (
        <>
          {rows.length === 0 ? <QuietNote>no journal entries.</QuietNote> : (
            <div className="ob-journal-list">
              {pageRows.map(j => (
                <div className="ob-journal" key={j.id}>
                  <div className="ob-journal-head">
                    <span className="ob-chip">{j.entry_date}</span>
                    {j.emotion && <span className="ob-chip">{j.emotion}</span>}
                    {j.tags && <span className="ob-chip">{j.tags}</span>}
                  </div>
                  <ProseCell text={j.content} max={280} />
                </div>
              ))}
            </div>
          )}
          <Pager offset={offset} limit={20} count={pageRows.length} total={rows.length} onPage={setOffset} />
          {rows.length >= 100 && <QuietNote>the mind returns its latest 100 entries — the deeper past isn't listable from here.</QuietNote>}
          <style>{`
            .ob-journal-list { display: flex; flex-direction: column; gap: 0.9rem; }
            .ob-journal-head { display: flex; gap: 0.4rem; margin-bottom: 0.3rem; flex-wrap: wrap; }
          `}</style>
        </>
      )}
    </Panel>
  );
}

// ─── weather · mood history ─────────────────────────────────────────────────

export function WeatherRegion() {
  const [days, setDays] = useState(30);
  const { data, at, error, loading, refetch } = useObsData<WeatherTrendResponse>(
    () => fetchObservatory<WeatherTrendResponse>('/weather/trend', { days }),
    [days],
  );
  const now = useMindStore(s => s.data?.weather ?? null);
  const trend = Array.isArray(data?.trend) ? data.trend : [];

  return (
    <Panel label="weather · mood history" age={ageOf(at)} onRefetch={refetch}>
      {now && (now.texture || now.dominant) && (
        <div style={{ marginBottom: '0.8rem' }}>
          <span className="ob-prose" style={{ fontStyle: 'italic', fontSize: '1.05rem' }}>
            now — {now.texture ?? now.dominant}
          </span>
        </div>
      )}
      <div className="ob-filters">
        <select className="ob-filter-select" value={days} onChange={e => setDays(Number(e.target.value))}>
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
        </select>
      </div>
      {loading ? <LoadingPulse /> : error ? <Unreachable error={error} /> : (
        trend.length === 0 ? <QuietNote>no mood readings in this window.</QuietNote> : (
          <div className="ob-table-wrap">
            <table className="ob-table">
              <thead>
                <tr><th>day</th><th>dominant feeling</th><th>intensity</th><th>readings</th></tr>
              </thead>
              <tbody>
                {trend.map(d => (
                  <tr key={d.day}>
                    <td>{d.day}</td>
                    <td><span className="ob-prose" style={{ fontSize: '0.78rem' }}>{d.feeling}</span></td>
                    <td>{d.intensity}</td>
                    <td>{d.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </Panel>
  );
}

// ─── dreams ─────────────────────────────────────────────────────────────────
// The mind's read API keeps no listable dream archive — /dreams/last +
// /dreams/patterns is the whole visible surface. Rendered honestly as such.

export function DreamsRegion() {
  const last = useObsData<DreamLastResponse>(() => fetchObservatory<DreamLastResponse>('/dreams/last'));
  const patterns = useObsData<PatternsResponse>(() => fetchObservatory<PatternsResponse>('/dreams/patterns'));

  const dream = last.data?.dream ?? null;
  const recurrence = dream?.recurrence_count ?? 0;

  return (
    <>
      <Panel label="last dream" age={ageOf(last.at)} onRefetch={last.refetch}>
        {last.loading ? <LoadingPulse /> : last.error ? <Unreachable error={last.error} /> : (
          !dream || !dream.content ? <QuietNote>no dream recorded yet.</QuietNote> : (
            <>
              <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                {dream.dream_date && <span className="ob-chip">{dream.dream_date}</span>}
                {recurrence > 0 && <span className="ob-chip ob-chip-warn">recurring ×{recurrence + 1}</span>}
                {dream.emotional_seed && <span className="ob-chip">seed — {dream.emotional_seed}</span>}
              </div>
              <div className="ob-prose" style={{ whiteSpace: 'pre-wrap', fontStyle: 'italic' }}>{dream.content}</div>
            </>
          )
        )}
        <QuietNote>the mind keeps no listable dream archive via its read API — the last dream and its patterns are the whole visible surface.</QuietNote>
      </Panel>

      <Panel label="patterns · 7 days" age={ageOf(patterns.at)} onRefetch={patterns.refetch}>
        {patterns.loading ? <LoadingPulse /> : patterns.error ? <Unreachable error={patterns.error} /> : patterns.data ? (
          <div className="ob-table-wrap">
            <table className="ob-table">
              <tbody>
                <tr>
                  <td style={{ whiteSpace: 'nowrap' }}>alive</td>
                  <td>{(patterns.data.alive ?? []).map(a => `${a.name} (${a.obs_count})`).join(' · ') || '—'}</td>
                </tr>
                <tr>
                  <td>weights</td>
                  <td>{(patterns.data.weights ?? []).map(w => `${w.weight ?? '∅'} ${w.count}`).join(' · ') || '—'}</td>
                </tr>
                <tr>
                  <td>charges</td>
                  <td>{(patterns.data.charges ?? []).map(c => `${c.charge ?? '∅'} ${c.count}`).join(' · ') || '—'}</td>
                </tr>
                <tr>
                  <td>foundational</td>
                  <td>{(patterns.data.foundational ?? []).map(f => f.name).join(' · ') || '—'}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : null}
      </Panel>
    </>
  );
}

// ─── drives ledger ──────────────────────────────────────────────────────────
// The mind exposes NO read endpoint for drives (only POST /api/drives/env,
// sensorium inbound) — the ledger reaches the house solely through the
// living-surface cache. Rendered from the same /api/mind/surface data the
// /mind room uses, and it says so.

export function DrivesRegion() {
  const data = useMindStore(s => s.data);
  const gauge = data?.surface?.living_surface?.drives;
  const at = data?.surface?.at ?? data?.surface?.processed_at;

  return (
    <Panel label="drives ledger" age={ageOf(at)}>
      {!gauge ? (
        <QuietNote>no drives ledger in the living surface yet.</QuietNote>
      ) : gauge.note ? (
        <QuietNote>{gauge.note}</QuietNote>
      ) : (
        <div className="ob-table-wrap">
          <table className="ob-table">
            <thead>
              <tr><th>drive</th><th>level</th><th>feel</th><th>resting toward</th></tr>
            </thead>
            <tbody>
              {(Array.isArray(gauge.drives) ? gauge.drives : []).map(d => (
                <tr key={d.drive}>
                  <td>{d.display_name}</td>
                  <td>{d.level.toFixed(2)}</td>
                  <td><span className="ob-prose" style={{ fontSize: '0.78rem' }}>{d.feel ?? '—'}</span></td>
                  <td>{d.resting_toward.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <QuietNote>
        the mind's read API exposes no drives endpoint — this ledger arrives through the living-surface cache (same source as /mind).
      </QuietNote>
    </Panel>
  );
}
