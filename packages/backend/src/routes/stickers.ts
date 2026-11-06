// Sticker library routes (mounted in api.ts behind session auth): GET /stickers, POST /stickers (multipart: name + file), DELETE /stickers/:id.
// The picture is an ordinary stored file (sidecar source 'sticker'), so it is served by GET /api/files/:id like any other.
import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { appWriteGate } from '../middleware/app-write.js';
import { tenantEnter } from '../tenancy/resolve.js';
import { addSticker, listStickers, removeSticker, StickerError, STICKER_MAX_BYTES } from '../services/media/stickers.js';
import { companionPath } from '../tenancy/house.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: STICKER_MAX_BYTES, files: 1 } }).single('file');

function present(s: { id: string; name: string; file_id: string; created_at: string }) {
  return { id: s.id, name: s.name, fileId: s.file_id, url: companionPath(`/api/files/${s.file_id}`), createdAt: s.created_at };
}

export const stickersRouter = Router();

stickersRouter.get('/', (_req, res) => {
  try { res.json({ stickers: listStickers().map(present) }); }
  catch (e) { console.error('[Stickers] list failed:', e instanceof Error ? e.name : 'error'); res.status(500).json({ error: 'Failed to list stickers' }); }
});

stickersRouter.post('/', appWriteGate, (req: Request, res: Response, next: NextFunction) => {
  upload(req, res, (err: unknown) => {
    if (err) {
      const tooBig = (err as { code?: string }).code === 'LIMIT_FILE_SIZE';
      res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'too_large' : 'upload_failed', message: tooBig ? 'A sticker is 2 MB or smaller' : 'Upload failed' });
      return;
    }
    next();
  });
}, tenantEnter, (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'file_required', message: 'No file provided (multipart field "file")' }); return; }
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    const s = addSticker(name, req.file.buffer, req.file.originalname, req.file.mimetype);
    res.status(201).json({ sticker: present(s) });
  } catch (e) {
    if (e instanceof StickerError) {
      res.status(e.code === 'name_taken' ? 409 : e.code === 'too_large' ? 413 : 400).json({ error: e.code, message: e.message });
      return;
    }
    console.error('[Stickers] upload failed:', e instanceof Error ? e.name : 'error');
    res.status(500).json({ error: 'Could not store the sticker' });
  }
});

stickersRouter.delete('/:id', (req, res) => {
  try {
    if (!removeSticker(String(req.params.id))) { res.status(404).json({ error: 'not_found' }); return; }
    res.json({ success: true });
  } catch (e) {
    console.error('[Stickers] delete failed:', e instanceof Error ? e.name : 'error');
    res.status(500).json({ error: 'Failed to delete the sticker' });
  }
});
