// What the web player does around its own playback (webapp/app.js playAt, _scheduleScrobble, the Wrapped calls),
// done on the server for a Velvet Room: the listen hooks of RoomManager (src/sendspin/rooms.js). Same functions,
// switches and per-user settings as the web player's routes.
import * as config from '../state/config.js';
import { logPlay } from './db.js';
import {
  scrobbleByFilepath, lbPlayingNow, lbScrobbleByFilepath, lastfmEnabled, lastfmActive, lbActive,
} from './scrobbler.js';
import { discordScrobbleByFilepath } from './discord-webhook.js';
import { msActive, msPlayingNow, msScrobbleByFilepath } from './multi-scrobbler.js';
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

// roomId → the room's last end hook, resolving to the event it closed. The next song's start waits for it: with
// repeat-one the same song follows itself, and the Wrapped dedupe would otherwise resume the play that just ended.
const lastEnd = new Map();

export const roomListen = {
  start(ctx) {
    const user = userFor(ctx.user);
    if (!user) return null;
    const fp = ctx.item.filepath;
    const sessionId = `room-${ctx.roomId.slice(0, 16)}-${BOOT}`;
    ctx.started = Promise.resolve(lastEnd.get(ctx.roomId))
      .then((ended) => wrapped.playStart(user, { filePath: fp, sessionId, source: ctx.source, notEventId: ended }))
      .catch((e) => console.debug('[velvet]', e?.message ?? e));
    // A song taken over mid-way, or at 0 while the web player or another room still had it open (it resumes that
    // play), was counted where it started.
    ctx.started.then((s) => {
      if (ctx.startMs === 0 && !s?.resumed) return logPlay(user, fp);
    }).catch((e) => console.debug('[velvet]', e?.message ?? e));
    const lb = lbActive(user);
    if (lb) safe(() => lbPlayingNow(user, fp));
    const ms = msActive(user);
    if (ms) safe(() => msPlayingNow(user, fp));
    return { lastfm: lastfmActive(user) ? 'pending' : 'off', listenbrainz: lb ? 'pending' : 'off', multiscrobbler: ms ? 'pending' : 'off' };
  },

  async scrobble(ctx) {
    const user = userFor(ctx.user);
    if (!user) return null;
    const fp = ctx.item.filepath;
    const lfm = lastfmEnabled() ? safe(() => scrobbleByFilepath(user, fp)) : null;
    const lb = lbActive(user) ? safe(() => lbScrobbleByFilepath(user, fp)) : null;
    const ms = msActive(user) ? safe(() => msScrobbleByFilepath(user, fp)) : null;
    safe(() => discordScrobbleByFilepath(user, fp));
    for (let slot = 0; slot < CUSTOM_WEBHOOK_SLOTS; slot++) safe(() => customWebhookScrobbleByFilepath(user, fp, slot));
    return {
      lastfm: lastfmActive(user) ? await outcome(lfm) : 'off',
      listenbrainz: lbActive(user) ? await outcome(lb) : 'off',
      multiscrobbler: msActive(user) ? await outcome(ms) : 'off',
    };
  },

  async pause(ctx) {
    const user = userFor(ctx.user);
    const eventId = await eventOf(ctx);
    if (user && eventId) wrapped.playPause(user, { eventId });
  },

  end(ctx, { how, playedMs }) {
    const done = (async () => {
      const user = userFor(ctx.user);
      const eventId = await eventOf(ctx);
      if (!user || !eventId) return null;
      if (how === 'end') wrapped.playEnd(user, { eventId, playedMs });
      else if (how === 'skip') wrapped.playSkip(user, { eventId, playedMs });
      else wrapped.playStop(user, { eventId, playedMs });
      return eventId;
    })();
    const kept = done.catch(() => null);
    lastEnd.set(ctx.roomId, kept);
    return done;
  },
};
