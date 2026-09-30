// One compact journal line per Auto-DJ pick, written when the web player reports
// the play start (POST /api/v1/wrapped/play-start with source=autodj and a `dj`
// trace). The decision itself is made client-side (_djPickSong in webapp/app.js),
// so without the client handing over its numbers the server log could only ever
// show *what* played, never *why* — which is exactly the question that kept
// coming up ("how did Auto-DJ land on Valerie Dore?").
//
// Deliberately bounded: every field is Joi-capped upstream, strings are cut and
// control characters removed here, and it is one line per track — a full day of
// Auto-DJ is a few dozen KB, never a candidate dump.

const clean = (s, max) => String(s ?? '').replaceAll(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, max); // eslint-disable-line no-control-regex
const num = v => (v == null || Number.isNaN(Number(v)) ? '?' : String(Math.round(Number(v) * 10) / 10));

function arrow(from, to, max = 32) {
  const a = clean(from, max) || '?';
  const b = clean(to, max) || '?';
  return a === b ? a : `${a}→${b}`;
}

export function formatAutoDjPick(username, fileRow, dj = {}) {
  const who = clean(username, 40) || '?';
  const track = `${clean(fileRow?.artist, 60) || '?'} — ${clean(fileRow?.title, 80) || '?'}`;
  const parts = [
    `score=${dj.score == null ? '?' : Number(dj.score).toFixed(3)}`,
    `cands=${dj.cands ?? '?'}`,
    `similar=${dj.similar ?? 0}`,
  ];
  if (dj.escape) parts.push(`escape=${clean(dj.escape, 40)}${dj.dropArtist ? '(hard)' : ''}`);
  const ctx = [
    `bpm ${arrow(num(dj.curBpm), num(fileRow?.bpm))}`,
    `key ${arrow(dj.curKey, fileRow?.musical_key, 16)}`,
    `year ${arrow(dj.curYear ?? '?', fileRow?.year ?? '?', 6)}`,
    `genre ${arrow(dj.curGenre, fileRow?.genre, 40)}`,
  ];
  return `[autodj] ▶ ${who}: "${track}" ${parts.join(' ')} | ${ctx.join(' ')}`;
}
