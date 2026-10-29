import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  helpBlocks, valueOf, hasAnswer, describeValue, reviewRows, reconcileIndex, madePassword, createSetupApi,
  planFailureAction, applyFailureAction, afterCodeAccepted, passwordStepWarning, passwordRestartWarning, PARENT_PASSWORD_WARNING,
  type SetupStep,
} from './setupWizardState';

const step = (over: Partial<SetupStep> & { id: string }): SetupStep => ({ kind: 'text', section: 'S', question: 'Q?', help: [], ...over });

describe('helpBlocks: the plan\'s hard-wrapped lines become paragraphs and lists', () => {
  it('joins consecutive lines into a paragraph and splits on a blank line', () => {
    expect(helpBlocks(['one', 'two', '', 'three'])).toEqual([{ kind: 'p', text: 'one two' }, { kind: 'p', text: 'three' }]);
  });
  it('keeps lines that start with two spaces as a list (the file lists), and a line starting with "digest" as a code line', () => {
    expect(helpBlocks(['hello: the code (2 files):', '  dsh/index.mjs', '  help.md', 'digest abc'])).toEqual([
      { kind: 'p', text: 'hello: the code (2 files):' },
      { kind: 'list', items: ['dsh/index.mjs', 'help.md'] },
      { kind: 'code', text: 'digest abc' },
    ]);
  });
  it('is empty for nothing', () => { expect(helpBlocks([])).toEqual([]); });
});

describe('valueOf and hasAnswer', () => {
  const text = step({ id: 'a', default: 'dflt' });
  it('is the answer when there is one, else the default', () => {
    expect(valueOf(text, {})).toBe('dflt');
    expect(valueOf(text, { a: 'mine' })).toBe('mine');
    expect(valueOf(text, { a: '' })).toBe('');
  });
  it('a secret is only what was typed (empty keeps the saved one): never a default', () => {
    const pw = step({ id: 'password', kind: 'secret', saved: true });
    expect(valueOf(pw, {})).toBe('');
    expect(valueOf(pw, { password: 'x' })).toBe('x');
  });
  it('a yes/no without a default is no, a multichoice is a list', () => {
    expect(valueOf(step({ id: 'y', kind: 'yesno' }), {})).toBe(false);
    expect(valueOf(step({ id: 'm', kind: 'multichoice' }), {})).toEqual([]);
  });
  it('hasAnswer is true once the person went through the step', () => {
    expect(hasAnswer(text, {})).toBe(false);
    expect(hasAnswer(text, { a: 'dflt' })).toBe(true);
  });
});

describe('describeValue and reviewRows: the review screen, with no secret in it', () => {
  const steps: SetupStep[] = [
    step({ id: 'name', question: 'Your name', default: 'Sam', section: 'Who' }),
    step({ id: 'provider', kind: 'choice', question: 'Which one?', default: 'codex', options: [{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }], section: 'Model' }),
    step({ id: 'plugins', kind: 'multichoice', question: 'Which to turn on?', default: [], options: [{ value: 'hello', label: 'Hello plugin' }], section: 'Plugins' }),
    step({ id: 'appWrite', kind: 'yesno', question: 'Let them write?', default: true, section: 'Features' }),
    step({ id: 'password', kind: 'secret', question: 'App password', saved: true, section: 'App' }),
    step({ id: 'anthropicKey', kind: 'secret', question: 'Key', saved: false, section: 'App' }),
  ];
  it('shows names for choices, yes/no as words, and a secret only as set or kept', () => {
    expect(describeValue(steps[0], { name: 'Ada' })).toBe('Ada');
    expect(describeValue(steps[1], { provider: 'claude' })).toBe('Claude');
    expect(describeValue(steps[2], { plugins: ['hello'] })).toBe('Hello plugin');
    expect(describeValue(steps[2], {})).toBe('none');
    expect(describeValue(steps[3], {})).toBe('yes');
    expect(describeValue(steps[3], { appWrite: false })).toBe('no');
    expect(describeValue(steps[4], {})).toBe('kept as saved');
    expect(describeValue(steps[4], { password: 'hunter2hunter2' })).toBe('new, hidden');
    expect(describeValue(steps[5], {})).toBe('not set');
    expect(describeValue(steps[0], {})).toBe('Sam');
  });
  it('never contains a typed secret', () => {
    const rows = reviewRows(steps, { password: 'SECRET-VALUE-123', anthropicKey: 'SECRET-KEY-456' });
    expect(JSON.stringify(rows)).not.toContain('SECRET');
    expect(rows.map((r) => r.question)).toEqual(['Your name', 'Which one?', 'Which to turn on?', 'Let them write?', 'App password', 'Key']);
  });
  it('an empty text answer reads as "empty", not as a blank', () => {
    expect(describeValue(steps[0], { name: '' })).toBe('empty');
  });
});

describe('reconcileIndex: where the person stands when the plan changes under them', () => {
  const ids = (xs: string[]) => xs.map((id) => step({ id }));
  it('stays on the same step by id when it is still there', () => {
    expect(reconcileIndex(ids(['a', 'b', 'c']), 1, ids(['a', 'x', 'b', 'c']))).toBe(2);
  });
  it('moves on to the next step that still exists when the current one went away', () => {
    expect(reconcileIndex(ids(['a', 'b', 'c']), 1, ids(['a', 'c']))).toBe(1);
  });
  it('goes to the end (the review) when nothing after it remains', () => {
    expect(reconcileIndex(ids(['a', 'b']), 1, ids(['a']))).toBe(1);
  });
});

describe('madePassword', () => {
  it('is four groups of four characters with no look-alikes, from the browser\'s random numbers', () => {
    const p = madePassword((n) => Uint8Array.from({ length: n }, (_v, i) => i * 13 + 5));
    expect(p).toMatch(/^[a-hj-km-np-z2-9]{4}(-[a-hj-km-np-z2-9]{4}){3}$/);
    expect(madePassword((n) => Uint8Array.from({ length: n }, (_v, i) => i)).length).toBe(19);
  });
});

describe('the API client', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const reply = (status: number, body: unknown) => vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return { ok: status < 400, status, json: async () => body } as Response; });
  afterEach(() => { calls.length = 0; vi.unstubAllGlobals(); });

  it('sends the setup code in x-setup-code and cookies always, and never the code once there is a session', async () => {
    vi.stubGlobal('fetch', reply(200, { steps: [], notes: [], problems: [], mode: 'first_run' }));
    const api = createSetupApi('http://x');
    await api.plan({ provider: 'claude' }, 'abcdef123456');
    expect(calls[0].url).toBe('http://x/api/setup/plan');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>)['x-setup-code']).toBe('abcdef123456');
    expect(calls[0].init.credentials).toBe('include');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ answers: { provider: 'claude' } });
    await api.plan({}, '');
    expect((calls[1].init.headers as Record<string, string>)['x-setup-code']).toBeUndefined();
  });

  it('turns a setup-code refusal into a clear result the page can show, and a network failure into a sentence', async () => {
    vi.stubGlobal('fetch', reply(401, { error: 'setup_code', message: 'That is not the setup code.' }));
    const r = await createSetupApi('').plan({}, 'wrong');
    expect(r).toEqual({ ok: false, needsCode: true, message: 'That is not the setup code.' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(await createSetupApi('').plan({}, 'x')).toMatchObject({ ok: false, message: expect.stringMatching(/reach the server/) });
  });

  it('a session that has ended is its own result (the page goes back to sign-in)', async () => {
    vi.stubGlobal('fetch', reply(401, { error: 'Unauthorized' }));
    expect(await createSetupApi('').plan({}, '')).toMatchObject({ ok: false, signedOut: true });
  });

  it('validate, test and apply post what the routes take and hand back what they answer', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ url: _url, init });
      const body = JSON.parse(init.body as string);
      const path = _url.split('/api/setup')[1];
      const out = path === '/validate' ? { ok: false, message: 'no' } : path === '/test' ? { ok: true, message: 'fine', state: 'found' } : { ok: true, restartNeeded: true, changed: [{ path: '/a', what: 'sanctum.yaml' }], notes: [] };
      void body;
      return { ok: true, status: 200, json: async () => out } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const api = createSetupApi('');
    expect(await api.validate('timezone', 'Mars/X', {}, '')).toEqual({ ok: false, message: 'no' });
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ id: 'timezone', value: 'Mars/X', answers: {} });
    expect(await api.test('codex_config', '', {}, '')).toMatchObject({ ok: true, state: 'found' });
    expect(JSON.parse(calls[1].init.body as string)).toMatchObject({ probe: 'codex_config' });
    const applied = await api.apply({ a: 1 }, 'code');
    expect(applied).toMatchObject({ ok: true, restartNeeded: true });
    expect(JSON.parse(calls[2].init.body as string)).toEqual({ answers: { a: 1 } });
  });

  it('apply that the server refuses brings back the problems by step', async () => {
    vi.stubGlobal('fetch', reply(400, { error: 'Some answers need another look.', problems: [{ id: 'password', message: 'Use at least 8 characters.' }] }));
    expect(await createSetupApi('').apply({}, '')).toEqual({ ok: false, message: 'Some answers need another look.', problems: [{ id: 'password', message: 'Use at least 8 characters.' }] });
  });
});

const LOCKED = 'Too many wrong setup codes from this address. Wait 15 minutes, then try again with the code printed in the window where `npm start` runs.';
const respond = (status: number, body: unknown) => vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response);

describe('a /plan failure that is not "needs the code" is shown where the person is looking', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('the lockout (429, no needsCode) keeps its message with the wait, and lands in the intro\'s code field', async () => {
    vi.stubGlobal('fetch', respond(429, { error: 'setup_code_locked', message: LOCKED }));
    const r = await createSetupApi('').plan({}, 'wrong');
    expect(r).toMatchObject({ ok: false, message: LOCKED });
    expect((r as { needsCode?: boolean }).needsCode).toBeUndefined();
    expect(planFailureAction(r as { ok: false; message: string }, 'intro')).toEqual({ phase: 'intro', codeError: LOCKED });
  });
  it('any other failure on the intro (a 500, the server unreachable) goes to the same field, so Start never appears to do nothing', () => {
    expect(planFailureAction({ message: 'Could not read the current setup: boom' }, 'intro')).toEqual({ phase: 'intro', codeError: 'Could not read the current setup: boom' });
  });
  it('needing the code returns to the intro from a step too; any other failure on a step is that step\'s error (not hidden)', () => {
    expect(planFailureAction({ message: 'expired', needsCode: true }, 'steps')).toEqual({ phase: 'intro', codeError: 'expired' });
    expect(planFailureAction({ message: 'down' }, 'steps')).toEqual({ phase: null, codeError: '', fieldError: 'down' });
  });
});

describe('/apply with a code that expired during the wizard', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('the API says needsCode, and the page returns to the code prompt with the answers kept and a resume to the review', async () => {
    vi.stubGlobal('fetch', respond(401, { error: 'setup_code_expired', message: 'That setup code has expired. A new one was printed.' }));
    const r = await createSetupApi('').apply({ password: 'pw' }, 'old');
    expect(r).toMatchObject({ ok: false, needsCode: true });
    const a = applyFailureAction(r as { ok: false; message: string; needsCode?: boolean });
    expect(a).toEqual({ phase: 'intro', codeError: 'That setup code has expired. A new one was printed.', resume: true, applyError: '' });
  });
  it('a new accepted code leads back to the review, not to step one; with no interrupted apply it leads to step one', () => {
    expect(afterCodeAccepted(true)).toBe('review');
    expect(afterCodeAccepted(false)).toBe('steps');
  });
  it('any other apply failure stays on the review with its message and the problems', () => {
    const problems = [{ id: 'password', message: 'too short' }];
    expect(applyFailureAction({ message: 'Some answers need another look.', problems })).toEqual({ phase: 'review', codeError: '', resume: false, applyError: 'Some answers need another look.', problems });
    expect(applyFailureAction({ message: 'boom' })).toEqual({ phase: 'review', codeError: '', resume: false, applyError: 'boom' });
  });
});

describe('the password the parent environment sets', () => {
  it('the password step warns before anything is typed, only for parent_env and only on that step', () => {
    expect(passwordStepWarning('password', 'parent_env')).toBe(PARENT_PASSWORD_WARNING);
    expect(passwordStepWarning('password', 'dotenv')).toBe('');
    expect(passwordStepWarning('password', undefined)).toBe('');
    expect(passwordStepWarning('companionName', 'parent_env')).toBe('');
    expect(PARENT_PASSWORD_WARNING).toMatch(/change it there too.*old one comes back at the next restart/);
  });
  it('the last screen carries it when the server says the parent keeps the old password', () => {
    expect(passwordRestartWarning({ passwordKeptByParent: true })).toBe(PARENT_PASSWORD_WARNING);
    expect(passwordRestartWarning({ passwordKeptByParent: false })).toBe('');
    expect(passwordRestartWarning({})).toBe('');
  });
});
