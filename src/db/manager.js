import winston from 'winston';
import * as config from '../state/config.js';
import * as backend from './sqlite-backend.js';

let clearShared;

export async function initDB() {
  backend.init(config.program.storage.dbDirectory, config.program.db);

  // Build the duplicate-content-hash set used by the Subsonic layer to emit
  // exact-file ("<hash>@<rowid>") ids. Cheap one-time scan; refreshed after scans.
  try { backend.refreshDuplicateHashes(); } catch { /* non-fatal */ }

  // Shared playlist cleanup interval
  if (clearShared) {
    clearInterval(clearShared);
    clearShared = undefined;
  }

  if (config.program.db.clearSharedInterval) {
    clearShared = setInterval(() => {
      try {
        backend.removeExpiredSharedPlaylists();
        backend.saveShareDB();
        winston.info('Successfully cleared shared playlists');
      } catch (err) {
        winston.error('Failed to clear expired saved playlists', { stack: err });
      }
    }, config.program.db.clearSharedInterval * 60 * 60 * 1000);
  }
}

// Save operations
export function saveFilesDB() { backend.saveFilesDB(); }
export function saveUserDB() { backend.saveUserDB(); }
export function saveShareDB() { backend.saveShareDB(); }

// File Operations
export function findFileByPath(filepath, vpath) { return backend.findFileByPath(filepath, vpath); }
export function findFilesByPaths(filepaths, vpath) { return backend.findFilesByPaths(filepaths, vpath); }
export function updateFileScanId(file, scanId) { return backend.updateFileScanId(file, scanId); }
export function batchUpdateScanIds(filepaths, vpath, scanId) { return backend.batchUpdateScanIds(filepaths, vpath, scanId); }
export function insertFile(fileData) { return backend.insertFile(fileData); }
export function albumFolderName(albumId) { return backend.albumFolderName(albumId); }
export function beginTransaction() { backend.beginTransaction(); }
export function commitTransaction() { backend.commitTransaction(); }
export function beginTransactionStrict() { backend.beginTransactionStrict(); }
export function commitTransactionStrict() { backend.commitTransactionStrict(); }
export function rollbackTransactionStrict() { backend.rollbackTransactionStrict(); }
export function savepoint(name) { backend.savepoint(name); }
export function releasePoint(name) { backend.releasePoint(name); }
export function rollbackToPoint(name) { backend.rollbackToPoint(name); }
export function vacuumInto(destPath) { backend.vacuumInto(destPath); }
export function removeFileByPath(filepath, vpath) { return backend.removeFileByPath(filepath, vpath); }
export function migrateHash(oldHash, newHash) { return backend.migrateHash(oldHash, newHash); }
export function getLiveArtFilenames() { return backend.getLiveArtFilenames(); }
export function getLiveHashes() { return backend.getLiveHashes(); }
export function getStaleFileHashes(vpath, scanId) { return backend.getStaleFileHashes(vpath, scanId); }
export function removeStaleFiles(vpath, scanId) { return backend.removeStaleFiles(vpath, scanId); }
export function clampRecentTsToModified(vpath, scanId, scanStartTs, oldMtimeCutoffTs) {
  return backend.clampRecentTsToModified(vpath, scanId, scanStartTs, oldMtimeCutoffTs);
}
export function clearScanIds(vpath) { return backend.clearScanIds(vpath); }
export function removeFilesByVpath(vpath) { return backend.removeFilesByVpath(vpath); }
export function removeFilesByPrefix(vpath, prefix) { return backend.removeFilesByPrefix(vpath, prefix); }
export function countFilesByVpath(vpath) { return backend.countFilesByVpath(vpath); }
export function countFilesByVpaths(vpaths) { return backend.countFilesByVpaths(vpaths); }
export function countFilesByScanId(vpath, scanId) { return backend.countFilesByScanId(vpath, scanId); }
export function recordCompletedScan(vpath, scanId, scanStartTs, finishedAtSec) { return backend.recordCompletedScan(vpath, scanId, scanStartTs, finishedAtSec); }
export function getStats() { return backend.getStats(); }
export function countAlbumsForSources(sources) { return backend.countAlbumsForSources(sources); }
export function getLastScannedMs() { return backend.getLastScannedMs(); }
export function rebuildFolderIndex() { backend.rebuildFolderIndex(); }
export function rebuildArtistIndex(onComplete) { backend.rebuildArtistIndex(onComplete); }

// AcoustID fingerprinting helpers
export function getAcoustidQueue(limit, retryAfterSec) { return backend.getAcoustidQueue(limit, retryAfterSec); }
export function setAcoustidPending(filepath, vpath) { return backend.setAcoustidPending(filepath, vpath); }
export function setAcoustidResult(filepath, vpath, result) { return backend.setAcoustidResult(filepath, vpath, result); }
export function resetAcoustidPending() { return backend.resetAcoustidPending(); }
export function resetAcoustidErrors()  { return backend.resetAcoustidErrors(); }
export function resetNotFoundForAcoustid() { return backend.resetNotFoundForAcoustid(); }
export function resetFilesForAcoustid(files) { return backend.resetFilesForAcoustid(files); }
export function getAcoustidStats() { return backend.getAcoustidStats(); }

// Tag Workshop — MB enrichment + tag review
export function getMbEnrichQueue(limit) { return backend.getMbEnrichQueue(limit); }
export function setMbEnrichPending(filepath, vpath) { return backend.setMbEnrichPending(filepath, vpath); }
export function setMbEnrichResult(filepath, vpath, data) { return backend.setMbEnrichResult(filepath, vpath, data); }
export function resetMbEnrichPending() { return backend.resetMbEnrichPending(); }
export function getMbEnrichStats() { return backend.getMbEnrichStats(); }
export function getMbEnrichErrors(limit) { return backend.getMbEnrichErrors(limit); }
export function retryMbEnrichErrors() { return backend.retryMbEnrichErrors(); }
export function getMbTextSearchStats() { return backend.getMbTextSearchStats(); }
export function resetMbTextSearchNotFound() { return backend.resetMbTextSearchNotFound(); }
export function getMbTextSearchErrors(limit) { return backend.getMbTextSearchErrors(limit); }
export function retryMbTextSearchErrors() { return backend.retryMbTextSearchErrors(); }
export function getTagWorkshopFolderFiles(vpathName, filepathPrefix) { return backend.getTagWorkshopFolderFiles(vpathName, filepathPrefix); }
export function resetFilesForEnrichment(files) { return backend.resetFilesForEnrichment(files); }
export function getTagWorkshopStatus() { return backend.getTagWorkshopStatus(); }
export function getTagWorkshopAlbums(filter, sort, page, search) { return backend.getTagWorkshopAlbums(filter, sort, page, search); }
export function getTagWorkshopAlbumTracks(mb_release_id, album_dir) { return backend.getTagWorkshopAlbumTracks(mb_release_id, album_dir); }
export function getTracksForAccept(mb_release_id, album_dir) { return backend.getTracksForAccept(mb_release_id, album_dir); }
export function getTrackForAccept(filepath, vpath) { return backend.getTrackForAccept(filepath, vpath); }
export function markTrackAccepted(filepath, vpath) { return backend.markTrackAccepted(filepath, vpath); }
export function skipAlbumTags(mb_release_id, album_dir) { return backend.skipAlbumTags(mb_release_id, album_dir); }
export function unshelveAlbum(mb_release_id, album_dir) { return backend.unshelveAlbum(mb_release_id, album_dir); }
export function getShelvedAlbums(page) { return backend.getShelvedAlbums(page); }
export function getCasingOnlyCandidates() { return backend.getCasingOnlyCandidates(); }

// Metadata Queries
export function updateFileArt(filepath, vpath, aaFile, scanId, artSource) { return backend.updateFileArt(filepath, vpath, aaFile, scanId, artSource); }
export function countArtUsage(aaFile) { return backend.countArtUsage(aaFile); }
export function updateFileCue(filepath, vpath, cuepoints) { return backend.updateFileCue(filepath, vpath, cuepoints); }
export function updateFileDuration(filepath, vpath, duration) { return backend.updateFileDuration(filepath, vpath, duration); }
export function updateFileTechMeta(filepath, vpath, bitrate, sampleRate, channels, bitDepth) { return backend.updateFileTechMeta(filepath, vpath, bitrate, sampleRate, channels, bitDepth); }
export function updateFileAlbumVersion(filepath, vpath, albumVersion, albumVersionSource) { return backend.updateFileAlbumVersion(filepath, vpath, albumVersion, albumVersionSource); }
export function getFileDuration(filepath) { return backend.getFileDuration(filepath); }
export function updateFileTags(filepath, vpath, tags) { return backend.updateFileTags(filepath, vpath, tags); }
export function updateFileModified(filepath, vpath, modifiedMs) { return backend.updateFileModified(filepath, vpath, modifiedMs); }
export function getFileWithMetadata(filepath, vpath, username) { return backend.getFileWithMetadata(filepath, vpath, username); }
export function getArtists(vpaths, ignoreVPaths, excludeFilepathPrefixes) { return backend.getArtists(vpaths, ignoreVPaths, excludeFilepathPrefixes); }
export function getArtistAlbums(artist, vpaths, ignoreVPaths, excludeFilepathPrefixes, includeFilepathPrefixes) { return backend.getArtistAlbums(artist, vpaths, ignoreVPaths, excludeFilepathPrefixes, includeFilepathPrefixes); }
export function getArtistAlbumsMulti(artists, vpaths, ignoreVPaths, excludeFilepathPrefixes, includeFilepathPrefixes) { return backend.getArtistAlbumsMulti(artists, vpaths, ignoreVPaths, excludeFilepathPrefixes, includeFilepathPrefixes); }
export function getArtistFolderSongs(artists, vpaths, username, ignoreVPaths, excludeFilepathPrefixes) { return backend.getArtistFolderSongs(artists, vpaths, username, ignoreVPaths, excludeFilepathPrefixes); }
export function getAlbums(vpaths, ignoreVPaths, excludeFilepathPrefixes, includeFilepathPrefixes) { return backend.getAlbums(vpaths, ignoreVPaths, excludeFilepathPrefixes, includeFilepathPrefixes); }
export function getAlbumSongs(album, vpaths, username, opts) { return backend.getAlbumSongs(album, vpaths, username, opts); }
export function getFilesForAlbumsBrowse(sources) { return backend.getFilesForAlbumsBrowse(sources); }
export function getDB() { return backend.getDB(); }
export function searchFiles(searchCol, searchTerm, vpaths, ignoreVPaths, filepathPrefix, excludeFilepathPrefixes, negativeTerms, limit) { return backend.searchFiles(searchCol, searchTerm, vpaths, ignoreVPaths, filepathPrefix, excludeFilepathPrefixes, negativeTerms, limit); }
export function getAlbumVersionInventory() { return backend.getAlbumVersionInventory(); }
export function searchAlbumsByArtist(searchTerm, vpaths, ignoreVPaths, filepathPrefix, excludeFilepathPrefixes, negativeTerms, limit) { return backend.searchAlbumsByArtist(searchTerm, vpaths, ignoreVPaths, filepathPrefix, excludeFilepathPrefixes, negativeTerms, limit); }
export function listAllSongs(vpaths, ignoreVPaths, excludeFilepathPrefixes, filepathPrefix, offset, limit) { return backend.listAllSongs(vpaths, ignoreVPaths, excludeFilepathPrefixes, filepathPrefix, offset, limit); }
export function searchFilesAllWords(tokens, vpaths, ignoreVPaths, filepathPrefix, excludeFilepathPrefixes, negativeTerms, limit) { return backend.searchFilesAllWords(tokens, vpaths, ignoreVPaths, filepathPrefix, excludeFilepathPrefixes, negativeTerms, limit); }
export function searchFolders(query, vpaths, ignoreVPaths) { return backend.searchFolders(query, vpaths, ignoreVPaths); }
export function searchArtistsNormalized(query, vpaths, ignoreVPaths) { return backend.searchArtistsNormalized(query, vpaths, ignoreVPaths); }
export function getArtistsForBrowse(vpaths, ignoreVPaths) { return backend.getArtistsForBrowse(vpaths, ignoreVPaths); }
export function getArtistsByLetter(letter) { return backend.getArtistsByLetter(letter); }
export function getArtistHomeStats() { return backend.getArtistHomeStats(); }
export function getArtistRow(artistClean) { return backend.getArtistRow(artistClean); }
export function getArtistRowByName(name) { return backend.getArtistRowByName(name); }
export function getArtistFiles(rawVariants, vpaths, ignoreVPaths) { return backend.getArtistFiles(rawVariants, vpaths, ignoreVPaths); }
export function resolveArtistNamesForDJ(names) { return backend.resolveArtistNamesForDJ(names); }
export function artistHasAlbums(variants, vpaths) { return backend.artistHasAlbums(variants, vpaths); }
export function artistsWithAlbums(variants, vpaths) { return backend.artistsWithAlbums(variants, vpaths); }
export function saveArtistInfo(artistClean, data) { return backend.saveArtistInfo(artistClean, data); }
export function getArtistImageByArtistId(artistId) { return backend.getArtistImageByArtistId(artistId); }
export function setArtistNameOverride(artistClean, newName) { return backend.setArtistNameOverride(artistClean, newName); }
export function setArtistImage(artistClean, imageFile, imageSource) { return backend.setArtistImage(artistClean, imageFile, imageSource); }
export function setArtistImageWrongFlag(artistClean, isWrong) { return backend.setArtistImageWrongFlag(artistClean, isWrong); }
export function markArtistFetchAttempt(artistClean) { return backend.markArtistFetchAttempt(artistClean); }
export function deriveArtistMbidFromFiles(canonicalName) { return backend.deriveArtistMbidFromFiles(canonicalName); }
export function getArtistImageAudit(kind, limit) { return backend.getArtistImageAudit(kind, limit); }
export function getArtistImageAuditCounts() { return backend.getArtistImageAuditCounts(); }
export function getArtistsNeedingFetch(limit) { return backend.getArtistsNeedingFetch(limit); }
export function getArtistsForTadbRetry(limit, force) { return backend.getArtistsForTadbRetry(limit, force); }
export function getRatedSongs(vpaths, username, ignoreVPaths) { return backend.getRatedSongs(vpaths, username, ignoreVPaths); }
export function getRecentlyAdded(vpaths, username, limit, ignoreVPaths, opts) { return backend.getRecentlyAdded(vpaths, username, limit, ignoreVPaths, opts); }
export function getRecentlyPlayed(vpaths, username, limit, ignoreVPaths, opts) { return backend.getRecentlyPlayed(vpaths, username, limit, ignoreVPaths, opts); }
export function getMostPlayed(vpaths, username, limit, ignoreVPaths, opts) { return backend.getMostPlayed(vpaths, username, limit, ignoreVPaths, opts); }
export function getAllFilesWithMetadata(vpaths, username, opts) { return backend.getAllFilesWithMetadata(vpaths, username, opts); }
export function countFilesForRandom(vpaths, username, opts) { return backend.countFilesForRandom(vpaths, username, opts); }
export function pickFileAtOffset(vpaths, username, opts, offset) { return backend.pickFileAtOffset(vpaths, username, opts, offset); }
export function getGenres(vpaths, ignoreVPaths, opts) { return backend.getGenres(vpaths, ignoreVPaths, opts); }
export function getSongsByGenre(genre, vpaths, username, ignoreVPaths, opts) { return backend.getSongsByGenre(genre, vpaths, username, ignoreVPaths, opts); }
export function getSongsByGenreRaw(rawGenres, vpaths, username, ignoreVPaths) { return backend.getSongsByGenreRaw(rawGenres, vpaths, username, ignoreVPaths); }
export function getDecades(vpaths, ignoreVPaths) { return backend.getDecades(vpaths, ignoreVPaths); }
export function getAlbumsByDecade(decade, vpaths, ignoreVPaths, excludeFilepathPrefixes) { return backend.getAlbumsByDecade(decade, vpaths, ignoreVPaths, excludeFilepathPrefixes); }
export function getSongsByDecade(decade, vpaths, username, ignoreVPaths) { return backend.getSongsByDecade(decade, vpaths, username, ignoreVPaths); }
export function getAlbumsByGenre(rawGenres, vpaths, ignoreVPaths, excludeFilepathPrefixes) { return backend.getAlbumsByGenre(rawGenres, vpaths, ignoreVPaths, excludeFilepathPrefixes); }

// User Metadata
export function findUserMetadata(hash, username) { return backend.findUserMetadata(hash, username); }
export function insertUserMetadata(obj) { return backend.insertUserMetadata(obj); }
export function updateUserMetadata(obj) { return backend.updateUserMetadata(obj); }
export function removeUserMetadataByUser(username) { return backend.removeUserMetadataByUser(username); }
export function resetPlayCounts(username) { return backend.resetPlayCounts(username); }
export function resetRecentlyPlayed(username) { return backend.resetRecentlyPlayed(username); }

// Playlists
export function getUserPlaylists(username) { return backend.getUserPlaylists(username); }
export function findPlaylist(username, playlistName) { return backend.findPlaylist(username, playlistName); }
export function createPlaylistEntry(entry) { return backend.createPlaylistEntry(entry); }
export function deletePlaylist(username, playlistName) { return backend.deletePlaylist(username, playlistName); }
export function renamePlaylist(username, oldName, newName) { return backend.renamePlaylist(username, oldName, newName); }
export function getPlaylistEntryById(id) { return backend.getPlaylistEntryById(id); }
export function removePlaylistEntryById(id) { return backend.removePlaylistEntryById(id); }
export function loadPlaylistEntries(username, playlistName) { return backend.loadPlaylistEntries(username, playlistName); }
export function removePlaylistsByUser(username) { return backend.removePlaylistsByUser(username); }

// Shared Playlists
export function findSharedPlaylist(playlistId) { return backend.findSharedPlaylist(playlistId); }
export function insertSharedPlaylist(item) { return backend.insertSharedPlaylist(item); }
export function getAllSharedPlaylists() { return backend.getAllSharedPlaylists(); }
export function removeSharedPlaylistById(playlistId) { return backend.removeSharedPlaylistById(playlistId); }
export function removeExpiredSharedPlaylists() { return backend.removeExpiredSharedPlaylists(); }
export function removeEternalSharedPlaylists() { return backend.removeEternalSharedPlaylists(); }
export function removeSharedPlaylistsByUser(username) { return backend.removeSharedPlaylistsByUser(username); }
// Scan Error Audit
export function insertScanError(guid, filepath, vpath, errorType, errorMsg, stack) { return backend.insertScanError(guid, filepath, vpath, errorType, errorMsg, stack); }
export function getScanErrors(limit) { return backend.getScanErrors(limit); }
export function getScanErrorByGuid(guid) { return backend.getScanErrorByGuid(guid); }
export function clearScanErrors() { return backend.clearScanErrors(); }
export function pruneScanErrors(retentionHours) { return backend.pruneScanErrors(retentionHours); }
export function clearResolvedErrors(vpath, scanStartTs) { return backend.clearResolvedErrors(vpath, scanStartTs); }
export function getScanErrorCount() { return backend.getScanErrorCount(); }
export function markScanErrorFixed(guid, fixAction) { return backend.markScanErrorFixed(guid, fixAction); }
export function confirmScanErrorOk(filepath, vpath) { return backend.confirmScanErrorOk(filepath, vpath); }
export function markFileArtChecked(filepath, vpath) { return backend.markFileArtChecked(filepath, vpath); }
export function markFileCueChecked(filepath, vpath) { return backend.markFileCueChecked(filepath, vpath); }

// Subsonic queries
export function getFilesByArtistId(artistId, vpaths, username, opts) { return backend.getFilesByArtistId(artistId, vpaths, username, opts); }
export function getFilesByAlbumId(albumId, vpaths, username, opts) { return backend.getFilesByAlbumId(albumId, vpaths, username, opts); }
export function getSongByHash(hash, username) { return backend.getSongByHash(hash, username); }
export function getSongsByHashes(hashes, username) { return backend.getSongsByHashes(hashes, username); }
export function getSongByRowid(rowid, username) { return backend.getSongByRowid(rowid, username); }
export function getSongsByRowids(rowids, username) { return backend.getSongsByRowids(rowids, username); }
export function refreshDuplicateHashes() { return backend.refreshDuplicateHashes(); }
export function isDuplicatedHash(hash) { return backend.isDuplicatedHash(hash); }
export function getFilesWithMetadataByPaths(filepaths, vpath, username) { return backend.getFilesWithMetadataByPaths(filepaths, vpath, username); }
export function getAaFileById(id) { return backend.getAaFileById(id); }
export function getAaFileForDir(vpath, dirRelPath) { return backend.getAaFileForDir(vpath, dirRelPath); }
export function clearAaFileForDirCache() { backend.clearAaFileForDirCache(); }
export function getStarredSongs(vpaths, username, opts) { return backend.getStarredSongs(vpaths, username, opts); }
export function getStarredAlbums(vpaths, username, opts) { return backend.getStarredAlbums(vpaths, username, opts); }
export function setStarred(hash, username, starred) { return backend.setStarred(hash, username, starred); }
export function getRandomSongs(vpaths, username, opts) { return backend.getRandomSongs(vpaths, username, opts); }
export function getAlbumsByArtistId(artistId, vpaths, opts) { return backend.getAlbumsByArtistId(artistId, vpaths, opts); }
export function getAllAlbumIds(vpaths, opts) { return backend.getAllAlbumIds(vpaths, opts); }
export function getAlbumStatsByIds(albumIds) { return backend.getAlbumStatsByIds(albumIds); }
export function getAllArtistIds(vpaths, opts) { return backend.getAllArtistIds(vpaths, opts); }
export function getDirectoryContents(vpath, dirRelPath, username) { return backend.getDirectoryContents(vpath, dirRelPath, username); }
// User settings sync
export function getUserSettings(username) { return backend.getUserSettings(username); }
export function saveUserSettings(username, patch) { return backend.saveUserSettings(username, patch); }
// Radio stations
export function getRadioStations(username) { return backend.getRadioStations(username); }
// Radio schedules
export function getRadioSchedules(username) { return backend.getRadioSchedules(username); }
export function createRadioSchedule(data) { return backend.createRadioSchedule(data); }
export function deleteRadioSchedule(id, username) { return backend.deleteRadioSchedule(id, username); }
export function toggleRadioSchedule(id, username, enabled) { return backend.toggleRadioSchedule(id, username, enabled); }
export function toggleRadioScheduleById(id, enabled) { return backend.toggleRadioScheduleById(id, enabled); }
export function getAllEnabledRadioSchedules() { return backend.getAllEnabledRadioSchedules(); }
export function createRadioStation(username, data) { return backend.createRadioStation(username, data); }
export function updateRadioStation(id, username, data) { return backend.updateRadioStation(id, username, data); }
export function deleteRadioStation(id, username) { return backend.deleteRadioStation(id, username); }
export function getRadioStationImgUsageCount(img) { return backend.getRadioStationImgUsageCount(img); }
export function reorderRadioStations(username, orderedIds) { return backend.reorderRadioStations(username, orderedIds); }
// Podcast feeds
export function getPodcastFeeds(username) { return backend.getPodcastFeeds(username); }
export function getPodcastFeed(id, username) { return backend.getPodcastFeed(id, username); }
export function createPodcastFeed(username, data) { return backend.createPodcastFeed(username, data); }
export function deletePodcastFeed(id, username) { return backend.deletePodcastFeed(id, username); }
export function updatePodcastFeedFetched(id, username, ts) { return backend.updatePodcastFeedFetched(id, username, ts); }
export function updatePodcastFeedTitle(id, username, title) { return backend.updatePodcastFeedTitle(id, username, title); }
export function updatePodcastFeedImg(id, username, img) { return backend.updatePodcastFeedImg(id, username, img); }
export function updatePodcastFeedUrl(id, username, url) { return backend.updatePodcastFeedUrl(id, username, url); }
export function reorderPodcastFeeds(username, orderedIds) { return backend.reorderPodcastFeeds(username, orderedIds); }
export function getPodcastFeedImgUsageCount(img) { return backend.getPodcastFeedImgUsageCount(img); }
// Podcast episodes
export function getPodcastEpisode(id) { return backend.getPodcastEpisode(id); }
export function getPodcastEpisodes(feedId) { return backend.getPodcastEpisodes(feedId); }
export function upsertPodcastEpisodes(feedId, episodes) { return backend.upsertPodcastEpisodes(feedId, episodes); }
export function saveEpisodeProgress(episodeId, feedId, position, played) { return backend.saveEpisodeProgress(episodeId, feedId, position, played); }
// Smart Playlists
export function runSmartPlaylist(filters, sort, limitN, vpaths, username, ignoreVPaths, filepathPrefix) { return backend.runSmartPlaylist(filters, sort, limitN, vpaths, username, ignoreVPaths, filepathPrefix); }
export function countSmartPlaylist(filters, vpaths, username, ignoreVPaths, filepathPrefix) { return backend.countSmartPlaylist(filters, vpaths, username, ignoreVPaths, filepathPrefix); }
export function getSmartPlaylists(username) { return backend.getSmartPlaylists(username); }
export function getSmartPlaylist(id, username) { return backend.getSmartPlaylist(id, username); }
export function saveSmartPlaylist(username, name, filters, sort, limitN) { return backend.saveSmartPlaylist(username, name, filters, sort, limitN); }
export function updateSmartPlaylist(id, username, data) { return backend.updateSmartPlaylist(id, username, data); }
export function deleteSmartPlaylist(id, username) { return backend.deleteSmartPlaylist(id, username); }
// Genre Groups
export function getGenreGroups() { return backend.getGenreGroups(); }
export function saveGenreGroups(groups) { return backend.saveGenreGroups(groups); }
// Wrapped / Play Events
export function insertPlayEvent(e) { return backend.insertPlayEvent(e); }
export function findRecentPlayEvent(userId, fileHash, windowMs) { return backend.findRecentPlayEvent(userId, fileHash, windowMs); }
export function getPlayEventById(id, userId) { return backend.getPlayEventById(id, userId); }
export function hasPlayEventBefore(userId, hash, beforeMs) { return backend.hasPlayEventBefore(userId, hash, beforeMs); }
export function updatePlayEvent(id, userId, fields) { return backend.updatePlayEvent(id, userId, fields); }
export function incrementPauseCount(id, userId) { return backend.incrementPauseCount(id, userId); }
export function upsertListeningSession(s) { return backend.upsertListeningSession(s); }
export function updateListeningSession(sid, uid, fields) { return backend.updateListeningSession(sid, uid, fields); }
export function getWrappedPeriods(userId) { return backend.getWrappedPeriods(userId); }
export function getHistoryEvents(userId, fromMs, toMs = null) { return backend.getHistoryEvents(userId, fromMs, toMs); }
export function getWrappedDataInRange(userId, from, to) { return backend.getWrappedDataInRange(userId, from, to); }
export function getWrappedSessionsInRange(userId, from, to) { return backend.getWrappedSessionsInRange(userId, from, to); }
export function getTotalFileCount(vpaths) { return backend.getTotalFileCount(vpaths); }
export function getWrappedAdminStats() { return backend.getWrappedAdminStats(); }
export function purgePlayEvents(userId, fromMs, toMs) { return backend.purgePlayEvents(userId, fromMs, toMs); }
export function previewFolderMetadata() { return backend.previewFolderMetadata(); }
export function backfillFolderMetadata() { return backend.backfillFolderMetadata(); }
// ReplayGain worker helpers
export function getRgStatus() { return backend.getRgStatus(); }
export function resetRgFailed() { return backend.resetRgFailed(); }
export function getRgFailedRows() { return backend.getRgFailedRows(); }
export function getRgFailedDetail() { return backend.getRgFailedDetail(); }
export function shelveRgRows(ids) { return backend.shelveRgRows(ids); }
export function unshelveRgRows(ids) { return backend.unshelveRgRows(ids); }
export function purgeRgRowsByIds(ids) { return backend.purgeRgRowsByIds(ids); }
export function resetRgFailedByIds(ids) { return backend.resetRgFailedByIds(ids); }
export function resetRgAll() { return backend.resetRgAll(); }
export function undoRgAll() { return backend.undoRgAll(); }
export function getRgUndoInfo() { return backend.getRgUndoInfo(); }
export function clearRgBackup() { return backend.clearRgBackup(); }
// BPM & Key Analysis
export function getBpmStats() { return backend.getBpmStats(); }
export function resetAbErrors() { return backend.resetAbErrors(); }
export function resetAbNotFound() { return backend.resetAbNotFound(); }
export function resetEssentiaErrors() { return backend.resetEssentiaErrors(); }
export function resetAllBpmData() { return backend.resetAllBpmData(); }
export function genreCorrectBpm(dryRun) { return backend.genreCorrectBpm(dryRun); }
export function genreCorrectBpmUndo() { return backend.genreCorrectBpmUndo(); }
export function genreCorrectBpmSelected(corrections) { return backend.genreCorrectBpmSelected(corrections); }
// Essentia audio features
export function saveAudioFeatures(hash, features) { return backend.saveAudioFeatures(hash, features); }
export function getAudioFeatures(hash) { return backend.getAudioFeatures(hash); }
export function getSimilarSongs(hash, limit) { return backend.getSimilarSongs(hash, limit); }
// Radio / Podcast Play Events
export function insertRadioPlayEvent(e) { return backend.insertRadioPlayEvent(e); }
export function updateRadioPlayEvent(id, userId, fields) { return backend.updateRadioPlayEvent(id, userId, fields); }
export function getRadioStatsInRange(userId, from, to) { return backend.getRadioStatsInRange(userId, from, to); }
export function insertPodcastPlayEvent(e) { return backend.insertPodcastPlayEvent(e); }
export function updatePodcastPlayEvent(id, userId, fields) { return backend.updatePodcastPlayEvent(id, userId, fields); }
export function getPodcastStatsInRange(userId, from, to) { return backend.getPodcastStatsInRange(userId, from, to); }
export function getHomeSummary(userId, vpaths, todayStart, weekStart, timeWindows) { return backend.getHomeSummary(userId, vpaths, todayStart, weekStart, timeWindows); }
// Subsonic bookmarks
export function getBookmarks(username) { return backend.getBookmarks(username); }
export function saveBookmark(username, songId, position, comment) { return backend.saveBookmark(username, songId, position, comment); }
export function deleteBookmark(username, songId) { return backend.deleteBookmark(username, songId); }
// Subsonic play queue
export function getPlayQueue(username) { return backend.getPlayQueue(username); }
export function savePlayQueue(username, currentId, positionMs, changedBy, songIds) { return backend.savePlayQueue(username, currentId, positionMs, changedBy, songIds); }


export function getUnplayedGems(username, vpaths, ignoreVPaths, limit) { return backend.getUnplayedGems(username, vpaths, ignoreVPaths, limit); }
export function countUnplayedGems(username, vpaths, ignoreVPaths) { return backend.countUnplayedGems(username, vpaths, ignoreVPaths); }
