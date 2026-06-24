import * as db from '../db/manager.js';

export function setup(velvet) {
  // GET /api/v1/queue  — return the full saved queue for the authenticated user
  velvet.get('/api/v1/queue', (req, res) => {
    const username = req.user?.username || 'velvet-user';
    const settings = db.getUserSettings(username);
    res.json(settings.queue ?? null);
  });

  // POST /api/v1/queue  — save (overwrite) the queue for the authenticated user
  velvet.post('/api/v1/queue', (req, res) => {
    const username = req.user?.username || 'velvet-user';
    db.saveUserSettings(username, { queue: req.body });
    res.json({ ok: true });
  });
}
