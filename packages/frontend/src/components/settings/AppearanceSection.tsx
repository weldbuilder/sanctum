/**
 * Appearance section — room, material, readability, and the colour/font editor.
 *
 * Two layers live here:
 *  1. Rooms and materials. A room is the scenery; a material is the whole
 *     palette for every surface that carries text. Picking a room card applies
 *     the room and its suggested material together; the Background and Surface
 *     menus change one at a time. Everything here is a *preview* until
 *     "Apply" — Cancel puts the exact previous appearance back. Extra readable
 *     (solid panels, no textures or ornaments) is part of the same document.
 *  2. The colour and font editor from before. For the Hedgewitch palette it
 *     behaves exactly as it always did (live, debounced save to /api/theme);
 *     under a skin material it edits that material's own customisations, kept
 *     in this browser, and shows what the material really has — not the old
 *     dark default.
 *
 * This panel owns its own opaque colours (--ap-*, declared on its wrapper), so a
 * bad custom colour can break the sample and the rest of the app but never the
 * place you fix it. "Restore readable appearance" is a fixed black-on-cream
 * button that inherits nothing.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Eyebrow, Btn, SaveIndicator, ToggleRow } from './primitives';
import { useThemeStore, THEME_TOKENS, FONT_CHOICES, toHexColor, type ThemeToken } from '../../store/theme';
import { useAppearanceStore } from '../../store/appearance';
import { useIdentity, patchIdentity, uploadAvatar } from '../../store/identity';
import { MATERIAL_LIST, MATERIALS } from '../../theme/materials';
import { ROOMS, ROOM_LIST } from '../../theme/rooms';
import { guardedOverrides } from '../../theme/apply';
import {
  RESTORE_BUTTON, baseTokenValue, panelScopeVars, readabilityIssues, withMaterial, withReadability, withRoom, withRoomPreset, materialAllowedWithRoom,
} from '../../theme/appearance';
import type { AppearanceDoc, MaterialId, RoomId } from '../../theme/types';
import { COMPANION_PREFIX } from '../../lib/base';

/** Rendered stand-in for the Hedgewitch room's preview (decorative; the card's text names it). */
function HedgewitchSwatch() {
  return (
    <span className="ap-swatch" aria-hidden="true">
      <span className="ap-swatch-rail" />
      <span className="ap-swatch-card" />
      <span className="ap-swatch-card user" />
    </span>
  );
}

const BUNDLED_AVATARS = ['01', '02', '03', '04', '05', '06'].map(n => `/avatars/${n}.svg`);
const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml';
const AVATAR_MAX = 2 * 1024 * 1024;

/** The companion's picture: the Sanctum mark by default, six bundled marks, or your own upload. Saved to the companion, not the browser. */
function AvatarChooser() {
  const identity = useIdentity();
  const fileRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const current = identity.avatar_url;
  const isUpload = !!current && current.startsWith(`${COMPANION_PREFIX}/api/identity/avatar/`);

  const choose = async (url: string | null) => {
    setBusy(true);
    setNote((await patchIdentity({ avatar_url: url })) ? '' : 'Could not save that picture.');
    setBusy(false);
  };
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (!AVATAR_ACCEPT.split(',').includes(file.type)) { setNote('Use a png, jpg, webp or svg image.'); return; }
    if (file.size > AVATAR_MAX) { setNote('That image is over 2 MB.'); return; }
    setBusy(true); setNote('');
    const up = await uploadAvatar(file);
    if ('error' in up) setNote(up.error);
    else if (!(await patchIdentity({ avatar_url: up.url }))) setNote('Uploaded, but could not save the choice.');
    setBusy(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const tile = (key: string, label: string, selected: boolean, onClick: () => void, src: string) => (
    <button key={key} type="button" className={`ap-avatar${selected ? ' selected' : ''}`} aria-pressed={selected} aria-label={label} title={label} disabled={busy} onClick={onClick}>
      <img src={src} alt="" width={56} height={56} />
    </button>
  );

  return (
    <>
      <Eyebrow label="picture" sub="shown in chat, home and the menu" />
      <Group>
        <div className="ap-avatars" role="group" aria-label="Companion picture">
          {tile('logo', 'Sanctum mark (default)', !current || current === '/logo.png', () => void choose(null), '/logo.png')}
          {BUNDLED_AVATARS.map((u, i) => tile(u, `Option ${i + 1}`, current === u, () => void choose(u), u))}
          {isUpload && tile('mine', 'Your upload', true, () => undefined, current as string)}
          <button type="button" className="ap-avatar ap-avatar-upload" disabled={busy} onClick={() => fileRef.current?.click()} aria-label="Upload your own picture" title="Upload your own">
            <span aria-hidden="true">+</span><span className="ap-avatar-cap">Upload</span>
          </button>
          <input ref={fileRef} type="file" accept={AVATAR_ACCEPT} hidden onChange={e => void onFile(e.target.files?.[0])} />
        </div>
        <p className="ap-hint" role="status" aria-live="polite">{note || 'png, jpg, webp or svg, up to 2 MB.'}</p>
      </Group>
    </>
  );
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const COLOR_GROUPS: Array<{ label: string; sub?: string; keys: string[] }> = [
  { label: 'backgrounds', keys: ['--bg-primary', '--bg-secondary', '--bg-input'] },
  { label: 'text', keys: ['--text-primary', '--text-secondary', '--text-muted'] },
  { label: 'border', keys: ['--border'] },
  { label: 'companion', sub: 'amber', keys: ['--amber', '--amber-bright'] },
  { label: 'you', sub: 'lavender', keys: ['--lavender', '--lavender-bright'] },
  { label: 'shared & status', keys: ['--gold', '--status-active'] },
];

const FONT_KEYS = ['--font-serif', '--font-body', '--font-mono'] as const;

function tokenByKey(key: string): ThemeToken {
  return THEME_TOKENS.find(t => t.key === key) as ThemeToken;
}

const SAVE_DEBOUNCE_MS = 500;
const STATUS_HOLD_MS = 2200;

export function AppearanceSection() {
  const legacyOverrides = useThemeStore(s => s.overrides);
  const setLegacyToken = useThemeStore(s => s.setToken);
  const saveTheme = useThemeStore(s => s.saveTheme);
  const resetTheme = useThemeStore(s => s.resetTheme);

  const applied = useAppearanceStore(s => s.applied);
  const draft = useAppearanceStore(s => s.draft);
  const persist = useAppearanceStore(s => s.persist);
  const preview = useAppearanceStore(s => s.preview);
  const apply = useAppearanceStore(s => s.apply);
  const cancel = useAppearanceStore(s => s.cancel);
  const setCustom = useAppearanceStore(s => s.setCustom);
  const clearCustom = useAppearanceStore(s => s.clearCustom);
  const resetAppearance = useAppearanceStore(s => s.reset);

  const doc: AppearanceDoc = draft ?? applied;
  const material = doc.materialId;
  const isClassic = material === 'hedgewitch';
  const extra = doc.readability === 'extra';

  const [status, setStatus] = useState<SaveStatus>('idle');
  const [message, setMessage] = useState('');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
  }, []);

  // Leaving the panel with an unapplied preview puts the saved appearance back.
  useEffect(() => () => {
    clearTimers();
    if (useAppearanceStore.getState().draft) useAppearanceStore.getState().cancel();
  }, [clearTimers]);

  const holdStatus = useCallback((ok: boolean) => {
    setStatus(ok ? 'saved' : 'error');
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setStatus('idle'), STATUS_HOLD_MS);
  }, []);

  // Classic palette: every pick applies live at once, the network save waits for a pause.
  const scheduleLegacySave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      setStatus('saving');
      const ok = await saveTheme(useThemeStore.getState().overrides);
      holdStatus(ok);
    }, SAVE_DEBOUNCE_MS);
  }, [saveTheme, holdStatus]);

  // ── room / material / readability: previewed, then applied or cancelled ──
  const change = (next: AppearanceDoc) => { setMessage(''); preview(next); };

  const onApply = () => {
    const saved = apply();
    setMessage(saved ? 'Applied. Saved in this browser.' : 'Applied for now, but this browser would not let it be saved. It will be lost on reload.');
  };
  const onCancel = () => { cancel(); setMessage('Cancelled. Your previous appearance is back.'); };

  const ownOverrides = isClassic ? legacyOverrides : (doc.customByMaterial[material] ?? {});
  const issues = useMemo(() => readabilityIssues(material, ownOverrides), [material, ownOverrides]);
  const held = useMemo(() => guardedOverrides(doc, legacyOverrides).held, [doc, legacyOverrides]);

  const effectiveValue = (key: string): string => ownOverrides[key] ?? baseTokenValue(material, key);

  const handleColorChange = (key: string, hex: string) => {
    if (isClassic) { setLegacyToken(key, hex); scheduleLegacySave(); }
    else setCustom(material, key, hex);
  };
  const handleFontChange = (key: string, value: string) => {
    if (isClassic) { setLegacyToken(key, value); scheduleLegacySave(); }
    else setCustom(material, key, value);
  };

  const restoreReadable = async () => {
    clearTimers();
    if (isClassic) {
      setStatus('saving');
      const ok = await resetTheme();
      holdStatus(ok);
    } else {
      clearCustom(material);
    }
    setMessage('Custom colours removed. This material’s own readable palette is back.');
  };
  const resetEverything = async () => {
    clearTimers();
    setStatus('saving');
    resetAppearance();
    const ok = await resetTheme();
    holdStatus(ok);
    setMessage('Back to the default appearance: Hedgewitch, standard readability, no customisations.');
  };

  const roomDef = ROOMS[doc.roomId];
  const suggested = MATERIALS[roomDef.defaultMaterial];
  const alreadySuggested = doc.materialId === roomDef.defaultMaterial;

  return (
    <div className="appearance-section">
      <div className="ap-safe" style={panelScopeVars(material) as React.CSSProperties}>
        <Eyebrow label="appearance" sub="rooms & materials" />
        <Group>
          <p className="appearance-lead">
            A <strong>room</strong> is the scenery behind the app. A <strong>material</strong> is the
            complete set of colours every panel, message and menu is drawn in. Pick them together
            or separately; nothing changes for good until you apply it.
          </p>
        </Group>

        <AvatarChooser />

        <Eyebrow label="rooms" sub="room + suggested material" />
        <div className="ap-rooms" role="group" aria-label="Rooms">
          {ROOM_LIST.map(r => {
            const selected = doc.roomId === r.id && doc.materialId === r.defaultMaterial;
            return (
              <button
                key={r.id}
                type="button"
                className={`ap-room${selected ? ' selected' : ''}`}
                aria-pressed={selected}
                onClick={() => change(withRoomPreset(doc, r.id))}
              >
                <span className="ap-room-thumb" style={{ background: r.fallback }} aria-hidden="true">
                  {r.thumbnail
                    ? <img src={r.thumbnail} alt="" width={360} height={240} loading="lazy" decoding="async" />
                    : <HedgewitchSwatch />}
                </span>
                <span className="ap-room-name">{r.name}</span>
                <span className="ap-room-sub">{MATERIALS[r.defaultMaterial].label}</span>
                {selected && <span className="ap-room-check">Selected</span>}
              </button>
            );
          })}
        </div>

        <Eyebrow label="background & surface" sub="one at a time" />
        <Group>
          <div className="ap-row">
            <label className="ap-label" htmlFor="ap-room-select">
              <span>Background</span>
              <span className="ap-hint">The room only. Text colours do not change (leaving the Hedgewitch kitchen also leaves its parchment).</span>
            </label>
            <select
              id="ap-room-select"
              className="sp-form-input ap-select"
              value={doc.roomId}
              onChange={e => change(withRoom(doc, e.target.value as RoomId))}
            >
              {ROOM_LIST.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div className="ap-row">
            <label className="ap-label" htmlFor="ap-material-select">
              <span>Surface</span>
              <span className="ap-hint">The whole palette: panels, messages, menus and their text.</span>
            </label>
            <select
              id="ap-material-select"
              className="sp-form-input ap-select"
              value={doc.materialId}
              onChange={e => change(withMaterial(doc, e.target.value as MaterialId))}
            >
              {MATERIAL_LIST.filter(m => materialAllowedWithRoom(doc.roomId, m.id)).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>
          <div className="ap-row ap-row-action">
            <button type="button" className="ap-btn" disabled={alreadySuggested} onClick={() => change(withMaterial(doc, roomDef.defaultMaterial))}>
              Use this room&rsquo;s suggested material ({suggested.label})
            </button>
          </div>
        </Group>

        <Eyebrow label="readability" />
        <Group>
          <ToggleRow
            label="Extra readable"
            checked={extra}
            onChange={v => change(withReadability(doc, v ? 'extra' : 'standard'))}
            hint="Solid panels with stronger outlines. No textures, corners or scenery image. Every menu and control stays."
          />
          <ToggleRow
            label="Frame and decorations"
            checked={doc.decorations && !extra}
            disabled={extra}
            onChange={v => change({ ...doc, decorations: v })}
            hint="Metal frames and corners on every panel, the room's texture on panels and margin, and a gilt frame round the window. Text always sits on a solid colour."
          />
        </Group>

        {draft && (
          <div className="ap-pending" role="group" aria-label="Unapplied appearance preview">
            <span className="ap-pending-text">Previewing. Not applied yet.</span>
            <button type="button" className="ap-btn ap-btn-primary" onClick={onApply}>Apply</button>
            <button type="button" className="ap-btn" onClick={onCancel}>Cancel</button>
          </div>
        )}
        <p className="ap-status" role="status" aria-live="polite">
          {message || (persist === 'unsaved' ? 'This browser would not save the appearance; it lasts until you reload.' : '')}
        </p>
      </div>

      {/* The sample reads the real, live variables on purpose: it shows what the app looks like right now. */}
      <Eyebrow label="sample" sub="what the app is drawn in right now" />
      <div className="ap-sample" aria-label="Sample of the current appearance">
        <div className="ap-s-companion">A reply from your companion sits on this surface.</div>
        <div className="ap-s-user">And what you write sits on this one.</div>
        <div className="ap-s-input">
          <span className="ap-s-placeholder">Message&hellip;</span>
          <span className="ap-s-send">Send</span>
        </div>
        <div className="ap-s-menu" role="presentation">
          <span className="ap-s-item">A menu item</span>
          <span className="ap-s-item ap-s-item-sel">The chosen item</span>
        </div>
      </div>

      <div className="ap-safe" style={panelScopeVars(material) as React.CSSProperties}>
        {(issues.length > 0 || held) && (
          <div className="ap-warn" role="alert">
            {held
              ? 'Some of your custom colours would make text hard to read on this material, so they are paused. '
              : 'Some of your custom colours are hard to read together. '}
            {issues.map(i => `${i.id}: ${i.ratio.toFixed(1)}:1 (needs ${i.min}:1)`).join('; ')}
            . Restore readable appearance below puts the material&rsquo;s own palette back.
          </div>
        )}

        <Eyebrow label="colours & fonts" sub={isClassic ? 'live, saved to your hearth' : `custom colours for ${MATERIALS[material].label}`} />
        <Group>
          <p className="appearance-lead">
            {isClassic
              ? 'Colours and fonts here write straight into the hearth’s own palette the instant you change them, and follow you on reload.'
              : 'These customise only the chosen material, in this browser. Switching material keeps each one’s own set. Extra readable ignores custom colours.'}
          </p>
        </Group>

        {COLOR_GROUPS.map(group => (
          <React.Fragment key={group.label}>
            <Eyebrow label={group.label} sub={group.sub} />
            <Group>
              {group.keys.map(key => {
                const token = tokenByKey(key);
                const value = effectiveValue(key);
                return (
                  <div className="theme-row" key={key}>
                    <div className="theme-row-left">
                      <span className="theme-row-label">{token.label}</span>
                      {token.hint && <span className="theme-row-hint">{token.hint}</span>}
                    </div>
                    <div className="theme-row-control">
                      <span className="theme-row-value">{value}</span>
                      <input
                        type="color"
                        className="theme-color-input"
                        value={toHexColor(value)}
                        onChange={e => handleColorChange(key, e.target.value)}
                        aria-label={token.label}
                      />
                    </div>
                  </div>
                );
              })}
            </Group>
          </React.Fragment>
        ))}

        <Eyebrow label="fonts" />
        <Group>
          {FONT_KEYS.map(key => {
            const token = tokenByKey(key);
            const value = effectiveValue(key);
            const choices = FONT_CHOICES[key];
            const known = choices.some(c => c.value === value);
            return (
              <div className="theme-row theme-row-font" key={key}>
                <div className="theme-row-left">
                  <span className="theme-row-label" style={{ fontFamily: value }}>{token.label}</span>
                  {token.hint && <span className="theme-row-hint">{token.hint}</span>}
                </div>
                <select
                  className="sp-form-input theme-font-select"
                  value={value}
                  onChange={e => handleFontChange(key, e.target.value)}
                  aria-label={token.label}
                >
                  {!known && <option value={value}>Current</option>}
                  {choices.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </Group>

        <div className="theme-actions">
          <SaveIndicator status={status} />
          <button type="button" className="ap-restore" onClick={restoreReadable} disabled={status === 'saving'}>
            Restore readable appearance
          </button>
          <Btn variant="muted" small onClick={resetEverything} disabled={status === 'saving'}>
            reset to defaults
          </Btn>
        </div>
      </div>

      <style>{`
        .appearance-section { padding-bottom: 2rem; }

        /* Everything that edits the appearance is drawn on this plate in its own colours. */
        .ap-safe {
          background: var(--ap-bg);
          color: var(--ap-text);
          border-radius: 0.75rem;
          padding: 0.25rem 1rem 1rem;
        }
        @media (max-width: 600px) { .ap-safe { padding-left: 0.25rem; padding-right: 0.25rem; } }
        .ap-safe + .ap-safe, .ap-sample + .ap-safe { margin-top: 1rem; }

        .appearance-lead {
          font-family: var(--font-serif, 'Lora', serif);
          font-size: 0.95rem;
          color: var(--ap-text-2);
          line-height: 1.6;
          padding: 0.875rem 0;
        }
        .appearance-lead strong { color: var(--ap-text); font-weight: 600; }

        /* ── companion picture ── */
        .ap-avatars { display: flex; flex-wrap: wrap; gap: 0.625rem; padding: 0.5rem 0; }
        .ap-avatar {
          width: 56px; height: 56px; padding: 0; box-sizing: border-box; border-radius: 50%;
          border: 1px solid var(--ap-border); background: var(--ap-field); color: var(--ap-field-text);
          overflow: hidden; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-direction: column;
        }
        .ap-avatar img { display: block; width: 100%; height: 100%; object-fit: cover; }
        .ap-avatar.selected { border: 3px solid var(--ap-accent); }
        .ap-avatar:disabled { opacity: 0.6; cursor: default; }
        .ap-avatar:focus-visible { outline: 3px solid var(--ap-focus); outline-offset: 2px; }
        .ap-avatar-upload { border-style: dashed; font-size: 1.25rem; line-height: 1; }
        .ap-avatar-cap { font-size: 0.625rem; letter-spacing: 0.04em; }

        /* ── room cards ── */
        .ap-rooms {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
          gap: 0.75rem;
          padding: 0.5rem 0 0.75rem;
        }
        .ap-room {
          display: flex;
          flex-direction: column;
          align-items: stretch;
          gap: 0.25rem;
          padding: 0.5rem;
          text-align: left;
          background: var(--ap-field);
          color: var(--ap-field-text);
          border: 1px solid var(--ap-border);
          border-radius: 0.625rem;
          cursor: pointer;
          min-height: 44px;
        }
        .ap-room:hover { border-color: var(--ap-text); }
        .ap-room.selected { border: 2px solid var(--ap-accent); padding: calc(0.5rem - 1px); }
        .ap-room:focus-visible, .ap-btn:focus-visible, .ap-restore:focus-visible, .ap-select:focus-visible {
          outline: 3px solid var(--ap-focus);
          outline-offset: 2px;
        }
        .ap-room-thumb {
          display: block;
          aspect-ratio: 3 / 2;
          border-radius: 0.375rem;
          overflow: hidden;
        }
        /* The classic room has no artwork file to preview, so its card draws the look: the dark green
           kitchen, a wood rail, a parchment panel and a dusty rose "You". Pure CSS, nothing to download. */
        .ap-swatch { position: relative; display: block; width: 100%; height: 100%;
          background: linear-gradient(rgba(16, 26, 14, 0.42), rgba(16, 26, 14, 0.52)), #2d3a20; }
        .ap-swatch-rail { position: absolute; left: 0; top: 0; bottom: 0; width: 14%; background: linear-gradient(180deg, #3a2416, #2c1a10); }
        .ap-swatch-card { position: absolute; left: 22%; right: 8%; top: 16%; height: 30%; border-radius: 4px; background: #faf4e4; }
        .ap-swatch-card.user { left: 40%; top: 54%; background: #CFABAC; }
        .ap-swatch-card::before, .ap-swatch-card::after { content: ''; position: absolute; left: 8%; height: 8%; border-radius: 2px; background: #5d5047; }
        .ap-swatch-card::before { top: 28%; width: 62%; }
        .ap-swatch-card::after { top: 56%; width: 40%; }
        .ap-swatch-card.user::before, .ap-swatch-card.user::after { background: #3b2f52; }
        .ap-room-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
        .ap-room-name { font-family: var(--font-serif, 'Lora', serif); font-size: 0.95rem; line-height: 1.2; }
        .ap-room-sub { font-size: 0.8rem; color: var(--ap-text-2); }
        .ap-room-check { font-size: 0.8rem; font-weight: 600; color: var(--ap-accent); }
        .ap-room-check::before { content: '\\2713\\00a0'; }

        /* ── rows ── */
        .ap-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          padding: 0.625rem 0;
          border-bottom: 1px solid var(--ap-border);
          flex-wrap: wrap;
        }
        .ap-row:last-child { border-bottom: none; }
        .ap-row-action { justify-content: flex-start; }
        .ap-label { display: flex; flex-direction: column; gap: 0.125rem; min-width: 0; flex: 1 1 10rem; font-size: 0.9rem; color: var(--ap-text); }
        .ap-hint { font-size: 0.8rem; color: var(--ap-muted); }
        .ap-select { width: auto; min-width: 11rem; max-width: 100%; min-height: 44px; background: var(--ap-field); color: var(--ap-field-text); border: 1px solid var(--ap-border); }

        .ap-btn, .ap-restore {
          min-height: 44px;
          padding: 0.5rem 1rem;
          border-radius: 0.5rem;
          font-size: 0.9rem;
          font-family: inherit;
          cursor: pointer;
          background: var(--ap-field);
          color: var(--ap-field-text);
          border: 1px solid var(--ap-border);
          text-align: left;
        }
        .ap-btn:hover:not(:disabled) { border-color: var(--ap-text); }
        .ap-btn:disabled { background: var(--ap-bg); color: var(--ap-muted); cursor: not-allowed; }
        .ap-btn-primary { background: var(--ap-button); color: var(--ap-button-text); border-color: var(--ap-button-text); text-align: center; }

        /* The one control that is the same on every material: black on cream, heavy outline. */
        .ap-restore {
          background: ${RESTORE_BUTTON.bg};
          color: ${RESTORE_BUTTON.text};
          border: 2px solid ${RESTORE_BUTTON.border};
          font-weight: 600;
          text-align: center;
        }
        .ap-restore:disabled { cursor: wait; }

        .ap-pending {
          display: flex;
          align-items: center;
          gap: 0.625rem;
          flex-wrap: wrap;
          margin-top: 0.75rem;
          padding: 0.625rem 0.75rem;
          border: 2px solid var(--ap-accent);
          border-radius: 0.625rem;
          background: var(--ap-field);
          color: var(--ap-field-text);
        }
        .ap-pending-text { flex: 1 1 10rem; font-size: 0.9rem; font-weight: 600; }
        .ap-status { min-height: 1.25rem; margin-top: 0.5rem; font-size: 0.85rem; color: var(--ap-text-2); }

        .ap-warn {
          margin: 0.75rem 0 0.25rem;
          padding: 0.625rem 0.75rem;
          border: 2px solid var(--ap-warning);
          border-radius: 0.5rem;
          background: var(--ap-field);
          color: var(--ap-field-text);
          font-size: 0.85rem;
          line-height: 1.5;
        }

        /* ── sample: drawn from the live, real variables ── */
        .ap-sample {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          padding: 0.75rem;
          margin-bottom: 0.5rem;
          border-radius: 0.75rem;
          background: var(--surface-panel);
          color: var(--surface-panel-text);
          border: 1px solid var(--control-border);
        }
        .ap-s-companion, .ap-s-user { padding: 0.5rem 0.75rem; border-radius: 0.75rem; font-size: 1rem; line-height: 1.5; max-width: 85%; }
        .ap-s-companion { background: var(--surface-companion); color: var(--surface-companion-text); border: 1px solid var(--companion-border); }
        .ap-s-user { align-self: flex-end; background: var(--surface-user); color: var(--surface-user-text); border: 1px solid var(--user-border); }
        .ap-s-input {
          display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
          padding: 0.375rem 0.375rem 0.375rem 0.875rem; border-radius: 999px;
          background: var(--surface-input); color: var(--surface-input-text); border: 1px solid var(--control-border);
        }
        .ap-s-placeholder { color: var(--surface-input-placeholder); }
        .ap-s-send { padding: 0.375rem 0.875rem; border-radius: 999px; background: var(--control-primary-bg); color: var(--control-primary-text); font-size: 0.9rem; }
        .ap-s-menu { display: flex; flex-direction: column; align-self: flex-start; min-width: 12rem; padding: 0.25rem; border-radius: 0.5rem; background: var(--surface-popover); color: var(--surface-popover-text); border: 1px solid var(--surface-popover-border); }
        .ap-s-item { padding: 0.375rem 0.625rem; font-size: 0.9rem; border-radius: 0.375rem; }
        .ap-s-item-sel { background: var(--control-selected-bg, var(--bg-active)); color: var(--control-selected-text, var(--surface-popover-text)); text-decoration: underline; text-underline-offset: 3px; }

        /* ── colour and font rows ── */
        .theme-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          padding: 0.625rem 0;
          border-bottom: 1px solid var(--ap-border);
          flex-wrap: wrap;
        }
        .theme-row:last-child { border-bottom: none; }

        .theme-row-left {
          display: flex;
          flex-direction: column;
          gap: 0.125rem;
          min-width: 0;
        }
        .theme-row-label { font-size: 0.9rem; color: var(--ap-text); }
        .theme-row-hint { font-size: 0.8rem; color: var(--ap-muted); font-style: italic; }

        .theme-row-control { display: flex; align-items: center; gap: 0.625rem; flex-shrink: 0; }
        .theme-row-value {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.75rem;
          color: var(--ap-text-2);
          letter-spacing: 0.02em;
          min-width: 6.5rem;
          text-align: right;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .theme-color-input {
          appearance: none;
          -webkit-appearance: none;
          width: 2.75rem;
          height: 2.75rem;
          padding: 0;
          border: 2px solid var(--ap-border);
          border-radius: 0.5rem;
          background: none;
          cursor: pointer;
          flex-shrink: 0;
        }
        .theme-color-input:hover { border-color: var(--ap-text); }
        .theme-color-input:focus-visible { outline: 3px solid var(--ap-focus); outline-offset: 2px; }
        .theme-color-input::-webkit-color-swatch-wrapper { padding: 0; border-radius: 0.4375rem; }
        .theme-color-input::-webkit-color-swatch { border: none; border-radius: 0.4375rem; }
        .theme-color-input::-moz-color-swatch { border: none; border-radius: 0.4375rem; }

        .theme-row-font { align-items: flex-start; }
        .theme-font-select { max-width: 15rem; width: auto; min-height: 44px; }

        .theme-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          flex-wrap: wrap;
          gap: 0.875rem;
          margin-top: 1.5rem;
        }
      `}</style>
    </div>
  );
}
