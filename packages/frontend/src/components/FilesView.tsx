/**
 * FilesView — the Files page: the companion's folders, and the shelf the two of them share.
 *
 * Laid out as the Files mock-up:
 *   - A header open onto the room: the page's name, a line on what is here, a search over what is shown, and Upload.
 *   - The places: Shared first (shared/ in the companion's home, the one folder this page changes), then the companion's
 *     home and the other folders the backend lets it read, each with how many things are in it.
 *   - Recent files from all of them, newest first, a picture shown as itself.
 *   - The open folder, as a table (name, kind, modified, size, a menu) or as cards, with a path back up.
 *   - A file opens in a sheet: the picture or the text, and Download; in Shared, Rename and Delete too.
 * Uploads go into the open folder when it is in Shared, else into Shared itself; files can also be dropped on the page.
 * Every surface that stands on the room is one plate class, `fl-plate` (ROUTE_PANELS and the Hedgewitch paper in materials.ts).
 *
 * Backend: GET /api/files/places, /recent, /browse, /read, /raw (a picture inline, any file with &download=1);
 * POST /api/files/shared/{upload,folder,rename,delete}, which refuse anything outside shared/ (as written and as real).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BASE } from '../lib/base';
import { useIdentity } from '../store/identity';
import { useConfirm } from './ConfirmDialog';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Entry { name: string; type: 'directory' | 'file'; size: number; mtime: string; path: string }
type PlaceKind = 'shared' | 'home' | 'workspace' | 'vault' | 'folder';
interface Place { path: string; label: string; kind: PlaceKind; count: number }
interface PlacesResponse {
  shared: { path: string; exists: boolean; count: number };
  places: Array<Place & { kind: Exclude<PlaceKind, 'shared'> }>;
}
type SortKey = 'name' | 'type' | 'modified' | 'size';
type View = 'list' | 'grid';
/** The open file: a picture is shown as itself; text is read; anything else offers its download. */
interface Sheet { entry: Entry; state: 'loading' | 'ready' | 'none' | 'error'; text?: string }

// ─── Kinds ────────────────────────────────────────────────────────────────────

type GlyphName =
  | 'folder' | 'image' | 'doc' | 'pdf' | 'sheet' | 'audio' | 'video' | 'archive' | 'code' | 'text' | 'file'
  | 'shared' | 'home' | 'workspace' | 'vault' | 'upload' | 'download' | 'grid' | 'list' | 'more' | 'close'
  | 'pencil' | 'trash' | 'search' | 'chevron' | 'clock' | 'newfolder' | 'arrow';

const KINDS: Array<[GlyphName, string, string[]]> = [
  ['image', 'Image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'bmp', 'svg', 'tif', 'tiff']],
  ['pdf', 'PDF', ['pdf']],
  ['doc', 'Document', ['doc', 'docx', 'odt', 'rtf', 'pages']],
  ['sheet', 'Spreadsheet', ['xls', 'xlsx', 'ods', 'csv', 'numbers']],
  ['audio', 'Audio', ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'opus']],
  ['video', 'Video', ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v']],
  ['archive', 'Archive', ['zip', 'tar', 'gz', 'tgz', '7z', 'rar']],
  ['text', 'Text', ['txt', 'md', 'markdown', 'log', 'rst']],
  ['code', 'Code', ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'json', 'yaml', 'yml', 'toml', 'ini', 'html', 'css', 'sh', 'ps1', 'sql', 'xml', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'cs', 'php', 'lua']],
];

const extOf = (name: string) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };

function kindOf(e: Pick<Entry, 'name' | 'type'>): { glyph: GlyphName; label: string } {
  if (e.type === 'directory') return { glyph: 'folder', label: 'Folder' };
  const ext = extOf(e.name);
  const kind = KINDS.find(([, , exts]) => exts.includes(ext));
  return kind ? { glyph: kind[0], label: kind[1] } : { glyph: 'file', label: ext ? ext.toUpperCase() : 'File' };
}

/** The pictures /files/raw shows inline (no SVG: it can carry script). */
const PICTURES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif']);
const isPicture = (name: string) => PICTURES.has(extOf(name));
/** Worth asking /files/read for: text, code, a CSV, or a file whose name does not say (the backend refuses binaries). */
const readable = (e: Entry) => {
  const glyph = kindOf(e).glyph;
  return (glyph === 'text' || glyph === 'code' || glyph === 'file' || extOf(e.name) === 'csv') && e.size <= 1024 * 1024;
};

const PLACE_GLYPH: Record<PlaceKind, GlyphName> = { shared: 'shared', home: 'home', workspace: 'workspace', vault: 'vault', folder: 'folder' };

// ─── Helpers ──────────────────────────────────────────────────────────────────

const rawUrl = (path: string, download = false) => `${BASE}/api/files/raw?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`;
const post = (action: 'folder' | 'rename' | 'delete', body: unknown) =>
  fetch(`${BASE}/api/files/shared/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Why the server said no, in words for the notice. */
async function reason(res: Response): Promise<string> {
  if (res.status === 413) return 'it is over 50 MB';
  if (res.status === 429) return 'too many at once, try again in a minute';
  try { const d = await res.json() as { error?: string }; if (d.error) return d.error; } catch { /* not JSON */ }
  return `the server said ${res.status}`;
}

const isWindowsPath = (p: string) => /^[A-Za-z]:\\|^\\\\/.test(p);
const trimSep = (p: string) => p.replace(/[\\/]+$/, '');
/** True when `path` is `root` or inside it (case-blind on Windows, where the backend's paths keep their case). */
function isUnder(path: string, root: string): boolean {
  if (!path || !root) return false;
  const win = isWindowsPath(root);
  const p = trimSep(win ? path.toLowerCase() : path);
  const r = trimSep(win ? root.toLowerCase() : root);
  return p === r || p.startsWith(r + (win ? '\\' : '/'));
}
const parentOf = (path: string) => path.replace(/[\\/][^\\/]+[\\/]*$/, '');

/** The way back up from `dir` to its place, the place named as the page names it. */
function crumbsOf(dir: string, place: Place): Array<{ label: string; path: string }> {
  const sep = isWindowsPath(place.path) ? '\\' : '/';
  const root = trimSep(place.path);
  const out = [{ label: place.label, path: place.path }];
  let at = root;
  for (const part of dir.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    at = `${at}${sep}${part}`;
    out.push({ label: part, path: at });
  }
  return out;
}

function formatSize(bytes: number): string {
  if (bytes == null || Number.isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** "Today, 10:24 AM", "Yesterday, 4:17 PM", else the date, in the reader's own way of writing them. */
function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(d)) / 86_400_000);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return days === 1 ? 'yesterday' : `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

const VIEW_KEY = 'sanctum.files.view';
function readView(): View {
  try { return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list'; } catch { return 'list'; }
}

// ─── Glyphs (line drawings in the ink or the skin's metal) ─────────────────────

function Icon({ name, size = 18 }: { name: GlyphName; size?: number }) {
  const page = <><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>;
  const tray = <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === 'more' ? 2.6 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {name === 'folder' && <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />}
      {name === 'newfolder' && <><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 11v6M9 14h6" /></>}
      {name === 'file' && page}
      {name === 'doc' && <>{page}<path d="M9 13h6M9 17h6" /></>}
      {name === 'text' && <>{page}<path d="M9 12h6M9 15.5h6M9 19h3" /></>}
      {name === 'pdf' && <>{page}<path d="M9 19v-5h1.6a1.5 1.5 0 0 1 0 3H9" /></>}
      {name === 'image' && <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.8" /><path d="m21 16-5-5-9 9" /></>}
      {name === 'sheet' && <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M4 9h16M4 15h16M10 3v18" /></>}
      {name === 'audio' && <><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></>}
      {name === 'video' && <><rect x="3" y="5" width="13" height="14" rx="2" /><path d="m16 10 5-3v10l-5-3" /></>}
      {name === 'archive' && <><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" /></>}
      {name === 'code' && <path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 4l-4 16" />}
      {name === 'shared' && <><path d="M3 13h5l1.5 2.5h5L16 13h5" /><path d="M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z" /></>}
      {name === 'home' && <><path d="M3.5 11 12 3.5 20.5 11" /><path d="M5.5 9.5V20h13V9.5" /><path d="M10 20v-5.5h4V20" /></>}
      {name === 'workspace' && <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18" /></>}
      {name === 'vault' && <><path d="M5 4.5A2.5 2.5 0 0 1 7.5 2H20v17H7.5A2.5 2.5 0 0 0 5 21.5z" /><path d="M5 21.5A2.5 2.5 0 0 1 7.5 19H20" /></>}
      {name === 'upload' && <><path d="M12 16V4M7 9l5-5 5 5" />{tray}</>}
      {name === 'download' && <><path d="M12 4v12M7 11l5 5 5-5" />{tray}</>}
      {name === 'grid' && <><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></>}
      {name === 'list' && <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />}
      {name === 'more' && <path d="M5 12h.01M12 12h.01M19 12h.01" />}
      {name === 'close' && <path d="M6 6l12 12M18 6 6 18" />}
      {name === 'pencil' && <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>}
      {name === 'trash' && <><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></>}
      {name === 'search' && <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>}
      {name === 'chevron' && <path d="M9 18l6-6-6-6" />}
      {name === 'clock' && <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>}
      {name === 'arrow' && <path d="M12 19V5M6 11l6-6 6 6" />}
    </svg>
  );
}

/** A name being typed: a new folder's, or a new name for a file or folder in Shared. Enter keeps it, Escape lets it go. */
function NameField({ value, label, onChange, onSave, onCancel }: {
  value: string; label: string; onChange: (v: string) => void; onSave: () => void; onCancel: () => void;
}) {
  return (
    <form className="fl-namefield" onSubmit={e => { e.preventDefault(); onSave(); }} onClick={e => e.stopPropagation()}>
      <input
        className="fl-input"
        value={value}
        maxLength={180}
        aria-label={label}
        autoFocus
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
      />
      <button className="fl-btn fl-btn-primary hearth-press" type="submit">Save</button>
      <button className="fl-btn hearth-press" type="button" onClick={onCancel}>Cancel</button>
    </form>
  );
}

// ─── FilesView ──────────────────────────────────────────────────────────────────

export function FilesView() {
  const companion = useIdentity().companion_name;
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();

  const [places, setPlaces] = useState<PlacesResponse | null>(null);
  const [placesError, setPlacesError] = useState(false);
  const [recent, setRecent] = useState<Entry[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [listing, setListing] = useState<'loading' | 'ready' | 'error'>('loading');
  const [listError, setListError] = useState('');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>(readView);
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'name', asc: true });
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ key: string; path: string; name: string } | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [tick, setTick] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const shelf = places?.shared.path ?? '';
  const shelfExists = places?.shared.exists ?? false;
  const dir = params.get('in') || shelf;
  const inShelf = useCallback((p: string) => isUnder(p, shelf), [shelf]);
  const refresh = useCallback(() => setTick(t => t + 1), []);

  const allPlaces: Place[] = useMemo(() => places
    ? [{ path: places.shared.path, label: 'Shared', kind: 'shared' as const, count: places.shared.count }, ...places.places]
    : [], [places]);
  // The place the open folder is in: the deepest one holding it (Shared sits inside the companion's home).
  const place = useMemo(() => allPlaces.filter(p => isUnder(dir, p.path)).sort((a, b) => b.path.length - a.path.length)[0], [allPlaces, dir]);
  const uploadDir = inShelf(dir) ? dir : shelf;

  // ─── Loading ───
  useEffect(() => {
    let live = true;
    fetch(`${BASE}/api/files/places`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: PlacesResponse) => { if (live) { setPlaces(d); setPlacesError(false); } })
      .catch(() => { if (live) setPlacesError(true); });
    fetch(`${BASE}/api/files/recent?limit=10`)
      .then(r => (r.ok ? r.json() : { files: [] }))
      .then((d: { files: Array<Omit<Entry, 'type'>> }) => { if (live) setRecent(d.files.map(f => ({ ...f, type: 'file' as const }))); })
      .catch(() => { /* recent files are a nicety; the page stands without them */ });
    return () => { live = false; };
  }, [tick]);

  // `places` itself is new on every refresh; the listing only needs to know it has arrived.
  const placesLoaded = places != null;
  useEffect(() => {
    if (!placesLoaded) return;
    let live = true;
    // The shelf is made by its first upload or folder; until then it is simply empty.
    if (dir === shelf && !shelfExists) { setEntries([]); setListing('ready'); return; }
    setListing('loading');
    fetch(`${BASE}/api/files/browse?path=${encodeURIComponent(dir)}`)
      .then(async r => {
        if (!live) return;
        if (!r.ok) {
          setListError(r.status === 403 ? 'That folder is outside the ones this page can open.'
            : r.status === 404 ? 'That folder is not there any more.' : `Could not open this folder (${r.status}).`);
          setListing('error');
          return;
        }
        const d = await r.json() as { entries?: Entry[] };
        if (live) { setEntries(d.entries ?? []); setListing('ready'); }
      })
      .catch(() => { if (live) { setListError('Could not reach the file service.'); setListing('error'); } });
    return () => { live = false; };
  }, [placesLoaded, dir, shelf, shelfExists, tick]);

  // A notice that something worked fades; one that something failed stays until it is dismissed or replaced.
  useEffect(() => {
    if (!notice || notice.error || busy) return;
    const t = setTimeout(() => setNotice(null), 4500);
    return () => clearTimeout(t);
  }, [notice, busy]);

  // An open actions menu closes on a click elsewhere or Escape.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => { if (!(e.target as Element).closest?.('.fl-actions')) setMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menu]);

  // The sheet takes focus, and Escape closes it (unless the delete question is open over it).
  const sheetPath = sheet?.entry.path;
  useEffect(() => {
    if (!sheetPath) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.cdlg-panel')) setSheet(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sheetPath]);

  // ─── Actions ───
  const go = useCallback((path: string) => {
    setQuery(''); setMenu(null); setRenaming(null); setNewFolder(null);
    setParams(path && path !== shelf ? { in: path } : {});
  }, [setParams, shelf]);

  const open = useCallback((e: Entry) => {
    setMenu(null);
    if (e.type === 'directory') { go(e.path); return; }
    if (isPicture(e.name)) { setSheet({ entry: e, state: 'ready' }); return; }
    if (!readable(e)) { setSheet({ entry: e, state: 'none' }); return; }
    setSheet({ entry: e, state: 'loading' });
    const settle = (next: Sheet) => setSheet(s => (s?.entry.path === e.path ? next : s));
    fetch(`${BASE}/api/files/read?path=${encodeURIComponent(e.path)}`)
      .then(async r => {
        if (r.status === 413 || r.status === 415) { settle({ entry: e, state: 'none' }); return; }
        if (!r.ok) throw new Error(String(r.status));
        const d = await r.json() as { content?: string };
        settle({ entry: e, state: 'ready', text: d.content ?? '' });
      })
      .catch(() => settle({ entry: e, state: 'error' }));
  }, [go]);

  const upload = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length || !shelf) return;
    const target = uploadDir;
    setBusy(true);
    let added = 0;
    const failed: string[] = [];
    for (const [i, f] of list.entries()) {
      setNotice({ text: list.length > 1 ? `Uploading ${i + 1} of ${list.length}…` : `Uploading ${f.name}…`, error: false });
      const form = new FormData();
      form.append('file', f, f.name);
      try {
        const r = await fetch(`${BASE}/api/files/shared/upload?dir=${encodeURIComponent(target)}`, { method: 'POST', body: form });
        if (r.ok) added++; else failed.push(`${f.name}: ${await reason(r)}`);
      } catch {
        failed.push(`${f.name}: could not reach the file service`);
      }
    }
    setBusy(false);
    if (dir !== target) go(target);
    refresh();
    const where = target === shelf ? 'Shared' : target.slice(target.search(/[^\\/]+$/));
    setNotice(failed.length
      ? { text: `${added ? `Added ${added}, but ` : ''}${failed.length === 1 ? 'one did not go in' : `${failed.length} did not go in`}: ${failed.join('; ')}`, error: true }
      : { text: `${added === 1 ? `Added ${list[0].name}` : `Added ${added} files`} to ${where}`, error: false });
  }, [shelf, uploadDir, dir, go, refresh]);

  const saveRename = useCallback(async () => {
    if (!renaming) return;
    const { path, name } = renaming;
    const r = await post('rename', { path, name: name.trim() });
    if (!r.ok) { setNotice({ text: `Could not rename: ${await reason(r)}`, error: true }); return; }
    const { entry } = await r.json() as { entry: Entry };
    setRenaming(null);
    setSheet(s => (s && s.entry.path === path ? { ...s, entry } : s));
    if (isUnder(dir, path)) go(entry.path + dir.slice(path.length));
    refresh();
  }, [renaming, dir, go, refresh]);

  const remove = useCallback(async (e: Entry) => {
    setMenu(null);
    const ok = await confirm({
      title: `Delete ${e.name}?`,
      body: e.type === 'directory' ? 'The folder and everything in it leave Shared. This cannot be undone.' : 'It leaves Shared. This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    const r = await post('delete', { path: e.path });
    if (!r.ok) { setNotice({ text: `Could not delete ${e.name}: ${await reason(r)}`, error: true }); return; }
    setSheet(s => (s && isUnder(s.entry.path, e.path) ? null : s));
    if (isUnder(dir, e.path)) go(parentOf(e.path));
    setNotice({ text: `Deleted ${e.name}`, error: false });
    refresh();
  }, [confirm, dir, go, refresh]);

  const makeFolder = useCallback(async () => {
    const name = (newFolder ?? '').trim();
    if (!name) { setNewFolder(null); return; }
    const r = await post('folder', { dir: uploadDir, name });
    if (!r.ok) { setNotice({ text: `Could not make the folder: ${await reason(r)}`, error: true }); return; }
    setNewFolder(null);
    refresh();
  }, [newFolder, uploadDir, refresh]);

  // ─── What is shown ───
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    const list = q ? entries.filter(e => e.name.toLowerCase().includes(q)) : entries;
    const by: Record<SortKey, (a: Entry, b: Entry) => number> = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
      type: (a, b) => kindOf(a).label.localeCompare(kindOf(b).label) || a.name.localeCompare(b.name),
      modified: (a, b) => a.mtime.localeCompare(b.mtime),
      size: (a, b) => a.size - b.size,
    };
    // Folders always first; then the chosen order.
    return [...list].sort((a, b) => (a.type === b.type ? 0 : a.type === 'directory' ? -1 : 1) || (sort.asc ? 1 : -1) * by[sort.key](a, b));
  }, [entries, q, sort]);
  const recentShown = q ? recent.filter(f => f.name.toLowerCase().includes(q)) : recent;
  const crumbs = place ? crumbsOf(dir, place) : [];
  const shelfCount = places?.shared.count ?? 0;

  const setViewKept = (v: View) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private window: the choice lasts this visit */ }
  };
  const sortBy = (key: SortKey) => setSort(s => ({ key, asc: s.key === key ? !s.asc : key === 'name' || key === 'type' }));
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  /** The ⋯ menu for one entry. `where` keeps a file listed twice (recent and the folder) to one open menu. */
  const actions = (where: string, e: Entry) => {
    const key = `${where}:${e.path}`;
    const mine = inShelf(e.path) && trimSep(e.path) !== trimSep(shelf);
    return (
      <span className="fl-actions">
        <button
          type="button"
          className="fl-icon-btn fl-more"
          aria-label={`More for ${e.name}`}
          aria-haspopup="menu"
          aria-expanded={menu === key}
          onClick={ev => { ev.stopPropagation(); setMenu(m => (m === key ? null : key)); }}
        >
          <Icon name="more" />
        </button>
        {menu === key && (
          <span className="fl-menu" role="menu" onClick={ev => ev.stopPropagation()}>
            {/* A recent card opens its file itself; its menu opens upward in the strip and keeps to what fits there. */}
            {where !== 'recent' && <button type="button" role="menuitem" onClick={() => open(e)}>{e.type === 'directory' ? 'Open' : 'Preview'}</button>}
            {e.type === 'file' && <a role="menuitem" href={rawUrl(e.path, true)} download={e.name} onClick={() => setMenu(null)}>Download</a>}
            {mine && <button type="button" role="menuitem" onClick={() => { setMenu(null); setRenaming({ key, path: e.path, name: e.name }); }}>Rename</button>}
            {mine && <button type="button" role="menuitem" className="fl-danger" onClick={() => void remove(e)}>Delete</button>}
          </span>
        )}
      </span>
    );
  };

  const renameField = (key: string) => renaming?.key === key && (
    <NameField
      value={renaming.name}
      label="New name"
      onChange={name => setRenaming(r => (r ? { ...r, name } : r))}
      onSave={() => void saveRename()}
      onCancel={() => setRenaming(null)}
    />
  );

  const thumb = (e: Entry, size: number) => (
    <span className="fl-thumb">
      {isPicture(e.name) ? <img src={rawUrl(e.path)} alt="" loading="lazy" decoding="async" /> : <Icon name={kindOf(e).glyph} size={size} />}
    </span>
  );

  const sortHead = (key: SortKey, label: string, cls: string) => (
    <th className={cls} aria-sort={sort.key === key ? (sort.asc ? 'ascending' : 'descending') : undefined}>
      <button type="button" className="fl-sort" onClick={() => sortBy(key)}>
        {label}
        {sort.key === key && <span className={`fl-sort-dir${sort.asc ? '' : ' fl-desc'}`}><Icon name="arrow" size={12} /></span>}
      </button>
    </th>
  );

  return (
    <div
      className="fl-root"
      onDragOver={e => { if (!hasFiles(e) || !shelf) return; e.preventDefault(); setDropping(true); }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false); }}
      onDrop={e => { if (!hasFiles(e)) return; e.preventDefault(); setDropping(false); void upload(e.dataTransfer.files); }}
    >
      <div className="fl-scroll">
        {/* ─── Header, open onto the room ─── */}
        <header className="fl-head">
          <div className="fl-head-text">
            <h1 className="fl-title">Files</h1>
            <p className="fl-sub">
              {places
                ? `${places.places.length + 1} places · ${shelfCount} ${shelfCount === 1 ? 'thing' : 'things'} in Shared`
                : placesError ? 'The file service did not answer' : '…'}
            </p>
          </div>
          <div className="fl-tools">
            <label className="fl-search">
              <Icon name="search" size={16} />
              <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search this folder" aria-label="Search this folder and recent files" />
            </label>
            <button
              type="button"
              className="fl-upload hearth-press"
              disabled={!shelf || busy}
              aria-label={`Upload to ${inShelf(dir) && crumbs.length > 1 ? crumbs.map(c => c.label).join(' / ') : 'Shared'}`}
              onClick={() => fileInput.current?.click()}
            >
              <Icon name="upload" size={16} />
              Upload
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={e => { if (e.target.files?.length) void upload(e.target.files); e.target.value = ''; }}
            />
          </div>
        </header>

        {notice && (
          <div className={`fl-notice${notice.error ? ' fl-notice-error' : ''}`} role={notice.error ? 'alert' : 'status'}>
            <span>{notice.text}</span>
            {!busy && <button type="button" className="fl-notice-x" aria-label="Dismiss" onClick={() => setNotice(null)}><Icon name="close" size={14} /></button>}
          </div>
        )}

        {placesError && !places && <p className="fl-quiet">Could not reach the file service. Is the server running?</p>}

        {/* ─── Places ─── */}
        {places && (
          <ul className="fl-places" aria-label="Places">
            {allPlaces.map(p => {
              const current = place?.path === p.path;
              const line = p.kind === 'shared' ? `Between you and ${companion}`
                : p.kind === 'home' ? `Where ${companion} works`
                : p.kind === 'workspace' ? 'Projects and work in progress'
                : p.kind === 'vault' ? 'Notes and saved knowledge'
                : 'A folder you opened to the page';
              const count = p.kind === 'shared' && !shelfExists ? 'Empty' : `${p.count} ${p.count === 1 ? 'item' : 'items'}`;
              return (
                <li key={p.path}>
                  <button type="button" className="fl-place fl-plate hearth-press" aria-current={current ? 'true' : undefined} onClick={() => go(p.path)}>
                    <span className="fl-medal" aria-hidden="true"><Icon name={PLACE_GLYPH[p.kind]} size={22} /></span>
                    <span className="fl-place-text">
                      <span className="fl-place-title">{p.label}</span>
                      <span className="fl-place-line">{line}</span>
                      <span className="fl-place-count">{count}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* ─── Recent files ─── */}
        {recentShown.length > 0 && (
          <section className="fl-section" aria-label="Recent files">
            <div className="fl-section-head">
              <Icon name="clock" size={20} />
              <h2 className="fl-section-title">Recent files</h2>
            </div>
            <ul className="fl-recent">
              {recentShown.map(f => {
                const key = `recent:${f.path}`;
                return (
                  <li key={f.path} className="fl-tile fl-plate">
                    <button type="button" className="fl-tile-open" onClick={() => open(f)}>
                      {thumb(f, 34)}
                      <span className="fl-tile-foot">
                        <span className="fl-glyph"><Icon name={kindOf(f).glyph} /></span>
                        <span className="fl-tile-text">
                          <span className="fl-tile-name">{f.name}</span>
                          <span className="fl-meta">Edited {ago(f.mtime)}</span>
                        </span>
                      </span>
                    </button>
                    {actions('recent', f)}
                    {renaming?.key === key && <div className="fl-tile-rename">{renameField(key)}</div>}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* ─── The open folder ─── */}
        {places && (
          <section className="fl-panel fl-plate" aria-label="Folder">
            <div className="fl-panel-head">
              <span className="fl-glyph"><Icon name={place ? PLACE_GLYPH[place.kind] : 'folder'} size={20} /></span>
              <nav className="fl-crumbs" aria-label="Folder path">
                {crumbs.map((c, i) => (
                  <React.Fragment key={c.path}>
                    {i > 0 && <span className="fl-crumb-sep" aria-hidden="true"><Icon name="chevron" size={13} /></span>}
                    <button type="button" className="fl-crumb" aria-current={i === crumbs.length - 1 ? 'page' : undefined} onClick={() => go(c.path)}>{c.label}</button>
                  </React.Fragment>
                ))}
              </nav>
              <div className="fl-panel-tools">
                {inShelf(dir) && (
                  <button type="button" className="fl-btn hearth-press" onClick={() => setNewFolder(n => (n == null ? '' : null))} aria-expanded={newFolder != null}>
                    <Icon name="newfolder" size={16} />
                    <span className="fl-btn-label">New folder</span>
                  </button>
                )}
                <span className="fl-toggle" role="group" aria-label="Show as">
                  <button type="button" aria-pressed={view === 'list'} aria-label="List" onClick={() => setViewKept('list')}><Icon name="list" size={16} /></button>
                  <button type="button" aria-pressed={view === 'grid'} aria-label="Cards" onClick={() => setViewKept('grid')}><Icon name="grid" size={16} /></button>
                </span>
              </div>
            </div>

            {newFolder != null && (
              <div className="fl-newfolder">
                <span className="fl-glyph"><Icon name="folder" /></span>
                <NameField value={newFolder} label="New folder name" onChange={setNewFolder} onSave={() => void makeFolder()} onCancel={() => setNewFolder(null)} />
              </div>
            )}

            {listing === 'loading' ? (
              <p className="fl-quiet-in">Opening…</p>
            ) : listing === 'error' ? (
              <p className="fl-quiet-in">{listError}</p>
            ) : shown.length === 0 ? (
              <p className="fl-quiet-in">
                {q ? `Nothing here matches “${query.trim()}”.`
                  : inShelf(dir) ? `Nothing here yet. Upload a file or drop it on the page, or ask ${companion} to leave one here.`
                  : 'This folder is empty.'}
              </p>
            ) : view === 'list' ? (
              <table className="fl-table">
                <thead>
                  <tr>
                    {sortHead('name', 'Name', 'fl-c-name')}
                    {sortHead('type', 'Type', 'fl-c-type')}
                    {sortHead('modified', 'Modified', 'fl-c-mod')}
                    {sortHead('size', 'Size', 'fl-c-size')}
                    <th className="fl-c-act"><span className="fl-sr">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map(e => {
                    const key = `list:${e.path}`;
                    const kind = kindOf(e);
                    return (
                      <tr key={e.path} className="fl-row" onClick={() => renaming?.key !== key && open(e)}>
                        <td className="fl-c-name">
                          {renaming?.key === key ? renameField(key) : (
                            <button type="button" className="fl-name" onClick={ev => { ev.stopPropagation(); open(e); }}>
                              <span className="fl-glyph"><Icon name={kind.glyph} /></span>
                              <span className="fl-name-text">
                                <span className="fl-name-label">{e.name}</span>
                                <span className="fl-row-meta fl-meta">{[kind.label, e.type === 'file' ? formatSize(e.size) : '', when(e.mtime)].filter(Boolean).join(' · ')}</span>
                              </span>
                            </button>
                          )}
                        </td>
                        <td className="fl-c-type">{kind.label}</td>
                        <td className="fl-c-mod">{when(e.mtime)}</td>
                        <td className="fl-c-size">{e.type === 'file' ? formatSize(e.size) : '—'}</td>
                        <td className="fl-c-act">{actions('list', e)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <ul className="fl-grid">
                {shown.map(e => {
                  const key = `grid:${e.path}`;
                  return (
                    <li key={e.path} className="fl-cell">
                      <button type="button" className="fl-tile-open" onClick={() => open(e)}>
                        {thumb(e, 30)}
                        <span className="fl-tile-foot">
                          <span className="fl-tile-text">
                            <span className="fl-tile-name">{e.name}</span>
                            <span className="fl-meta">{e.type === 'file' ? `${formatSize(e.size)} · ${ago(e.mtime)}` : `Folder · ${ago(e.mtime)}`}</span>
                          </span>
                        </span>
                      </button>
                      {actions('grid', e)}
                      {renaming?.key === key && <div className="fl-tile-rename">{renameField(key)}</div>}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </div>

      {dropping && <div className="fl-drop" aria-hidden="true">Drop to add to {inShelf(dir) && crumbs.length > 1 ? crumbs[crumbs.length - 1].label : 'Shared'}</div>}

      {/* ─── The open file ─── */}
      {sheet && (() => {
        const e = sheet.entry;
        const kind = kindOf(e);
        const mine = inShelf(e.path);
        const key = `sheet:${e.path}`;
        return (
          <div className="fl-scrim" onMouseDown={ev => { if (ev.target === ev.currentTarget) setSheet(null); }}>
            <div className="fl-sheet fl-plate" role="dialog" aria-modal="true" aria-label={e.name}>
              <header className="fl-sheet-head">
                <span className="fl-glyph"><Icon name={kind.glyph} size={22} /></span>
                <span className="fl-sheet-title">
                  <span className="fl-sheet-name">{e.name}</span>
                  <span className="fl-meta">{[kind.label, formatSize(e.size), when(e.mtime)].filter(Boolean).join(' · ')}</span>
                </span>
                <button ref={closeRef} type="button" className="fl-icon-btn" aria-label="Close" onClick={() => setSheet(null)}><Icon name="close" /></button>
              </header>
              <div className="fl-sheet-body">
                {isPicture(e.name) ? <img className="fl-sheet-pic" src={rawUrl(e.path)} alt={e.name} />
                  : sheet.state === 'loading' ? <p className="fl-quiet-in">Opening…</p>
                  : sheet.state === 'ready' ? <pre className="fl-sheet-text">{sheet.text}</pre>
                  : sheet.state === 'none' ? <p className="fl-quiet-in">There is no preview for this kind of file here. Download it to open it on this device.</p>
                  : <p className="fl-quiet-in">Could not open this file.</p>}
              </div>
              <footer className="fl-sheet-foot">
                {renaming?.key === key ? renameField(key) : (
                  <>
                    {mine && <button type="button" className="fl-btn fl-btn-danger hearth-press" onClick={() => void remove(e)}><Icon name="trash" size={16} />Delete</button>}
                    {mine && <button type="button" className="fl-btn hearth-press" onClick={() => setRenaming({ key, path: e.path, name: e.name })}><Icon name="pencil" size={16} />Rename</button>}
                    <a className="fl-btn fl-btn-primary hearth-press" href={rawUrl(e.path, true)} download={e.name}><Icon name="download" size={16} />Download</a>
                  </>
                )}
              </footer>
            </div>
          </div>
        );
      })()}

      <style>{`
        .fl-root { position: relative; height: 100%; min-width: 0; }
        .fl-scroll {
          height: 100%;
          overflow-y: auto;
          padding: 0 1.25rem calc(env(safe-area-inset-bottom, 0px) + 3rem);
          display: flex;
          flex-direction: column;
          gap: 1.1rem;
          min-width: 0;
        }

        /* ── header: open onto the room, as Notes, Home's welcome and the Command center's day ── */
        .fl-head {
          position: relative;
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          flex-wrap: wrap;
          gap: 1rem 1.5rem;
          padding: 1.5rem clamp(0.5rem, 3vw, 2.5rem) 0.25rem;
          isolation: isolate;
        }
        .fl-head::before {
          content: '';
          position: absolute;
          inset: 0;
          z-index: -1;
          pointer-events: none;
          background: radial-gradient(ellipse 40% 80% at 18% 55%,
            color-mix(in srgb, var(--surface-chrome, #2c1a10) 60%, transparent) 0%,
            color-mix(in srgb, var(--surface-chrome, #2c1a10) 30%, transparent) 50%,
            transparent 75%);
        }
        .fl-title {
          margin: 0;
          font: 600 clamp(2.2rem, 3.6vw, 3.1rem)/1.05 'Cormorant Garamond', 'EB Garamond', Georgia, serif;
          color: var(--home-head-text, #f6eedb);
          text-shadow: 0 2px 18px rgba(0, 0, 0, 0.85), 0 1px 3px rgba(0, 0, 0, 0.7);
        }
        .fl-sub {
          margin: 0.3rem 0 0;
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 1rem;
          color: var(--home-head-text, #f6eedb);
          text-shadow: 0 1px 10px rgba(0, 0, 0, 0.9);
        }
        .fl-tools { display: flex; align-items: center; gap: 0.6rem; min-width: 0; }
        .fl-search {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          width: 20rem;
          max-width: 100%;
          min-width: 0;
          padding: 0.5rem 0.9rem;
          border-radius: 999px;
          background: var(--settings-field-bg, var(--surface-chrome-deep, #1a120c));
          border: 1px solid color-mix(in srgb, var(--skin-trim, #c9a87c) 55%, transparent);
          color: var(--settings-field-text, var(--surface-chrome-text, #efe4d0));
        }
        .fl-search svg { flex-shrink: 0; color: var(--skin-trim, currentColor); }
        .fl-search input {
          flex: 1;
          min-width: 0;
          background: none;
          border: 0;
          outline: none;
          color: inherit;
          font-family: var(--font-serif, 'Lora', serif);
          font-size: 0.95rem;
        }
        .fl-search input::placeholder { color: var(--settings-field-placeholder, var(--surface-chrome-muted, #cbbfa9)); }
        .fl-search:focus-within { outline: 2px solid var(--focus-ring-chrome, var(--focus-ring, #e9c688)); outline-offset: 2px; }
        .fl-upload {
          display: inline-flex;
          align-items: center;
          gap: 0.45rem;
          flex-shrink: 0;
          white-space: nowrap;
          padding: 0.5rem 1.1rem;
          border-radius: 999px;
          background: var(--chip-bg, var(--surface-chrome, #2c1a10));
          border: 1px solid color-mix(in srgb, var(--skin-trim, #c9a87c) 70%, transparent);
          color: var(--menu-ink, var(--surface-chrome-text, #efe4d0));
          font-family: var(--font-serif, 'Lora', serif);
          font-size: 0.95rem;
          cursor: pointer;
        }
        .fl-upload svg { color: var(--skin-trim, currentColor); }
        .fl-upload:disabled { opacity: 0.6; cursor: default; }
        .fl-notice {
          align-self: flex-start;
          display: inline-flex;
          align-items: center;
          gap: 0.6rem;
          max-width: calc(100% - 1rem);
          margin: -0.4rem clamp(0.5rem, 3vw, 2.5rem) 0;
          padding: 0.4rem 0.5rem 0.4rem 0.95rem;
          border-radius: 999px;
          background: var(--chip-bg, var(--surface-chrome, #2c1a10));
          border: 1px solid color-mix(in srgb, var(--skin-trim, #c9a87c) 70%, transparent);
          color: var(--menu-ink, var(--surface-chrome-text, #efe4d0));
          font-family: var(--font-serif, 'Lora', serif);
          font-size: 0.92rem;
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
        }
        .fl-notice-error { border-radius: 10px; border-width: 2px; }
        .fl-notice-x { display: inline-grid; place-items: center; width: 1.6rem; height: 1.6rem; border-radius: 50%; background: none; border: 0; color: inherit; cursor: pointer; flex-shrink: 0; }
        .fl-quiet {
          margin: 0;
          padding: 0 clamp(0.5rem, 3vw, 2.5rem);
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          color: var(--home-head-text, #f6eedb);
          text-shadow: 0 1px 10px rgba(0, 0, 0, 0.9);
        }

        /* ── plates: the route's plate (materials.ts), a faint wash where no skin draws one ── */
        .fl-plate {
          position: relative;
          border-radius: 6px;
          border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
          background: rgba(255, 255, 255, 0.02);
          color: var(--text-primary, #efe4d0);
          min-width: 0;
        }
        .fl-glyph { display: inline-flex; flex-shrink: 0; color: var(--skin-trim, var(--text-muted, #a09689)); }
        .fl-meta { font-family: var(--font-serif, 'Lora', serif); font-size: 0.82rem; color: var(--text-muted, #a09689); }
        .fl-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

        /* ── places: Home's ways in, a medallion in the skin's metal and the place's name ── */
        .fl-places { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(13.5rem, 1fr)); gap: 1rem; }
        .fl-place {
          display: flex;
          align-items: center;
          gap: 0.85rem;
          width: 100%;
          height: 100%;
          padding: 1rem 1.1rem;
          text-align: left;
          font: inherit;
          cursor: pointer;
          box-shadow: var(--panel-shadow, 0 10px 30px rgba(20, 10, 5, 0.35));
        }
        /* The open place is ringed in the skin's own metal. */
        .fl-place[aria-current="true"]::after {
          content: '';
          position: absolute;
          inset: -5px;
          border: 2px solid var(--skin-trim, var(--text-primary, #efe4d0));
          border-radius: 9px;
          pointer-events: none;
        }
        .fl-place:focus-visible { outline: 2px solid var(--focus-ring-chrome, var(--focus-ring, #e6dac3)); outline-offset: 7px; }
        .fl-medal {
          display: grid;
          place-items: center;
          width: 3rem;
          height: 3rem;
          flex-shrink: 0;
          border-radius: 50%;
          background: radial-gradient(circle at 50% 35%,
            color-mix(in srgb, var(--surface-chrome, #2c1a10) 78%, var(--skin-trim, #d4a843)) 0%,
            var(--surface-chrome, #2c1a10) 70%);
          border: 1.5px solid var(--skin-trim, var(--surface-chrome-muted, #d9cdb6));
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--skin-trim, #d4a843) 18%, transparent), 0 4px 12px rgba(0, 0, 0, 0.35);
          color: var(--skin-trim, var(--surface-chrome-text, #efe4d0));
        }
        .fl-place-text { display: flex; flex-direction: column; gap: 0.12rem; min-width: 0; }
        .fl-place-title { font-family: var(--font-serif, 'Lora', Georgia, serif); font-size: 1.15rem; line-height: 1.2; color: var(--text-primary, #efe4d0); overflow-wrap: anywhere; }
        .fl-place-line { font-size: 0.85rem; line-height: 1.35; color: var(--text-secondary, #dccfb8); }
        .fl-place-count {
          margin-top: 0.2rem;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.68rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--text-muted, #a09689);
        }

        /* ── section headings on the room ── */
        .fl-section { display: flex; flex-direction: column; gap: 0.6rem; min-width: 0; container-type: inline-size; }
        .fl-section-head { display: flex; align-items: center; gap: 0.55rem; padding: 0 clamp(0.25rem, 1vw, 0.5rem); color: var(--home-head-text, #f6eedb); }
        .fl-section-head svg { color: var(--skin-trim, currentColor); filter: drop-shadow(0 1px 4px rgba(0, 0, 0, 0.8)); }
        .fl-section-title {
          margin: 0;
          font: 600 1.55rem/1.1 'Cormorant Garamond', 'EB Garamond', Georgia, serif;
          color: var(--home-head-text, #f6eedb);
          text-shadow: 0 1px 10px rgba(0, 0, 0, 0.9), 0 1px 3px rgba(0, 0, 0, 0.7);
        }

        /* ── recent files: one row of cards, a picture shown as itself ── */
        .fl-recent {
          list-style: none;
          margin: 0;
          padding: 0.2rem 0.2rem 0.6rem;
          display: grid;
          grid-auto-flow: column;
          /* Four across the section; more scroll in from the side (a minmax would stay at its minimum once they overflow). */
          grid-auto-columns: max(14.5rem, calc((100cqi - 3.4rem) / 4));
          gap: 1rem;
          overflow-x: auto;
          scroll-snap-type: x proximity;
        }
        .fl-tile { scroll-snap-align: start; box-shadow: var(--panel-shadow, 0 10px 30px rgba(20, 10, 5, 0.35)); }
        .fl-tile-open {
          display: flex;
          flex-direction: column;
          width: 100%;
          height: 100%;
          padding: 0;
          border: 0;
          background: none;
          color: inherit;
          font: inherit;
          text-align: left;
          cursor: pointer;
        }
        .fl-tile-open:focus-visible { outline: 2px solid var(--focus-ring-chrome, var(--focus-ring, #e6dac3)); outline-offset: 2px; border-radius: inherit; }
        /* A framed plate (Celestial) keeps its fittings clear: the picture sits inside them, as in a mount. */
        .fl-thumb {
          display: grid;
          place-items: center;
          height: 7.25rem;
          margin: max(6px, var(--plate-corner, 0px)) max(6px, var(--plate-corner, 0px)) 0;
          border-radius: 4px;
          overflow: hidden;
          background: color-mix(in srgb, currentColor 7%, transparent);
          color: var(--skin-trim, var(--text-muted, #a09689));
        }
        .fl-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
        .fl-tile-foot { display: flex; align-items: center; gap: 0.6rem; min-width: 0; padding: 0.7rem 3rem 0.8rem max(0.9rem, var(--plate-corner, 0px)); }
        .fl-tile-text { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
        .fl-tile-name {
          font-family: var(--font-serif, 'Lora', serif);
          font-size: 0.98rem;
          color: var(--text-primary, #efe4d0);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .fl-tile .fl-actions, .fl-cell .fl-actions { position: absolute; right: max(0.45rem, calc(var(--plate-corner, 0px) - 0.2rem)); bottom: 0.65rem; }
        /* In the strip the menu opens upward, inside the card: the strip scrolls sideways and would clip it below. */
        .fl-recent .fl-menu { top: auto; bottom: calc(100% + 4px); }
        .fl-tile-rename { padding: 0 0.75rem 0.75rem; }

        /* ── the open folder ── */
        .fl-panel { padding: 0.9rem max(1.1rem, calc(var(--plate-corner, 0px) + 0.25rem)) 1rem; }
        .fl-panel-head {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          flex-wrap: wrap;
          padding-bottom: 0.7rem;
          border-bottom: 1px solid color-mix(in srgb, var(--skin-trim, rgba(255, 255, 255, 0.3)) 30%, transparent);
        }
        .fl-crumbs { display: flex; align-items: center; flex-wrap: wrap; gap: 0.1rem; flex: 1; min-width: 0; }
        .fl-crumb {
          padding: 0.1rem 0.3rem;
          border-radius: 4px;
          border: 0;
          background: none;
          color: var(--text-secondary, #dccfb8);
          font: 500 1.35rem/1.2 'Cormorant Garamond', 'EB Garamond', Georgia, serif;
          cursor: pointer;
          overflow-wrap: anywhere;
          text-align: left;
        }
        .fl-crumb:hover { text-decoration: underline; text-underline-offset: 3px; }
        .fl-crumb[aria-current="page"] { color: var(--text-primary, #efe4d0); font-weight: 600; }
        .fl-crumb-sep { display: inline-flex; color: var(--text-muted, #a09689); }
        .fl-panel-tools { display: flex; align-items: center; gap: 0.5rem; margin-left: auto; }
        .fl-toggle {
          display: inline-flex;
          border: 1px solid color-mix(in srgb, var(--skin-trim, #c9a87c) 55%, transparent);
          border-radius: 6px;
          overflow: hidden;
        }
        .fl-toggle button { display: inline-grid; place-items: center; padding: 0.4rem 0.55rem; border: 0; background: none; color: var(--text-muted, #a09689); cursor: pointer; }
        .fl-toggle button[aria-pressed="true"] { background: color-mix(in srgb, var(--skin-trim, #c9a87c) 24%, transparent); color: var(--text-primary, #efe4d0); }
        .fl-newfolder { display: flex; align-items: center; gap: 0.6rem; padding: 0.7rem 0.5rem 0.2rem; }
        .fl-quiet-in {
          margin: 0;
          padding: 1.4rem 0.5rem 0.6rem;
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          color: var(--text-muted, #a09689);
        }

        .fl-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
        .fl-table th {
          padding: 0.75rem 0.5rem 0.45rem;
          text-align: left;
          font-weight: 400;
        }
        .fl-sort {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          padding: 0;
          border: 0;
          background: none;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.7rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--text-muted, #a09689);
          cursor: pointer;
        }
        .fl-sort-dir { display: inline-flex; }
        .fl-desc { transform: rotate(180deg); }
        .fl-table td {
          padding: 0.5rem;
          border-top: 1px solid color-mix(in srgb, var(--skin-trim, rgba(255, 255, 255, 0.3)) 18%, transparent);
          font-family: var(--font-serif, 'Lora', serif);
          font-size: 0.9rem;
          color: var(--text-secondary, #dccfb8);
          vertical-align: middle;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .fl-table td.fl-c-act, .fl-table td.fl-c-name { overflow: visible; }
        .fl-c-type { width: 8.5rem; }
        .fl-c-mod { width: 11.5rem; }
        .fl-c-size { width: 6rem; }
        .fl-c-act { width: 3rem; text-align: right; }
        .fl-row { cursor: pointer; }
        .fl-row:hover td { background: color-mix(in srgb, currentColor 6%, transparent); }
        .fl-name {
          display: flex;
          align-items: center;
          gap: 0.65rem;
          max-width: 100%;
          min-width: 0;
          padding: 0.1rem 0;
          border: 0;
          background: none;
          color: var(--text-primary, #efe4d0);
          font: inherit;
          font-size: 1rem;
          text-align: left;
          cursor: pointer;
        }
        .fl-name-text { display: flex; flex-direction: column; min-width: 0; }
        .fl-name-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .fl-row-meta { display: none; }

        .fl-grid { list-style: none; margin: 0.9rem 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); gap: 0.85rem; }
        /* Cards inside the panel are not plates of their own: a hairline in the metal, and no fittings to keep clear of. */
        .fl-cell {
          --plate-corner: 0px;
          position: relative;
          min-width: 0;
          border-radius: 5px;
          border: 1px solid color-mix(in srgb, var(--skin-trim, rgba(255, 255, 255, 0.3)) 35%, transparent);
        }
        .fl-cell .fl-thumb { height: 6.5rem; }
        .fl-cell .fl-tile-foot { padding: 0.55rem 2.7rem 0.65rem 0.7rem; }
        .fl-cell .fl-tile-name { font-size: 0.92rem; }
        .fl-cell .fl-meta { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .fl-cell .fl-actions { right: 0.3rem; bottom: 0.45rem; }

        /* ── buttons, menus and names being typed ── */
        .fl-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.42rem 0.95rem;
          border-radius: 6px;
          border: 1px solid color-mix(in srgb, var(--skin-trim, #c9a87c) 55%, transparent);
          background: transparent;
          color: var(--text-primary, #efe4d0);
          font-family: var(--font-serif, 'Lora', serif);
          font-size: 0.92rem;
          text-decoration: none;
          white-space: nowrap;
          cursor: pointer;
        }
        .fl-btn svg { color: var(--skin-trim, currentColor); }
        .fl-btn-primary { border-color: var(--skin-trim, #c9a87c); font-weight: 600; }
        .fl-btn-danger, .fl-btn-danger svg { color: var(--status-error-text, #e08a7a); }
        .fl-icon-btn {
          display: inline-grid;
          place-items: center;
          width: 2.1rem;
          height: 2.1rem;
          flex-shrink: 0;
          border-radius: 50%;
          border: 1px solid transparent;
          background: none;
          color: var(--text-secondary, #dccfb8);
          cursor: pointer;
        }
        .fl-icon-btn:hover, .fl-icon-btn[aria-expanded="true"] { border-color: color-mix(in srgb, var(--skin-trim, #c9a87c) 60%, transparent); }
        .fl-actions { position: relative; display: inline-flex; }
        .fl-actions:has(.fl-menu) { z-index: 20; }
        .fl-menu {
          position: absolute;
          right: 0;
          top: calc(100% + 4px);
          z-index: 20;
          display: flex;
          flex-direction: column;
          min-width: 10rem;
          padding: 0.3rem;
          border-radius: 6px;
          background: var(--bg-surface, #1a120c);
          border: 1px solid var(--skin-trim, var(--border, rgba(255, 255, 255, 0.2)));
          box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
        }
        .fl-menu > * {
          display: block;
          padding: 0.5rem 0.75rem;
          border: 0;
          border-radius: 4px;
          background: none;
          color: var(--text-primary, #efe4d0);
          font-family: var(--font-serif, 'Lora', serif);
          font-size: 0.92rem;
          text-align: left;
          text-decoration: none;
          white-space: nowrap;
          cursor: pointer;
        }
        .fl-menu > *:hover, .fl-menu > *:focus-visible { background: color-mix(in srgb, currentColor 12%, transparent); }
        .fl-menu .fl-danger { color: var(--status-error-text, #e08a7a); }
        .fl-namefield { display: flex; align-items: center; gap: 0.45rem; flex: 1; min-width: 0; flex-wrap: wrap; }
        .fl-input {
          flex: 1;
          min-width: 8rem;
          padding: 0.4rem 0.65rem;
          border-radius: 6px;
          background: var(--settings-field-bg, var(--surface-chrome-deep, #1a120c));
          border: 1px solid var(--settings-field-border, var(--control-border, #8a7c66));
          color: var(--settings-field-text, var(--surface-chrome-text, #efe4d0));
          font-family: var(--font-serif, 'Lora', serif);
          font-size: 0.95rem;
        }

        /* ── the open file ── */
        .fl-scrim {
          position: fixed;
          inset: 0;
          z-index: 900;
          display: grid;
          place-items: center;
          padding: 1.25rem;
          background: rgba(8, 6, 4, 0.62);
          backdrop-filter: blur(3px);
        }
        .fl-sheet {
          display: flex;
          flex-direction: column;
          width: min(56rem, 100%);
          max-height: min(88vh, 100%);
          padding: 1rem max(1.2rem, calc(var(--plate-corner, 0px) + 0.3rem));
          box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
        }
        .fl-sheet-head, .fl-sheet-foot { display: flex; align-items: center; gap: 0.7rem; }
        .fl-sheet-head { padding-bottom: 0.75rem; border-bottom: 1px solid color-mix(in srgb, var(--skin-trim, rgba(255, 255, 255, 0.3)) 30%, transparent); }
        .fl-sheet-title { display: flex; flex-direction: column; gap: 0.1rem; flex: 1; min-width: 0; }
        .fl-sheet-name { font: 600 1.45rem/1.2 'Cormorant Garamond', 'EB Garamond', Georgia, serif; color: var(--text-primary, #efe4d0); overflow-wrap: anywhere; }
        .fl-sheet-body { flex: 1; min-height: 0; overflow: auto; display: grid; place-items: center; padding: 1rem 0; }
        .fl-sheet-pic { display: block; max-width: 100%; max-height: 64vh; object-fit: contain; border-radius: 4px; }
        .fl-sheet-text {
          place-self: stretch;
          margin: 0;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.8rem;
          line-height: 1.6;
          color: var(--text-secondary, #dccfb8);
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .fl-sheet-foot { justify-content: flex-end; flex-wrap: wrap; padding-top: 0.75rem; border-top: 1px solid color-mix(in srgb, var(--skin-trim, rgba(255, 255, 255, 0.3)) 30%, transparent); }

        .fl-drop {
          position: absolute;
          inset: 0.75rem;
          z-index: 30;
          display: grid;
          place-items: center;
          border: 2px dashed var(--skin-trim, #c9a87c);
          border-radius: 10px;
          background: color-mix(in srgb, var(--surface-chrome, #2c1a10) 92%, transparent);
          color: var(--surface-chrome-text, #efe4d0);
          font: 600 1.7rem 'Cormorant Garamond', 'EB Garamond', Georgia, serif;
          pointer-events: none;
        }

        @media (max-width: 768px) {
          .fl-scroll { padding: 0 0.6rem calc(env(safe-area-inset-bottom, 0px) + 3rem); gap: 0.85rem; }
          .fl-head { padding: 1rem 0.25rem 0.25rem; align-items: stretch; }
          .fl-title { font-size: 2.1rem; }
          .fl-tools { width: 100%; }
          .fl-search { flex: 1; width: auto; }
          .fl-upload { padding: 0.5rem 0.85rem; }
          .fl-notice { margin: -0.3rem 0.25rem 0; }
          .fl-places { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.6rem; }
          .fl-place { padding: 0.7rem 0.75rem; gap: 0.6rem; }
          .fl-medal { width: 2.2rem; height: 2.2rem; }
          .fl-medal svg { width: 17px; height: 17px; }
          .fl-place-title { font-size: 0.98rem; }
          .fl-place-line { display: none; }
          .fl-section-title { font-size: 1.35rem; }
          .fl-recent { grid-auto-columns: 13rem; gap: 0.65rem; }
          .fl-thumb { height: 6.5rem; }
          /* The picture or the big glyph already says what kind of file it is; the name gets the room. */
          .fl-tile-foot .fl-glyph { display: none; }
          .fl-tile-foot { padding: 0.6rem 2.6rem 0.7rem max(0.8rem, var(--plate-corner, 0px)); }
          .fl-tile .fl-meta { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .fl-panel { padding: 0.75rem max(0.8rem, calc(var(--plate-corner, 0px) + 0.1rem)) 0.8rem; }
          .fl-crumb { font-size: 1.15rem; }
          .fl-btn-label { display: none; }
          .fl-c-type, .fl-c-mod, .fl-c-size { display: none; }
          .fl-row-meta { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .fl-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.6rem; }
          .fl-scrim { padding: 0.5rem; }
          .fl-sheet { max-height: 92vh; }
        }
      `}</style>
    </div>
  );
}
