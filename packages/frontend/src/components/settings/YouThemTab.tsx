/** You & them tab: the two names, the timezone, then the identity files and their ratify step (IdentitySection, unchanged). */
import React from 'react';
import { Eyebrow, Group, TextField } from './primitives';
import { IdentitySection } from './IdentitySection';
import { PREFS_CSS, PrefsSaveBar, usePreferences } from './prefsShared';

export function YouThemTab({ base }: { base: string }) {
  const { draft, patchDraft, saveAll, saveStatus, saveError, dirty } = usePreferences(base);
  return (
    <div className="prefs-section">
      <style>{PREFS_CSS}</style>
      {draft && (
        <>
          <Eyebrow label="names and time" />
          <Group>
            <div className="prefs-form-block">
              <TextField label="companion name" value={draft.identity.companion_name} mono restartRequired
                onChange={v => patchDraft({ identity: { ...draft.identity, companion_name: v } })} />
              <TextField label="your name" value={draft.identity.user_name} mono restartRequired
                onChange={v => patchDraft({ identity: { ...draft.identity, user_name: v } })} />
              <TextField label="timezone" value={draft.identity.timezone} mono
                onChange={v => patchDraft({ identity: { ...draft.identity, timezone: v } })}
                hint="IANA timezone string, e.g. Europe/London. Times in the app use your device's own clock format." />
            </div>
          </Group>
          <PrefsSaveBar saveStatus={saveStatus} saveError={saveError} dirty={dirty} onSave={() => void saveAll()} />
        </>
      )}
      <IdentitySection base={base} />
    </div>
  );
}
