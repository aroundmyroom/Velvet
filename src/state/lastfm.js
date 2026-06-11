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

Scribble.prototype.Love = function (song, username, callback) {
  if (this.users[username].sessionKey == null) {
    this.MakeSession(username, (sk) => {
      postLove(this, song, sk, username, callback)
    })
  } else {
    postLove(this, song, this.users[username].sessionKey, username, callback)
  }
}

Scribble.prototype.Scrobble = function (song, username, callback) {
  if (this.users[username].sessionKey == null) {
    this.MakeSession(username, (sk) => {
      postScrobble(this, song, sk, username, callback)
    })
  } else {
    postScrobble(this, song, this.users[username].sessionKey, username, callback)
  }
}

Scribble.prototype.NowPlaying = function (song, username, callback) {
  if (this.users[username].sessionKey == null) {
    this.MakeSession(username, (sk) => {
      postNowPlaying(this, song, sk, username, callback)
    })
  } else {
    postNowPlaying(this, song, this.users[username].sessionKey, username, callback)
  }
}

Scribble.prototype.MakeSession = function (username, callback) {
  const password = this.users[username].password;

  const token = makeHash(username + makeHash(password))
    , apiSig = makeHash('api_key' + this.apiKey + 'authToken' + token + 'methodauth.getMobileSessionusername' + username + this.apiSecret)
    , path = '/2.0/?method=auth.getMobileSession&' +
      'username=' + username +
      '&authToken=' + token +
      '&api_key=' + this.apiKey +
      '&api_sig=' + apiSig + '&format=json'
  sendGet(path, (ret) => {
    this.users[username].sessionKey = ret.session.key
    if (typeof (callback) === 'function') {
      callback(ret.session.key)
    }
  })
}

Scribble.prototype.GetArtistInfo = function (artist, callback) {
  const path = '/2.0/?method=artist.getInfo&artist=' + encodeURIComponent(artist) + '&api_key=' + this.apiKey + '&format=json'
  sendGet(path, function (ret) {
    if (typeof (callback) === 'function')
      {callback(ret)}
  })
}

Scribble.prototype.GetSimilarArtists = function (artist, callback, limit = 50) {
  const amt = limit;
  const path = '/2.0/?method=artist.getSimilar&artist=' + encodeURIComponent(artist) + '&api_key=' + this.apiKey + '&format=json&limit=' + amt
  sendGet(path, function (ret) {
    if (typeof (callback) === 'function')
      {callback(ret)}
  })
}

Scribble.prototype.GetArtistInfo = function (artist, callback) {
  const path = '/2.0/?method=artist.getInfo&artist=' + encodeURIComponent(artist) + '&api_key=' + this.apiKey + '&format=json';
  sendGet(path, function (ret) {
    if (typeof (callback) === 'function')
      { callback(ret); }
  });
}

Scribble.prototype.GetArtistEvents = function (artist, callback, limit = 50) {
  const amt = limit;
  const path = '/2.0/?method=artist.getevents&artist=' + encodeURIComponent(artist) + '&api_key=' + this.apiKey + '&format=json&limit=' + amt
  sendGet(path, function (ret) {
    if (typeof (callback) === 'function')
      {callback(ret)}
  })
}

Scribble.prototype.GetArtistTopAlbums = function (artist, callback, limit = 50) {
  const path = '/2.0/?method=artist.gettopalbums&artist=' + encodeURIComponent(artist) + '&api_key=' + this.apiKey + '&format=json&limit=' + limit
  sendGet(path, function (ret) {
    if (typeof (callback) === 'function')
      {callback(ret)}
  })
}

Scribble.prototype.GetArtistTopTracks = function (artist, callback, limit = 50) {
  const path = '/2.0/?method=artist.gettoptracks&artist=' + encodeURIComponent(artist) + '&api_key=' + this.apiKey + '&format=json&limit=' + limit
  sendGet(path, function (ret) {
    if (typeof (callback) === 'function')
      {callback(ret)}
  })
}

Scribble.prototype.GetSimilarSongs = function (song, callback, limit = 50) {
  const path = '/2.0/?method=track.getSimilar&artist=' + encodeURIComponent(song.artist) + '&track=' + encodeURIComponent(song.track) + '&api_key=' + this.apiKey + '&format=json&limit=' + limit
  sendGet(path, function (ret) {
    if (typeof (callback) === 'function')
      {callback(ret)}
  })
}

Scribble.prototype.GetTrackInfo = function (song, callback) {
  const path = '/2.0/?method=track.getInfo&api_key=' + this.apiKey + '&artist=' + encodeURIComponent(song.artist) + '&track=' + encodeURIComponent(song.track) + '&format=json'
  sendGet(path, function (ret) {
    if (typeof (callback) === 'function')
      {callback(ret)}
  })
}

Scribble.prototype.GetAlbumInfo = function (song, callback) {
  song.album = song.album.replaceAll(/\s/g, '%20')
  const path = '2.0/?method=album.getinfo&api_key=' + this.apiKey + '&artist=' + song.artist + '&album=' + song.album + '&format=json'
  sendGet(path, function (ret) {
    if (typeof (callback) === 'function')
      {callback(ret)}
  })
}

function postLove(self, song, sk, username, callback) {
  if (sk && self.users[username].sessionKey == null) {
    self.users[username].sessionKey = sk
  }
  const apiSig = makeHash('album' + (song.album || '_') + 'api_key' + self.apiKey + 'artist' + song.artist + 'methodtrack.lovesk' + self.users[username].sessionKey + 'track' + song.track + self.apiSecret)
    , post_data = querystring.stringify({
      method: 'track.love',
      api_key: self.apiKey,
      sk: self.users[username].sessionKey,
      api_sig: apiSig,
      artist: song.artist,
      track: song.track,
      album: song.album || '_'
    })
  sendPost(post_data, callback)
}

function postNowPlaying(self, song, sk, username, callback) {
  if (sk && self.users[username].sessionKey == null) {
    self.users[username].sessionKey = sk
  }
  const dur = (song.duration) ? 'duration' + song.duration : ''
    , apiSig = makeHash('album' + (song.album || '_') + 'api_key' + self.apiKey + 'artist' + song.artist + dur + 'methodtrack.updateNowPlayingsk' + self.users[username].sessionKey + 'track' + song.track + self.apiSecret)
    , post_data = querystring.stringify({
      method: 'track.updateNowPlaying',
      artist: song.artist,
      track: song.track,
      album: song.album || '_',
      duration: song.duration,
      api_key: self.apiKey,
      api_sig: apiSig,
      sk: self.users[username].sessionKey
    })
  sendPost(post_data, callback)
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
      try {
        const ret = JSON.parse(response)
        if (typeof (callback) === 'function') { callback(ret); }
      } catch {
        console.warn('[lastfm] non-JSON response from Last.fm API');
        if (typeof (callback) === 'function') { callback(null); }
      }
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
