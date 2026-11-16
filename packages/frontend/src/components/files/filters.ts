/** The chips of the Files page's "Show" group, in order. FilesView draws them; the test holds the count (the row must still fit at 360 wide). */
export type Filter = 'all' | 'generated' | 'stickers' | 'references';
export const FILTER_CHIPS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'generated', label: 'Generated' },
  { id: 'stickers', label: 'Stickers' },
  { id: 'references', label: 'References' },
];
