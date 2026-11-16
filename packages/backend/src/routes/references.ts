// Reference library routes (mounted in api.ts behind session auth): GET /references, POST /references (multipart: name, self, note + file),
// PATCH /references/:id ({self?, note?}), DELETE /references/:id. The picture is an ordinary stored file (sidecar source 'reference').
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { appWriteGate } from '../middleware/app-write.js';
import { tenantEnter } from '../tenancy/resolve.js';
import { addReference, listReferences, removeReference, updateReference, ReferenceError, REFERENCE_MAX_BYTES, type Reference } from '../services/media/references.js';
import { companionPath } from '../tenancy/house.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: REFERENCE_MAX_BYTES, files: 1 } }).single('file');

function present(r: Reference) {
  return { id: r.id, name: r.name, self: r.self, note: r.note, fileId: r.file_id, url: companionPath(`/api/files/${r.file_id}`), createdAt: r.created_at };
}
const statusOf = (code: string) => (code === 'name_taken' || code === 'self_limit' || code === 'library_full' ? 409 : code === 'too_large' ? 413 : code === 'not_found' ? 404 : 400);

export const referencesRouter = Router();

referencesRouter.get('/', (_req, res) => {
  try { res.json({ references: listReferences().map(present) }); }
  catch (e) { console.error('[References] list failed:', e instanceof Error ? e.name : 'error'); res.status(500).json({ error: 'Failed to list references' }); }
});

referencesRouter.post('/', appWriteGate, (req: Request, res: Response, next: NextFunction) => {
  upload(req, res, (err: unknown) => {
    if (err) {
      const tooBig = (err as { code?: string }).code === 'LIMIT_FILE_SIZE';
      res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'too_large' : 'upload_failed', message: tooBig ? 'A reference is 1 MB or smaller' : 'Upload failed' });
      return;
    }
    next();
  });
}, tenantEnter, (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'file_required', message: 'No file provided (multipart field "file")' }); return; }
  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = addReference({
      name: typeof b.name === 'string' ? b.name : '',
      self: b.self === '1' || b.self === 'true',
      note: typeof b.note === 'string' ? b.note : '',
      buffer: req.file.buffer, filename: req.file.originalname, mime: req.file.mimetype,
    });
    res.status(201).json({ reference: present(r) });
  } catch (e) {
    if (e instanceof ReferenceError) { res.status(statusOf(e.code)).json({ error: e.code, message: e.message }); return; }
    console.error('[References] upload failed:', e instanceof Error ? e.name : 'error');
    res.status(500).json({ error: 'Could not store the reference' });
  }
});

referencesRouter.patch('/:id', appWriteGate, (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  if ((b.self !== undefined && typeof b.self !== 'boolean') || (b.note !== undefined && typeof b.note !== 'string')) {
    res.status(400).json({ error: 'bad_request', message: 'Send self (true or false) and/or note (text)' }); return;
  }
  try {
    const r = updateReference(String(req.params.id), { self: b.self as boolean | undefined, note: b.note as string | undefined });
    res.json({ reference: present(r) });
  } catch (e) {
    if (e instanceof ReferenceError) { res.status(statusOf(e.code)).json({ error: e.code, message: e.message }); return; }
    console.error('[References] update failed:', e instanceof Error ? e.name : 'error');
    res.status(500).json({ error: 'Could not update the reference' });
  }
});

referencesRouter.delete('/:id', appWriteGate, (req, res) => {
  try {
    if (!removeReference(String(req.params.id))) { res.status(404).json({ error: 'not_found' }); return; }
    res.json({ success: true });
  } catch (e) {
    console.error('[References] delete failed:', e instanceof Error ? e.name : 'error');
    res.status(500).json({ error: 'Failed to delete the reference' });
  }
});
