// Google API helpers — read AND write wrappers over the authed OAuth2Client from
// google-auth.ts. Each helper resolves the RIGHT account via the app's binding
// (requireAppClient) so it acts on the bound account automatically.
//
// SAFETY INVARIANTS baked in here (non-negotiable):
//   - NO permanent deletion anywhere. Gmail = trash only (users.messages.trash);
//     never delete / batchDelete / emptyTrash. Calendar removal = the reversible
//     cancel (events.delete moves to the bin, recoverable for ~30 days). No
//     "permanently purge" path is exposed.
//   - Write-scope gating: a write helper checks the SPECIFIC scope it needs is
//     granted on the bound account and throws GoogleScopeNotGrantedError with the
//     missing scope BEFORE hitting Google — so callers surface an actionable
//     "re-grant in Settings" message, not a raw Google 403.

import { google } from 'googleapis';
import {
  getClientForApp,
  accountForApp,
  isScopeGranted,
  isWriteScopeGranted,
  GoogleAppNotBoundError,
  type GoogleApp,
} from './google-auth.js';
import { getDb } from './db.js';
import { tenantLocal } from '../tenancy/context.js';

// ---------------------------------------------------------------------------
// Sentinels (caught by the MCP to print friendly, actionable strings)
// ---------------------------------------------------------------------------

/** Thrown when an app has no connected account behind it yet — either Google
 *  isn't connected at all, or this app isn't enabled/bound to an account. */
export class GoogleNotConnectedError extends Error {
  constructor() {
    super('Google is not connected');
    this.name = 'GoogleNotConnectedError';
  }
}

/** Thrown when an app is enabled+bound but a required OAuth scope hasn't been
 *  granted yet on the bound account. `scope` (when set) is the specific missing
 *  scope — used to tell the user exactly which capability needs a re-grant. */
export class GoogleScopeNotGrantedError extends Error {
  constructor(
    public readonly app: GoogleApp,
    public readonly scope?: string
  ) {
    super(`Google ${app} access not granted`);
    this.name = 'GoogleScopeNotGrantedError';
  }
}

// ---------------------------------------------------------------------------
// Shared preconditions
// ---------------------------------------------------------------------------

/** READ precondition: the app must be enabled+bound to a connected account, and
 *  that account must have the app's FULL scope set granted. Returns the resolved
 *  authed client for the bound account. */
async function requireAppClient(app: GoogleApp) {
  if (!accountForApp(app)) throw new GoogleNotConnectedError();
  if (!isScopeGranted(app)) throw new GoogleScopeNotGrantedError(app);
  try {
    return await getClientForApp(app);
  } catch (err) {
    if (err instanceof GoogleAppNotBoundError) throw new GoogleNotConnectedError();
    throw err;
  }
}

/** WRITE precondition: like requireAppClient, but additionally requires a SPECIFIC
 *  write scope so a precise re-grant message can be shown (e.g. the documents scope
 *  may be missing on a Docs-bound account). The app must be bound to a connected
 *  account first; then the specific scope must be granted. */
async function requireWriteClient(app: GoogleApp, scope: string) {
  if (!accountForApp(app)) throw new GoogleNotConnectedError();
  if (!isWriteScopeGranted(app, scope)) throw new GoogleScopeNotGrantedError(app, scope);
  try {
    return await getClientForApp(app);
  } catch (err) {
    if (err instanceof GoogleAppNotBoundError) throw new GoogleNotConnectedError();
    throw err;
  }
}

// ===========================================================================
// Calendar — scope: calendar (read + write)
// ===========================================================================

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string | null; // ISO datetime, or YYYY-MM-DD for all-day
  end: string | null;
  location: string | null;
  allDay: boolean;
  status?: string | null;
  htmlLink?: string | null;
}

/** List upcoming events from the primary calendar. */
export async function listUpcomingEvents(opts: {
  maxResults?: number;
  timeMin?: string;
  timeMax?: string;
} = {}): Promise<CalendarEvent[]> {
  const auth = await requireAppClient('calendar');
  const calendar = google.calendar({ version: 'v3', auth });

  const maxResults = Math.min(Math.max(opts.maxResults ?? 10, 1), 50);
  const timeMin = opts.timeMin ?? new Date().toISOString();

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax: opts.timeMax,
    maxResults,
    singleEvents: true,
    orderBy: 'startTime',
  });

  return (res.data.items ?? []).map(mapCalendarEvent);
}

/** Create an event on the primary calendar. Times: either dateTime (ISO, with an
 *  optional timeZone) or all-day date (YYYY-MM-DD). */
export async function createCalendarEvent(opts: {
  summary: string;
  start: string; // ISO dateTime or YYYY-MM-DD
  end: string; // ISO dateTime or YYYY-MM-DD
  allDay?: boolean;
  location?: string;
  description?: string;
  timeZone?: string;
}): Promise<CalendarEvent> {
  const auth = await requireWriteClient('calendar', CALENDAR_SCOPE);
  const calendar = google.calendar({ version: 'v3', auth });

  const startPoint = opts.allDay ? { date: opts.start } : { dateTime: opts.start, timeZone: opts.timeZone };
  const endPoint = opts.allDay ? { date: opts.end } : { dateTime: opts.end, timeZone: opts.timeZone };

  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: opts.summary,
      location: opts.location,
      description: opts.description,
      start: startPoint,
      end: endPoint,
    },
  });
  return mapCalendarEvent(res.data);
}

/** Update an existing event (patch semantics — only provided fields change). */
export async function updateCalendarEvent(opts: {
  id: string;
  summary?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  location?: string;
  description?: string;
  timeZone?: string;
}): Promise<CalendarEvent> {
  const auth = await requireWriteClient('calendar', CALENDAR_SCOPE);
  const calendar = google.calendar({ version: 'v3', auth });

  const requestBody: Record<string, unknown> = {};
  if (opts.summary !== undefined) requestBody.summary = opts.summary;
  if (opts.location !== undefined) requestBody.location = opts.location;
  if (opts.description !== undefined) requestBody.description = opts.description;
  if (opts.start !== undefined) {
    requestBody.start = opts.allDay ? { date: opts.start } : { dateTime: opts.start, timeZone: opts.timeZone };
  }
  if (opts.end !== undefined) {
    requestBody.end = opts.allDay ? { date: opts.end } : { dateTime: opts.end, timeZone: opts.timeZone };
  }

  const res = await calendar.events.patch({
    calendarId: 'primary',
    eventId: opts.id,
    requestBody,
  });
  return mapCalendarEvent(res.data);
}

/** Cancel/remove an event — the REVERSIBLE bin delete (recoverable ~30 days via
 *  the Calendar trash). This is the only removal path; no hard purge is exposed. */
export async function cancelCalendarEvent(id: string): Promise<{ id: string; cancelled: true }> {
  const auth = await requireWriteClient('calendar', CALENDAR_SCOPE);
  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.events.delete({ calendarId: 'primary', eventId: id });
  return { id, cancelled: true };
}

function mapCalendarEvent(e: {
  id?: string | null;
  summary?: string | null;
  start?: { date?: string | null; dateTime?: string | null } | null;
  end?: { date?: string | null; dateTime?: string | null } | null;
  location?: string | null;
  status?: string | null;
  htmlLink?: string | null;
}): CalendarEvent {
  const allDay = !!e.start?.date && !e.start?.dateTime;
  return {
    id: e.id ?? '',
    summary: e.summary ?? '(no title)',
    start: e.start?.dateTime ?? e.start?.date ?? null,
    end: e.end?.dateTime ?? e.end?.date ?? null,
    location: e.location ?? null,
    allDay,
    status: e.status ?? null,
    htmlLink: e.htmlLink ?? null,
  };
}

// ===========================================================================
// Tasks — scope: tasks (read + write)
// ===========================================================================

const TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';

export interface TaskItem {
  id: string;
  title: string;
  notes: string | null;
  due: string | null;
  status: string;
  listTitle: string;
  listId: string;
}

/** List OPEN (incomplete) tasks across task-lists (or one list via listId). */
export async function listOpenTasks(opts: {
  listId?: string;
  maxResults?: number;
} = {}): Promise<TaskItem[]> {
  const auth = await requireAppClient('tasks');
  const tasksApi = google.tasks({ version: 'v1', auth });
  const perList = Math.min(Math.max(opts.maxResults ?? 50, 1), 100);

  let lists: { id: string; title: string }[];
  if (opts.listId) {
    lists = [{ id: opts.listId, title: opts.listId }];
  } else {
    const listsRes = await tasksApi.tasklists.list({ maxResults: 100 });
    lists = (listsRes.data.items ?? []).map((l) => ({
      id: l.id ?? '',
      title: l.title ?? '(untitled list)',
    }));
  }

  const out: TaskItem[] = [];
  for (const list of lists) {
    if (!list.id) continue;
    const res = await tasksApi.tasks.list({
      tasklist: list.id,
      showCompleted: false,
      showHidden: false,
      maxResults: perList,
    });
    for (const t of res.data.items ?? []) {
      if (t.status === 'completed') continue;
      out.push({
        id: t.id ?? '',
        title: t.title ?? '(untitled)',
        notes: t.notes ?? null,
        due: t.due ?? null,
        status: t.status ?? 'needsAction',
        listTitle: list.title,
        listId: list.id,
      });
    }
  }
  return out;
}

/** Resolve a task-list id: the given one, or the user's default ('@default'). */
function resolveTaskListId(listId?: string): string {
  return listId || '@default';
}

/** Create a task on a list (default list if listId omitted). */
export async function createTask(opts: {
  title: string;
  notes?: string;
  due?: string; // RFC3339
  listId?: string;
}): Promise<TaskItem> {
  const auth = await requireWriteClient('tasks', TASKS_SCOPE);
  const tasksApi = google.tasks({ version: 'v1', auth });
  const tasklist = resolveTaskListId(opts.listId);

  const res = await tasksApi.tasks.insert({
    tasklist,
    requestBody: { title: opts.title, notes: opts.notes, due: opts.due },
  });
  const t = res.data;
  return {
    id: t.id ?? '',
    title: t.title ?? opts.title,
    notes: t.notes ?? null,
    due: t.due ?? null,
    status: t.status ?? 'needsAction',
    listTitle: tasklist,
    listId: tasklist,
  };
}

/** Update a task — fields plus an optional `complete` flag (marks completed or
 *  reopens). Patch semantics: only provided fields change. */
export async function updateTask(opts: {
  id: string;
  listId?: string;
  title?: string;
  notes?: string;
  due?: string;
  complete?: boolean;
}): Promise<TaskItem> {
  const auth = await requireWriteClient('tasks', TASKS_SCOPE);
  const tasksApi = google.tasks({ version: 'v1', auth });
  const tasklist = resolveTaskListId(opts.listId);

  const requestBody: Record<string, unknown> = {};
  if (opts.title !== undefined) requestBody.title = opts.title;
  if (opts.notes !== undefined) requestBody.notes = opts.notes;
  if (opts.due !== undefined) requestBody.due = opts.due;
  if (opts.complete !== undefined) {
    requestBody.status = opts.complete ? 'completed' : 'needsAction';
    // Clearing completed reopens; setting status=completed lets the API stamp it.
    if (!opts.complete) requestBody.completed = null;
  }

  const res = await tasksApi.tasks.patch({
    tasklist,
    task: opts.id,
    requestBody,
  });
  const t = res.data;
  return {
    id: t.id ?? opts.id,
    title: t.title ?? '(untitled)',
    notes: t.notes ?? null,
    due: t.due ?? null,
    status: t.status ?? 'needsAction',
    listTitle: tasklist,
    listId: tasklist,
  };
}

/** Delete a task. Tasks deletion is minor/effectively reversible (re-creatable);
 *  this is the standard Tasks removal and is acceptable per spec. */
export async function deleteTask(opts: { id: string; listId?: string }): Promise<{ id: string; deleted: true }> {
  const auth = await requireWriteClient('tasks', TASKS_SCOPE);
  const tasksApi = google.tasks({ version: 'v1', auth });
  const tasklist = resolveTaskListId(opts.listId);
  await tasksApi.tasks.delete({ tasklist, task: opts.id });
  return { id: opts.id, deleted: true };
}

// ===========================================================================
// Gmail — scope: gmail.modify ONLY (read + draft + trash). SEND IS REMOVED.
// ===========================================================================
//
// SECURITY (2026-06, Ward exfiltration hardening): there is NO send capability.
// gmail.modify covers read, draft, and trash — that is the entire Gmail surface.
// The assistant DRAFTS; the user SENDS from Gmail. This structurally closes the
// data-exfiltration path (a prompt-injected "email this to attacker" can produce
// at most a Draft the user must consciously open and send). The gmail.send scope
// is no longer requested, and no code path reaches users.messages.send.

const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

export interface GmailSummary {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string | null;
  unread: boolean;
}

export interface GmailMessage extends GmailSummary {
  to: string;
  body: string;
}

/** List header-light messages matching a Gmail query (defaults to inbox). */
export async function listGmailMessages(opts: {
  query?: string;
  maxResults?: number;
} = {}): Promise<GmailSummary[]> {
  const auth = await requireAppClient('gmail');
  const gmail = google.gmail({ version: 'v1', auth });
  const maxResults = Math.min(Math.max(opts.maxResults ?? 10, 1), 25);

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: opts.query || 'in:inbox',
    maxResults,
  });

  const ids = (listRes.data.messages ?? []).map((m) => m.id).filter((x): x is string => !!x);
  const out: GmailSummary[] = [];
  for (const id of ids) {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date'],
    });
    out.push(parseGmailSummary(id, msg.data));
  }
  return out;
}

/** Read one message by id — decoded plain-text body plus headers. */
export async function readGmailMessage(id: string): Promise<GmailMessage> {
  const auth = await requireAppClient('gmail');
  const gmail = google.gmail({ version: 'v1', auth });
  const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  const summary = parseGmailSummary(id, msg.data);
  const headers = msg.data.payload?.headers ?? [];
  const to = headerValue(headers, 'To');
  return { ...summary, to, body: extractPlainText(msg.data.payload) };
}

// NOTE: sendGmailMessage was REMOVED (Ward exfiltration hardening). There is no
// users.messages.send path anywhere. Drafting is the only outbound Gmail write.

/** Create a draft (gmail.modify covers drafts). */
export async function createGmailDraft(opts: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}): Promise<{ id: string; sent: false }> {
  const auth = await requireWriteClient('gmail', GMAIL_MODIFY_SCOPE);
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = buildRawMessage(opts);
  const res = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } });
  return { id: res.data.id ?? '', sent: false };
}

/** Move a message to Trash — REVERSIBLE. NEVER permanent delete (no delete /
 *  batchDelete / emptyTrash is exposed anywhere). */
export async function trashGmailMessage(id: string): Promise<{ id: string; trashed: true }> {
  const auth = await requireWriteClient('gmail', GMAIL_MODIFY_SCOPE);
  const gmail = google.gmail({ version: 'v1', auth });
  await gmail.users.messages.trash({ userId: 'me', id });
  return { id, trashed: true };
}

function buildRawMessage(opts: { to: string; subject: string; body: string; cc?: string; bcc?: string }): string {
  const lines = [
    `To: ${opts.to}`,
    ...(opts.cc ? [`Cc: ${opts.cc}`] : []),
    ...(opts.bcc ? [`Bcc: ${opts.bcc}`] : []),
    `Subject: ${encodeHeader(opts.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    opts.body,
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

/** RFC2047-encode a header value when it contains non-ASCII (keeps subjects intact). */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function headerValue(
  headers: { name?: string | null; value?: string | null }[],
  name: string
): string {
  const h = headers.find((x) => (x.name ?? '').toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

function parseGmailSummary(
  id: string,
  data: { snippet?: string | null; labelIds?: string[] | null; payload?: { headers?: { name?: string | null; value?: string | null }[] | null } | null }
): GmailSummary {
  const headers = data.payload?.headers ?? [];
  return {
    id,
    from: headerValue(headers, 'From') || '(unknown sender)',
    subject: headerValue(headers, 'Subject') || '(no subject)',
    snippet: data.snippet ?? '',
    date: headerValue(headers, 'Date') || null,
    unread: (data.labelIds ?? []).includes('UNREAD'),
  };
}

function extractPlainText(
  payload: { mimeType?: string | null; body?: { data?: string | null } | null; parts?: any[] | null } | null | undefined
): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeB64Url(payload.body.data);
  }
  for (const part of payload.parts ?? []) {
    const text = extractPlainText(part);
    if (text) return text;
  }
  if (payload.body?.data) return decodeB64Url(payload.body.data);
  return '';
}

function decodeB64Url(data: string): string {
  try {
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

// ===========================================================================
// Drive — scope: drive.metadata.readonly (metadata only, NO content)
// ===========================================================================

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  link: string | null;
}

/** Find files by name fragment and/or list by recency. Metadata only. */
export async function searchDriveFiles(opts: {
  query?: string;
  maxResults?: number;
} = {}): Promise<DriveFile[]> {
  const auth = await requireAppClient('drive');
  const drive = google.drive({ version: 'v3', auth });
  const pageSize = Math.min(Math.max(opts.maxResults ?? 10, 1), 50);

  const clauses = ['trashed = false'];
  if (opts.query && opts.query.trim()) {
    const safe = opts.query.trim().replace(/'/g, "\\'");
    clauses.push(`name contains '${safe}'`);
  }

  const res = await drive.files.list({
    q: clauses.join(' and '),
    pageSize,
    orderBy: 'modifiedTime desc',
    fields: 'files(id, name, mimeType, modifiedTime, webViewLink)',
    spaces: 'drive',
  });

  return (res.data.files ?? []).map((f): DriveFile => ({
    id: f.id ?? '',
    name: f.name ?? '(unnamed)',
    mimeType: f.mimeType ?? '',
    modifiedTime: f.modifiedTime ?? null,
    link: f.webViewLink ?? null,
  }));
}

// ===========================================================================
// Docs — scope: documents (read + write)
// ===========================================================================

const DOCS_SCOPE = 'https://www.googleapis.com/auth/documents';

export interface DocSummary {
  id: string;
  title: string;
  link: string | null;
}

/** Read a document's full plain text (concatenated paragraph runs). */
export async function readDocument(documentId: string): Promise<{ id: string; title: string; text: string }> {
  const auth = await requireAppClient('docs');
  const docs = google.docs({ version: 'v1', auth });
  const res = await docs.documents.get({ documentId });
  const title = res.data.title ?? '(untitled)';
  const text = extractDocText(res.data.body?.content ?? []);
  return { id: documentId, title, text };
}

/** Create a new document. If `text` is given, the body is appended after create. */
export async function createDocument(opts: { title: string; text?: string }): Promise<DocSummary> {
  const auth = await requireWriteClient('docs', DOCS_SCOPE);
  const docs = google.docs({ version: 'v1', auth });
  const created = await docs.documents.create({ requestBody: { title: opts.title } });
  const id = created.data.documentId ?? '';
  if (opts.text && id) {
    await docs.documents.batchUpdate({
      documentId: id,
      requestBody: { requests: [{ insertText: { location: { index: 1 }, text: opts.text } }] },
    });
  }
  return { id, title: created.data.title ?? opts.title, link: id ? `https://docs.google.com/document/d/${id}/edit` : null };
}

/** Update a document via a raw batchUpdate requests array (full Docs API power),
 *  or the convenience `appendText` to add text at the end of the body. */
export async function updateDocument(opts: {
  documentId: string;
  requests?: unknown[];
  appendText?: string;
}): Promise<{ id: string; updated: true }> {
  const auth = await requireWriteClient('docs', DOCS_SCOPE);
  const docs = google.docs({ version: 'v1', auth });

  let requests = opts.requests as any[] | undefined;
  if (!requests && opts.appendText !== undefined) {
    // Find the end index to append at (last content element's endIndex - 1).
    const doc = await docs.documents.get({ documentId: opts.documentId });
    const content = doc.data.body?.content ?? [];
    const last = content[content.length - 1];
    const endIndex = typeof last?.endIndex === 'number' ? Math.max(last.endIndex - 1, 1) : 1;
    requests = [{ insertText: { location: { index: endIndex }, text: opts.appendText } }];
  }
  if (!requests || requests.length === 0) {
    throw new Error('updateDocument needs either `requests` or `appendText`.');
  }
  await docs.documents.batchUpdate({ documentId: opts.documentId, requestBody: { requests } });
  return { id: opts.documentId, updated: true };
}

function extractDocText(
  content: { paragraph?: { elements?: { textRun?: { content?: string | null } | null }[] | null } | null }[]
): string {
  let out = '';
  for (const el of content) {
    for (const e of el.paragraph?.elements ?? []) {
      out += e.textRun?.content ?? '';
    }
  }
  return out;
}

// ===========================================================================
// Sheets — scope: spreadsheets (read + write)
// ===========================================================================

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** Read values from an A1 range. Returns the raw 2D array of cell values. */
export async function readSheetValues(opts: {
  spreadsheetId: string;
  range: string;
}): Promise<{ range: string; values: string[][] }> {
  const auth = await requireAppClient('sheets');
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: opts.spreadsheetId, range: opts.range });
  const values = (res.data.values ?? []).map((row) => row.map((c) => String(c ?? '')));
  return { range: res.data.range ?? opts.range, values };
}

/** Overwrite values at an A1 range (USER_ENTERED parsing). */
export async function updateSheetValues(opts: {
  spreadsheetId: string;
  range: string;
  values: (string | number)[][];
}): Promise<{ updatedCells: number }> {
  const auth = await requireWriteClient('sheets', SHEETS_SCOPE);
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.update({
    spreadsheetId: opts.spreadsheetId,
    range: opts.range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: opts.values },
  });
  return { updatedCells: res.data.updatedCells ?? 0 };
}

/** Append rows after the last row of the table anchored at `range`. */
export async function appendSheetValues(opts: {
  spreadsheetId: string;
  range: string;
  values: (string | number)[][];
}): Promise<{ updatedCells: number; updatedRange: string | null }> {
  const auth = await requireWriteClient('sheets', SHEETS_SCOPE);
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: opts.spreadsheetId,
    range: opts.range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: opts.values },
  });
  return {
    updatedCells: res.data.updates?.updatedCells ?? 0,
    updatedRange: res.data.updates?.updatedRange ?? null,
  };
}

// ===========================================================================
// YouTube — scope: youtube (manage — read + create playlist + add item)
// ===========================================================================

const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube';

export interface YouTubePlaylist {
  id: string;
  title: string;
  itemCount: number | null;
}

export interface YouTubeItem {
  id: string; // playlistItem id (or video id for liked/subscriptions context)
  title: string;
  videoId: string | null;
  channelTitle: string | null;
}

/** List the user's own playlists. */
export async function listYouTubePlaylists(opts: { maxResults?: number } = {}): Promise<YouTubePlaylist[]> {
  const auth = await requireAppClient('youtube');
  const yt = google.youtube({ version: 'v3', auth });
  const maxResults = Math.min(Math.max(opts.maxResults ?? 25, 1), 50);
  const res = await yt.playlists.list({ part: ['snippet', 'contentDetails'], mine: true, maxResults });
  return (res.data.items ?? []).map((p) => ({
    id: p.id ?? '',
    title: p.snippet?.title ?? '(untitled)',
    itemCount: p.contentDetails?.itemCount ?? null,
  }));
}

/** List items in a specific playlist. */
export async function listYouTubePlaylistItems(opts: {
  playlistId: string;
  maxResults?: number;
}): Promise<YouTubeItem[]> {
  const auth = await requireAppClient('youtube');
  const yt = google.youtube({ version: 'v3', auth });
  const maxResults = Math.min(Math.max(opts.maxResults ?? 25, 1), 50);
  const res = await yt.playlistItems.list({ part: ['snippet'], playlistId: opts.playlistId, maxResults });
  return (res.data.items ?? []).map((i) => ({
    id: i.id ?? '',
    title: i.snippet?.title ?? '(untitled)',
    videoId: i.snippet?.resourceId?.videoId ?? null,
    channelTitle: i.snippet?.videoOwnerChannelTitle ?? i.snippet?.channelTitle ?? null,
  }));
}

/** List the user's channel subscriptions. */
export async function listYouTubeSubscriptions(opts: { maxResults?: number } = {}): Promise<YouTubeItem[]> {
  const auth = await requireAppClient('youtube');
  const yt = google.youtube({ version: 'v3', auth });
  const maxResults = Math.min(Math.max(opts.maxResults ?? 25, 1), 50);
  const res = await yt.subscriptions.list({ part: ['snippet'], mine: true, maxResults });
  return (res.data.items ?? []).map((s) => ({
    id: s.id ?? '',
    title: s.snippet?.title ?? '(untitled)',
    videoId: null,
    channelTitle: s.snippet?.title ?? null,
  }));
}

/** List the user's liked videos (the system 'LL' playlist). */
export async function listYouTubeLiked(opts: { maxResults?: number } = {}): Promise<YouTubeItem[]> {
  const auth = await requireAppClient('youtube');
  const yt = google.youtube({ version: 'v3', auth });
  const maxResults = Math.min(Math.max(opts.maxResults ?? 25, 1), 50);
  const res = await yt.videos.list({ part: ['snippet'], myRating: 'like', maxResults });
  return (res.data.items ?? []).map((v) => ({
    id: v.id ?? '',
    title: v.snippet?.title ?? '(untitled)',
    videoId: v.id ?? null,
    channelTitle: v.snippet?.channelTitle ?? null,
  }));
}

/** Create a new playlist — ALWAYS private (Ward hardening). Privacy is hardcoded
 *  'private'; there is no public/unlisted publish path exposed. */
export async function createYouTubePlaylist(opts: {
  title: string;
  description?: string;
}): Promise<YouTubePlaylist> {
  const auth = await requireWriteClient('youtube', YOUTUBE_SCOPE);
  const yt = google.youtube({ version: 'v3', auth });
  const res = await yt.playlists.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: { title: opts.title, description: opts.description },
      // HARDCODED private — never public/unlisted. No externally-visible publish.
      status: { privacyStatus: 'private' },
    },
  });
  return {
    id: res.data.id ?? '',
    title: res.data.snippet?.title ?? opts.title,
    itemCount: null,
  };
}

/** Add a video to a playlist. */
export async function addToYouTubePlaylist(opts: {
  playlistId: string;
  videoId: string;
}): Promise<{ id: string; added: true }> {
  const auth = await requireWriteClient('youtube', YOUTUBE_SCOPE);
  const yt = google.youtube({ version: 'v3', auth });
  const res = await yt.playlistItems.insert({
    part: ['snippet'],
    requestBody: {
      snippet: {
        playlistId: opts.playlistId,
        resourceId: { kind: 'youtube#video', videoId: opts.videoId },
      },
    },
  });
  return { id: res.data.id ?? '', added: true };
}

// ===========================================================================
// Write-audit log — a pure RECORD of every Google mutation (no gating)
// ===========================================================================
//
// Ward hardening: every WRITE action (calendar create/update/cancel, tasks
// create/update/delete, gmail draft/trash, docs create/update, sheets
// update/append, youtube create/add) appends an audit row AFTER it executes —
// success OR failure. This answers "what did the assistant change and where",
// which is the forensic trail an exfiltration review needs.
//
// PRIVACY: NEVER log tokens, secrets, or full email/doc bodies. The `summary`
// field is a SHORT non-sensitive target descriptor (event title, draft subject +
// recipient, doc id, playlist title). Callers must keep it body-free.
//
// Storage: a local `google_audit` SQLite table (queryable, matches the getDb()
// pattern used across the backend). Created lazily on first write.

const auditTableReady = tenantLocal(() => false);

function ensureAuditTable(): void {
  if (auditTableReady.get()) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS google_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      service TEXT NOT NULL,
      action TEXT NOT NULL,
      account TEXT,
      summary TEXT,
      outcome TEXT NOT NULL DEFAULT 'ok'
    )
  `);
  auditTableReady.set(true);
}

/** Append one write-audit row. PURE RECORD — never throws into the caller (an
 *  audit failure must not break or alter an in-flight Google write). `outcome` is
 *  'ok' on success, or 'error: <msg>' on a failed attempt. `summary` MUST be a
 *  short, non-sensitive target descriptor — NEVER a token, secret, or full body. */
export function logGoogleWrite(entry: {
  service: GoogleApp | string;
  action: string;
  account?: string | null;
  summary?: string | null;
  outcome?: string;
}): void {
  try {
    ensureAuditTable();
    getDb()
      .prepare(
        `INSERT INTO google_audit (ts, service, action, account, summary, outcome)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        new Date().toISOString(),
        String(entry.service),
        String(entry.action),
        entry.account ?? null,
        // Defensive truncation — a summary should already be short + body-free.
        entry.summary ? String(entry.summary).slice(0, 300) : null,
        entry.outcome ?? 'ok'
      );
  } catch {
    // Audit logging is best-effort. A failure here must never surface to the user
    // or abort the Google operation it is recording.
  }
}
