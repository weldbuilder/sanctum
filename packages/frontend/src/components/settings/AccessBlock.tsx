/**
 * The write-access controls that used to sit in Preferences: the app's features, the Command Center, and where the companion may write
 * (workspace root, vault, extra folders; on Codex the sandbox, extra folders and network). They save through PUT /api/preferences as before.
 * Lives in the Permissions tab, below the consent gate.
 */
import React from 'react';
import { Eyebrow, Group, TextField, ToggleRow } from './primitives';
import { HearthSelect } from '../hearth';
import { PREFS_CSS, PrefsSaveBar, usePreferences } from './prefsShared';

export function AccessBlock({ base }: { base: string }) {
  const { draft, patchDraft, saveAll, saveStatus, saveError, dirty } = usePreferences(base);
  if (!draft) return null;
  const extraPaths = draft.hooks?.extra_write_paths?.join(', ') ?? '';
  return (
    <div className="prefs-section">
      <style>{PREFS_CSS}</style>
      {/* ── Permissions ── */}
      <Eyebrow label="app features and folders" sub={draft.agent.provider === 'codex' ? 'what the companion may touch, on Codex' : 'what the companion may write, on Claude'} />
      <Group>
        <ToggleRow
          label="write to the app's features (older switch)"
          checked={draft.agent.app_write !== false}
          onChange={v => patchDraft({ agent: { ...draft.agent, app_write: v } })}
          restartRequired
          hint="Reminders and timers, the meal and care log, cycle tracking, notes and canvases, routines, presence. On your say-so only. Off, every write is refused."
        />
        <ToggleRow
          label="Command Center"
          checked={draft.command_center?.enabled ?? false}
          onChange={v => patchDraft({ command_center: { ...(draft.command_center ?? {}), enabled: v } })}
          restartRequired
          hint="The care log, cycle tracking, routines, pets, countdowns and wins pages, and the companion's tools for them."
        />
      </Group>
      {draft.agent.provider === 'codex' && draft.agent.codex ? (
        <Group>
          <div className="prefs-form-block">
            <span className="sp-empty-text">
              On Codex the sandbox is the boundary. The home folder is always readable; the level
              below decides what else. Background helpers (digest, handoff, outlook) always run
              read-only whatever is set here.
            </span>
            <div className="sp-form-group">
              <label className="sp-form-label">
                sandbox <span className="sp-restart-badge" title="Applies on restart">restart</span>
              </label>
              <HearthSelect
                block
                ariaLabel="sandbox mode"
                value={draft.agent.codex.sandbox_mode}
                onChange={v => patchDraft({ agent: { ...draft.agent, codex: { ...draft.agent.codex!, sandbox_mode: v as 'read-only' | 'workspace-write' | 'danger-full-access' } } })}
                options={[
                  { value: 'read-only', label: 'Read only', sublabel: 'can read the home folder, writes nothing' },
                  { value: 'workspace-write', label: 'Home folder', sublabel: 'writes inside the home folder and the extra folders below' },
                  { value: 'danger-full-access', label: 'Full access', sublabel: 'writes anywhere on this computer; nothing stops a bad edit' },
                ]}
              />
            </div>
            <TextField
              label="extra writable folders"
              value={draft.agent.codex.additional_directories.join(', ')}
              onChange={v => patchDraft({ agent: { ...draft.agent, codex: { ...draft.agent.codex!, additional_directories: v.split(',').map(x => x.trim()).filter(Boolean) } } })}
              mono
              restartRequired
              hint="Comma-separated absolute paths the companion may also write to, e.g. a notes folder. Empty = the home folder only."
            />
            <ToggleRow
              label="network access"
              checked={draft.agent.codex.network_access}
              onChange={v => patchDraft({ agent: { ...draft.agent, codex: { ...draft.agent.codex!, network_access: v } } })}
              restartRequired
              hint="Lets the companion reach the network from inside the sandbox. Keep on: the res tools (canvas, timers, notes) talk to this app over the local network."
            />
          </div>
        </Group>
      ) : (
      <Group>
        <div className="prefs-form-block">
          <TextField
            label="workspace root"
            value={draft.hooks?.workspace_root ?? ''}
            onChange={v => patchDraft({ hooks: { ...(draft.hooks ?? {}), workspace_root: v } })}
            mono
            restartRequired
            hint="Primary write-allowed directory — absolute path, saved to sanctum.yaml (hooks.workspace_root)"
          />
          <TextField
            label="vault path"
            value={draft.hooks?.vault_path ?? ''}
            onChange={v => patchDraft({ hooks: { ...(draft.hooks ?? {}), vault_path: v } })}
            mono
            restartRequired
            hint="Knowledge vault — absolute path, saved to sanctum.yaml (hooks.vault_path)"
          />
          <TextField
            label="extra write paths"
            value={extraPaths}
            onChange={v => patchDraft({
              hooks: {
                ...(draft.hooks ?? {}),
                extra_write_paths: v.split(',').map(s => s.trim()).filter(Boolean),
              },
            })}
            restartRequired
            hint="Comma-separated absolute paths granted write access (hooks.extra_write_paths)"
          />
        </div>
      </Group>
      )}

      <PrefsSaveBar saveStatus={saveStatus} saveError={saveError} dirty={dirty} onSave={() => void saveAll()} />
    </div>
  );
}
