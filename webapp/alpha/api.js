const MSTREAMAPI = (() => {
  let velvetModule = {};

  velvetModule.listOfServers = [];
  velvetModule.currentServer = {
    host: "",
    username: "",
    token: "",
    vpaths: []
  };
  
  async function req(type, url, dataObject) {
    const res = await fetch(url, {
      method: type,
      headers: {
        'Content-Type': 'application/json',
        'x-access-token': MSTREAMAPI.currentServer.token
        // 'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: dataObject ? JSON.stringify(dataObject) : undefined
    });

    if (res.ok !== true) {
      throw new Error(res);
    }

    return await res.json();
  }

  velvetModule.dirparser =  (directory) => {
    return req('POST', velvetModule.currentServer.host + 'api/v1/file-explorer', { directory: directory });
  }

  velvetModule.loadFileplaylist =  (path) => {
    return req('POST', velvetModule.currentServer.host + 'api/v1/file-explorer/m3u', { path });
  }

  velvetModule.recursiveScan =  (directory) => {
    return req('POST', velvetModule.currentServer.host + 'api/v1/file-explorer/recursive', { directory: directory });
  }

  velvetModule.savePlaylist =  (title, songs, live) => {
    const postData = { title: title, songs: songs };
    if (live !== undefined) {
      postData.live = live;
    }
    return req('POST', velvetModule.currentServer.host + 'api/v1/playlist/save', postData);
  }

  velvetModule.newPlaylist =  (title) => {
    return req('POST', velvetModule.currentServer.host + 'api/v1/playlist/new', { title: title });
  }

  velvetModule.deletePlaylist =  (playlistname) => {
    return req('POST', velvetModule.currentServer.host + 'api/v1/playlist/delete', { playlistname: playlistname });
  }

  velvetModule.removePlaylistSong =  (id) => {
    return req('POST', velvetModule.currentServer.host + 'api/v1/playlist/remove-song', { id: id });
  }

  velvetModule.loadPlaylist =  (playlistname) => {
    return req('POST', velvetModule.currentServer.host + 'api/v1/playlist/load', { playlistname: playlistname });
  }

  velvetModule.getAllPlaylists =  () => {
    return req('GET', velvetModule.currentServer.host + 'api/v1/playlist/getall', false);
  }

  velvetModule.addToPlaylist =  (playlist, song) => {
    return req('POST', velvetModule.currentServer.host + 'api/v1/playlist/add-song', { playlist: playlist, song: song });
  }

  velvetModule.search =  (postObject) => {
    return req('POST', velvetModule.currentServer.host + 'api/v1/db/search', postObject);
  }

  velvetModule.artists =  (postObject) => {
    return req('POST', velvetModule.currentServer.host + 'api/v1/db/artists', postObject);
  }

  velvetModule.albums =  (postObject) => {
    return req('POST', velvetModule.currentServer.host + 'api/v1/db/albums', postObject);
  }

  velvetModule.artistAlbums =  (postObject) => {
    return req('POST', velvetModule.currentServer.host + "api/v1/db/artists-albums", postObject);
  }

  velvetModule.albumSongs =  (postObject) => {
    return req('POST', velvetModule.currentServer.host + "api/v1/db/album-songs", postObject);
  }

  velvetModule.dbStatus =  () => {
    return req('GET', velvetModule.currentServer.host + "api/v1/db/status", false);
  }

  velvetModule.makeShared =  (playlist, shareTimeInDays) => {
    return req('POST', velvetModule.currentServer.host + "api/v1/share", { time: shareTimeInDays, playlist: playlist });
  }

  velvetModule.rateSong =  (filepath, rating) => {
    return req('POST', velvetModule.currentServer.host + "api/v1/db/rate-song", { filepath: filepath, rating: rating });
  }

  velvetModule.getRated =  (postObject) => {
    return req('POST', velvetModule.currentServer.host + "api/v1/db/rated", postObject);
  }

  velvetModule.getRecentlyAdded =  (limit, ignoreVPaths) => {
    return req('POST', velvetModule.currentServer.host + "api/v1/db/recent/added", { limit: limit, ignoreVPaths });
  }

  velvetModule.getRecentlyPlayed =  (limit, ignoreVPaths) => {
    return req('POST', velvetModule.currentServer.host + "api/v1/db/stats/recently-played", { limit: limit, ignoreVPaths });
  }

  velvetModule.getMostPlayed =  (limit, ignoreVPaths) => {
    return req('POST', velvetModule.currentServer.host + "api/v1/db/stats/most-played", { limit: limit, ignoreVPaths });
  }

  velvetModule.lookupMetadata =  (filepath) => {
    return req('POST', velvetModule.currentServer.host + "api/v1/db/metadata", { filepath: filepath });
  }

  velvetModule.getRandomSong =  (postObject) => {
    return req('POST', velvetModule.currentServer.host + "api/v1/db/random-songs", postObject);
  }

  // Scrobble
  velvetModule.scrobbleByMetadata =  (artist, album, trackName) => {
    return req('POST', velvetModule.currentServer.host +  "api/v1/lastfm/scrobble-by-metadata", { artist: artist, album: album, track: trackName });
  }

  velvetModule.scrobbleByFilePath =  (filePath) => {
    return req('POST', velvetModule.currentServer.host +  "api/v1/lastfm/scrobble-by-filepath", { filePath });
  }

  // LOGIN
  velvetModule.login =  (username, password, url) => {
    return req('POST', url ? url + "api/v1/auth/login" : "api/v1/auth/login", { username: username, password: password });
  }

  velvetModule.ping =  () => {
    return req('GET', velvetModule.currentServer.host + "api/v1/ping", false);
  }

  velvetModule.logout = () => {
    localStorage.removeItem('token');
    Cookies.remove('x-access-token');
    document.location.assign(window.location.href + (window.location.href.slice(-1) === '/' ? '' : '/') + 'login');
  }

  return velvetModule;
})();
