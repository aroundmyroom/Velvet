// What the web player does around its own playback (webapp/app.js playAt, _scheduleScrobble, the Wrapped calls),
// done on the server for a Velvet Room: the listen hooks of RoomManager (src/sendspin/rooms.js). Same functions,
// switches and per-user settings as the web player's routes.
import * as config from '../state/config.js';
import { logPlay } from './db.js';
import {
  scrobbleByFilepath, lbPlayingNow, lbScrobbleByFilepath, lastfmEnabled, lastfmActive, lbActive,
} from './scrobbler.js';
import { discordScrobbleByFilepath } from './discord-webhook.js';
import { customWebhookScrobbleByFilepath, CUSTOM_WEBHOOK_SLOTS } from './custom-webhooks.js';
import * as wrapped from './wrapped.js';

const BOOT = Date.now().toString(36);

function userFor(name) {
  const users = config.program.users ?? {};
  if (users[name]) return { ...users[name], username: name };
  if (name === 'velvet-user' && !Object.keys(users).length) return { vpaths: Object.keys(config.program.folders ?? {}), username: name };
  return null;
}

// A song the user can no longer reach (folder access changed) makes the lookups throw: that service just fails.
function safe(fn) {
  try {
    return fn();
  } catch (e) {
    console.debug('[velvet]', e?.message ?? e);
    return null;
  }
}

async function outcome(p) {
  return p && (await p) !== false ? 'ok' : 'err';
}

async function eventOf(ctx) {
  return (await ctx.started)?.eventId ?? null;
}

export const roomListen = {
  start(ctx) {
    const user = userFor(ctx.user);
    if (!user) return null;
    const fp = ctx.item.filepath;
    // A song taken over mid-way was counted where it started.
    if (ctx.startMs === 0) logPlay(user, fp).catch((e) => console.debug('[velvet]', e?.message ?? e));
    ctx.started = wrapped.playStart(user, { filePath: fp, sessionId: `room-${ctx.roomId.slice(0, 16)}-${BOOT}`, source: ctx.source })
      .catch((e) => console.debug('[velvet]', e?.message ?? e));
    const lb = lbActive(user);
    if (lb) safe(() => lbPlayingNow(user, fp));
    return { lastfm: lastfmActive(user) ? 'pending' : 'off', listenbrainz: lb ? 'pending' : 'off' };
  },

  async scrobble(ctx) {
    const user = userFor(ctx.user);
    if (!user) return null;
    const fp = ctx.item.filepath;
    const lfm = lastfmEnabled() ? safe(() => scrobbleByFilepath(user, fp)) : null;
    const lb = lbActive(user) ? safe(() => lbScrobbleByFilepath(user, fp)) : null;
    safe(() => discordScrobbleByFilepath(user, fp));
    for (let slot = 0; slot < CUSTOM_WEBHOOK_SLOTS; slot++) safe(() => customWebhookScrobbleByFilepath(user, fp, slot));
    return {
      lastfm: lastfmActive(user) ? await outcome(lfm) : 'off',
      listenbrainz: lbActive(user) ? await outcome(lb) : 'off',
    };
  },

  async pause(ctx) {
    const user = userFor(ctx.user);
    const eventId = await eventOf(ctx);
    if (user && eventId) wrapped.playPause(user, { eventId });
  },

  async end(ctx, { how, playedMs }) {
    const user = userFor(ctx.user);
    const eventId = await eventOf(ctx);
    if (!user || !eventId) return;
    if (how === 'end') wrapped.playEnd(user, { eventId, playedMs });
    else if (how === 'skip') wrapped.playSkip(user, { eventId, playedMs });
    else wrapped.playStop(user, { eventId, playedMs });
  },
};
