import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StickerGrid, type StickerGridProps } from './StickerLibrary';
import { readStickers, stickerDraftProblem, stickerError } from './stickers';

const noop = () => undefined;
const base: StickerGridProps = {
  state: 'ready', stickers: [], query: '', canSend: true, name: '', fileName: '', busy: false,
  onName: noop, onPick: noop, onAdd: noop, onSend: noop, onDelete: noop,
};
const items = [
  { id: 'a', name: 'Wave', fileId: 'f1', url: '/api/files/f1', createdAt: '' },
  { id: 'b', name: 'Cheer', fileId: 'f2', url: '/api/files/f2', createdAt: '' },
];

describe('the Stickers chip in Files', () => {
  it('empty: one plain line and the upload form on the Files controls', () => {
    const html = renderToStaticMarkup(<StickerGrid {...base} />);
    expect(html).toContain('No stickers yet.');
    expect(html).toContain('class="fl-input fl-stk-name"');
    expect(html).toContain('fl-btn fl-btn-primary hearth-press');
    expect(html).toContain('Choose picture');
  });
  it('lists each sticker as a Files tile with Send to chat and Delete; Send waits for an open chat', () => {
    const html = renderToStaticMarkup(<StickerGrid {...base} stickers={items} />);
    expect(html).toContain('fl-cell');
    expect(html).toContain('alt="Wave"');
    expect(html).toContain('aria-label="Delete Cheer"');
    expect(html.match(/Send to chat/g)).toHaveLength(2);
    expect(renderToStaticMarkup(<StickerGrid {...base} stickers={items} canSend={false} />)).toMatch(/disabled=""[^>]*title="No open chat/);
  });
  it('search narrows by name', () => {
    const html = renderToStaticMarkup(<StickerGrid {...base} stickers={items} query="che" />);
    expect(html).toContain('alt="Cheer"');
    expect(html).not.toContain('alt="Wave"');
  });
});

describe('sticker helpers', () => {
  it('reads the list sorted by name and drops rows without ids', () => {
    expect(readStickers({ stickers: [{ id: 'b', name: 'b', fileId: 'x' }, { name: 'bad' }, { id: 'a', name: 'A', fileId: 'y' }] }).map(s => s.name)).toEqual(['A', 'b']);
    expect(readStickers(null)).toEqual([]);
  });
  it('checks a draft before upload', () => {
    expect(stickerDraftProblem(' ', null)).toBe('Give the sticker a name');
    expect(stickerDraftProblem('x', null)).toBe('Choose a picture');
    expect(stickerDraftProblem('x', { size: 10, type: 'text/plain' })).toBe('A sticker is a picture');
    expect(stickerDraftProblem('x', { size: 3 * 1024 * 1024, type: 'image/png' })).toBe('A sticker is 2 MB or smaller');
    expect(stickerDraftProblem('x', { size: 10, type: 'image/png' })).toBeNull();
  });
  it('words the server errors', () => {
    expect(stickerError(409)).toBe('A sticker with that name exists');
    expect(stickerError(413)).toBe('A sticker is 2 MB or smaller');
    expect(stickerError(403)).toContain('permissions');
  });
});
