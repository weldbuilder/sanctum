/** The Settings tabs: six that are settings, then Status, which only reads. One list, so the page and its test cannot drift apart. */
export type SectionId = 'you' | 'mind' | 'rhythm' | 'channels' | 'permissions' | 'look' | 'status';

export const TABS: ReadonlyArray<{ id: SectionId; label: string; sub: string }> = [
  { id: 'you', label: 'you & them', sub: 'names, time, identity files' },
  { id: 'mind', label: 'mind', sub: 'model, memory, summaries, pictures' },
  { id: 'rhythm', label: 'rhythm', sub: 'check-ins, handoff, watchtower' },
  { id: 'channels', label: 'channels', sub: 'Discord, Telegram, voice' },
  { id: 'permissions', label: 'permissions', sub: 'what the companion may do' },
  { id: 'look', label: 'look', sub: 'room, material, readability' },
  { id: 'status', label: 'status', sub: 'skills, MCPs, usage, logs' },
];

export const DEFAULT_TAB: SectionId = 'you';

/** The tab a `?tab=` query names (the command palette's links), else the default. */
export function tabFromSearch(search: string): SectionId {
  const id = new URLSearchParams(search).get('tab');
  return TABS.some(t => t.id === id) ? (id as SectionId) : DEFAULT_TAB;
}
