import Joi from 'joi';
import winston from 'winston';
import * as db from '../db/manager.js';

export function setup(velvet) {
  // GET /api/v1/user/settings  — load prefs + queue for the authenticated user
  velvet.get('/api/v1/user/settings', (req, res) => {
    const username = req.user?.username || 'velvet-user';
    res.json(db.getUserSettings(username));
  });

  // POST /api/v1/user/settings  — save/merge prefs and/or queue
  velvet.post('/api/v1/user/settings', async (req, res) => {
    const schema = Joi.object({
      prefs: Joi.object().unknown(true).optional(),
      queue: Joi.any().optional(),
    });
    await schema.validateAsync(req.body);
    const username = req.user?.username || 'velvet-user';
    try {
      db.saveUserSettings(username, req.body);
      return res.json({ ok: true });
    } catch (e) {
      const msg = String(e?.message || '').toLowerCase();
      const isBusy = msg.includes('sqlite_busy') || msg.includes('database is locked');
      if (isBusy) {
        return res.status(503).json({ error: 'database busy' });
      }
      winston.warn(`[user-settings] Failed to save settings for ${username}: ${e?.message || e}`);
      return res.status(500).json({ error: 'failed to save settings' });
    }
  });
}
