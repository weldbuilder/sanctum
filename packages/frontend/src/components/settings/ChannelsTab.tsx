/** Channels tab: Discord and Telegram (on, token, lanes: ChannelsSection), then voice (on, voice id) and the browser seat's viewer address. */
import React from 'react';
import { Eyebrow, Group, TextField, ToggleRow } from './primitives';
import { ChannelsSection } from './ChannelsSection';
import { PREFS_CSS, PrefsSaveBar, usePreferences } from './prefsShared';

export function ChannelsTab({ base, onOpenLogs }: { base: string; onOpenLogs?: (q: string) => void }) {
  const { draft, patchDraft, patchImmediate, saveAll, saveStatus, saveError, dirty } = usePreferences(base);
  return (
    <div className="prefs-section">
      <style>{PREFS_CSS}</style>
      <ChannelsSection base={base} onOpenLogs={onOpenLogs} />
      {draft && (
        <>
          <Eyebrow label="voice" />
          <Group>
            <ToggleRow label="voice" checked={draft.voice.enabled} hint="Voice notes and read-aloud. Spends text-to-speech credit."
              onChange={v => void patchImmediate({ voice: { ...draft.voice, enabled: v } })} />
            <div className="prefs-form-block">
              <TextField label="ElevenLabs voice ID" value={draft.voice.elevenlabs_voice_id ?? ''} mono
                onChange={v => patchDraft({ voice: { ...draft.voice, elevenlabs_voice_id: v } })}
                hint="Voice ID used for TTS. Set ELEVENLABS_API_KEY in .env." />
            </div>
          </Group>
          <Eyebrow label="browser" />
          <Group>
            <div className="prefs-form-block">
              <TextField label="browser viewer URL" value={draft.integrations?.browser_url ?? ''} mono placeholder="http://<viewer-host>:3201/"
                onChange={v => patchDraft({ integrations: { ...(draft.integrations ?? {}), browser_url: v } })}
                hint="Shown in the Browser tab (see examples/browser-seat-neko). Keep it on localhost or a private network. Restart to apply." />
            </div>
          </Group>
          <PrefsSaveBar saveStatus={saveStatus} saveError={saveError} dirty={dirty} onSave={() => void saveAll()} />
        </>
      )}
    </div>
  );
}
