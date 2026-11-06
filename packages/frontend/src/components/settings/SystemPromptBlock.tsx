/**
 * The system-prompt frame editor (GET/PUT /api/prompts/system): the agent re-reads it every turn, so a save applies on the next one.
 * Lives in the Mind tab; moved here whole from the old Preferences section.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Card, Eyebrow, SaveIndicator } from './primitives';

export function SystemPromptBlock({ base }: { base: string }) {
  // System-prompt frame (separate endpoint — the agent re-reads it every turn, so a save applies on the next one)
  const [sysConfigured, setSysConfigured] = useState(false);
  const [sysContent, setSysContent] = useState('');
  const [sysDraft, setSysDraft] = useState('');
  const [sysPath, setSysPath] = useState('');
  const [sysSource, setSysSource] = useState('');
  const [sysReadPath, setSysReadPath] = useState('');
  // true: the text shown is not yet the agent's own copy (the shipped harness, or a file the editor does not write), so a save is meaningful even unedited.
  const [sysTemplate, setSysTemplate] = useState(false);
  // The HTTP status when the frame could not be read ('' = no failure).
  const [sysLoadError, setSysLoadError] = useState('');
  const [sysProvider, setSysProvider] = useState('claude');
  const [sysAgentsPath, setSysAgentsPath] = useState('');
  const [sysStatus, setSysStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    async function loadSys() {
      try {
        const res = await fetch(`${base}/api/prompts/system`);
        if (!res.ok) { setSysLoadError(String(res.status)); return; }
        setSysLoadError('');
        const data = await res.json();
        setSysConfigured(!!data.configured);
        setSysContent(data.content ?? '');
        setSysDraft(data.content ?? '');
        setSysPath(data.path ?? '');
        setSysSource(data.source ?? '');
        setSysReadPath(data.read_path ?? '');
        setSysTemplate(data.template === true);
        setSysProvider(data.provider ?? 'claude');
        setSysAgentsPath(data.agents_md ?? '');
      } catch { /* backend not up */ }
    }
    loadSys();
  }, [base]);

  const saveSystemPrompt = useCallback(async () => {
    setSysStatus('saving');
    try {
      const res = await fetch(`${base}/api/prompts/system`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: sysDraft }),
      });
      if (res.ok) {
        const saved = await res.json().catch(() => ({}));
        setSysContent(sysDraft); setSysStatus('saved');
        // The save went to this path; from now on it is the file the agent reads.
        if (saved.path) { setSysPath(saved.path); setSysReadPath(saved.path); }
        setSysTemplate(false);
        if (saved.source) setSysSource(saved.source);
      }
      else setSysStatus('error');
    } catch { setSysStatus('error'); }
    setTimeout(() => setSysStatus('idle'), 2200);
  }, [base, sysDraft]);

  return (
    <>
      {/* ── System prompt frame ── */}
      <Eyebrow label="system prompt" />
      <Card>
        <div className="prefs-form-block">
          {sysProvider !== 'claude' ? (
            <span className="sp-empty-text">
              On {sysProvider === 'codex' ? 'Codex' : 'this mind'}, your companion's identity lives in two files in their home
              folder: profile.md and companion.md. Edit those to change who they are.
              {sysAgentsPath && <code className="sysprompt-path">{sysAgentsPath}</code>}
            </span>
          ) : sysConfigured ? (
            <div className="sysprompt-block">
              <div className="sysprompt-head">
                <span className="sysprompt-hint">
                  The lean operating frame, prepended before CLAUDE.md. Replaces the
                  Claude Code preset. <strong>Re-read every turn: a saved copy applies on the next message, no restart.</strong>
                  {sysTemplate && sysSource === 'none' && (
                    <> No frame is active; saving installs this harness as your own copy at {sysPath || 'the path below'}.</>
                  )}
                  {sysTemplate && sysSource === 'configured' && (
                    <> This text comes from a file the editor does not write to. Saving creates your own copy at the path below, and that copy is the one used from then on.</>
                  )}
                </span>
                {sysPath && <code className="sysprompt-path">{sysPath}</code>}
              </div>
              <textarea
                className="sysprompt-textarea"
                value={sysDraft}
                onChange={e => setSysDraft(e.target.value)}
                spellCheck={false}
                rows={18}
                aria-label="System prompt frame"
              />
              <div className="sysprompt-actions">
                <SaveIndicator status={sysStatus} />
                <button
                  className="sysprompt-save"
                  onClick={saveSystemPrompt}
                  disabled={(sysDraft === sysContent && !sysTemplate) || sysStatus === 'saving'}
                >
                  save frame
                </button>
              </div>
            </div>
          ) : sysLoadError ? (
            <span className="sp-empty-text">The frame could not be read (HTTP {sysLoadError}).</span>
          ) : (
            <span className="sp-empty-text">
              No system_prompt_file configured. Set agent.system_prompt_file in
              sanctum.yaml to edit the frame here.
            </span>
          )}
        </div>
        <style>{`
          .sysprompt-block { display: flex; flex-direction: column; gap: 0.75rem; }
          .sysprompt-head { display: flex; flex-direction: column; gap: 0.375rem; }
          .sysprompt-hint {
            font-size: 0.8125rem; line-height: 1.5;
            color: var(--text-secondary);
          }
          .sysprompt-hint strong { color: var(--amber); font-weight: 500; }
          .sysprompt-path {
            font-family: var(--font-mono, monospace);
            font-size: 0.6875rem; color: var(--text-muted);
            opacity: 0.8; word-break: break-all;
          }
          .sysprompt-textarea {
            width: 100%; box-sizing: border-box; resize: vertical;
            min-height: 16rem;
            background: var(--settings-field-bg);
            border: 1px solid var(--settings-field-border);
            border-radius: 0.5rem; padding: 0.875rem 1rem;
            color: var(--text-primary);
            font-family: var(--font-mono, 'JetBrains Mono', monospace);
            font-size: 0.78125rem; line-height: 1.6;
            transition: border-color 240ms var(--hearth-curve, ease);
          }
          .sysprompt-textarea:focus {
            outline: none;
            border-color: var(--field-border-focus, var(--amber));
          }
          .sysprompt-actions {
            display: flex; align-items: center; justify-content: flex-end;
            gap: 0.875rem;
          }
          .sysprompt-save {
            min-height: 40px;
            font-size: 0.8125rem; font-weight: 500;
            color: var(--bg-primary);
            background: var(--amber);
            border: none; border-radius: 0.4375rem;
            padding: 0.4375rem 0.9375rem; cursor: pointer;
            transition: opacity 200ms var(--hearth-curve, ease), transform 100ms var(--hearth-curve, ease);
          }
          .sysprompt-save:hover:not(:disabled) { opacity: 0.9; }
          .sysprompt-save:active:not(:disabled) { transform: scale(0.985); }
          .sysprompt-save:disabled { opacity: 0.4; cursor: default; }
        `}</style>
      </Card>

    </>
  );
}
