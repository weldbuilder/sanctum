import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import {
  getAuthPreferences,
  updateAuthPreferences,
  maskApiKey,
  type AuthPreferencesUpdate,
} from '../services/auth-preferences.js';
import { getUsageSummary, clearUsageLog } from '../services/usage-log.js';
import { clearAllThreadSessions } from '../services/db.js';

const router: Router = Router();
router.use(authMiddleware);

// GET /api/auth-preferences — returns current auth mode + model overrides.
// The api_key is never returned in full; only a masked prefix/suffix for UI.
router.get('/auth-preferences', (_req, res) => {
  const prefs = getAuthPreferences();
  res.json({
    auth_mode: prefs.auth_mode,
    api_key_masked: maskApiKey(prefs.api_key),
    api_key_set: !!prefs.api_key,
    preferred_model: prefs.preferred_model,
    preferred_model_autonomous: prefs.preferred_model_autonomous,
    usage_tracking_enabled: prefs.usage_tracking_enabled,
    updated_at: prefs.updated_at,
  });
});

// PUT /api/auth-preferences — update any subset of fields.
// Pass api_key: null to clear it. Omit a field to leave it unchanged.
router.put('/auth-preferences', (req, res) => {
  try {
    const body = req.body as AuthPreferencesUpdate;
    const update: AuthPreferencesUpdate = {};

    if (body.auth_mode !== undefined) {
      if (body.auth_mode !== 'subscription' && body.auth_mode !== 'api_key') {
        res.status(400).json({ error: 'auth_mode must be subscription or api_key' });
        return;
      }
      update.auth_mode = body.auth_mode;
    }
    if (body.api_key !== undefined) {
      if (body.api_key !== null && typeof body.api_key !== 'string') {
        res.status(400).json({ error: 'api_key must be a string or null' });
        return;
      }
      if (typeof body.api_key === 'string' && body.api_key.trim().length === 0) {
        update.api_key = null;
      } else if (typeof body.api_key === 'string' && !body.api_key.startsWith('sk-ant-')) {
        res.status(400).json({ error: 'api_key does not look like an Anthropic key (expected sk-ant-...)' });
        return;
      } else {
        update.api_key = body.api_key;
      }
    }
    if (body.preferred_model !== undefined) update.preferred_model = body.preferred_model;
    if (body.preferred_model_autonomous !== undefined) update.preferred_model_autonomous = body.preferred_model_autonomous;
    if (body.usage_tracking_enabled !== undefined) update.usage_tracking_enabled = body.usage_tracking_enabled;

    const next = updateAuthPreferences(update);

    if (next.auth_mode === 'api_key' && !next.api_key) {
      res.json({
        success: true,
        warning: 'Auth mode is api_key but no key is set — queries will fail until a key is provided.',
        auth_mode: next.auth_mode,
        api_key_set: false,
      });
      return;
    }

    res.json({
      success: true,
      auth_mode: next.auth_mode,
      api_key_set: !!next.api_key,
    });
  } catch (err) {
    console.error('Failed to update auth preferences:', err);
    res.status(500).json({ error: 'Failed to update auth preferences' });
  }
});

// POST /api/auth-preferences/test — validates an API key by making a single
// minimal call to Anthropic. Tests the *supplied* key in the body, not the
// stored one — so the user can validate before saving.
router.post('/auth-preferences/test', async (req, res) => {
  const { api_key, model } = req.body as { api_key?: string; model?: string };
  if (!api_key || typeof api_key !== 'string') {
    res.status(400).json({ error: 'api_key is required' });
    return;
  }
  if (!api_key.startsWith('sk-ant-')) {
    res.status(400).json({ error: 'api_key does not look like an Anthropic key' });
    return;
  }

  const testModel = model || 'claude-haiku-5-5';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': api_key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: testModel,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({})) as { error?: { message?: string } };
      const message = errBody.error?.message || `HTTP ${response.status}`;
      res.status(response.status).json({ success: false, error: message, model: testModel });
      return;
    }

    const result = await response.json() as {
      model: string;
      usage: { input_tokens: number; output_tokens: number };
    };
    res.json({
      success: true,
      model: result.model,
      input_tokens: result.usage.input_tokens,
      output_tokens: result.usage.output_tokens,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ success: false, error: message, model: testModel });
  }
});

// GET /api/auth-preferences/usage — rolling usage summary.
router.get('/auth-preferences/usage', (req, res) => {
  const windowDays = Math.max(1, Math.min(365, parseInt(String(req.query.days ?? '30'), 10) || 30));
  res.json(getUsageSummary(windowDays));
});

// DELETE /api/auth-preferences/usage — reset usage counter.
router.delete('/auth-preferences/usage', (_req, res) => {
  clearUsageLog();
  res.json({ success: true });
});

// POST /api/auth-preferences/reset-sessions — null current_session_id on every
// thread so the next message in each starts a fresh SDK session. Useful after
// switching auth: Anthropic's prompt cache is account-scoped, so resuming a
// session under new auth gets no cache hit and the first turn is full-price.
router.post('/auth-preferences/reset-sessions', (_req, res) => {
  const affected = clearAllThreadSessions();
  res.json({ success: true, threadsReset: affected });
});

export default router;
