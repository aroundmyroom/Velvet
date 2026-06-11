import { XMLParser } from 'fast-xml-parser';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, unlink, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import path from 'node:path';
import Joi from 'joi';
import * as config from '../state/config.js';
import * as db from '../db/manager.js';
import { isPrivateHost } from '../util/ssrf-check.js';
import { resolvePathWithinRoot } from '../util/path-security.js';

function _parseDuration(v) {
  if (!v && v !== 0) return 0;
  if (!Number.isNaN(v)) return Number.parseInt(v, 10);
  const parts = String(v).split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
  if (parts.length === 2) return parts[0] * 60 + (parts[1] || 0);
  return 0;
}

async function _cacheArt(imgUrl) {
  if (!imgUrl) return null;
  if (!/^https?:\/\//i.test(imgUrl)) return imgUrl;
  try {
    const hash = createHash('sha256').update(imgUrl).digest('hex');
    const artDir = config.program.storage.albumArtDirectory;
    await mkdir(artDir, { recursive: true });
    const urlExt = imgUrl.split('?')[0].match(/\.(png|gif|webp|svg|jpe?g)$/i)?.[1]?.toLowerCase().replaceAll('jpeg', 'jpg');
    if (urlExt) {
      const cached = path.join(artDir, `podcast-${hash}.${urlExt}`);
      if (existsSync(cached)) return `podcast-${hash}.${urlExt}`;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    const r = await fetch(imgUrl, { signal: ac.signal, redirect: 'follow' });
    clearTimeout(timer);
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) return null;
    const ctExtMap = { 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/jpeg': 'jpg' };
    const ext = urlExt || ctExtMap[ct.split(';')[0].trim().toLowerCase()] || 'jpg';
    const filename = `podcast-${hash}.${ext}`;
    const fullPath = path.join(artDir, filename);
    if (existsSync(fullPath)) return filename;
    const buf = await r.arrayBuffer();
    await writeFile(fullPath, Buffer.from(buf));
    for (const prefix of ['zs-', 'zl-']) {
      const thumb = path.join(artDir, prefix + filename);
      if (existsSync(thumb)) unlink(thumb, () => {});
    }
    return filename;
  } catch { return null; }
}

// processEntities:false is required — RSS feeds like Anchor/Spotify embed hundreds
// of HTML entities (&lt;p&gt; etc.) in itunes:summary fields; fast-xml-parser's
// default limit of 1000 is easily exceeded with 88+ episodes.
const _xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => name === 'item',
  parseTagValue: true,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
});

function _str(v) {
  if (v == null) return '';
  if (typeof v === 'object') return String(v['#text'] || '');
  return String(v);
}

// Strips both real HTML tags (<p>) and entity-encoded HTML (&lt;p&gt;),
// then decodes remaining XML entities so plain text reads correctly.
function _cleanHtml(s) {
  if (!s) return '';
  let r = String(s);
  r = r.replaceAll(/<[^>]+>/g, ' ');               // real HTML tags
  r = r.replaceAll(/&lt;[^&]*?&gt;/g, ' ');        // entity-encoded HTML tags
  r = r.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'");
  r = r.replaceAll(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number.parseInt(n, 10)));
  r = r.replaceAll(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)));
  return r.replaceAll(/\s+/g, ' ').trim();
}

// Decodes XML/HTML entities that commonly appear in RSS URL attributes.
// Only decodes characters safe to unescape in a URL context.
function _decodeUrlEntities(s) {
  if (!s?.includes('&')) return s;
  return String(s)
    .replaceAll('&amp;',  '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;',   '<')
    .replaceAll('&gt;',   '>');
}

function _resolveAlbumArtPath(filename) {
  if (!filename || path.basename(filename) !== filename || filename.includes('..')) return null;
  try {
    return resolvePathWithinRoot(config.program.storage.albumArtDirectory, filename);
  } catch {
    return null;
  }
}

function _parseRss(xmlText) {
  let parsed;
  try { parsed = _xmlParser.parse(xmlText); } catch (e) { throw new Error('Invalid XML: ' + e.message, { cause: e }); }

  const ch = parsed?.rss?.channel;
  if (!ch) throw new Error('Not a valid RSS 2.0 feed');

  const title = _str(ch.title);
  const description = _str(ch.description) || _str(ch['itunes:summary']);
  const author = _str(ch['itunes:author']) || _str(ch['itunes:owner']?.['itunes:name']) || _str(ch.author);
  const language = _str(ch.language);

  let imgUrl = null;
  if (ch['itunes:image']?.['@_href']) imgUrl = String(ch['itunes:image']['@_href']);
  else if (ch['itunes:image']) imgUrl = _str(ch['itunes:image']);
  else if (ch.image?.url) imgUrl = _str(ch.image.url);
  if (imgUrl) imgUrl = _decodeUrlEntities(imgUrl);

  let rawItems;
  if (Array.isArray(ch.item)) { rawItems = ch.item; }
  else if (ch.item) { rawItems = [ch.item]; }
  else { rawItems = []; }

  const episodes = [];
  for (const item of rawItems) {
    // Resolve audio URL — try standard enclosure, BBC's ppg:enclosureSecure, media:content
    let audioUrl = null;
    const enc = item.enclosure;
    if (enc?.['@_url'] && (!enc['@_type'] || enc['@_type'].startsWith('audio/'))) {
      audioUrl = String(enc['@_url']);
    }
    if (!audioUrl) {
      const ppg = item['ppg:enclosureSecure'];
      if (ppg?.['@_url']) audioUrl = String(ppg['@_url']);
    }
    if (!audioUrl) {
      const mc = item['media:content'];
      if (mc?.['@_url'] && mc['@_type']?.startsWith('audio/')) audioUrl = String(mc['@_url']);
    }
    if (!audioUrl || !/^https?:\/\//i.test(audioUrl)) continue;
    audioUrl = _decodeUrlEntities(audioUrl);

    const guid = _str(item.guid?.['#text'] ?? item.guid) || audioUrl;
    const epTitle = _cleanHtml(_str(item.title)) || '(No title)';
    const rawDesc = _str(item['itunes:summary']) || _str(item.description);
    const description = _cleanHtml(rawDesc);
    const durationSecs = _parseDuration(item['itunes:duration']);

    let pubDate = null;
    if (item.pubDate) {
      const d = new Date(_str(item.pubDate));
      if (!Number.isNaN(d.getTime())) pubDate = Math.floor(d.getTime() / 1000);
    }

    const episodeImg = item['itunes:image']?.['@_href'] ? _decodeUrlEntities(String(item['itunes:image']['@_href'])) : null;

    episodes.push({ guid, title: epTitle, description, audio_url: audioUrl, pub_date: pubDate, duration_secs: durationSecs, img: episodeImg });
  }

  if (episodes.length === 0) throw new Error('No audio episodes found in this feed');

  const cleanTitle = _cleanHtml(title) || '(Untitled)';
  const cleanDesc  = _cleanHtml(description);
  const cleanAuthor = _cleanHtml(author);
  return { title: cleanTitle, description: cleanDesc, imgUrl, author: cleanAuthor, language: language.trim(), episodes };
}

async function _fetchAndParse(url) {
  const parsed = new URL(url);
  if (isPrivateHost(parsed.hostname)) throw new Error('That URL is not allowed');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  let r;
  try {
    r = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Velvet/5 PodcastClient', 'Accept': 'application/rss+xml, application/xml, text/xml, */*' }
    });
    clearTimeout(timer);
  } catch (e) {
    clearTimeout(timer);
    throw new Error('Failed to fetch feed: ' + (e?.message || 'network error'), { cause: e });
  }

  if (!r.ok) throw new Error(`Feed returned HTTP ${r.status}`);
  const text = await r.text();
  return _parseRss(text);
}

export function setup(velvet) {
  // GET /api/v1/podcast/preview?url=... — fetch & parse without saving
  velvet.get('/api/v1/podcast/preview', async (req, res) => {
    const url = String(req.query.url || '').trim();
    if (!url) return res.status(400).json({ error: 'url is required' });
    try {
      const parsed = new URL(url);
      if (isPrivateHost(parsed.hostname)) return res.status(400).json({ error: 'That URL is not allowed' });
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        return res.status(400).json({ error: 'Only http/https URLs are allowed' });
    } catch { return res.status(400).json({ error: 'Invalid URL' }); }
    try {
      const feed = await _fetchAndParse(url);
      res.json({
        title:        feed.title,
        description:  feed.description,
        author:       feed.author,
        language:     feed.language,
        imgUrl:       feed.imgUrl,
        episodeCount: feed.episodes.length,
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // GET /api/v1/podcast/feeds
  velvet.get('/api/v1/podcast/feeds', (req, res) => {
    res.json(db.getPodcastFeeds(req.user.username));
  });

  // POST /api/v1/podcast/feeds — subscribe
  velvet.post('/api/v1/podcast/feeds', async (req, res) => {
    const schema = Joi.object({
      url:  Joi.string().uri({ scheme: ['http', 'https'] }).max(2048).required(),
      name: Joi.string().max(200).allow('', null).optional(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    try {
      const parsed = new URL(value.url);
      if (isPrivateHost(parsed.hostname)) return res.status(400).json({ error: 'That URL is not allowed' });
    } catch { return res.status(400).json({ error: 'Invalid URL' }); }

    try {
      const feed = await _fetchAndParse(value.url);
      const img = await _cacheArt(feed.imgUrl);
      const feedId = db.createPodcastFeed(req.user.username, {
        url: value.url,
        title: value.name?.trim() || feed.title,
        description: feed.description,
        img: img || null, author: feed.author, language: feed.language,
        last_fetched: Math.floor(Date.now() / 1000),
      });
      db.upsertPodcastEpisodes(feedId, feed.episodes);
      res.json(db.getPodcastFeed(feedId, req.user.username));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // PUT /api/v1/podcast/feeds/reorder
  velvet.put('/api/v1/podcast/feeds/reorder', (req, res) => {
    const schema = Joi.object({ ids: Joi.array().items(Joi.number().integer()).min(1).required() });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    db.reorderPodcastFeeds(req.user.username, value.ids);
    res.json({});
  });

  // PATCH /api/v1/podcast/feeds/:id — rename / edit
  velvet.patch('/api/v1/podcast/feeds/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const schema = Joi.object({
      title: Joi.string().max(200).optional(),
      url:   Joi.string().uri({ scheme: ['http', 'https'] }).max(2048).optional(),
    }).or('title', 'url');
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    const feed = db.getPodcastFeed(id, req.user.username);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    if (value.title) db.updatePodcastFeedTitle(id, req.user.username, value.title.trim());
    if (value.url)   db.updatePodcastFeedUrl(id, req.user.username, value.url.trim());
    res.json(db.getPodcastFeed(id, req.user.username));
  });

  // DELETE /api/v1/podcast/feeds/:id
  velvet.delete('/api/v1/podcast/feeds/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

    const feed = db.getPodcastFeed(id, req.user.username);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });

    db.deletePodcastFeed(id, req.user.username);

    if (feed.img && !/^https?:\/\//i.test(feed.img)) {
      if (db.getPodcastFeedImgUsageCount(feed.img) === 0) {
        for (const prefix of ['', 'zs-', 'zl-']) {
          const artPath = _resolveAlbumArtPath(prefix + feed.img);
          if (artPath) {
            try { unlink(artPath, () => {}); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
          }
        }
      }
    }
    res.json({});
  });

  // POST /api/v1/podcast/feeds/:id/refresh
  velvet.post('/api/v1/podcast/feeds/:id/refresh', async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

    const feed = db.getPodcastFeed(id, req.user.username);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });

    try {
      const parsed = await _fetchAndParse(feed.url);
      db.upsertPodcastEpisodes(id, parsed.episodes);
      db.updatePodcastFeedFetched(id, req.user.username, Math.floor(Date.now() / 1000));

      // Re-cache art if the file is missing from disk (e.g. deleted by orphan cleanup)
      if (parsed.imgUrl && feed.img) {
        const fullPath = _resolveAlbumArtPath(feed.img);
        if (!fullPath || !existsSync(fullPath)) {
          const newImg = await _cacheArt(parsed.imgUrl);
          if (newImg) db.updatePodcastFeedImg(id, req.user.username, newImg);
        }
      }

      res.json(db.getPodcastFeed(id, req.user.username));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // GET /api/v1/podcast/episodes/:feedId
  velvet.get('/api/v1/podcast/episodes/:feedId', (req, res) => {
    const feedId = Number.parseInt(req.params.feedId, 10);
    if (!Number.isFinite(feedId)) return res.status(400).json({ error: 'Invalid feedId' });

    const feed = db.getPodcastFeed(feedId, req.user.username);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });

    res.json(db.getPodcastEpisodes(feedId));
  });

  // POST /api/v1/podcast/episode/progress
  velvet.post('/api/v1/podcast/episode/progress', (req, res) => {
    const schema = Joi.object({
      episodeId: Joi.number().integer().required(),
      feedId:    Joi.number().integer().required(),
      position:  Joi.number().min(0).required(),
      played:    Joi.boolean().optional(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const feed = db.getPodcastFeed(value.feedId, req.user.username);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });

    db.saveEpisodeProgress(value.episodeId, value.feedId, value.position, value.played ?? false);
    res.json({});
  });

  // POST /api/v1/podcast/episode/save — download episode audio to the server's AudioBooks folder
  velvet.post('/api/v1/podcast/episode/save', async (req, res) => {
    const schema = Joi.object({
      feedId:    Joi.number().integer().required(),
      episodeId: Joi.number().integer().required(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });

    const feed = db.getPodcastFeed(value.feedId, req.user.username);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });

    const ep = db.getPodcastEpisode(value.episodeId);
    if (!ep || ep.feed_id !== value.feedId) return res.status(404).json({ error: 'Episode not found' });

    let audioUrl;
    try {
      audioUrl = new URL(ep.audio_url);
      if (audioUrl.protocol !== 'http:' && audioUrl.protocol !== 'https:')
        return res.status(400).json({ error: 'Episode audio URL must be http or https' });
      if (isPrivateHost(audioUrl.hostname))
        return res.status(400).json({ error: 'Episode audio URL is not allowed' });
    } catch { return res.status(400).json({ error: 'Invalid episode audio URL' }); }

    const { targetRoot, targetVpathName } = _findAudioBooksVpath(req.user.username);
    if (!targetRoot) return res.status(400).json({ error: 'No AudioBooks/Podcasts folder is configured for your account' });

    const _sanitize = (s, max) =>
      (s || '').replaceAll(/[/\\:*?"<>|]/g, '').replaceAll(/\.{2,}/g, '.').replaceAll(/\s+/g, ' ').trim().slice(0, max) || 'unnamed';

    const safeFeedTitle = _sanitize(feed.title, 80);
    const safeEpTitle   = _sanitize(ep.title || 'episode', 100);
    const dateStr       = ep.pub_date ? new Date(ep.pub_date * 1000).toISOString().slice(0, 10) : '';
    const urlExt        = /\.(mp3|m4a|ogg|flac|opus|aac|wav)$/i.exec(audioUrl.pathname)?.[1]?.toLowerCase();

    const folderPath = path.join(targetRoot, safeFeedTitle);
    const baseName   = dateStr ? `${dateStr} ${safeEpTitle}` : safeEpTitle;

    try { await mkdir(folderPath, { recursive: true }); } catch (e) {
      return res.status(500).json({ error: 'Could not create folder: ' + (e?.message || 'unknown error') });
    }

    const { dlRes, ext } = await _fetchEpisodeAudio(ep.audio_url, urlExt);
    if (!dlRes) return res.status(502).json({ error: 'Failed to fetch episode' });
    if (!dlRes.ok) return res.status(502).json({ error: `Episode server returned HTTP ${dlRes.status}` });

    const filename = `${baseName}.${ext}`;
    const filePath = path.join(folderPath, filename);

    const fileStream = createWriteStream(filePath);
    try {
      await pipeline(Readable.fromWeb(dlRes.body), fileStream);
    } catch (e) {
      try { unlink(filePath, () => {}); } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      return res.status(500).json({ error: 'Failed to save file: ' + (e?.message || 'write error') });
    }

    res.json({ savedTo: path.join(targetVpathName, safeFeedTitle, filename) });
  });
}

function _findAudioBooksVpath(username) {
  const userVpaths = config.program.users[username]?.vpaths || [];
  for (const vpath of userVpaths) {
    const folder = config.program.folders[vpath];
    if (folder?.type === 'audio-books') return { targetRoot: folder.root, targetVpathName: vpath };
  }
  return { targetRoot: null, targetVpathName: null };
}

async function _fetchEpisodeAudio(audioUrl, urlExt) {
  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(), 120000);
  let dlRes;
  try {
    dlRes = await fetch(audioUrl, {
      signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': 'Velvet/5 PodcastClient' }
    });
    clearTimeout(timer);
  } catch {
    clearTimeout(timer);
    return { dlRes: null, ext: urlExt || 'mp3' };
  }
  let ext = urlExt || 'mp3';
  if (!urlExt) {
    const ctExtMap = { 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
      'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/opus': 'opus',
      'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };
    const ct = (dlRes.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (ctExtMap[ct]) ext = ctExtMap[ct];
  }
  return { dlRes, ext };
}
