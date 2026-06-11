const MSTREAMPLAYER = (() => {
  const velvetModule = {};

  velvetModule.transcodeOptions = {
    serverEnabled: false,
    frontendEnabled: false,
    defaultBitrate: null,
    defaultCodec: null,
    defaultAlgo: null,
    selectedBitrate: null,
    selectedCodec: null,
    selectedAlgo: null,
  };

  // Playlist variables
  velvetModule.positionCache = { val: -1 };
  velvetModule.playlist = [];
  const cacheTimeout = 30000;
  
  var currentReplayGainAmp = 1.0;

  velvetModule.editSongMetadata = function (key, value, songIndex) {
    for (var i = 0, len = velvetModule.playlist.length; i < len; i++) {
      if ((velvetModule.playlist[i].metadata && velvetModule.playlist[i].metadata.hash === velvetModule.playlist[songIndex].metadata.hash) || velvetModule.playlist[i].filepath === velvetModule.playlist[songIndex].filepath) {
        velvetModule.playlist[i].metadata[key] = value;
      }
    }
  }

  velvetModule.changeVolume = (newVolume) => {
    if (isNaN(newVolume) || newVolume < 0 || newVolume > 100) {
      return;
    }
    velvetModule.playerStats.volume = newVolume;

    const rgainAdjustedVolume = newVolume / 100 * currentReplayGainAmp;
    getCurrentPlayer().playerObject.volume = rgainAdjustedVolume;
    getOtherPlayer().playerObject.volume = rgainAdjustedVolume;
  }

  // Scrobble function
  // This is a placeholder function that the API layer can take hold of to implement the scrobble call
  let scrobbleTimer;
  velvetModule.scrobble = () => {
    MSTREAMAPI.scrobbleByFilePath(
      velvetModule.getCurrentSong().rawFilePath, 
      (response, error) => {});
  }

  // The audioData looks like this
  // var song = {
  //   "url":"vPath/path/to/song.mp3?token=xxx",
  //   "filepath": "path/to/song.mp3"
  // }
  velvetModule.addSong = (audioData, forceAutoPlayOff) => {
    if (!audioData.url || audioData.url == false) {
      return false;
    }

    audioData.error = false;

    // Handle shuffle
    if (velvetModule.playerStats.shuffle === true) {
      const pos = Math.floor(Math.random() * (shuffleCache.length + 1));
      shuffleCache.splice(pos, 0, audioData);
    }

    return addSongToPlaylist(audioData, forceAutoPlayOff);
  }

  async function autoDJ() {
    try {
      const params = {
        ignoreList: autoDjIgnoreArray,
        minRating: velvetModule.minRating,
        ignoreVPaths: Object.keys(velvetModule.ignoreVPaths).filter((vpath) => {
          return velvetModule.ignoreVPaths[vpath] === true;
        })
      };
  
      const res = await MSTREAMAPI.getRandomSong(params);
      autoDjIgnoreArray = res.ignoreList;

      VUEPLAYERCORE.addSongWizard(res.songs[0].filepath, res.songs[0].metadata);

    }catch (err) {
      console.log(err);
      iziToast.warning({
        title: 'Auto DJ Failed',
        position: 'topCenter',
        timeout: 3500
      });
    }
  }

  function addSongToPlaylist(song, forceAutoPlayOff) {
    velvetModule.playlist.push(song);

    // If this the first song in the list
    if (velvetModule.playlist.length === 1) {
      velvetModule.positionCache.val = 0;
      return goToSong(velvetModule.positionCache.val, forceAutoPlayOff);
    }

    // TODO: Check if we are at the end of the playlist and nothing is playing.

    // Cache song if appropriate
    if ((!cacheTimer) && velvetModule.playlist.length > velvetModule.positionCache.val + 1 && velvetModule.positionCache.val === velvetModule.playlist.length -2) {
      clearTimeout(cacheTimer);
      cacheTimer = setTimeout(function () { 
        setCachedSong(velvetModule.positionCache.val + 1); 
        cacheTimer = undefined;
      }, cacheTimeout);
    }

    return true;
  }

  velvetModule.insertSongAt = (song, position, playNow) => {
    if (!song.url || song.url == false) {
      return false;
    }

    song.error = false;

    velvetModule.playlist.splice(position, 0, song);

    if (playNow) {
      velvetModule.positionCache.val = position;
      goToSong(velvetModule.positionCache.val);
    }

    // TODO: Check cache. Since we use this for play now only, the cache is usually preserved
  }

  velvetModule.clearAndPlay = function (song) {
    // Clear playlist
    velvetModule.playlist = [];
    return addSong(song);
  }

  velvetModule.clearPlaylist = function () {
    while (velvetModule.playlist.length > 0) { velvetModule.playlist.pop(); }
    velvetModule.positionCache.val = -1;

    clearEnd();

    // Clear shuffle as well
    if (velvetModule.playerStats.shuffle === true) {
      // Clear Shuffle Cache
      while (shuffleCache.length > 0) { shuffleCache.pop(); }
    }

    if (velvetModule.playerStats.autoDJ === true) {
      autoDJ();
    }

    return true;
  }

  velvetModule.nextSong = function () {
    // Stop the current song
    return goToNextSong();
  }

  velvetModule.previousSong = function () {
    return goToPreviousSong();
  }

  velvetModule.goToSongAtPosition = function (position) {
    if (!velvetModule.playlist[position]) {
      return false;
    }

    clearEnd();

    velvetModule.positionCache.val = position;
    return goToSong(velvetModule.positionCache.val);
  }

  velvetModule.removeSongAtPosition = function (position, sanityCheckUrl) {
    // Check that position is filled
    if (position > velvetModule.playlist.length || position < 0) {
      return false;
    }
    // If sanityCheckUrl, check that url are the same
    if (sanityCheckUrl && sanityCheckUrl != velvetModule.playlist[position].url) {
      return false;
    }

    var removedSong = velvetModule.playlist[position];

    // Remove song
    velvetModule.playlist.splice(position, 1);

    if (velvetModule.playerStats.shuffle === true) {
      //  Remove song from shuffle Cache
      for (var i = 0, len = shuffleCache.length; i < len; i++) {
        // Check if this is the current song
        if (removedSong === shuffleCache[i]) {
          shuffleCache.splice(i, 1);
        }
      }
      for (var i = 0, len = shufflePrevious.length; i < len; i++) {
        // Check if this is the current song
        if (removedSong === shufflePrevious[i]) {
          shufflePrevious.splice(i, 1);
        }
      }
    }

    // Handle case where user removes current song and it's the last song in the playlist
    if (position === velvetModule.positionCache.val && position === velvetModule.playlist.length) {
      clearEnd();
      // Go to random song if random is set
      if (velvetModule.playerStats.shuffle === true) {
        goToNextSong();
      } else if (velvetModule.playerStats.shouldLoop === true) { // loop is set
        velvetModule.positionCache.val = 0;
        goToSong(velvetModule.positionCache.val);
      } else { // Reset to start is nothing is set
        velvetModule.positionCache.val = -1;
      }
    } else if (position === velvetModule.positionCache.val) { // User removes currently playing song
      // Go to next song
      clearEnd();

      // If random is set, go to random song
      if (velvetModule.playerStats.shuffle === true) {
        goToNextSong();
      } else {
        goToSong(velvetModule.positionCache.val);
      }

    } else if (position < velvetModule.positionCache.val) {
      // Lower position cache by 1 if necessary
      velvetModule.positionCache.val--;
    } else if (position === (velvetModule.positionCache.val + 1)) {
      if(velvetModule.positionCache.val === (velvetModule.playlist.length - 1) && velvetModule.playerStats.autoDJ === true) {
          autoDJ();
      }

      // If the next song is removed, reset cache
      clearTimeout(cacheTimer);
      cacheTimer = setTimeout(function () {
        cacheTimer = undefined;
        if(velvetModule.playerStats.shuffle === true) {
          // TODO: This doesn't actually get triggered if remove the next shuffle song
          // if(shuffleCache[0]) {
          //   for (var i = 0; i < velvetModule.playlist.length; i++) {
          //     if(velvetModule.playlist[i] === shuffleCache[shuffleCache.length - 1]) {
          //       setCachedSong(i);
          //       break;
          //     }
          //   }
          // }
        } else if (velvetModule.playerStats.shouldLoop === true) {
          if (velvetModule.positionCache.val === (velvetModule.playlist.length - 1)) {
            setCachedSong(0);
          }  else {
            setCachedSong(velvetModule.positionCache.val + 1);
          }
        } else {
          setCachedSong(velvetModule.positionCache.val + 1);
        }
  
      }, cacheTimeout);
    }
  }

  velvetModule.getCurrentSong = () => {
    return getCurrentPlayer().songObject;
  }

  function goToPreviousSong() {
    // If random is set, go to previous song from cache
    if (velvetModule.playerStats.shuffle === true) {
      // Check that there is a previous song to go back to
      if (shufflePrevious.length <= 1) {
        return;
      }

      // Pop a song and go to the last song
      var nextSong = shufflePrevious.pop();
      shuffleCache.push(nextSong);

      var currentSong = shufflePrevious[shufflePrevious.length - 1];

      // Reset position cache
      for (var i = 0, len = velvetModule.playlist.length; i < len; i++) {
        // Check if this is the current song
        if (currentSong === velvetModule.playlist[i]) {
          velvetModule.positionCache.val = i;
        }
      }
      clearEnd();

      goToSong(velvetModule.positionCache.val);
      return;
    }

    // Make sure there is a previous song
    if (velvetModule.positionCache.val < 1) {
      return false;
    }

    // Set previous song and play
    clearEnd();
    velvetModule.positionCache.val--;
    return goToSong(velvetModule.positionCache.val);
  }

  function goToNextSong() {
    // If random is set, go to random song
    if (velvetModule.playerStats.shuffle === true) {
      // Chose a random value
      var nextSong = shuffleCache.pop();

      // Prevent same song from playing twice after a re-shuffle
      if (nextSong === velvetModule.getCurrentSong()) {
        console.log('DUPEEEEE');
        shuffleCache.unshift(nextSong);
        nextSong = shuffleCache.pop();
      }

      if (shuffleCache.length === 0) {
        newShuffle();
      }

      // Reset position cache
      for (var i = 0, len = velvetModule.playlist.length; i < len; i++) {
        // Check if this is the current song
        if (nextSong === velvetModule.playlist[i]) {
          velvetModule.positionCache.val = i;
        }
      }
      clearEnd();

      goToSong(velvetModule.positionCache.val);

      // Remove duplicates from shuffle previous
      for (var i = 0, len = shufflePrevious.length; i < len; i++) {
        // Check if this is the current song
        if (nextSong === shufflePrevious[i]) {
          shufflePrevious.splice(i, 1);
        }
      }

      shufflePrevious.push(nextSong);
      return;
    }

    // Check if the next song exists
    if (!velvetModule.playlist[velvetModule.positionCache.val + 1]) {
      // If loop is set and no other song, go back to first song
      if (velvetModule.playerStats.shouldLoop === true && velvetModule.playlist.length > 0) {
        velvetModule.positionCache.val = 0;
        clearEnd();

        return goToSong(velvetModule.positionCache.val);
      }
      return false;
    }

    // Load up next song
    velvetModule.positionCache.val++;
    clearEnd();
    return goToSong(velvetModule.positionCache.val);
  }


  function getCurrentPlayer() {
    if (curP === 'A') {
      return playerA;
    } else if (curP === 'B') {
      return playerB;
    }

    return false;
  }

  function getOtherPlayer() {
    if (curP === 'A') {
      return playerB;
    } else if (curP === 'B') {
      return playerA;
    }

    return false;
  }

  function flipFlop() {
    if (curP === 'A') {
      curP = 'B';
    } else if (curP === 'B') {
      curP = 'A';
    }

    return curP;
  }


  function goToSong(position, forceAutoPlayOff) {
    if (!velvetModule.playlist[position]) {
      return false;
    }

    if (velvetModule.playerStats.autoDJ === true && position === velvetModule.playlist.length - 1) {
      autoDJ();
    }

    // Reset Duration
    velvetModule.playerStats.duration = 0;
    velvetModule.playerStats.currentTime = 0;

    // Stop the current song
    getCurrentPlayer().playerObject.pause();
    getCurrentPlayer().playerObject.currentTime = 0;

    // Song is cached
    flipFlop();
    if (getCurrentPlayer().songObject === velvetModule.playlist[position]) {
      // Play
      velvetModule.playPause();
    } else {
      // console.log('DID NOT USE CACHE');
      setMedia(velvetModule.playlist[position], getCurrentPlayer(), typeof forceAutoPlayOff !== 'undefined' ? !forceAutoPlayOff : true);
    }

    velvetModule.resetCurrentMetadata();
    
    // connect to visualizer
    if (typeof VIZ !== 'undefined') {
      var audioCtx = VIZ.get();
      try {
        var audioNode = getCurrentPlayer().playerObject;
        if (!audioNode.previouslyConnectedViz) {
          var analyser = audioCtx.createAnalyser();
          var source = audioCtx.createMediaElementSource(audioNode);
          source.connect(analyser);
          source.connect(audioCtx.destination);
          VIZ.connect(analyser);
          audioNode.previouslyConnectedViz = true;
        }
      } catch( err) {
        console.log(err);
      }
    }

    // Cache next song
    // The timer prevents excessive caching when the user starts button mashing
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(function () {
      cacheTimer = undefined;
      if(velvetModule.playerStats.shuffle === true) {
        if(shuffleCache[0]) {
          for (var i = 0; i < velvetModule.playlist.length; i++) {
            if(velvetModule.playlist[i] === shuffleCache[shuffleCache.length - 1]) {
              setCachedSong(i);
              break;
            }
          }
        }
      } else if (velvetModule.playerStats.shouldLoop === true) {
        if (position === (velvetModule.playlist.length - 1)) {
          setCachedSong(0);
        }  else {
          setCachedSong(position + 1);
        }
      } else {
        setCachedSong(position + 1);
      }

    }, cacheTimeout);

    // Scrobble song after 30 seconds
    clearTimeout(scrobbleTimer);
    scrobbleTimer = setTimeout(() => { velvetModule.scrobble() }, 30000);
  }

  // Should be called whenever the "metadata" field of the current song is changed, or
  // the current song is changed.
  velvetModule.resetCurrentMetadata = () => {
    const curSong = getCurrentPlayer().songObject;
    velvetModule.playerStats.metadata.artist = curSong.metadata && curSong.metadata.artist ? curSong.metadata.artist : "";
    velvetModule.playerStats.metadata.album = curSong.metadata && curSong.metadata.album  ? curSong.metadata.album : "";
    velvetModule.playerStats.metadata.track = curSong.metadata && curSong.metadata.track ? curSong.metadata.track : "";
    velvetModule.playerStats.metadata.title = curSong.metadata && curSong.metadata.title ? curSong.metadata.title : "";
    velvetModule.playerStats.metadata.year = curSong.metadata && curSong.metadata.year ? curSong.metadata.year : "";
    velvetModule.playerStats.metadata['album-art'] = curSong.metadata && curSong.metadata['album-art'] ? curSong.metadata['album-art'] : "";
    velvetModule.playerStats.metadata['replaygain-track-db'] = curSong.metadata && curSong.metadata['replaygain-track-db'] ? curSong.metadata['replaygain-track-db'] : "";
    velvetModule.playerStats.metadata.filepath = curSong.rawFilePath;

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: velvetModule.playerStats.metadata.title,
        artist: velvetModule.playerStats.metadata.artist,
        album: velvetModule.playerStats.metadata.album,
        artwork: [] //TODO: Get album art working here
      });
    }
    
    let pageTitle = (velvetModule.playerStats.metadata.title) ? 
    velvetModule.playerStats.metadata.title + ' - ' + velvetModule.playerStats.metadata.artist : // if metadata exists
        (velvetModule.playerStats.metadata.filepath ? velvetModule.playerStats.metadata.filepath.split('/').pop() : 'Velvet Music');
    document.title = pageTitle; // set page title when song is playing
    
    velvetModule.updateReplayGainFromSong(curSong);
  }

  // Update ReplayGain state from given song, if required.
  velvetModule.updateReplayGainFromSong = function (song) {
    console.assert(song);
    var newRgAmpValue = undefined;

    if (velvetModule.playerStats.replayGain) {
      if (song.metadata) {
        const rgainDb = song.metadata['replaygain-track-db'];
        if (rgainDb) {
          // Note: the music-metadata package has a similar calculation in its Utils class, and that's used to
          // calculate a returned 'ratio' value. However, the calculation used there is actually calculating the power
          // ratio and not the amplitude ratio as required. As power is amplitude squared, that results in a volume
          // reduction that's too small (i.e. 0.25**2 = 0.00625).
          newRgAmpValue = Math.pow(10, (rgainDb + velvetModule.playerStats.replayGainPreGainDb) / 20)
        }
      }

      if (newRgAmpValue === undefined) {
        currentReplayGainAmp = 0.316; // -10 db for songs without ReplayGain info.
      } else {
        currentReplayGainAmp = newRgAmpValue;
      }
    } else {
      currentReplayGainAmp = 1.0;
    }
    
    velvetModule.changeVolume(velvetModule.playerStats.volume);
  }

  velvetModule.resetPositionCache = function () {
    var len;

    const curSong = getCurrentPlayer().songObject;

    for (var i = 0, len = velvetModule.playlist.length; i < len; i++) {
      // Check if this is the current song
      if (curSong === velvetModule.playlist[i]) {
        velvetModule.positionCache.val = i;
        return;
      }
    }

    // No song found, reset
    velvetModule.positionCache.val = -1;
  }

  // ========================= Howler Player ===============
  function howlPlayerPlay() {
    const localPlayer = getCurrentPlayer();
    velvetModule.playerStats.playing = true;

    localPlayer.playerObject.play();
  }
  function howlPlayerPause() {
    const localPlayer = getCurrentPlayer();
    velvetModule.playerStats.playing = false;

    localPlayer.playerObject.pause();
  }
  function howlPlayerPlayPause() {
    const localPlayer = getCurrentPlayer();

    // TODO: Check that media is loaded
    if (localPlayer.playerObject.paused === false) {
      velvetModule.playerStats.playing = false;
      localPlayer.playerObject.pause();
      document.title = "Velvet"
    } else {
      localPlayer.playerObject.play();
      
      let pageTitle = (velvetModule.playerStats.metadata.title) ? 
        velvetModule.playerStats.metadata.title + ' - ' + velvetModule.playerStats.metadata.artist : // if metadata exists
        (velvetModule.playerStats.metadata.filepath ? velvetModule.playerStats.metadata.filepath.split('/').pop() : 'Velvet Music');
      document.title = pageTitle; // set page title when song is playing
      
      velvetModule.playerStats.playing = true;
    }
  }
  // ========================================================


  function clearEnd() {
    const localPlayer = getCurrentPlayer();
    localPlayer.playerObject.onended = () => {};
  }

  // Player
  // Event: On Song end
  // Set Media
  // Play, pause, skip, etc
  velvetModule.playPause = () => {
    return howlPlayerPlayPause();
  }

  velvetModule.changePlaybackRate = (newRate) => {
    newRate = Number(newRate);
    if (isNaN(newRate) || newRate > 10 || newRate < 0.1) {
      console.log('Bad New Rate');
      return;
    }

    velvetModule.playerStats.playbackRate = newRate;

    const lPlayer = getCurrentPlayer();
    lPlayer.playerObject.playbackRate = newRate;
    
    const oPlayer = getOtherPlayer();
    oPlayer.playerObject.playbackRate = newRate;
  }

  velvetModule.playerStats = {
    playbackRate: 1,
    duration: 0,
    currentTime: 0,
    playing: false,
    shouldLoop: false,
    shouldLoopOne: false,
    shuffle: false,
    volume: 100,
    metadata: {
      "artist": "",
      "album": "",
      "track": "",
      "title": "",
      "year": "",
      "album-art": "",
    },
    replayGain: false,
    replayGainPreGainDb: 0
  }

  function makeNewPlayer(playerObj) {
    playerObj.playerObject = new Audio();
    playerObj.playerObject.volume = velvetModule.playerStats.volume/100;
    playerObj.playerObject.playbackRate =  velvetModule.playerStats.playbackRate;

    playerObj.playerObject.addEventListener('error', err => {
      console.log(err)
      if (playerObj.songObject) { playerObj.songObject.error = true; }
      if (iziToast) {
        iziToast.error({
          title: 'Failed To Play Song',
          position: 'topCenter',
          timeout: 3500
        });
      }

      if (playerObj === getCurrentPlayer()) {
        goToNextSong();
      }else {
        // Invalidate cache
        const newOtherPlayerObject = getOtherPlayer();
        newOtherPlayerObject.songObject = false;
        playerObj.playerObject.onended = () => {};
      }
    });

    playerObj.playerObject.addEventListener('timeupdate', err => {
      velvetModule.playerStats.currentTime = getCurrentPlayer().playerObject.currentTime;
      velvetModule.playerStats.duration = getCurrentPlayer().playerObject.duration;
    });
  }

  const playerA = {
    playerObject: false,
    songObject: false
  }
  const playerB = {
    playerObject: false,
    songObject: false
  }

  makeNewPlayer(playerA);
  makeNewPlayer(playerB);

  var curP = 'A';

  function setMedia(song, player, play) {
    let url = song.url;
    if(velvetModule.transcodeOptions.serverEnabled === true && velvetModule.transcodeOptions.frontendEnabled === true) {
      if (velvetModule.transcodeOptions.selectedBitrate !== null) {
        url += `&bitrate=${velvetModule.transcodeOptions.selectedBitrate}`;
      }
      if (velvetModule.transcodeOptions.selectedCodec !== null) {
        url += `&codec=${velvetModule.transcodeOptions.selectedCodec}`;
      }
      if (velvetModule.transcodeOptions.selectedAlgo !== null) {
        url += `&algo=${velvetModule.transcodeOptions.selectedAlgo}`;
      }
    }

    player.playerObject.src = url;
    player.songObject = song;
    player.playerObject.load();
    player.playerObject.playbackRate = velvetModule.playerStats.playbackRate;
    
    player.playerObject.onended = () => {
      callMeOnStreamEnd();
    }

    if (play == true) {
      howlPlayerPlay();
    }
  }

  function callMeOnStreamEnd() {
    velvetModule.playerStats.playing = false;
    if (velvetModule.playerStats.shouldLoopOne === true) {
      return goToSong(velvetModule.positionCache.val);
    }
    // Go to next song
    goToNextSong();
  }

  velvetModule.goBackSeek = (backBy) => {
    const lPlayer = getCurrentPlayer();
    var seekTo = lPlayer.playerObject.currentTime - backBy;
    if (seekTo < 0) {
      seekTo = 0;
    }

    lPlayer.playerObject.currentTime = seekTo;
  }

  velvetModule.goForwardSeek = (forwardBy) => {
    const lPlayer = getCurrentPlayer();
    if (lPlayer.playerObject.currentTime > (lPlayer.playerObject.duration - 5) ) {
      return;
    }

    let seekTo = lPlayer.playerObject.currentTime + forwardBy;
    if (seekTo >  (lPlayer.playerObject.duration - 5)) {
      seekTo = lPlayer.playerObject.duration - 5;
    }

    lPlayer.playerObject.currentTime = seekTo;
  }

  // NOTE: Seektime is in seconds
  velvetModule.seek = (seekTime) => {
    const lPlayer = getCurrentPlayer();
    // Check that the seek number is less than the duration
    if (seekTime < 0 || seekTime > lPlayer.playerObject.duration) {
      return false;
    }
    lPlayer.playerObject.currentTime = seektime;
  }

  velvetModule.seekByPercentage = (percentage) => {
    if (percentage < 0 || percentage > 99) {
      return false;
    }

    const lPlayer = getCurrentPlayer();
    if (!lPlayer.songObject) { return; }
    const seektime = (percentage * lPlayer.playerObject.duration) / 100;
    lPlayer.playerObject.currentTime = seektime;
  }

  // Timer for caching.  Helps prevent excess caching due to button mashing
  var cacheTimer;
  function setCachedSong(position) {
    // console.log(' ATTEMPTING TO CACHE');
    if (!velvetModule.playlist[position]) {
      //console.log(' FAILED TO CACHE');
      return false;
    }

    // console.log(velvetModule.playlist[position])

    var oPlayer = getOtherPlayer();
    setMedia(velvetModule.playlist[position], oPlayer, false);
    // console.log(' IT CACHED!!!!!!');
    return true;
  }


  // Loop
  velvetModule.toggleRepeat = () => {
    if (velvetModule.playerStats.autoDJ === true) { return; }

    if (velvetModule.playerStats.shouldLoopOne === true) {
      velvetModule.playerStats.shouldLoop = false;
      velvetModule.playerStats.shouldLoopOne = false;
    } else if (velvetModule.playerStats.shouldLoop === true) {
      velvetModule.playerStats.shouldLoop = false;
      velvetModule.playerStats.shouldLoopOne = true;
    } else {
      velvetModule.playerStats.shouldLoop = true;
      velvetModule.playerStats.shouldLoopOne = false;
    }
  }

  // Random Song
  var shuffleCache = []; // Cache the last 5 songs played to avoid repeats
  var shufflePrevious = [];
  velvetModule.setShuffle = (newValue) => {
    if (typeof newValue !== "boolean") { return; }
    if (velvetModule.playerStats.autoDJ === true) { return; }

    velvetModule.playerStats.shuffle = newValue;
    velvetModule.playerStats.shuffle === true ? newShuffle() : turnShuffleOff();
  }
  
  velvetModule.toggleShuffle = () => {
    if (velvetModule.playerStats.autoDJ === true) { return; }
    velvetModule.playerStats.shuffle = !velvetModule.playerStats.shuffle;
    velvetModule.playerStats.shuffle === true ? newShuffle() : turnShuffleOff();
    return velvetModule.playerStats.shuffle;
  }

  function newShuffle() {
    shuffleCache = shuffle(velvetModule.playlist.slice(0));
  }

  function turnShuffleOff() {
    shufflePrevious = [];
    shuffleCache = [];
  }

  function shuffle(array) {
    var currentIndex = array.length
      , temporaryValue
      , randomIndex
      ;

    // While there remain elements to shuffle...
    while (0 !== currentIndex) {
      // Pick a remaining element...
      randomIndex = Math.floor(Math.random() * currentIndex);
      currentIndex -= 1;

      // And swap it with the current element.
      temporaryValue = array[currentIndex];
      array[currentIndex] = array[randomIndex];
      array[randomIndex] = temporaryValue;
    }

    return array;
  }

  // AutoDJ
  velvetModule.playerStats.autoDJ = false;
  var autoDjIgnoreArray = [];
  velvetModule.ignoreVPaths = {};
  velvetModule.minRating = 0;

  velvetModule.toggleAutoDJ = () => {
    velvetModule.playerStats.autoDJ = !velvetModule.playerStats.autoDJ;
    if (velvetModule.playerStats.autoDJ === true) {
      // Turn off shuffle & loop
      velvetModule.playerStats.shuffle = false;
      velvetModule.playerStats.shouldLoop = false;
      velvetModule.playerStats.shouldLoopOne = false;

      // Add song if necessary
      if (velvetModule.playlist.length === 0 || velvetModule.positionCache.val === velvetModule.playlist.length - 1) {
        autoDJ();
      }
    }

    return velvetModule.playerStats.autoDJ;
  }

  // ReplayGain
  velvetModule.setReplayGainActive = (isActive) => {
    velvetModule.playerStats.replayGain = isActive;
    if (getCurrentPlayer().songObject) {
      velvetModule.updateReplayGainFromSong(getCurrentPlayer().songObject);
    }
  }

  velvetModule.setReplayGainPreGainDb = (db) => {
    velvetModule.playerStats.replayGainPreGainDb = db;
    if (getCurrentPlayer().songObject) {
      velvetModule.updateReplayGainFromSong(getCurrentPlayer().songObject);
    }
  }

  // Setup Media Session
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', function() { howlPlayerPlay(); });
    navigator.mediaSession.setActionHandler('pause', function() { howlPlayerPause(); });
    navigator.mediaSession.setActionHandler('stop', function() { howlPlayerPause(); });
    // navigator.mediaSession.setActionHandler('seekbackward', function() { /* Code excerpted. */ });
    // navigator.mediaSession.setActionHandler('seekforward', function() { /* Code excerpted. */ });
    // navigator.mediaSession.setActionHandler('seekto', function() { /* Code excerpted. */ });
    navigator.mediaSession.setActionHandler('previoustrack', function() { goToPreviousSong(); });
    navigator.mediaSession.setActionHandler('nexttrack', function() { goToNextSong() });
  }

  // Return an object that is assigned to Module
  return velvetModule;
})();
