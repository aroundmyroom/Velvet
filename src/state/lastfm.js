// Scrobbler code shamelessly stolen from
// https://github.com/dittodhole/node-scribble-js

import https from 'node:https';
import crypto from 'node:crypto';
import querystring from 'node:querystring';

const Scribble = function () {
  this.users = {}
}

Scribble.prototype.addUser = function (username, password) {
  this.users[username] = {
    password: password,
    sessionKey: null
  }
}

// Restore a user from a persisted session key — password never stored
Scribble.prototype.addUserWithSession = function (username, sessionKey) {
  this.users[username] = {
    password: null,
    sessionKey: sessionKey
  }
}

Scribble.prototype.reset = function () {
  Object.keys(this.users).forEach(k => delete this.users[k])
}

Scribble.prototype.setKeys = function (api_key, api_secret) {
  this.apiKey = api_key
  this.apiSecret = api_secret
}

Scribble.prototype.Scrobble = function (song, username, callback) {
  if (this.users[username].sessionKey == null) {
    this.MakeSession(username, (sk) => {
      if (!sk) {
        if (typeof (callback) === 'function') { callback(null) }
        return
      }
      postScrobble(this, song, sk, username, callback)
    })
  } else {
    postScrobble(this, song, this.users[username].sessionKey, username, callback)
  }
}

// Calls back with the session key, or null when Last.fm refuses (bad password, error object).
Scribble.prototype.MakeSession = function (username, callback) {
  const password = this.users[username].password;

  const token = makeHash(username + makeHash(password))
    , apiSig = makeHash('api_key' + this.apiKey + 'authToken' + token + 'methodauth.getMobileSessionusername' + username + this.apiSecret)
    , path = '/2.0/?method=auth.getMobileSession&' +
      'username=' + encodeURIComponent(username) +
      '&authToken=' + token +
      '&api_key=' + this.apiKey +
      '&api_sig=' + apiSig + '&format=json'
  sendGet(path, (ret) => {
    const key = ret?.session?.key ?? null
    if (key) { this.users[username].sessionKey = key }
    else { console.warn(`[lastfm] could not open a session for ${username}: ${ret?.message ?? 'no response'}`) }
    if (typeof (callback) === 'function') { callback(key) }
  })
}

Scribble.prototype.GetArtistInfo = function (artist, callback) {
  const path = '/2.0/?method=artist.getInfo&artist=' + encodeURIComponent(artist) + '&api_key=' + this.apiKey + '&format=json';
  sendGet(path, function (ret) {
    if (typeof (callback) === 'function')
      { callback(ret); }
  });
}

Scribble.prototype.GetSimilarSongs = function (song, callback, limit = 50) {
  const path = '/2.0/?method=track.getSimilar&artist=' + encodeURIComponent(song.artist) + '&track=' + encodeURIComponent(song.track) + '&api_key=' + this.apiKey + '&format=json&limit=' + limit
  sendGet(path, function (ret) {
    if (typeof (callback) === 'function')
      {callback(ret)}
  })
}

function postScrobble(self, song, sk, username, callback) {
  if (sk && self.users[username].sessionKey == null) {
    self.users[username].sessionKey = sk
  }
  const timestamp = Math.floor(Date.now() / 1000)
    , apiSig = makeHash('album' + (song.album || '_') + 'api_key' + self.apiKey + 'artist' + song.artist + 'methodtrack.scrobblesk' + self.users[username].sessionKey + 'timestamp' + timestamp + 'track' + song.track + self.apiSecret)
    , post_data = querystring.stringify({
      method: 'track.scrobble',
      api_key: self.apiKey,
      sk: self.users[username].sessionKey,
      api_sig: apiSig,
      timestamp: timestamp,
      artist: song.artist,
      track: song.track,
      album: song.album || '_'
    })
  sendPost(post_data, callback)
}

function sendPost(data, callback) {
  const options = {
    host: 'ws.audioscrobbler.com',
    path: '/2.0/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(data)
    }
  }
    , doPOST = https.request(options, function (request) {
      let reqReturn = ''
      request.setEncoding('utf8')
      request.on('data', function (chunk) {
        reqReturn += chunk
      })
      request.on('end', function () {
        if (typeof (callback) === 'function')
          {callback(reqReturn)}
      })
    }).on('error', function (_err) {
      if (typeof (callback) === 'function') { callback(null); }
    })
  doPOST.write(data)
  doPOST.end()
}

// The callback runs once, outside the parse try: an exception it throws must not re-enter it.
function sendGet(path, callback) {
  let response = '';
  const apiCall = {
      host: 'ws.audioscrobbler.com',
      path: path
    }
  https.get(apiCall, function (res) {
    res.on('data', function (chunk) {
      response += chunk;
    })
    res.on('end', function () {
      let ret = null
      try {
        ret = JSON.parse(response)
      } catch {
        console.warn('[lastfm] non-JSON response from Last.fm API');
      }
      if (typeof (callback) === 'function') { callback(ret); }
    })
  }).on('error', function (err) {
    console.warn('[lastfm] network error:', err.message);
    if (typeof (callback) === 'function') { callback(null); }
  })
}

function makeHash(input) {
  return crypto.createHash('md5').update(input, 'utf8').digest("hex") // NOSONAR: Last.fm API requires MD5 per protocol specification
}

export default Scribble;
