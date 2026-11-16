import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReferenceGrid, type ReferenceGridProps } from './ReferenceLibrary';
import { chosenReferences, readReferences, referenceChipLabel, referenceDraftProblem, referenceError, REFERENCE_HINT, type ReferenceItem } from './references';
import { FILTER_CHIPS } from './filters';

const noop = () => undefined;
const base: ReferenceGridProps = {
  state: 'ready', refs: [], query: '', name: '', note: '', self: false, fileName: '', busy: false, editing: null,
  onName: noop, onNote: noop, onSelf: noop, onPick: noop, onAdd: noop, onToggleSelf: noop, onEdit: noop, onEditText: noop,
  onSaveNote: noop, onCancelEdit: noop, onDelete: noop,
};
const ref = (o: Partial<ReferenceItem> & { id: string; name: string }): ReferenceItem => ({ self: false, note: '', fileId: `f-${o.id}`, url: `/api/files/f-${o.id}`, createdAt: '', ...o });
const items = [
  ref({ id: 'a', name: 'Echo', self: true, note: 'Echo in the green coat' }),
  ref({ id: 'b', name: 'Sam' }),
  ref({ id: 'c', name: 'Lake house', note: 'The porch at dusk' }),
];

describe('the References chip in Files', () => {
  it('empty: one plain line, the form on the Files controls, and the size hint', () => {
    const html = renderToStaticMarkup(<ReferenceGrid {...base} />);
    expect(html).toContain('No references yet.');
    expect(html).toContain('aria-label="Reference name"');
    expect(html).toContain('aria-label="Reference note"');
    expect(html).toContain('This is the companion');
    expect(html).toContain('Choose picture');
    expect(html).toContain('fl-btn fl-btn-primary hearth-press');
    expect(html).toContain('Add reference');
    expect(html).toContain('PNG, JPEG or WebP up to 1 MB. Mark the ones that show your companion; those are used for selfies.');
  });

  it('each reference is a Files tile with its picture, name, note; a You badge only on the companion\'s own', () => {
    const html = renderToStaticMarkup(<ReferenceGrid {...base} refs={items} />);
    expect(html.match(/class="fl-cell fl-ref-cell"/g)).toHaveLength(3);
    expect(html).toContain('alt="Lake house"');
    expect(html).toContain('The porch at dusk');
    expect(html).toContain('No note');
    expect(html.match(/fl-ref-badge/g)).toHaveLength(2); // the style rule and the one badge
    expect(html).toContain('<span class="fl-ref-badge">You</span>');
    expect(html.match(/<span class="fl-ref-badge">/g)).toHaveLength(1);
  });

  it('"This is you" is a toggle that shows its state; Delete is the destructive Files button', () => {
    const html = renderToStaticMarkup(<ReferenceGrid {...base} refs={items} />);
    expect(html.match(/aria-pressed="true">This is you/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="false">This is you/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Delete Echo"');
    expect(html).toContain('fl-btn fl-btn-danger hearth-press');
    expect(html).toContain('aria-label="Edit the note for Sam"');
  });

  it('editing a note swaps that card\'s actions for a field with Save note and Cancel', () => {
    const html = renderToStaticMarkup(<ReferenceGrid {...base} refs={items} editing={{ id: 'b', text: 'Sam by the lake' }} />);
    expect(html).toContain('aria-label="Note for Sam"');
    expect(html).toContain('value="Sam by the lake"');
    expect(html).toContain('Save note');
    expect(html.match(/Save note/g)).toHaveLength(1);
    expect(html).not.toContain('aria-label="Delete Sam"');
    expect(html).toContain('aria-label="Delete Echo"');
  });

  it('search narrows by name or note; the loading and error lines', () => {
    expect(renderToStaticMarkup(<ReferenceGrid {...base} refs={items} query="porch" />)).toContain('alt="Lake house"');
    expect(renderToStaticMarkup(<ReferenceGrid {...base} refs={items} query="porch" />)).not.toContain('alt="Sam"');
    expect(renderToStaticMarkup(<ReferenceGrid {...base} refs={items} query="zzz" />)).toContain('No reference matches “zzz”.');
    expect(renderToStaticMarkup(<ReferenceGrid {...base} state="loading" />)).toContain('Opening…');
    expect(renderToStaticMarkup(<ReferenceGrid {...base} state="error" />)).toContain('Could not load the references.');
  });

  it('names no colour of its own (tokens only)', () => {
    const html = renderToStaticMarkup(<ReferenceGrid {...base} refs={items} />);
    const css = html.slice(html.indexOf('<style>'));
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
  });
});

describe('reference helpers', () => {
  it('reads the list sorted by name, drops rows without ids, and keeps self and note', () => {
    const got = readReferences({ references: [{ id: 'b', name: 'b', fileId: 'x' }, { name: 'bad' }, { id: 'a', name: 'A', fileId: 'y', self: true, note: 'n' }] });
    expect(got.map(r => [r.name, r.self, r.note])).toEqual([['A', true, 'n'], ['b', false, '']]);
    expect(readReferences(null)).toEqual([]);
  });

  it('checks a draft before upload', () => {
    expect(referenceDraftProblem(' ', null)).toBe('Give the reference a name');
    expect(referenceDraftProblem('a|b', null)).toBe('A name has no brackets, colons, commas or bars');
    expect(referenceDraftProblem('x', null)).toBe('Choose a picture');
    expect(referenceDraftProblem('x', { size: 10, type: 'image/gif' })).toBe('A reference is a PNG, JPEG or WebP picture');
    expect(referenceDraftProblem('x', { size: 1_000_001, type: 'image/png' })).toBe('A reference is 1 MB or smaller');
    expect(referenceDraftProblem('x', { size: 1_000_000, type: 'image/webp' })).toBeNull();
    expect(REFERENCE_HINT).toContain('1 MB');
  });

  it('maps the errors the server sends to one line each', () => {
    expect(referenceError(409, { error: 'name_taken' })).toBe('A reference with that name exists');
    expect(referenceError(409, { error: 'self_limit' })).toBe('Up to four references can show your companion');
    expect(referenceError(409, { error: 'library_full' })).toBe('The library holds up to twelve references');
    expect(referenceError(413)).toBe('A reference is 1 MB or smaller');
    expect(referenceError(403)).toContain('app writes are off');
    expect(referenceError(400, { message: 'A name is up to 40 characters' })).toBe('A name is up to 40 characters');
    expect(referenceError(500)).toBe('Could not save the reference (500)');
  });

  it('chips: your own are marked; "As you" puts them first, then the picks once each, at most four', () => {
    expect(referenceChipLabel({ name: 'Echo', self: true })).toBe('Echo (you)');
    expect(referenceChipLabel({ name: 'Sam', self: false })).toBe('Sam');
    const refs = [ref({ id: '1', name: 'Echo', self: true }), ref({ id: '2', name: 'Echo side', self: true }), ...['A', 'B', 'C'].map((n, i) => ref({ id: `n${i}`, name: n }))];
    expect(chosenReferences(refs, ['A'], false)).toEqual(['A']);
    expect(chosenReferences(refs, ['A', 'Echo'], true)).toEqual(['Echo', 'Echo side', 'A']);
    expect(chosenReferences(refs, ['A', 'B', 'C'], true)).toEqual(['Echo', 'Echo side', 'A', 'B']);
  });
});

describe('the Files "Show" chips', () => {
  it('are four, References last, so the row stays one group', () => {
    expect(FILTER_CHIPS.map(c => c.label)).toEqual(['All', 'Generated', 'Stickers', 'References']);
  });
});
