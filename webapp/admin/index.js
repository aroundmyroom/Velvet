// ── i18n Vue-reactivity bridge ───────────────────────────────────────────────
// I18NSTATE.tick increments each time a language loads.  Vue templates that
// call this.t('key') read the tick value, making them automatically re-render.
const I18NSTATE = Vue.observable({ tick: 0 });
Vue.prototype.t = function(key, params) {
  I18NSTATE.tick; // NOSONAR — reactive dependency, forces re-render on lang change
  return I18N.t(key, params);
};
I18N.onChange(() => { I18NSTATE.tick++; });
I18N.loadLanguage(); // detect from localStorage / browser navigator
// ─────────────────────────────────────────────────────────────────────────────

const ADMINDATA = (() => {
  const module = {};

  module.version = { val: false };

  // Used for handling the file explorer selection
  module.sharedSelect = { value: '' };

  // Used for modifying a user
  module.selectedUser = { value: '' };

  // folders
  module.folders = {};
  module.foldersUpdated = { ts: 0 };
  module.winDrives = [];
  // users
  module.users = {};
  module.usersUpdated = { ts: 0 };
  // db stuff
  module.dbParams = {};
  module.dbParamsUpdated = { ts: 0 };
  // album version tag config
  module.albumVersionTags = [];
  module.albumVersionInventory = [];
  // server settings
  module.serverParams = {};
  module.serverParamsUpdated = { ts: 0 };
  // transcoding
  module.transcodeParams = {};
  module.transcodeParamsUpdated = { ts: 0 };
  module.downloadPending = { val: false };
  // server audio (mpv)
  module.serverAudioParams = {};
  module.serverAudioParamsUpdated = { ts: 0 };
  // dlna
  module.dlnaParams = {};
  module.dlnaParamsUpdated = { ts: 0 };
  // shared playlists
  module.sharedPlaylists = [];
  module.sharedPlaylistUpdated = { ts: 0 };
  // federation
  module.federationEnabled = { val: false };
  module.federationParams = {};
  module.federationParamsUpdated = { ts: 0 };
  module.federationInviteToken = { val: null };

  module.getSharedPlaylists = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/db/shared`
    });

    while(module.sharedPlaylists.length !== 0) {
      module.sharedPlaylists.pop();
    }

    res.data.forEach(item => {
      module.sharedPlaylists.push(item);
    });

    module.sharedPlaylistUpdated.ts = Date.now();
  };

  module.deleteSharedPlaylist = async (playlistObj) => {
    await API.axios({
      method: 'DELETE',
      url: `${API.url()}/api/v1/admin/db/shared`,
      data: { id: playlistObj.playlistId }
    });

    module.sharedPlaylists.splice(module.sharedPlaylists.indexOf(playlistObj), 1);
  };

  module.deleteUnxpShared = async () => {
    await API.axios({
      method: 'DELETE',
      url: `${API.url()}/api/v1/admin/db/shared/eternal`
    });

    // Clear playlist array since we no longer know it's state after this api call
    while(module.sharedPlaylists.length !== 0) {
      module.sharedPlaylists.pop();
    }
  };

  module.deleteExpiredShared = async () => {
    await API.axios({
      method: 'DELETE',
      url: `${API.url()}/api/v1/admin/db/shared/expired`
    });

    // Clear playlist array since we no longer know it's state after this api call
    while(module.sharedPlaylists.length !== 0) {
      module.sharedPlaylists.pop();
    }
  };

  module.getFolders = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/directories`
    });

    Object.keys(res.data).forEach(key=>{
      // Use Vue.set so each folder object enters Vue's reactive system immediately.
      Vue.set(module.folders, key, res.data[key]);
    });

    module.foldersUpdated.ts = Date.now();
  };

  module.getUsers = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/users`
    });

    Object.keys(res.data).forEach(key=>{
      const u = res.data[key];
      // Normalise permission flags so keys always exist as explicit booleans.
      // Vue 2 cannot reactively track a property that was never defined on the object.
      if (!Object.hasOwn(u, 'allow-upload')) u['allow-upload'] = true;
      if (!Object.hasOwn(u, 'allow-radio-recording')) u['allow-radio-recording'] = false;
      if (!Object.hasOwn(u, 'allow-youtube-download')) u['allow-youtube-download'] = false;
      // MPV permissions: server-remote default true (matches historical open access), mpv-cast default false
      if (!Object.hasOwn(u, 'allow-server-remote')) u['allow-server-remote'] = true;
      if (!Object.hasOwn(u, 'allow-mpv-cast')) u['allow-mpv-cast'] = false;
      // Use Vue.set so each user object enters Vue's reactive system.
      // Plain assignment (module.users[key] = u) bypasses reactivity — subsequent
      // Vue.set() calls on the child object would never trigger template updates.
      Vue.set(module.users, key, u);
    });

    module.usersUpdated.ts = Date.now();
  };

  module.getDbParams = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/db/params`
    });

    Object.keys(res.data).forEach(key=>{
      module.dbParams[key] = res.data[key];
    });

    module.dbParamsUpdated.ts = Date.now();
  }

  module.getServerParams = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/config`
    });

    Object.keys(res.data).forEach(key=>{
      module.serverParams[key] = res.data[key];
    });

    module.serverParamsUpdated.ts = Date.now();
  }

  module.getTranscodeParams = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/transcode`
    });

    Object.keys(res.data).forEach(key=>{
      module.transcodeParams[key] = res.data[key];
    });

    module.transcodeParamsUpdated.ts = Date.now();
  }

  module.getServerAudioParams = async () => {
    const res = await API.axios({
      method: 'GET',
      url: `${API.url()}/api/v1/admin/server-audio`
    });

    Object.keys(res.data).forEach(key=>{
      module.serverAudioParams[key] = res.data[key];
    });

    module.serverAudioParamsUpdated.ts = Date.now();
  }

  module.getDlnaParams = async () => {
    try {
      const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/dlna/config` });
      Object.keys(res.data).forEach(key => { module.dlnaParams[key] = res.data[key]; });
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    module.dlnaParamsUpdated.ts = Date.now();
  }

  module.getFederationParams = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api/v1/federation/stats`
      });

      if (res.data.enabled === false) {
        module.federationEnabled.val = false;
      } else {
        module.federationEnabled.val = true;
        Object.keys(res.data).forEach(key=>{
          module.federationParams[key] = res.data[key];
        });
      }
    }catch { /* noop */ }

    module.federationParamsUpdated.ts = Date.now();
  }

  module.getVersion = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api`
      });
      module.version.val = res.data.server;
    }catch { /* noop */ } 
  }

  module.getWinDrives = async () => {
    try {
      const res = await API.axios({
        method: 'GET',
        url: `${API.url()}/api/v1/admin/file-explorer/win-drives`
      });

      module.winDrives.length = 0;
      res.data.forEach((d) => {
        module.winDrives.push(d);
      });

      return res;
    }catch { /* noop */ }
  }

  return module;
})();

// Load in data
ADMINDATA.getTranscodeParams();
ADMINDATA.getServerAudioParams();
ADMINDATA.getDlnaParams();
ADMINDATA.getFolders();
ADMINDATA.getUsers();
ADMINDATA.getDbParams();
ADMINDATA.getServerParams().then(() => {
  ADMINDATA.getFederationParams();
}).catch(() => {});
ADMINDATA.getVersion();
ADMINDATA.getWinDrives();

// Fetch scan error count for sidebar badge on boot
(async () => {
  try {
    const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/db/scan-errors/count` });
    const badge = document.getElementById('scan-errors-badge');
    if (badge && res.data.count > 0) {
      badge.textContent = res.data.count > 99 ? '99+' : res.data.count;
      badge.style.display = 'inline-flex';
    }
  } catch (e) { console.debug('[velvet]', e?.message ?? e); }
})();

// Handle .modal-close class elements
document.addEventListener('click', function(e) {
  if (e.target.closest('.modal-close')) modVM.closeModal();
});

// Intialize Clipboard
const _clipboard = new ClipboardJS('.fed-copy-button'); // eslint-disable-line no-unused-vars

// ── Confirm dialog helper ──────────────────────────────────────
function adminConfirm(title, message, confirmLabel, onConfirm) {
  confirmVM.ask(title, message, confirmLabel, onConfirm);
}

// ── Modal template helpers ─────────────────────────────────────
const mHead = (title, subtitle = '') => {
  const subHtml = subtitle ? `<div class="modal-subtitle">${subtitle}</div>` : '';
  return `<div class="modal-header"><div><div class="modal-title">${title}</div>${subHtml}</div><button class="modal-close-x" type="button" @click="closeModal">&times;</button></div>`;
};
const mFoot = (saveExpr = "t('admin.modal.btnSave')", pendingExpr = "t('admin.modal.btnSaving')") =>
  `<div class="modal-footer-row"><button class="btn-flat" type="button" @click="closeModal">{{ t('admin.modal.btnCancel') }}</button><button class="btn" type="submit" :disabled="submitPending === true">{{ submitPending === false ? ${saveExpr} : ${pendingExpr} }}</button></div>`;

// Global mixin: provides closeModal() to every component
Vue.mixin({
  methods: {
    closeModal() { if (modVM !== undefined) modVM.closeModal(); }
  }
});

// ── Wrapped Play Stats Admin View ──────────────────────────────────────────
const wrappedAdminView = Vue.component('wrapped-admin-view', {
  data() {
    const pad = n => String(n).padStart(2, '0');
    const fmtLocal = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const now = new Date();
    return {
      loading:    false,
      loaded:     false,
      stats:      null,
      purgeUser:  '',
      fromDt:     fmtLocal(new Date(now.getTime() - 3600000)), // 1h ago
      toDt:       fmtLocal(now),
      purging:    false,
      backfilling: false,
      // Fix Missing Metadata preview
      previewLoading: false,
      preview: null,  // { total, canDerive, skipped, examples[] }
    };
  },
  computed: {
    storageKB() {
      return this.stats ? (this.stats.storage_bytes / 1024).toFixed(1) : '—';
    },
  },
  mounted() { this.load(); this.loadPreview(); },
  methods: {
    // Format a Date as the value expected by <input type="datetime-local">: "YYYY-MM-DDTHH:MM"
    _fmtLocal(d) {
      const pad = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },
    async loadPreview() {
      this.previewLoading = true;
      try {
        const r = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/wrapped/backfill-folder-metadata/preview` });
        this.preview = r.data;
      } catch { this.preview = null; } finally { this.previewLoading = false; }
    },
    setPreset(hoursAgo) {
      const now = new Date();
      this.toDt   = this._fmtLocal(now);
      this.fromDt = this._fmtLocal(new Date(now.getTime() - hoursAgo * 3600000));
    },
    setPresetDay(daysAgo) {
      const d = new Date();
      d.setDate(d.getDate() - daysAgo);
      d.setHours(0, 0, 0, 0);
      const end = new Date(d);
      end.setHours(23, 59, 59, 0);
      this.fromDt = this._fmtLocal(d);
      this.toDt   = this._fmtLocal(daysAgo === 0 ? new Date() : end);
    },
    async load() {
      this.loading = true;
      try {
        const r = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/wrapped/stats` });
        this.stats = r.data;
        this.loaded = true;
        if (this.stats.per_user.length) this.purgeUser = this.stats.per_user[0].user_id;
      } catch {
        iziToast.error({ title: this.t('admin.playStats.toastFailedLoad'), position: 'topCenter', timeout: 3000 });
      } finally {
        this.loading = false;
      }
    },
    doPurge() {
      if (!this.purgeUser || !this.fromDt || !this.toDt) return;
      const fromMs = new Date(this.fromDt).getTime();
      const toMs   = new Date(this.toDt).getTime();
      if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
        iziToast.error({ title: this.t('admin.playStats.toastInvalidDate'), position: 'topCenter', timeout: 3000 });
        return;
      }
      if (toMs < fromMs) {
        iziToast.error({ title: this.t('admin.playStats.toastToBeforeFrom'), position: 'topCenter', timeout: 3000 });
        return;
      }
      const fmt = dt => new Date(dt).toLocaleString();
      adminConfirm(
        this.t('admin.playStats.confirmDeleteTitle', { user: this.purgeUser }),
        this.t('admin.playStats.confirmDeleteMsg', { from: fmt(fromMs), to: fmt(toMs) }),
        this.t('admin.playStats.confirmDeleteLabel'),
        async () => {
          this.purging = true;
          try {
            const r = await API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/admin/wrapped/purge`,
              data: { userId: this.purgeUser, fromMs, toMs },
            });
            iziToast.success({ title: this.t('admin.playStats.toastDeletedEvents', { count: r.data.deleted }), position: 'topCenter', timeout: 3000 });
            this.load();
          } catch (e) {
            iziToast.error({ title: this.t('admin.playStats.toastDeleteFailed'), message: e.message, position: 'topCenter', timeout: 4000 });
          } finally {
            this.purging = false;
          }
        }
      );
    },
    fmtMs(ms) {
      if (!ms) return '0 min';
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      return h ? `${h}h ${m}m` : `${m} min`;
    },
    doBackfill() {
      adminConfirm(
        this.t('admin.playStats.confirmBackfillTitle'),
        this.t('admin.playStats.confirmBackfillMsg'),
        this.t('admin.playStats.confirmBackfillLabel'),
        async () => {
          this.backfilling = true;
          try {
            const r = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/wrapped/backfill-folder-metadata` });
            iziToast.success({ title: this.t('admin.playStats.toastUpdatedFiles', { count: r.data.updated }), position: 'topCenter', timeout: 4000 });
            this.loadPreview(); // refresh count after apply
          } catch (e) {
            iziToast.error({ title: this.t('admin.playStats.toastBackfillFailed'), message: e.message, position: 'topCenter', timeout: 4000 });
          } finally {
            this.backfilling = false;
          }
        }
      );
    },
  },
  template: `
    <div>
      <div class="card">
        <div class="card-content">
          <span class="card-title">{{ t('admin.playStats.title') }}</span>
          <p class="grey-text">{{ t('admin.playStats.subtitle') }}</p>
          <div v-if="loading" class="center-align" style="padding:2rem;">{{ t('admin.playStats.loading') }}</div>
          <div v-else-if="loaded && stats">
            <div style="display:flex;gap:2rem;flex-wrap:wrap;margin-bottom:1.5rem;">
              <div class="admin-stat-box">
                <div class="admin-stat-value">{{ stats.total_events.toLocaleString() }}</div>
                <div class="admin-stat-label">{{ t('admin.playStats.statSongEvents') }}</div>
              </div>
              <div class="admin-stat-box">
                <div class="admin-stat-value">{{ stats.total_radio.toLocaleString() }}</div>
                <div class="admin-stat-label">{{ t('admin.playStats.statRadioSessions') }}</div>
              </div>
              <div class="admin-stat-box">
                <div class="admin-stat-value">{{ stats.total_podcast.toLocaleString() }}</div>
                <div class="admin-stat-label">{{ t('admin.playStats.statPodcastEpisodes') }}</div>
              </div>
              <div class="admin-stat-box">
                <div class="admin-stat-value">{{ storageKB }} KB</div>
                <div class="admin-stat-label">{{ t('admin.playStats.statDbStorage') }}</div>
              </div>
            </div>
            <table class="striped" v-if="stats.per_user.length">
              <thead><tr><th>{{ t('admin.playStats.tableUser') }}</th><th>{{ t('admin.playStats.tableSongs') }}</th><th>{{ t('admin.playStats.tableSongTime') }}</th><th>{{ t('admin.playStats.tableRadioSessions') }}</th><th>{{ t('admin.playStats.tableRadioTime') }}</th><th>{{ t('admin.playStats.tablePodcastEps') }}</th><th>{{ t('admin.playStats.tablePodcastTime') }}</th></tr></thead>
              <tbody>
                <tr v-for="u in stats.per_user" :key="u.user_id">
                  <td>{{ u.user_id }}</td>
                  <td>{{ u.event_count.toLocaleString() }}</td>
                  <td>{{ fmtMs(u.total_played_ms) }}</td>
                  <td>{{ u.radio_sessions.toLocaleString() }}</td>
                  <td>{{ fmtMs(u.total_radio_ms) }}</td>
                  <td>{{ u.podcast_episodes.toLocaleString() }}</td>
                  <td>{{ fmtMs(u.total_podcast_ms) }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="grey-text">{{ t('admin.playStats.noEventsYet') }}</p>
          </div>
        </div>
      </div>

      <div class="card" v-if="loaded && stats && stats.per_user.length">
        <div class="card-content">
          <span class="card-title">{{ t('admin.playStats.deleteRangeTitle') }}</span>
          <p class="grey-text">{{ t('admin.playStats.deleteRangeDesc') }}</p>

          <div style="margin-bottom:1rem;">
            <div style="font-size:.8rem;color:var(--fg-muted);margin-bottom:.4rem;">{{ t('admin.playStats.labelUser') }}</div>
            <select v-model="purgeUser" style="padding:.4rem .6rem;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);">
              <option v-for="u in stats.per_user" :key="u.user_id" :value="u.user_id">{{ u.user_id }}</option>
            </select>
          </div>

          <div style="display:flex;gap:1.5rem;flex-wrap:wrap;margin-bottom:1rem;">
            <div>
              <div style="font-size:.8rem;color:var(--fg-muted);margin-bottom:.3rem;">{{ t('admin.playStats.labelFrom') }}</div>
              <input type="datetime-local" v-model="fromDt" style="padding:.4rem .6rem;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);" />
            </div>
            <div>
              <div style="font-size:.8rem;color:var(--fg-muted);margin-bottom:.3rem;">{{ t('admin.playStats.labelTo') }}</div>
              <input type="datetime-local" v-model="toDt" style="padding:.4rem .6rem;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);" />
            </div>
          </div>

          <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-bottom:1.2rem;">
            <span style="font-size:.8rem;color:var(--fg-muted);">{{ t('admin.playStats.quickSelect') }}</span>
            <button class="btn btn-small" style="height:2rem;line-height:2rem;padding:0 .75rem;font-size:.8rem;" @click="setPreset(1)">{{ t('admin.playStats.presetLast1h') }}</button>
            <button class="btn btn-small" style="height:2rem;line-height:2rem;padding:0 .75rem;font-size:.8rem;" @click="setPreset(6)">{{ t('admin.playStats.presetLast6h') }}</button>
            <button class="btn btn-small" style="height:2rem;line-height:2rem;padding:0 .75rem;font-size:.8rem;" @click="setPreset(12)">{{ t('admin.playStats.presetLast12h') }}</button>
            <button class="btn btn-small" style="height:2rem;line-height:2rem;padding:0 .75rem;font-size:.8rem;" @click="setPresetDay(0)">{{ t('admin.playStats.presetToday') }}</button>
            <button class="btn btn-small" style="height:2rem;line-height:2rem;padding:0 .75rem;font-size:.8rem;" @click="setPresetDay(1)">{{ t('admin.playStats.presetYesterday') }}</button>
          </div>

          <button class="btn red darken-1" :disabled="purging" @click="doPurge">
            {{ purging ? t('admin.playStats.btnDeleting') : t('admin.playStats.btnDelete') }}
          </button>
        </div>
      </div>

      <div class="card">
        <div class="card-content">
          <span class="card-title">{{ t('admin.playStats.fixMetadataTitle') }}</span>
          <p class="grey-text">{{ t('admin.playStats.fixMetadataDesc') }}</p>
          <p class="grey-text" style="margin-top:.5rem;">{{ t('admin.playStats.fixMetadataNote') }}</p>

          <!-- Count summary -->
          <div v-if="previewLoading" style="margin-top:.75rem;font-size:.85rem;color:var(--fg-muted);">{{ t('admin.playStats.previewLoading') }}</div>
          <div v-else-if="preview" style="margin-top:.75rem;">
            <div style="display:flex;gap:1.5rem;flex-wrap:wrap;margin-bottom:.9rem;">
              <div class="admin-stat-box">
                <div class="admin-stat-value">{{ preview.total.toLocaleString() }}</div>
                <div class="admin-stat-label">{{ t('admin.playStats.previewTotal') }}</div>
              </div>
              <div class="admin-stat-box">
                <div class="admin-stat-value" style="color:#66bb6a;">{{ preview.canDerive.toLocaleString() }}</div>
                <div class="admin-stat-label">{{ t('admin.playStats.previewCanDerive') }}</div>
              </div>
              <div class="admin-stat-box">
                <div class="admin-stat-value" style="color:var(--fg-muted);">{{ preview.skipped.toLocaleString() }}</div>
                <div class="admin-stat-label">{{ t('admin.playStats.previewSkipped') }}</div>
              </div>
            </div>

            <!-- Example rows -->
            <div v-if="preview.examples && preview.examples.length" style="margin-bottom:.9rem;">
              <div style="font-size:.78rem;font-weight:600;color:var(--fg-muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:.4rem;">{{ t('admin.playStats.previewExamplesLabel') }}</div>
              <div style="overflow-x:auto;">
                <table style="width:100%;border-collapse:collapse;font-size:.8rem;">
                  <thead>
                    <tr style="color:var(--fg-muted);text-align:left;">
                      <th style="padding:.25rem .5rem;font-weight:500;">{{ t('admin.playStats.colArtist') }}</th>
                      <th style="padding:.25rem .5rem;font-weight:500;">{{ t('admin.playStats.colAlbum') }}</th>
                      <th style="padding:.25rem .5rem;font-weight:500;">{{ t('admin.playStats.colTitle') }}</th>
                      <th style="padding:.25rem .5rem;font-weight:500;">{{ t('admin.playStats.colFile') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(ex, i) in preview.examples" :key="i" :style="{ background: i%2===0 ? 'transparent' : 'rgba(128,128,128,.06)' }">
                      <td style="padding:.3rem .5rem;white-space:nowrap;">{{ ex.artist }}</td>
                      <td style="padding:.3rem .5rem;">{{ ex.album }}</td>
                      <td style="padding:.3rem .5rem;">{{ ex.title }}</td>
                      <td style="padding:.3rem .5rem;color:var(--fg-muted);font-size:.72rem;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" :title="ex.filepath">{{ ex.filepath.split('/').pop() }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <button class="btn" :disabled="backfilling || (preview && preview.canDerive === 0)" @click="doBackfill" style="margin-top:.5rem;">
            {{ backfilling ? t('admin.playStats.btnApplying') : t('admin.playStats.btnDerive') }}
          </button>
        </div>
      </div>
    </div>
  `,
});

// ── Artist Albums Diagnostic View ─────────────────────────────────────────
const artistAlbumsDiagView = Vue.component('artist-albums-diag-view', {
  data() {
    return {
      artistQuery: '',
      loading: false,
      result: null,
      error: null,
      copied: false,
    };
  },
  methods: {
    async runDiag() {
      const q = this.artistQuery.trim();
      if (!q) return;
      this.loading = true;
      this.result = null;
      this.error = null;
      this.copied = false;
      try {
        const r = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/diagnostics/artist-albums`, params: { artist: q } });
        this.result = r.data;
      } catch (e) {
        this.error = e?.response?.data?.error || e.message || 'Request failed';
      } finally {
        this.loading = false;
      }
    },
    exportJson() {
      if (!this.result) return;
      const blob = new Blob([JSON.stringify(this.result, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `artist-diag-${this.result.query.replaceAll(/[^a-z0-9]/gi, '_')}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
    exportText() {
      if (!this.result) return;
      const r = this.result;
      const lines = [];
      lines.push(
        `Artist Albums — ${r.query}`,
        '='.repeat(60),
        '',
        'SUMMARY',
        `  Distinct effective-artist values : ${r.summary.totalEffectiveValues}`,
        `  Covered by normalised variants   : ${r.summary.coveredByVariants}`,
        `  Orphaned values (not covered)    : ${r.summary.orphanedValues}`,
        `  Hidden albums (orphaned)         : ${r.summary.orphanedAlbumCount}`,
        '',
      );
      if (r.normalizedEntry) {
        lines.push(
          'NORMALIZED INDEX ENTRY',
          `  Canonical name : ${r.normalizedEntry.canonicalName}`,
          `  Song count     : ${r.normalizedEntry.songCount}`,
          `  Known vpaths   : ${r.normalizedEntry.vpaths.join(', ') || '(none)'}`,
          '  Raw variants:',
        );
        for (const v of r.normalizedEntry.rawVariants) lines.push(`    ${v}`);
        lines.push('');
      } else {
        lines.push('NORMALIZED INDEX ENTRY', '  Not found.', '');
      }
      if (r.orphanAlbums.length) {
        lines.push('ORPHANED ARTIST VALUES (albums hidden from artist view)');
        for (const o of r.orphanAlbums) {
          lines.push(`  ${o.effective}  (${o.track_count} tracks)`);
          for (const a of o.albums) {
            lines.push(`    ${a.album || '(no album tag)'}  —  ${a.vpath}/${a.dir}`);
          }
        }
        lines.push('', '  Fix: retag album_artist on these files to one of the rawVariants above,', '  then re-scan.', '');
      }
      lines.push('ALBUMS PER NORMALIZED VARIANT');
      for (const [variant, albums] of Object.entries(r.albumsByVariant)) {
        lines.push(`  ${variant}`);
        if (!albums.length) { lines.push('    (no albums)'); continue; }
        for (const a of albums) lines.push(`    ${a.album || '(no album tag)'}  [${a.vpath}]`);
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `artist-diag-${r.query.replaceAll(/[^a-z0-9]/gi, '_')}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    },
    async copyJson() {
      if (!this.result) return;
      try {
        await navigator.clipboard.writeText(JSON.stringify(this.result, null, 2));
        this.copied = true;
        setTimeout(() => { this.copied = false; }, 2000);
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    },
  },
  template: `
    <div class="admin-panel-wrap">
      <h2 class="admin-section-title">Artist Albums</h2>

      <!-- Album Category Folders -->
      <div class="admin-card" style="margin-bottom:24px;padding:16px 18px;">
        <div class="admin-label" style="margin-bottom:6px;font-size:.95rem;">Album Category Folders</div>
        <album-category-folders-card></album-category-folders-card>
      </div>

      <hr style="border:none;border-top:1px solid var(--border);margin:0 0 20px;">

      <div class="admin-label" style="margin-bottom:8px;">Artist Albums Diagnostic</div>
      <p class="admin-desc" style="margin-bottom:12px">
        Enter an artist name to find out why some albums may be missing from their artist view.
      </p>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:18px">
        <input
          v-model="artistQuery"
          class="admin-input"
          style="flex:1;max-width:360px"
          placeholder="e.g. Riverside"
          @keyup.enter="runDiag"
        />
        <button class="admin-btn" :disabled="loading || !artistQuery.trim()" @click="runDiag">
          {{ loading ? 'Running…' : 'Run Diagnostic' }}
        </button>
        <template v-if="result">
          <button class="admin-btn admin-btn-secondary" @click="exportText" title="Download as plain text file">
            ↓ Export .txt
          </button>
          <button class="admin-btn admin-btn-secondary" @click="exportJson" title="Download as JSON file">
            ↓ Export .json
          </button>
          <button class="admin-btn admin-btn-secondary" @click="copyJson" title="Copy full JSON to clipboard">
            {{ copied ? '✓ Copied!' : 'Copy JSON' }}
          </button>
        </template>
      </div>

      <div v-if="error" style="color:var(--danger);margin-bottom:12px">{{ error }}</div>

      <template v-if="result">
        <!-- Summary banner -->
        <div class="admin-card" style="margin-bottom:16px;padding:12px 16px">
          <div style="display:flex;gap:24px;flex-wrap:wrap">
            <div><span style="color:var(--t3);font-size:12px">Distinct effective-artist values</span><br><strong>{{ result.summary.totalEffectiveValues }}</strong></div>
            <div><span style="color:var(--t3);font-size:12px">Covered by normalised variants</span><br><strong style="color:var(--accent)">{{ result.summary.coveredByVariants }}</strong></div>
            <div><span style="color:var(--t3);font-size:12px">Orphaned values (not covered)</span><br><strong :style="result.summary.orphanedValues > 0 ? 'color:var(--danger)' : ''">{{ result.summary.orphanedValues }}</strong></div>
            <div><span style="color:var(--t3);font-size:12px">Hidden albums (orphaned)</span><br><strong :style="result.summary.orphanedAlbumCount > 0 ? 'color:var(--danger)' : ''">{{ result.summary.orphanedAlbumCount }}</strong></div>
          </div>
        </div>

        <!-- Normalized entry -->
        <div class="admin-card" style="margin-bottom:16px;padding:12px 16px">
          <div class="admin-label" style="margin-bottom:6px">Normalized Index Entry</div>
          <template v-if="result.normalizedEntry">
            <div style="margin-bottom:4px"><span style="color:var(--t3)">Canonical name: </span><strong>{{ result.normalizedEntry.canonicalName }}</strong></div>
            <div style="margin-bottom:4px"><span style="color:var(--t3)">Song count: </span>{{ result.normalizedEntry.songCount }}</div>
            <div style="margin-bottom:4px"><span style="color:var(--t3)">Known vpaths: </span>{{ result.normalizedEntry.vpaths.join(', ') || '(none)' }}</div>
            <div style="margin-bottom:2px;color:var(--t3)">Raw variants queried in artist view:</div>
            <ul style="margin:4px 0 0 16px;padding:0">
              <li v-for="v in result.normalizedEntry.rawVariants" :key="v" style="font-size:13px;font-family:monospace">{{ v }}</li>
            </ul>
          </template>
          <div v-else style="color:var(--danger)">Artist not found in normalized index — no artist card will be shown in the Artists view.</div>
        </div>

        <!-- Orphaned albums (root cause!) -->
        <template v-if="result.orphanAlbums.length">
          <div class="admin-card" style="margin-bottom:16px;padding:12px 16px;border:1px solid var(--danger)">
            <div class="admin-label" style="color:var(--danger);margin-bottom:8px">⚠ Orphaned artist values — albums hidden from artist view</div>
            <p style="font-size:13px;color:var(--t2);margin-bottom:10px">
              These effective COALESCE(album_artist, artist) values exist in the database but are NOT included in the
              artist's rawVariants list. Any album whose tracks have these values will be invisible in the artist view.
            </p>
            <div v-for="o in result.orphanAlbums" :key="o.effective" style="margin-bottom:12px">
              <div style="font-family:monospace;font-size:13px;background:var(--bg2);padding:4px 8px;border-radius:4px;margin-bottom:4px">
                {{ o.effective }} <span style="color:var(--t3)">({{ o.track_count }} tracks)</span>
              </div>
              <ul style="margin:0 0 0 16px;padding:0">
                <li v-for="a in o.albums" :key="a.dir" style="font-size:12px;color:var(--t2)">
                  {{ a.album || '(no album tag)' }} — <span style="color:var(--t3)">{{ a.vpath }}/{{ a.dir }}</span>
                </li>
              </ul>
            </div>
            <p style="font-size:12px;color:var(--t3);margin-top:8px">
              Fix: ensure the album_artist tag on these files matches exactly one of the rawVariants above, or re-scan after correcting the tags.
            </p>
          </div>
        </template>

        <!-- Albums per variant -->
        <div class="admin-card" style="padding:12px 16px">
          <div class="admin-label" style="margin-bottom:8px">Albums per normalized variant</div>
          <template v-if="result.normalizedEntry">
            <div v-for="(albums, variant) in result.albumsByVariant" :key="variant" style="margin-bottom:10px">
              <div style="font-family:monospace;font-size:13px;background:var(--bg2);padding:3px 8px;border-radius:3px;margin-bottom:4px">{{ variant }}</div>
              <div v-if="!albums.length" style="font-size:12px;color:var(--t3);margin-left:12px">No albums</div>
              <ul v-else style="margin:0 0 0 16px;padding:0">
                <li v-for="a in albums" :key="a.dir" style="font-size:12px;color:var(--t2)">
                  {{ a.album || '(no album tag)' }} <span style="color:var(--t3)">[{{ a.vpath }}]</span>
                </li>
              </ul>
            </div>
          </template>
          <div v-else style="color:var(--t3);font-size:13px">No normalized entry found — no albums to show.</div>
        </div>
      </template>
    </div>
  `,
});

// ── Scan Error Audit View ──────────────────────────────────────────────────
const scanErrorsView = Vue.component('scan-errors-view', {
  data() {
    return {
      errors:          [],
      total:           0,
      loading:         false,
      loaded:          false,
      expandedRow:     null,
      typeFilter:      null,
      retentionHours:  ADMINDATA.dbParams.scanErrorRetentionHours || 48,
      savingRetention: false,
      fixing:          {},   // guid → true while fix API call is in-flight
    };
  },
  computed: {
    filteredErrors() {
      if (!this.typeFilter) return this.errors;
      return this.errors.filter(e => e.error_type === this.typeFilter);
    },
    typeCounts() {
      const c = {};
      for (const e of this.errors) { c[e.error_type] = (c[e.error_type] || 0) + 1; }
      return c;
    },
    allTypes() {
      return [...new Set(this.errors.map(e => e.error_type))];
    },
    unfixedCount() {
      return this.errors.filter(e => !e.fixed_at && e.file_in_db).length;
    }
  },
  mounted() { this.load(); },
  methods: {
    async load() {
      this.loading = true;
      try {
        const [errRes, paramRes] = await Promise.all([
          API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/db/scan-errors` }),
          API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/db/params` })
        ]);
        this.errors = errRes.data.errors;
        this.total  = errRes.data.total;
        this.loaded = true;
        if (paramRes.data.scanErrorRetentionHours) {
          this.retentionHours = paramRes.data.scanErrorRetentionHours;
        }
        const badge = document.getElementById('scan-errors-badge');
        if (badge) {
          const cnt = this.unfixedCount;
          badge.textContent = cnt > 99 ? '99+' : cnt;
          badge.style.display = cnt === 0 ? 'none' : 'inline-flex';
        }
      } catch {
        iziToast.error({ title: this.t('admin.scanErrors.toastFailedLoad'), position: 'topCenter', timeout: 3000 });
      } finally {
        this.loading = false;
      }
    },
    confirmClear() {
      adminConfirm(
        this.t('admin.scanErrors.confirmClearTitle'),
        this.t('admin.scanErrors.confirmClearMsg'),
        this.t('admin.scanErrors.confirmClearLabel'),
        () => this.doClear()
      );
    },
    async doClear() {
      try {
        await API.axios({ method: 'DELETE', url: `${API.url()}/api/v1/admin/db/scan-errors` });
        this.errors = [];
        this.total  = 0;
        this.typeFilter = null;
        const badge = document.getElementById('scan-errors-badge');
        if (badge) badge.style.display = 'none';
        iziToast.success({ title: this.t('admin.scanErrors.toastCleared'), position: 'topCenter', timeout: 2500 });
      } catch {
        iziToast.error({ title: this.t('admin.scanErrors.toastFailedClear'), position: 'topCenter', timeout: 3000 });
      }
    },
    async saveRetention() {
      this.savingRetention = true;
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/scan-error-retention`,
          data: { hours: Number(this.retentionHours) }
        });
        ADMINDATA.dbParams.scanErrorRetentionHours = Number(this.retentionHours);
        iziToast.success({ title: this.t('admin.scanErrors.toastRetentionSaved'), position: 'topCenter', timeout: 2000 });
      } catch {
        iziToast.error({ title: this.t('admin.scanErrors.toastRetentionFailed'), position: 'topCenter', timeout: 3000 });
      } finally {
        this.savingRetention = false;
      }
    },
    toggleRow(guid) {
      this.expandedRow = this.expandedRow === guid ? null : guid;
    },
    typeLabel(t) {
      return {
        parse: this.t('admin.scanErrors.typeParseError'),
        art: this.t('admin.scanErrors.typeAlbumArt'),
        cue: this.t('admin.scanErrors.typeCueSheet'),
        insert: this.t('admin.scanErrors.typeDbInsert'),
        other: this.t('admin.scanErrors.typeOther')
      }[t] || t;
    },
    typeIcon(t) {
      const icons = {
        parse:  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
        art:    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
        cue:    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
        insert: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
        other:  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
      };
      return icons[t] || icons.other;
    },
    typeColor(t) {
      return { parse: 'var(--red)', art: 'var(--yellow)', cue: 'var(--primary)', insert: 'var(--accent)', other: 'var(--t2)' }[t] || 'var(--t2)';
    },
    typeBg(t) {
      return { parse: 'rgba(248,113,113,.14)', art: 'rgba(251,191,36,.14)', cue: 'rgba(139,92,246,.14)', insert: 'rgba(96,165,250,.12)', other: 'rgba(136,136,176,.10)' }[t] || 'rgba(136,136,176,.10)';
    },
    retentionLabel(h) {
      const map = {
        12: this.t('admin.scanErrors.retention12h'),
        24: this.t('admin.scanErrors.retention1d'),
        48: this.t('admin.scanErrors.retention2d'),
        72: this.t('admin.scanErrors.retention3d'),
        168: this.t('admin.scanErrors.retention1w'),
        336: this.t('admin.scanErrors.retention2w'),
        720: this.t('admin.scanErrors.retention30d')
      };
      return map[h] || h + 'h';
    },
    relTime(ts) {
      const s = Math.floor(Date.now() / 1000) - ts;
      if (s < 10)     return 'just now';
      if (s < 60)     return s + 's ago';
      if (s < 3600)   return Math.floor(s / 60) + 'm ago';
      if (s < 86400)  return Math.floor(s / 3600) + 'h ago';
      if (s < 2592000) return Math.floor(s / 86400) + 'd ago';
      return new Date(ts * 1000).toLocaleDateString();
    },
    absTime(ts) {
      return new Date(ts * 1000).toLocaleString();
    },
    shortPath(fp) {
      if (!fp) return '—';
      const parts = fp.replaceAll('\\', '/').split('/');
      if (parts.length <= 3) return fp;
      return '\u2026/' + parts.slice(-2).join('/');
    },
    copyPath(fp) {
      if (!fp) return;
      navigator.clipboard.writeText(fp).then(() => {
        iziToast.info({ title: this.t('admin.scanErrors.toastPathCopied'), position: 'topCenter', timeout: 1500 });
      }).catch(() => {});
    },
    async fixError(err) {
      if (err.fixed_at || this.fixing[err.guid]) return;
      Vue.set(this.fixing, err.guid, true);
      try {
        const r = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/db/scan-errors/fix`, data: { guid: err.guid } });
        const idx = this.errors.findIndex(e => e.guid === err.guid);
        if (idx >= 0) {
          this.errors[idx].fixed_at  = Math.floor(Date.now() / 1000);
          this.errors[idx]._fixAction = r.data.action;
        }
        const badge = document.getElementById('scan-errors-badge');
        if (badge) {
          const cnt = this.unfixedCount;
          badge.textContent = cnt > 99 ? '99+' : cnt;
          badge.style.display = cnt === 0 ? 'none' : 'inline-flex';
        }
        const labels = {
          art_fixed: this.t('admin.scanErrors.fixActionArtFixed'),
          remuxed: this.t('admin.scanErrors.fixActionRemuxed'),
          reencoded: this.t('admin.scanErrors.fixActionReencoded'),
          cue_dismissed: this.t('admin.scanErrors.fixActionCueDismissed'),
          dismissed: this.t('admin.scanErrors.fixActionDismissed'),
          unrecoverable: this.t('admin.scanErrors.fixActionUnrecoverable')
        };
        if (r.data.action === 'unrecoverable') {
          iziToast.error({ title: this.t('admin.scanErrors.toastFileUnrecoverable'), message: this.t('admin.scanErrors.toastFileUnrecoverableMsg'), position: 'topCenter', timeout: 0, close: true });
        } else {
          const msg = (labels[r.data.action] || this.t('admin.scanErrors.toastFixed')) + (r.data.note ? ' — ' + r.data.note : '');
          iziToast.success({ title: this.t('admin.scanErrors.toastFixed'), message: msg, position: 'topCenter', timeout: 4000 });
        }
        // Sync fix_action from server response into the local row so the badge
        // reflects the correct state immediately (before page reload).
        if (idx >= 0) this.errors[idx].fix_action = r.data.action;
      } catch (e) {
        iziToast.error({ title: this.t('admin.scanErrors.toastFixFailed'), message: e?.response?.data?.error || this.t('admin.scanErrors.typeOther'), position: 'topCenter', timeout: 0, close: true });
      } finally {
        Vue.delete(this.fixing, err.guid);
      }
    },
    fixActionLabel(action) {
      return {
        art_fixed: this.t('admin.scanErrors.fixActionArtFixed'),
        remuxed: this.t('admin.scanErrors.fixActionRemuxed'),
        reencoded: this.t('admin.scanErrors.fixActionReencoded'),
        cue_dismissed: this.t('admin.scanErrors.fixActionCueDismissed'),
        dismissed: this.t('admin.scanErrors.fixActionDismissed'),
        unrecoverable: this.t('admin.scanErrors.fixActionUnrecoverable')
      }[action] || this.t('admin.scanErrors.toastFixed');
    }
  },
  template: `
    <div>
      <div class="container">

        <!-- ── Header Card ── -->
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <div class="se-header">
                  <div class="se-title-group">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2" style="flex-shrink:0;margin-top:1px">
                      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <div>
                      <div class="se-main-title">{{ t('admin.scanErrors.title') }}</div>
                      <div class="se-sub">{{ t('admin.scanErrors.subtitle') }}</div>
                    </div>
                    <span class="se-total-pill" v-if="loaded && unfixedCount > 0">
                      {{ t('admin.scanErrors.pillIssues', { count: unfixedCount }) }}{{total > errors.length ? ' ' + t('admin.scanErrors.pillShowing', { shown: errors.length.toLocaleString(), total: total.toLocaleString() }) : ''}}
                    </span>
                    <span class="se-total-pill se-total-ok" v-else-if="loaded && errors.length === 0">
                      {{ t('admin.scanErrors.pillClean') }}
                    </span>
                    <span class="se-total-pill se-total-ok" v-else-if="loaded && unfixedCount === 0">
                      {{ t('admin.scanErrors.pillNoActionable') }}
                    </span>
                  </div>
                  <div class="se-controls-row">
                    <div class="se-retention-group">
                      <label class="se-retention-label">{{ t('admin.scanErrors.retentionLabel') }}</label>
                      <select v-model.number="retentionHours" @change="saveRetention" class="se-retention-sel" :disabled="savingRetention">
                        <option :value="12">{{ t('admin.scanErrors.retention12h') }}</option>
                        <option :value="24">{{ t('admin.scanErrors.retention1d') }}</option>
                        <option :value="48">{{ t('admin.scanErrors.retention2d') }}</option>
                        <option :value="72">{{ t('admin.scanErrors.retention3d') }}</option>
                        <option :value="168">{{ t('admin.scanErrors.retention1w') }}</option>
                        <option :value="336">{{ t('admin.scanErrors.retention2w') }}</option>
                        <option :value="720">{{ t('admin.scanErrors.retention30d') }}</option>
                      </select>
                      <span class="se-retention-hint">{{ t('admin.scanErrors.retentionHint') }}</span>
                    </div>
                    <div class="se-action-group">
                      <button class="btn-flat btn-small" @click="load" :disabled="loading">
                        <svg v-if="!loading" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                        <svg v-else class="se-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                        {{loading ? t('admin.scanErrors.btnLoading') : t('admin.scanErrors.btnRefresh')}}
                      </button>
                      <button class="btn btn-small red" @click="confirmClear" v-if="errors.length > 0">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
                        {{ t('admin.scanErrors.btnClearAll') }}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ── Loading spinner ── -->
        <div class="row" v-if="loading && !loaded">
          <div class="col s12" style="display:flex;justify-content:center;padding:3rem 0">
            <svg class="spinner" width="50px" height="50px" viewBox="0 0 66 66"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
          </div>
        </div>

        <!-- ── Empty state ── -->
        <div class="row" v-else-if="loaded && errors.length === 0">
          <div class="col s12">
            <div class="card">
              <div class="se-empty-state">
                <div class="se-empty-icon">
                  <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="1.5">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                    <polyline points="22 4 12 14.01 9 11.01"/>
                  </svg>
                </div>
                <div class="se-empty-title">{{ t('admin.scanErrors.emptyTitle') }}</div>
                <div class="se-empty-msg">{{ t('admin.scanErrors.emptyMsg') }}</div>
              </div>
            </div>
          </div>
        </div>

        <template v-else-if="loaded && errors.length > 0">

          <!-- ── Truncation warning ── -->
          <div class="row" v-if="total > errors.length">
            <div class="col s12">
              <div style="background:rgba(251,191,36,.13);border:1px solid rgba(251,191,36,.35);border-radius:8px;padding:.7rem 1rem;display:flex;align-items:center;gap:.6rem;font-size:.85rem;color:var(--yellow)">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                {{ t('admin.scanErrors.truncationWarning', { shown: errors.length.toLocaleString(), total: total.toLocaleString() }) }}
              </div>
            </div>
          </div>

          <!-- ── Type filter chips ── -->
          <div class="row">
            <div class="col s12">
              <div class="se-filter-strip">
                <button class="se-fchip" :class="{active: typeFilter === null}" @click="typeFilter = null">
                  {{ t('admin.scanErrors.filterAll') }}
                  <span class="se-fchip-cnt">{{errors.length}}</span>
                </button>
                <button
                  v-for="type in allTypes" :key="type"
                  class="se-fchip"
                  :class="{active: typeFilter === type}"
                  :style="typeFilter === type ? {background: typeBg(type), borderColor: typeColor(type), color: typeColor(type)} : {}"
                  @click="typeFilter = (typeFilter === type ? null : type)"
                >
                  <span class="se-fchip-dot" :style="{background: typeColor(type)}"></span>
                  {{typeLabel(type)}}
                  <span class="se-fchip-cnt">{{typeCounts[type] || 0}}</span>
                </button>
              </div>
            </div>
          </div>

          <!-- ── Errors table ── -->
          <div class="row">
            <div class="col s12">
              <div class="card se-table-card">
                <div class="se-table-wrap">

                  <!-- Column headers -->
                  <div class="se-thead">
                    <div class="se-th se-col-type">{{ t('admin.scanErrors.colType') }}</div>
                    <div class="se-th se-col-file">{{ t('admin.scanErrors.colFile') }}</div>
                    <div class="se-th se-col-msg">{{ t('admin.scanErrors.colIssue') }}</div>
                    <div class="se-th se-col-count">{{ t('admin.scanErrors.colDetections') }}</div>
                    <div class="se-th se-col-first">{{ t('admin.scanErrors.colFirstSeen') }}</div>
                    <div class="se-th se-col-last">{{ t('admin.scanErrors.colLastSeen') }}</div>
                    <div class="se-th se-col-exp"></div>
                  </div>

                  <!-- Body rows -->
                  <template v-for="err in filteredErrors" :key="err.guid">
                    <!-- Main row -->
                    <div
                      class="se-row"
                      :class="{expanded: expandedRow === err.guid, 'se-row--fixed': err.fixed_at && err.fix_action !== 'unrecoverable', 'se-row--unrecoverable': err.fix_action === 'unrecoverable'}"
                      @click="toggleRow(err.guid)"
                    >
                      <!-- Type badge -->
                      <div class="se-col-type">
                        <span class="se-type-badge"
                          :style="{background: typeBg(err.error_type), color: typeColor(err.error_type), borderColor: typeColor(err.error_type)}"
                        >
                          <span v-html="typeIcon(err.error_type)"></span>
                          {{typeLabel(err.error_type)}}
                        </span>
                        <span class="se-fixed-badge" v-if="err.fixed_at && err.fix_action !== 'unrecoverable'">{{ t('admin.scanErrors.badgeFixed') }}</span>
                        <span class="se-unrecoverable-badge" v-if="err.fix_action === 'unrecoverable'">{{ t('admin.scanErrors.badgeUnrecoverable') }}</span>
                        <span class="se-deleted-badge" v-if="!err.file_in_db && !(err.error_msg && (err.error_msg.includes('EPIPE') || err.error_msg.includes('ECONNRESET') || err.error_msg.includes('ECONNREFUSED')))">{{ t('admin.scanErrors.badgeGoneFromLibrary') }}</span>
                        <span class="se-deleted-badge" v-if="!err.file_in_db && err.error_msg && (err.error_msg.includes('EPIPE') || err.error_msg.includes('ECONNRESET') || err.error_msg.includes('ECONNREFUSED'))">{{ t('admin.scanErrors.badgeScanInterrupted') }}</span>
                      </div>

                      <!-- File path -->
                      <div class="se-col-file">
                        <span class="se-vpath-tag">{{err.vpath}}</span>
                        <span class="se-filepath" :title="err.filepath" @click.stop="copyPath(err.filepath)">
                          {{shortPath(err.filepath)}}
                        </span>
                      </div>

                      <!-- Error message (truncated) -->
                      <div class="se-col-msg">
                        <span class="se-errmsg">{{err.error_msg || '(' + t('admin.scanErrors.noMessage') + ')'}}</span>
                      </div>

                      <!-- Detection count -->
                      <div class="se-col-count">
                        <span class="se-count-badge" v-if="err.count > 1" :title="t('admin.scanErrors.countDetected', { count: err.count })">
                          {{ t('admin.scanErrors.countDetected', { count: err.count }) }}
                        </span>
                        <span class="se-count-once" v-else>{{ t('admin.scanErrors.countOnce') }}</span>
                      </div>

                      <!-- First seen -->
                      <div class="se-col-first">
                        <span :title="absTime(err.first_seen)">{{relTime(err.first_seen)}}</span>
                      </div>

                      <!-- Last seen -->
                      <div class="se-col-last">
                        <span :title="absTime(err.last_seen)">{{relTime(err.last_seen)}}</span>
                      </div>

                      <!-- Expand chevron -->
                      <div class="se-col-exp">
                        <svg class="se-chevron" :class="{open: expandedRow === err.guid}"
                          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                          <polyline points="6 9 12 15 18 9"/>
                        </svg>
                      </div>
                    </div>

                    <!-- Expanded detail panel -->
                    <div class="se-detail" v-if="expandedRow === err.guid">
                      <div class="se-detail-grid">
                        <div class="se-detail-section">
                          <div class="se-detail-label">{{ t('admin.scanErrors.detailFullPath') }}</div>
                          <div class="se-detail-value se-detail-path" @click="copyPath(err.filepath)" title="Click to copy">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                            {{err.filepath || '—'}}
                          </div>
                        </div>
                        <div class="se-detail-section">
                          <div class="se-detail-label">{{ t('admin.scanErrors.detailErrorMsg') }}</div>
                          <div class="se-detail-value">{{err.error_msg || '(' + t('admin.scanErrors.none') + ')'}}</div>
                        </div>
                        <div class="se-detail-section" v-if="err.stack">
                          <div class="se-detail-label">{{ t('admin.scanErrors.detailStackTrace') }}</div>
                          <pre class="se-stack">{{err.stack}}</pre>
                        </div>
                        <div class="se-detail-meta-row">
                          <div class="se-detail-meta-chip">
                            <span class="se-detail-meta-k">{{ t('admin.scanErrors.detailLibraryPath') }}</span>
                            <span class="se-detail-meta-v">{{err.vpath}}</span>
                          </div>
                          <div class="se-detail-meta-chip">
                            <span class="se-detail-meta-k">{{ t('admin.scanErrors.detailFirstDetected') }}</span>
                            <span class="se-detail-meta-v">{{absTime(err.first_seen)}}</span>
                          </div>
                          <div class="se-detail-meta-chip">
                            <span class="se-detail-meta-k">{{ t('admin.scanErrors.detailLastDetected') }}</span>
                            <span class="se-detail-meta-v">{{absTime(err.last_seen)}}</span>
                          </div>
                          <div class="se-detail-meta-chip">
                            <span class="se-detail-meta-k">{{ t('admin.scanErrors.detailTotalDetections') }}</span>
                            <span class="se-detail-meta-v" :style="{color: err.count > 1 ? typeColor(err.error_type) : 'inherit'}">
                              {{ t('admin.scanErrors.detailTimePlural', { count: err.count }) }}
                            </span>
                          </div>
                        </div>

                        <!-- ── Deleted-from-library banner ── -->
                        <div class="se-deleted-banner" v-if="!err.file_in_db">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                          <div>
                            <div class="se-deleted-title">{{ t('admin.scanErrors.deletedBannerTitle') }}</div>
                            <div class="se-deleted-body" v-if="err.error_msg && (err.error_msg.includes('EPIPE') || err.error_msg.includes('ECONNRESET') || err.error_msg.includes('ECONNREFUSED'))">
                              {{ t('admin.scanErrors.deletedBodyInterrupted') }}
                            </div>
                            <div class="se-deleted-body" v-else>{{ t('admin.scanErrors.deletedBodyRemoved') }}</div>
                          </div>
                        </div>

                        <!-- ── Fix action row ── -->
                        <div class="se-unrecoverable-banner" v-if="err.fix_action === 'unrecoverable'">
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                          <div>
                            <div class="se-unrecoverable-title">{{ t('admin.scanErrors.unrecoverableTitle') }}</div>
                            <div class="se-unrecoverable-body">{{ t('admin.scanErrors.unrecoverableBody') }}</div>
                          </div>
                        </div>
                        <div class="se-detail-fix-row" v-else-if="err.fixed_at && err.fix_action !== 'unrecoverable'">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--se-green,#4caf50)" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                          <span class="se-fix-done-txt">
                            Fixed {{relTime(err.fixed_at)}}
                            <span v-if="err.fix_action" style="opacity:.65;margin-left:.35rem">({{fixActionLabel(err.fix_action)}})</span>
                            <span v-if="err.confirmed_at" class="se-confirmed-chip">&#10003; Rescan confirmed OK {{relTime(err.confirmed_at)}}</span>
                            <span v-else style="opacity:.5;margin-left:.5rem;font-size:.8em">{{ t('admin.scanErrors.fixRescanWaiting') }}</span>
                          </span>
                        </div>
                        <div class="se-detail-fix-row" v-else-if="!err.file_in_db">
                          <span style="opacity:.5;font-size:.85em">{{ t('admin.scanErrors.fixNoActionNeeded') }}</span>
                        </div>
                        <div class="se-detail-fix-row" v-else>
                          <button class="se-fix-btn" @click.stop="fixError(err)" :disabled="fixing[err.guid]">
                            <svg v-if="!fixing[err.guid]" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                            <svg v-else class="se-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                            {{fixing[err.guid] ? t('admin.scanErrors.btnFixing') : t('admin.scanErrors.btnFixError')}}
                          </button>
                          <span class="se-fix-hint" v-if="err.error_type === 'art'">{{ t('admin.scanErrors.fixHintArt') }}</span>
                          <span class="se-fix-hint" v-else-if="err.error_type === 'cue'">{{ t('admin.scanErrors.fixHintCue') }}</span>
                          <span class="se-fix-hint" v-else-if="err.error_type === 'parse' || err.error_type === 'duration'">{{ t('admin.scanErrors.fixHintParse') }}</span>
                          <span class="se-fix-hint" v-else>{{ t('admin.scanErrors.fixHintOther') }}</span>
                        </div>

                      </div>
                    </div>

                  </template>

                  <!-- Row count footer -->
                  <div class="se-table-footer">
                    {{ t('admin.scanErrors.tableFooter', { shown: filteredErrors.length, total: errors.length }) }}
                    <span v-if="typeFilter"> {{ t('admin.scanErrors.filteredBy', { type: typeLabel(typeFilter) }) }}</span>
                    <a v-if="typeFilter" @click="typeFilter = null" style="margin-left:.5rem">{{ t('admin.scanErrors.clearFilter') }}</a>
                  </div>

                </div>
              </div>
            </div>
          </div>

        </template>

      </div>
    </div>`
});
// ─────────────────────────────────────────────────────────────────────────────

// ── Directory Access Test Modal ────────────────────────────────────────────
const dirAccessTestModal = Vue.component('dir-access-test-modal', {
  data() {
    return {
      loading: true,
      platform: '',
      results: []
    };
  },
  computed: {
    allGood()    { return !this.loading && this.results.length > 0 && this.results.every(r => r.readable && r.writable); },
    hasNoAccess(){ return this.results.some(r => !r.readable); },
    hasReadOnly(){ return this.results.some(r => r.readable && !r.writable); },
    adviceLevel(){
      if (this.loading || this.results.length === 0) return 'ok';
      if (this.hasNoAccess) return 'error';
      if (this.hasReadOnly) return 'warn';
      return 'ok';
    },
    adviceText() {
      if (this.loading || this.results.length === 0) return '';
      if (this.allGood) return this.t('admin.modal.dirTestAdviceAllGoodText');
      const parts = [];
      if (this.hasNoAccess)
        parts.push(this.t('admin.modal.dirTestAdviceNoAccess'));
      if (this.hasReadOnly) {
        if (this.platform === 'win32')
          parts.push(this.t('admin.modal.dirTestAdviceReadOnlyWin'));
        else
          parts.push(this.t('admin.modal.dirTestAdviceReadOnlyLinux'));
      }
      return parts.join('  ');
    },
    adviceBox() {
      const common = 'border-radius:8px;padding:.7rem 1rem;margin-top:.75rem;font-size:.88rem;line-height:1.6;';
      const level = String(this.adviceLevel);
      if (level === 'error') return common + 'background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.3);color:#f87171;';
      if (level === 'warn')  return common + 'background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.3);color:#fbbf24;';
      return common + 'background:rgba(74,222,128,.08);border:1px solid rgba(74,222,128,.3);color:#4ade80;';
    },
    adviceTitle() {
      const level = String(this.adviceLevel);
      if (level === 'error') return this.t('admin.modal.dirTestAdviceProblemTitle');
      if (level === 'warn')  return this.t('admin.modal.dirTestAdviceWarnTitle');
      return this.t('admin.modal.dirTestAdviceAllGoodTitle');
    }
  },
  template: `
    <div>
      ${mHead("{{ t('admin.modal.dirTestTitle') }}", "{{ t('admin.modal.dirTestSubtitle') }}")}
      <div class="modal-body">
        <div v-if="loading" style="display:flex;align-items:center;justify-content:center;padding:2.5rem 0;gap:1rem;color:var(--t2);">
          <svg class="spinner" width="28" height="28" viewBox="0 0 66 66"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
          {{ t('admin.modal.dirTestTesting') }}
        </div>
        <div v-else-if="results.length === 0" style="color:var(--t2);padding:.75rem 0;">{{ t('admin.modal.dirTestNoDirectories') }}</div>
        <div v-else>
          <div v-for="r in results" :key="r.vpath" style="margin-bottom:.75rem;border:1px solid var(--border);border-radius:8px;overflow:hidden;">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:.5rem .85rem;background:var(--c1b);gap:.5rem;flex-wrap:wrap;">
              <div style="min-width:0;flex:1;">
                <code style="color:var(--accent);font-size:.9rem;">{{r.vpath}}</code>
                <div style="color:var(--t3);font-size:.75rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:340px;">{{r.root}}</div>
              </div>
              <span :style="storageBadgeStyle(r.storageType)" style="font-size:.72rem;padding:.18rem .52rem;border-radius:4px;font-weight:600;letter-spacing:.03em;white-space:nowrap;flex-shrink:0;">{{storageLabel(r.storageType)}}</span>
            </div>
            <div style="display:flex;align-items:center;gap:1.5rem;padding:.5rem .85rem;flex-wrap:wrap;">
              <span :style="r.readable ? 'color:#4ade80;font-weight:700;' : 'color:#f87171;font-weight:700;'">
                {{r.readable ? '✓' : '✗'}} {{ t('admin.modal.dirTestLabelRead') }}
              </span>
              <span :style="r.writable ? 'color:#4ade80;font-weight:700;' : r.readable ? 'color:#fbbf24;font-weight:700;' : 'color:#f87171;font-weight:700;'">
                {{r.writable ? '✓' : '✗'}} {{ t('admin.modal.dirTestLabelWrite') }}
              </span>
              <span v-if="r.error" style="color:var(--t3);font-size:.75rem;font-family:monospace;">{{r.error}}</span>
            </div>
          </div>
          <div :style="adviceBox">
            <strong>{{adviceTitle}}</strong><br>
            {{adviceText}}
          </div>
        </div>
      </div>
      <div class="modal-footer-row">
        <button class="btn" type="button" @click="closeModal">{{ t('admin.modal.btnClose') }}</button>
      </div>
    </div>`,
  mounted() { this.runTest(); },
  methods: {
    async runTest() {
      this.loading = true;
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/directories/test` });
        this.platform   = res.data.platform;
        this.results    = res.data.results;
      } catch {
        iziToast.error({ title: this.t('admin.modal.dirTestFailed'), position: 'topCenter', timeout: 3500 });
        modVM.closeModal();
      } finally {
        this.loading = false;
      }
    },
    storageLabel(t) {
      const m = {
        'windows-local':   'Windows local drive',
        'windows-network': 'Windows network share',
        'linux-local':     'Linux local',
        'linux-mounted':   'Linux mounted drive',
        'mac-local':       'macOS local',
        'mac-external':    'macOS external drive'
      };
      return m[t] || t;
    },
    storageBadgeStyle(t) {
      if (t === 'windows-network' || t === 'linux-mounted' || t === 'mac-external')
        return 'background:rgba(251,191,36,.12);color:#fbbf24;border:1px solid rgba(251,191,36,.3);';
      return 'background:rgba(99,102,241,.12);color:#818cf8;border:1px solid rgba(99,102,241,.25);';
    }
  }
});

const foldersView = Vue.component('folders-view', {
  data() {
    return {
      componentKey: false, // Flip this value to force re-render
      dirName: '',
      folder: ADMINDATA.sharedSelect,
      foldersTS: ADMINDATA.foldersUpdated,
      usersTS: ADMINDATA.usersUpdated,
      folders: ADMINDATA.folders,
      users: ADMINDATA.users,
      submitPending: false,
      editingFolder: null,
      editForm: { root: '', type: 'music', users: [] }
    };
  },
  computed: {
    directories_users() {
      // Depend on usersTS.ts so Vue re-evaluates when users load
      this.usersTS.ts; // NOSONAR — reactive dependency
      // Returns { vpath: [username, ...] } — only non-admin users explicitly assigned
      const map = {};
      Object.keys(this.folders).forEach(vp => { map[vp] = []; });
      Object.entries(this.users).forEach(([uname, u]) => {
        if (u.admin) return; // admins shown separately
        (u.vpaths || []).forEach(vp => {
          if (!map[vp]) map[vp] = [];
          map[vp].push(uname);
        });
      });
      return map;
    },
    admin_users() {
      this.usersTS.ts; // NOSONAR — reactive dependency
      return Object.entries(this.users)
        .filter(([, u]) => u.admin)
        .map(([uname]) => uname);
    },
    non_admin_count() {
      this.usersTS.ts; // NOSONAR — reactive dependency
      return Object.values(this.users).filter(u => !u.admin).length;
    },
    folderStructure() {
      this.foldersTS.ts; // NOSONAR — reactive dependency

      const effective = {};
      Object.entries(this.folders).forEach(([vpath, folder]) => {
        effective[vpath] = {
          root: folder.root || '',
          type: folder.type || 'music'
        };
      });

      if (this.editingFolder && effective[this.editingFolder]) {
        effective[this.editingFolder].root = (this.editForm.root || '').trim() || effective[this.editingFolder].root;
        effective[this.editingFolder].type = this.editForm.isExcluded
          ? 'excluded'
          : (this.editForm.isAudioBooks
              ? 'audio-books'
              : ((this.editForm.isRecording || this.editForm.isYoutube) ? 'recordings' : 'music'));
      }

      const pendingPath = (this.folder.value || '').trim();
      const pendingAlias = (this.dirName || '').trim();
      if (pendingPath && pendingAlias && !effective[pendingAlias]) {
        const isExcl = document.getElementById('folder-is-excluded')?.checked === true;
        const isAB = document.getElementById('folder-is-audiobooks')?.checked === true;
        const isRec = document.getElementById('folder-is-recordings')?.checked === true;
        const isYT = document.getElementById('folder-is-youtube')?.checked === true;
        let pendingType = 'music';
        if (isExcl) pendingType = 'excluded';
        else if (isAB) pendingType = 'audio-books';
        else if (isRec || isYT) pendingType = 'recordings';
        effective[pendingAlias] = { root: pendingPath, type: pendingType, _pending: true };
      }

      return this.buildFolderStructure(effective);
    }
  },
  template: `
    <div class="container">

      <div class="card">
        <div class="card-content">
          <span class="card-title">{{ t('admin.folders.addTitle') }}</span>
          <form id="choose-directory-form" @submit.prevent="submitForm">

            <div class="input-field">
              <label for="folder-name">{{ t('admin.folders.labelPath') }}</label>
              <div style="display:flex;gap:.5rem;align-items:stretch;">
                <input
                  v-on:click="addFolderDialog()"
                  v-model="folder.value"
                  id="folder-name" required type="text"
                  :placeholder="t('admin.folders.pathPlaceholder')"
                  style="cursor:pointer;flex:1;margin-bottom:0;"
                  readonly />
                <button type="button" class="btn" @click="addFolderDialog()" style="flex-shrink:0;height:38px;align-self:center;" title="Open folder browser">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 48 48" style="vertical-align:middle;margin-right:4px;"><path fill="#FFA000" d="M38 12H22l-4-4H8c-2.2 0-4 1.8-4 4v24c0 2.2 1.8 4 4 4h31c1.7 0 3-1.3 3-3V16c0-2.2-1.8-4-4-4z"/><path fill="#FFCA28" d="M42.2 18H15.3c-1.9 0-3.6 1.4-3.9 3.3L8 40h31.7c1.9 0 3.6-1.4 3.9-3.3l2.5-14c.5-2.4-1.4-4.7-3.9-4.7z"/></svg>{{ t('admin.folders.btnBrowse') }}
                </button>
              </div>
            </div>

            <div class="input-field">
              <label for="add-directory-name">{{ t('admin.folders.labelAlias') }} <span style="color:var(--t3);font-weight:400;">{{ t('admin.folders.aliasSuffix') }}</span></label>
              <input
                pattern="[a-zA-Z0-9-]+"
                v-model="dirName"
                id="add-directory-name" required type="text"
                :placeholder="t('admin.folders.aliasPlaceholder')" />
              <small style="display:block;color:var(--t2);font-size:.82rem;margin-top:.25rem;">
                {{ t('admin.folders.aliasHint') }}
              </small>
            </div>

            <div style="display:flex;flex-direction:column;gap:.85rem;margin:.25rem 0 .5rem;">

              <label style="display:flex;align-items:flex-start;gap:.6rem;cursor:pointer;">
                <input id="folder-auto-access" type="checkbox" checked style="width:auto;margin-top:3px;flex-shrink:0;" />
                <span>
                  <span style="color:var(--t1);font-weight:600;">{{ t('admin.folders.optionAutoAccess') }}</span><br>
                  <small style="color:var(--t2);font-size:.82rem;">{{ t('admin.folders.optionAutoAccessDesc') }}</small>
                </span>
              </label>

              <label style="display:flex;align-items:flex-start;gap:.6rem;cursor:pointer;">
                <input id="folder-is-audiobooks" type="checkbox" style="width:auto;margin-top:3px;flex-shrink:0;"
                  @change="if ($event.target.checked) { document.getElementById('folder-is-excluded').checked = false; document.getElementById('folder-is-excluded').dispatchEvent(new Event('change')); }" />
                <span>
                  <span style="color:var(--t1);font-weight:600;">{{ t('admin.folders.optionAudiobooks') }}</span><br>
                  <small style="color:var(--t2);font-size:.82rem;">{{ t('admin.folders.optionAudiobooksDesc') }}</small>
                </span>
              </label>

              <label style="display:flex;align-items:flex-start;gap:.6rem;cursor:pointer;">
                <input id="folder-is-excluded" type="checkbox" style="width:auto;margin-top:3px;flex-shrink:0;"
                  @change="
                    const excl = $event.target.checked;
                    if (excl) {
                      document.getElementById('folder-auto-access').checked = false;
                      document.getElementById('folder-is-audiobooks').checked = false;
                      document.getElementById('folder-is-recordings').checked = false;
                      document.getElementById('folder-is-youtube').checked = false;
                      document.getElementById('folder-allow-record-delete').checked = false;
                      document.getElementById('folder-allow-record-delete-row').style.display = 'none';
                    }
                    ['folder-is-audiobooks','folder-is-recordings','folder-is-youtube'].forEach(id => document.getElementById(id).disabled = excl);" />
                <span>
                  <span style="color:var(--t1);font-weight:600;">{{ t('admin.folders.optionExcluded') }}</span><br>
                  <small style="color:var(--t2);font-size:.82rem;">{{ t('admin.folders.optionExcludedDesc') }}</small>
                </span>
              </label>

              <label style="display:flex;align-items:flex-start;gap:.6rem;cursor:pointer;">
                <input id="folder-is-recordings" type="checkbox" style="width:auto;margin-top:3px;flex-shrink:0;"
                  @change="
                    if ($event.target.checked) { document.getElementById('folder-is-excluded').checked = false; document.getElementById('folder-is-excluded').dispatchEvent(new Event('change')); }
                    const any = $event.target.checked || document.getElementById('folder-is-youtube').checked;
                    document.getElementById('folder-allow-record-delete-row').style.display = any ? 'flex' : 'none';
                    if (!any) document.getElementById('folder-allow-record-delete').checked = false;" />
                <span>
                  <span style="color:var(--t1);font-weight:600;">{{ t('admin.folders.optionRecordings') }}</span><br>
                  <small style="color:var(--t2);font-size:.82rem;">{{ t('admin.folders.optionRecordingsDesc') }}</small>
                </span>
              </label>

              <label style="display:flex;align-items:flex-start;gap:.6rem;cursor:pointer;">
                <input id="folder-is-youtube" type="checkbox" style="width:auto;margin-top:3px;flex-shrink:0;"
                  @change="
                    if ($event.target.checked) { document.getElementById('folder-is-excluded').checked = false; document.getElementById('folder-is-excluded').dispatchEvent(new Event('change')); }
                    const any = $event.target.checked || document.getElementById('folder-is-recordings').checked;
                    document.getElementById('folder-allow-record-delete-row').style.display = any ? 'flex' : 'none';
                    if (!any) document.getElementById('folder-allow-record-delete').checked = false;" />
                <span>
                  <span style="color:var(--t1);font-weight:600;">{{ t('admin.folders.optionYoutube') }}</span><br>
                  <small style="color:var(--t2);font-size:.82rem;">{{ t('admin.folders.optionYoutubeDesc') }}</small>
                </span>
              </label>

              <label id="folder-allow-record-delete-row" style="display:none;align-items:flex-start;gap:.6rem;cursor:pointer;">
                <input id="folder-allow-record-delete" type="checkbox" style="width:auto;margin-top:3px;flex-shrink:0;" />
                <span>
                  <span style="color:var(--t1);font-weight:600;">{{ t('admin.folders.optionAllowDelete') }}</span><br>
                  <small style="color:var(--t2);font-size:.82rem;">{{ t('admin.folders.optionAllowDeleteDesc') }}</small>
                </span>
              </label>

            </div>
          </form>
        </div>
        <div class="card-action">
          <button class="btn" type="submit" form="choose-directory-form" :disabled="submitPending === true">
            {{ submitPending ? t('admin.folders.btnAdding') : t('admin.folders.btnAdd') }}
          </button>
        </div>
      </div>

      <div class="card">
        <div class="card-content">
          <span class="card-title">{{ t('admin.folders.structureTitle') }}</span>
          <p style="margin:.25rem 0 .75rem;color:var(--t2);font-size:.9rem;">{{ t('admin.folders.structureSummary') }}</p>
          <ul style="margin:0 0 .85rem 1rem;padding:0;color:var(--t2);font-size:.86rem;line-height:1.45;">
            <li>{{ t('admin.folders.structureInfoRoot') }}</li>
            <li>{{ t('admin.folders.structureInfoChild') }}</li>
            <li>{{ t('admin.folders.structureInfoExclude') }}</li>
          </ul>

          <div v-if="folderStructure.roots.length === 0" style="color:var(--t3);font-size:.86rem;">{{ t('admin.folders.structureEmpty') }}</div>
          <div v-else style="display:flex;flex-direction:column;gap:10px;">
            <div v-for="root in folderStructure.roots" :key="'root-'+root.vpath"
                 style="border:1px solid var(--border);border-radius:10px;padding:10px;background:var(--card);">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <strong style="color:var(--t1);">📁 {{ root.root }}</strong>
                <span style="font-size:11px;padding:2px 7px;border-radius:999px;background:rgba(16,185,129,.12);color:#10b981;border:1px solid rgba(16,185,129,.3);">{{ t('admin.folders.structureBadgeRoot') }}</span>
                <span style="font-size:12px;color:var(--t3);">{{ t('admin.folders.structureScansAs', { vpath: root.vpath }) }}</span>
                <span v-if="root.pending" style="font-size:11px;padding:2px 7px;border-radius:999px;background:rgba(251,191,36,.12);color:#f59e0b;border:1px solid rgba(251,191,36,.3);">{{ t('admin.folders.structurePending') }}</span>
              </div>

              <div v-for="childVp in descendantsForRoot(root.vpath)" :key="'child-'+root.vpath+'-'+childVp"
                   style="margin-top:6px;margin-left:18px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <span style="color:var(--t3);">└──</span>
                <code style="font-size:12px;">{{ folderStructure.byVpath[childVp].root }}</code>
                <span style="font-size:11px;padding:2px 7px;border-radius:999px;background:rgba(99,102,241,.12);color:#818cf8;border:1px solid rgba(99,102,241,.3);">{{ t('admin.folders.structureBadgeChild') }}</span>
                <span style="font-size:12px;color:var(--t3);">→ {{ childVp }}</span>
                <span v-if="folderStructure.byVpath[childVp].pending" style="font-size:11px;padding:2px 7px;border-radius:999px;background:rgba(251,191,36,.12);color:#f59e0b;border:1px solid rgba(251,191,36,.3);">{{ t('admin.folders.structurePending') }}</span>
              </div>
            </div>

            <div v-for="warn in folderStructure.impliedMissingRoots" :key="'implied-'+warn.parentPath"
                 style="border:1px solid rgba(245,158,11,.35);border-radius:10px;padding:11px;background:rgba(245,158,11,.08);">
              <div style="font-weight:700;color:#f59e0b;">⚠️ {{ t('admin.folders.structureImpliedTitle', { root: warn.parentPath }) }}</div>
              <div style="margin-top:4px;color:var(--t2);font-size:.88rem;line-height:1.4;">{{ t('admin.folders.structureImpliedBody', { root: warn.parentPath }) }}</div>
              <div v-for="vp in warn.vpaths" :key="'warn-vp-'+warn.parentPath+'-'+vp" style="margin-top:4px;margin-left:18px;font-size:.85rem;color:var(--t2);">
                └── <code>{{ folderStructure.byVpath[vp].root }}</code> <span style="color:var(--t3);">[{{ t('admin.folders.structureWarnTreatAsRoot', { vpath: vp }) }}]</span>
              </div>
              <button class="btn-small" type="button" style="margin-top:8px;" @click="prefillMissingRoot(warn.parentPath)">{{ t('admin.folders.structureAddRootBtn', { root: warn.parentPath }) }}</button>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-content">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem;">
            <span class="card-title" style="margin-bottom:0;">{{ t('admin.folders.listTitle') }}</span>
            <button class="btn-small" type="button" @click="testAccess" :title="t('admin.folders.btnTestAccess')">{{ t('admin.folders.btnTestAccess') }}</button>
          </div>
          <div v-if="Object.keys(folders).length === 0" style="color:var(--t2);padding:.5rem 0;">{{ t('admin.folders.noDirectories') }}</div>
          <div v-else style="display:flex;flex-direction:column;gap:10px;">
            <div v-for="(v, k) in folders" :key="k"
                 style="border:1px solid var(--border);border-radius:var(--r);padding:14px 16px;background:var(--raised);display:flex;flex-direction:column;gap:8px;">

              <!-- Row 1: vpath + type badge + actions -->
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                <code style="font-size:1rem;color:var(--accent);font-weight:700;">{{k}}</code>
                <span :style="'display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;' +
                  (v.type === 'recordings' ? 'background:rgba(99,102,241,.15);color:#818cf8;' :
                   v.type === 'youtube'    ? 'background:rgba(220,50,50,.12);color:#e05555;' :
                   v.type === 'audio-books'? 'background:rgba(245,158,11,.12);color:#f59e0b;' :
                   v.type === 'excluded'   ? 'background:rgba(156,163,175,.12);color:#9ca3af;' :
                                            'background:rgba(16,185,129,.12);color:#10b981;')">
                  {{ v.type === 'recordings' ? t('admin.folders.typeRadioRecordings') :
                     v.type === 'youtube'    ? t('admin.folders.typeYoutubeDownloads') :
                     v.type === 'audio-books'? t('admin.folders.typeAudiobooks') :
                     v.type === 'excluded'   ? t('admin.folders.typeExcluded') : t('admin.folders.typeMusic') }}
                </span>
                <div style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;">
                  <button class="btn-small" type="button" @click="toggleEditFolder(k)">
                    {{ editingFolder === k ? t('admin.folders.btnCancelEdit') : t('admin.folders.btnEdit') }}
                  </button>
                  <button v-if="v.type === 'recordings' || v.type === 'youtube'" class="btn-small" type="button"
                    :style="v.allowRecordDelete ? 'background:var(--primary);color:#fff;' : ''"
                    :title="v.allowRecordDelete ? t('admin.folders.btnDeleteOn') : t('admin.folders.btnDeleteOff')"
                    @click="toggleRecordDelete(k)">
                    {{v.allowRecordDelete ? t('admin.folders.btnDeleteOn') : t('admin.folders.btnDeleteOff')}}
                  </button>
                  <button v-if="v.type !== 'recordings' && v.type !== 'youtube' && v.type !== 'excluded'" class="btn-small" type="button"
                    :style="v.albumsOnly ? 'background:var(--primary);color:#fff;' : ''"
                    :title="v.albumsOnly ? t('admin.folders.btnAlbumsOnlyOn') : t('admin.folders.btnAlbumsOnlyOff')"
                    @click="toggleAlbumsOnly(k)">
                    {{v.albumsOnly ? t('admin.folders.btnAlbumsOnlyOn') : t('admin.folders.btnAlbumsOnlyOff')}}
                  </button>
                  <button v-if="v.type !== 'recordings' && v.type !== 'youtube' && v.type !== 'excluded'" class="btn-small" type="button"
                    :style="v.dlnaEnabled ? 'background:var(--primary);color:#fff;' : ''"
                    :title="v.dlnaEnabled ? t('admin.folders.btnDlnaOn') : t('admin.folders.btnDlnaOff')"
                    @click="toggleDlnaEnabled(k)">
                    {{v.dlnaEnabled ? t('admin.folders.btnDlnaOn') : t('admin.folders.btnDlnaOff')}}
                  </button>
                  <button v-if="v.type !== 'excluded'" class="btn-small" type="button"
                    :style="v.artistsOn !== false ? 'background:var(--primary);color:#fff;' : ''"
                    :title="v.artistsOn !== false ? t('admin.folders.btnArtistsOn') : t('admin.folders.btnArtistsOff')"
                    @click="toggleArtistsOn(k)">
                    {{v.artistsOn !== false ? t('admin.folders.btnArtistsOn') : t('admin.folders.btnArtistsOff')}}
                  </button>
                  <button class="btn-small red" type="button" @click="removeFolder(k, v.root)">{{ t('admin.folders.btnRemove') }}</button>
                </div>
              </div>

              <!-- Row 2: directory path -->
              <div style="display:flex;align-items:baseline;gap:8px;">
                <span style="font-size:11px;color:var(--t3);flex-shrink:0;min-width:60px;">{{ t('admin.folders.labelPathRow') }}</span>
                <div style="display:flex;flex-direction:column;gap:3px;min-width:0;">
                  <span style="font-size:12px;color:var(--t2);word-break:break-all;font-family:monospace;">{{v.root}}</span>
                  <small v-if="v.type !== 'excluded'" style="color:var(--t3);font-size:.76rem;line-height:1.35;">
                    {{ t('admin.folders.artistsHint') }}
                  </small>
                </div>
              </div>

              <!-- Row 3: user access -->
              <div style="display:flex;align-items:flex-start;gap:8px;">
                <span style="font-size:11px;color:var(--t3);flex-shrink:0;min-width:60px;padding-top:2px;">{{ t('admin.folders.labelAccessRow') }}</span>
                <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;">
                  <span v-for="uname in admin_users" :key="'admin-'+uname"
                        title="Admin — always has full access to all folders"
                        style="display:inline-block;padding:1px 7px;border-radius:8px;font-size:11px;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.3);color:#f59e0b;font-weight:600;">
                    ★ {{uname}}
                  </span>
                  <span v-if="(directories_users[k] || []).length >= non_admin_count && non_admin_count > 0"
                        style="display:inline-block;padding:1px 7px;border-radius:8px;font-size:11px;background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);color:#10b981;font-weight:600;">{{ t('admin.folders.allUsers') }}</span>
                  <template v-else-if="(directories_users[k] || []).length > 0">
                    <span v-for="uname in (directories_users[k] || [])" :key="uname"
                          style="display:inline-block;padding:1px 7px;border-radius:8px;font-size:11px;background:var(--card);border:1px solid var(--border);color:var(--t2);">
                      {{uname}}
                    </span>
                  </template>
                  <span v-else-if="non_admin_count > 0"
                        style="font-size:12px;color:var(--t3);">{{ t('admin.folders.noUsersAssigned') }}</span>
                </div>
              </div>

              <!-- Edit panel (inline, expands when Edit is clicked) -->
              <div v-if="editingFolder === k"
                   style="margin-top:6px;padding:14px;border-radius:var(--r);background:var(--card);border:1px solid var(--border);display:flex;flex-direction:column;gap:12px;">

                <!-- Path -->
                <div>
                  <label style="font-size:12px;font-weight:600;color:var(--t2);display:block;margin-bottom:4px;">{{ t('admin.folders.editLabelPath') }}</label>
                  <div style="display:flex;gap:6px;">
                    <input v-model="editForm.root" type="text" class="settings-select" style="flex:1;font-family:monospace;font-size:.82rem;" />
                    <button class="btn-small" type="button" @click="pickEditFolder(k)" title="Browse">…</button>
                  </div>
                  <small style="color:var(--t3);font-size:.78rem;">{{ t('admin.folders.editPathHint') }}</small>
                </div>

                <!-- Type (checkboxes for radio/youtube, like add form) -->
                <div>
                  <label style="font-size:12px;font-weight:600;color:var(--t2);display:block;margin-bottom:6px;">{{ t('admin.folders.editLabelType') }}</label>
                  <div style="display:flex;flex-wrap:wrap;gap:18px;align-items:center;">
                    <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:13px;color:var(--t1);">
                      <input type="checkbox" v-model="editForm.isRecording" style="width:auto;" :disabled="editForm.isExcluded"
                        @change="if (editForm.isRecording) editForm.isExcluded = false;" />
                      {{ t('admin.folders.typeRadioRecordings') }}
                    </label>
                    <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:13px;color:var(--t1);">
                      <input type="checkbox" v-model="editForm.isYoutube" style="width:auto;" :disabled="editForm.isExcluded"
                        @change="if (editForm.isYoutube) editForm.isExcluded = false;" />
                      {{ t('admin.folders.typeYoutubeDownloads') }}
                    </label>
                    <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:13px;color:var(--t1);">
                      <input type="checkbox" v-model="editForm.isAudioBooks" style="width:auto;" :disabled="editForm.isExcluded"
                        @change="if (editForm.isAudioBooks) editForm.isExcluded = false;" />
                      {{ t('admin.folders.typeAudiobooks') }}
                    </label>
                    <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:13px;color:var(--t1);">
                      <input type="checkbox" v-model="editForm.isExcluded" style="width:auto;"
                        @change="if (editForm.isExcluded) { editForm.isRecording=false; editForm.isYoutube=false; editForm.isAudioBooks=false; }" />
                      {{ t('admin.folders.typeExcluded') }}
                    </label>
                  </div>
                  <small style="color:var(--t3);font-size:.78rem;">{{ t('admin.folders.editTypeCombinedHint') }}</small>
                </div>

                <!-- User access (non-admin users only) -->
                <div v-if="non_admin_count > 0">
                  <label style="font-size:12px;font-weight:600;color:var(--t2);display:block;margin-bottom:6px;">{{ t('admin.folders.editLabelUsers') }}</label>
                  <div style="display:flex;flex-wrap:wrap;gap:8px;">
                    <label v-for="(u, uname) in users" :key="uname" v-if="!u.admin"
                           style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:13px;color:var(--t1);">
                      <input type="checkbox" :value="uname" v-model="editForm.users" style="width:auto;" />
                      {{uname}}
                    </label>
                  </div>
                </div>

                <!-- Save -->
                <div style="display:flex;gap:8px;justify-content:flex-end;">
                  <button class="btn-small" type="button" @click="editingFolder = null">{{ t('admin.folders.editBtnCancel') }}</button>
                  <button class="btn-small btn-primary" type="button" @click="saveEditFolder(k)">{{ t('admin.folders.editBtnSave') }}</button>
                </div>
              </div>

            </div>
          </div>
        </div>
      </div>

    </div>`,
    created: function() {
      ADMINDATA.sharedSelect.value = '';
    },
    watch: {
      'folder.value': function (newVal, oldVal) {
        this.makeVPath(newVal);
      }
    },
    methods: {
      _normRoot(root) {
        return String(root || '').replace(/\\+/g, '/').replace(/\/+$/, '');
      },
      _parentPath(root) {
        const r = this._normRoot(root);
        if (!r || r === '/') return '';
        const i = r.lastIndexOf('/');
        if (i <= 0) return '/';
        return r.slice(0, i);
      },
      buildFolderStructure(foldersObj) {
        const nodes = Object.entries(foldersObj).map(([vpath, f]) => ({
          vpath,
          root: this._normRoot(f.root),
          type: f.type || 'music',
          pending: f._pending === true,
          parent: null,
          children: []
        })).filter(n => n.root);

        for (const node of nodes) {
          let parent = null;
          let bestLen = -1;
          const me = node.root + '/';
          for (const other of nodes) {
            if (other.vpath === node.vpath) continue;
            const o = other.root + '/';
            if (!me.startsWith(o) || me === o) continue;
            if (o.length > bestLen) {
              parent = other.vpath;
              bestLen = o.length;
            }
          }
          node.parent = parent;
        }

        const byVpath = {};
        nodes.forEach(n => { byVpath[n.vpath] = n; });
        nodes.forEach(n => {
          if (n.parent && byVpath[n.parent]) byVpath[n.parent].children.push(n.vpath);
        });

        const roots = nodes.filter(n => !n.parent);
        const configuredRoots = new Set(nodes.map(n => n.root));

        const rootsByParentPath = {};
        roots.forEach(r => {
          const p = this._parentPath(r.root);
          if (!p) return;
          if (!rootsByParentPath[p]) rootsByParentPath[p] = [];
          rootsByParentPath[p].push(r.vpath);
        });

        const impliedMissingRoots = Object.entries(rootsByParentPath)
          .filter(([parentPath, vpaths]) => vpaths.length > 1 && !configuredRoots.has(parentPath))
          .map(([parentPath, vpaths]) => ({
            parentPath,
            vpaths
          }));

        return { roots, byVpath, impliedMissingRoots };
      },
      descendantsForRoot(rootVpath) {
        const out = [];
        const walk = (vp) => {
          const node = this.folderStructure.byVpath[vp];
          if (!node) return;
          (node.children || []).forEach(child => {
            out.push(child);
            walk(child);
          });
        };
        walk(rootVpath);
        return out;
      },
      prefillMissingRoot(parentPath) {
        if (!parentPath) return;
        this.folder.value = parentPath;
        this.makeVPath(parentPath);
      },
      makeVPath(dir) {
        const newName = dir.split(/[\\/]/).pop().toLowerCase().replaceAll(' ', '-').replaceAll(/[^a-zA-Z0-9-]/g, "");
        
        // Note: vpath uniqueness validation handled server-side

        this.dirName = newName;
        this.$nextTick(() => {
        });
      },
      maybeResetForm: function() {
        if (this.dirName === '' && this.folder.value === '') {
          document.getElementById("choose-directory-form").reset();
        }
      },
      addFolderDialog: function (event) {
        modVM.currentViewModal = 'file-explorer-modal';
        modVM.openModal();
      },
      submitForm: async function () {
        if (ADMINDATA.folders[this.dirName]) {
          iziToast.warn({
            title: this.t('admin.folders.toastAlreadyInUse'),
            position: 'topCenter',
            timeout: 3500
          });
          return;
        }

        try {
          this.submitPending = true;

          await API.axios({
            method: 'PUT',
            url: `${API.url()}/api/v1/admin/directory`,
            data: {
              directory: this.folder.value,
              vpath: this.dirName,
              autoAccess: document.getElementById('folder-auto-access').checked,
              isAudioBooks: document.getElementById('folder-is-audiobooks').checked,
              isRecording: document.getElementById('folder-is-recordings').checked,
              isYoutube: document.getElementById('folder-is-youtube').checked,
              allowRecordDelete: document.getElementById('folder-allow-record-delete').checked,
              isExcluded: document.getElementById('folder-is-excluded').checked
            }
          });

          if (document.getElementById('folder-auto-access').checked) {
            Object.values(ADMINDATA.users).forEach(user => {
              user.vpaths.push(this.dirName);
            });
          }

          const isExcl = document.getElementById('folder-is-excluded').checked;
          const isAB   = document.getElementById('folder-is-audiobooks').checked;
          const isRec  = document.getElementById('folder-is-recordings').checked;
          const isYT   = document.getElementById('folder-is-youtube').checked;
          const isARD  = document.getElementById('folder-allow-record-delete').checked;
          let addedType = 'music';
          if (isExcl) addedType = 'excluded';
          else if (isAB) addedType = 'audio-books';
          else if (isRec && isYT) addedType = 'recordings';
          else if (isYT) addedType = 'youtube';
          else if (isRec) addedType = 'recordings';
          const addedFolder = { root: this.folder.value, type: addedType, artistsOn: true };
          if ((isRec || isYT) && isARD) addedFolder.allowRecordDelete = true;
          Vue.set(ADMINDATA.folders, this.dirName, addedFolder);
          this.dirName = '';
          this.folder.value = '';
          this.$nextTick(() => {
          });
        }catch {
          iziToast.error({
            title: this.t('admin.folders.toastFailedAdd'),
            position: 'topCenter',
            timeout: 3500
          });
        } finally {
          this.submitPending = false;
        }
      },
      testAccess: function() {
        modVM.currentViewModal = 'dir-access-test-modal';
        modVM.openModal();
      },
      toggleRecordDelete: async function(vpath) {
        const folder = ADMINDATA.folders[vpath];
        const newVal = !folder.allowRecordDelete;
        try {
          await API.axios({
            method: 'PATCH',
            url: `${API.url()}/api/v1/admin/directory/flags`,
            data: { vpath, allowRecordDelete: newVal }
          });
          Vue.set(ADMINDATA.folders[vpath], 'allowRecordDelete', newVal);
          iziToast.success({
            title: newVal ? this.t('admin.folders.toastDeleteEnabled') : this.t('admin.folders.toastDeleteDisabled'),
            position: 'topCenter', timeout: 3000
          });
        } catch {
          iziToast.error({ title: this.t('admin.folders.toastFailedUpdate'), position: 'topCenter', timeout: 3000 });
        }
      },
      toggleAlbumsOnly: async function(vpath) {
        const folder = ADMINDATA.folders[vpath];
        const newVal = !folder.albumsOnly;
        try {
          await API.axios({
            method: 'PATCH',
            url: `${API.url()}/api/v1/admin/directory/flags`,
            data: { vpath, albumsOnly: newVal }
          });
          Vue.set(ADMINDATA.folders[vpath], 'albumsOnly', newVal);
          iziToast.success({
            title: newVal ? this.t('admin.folders.toastAlbumsOnlyEnabled') : this.t('admin.folders.toastAlbumsOnlyDisabled'),
            position: 'topCenter', timeout: 3000
          });
        } catch {
          iziToast.error({ title: this.t('admin.folders.toastFailedUpdate'), position: 'topCenter', timeout: 3000 });
        }
      },
      toggleDlnaEnabled: async function(vpath) {
        const folder = ADMINDATA.folders[vpath];
        const newVal = !folder.dlnaEnabled;
        try {
          await API.axios({
            method: 'PATCH',
            url: `${API.url()}/api/v1/admin/directory/flags`,
            data: { vpath, dlnaEnabled: newVal }
          });
          Vue.set(ADMINDATA.folders[vpath], 'dlnaEnabled', newVal);
          iziToast.success({
            title: newVal ? this.t('admin.folders.toastDlnaEnabled') : this.t('admin.folders.toastDlnaDisabled'),
            position: 'topCenter', timeout: 3000
          });
        } catch {
          iziToast.error({ title: this.t('admin.folders.toastFailedUpdate'), position: 'topCenter', timeout: 3000 });
        }
      },
      toggleArtistsOn: async function(vpath) {
        const folder = ADMINDATA.folders[vpath];
        const newVal = folder.artistsOn === false;
        Vue.set(ADMINDATA.folders[vpath], 'artistsOn', newVal);
        try {
          await API.axios({
            method: 'PATCH',
            url: `${API.url()}/api/v1/admin/directory/flags`,
            data: { vpath, artistsOn: newVal }
          });
          iziToast.success({
            title: newVal ? this.t('admin.folders.toastArtistsEnabled') : this.t('admin.folders.toastArtistsDisabled'),
            message: this.t('admin.folders.toastArtistsRebuild'),
            position: 'topCenter', timeout: 3500
          });
        } catch {
          Vue.set(ADMINDATA.folders[vpath], 'artistsOn', !newVal);
          iziToast.error({ title: this.t('admin.folders.toastFailedUpdate'), position: 'topCenter', timeout: 3000 });
        }
      },
      toggleEditFolder: function(vpath) {
        if (this.editingFolder === vpath) {
          this.editingFolder = null;
          return;
        }
        const folder = ADMINDATA.folders[vpath];
        const currentUsers = (this.directories_users[vpath] || []).slice();
        this.editForm = {
          root: folder.root || '',
          isRecording: folder.type === 'recordings' || (folder.type === 'youtube' && folder.allowRecordDelete),
          isYoutube: folder.type === 'youtube' || (folder.type === 'recordings' && folder.allowRecordDelete),
          isAudioBooks: folder.type === 'audio-books',
          isExcluded: folder.type === 'excluded',
          users: currentUsers
        };
        this.editingFolder = vpath;
      },
      pickEditFolder: function() {
        modVM.currentViewModal = 'file-explorer-modal';
        ADMINDATA.sharedSelect._editTarget = 'editForm';
        ADMINDATA.sharedSelect._editRef = this;
        modVM.openModal();
      },
      saveEditFolder: async function(vpath) {
        const folder = ADMINDATA.folders[vpath];
        const errors = [];

        // 1. Save type if changed (checkbox logic)
        let newType = 'music';
        if (this.editForm.isExcluded) {
          newType = 'excluded';
        } else if (this.editForm.isAudioBooks) {
          newType = 'audio-books';
        } else if (this.editForm.isRecording && this.editForm.isYoutube) {
          newType = 'recordings';
        } else if (this.editForm.isYoutube) {
          newType = 'youtube';
        } else if (this.editForm.isRecording) {
          newType = 'recordings';
        }
        if (newType !== (folder.type || 'music')) {
          try {
            await API.axios({
              method: 'PATCH',
              url: `${API.url()}/api/v1/admin/directory/type`,
              data: { vpath, type: newType }
            });
            Vue.set(ADMINDATA.folders[vpath], 'type', newType);
            // Clear flags incompatible with new type
            const isRecordLike = newType === 'recordings' || newType === 'youtube';
            if (!isRecordLike) Vue.delete(ADMINDATA.folders[vpath], 'allowRecordDelete');
            if (isRecordLike || newType === 'excluded') Vue.delete(ADMINDATA.folders[vpath], 'albumsOnly');
          } catch {
            errors.push('type');
          }
        }

        // 2. Save path if changed
        if (this.editForm.root.trim() && this.editForm.root.trim() !== folder.root) {
          try {
            await API.axios({
              method: 'PATCH',
              url: `${API.url()}/api/v1/admin/directory/root`,
              data: { vpath, root: this.editForm.root.trim() }
            });
            Vue.set(ADMINDATA.folders[vpath], 'root', this.editForm.root.trim());
            iziToast.warning({
              title: this.t('admin.folders.toastPathChanged'),
              position: 'topCenter', timeout: 5000
            });
          } catch (err) {
            errors.push('path');
            iziToast.error({
              title: this.t('admin.folders.toastInvalidPath', { error: err?.response?.data?.error || 'not a valid directory' }),
              position: 'topCenter', timeout: 4000
            });
          }
        }

        // 3. Save user access if changed
        const prevUsers = (this.directories_users[vpath] || []).slice().sort().join(',');
        const nextUsers = this.editForm.users.slice().sort().join(',');
        if (prevUsers !== nextUsers) {
          try {
            await API.axios({
              method: 'PATCH',
              url: `${API.url()}/api/v1/admin/directory/users`,
              data: { vpath, users: this.editForm.users }
            });
            // Update in-memory user vpaths so directories_users recomputes
            Object.entries(ADMINDATA.users).forEach(([uname, u]) => {
              if (u.admin) return;
              const hasAccess = this.editForm.users.includes(uname);
              const vpaths = (u.vpaths || []).filter(vp => vp !== vpath);
              if (hasAccess) vpaths.push(vpath);
              Vue.set(ADMINDATA.users[uname], 'vpaths', vpaths);
            });
            ADMINDATA.usersUpdated.ts = Date.now();
          } catch {
            errors.push('users');
          }
        }

        if (errors.length === 0) {
          iziToast.success({ title: this.t('admin.folders.toastFolderUpdated'), position: 'topCenter', timeout: 2500 });
          this.editingFolder = null;
        } else if (errors.length < 3) {
          iziToast.warning({ title: this.t('admin.folders.toastSomeChangesFailed', { fields: errors.join(', ') }), position: 'topCenter', timeout: 4000 });
        }
      },
      removeFolder: async function(vpath, folder) {
                adminConfirm(this.t('admin.folders.confirmRemoveTitle', { folder: folder }), this.t('admin.folders.confirmRemoveMsg'), this.t('admin.folders.confirmRemoveLabel'), () => {
          API.axios({
                          method: 'DELETE',
                          url: `${API.url()}/api/v1/admin/directory`,
                          data: { vpath: vpath }
                        }).then(() => {
                          iziToast.warning({
                            title: this.t('admin.folders.toastServerRebooting'),
                            position: 'topCenter',
                            timeout: 3500
                          });
                          Vue.delete(ADMINDATA.folders, vpath);
                          Object.values(ADMINDATA.users).forEach(user => {
                            if (user.vpaths.includes(vpath)) {
                              user.vpaths.splice(user.vpaths.indexOf(vpath), 1);
                            }
                          });
                        }).catch(() => {
                          iziToast.error({
                            title: this.t('admin.folders.toastFailedRemove'),
                            position: 'topCenter',
                            timeout: 3500
                          });
                        });
        });
      }
    }
});

const usersView = Vue.component('users-view', {
  data() {
    return {
      directories: ADMINDATA.folders,
      users: ADMINDATA.users,
      usersTS: ADMINDATA.usersUpdated,
      newUsername: '',
      newPassword: '',
      showNewPassword: false,
      newUserDirs: [],
      makeAdmin: Object.keys(ADMINDATA.users).length === 0,
      submitPending: false,
      selectInstance: null
    };
  },
  template: `
    <div class="container">

      <div class="card">
        <div class="card-content">
          <span class="card-title">{{ t('admin.users.addTitle') }}</span>
          <p style="color:var(--t2);font-size:.88rem;margin:.25rem 0 1rem;">{{ t('admin.users.addDesc') }}</p>
          <form id="add-user-form" @submit.prevent="addUser" autocomplete="off">

            <div style="display:flex;gap:.75rem;flex-wrap:wrap;">
              <div class="input-field" style="flex:1;min-width:160px;">
                <label for="new-username">{{ t('admin.users.labelUsername') }}</label>
                <input v-model="newUsername" id="new-username" required type="text" :placeholder="t('admin.users.usernamePlaceholder')" autocomplete="off">
              </div>
              <div class="input-field" style="flex:1;min-width:160px;">
                <label for="new-password">{{ t('admin.users.labelPassword') }}</label>
                <div class="pwd-wrap">
                  <input v-model="newPassword" id="new-password" required :type="showNewPassword ? 'text' : 'password'" placeholder="•••••••" autocomplete="new-password">
                  <button type="button" class="pwd-toggle" @click="showNewPassword = !showNewPassword" tabindex="-1" :title="showNewPassword ? t('admin.users.btnHidePassword') : t('admin.users.btnShowPassword')">
                    <svg v-if="!showNewPassword" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                  </button>
                </div>
              </div>
            </div>

            <div class="input-field">
              <label for="new-user-dirs">{{ t('admin.users.labelFolderAccess') }} <span style="color:var(--red);font-size:.8rem;">*</span></label>
              <select id="new-user-dirs" :disabled="Object.keys(directories).length === 0" multiple :size="Math.max(2, Object.keys(directories).length)" v-model="newUserDirs">
                <option disabled value="" v-if="Object.keys(directories).length === 0">{{ t('admin.users.noDirectoriesToSelect') }}</option>
                <option v-for="(val, key) in directories" :key="key" :value="key">{{ key }}</option>
              </select>
              <small style="display:block;color:var(--t2);font-size:.82rem;margin-top:.25rem;" v-if="Object.keys(directories).length > 0">{{ t('admin.users.folderSelectHint') }}</small>
              <small style="display:block;color:var(--t2);font-size:.82rem;margin-top:.25rem;" v-else>{{ t('admin.users.addMusicFirst') }}</small>
            </div>

            <label style="display:flex;align-items:center;gap:.6rem;cursor:pointer;margin:.25rem 0 .5rem;">
              <input id="make-admin-cb" type="checkbox" v-model="makeAdmin" style="width:auto;margin:0;flex-shrink:0;">
              <span><span style="color:var(--t1);font-weight:600;">{{ t('admin.users.grantAdmin') }}</span><br><small style="color:var(--t2);font-size:.82rem;">{{ t('admin.users.grantAdminDesc') }}</small></span>
            </label>

          </form>
        </div>
        <div class="card-action">
          <button class="btn" type="submit" form="add-user-form" :disabled="submitPending === true">
            {{submitPending === false ? t('admin.users.btnAdd') : t('admin.users.btnAdding')}}
          </button>
        </div>
      </div>

      <div v-if="usersTS.ts === 0" style="display:flex;justify-content:center;padding:2rem;">
        <svg class="spinner" width="48" height="48" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
      </div>

      <div v-else class="card">
        <div class="card-content">
          <span class="card-title">{{ t('admin.users.listTitle') }}</span>
          <p v-if="Object.keys(users).length === 0" style="color:var(--t2);margin:.5rem 0 0;">{{ t('admin.users.noUsersYet') }}</p>
          <div v-if="Object.keys(users).length === 0" style="margin-top:.85rem;padding:.65rem .85rem;border-radius:6px;background:var(--raised);border:1px solid var(--border);font-size:.85rem;color:var(--t2);line-height:1.5;">
            {{ t('admin.users.noUsersSubsonicTitle') }}<br>
            {{ t('admin.users.noUsersSubsonicDesc') }}<br>
            {{ t('admin.users.noUsersSubsonicUser') }}
          </div>
          <table v-else>
            <thead>
              <tr>
                <th style="width:140px;">{{ t('admin.users.colUsername') }}</th>
                <th>{{ t('admin.users.colFolders') }}</th>
                <th style="width:70px;">{{ t('admin.users.colRole') }}</th>
                <th style="width:130px;">{{ t('admin.users.colPermissions') }}</th>
                <th style="text-align:right;white-space:nowrap;">{{ t('admin.users.colActions') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(v, k) in users">
                <td style="font-weight:600;color:var(--t1);">{{k}}</td>
                <td><span style="color:var(--t2);font-size:.85rem;">{{v.vpaths.join(', ') || '&mdash;'}}</span></td>
                <td>
                  <span v-if="v.admin === true" style="background:rgba(139,92,246,.15);color:var(--primary);font-size:.75rem;font-weight:700;padding:.15rem .45rem;border-radius:4px;">{{ t('admin.users.roleAdmin') }}</span>
                  <span v-else style="background:var(--raised);color:var(--t2);font-size:.75rem;padding:.15rem .45rem;border-radius:4px;">{{ t('admin.users.roleUser') }}</span>
                </td>
                <td>
                  <div style="display:flex;flex-direction:column;gap:.3rem;min-width:110px;">
                    <button type="button" class="btn-small btn-flat"
                      :title="v['allow-radio-recording'] ? t('admin.users.tooltipDisableRecord') : t('admin.users.tooltipEnableRecord')"
                      :style="v['allow-radio-recording'] ? 'background:rgba(40,167,69,.12);color:#28a745;border-color:rgba(40,167,69,.35);' : 'background:rgba(220,50,50,.12);color:#e05555;border-color:rgba(220,50,50,.35);'"
                      style="display:flex;align-items:center;width:100%;gap:0;font-weight:600;"
                      @click="toggleRadioRecording(k, v)">
                      <span style="display:inline-block;width:18px;text-align:center;flex-shrink:0;">&#9679;</span>
                      <span style="flex:1;text-align:left;">{{ t('admin.users.permRecord') }}</span>
                      <span style="font-size:.68rem;opacity:.6;font-weight:400;margin-left:4px;">{{v['allow-radio-recording'] ? 'ON' : 'off'}}</span>
                    </button>
                    <button type="button" class="btn-small btn-flat"
                      :title="v['allow-youtube-download'] ? t('admin.users.tooltipDisableYoutube') : t('admin.users.tooltipEnableYoutube')"
                      :style="v['allow-youtube-download'] ? 'background:rgba(40,167,69,.12);color:#28a745;border-color:rgba(40,167,69,.35);' : 'background:rgba(220,50,50,.12);color:#e05555;border-color:rgba(220,50,50,.35);'"
                      style="display:flex;align-items:center;width:100%;gap:0;font-weight:600;"
                      @click="toggleYoutubeDownload(k, v)">
                      <span style="display:inline-block;width:18px;text-align:center;flex-shrink:0;">&#9654;</span>
                      <span style="flex:1;text-align:left;">{{ t('admin.users.permYoutube') }}</span>
                      <span style="font-size:.68rem;opacity:.6;font-weight:400;margin-left:4px;">{{v['allow-youtube-download'] ? 'ON' : 'off'}}</span>
                    </button>
                    <button type="button" class="btn-small btn-flat"
                      :title="v['allow-upload'] !== false ? t('admin.users.tooltipDisableUpload') : t('admin.users.tooltipEnableUpload')"
                      :style="v['allow-upload'] === false ? 'background:rgba(220,50,50,.12);color:#e05555;border-color:rgba(220,50,50,.35);' : 'background:rgba(40,167,69,.12);color:#28a745;border-color:rgba(40,167,69,.35);'"
                      style="display:flex;align-items:center;width:100%;gap:0;font-weight:600;"
                      @click="toggleUpload(k, v)">
                      <span style="display:inline-block;width:18px;text-align:center;flex-shrink:0;"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path d="m3.75 2.75h8.5m-8.5 6.5 4-3.5 4 3.5m-4 5v-8.5"/></svg></span>
                      <span style="flex:1;text-align:left;">{{ t('admin.users.permUpload') }}</span>
                      <span style="font-size:.68rem;opacity:.6;font-weight:400;margin-left:4px;">{{v['allow-upload'] === false ? 'off' : 'ON'}}</span>
                    </button>
                    <template v-if="mpvConfigured">
                      <button type="button" class="btn-small btn-flat"
                        :title="v['allow-server-remote'] ? t('admin.users.tooltipDisableRemote') : t('admin.users.tooltipEnableRemote')"
                        :style="v['allow-server-remote'] ? 'background:rgba(40,167,69,.12);color:#28a745;border-color:rgba(40,167,69,.35);' : 'background:rgba(220,50,50,.12);color:#e05555;border-color:rgba(220,50,50,.35);'"
                        style="display:flex;align-items:center;width:100%;gap:0;font-weight:600;"
                        @click="toggleServerRemote(k, v)">
                        <span style="display:inline-block;width:18px;text-align:center;flex-shrink:0;"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><rect x="2" y="3" width="12" height="8" rx="1.5"/><path d="M5.5 13.5h5M8 11.5v2"/></svg></span>
                        <span style="flex:1;text-align:left;">{{ t('admin.users.permRemote') }}</span>
                        <span style="font-size:.68rem;opacity:.6;font-weight:400;margin-left:4px;">{{v['allow-server-remote'] ? 'ON' : 'off'}}</span>
                      </button>
                      <button type="button" class="btn-small btn-flat"
                        :title="v['allow-mpv-cast'] ? t('admin.users.tooltipDisableCast') : t('admin.users.tooltipEnableCast')"
                        :style="v['allow-mpv-cast'] ? 'background:rgba(40,167,69,.12);color:#28a745;border-color:rgba(40,167,69,.35);' : 'background:rgba(220,50,50,.12);color:#e05555;border-color:rgba(220,50,50,.35);'"
                        style="display:flex;align-items:center;width:100%;gap:0;font-weight:600;"
                        @click="toggleMpvCastPerm(k, v)">
                        <span style="display:inline-block;width:18px;text-align:center;flex-shrink:0;"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path d="M2 10.5a8 8 0 0 1 12 0M4.5 12.5a5 5 0 0 1 7 0M8 14.5v.01"/></svg></span>
                        <span style="flex:1;text-align:left;">{{ t('admin.users.permCast') }}</span>
                        <span style="font-size:.68rem;opacity:.6;font-weight:400;margin-left:4px;">{{v['allow-mpv-cast'] ? 'ON' : 'off'}}</span>
                      </button>
                    </template>
                  </div>
                </td>
                <td>
                  <div style="display:flex;gap:.4rem;justify-content:flex-end;flex-wrap:wrap;">
                    <button class="btn-small btn-flat" type="button" @click="changePassword(k)">{{ t('admin.users.btnPassword') }}</button>
                    <button class="btn-small btn-flat" type="button" @click="changeVPaths(k)">{{ t('admin.users.btnFolders') }}</button>
                    <button class="btn-small btn-flat" type="button" @click="changeAccess(k)">{{ t('admin.users.btnAccess') }}</button>
                    <button class="btn-small" type="button" style="background:var(--red);border-color:var(--red);" @click="deleteUser(k)">{{ t('admin.users.btnDelete') }}</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

    </div>`,
    mounted: function () {
    },
    beforeDestroy: function() {
    },
    computed: {
      mpvConfigured() {
        // Buttons only appear when server-audio is configured (even if currently stopped)
        return ADMINDATA.serverAudioParams.enabled === true;
      }
    },
    methods: {
      changeVPaths: function(username) {
        ADMINDATA.selectedUser.value = username;
        modVM.currentViewModal = 'user-vpaths-modal';
        modVM.openModal();
      },
      changeAccess: function(username) {
        ADMINDATA.selectedUser.value = username;
        modVM.currentViewModal = 'user-access-modal';
        modVM.openModal();
      },
      changePassword: function(username) {
        ADMINDATA.selectedUser.value = username;
        modVM.currentViewModal = 'user-password-modal';
        modVM.openModal();
      },
      deleteUser: function (username) {
                adminConfirm(this.t('admin.users.confirmDeleteTitle', { username }), '', this.t('admin.users.confirmDeleteLabel'), async () => {
          try {
                          await API.axios({
                            method: 'DELETE',
                            url: `${API.url()}/api/v1/admin/users`,
                            data: { username: username }
                          });
                          Vue.delete(ADMINDATA.users, username);
                        } catch {
                          iziToast.error({
                            title: this.t('admin.users.toastFailedUpdate'),
                            position: 'topCenter',
                            timeout: 3500
                          });
                        }
        });
      },
      addUser: async function (event) {
        try {
          this.submitPending = true;

          if (this.newUserDirs.length === 0) {
            iziToast.warning({
              title: this.t('admin.users.toastNoFolder'),
              message: this.t('admin.users.toastNoFolderMsg'),
              position: 'topCenter',
              timeout: 4000
            });
            this.submitPending = false;
            return;
          }

          const data = {
            username: this.newUsername,
            password: this.newPassword,
            vpaths: this.newUserDirs,
            admin: this.makeAdmin
          };

          await API.axios({
            method: 'PUT',
            url: `${API.url()}/api/v1/admin/users`,
            data: data
          });

          Vue.set(ADMINDATA.users, this.newUsername, { vpaths: data.vpaths, admin: data.admin });

          const isFirstUser = Object.keys(ADMINDATA.users).length === 1;

          this.newUsername = '';
          this.newPassword = '';
          this.showNewPassword = false;
          this.makeAdmin = false;
          this.newUserDirs = [];

          iziToast.success({ title: this.t('admin.users.toastUserAdded'), position: 'topCenter', timeout: 3000 });

          if (isFirstUser) {
            adminConfirm(this.t('admin.users.firstUserTitle'), this.t('admin.users.firstUserMsg'), this.t('admin.users.firstUserLabel'), () => {
              window.location.href = '/login';
            });
          }
        }catch {
          iziToast.error({
            title: this.t('admin.users.toastFailedAdd'),
            position: 'topCenter',
            timeout: 3500
          });
        }finally {
          this.submitPending = false;
        }
      },
      toggleRadioRecording: async function (username, user) {
        const newVal = !user['allow-radio-recording'];
        try {
          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/users/allow-radio-recording`,
            data: { username, allow: newVal }
          });
          Vue.set(ADMINDATA.users[username], 'allow-radio-recording', newVal);
          iziToast.success({ title: newVal ? this.t('admin.users.toastRecordEnabled') : this.t('admin.users.toastRecordDisabled'), position: 'topCenter', timeout: 3000 });
        } catch {
          iziToast.error({ title: this.t('admin.users.toastFailedUpdate'), position: 'topCenter', timeout: 3500 });
        }
      },
      toggleYoutubeDownload: async function (username, user) {
        const newVal = !user['allow-youtube-download'];
        try {
          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/users/allow-youtube-download`,
            data: { username, allow: newVal }
          });
          Vue.set(ADMINDATA.users[username], 'allow-youtube-download', newVal);
          iziToast.success({ title: newVal ? this.t('admin.users.toastYoutubeEnabled') : this.t('admin.users.toastYoutubeDisabled'), position: 'topCenter', timeout: 3000 });
        } catch {
          iziToast.error({ title: this.t('admin.users.toastFailedUpdate'), position: 'topCenter', timeout: 3500 });
        }
      },
      toggleUpload: async function (username, user) {
        const newVal = user['allow-upload'] === false;
        try {
          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/users/allow-upload`,
            data: { username, allow: newVal }
          });
          Vue.set(ADMINDATA.users[username], 'allow-upload', newVal);
          iziToast.success({ title: newVal ? this.t('admin.users.toastUploadEnabled') : this.t('admin.users.toastUploadDisabled'), position: 'topCenter', timeout: 3000 });
        } catch {
          iziToast.error({ title: this.t('admin.users.toastFailedUpdate'), position: 'topCenter', timeout: 3500 });
        }
      },
      toggleServerRemote: async function (username, user) {
        const newVal = !user['allow-server-remote'];
        try {
          await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/users/allow-server-remote`, data: { username, allow: newVal } });
          Vue.set(ADMINDATA.users[username], 'allow-server-remote', newVal);
          iziToast.success({ title: newVal ? this.t('admin.users.toastRemoteGranted') : this.t('admin.users.toastRemoteRevoked'), position: 'topCenter', timeout: 3000 });
        } catch {
          iziToast.error({ title: this.t('admin.users.toastFailedUpdate'), position: 'topCenter', timeout: 3500 });
        }
      },
      toggleMpvCastPerm: async function (username, user) {
        const newVal = !user['allow-mpv-cast'];
        try {
          await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/users/allow-mpv-cast`, data: { username, allow: newVal } });
          Vue.set(ADMINDATA.users[username], 'allow-mpv-cast', newVal);
          iziToast.success({ title: newVal ? this.t('admin.users.toastCastEnabled') : this.t('admin.users.toastCastDisabled'), position: 'topCenter', timeout: 3000 });
        } catch {
          iziToast.error({ title: this.t('admin.users.toastFailedUpdate'), position: 'topCenter', timeout: 3500 });
        }
      }
    }
});

const advancedView = Vue.component('advanced-view', {
  data() {
    return {
      params: ADMINDATA.serverParams,
      paramsTS: ADMINDATA.serverParamsUpdated,
      uiSelect: ADMINDATA.serverParams.ui || 'velvet'
    };
  },
  template: `
    <div v-if="paramsTS.ts === 0" class="row">
      <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
    </div>
    <div v-else>
      <div class="container">
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">{{ t('admin.settings.uiTitle') }}</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>{{ t('admin.settings.labelDefaultTheme') }}</b></td>
                      <td>
                        <select v-model="uiSelect" v-on:change="setUi(uiSelect)" style="width:auto;padding:4px 8px">
                          <option value="velvet">{{ t('admin.settings.themeVelvetDefault') }}</option>
                          <option value="velvet-dark">{{ t('admin.settings.themeVelvetDark') }}</option>
                          <option value="velvet-light">{{ t('admin.settings.themeVelvetLight') }}</option>
                        </select>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p style="color:#888;font-size:12px;margin-top:8px">{{ t('admin.settings.themeHint') }}</p>
              </div>
            </div>
          </div>
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">{{ t('admin.settings.securityTitle') }}</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>{{ t('admin.settings.labelFileUploading') }}</b> {{ params.noUpload === false ? t('admin.settings.fileUploadingEnabled') : t('admin.settings.fileUploadingDisabled') }}</td>
                      <td>
                        <a v-on:click="toggleFileUpload()" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.settings.labelAuthKey') }}</b> ****************{{params.secret}}</td>
                      <td>
                        <a v-on:click="generateNewKey()" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">{{ t('admin.settings.networkTitle') }}</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>{{ t('admin.settings.labelPort') }}</b> {{params.port}}</td>
                      <td>
                        <a v-on:click="openModal('edit-port-modal')" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.settings.labelMaxRequestSize') }}</b> {{params.maxRequestSize}}</td>
                      <td>
                        <a v-on:click="openModal('edit-request-size-modal')" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.settings.labelAddress') }}</b> {{params.address}}</td>
                      <td>
                        <a v-on:click="openModal('edit-address-modal')" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div class="col s12">
            <div class="card">
              <div v-if="!params.ssl || !params.ssl.cert">
                <div class="card-content">
                  <span class="card-title">{{ t('admin.settings.sslTitle') }}</span>
                  <a v-on:click="openModal('edit-ssl-modal')" class="btn">{{ t('admin.settings.btnAddSslCerts') }}</a>
                </div>
              </div>
              <div v-else>
                <div class="card-content">
                  <span class="card-title">{{ t('admin.settings.sslTitle') }}</span>
                  <table>
                    <tbody>
                      <tr>
                        <td><b>{{ t('admin.settings.labelCert') }}</b> {{params.ssl.cert}}</td>
                      </tr>
                      <tr>
                        <td><b>{{ t('admin.settings.labelKey') }}</b> {{params.ssl.key}}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div class="card-action">
                  <a v-on:click="openModal('edit-ssl-modal')" class="btn">{{ t('admin.settings.btnEditSsl') }}</a>
                  <a v-on:click="removeSSL()" class="btn">{{ t('admin.settings.btnRemoveSsl') }}</a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  methods: {
    openModal: function(modalView) {
      modVM.currentViewModal = modalView;
      modVM.openModal();
    },
    removeSSL: function() {
            adminConfirm(this.t('admin.settings.confirmRemoveSslTitle'), this.t('admin.settings.confirmRemoveSslMsg'), this.t('admin.settings.confirmRemoveSslLabel'), async () => {
        try {
                      await API.axios({
                        method: 'DELETE',
                        url: `${API.url()}/api/v1/admin/ssl`
                      });

                      setTimeout(() => {
                        window.location.href = window.location.href.replaceAll('https://', 'http://'); 
                      }, 4000);

                      iziToast.success({
                        title: this.t('admin.settings.toastCertsDeleted'),
                        position: 'topCenter',
                        timeout: 8500
                      });
                    } catch {
                      iziToast.error({
                        title: this.t('admin.settings.toastFailedDeleteCert'),
                        position: 'topCenter',
                        timeout: 3500
                      });
                    }
      });
    },
    generateNewKey: function() {
            adminConfirm(this.t('admin.settings.confirmNewKeyTitle'), this.t('admin.settings.confirmNewKeyMsg'), this.t('admin.settings.confirmNewKeyLabel'), () => {
        API.axios({
                      method: 'POST',
                      url: `${API.url()}/api/v1/admin/config/secret`,
                      data: { strength: 128 }
                    }).then(() => {
                      API.logout();
                    }).catch(() => {
                      iziToast.error({
                        title: this.t('admin.common.failed'),
                        position: 'topCenter',
                        timeout: 3500
                      });
                    });
      });
    },
    setUi: function(ui) {
      API.axios({
        method: 'POST',
        url: `${API.url()}/api/v1/admin/config/theme`,
        data: { ui }
      }).then(() => {
        Vue.set(ADMINDATA.serverParams, 'ui', ui);
        this.uiSelect = ui;
        iziToast.success({ title: this.t('admin.settings.toastThemeUpdated'), position: 'topCenter', timeout: 3000 });
      }).catch(() => {
        this.uiSelect = ADMINDATA.serverParams.ui || 'velvet';
        iziToast.error({ title: this.t('admin.common.failed'), position: 'topCenter', timeout: 3000 });
      });
    },
    toggleFileUpload: function() {
            adminConfirm(this.params.noUpload === false ? this.t('admin.settings.confirmDisableUploadTitle') : this.t('admin.settings.confirmEnableUploadTitle'), '', this.params.noUpload === false ? this.t('admin.common.disable') : this.t('admin.common.enable'), () => {
        API.axios({
                      method: 'POST',
                      url: `${API.url()}/api/v1/admin/config/noupload`,
                      data: { noUpload: !this.params.noUpload }
                    }).then(() => {
                      // update frontend data
                      Vue.set(ADMINDATA.serverParams, 'noUpload', !this.params.noUpload);

                      iziToast.success({
                        title: this.t('admin.common.updatedSuccessfully'),
                        position: 'topCenter',
                        timeout: 3500
                      });
                    }).catch(() => {
                      iziToast.error({
                        title: this.t('admin.common.failed'),
                        position: 'topCenter',
                        timeout: 3500
                      });
                    });
      });
    }
  }
});


const dbView = Vue.component('db-view', {
  data() {
    return {
      dbParams: ADMINDATA.dbParams,
      dbStats: null,
      sharedPlaylists: ADMINDATA.sharedPlaylists,
      sharedPlaylistsTS: ADMINDATA.sharedPlaylistUpdated,
      isPullingStats: false,
      isPullingShared: false,
      scanProgress: [],
      resumable: [],
      spPollTimer: null,
      rebuildingArtists: false,
    };
  },
  mounted: async function() {
    await this.pollProgress();
    this.spPollTimer = setInterval(() => this.pollProgress(), 3000);
  },
  beforeDestroy: function() {
    if (this.spPollTimer) { clearInterval(this.spPollTimer); this.spPollTimer = null; }
  },
  template: `
    <div>
      <div class="container">
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">{{ t('admin.db.scanSettingsTitle') }}</span>
                <table>
                  <tbody>
                    <tr>
                      <td>
                        <b>{{ t('admin.db.labelScanInterval') }}</b> {{dbParams.scanInterval}} {{ t('admin.db.scanIntervalUnit') }}
                        <span v-if="dbParams.scanStartTime" style="margin-left:10px;color:var(--t3);font-size:12px;">{{ t('admin.db.labelScanStartTime') }}: <b>{{dbParams.scanStartTime}}</b></span>
                        <div v-if="dbParams.nextScanAt" style="margin-top:4px;font-size:12px;color:var(--t3);">{{ t('admin.db.nextScanCountdown') }}: <b>{{_scanCountdown(dbParams.nextScanAt)}}</b></div>
                      </td>
                      <td>
                        <a v-on:click="openModal('edit-scan-interval-modal')" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.labelBootScanDelay') }}</b> {{dbParams.bootScanDelay}} {{ t('admin.db.bootScanDelayUnit') }}</td>
                      <td>
                        <a v-on:click="openModal('edit-boot-scan-delay-modal')" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.labelBootScanEnabled') }}</b> {{dbParams.bootScanEnabled}}</td>
                      <td>
                        <a v-on:click="toggleBootScanEnabled()" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.labelSkipImageMetadata') }}</b> {{dbParams.skipImg}}</td>
                      <td>
                        <a v-on:click="toggleSkipImg()" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.labelCompressImages') }}</b> {{dbParams.compressImage}}</td>
                      <td>
                        <a v-on:click="recompressImages()" class="btn-sm">{{ t('admin.db.btnRecompress') }}</a>
                        <a v-on:click="toggleCompressImage()" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.labelMaxConcurrentScans') }}</b> {{dbParams.maxConcurrentTasks}}</td>
                      <td>
                        <a v-on:click="openModal('edit-max-scan-modal')" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.labelAllowId3Edit') }}</b> {{dbParams.allowId3Edit || false}}</td>
                      <td>
                        <a v-on:click="toggleAllowId3Edit()" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.db.labelMaxZipSize') }}</b> {{dbParams.maxZipMb || 500}} {{ t('admin.db.maxZipUnit') }}</td>
                      <td>
                        <a v-on:click="openModal('edit-max-zip-mb-modal')" class="btn-sm btn-sm-edit">{{ t('admin.common.edit') }}</a>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
        <!-- Album Version Tag Fields card -->
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">Album Version Tag Fields</span>
                <p style="color:var(--t2);font-size:.88rem;margin-bottom:12px;">
                  Ordered list of tag field names checked during scanning to find album version/edition text.
                  First non-empty match wins. After changing this list, rescan your library to apply.
                </p>
                <album-version-tags-card></album-version-tags-card>
              </div>
            </div>
          </div>
        </div>
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">{{ t('admin.db.queueStatsTitle') }}</span>
                <a v-on:click="scanDB" class="btn">{{ t('admin.db.btnStartScan') }}</a>
                <a v-if="resumable.length > 0 && scanProgress.length === 0" v-on:click="resumeScan" class="btn" style="margin-left:.5rem">{{ t('admin.db.btnResumeScan') }}</a>
                <a v-if="scanProgress.length > 0" v-on:click="stopScan" class="btn red" style="margin-left:.5rem">{{ t('admin.db.btnStopScanning') }}</a>
                <a v-on:click="pullStats" class="btn">{{ t('admin.db.btnPullStats') }}</a>
                <a class="btn" :disabled="rebuildingArtists" v-on:click="doRebuildArtists" style="margin-left:.5rem">{{ rebuildingArtists ? t('admin.db.btnRebuildingArtists') : t('admin.db.btnRebuildArtistIndex') }}</a>
                <span v-if="rebuildingArtists" style="display:inline-flex;align-items:center;gap:.4rem;margin-left:.7rem;color:#666;font-size:.92rem;vertical-align:middle;">
                  <svg class="spinner" width="18px" height="18px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
                  {{ t('admin.db.rebuildingArtistMsg') }}
                </span>
                <div v-if="scanProgress.length > 0" class="sp-container">
                  <div v-for="sp in scanProgress" :key="sp.scanId" class="sp-card">
                    <div class="sp-header">
                      <span class="sp-live-dot"></span>
                      <span class="sp-vpath">{{sp.vpath}}</span>
                      <span v-if="sp.countingFound > 0 && sp.scanned === 0" class="sp-counting-badge">Counting&hellip;</span>
                      <span v-else-if="sp.pct !== null" class="sp-pct-badge">{{sp.pct}}%</span>
                      <span v-else class="sp-firstscan-badge">first scan</span>
                      <span class="sp-spacer"></span>
                      <span v-if="sp.etaSec" class="sp-eta">est. {{formatEta(sp.etaSec)}}</span>
                      <span v-if="sp.filesPerSec" class="sp-rate">{{sp.filesPerSec}}/s</span>
                    </div>
                    <div class="sp-track">
                      <div v-if="sp.countingFound > 0 && sp.scanned === 0" class="sp-fill-indeterminate"></div>
                      <div v-else-if="sp.pct !== null" class="sp-fill" :style="{width: sp.pct + '%'}"></div>
                      <div v-else class="sp-fill-indeterminate"></div>
                    </div>
                    <div class="sp-counts">
                      <span v-if="sp.countingFound > 0 && sp.scanned === 0">{{sp.countingFound.toLocaleString()}} files found&hellip;</span>
                      <span v-else-if="sp.expected">{{sp.scanned.toLocaleString()}} / {{sp.expected.toLocaleString()}} files checked</span>
                      <span v-else>{{sp.scanned.toLocaleString()}} files checked</span>
                      <span class="sp-elapsed">elapsed: {{formatElapsed(sp.elapsedSec)}}</span>
                    </div>
                    <div v-if="sp.added > 0" class="sp-counts" style="margin-top:.2rem;color:var(--accent,#26a69a)">
                      <span>{{sp.added.toLocaleString()}} added to DB</span>
                    </div>
                    <div v-if="sp.currentFile" class="sp-current-file">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
                      <span class="sp-filepath" :title="sp.currentFile">{{truncatePath(sp.currentFile)}}</span>
                    </div>
                  </div>
                </div>
                <div v-if="isPullingStats === true">
                  <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
                </div>
                <div v-else-if="dbStats && dbStats.totalFiles != null">
                  <div class="stat-grid">
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.totalFiles||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statTotalTracks') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.totalArtists||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statArtists') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.totalAlbums||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statAlbums') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.totalGenres||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statGenres') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.withArt||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statWithArt') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num" style="color:var(--t2)">{{(dbStats.withoutArt||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statNoArt') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.artEmbedded||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statArtEmbedded') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.artFromDirectory||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statArtFromFolder') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num" style="color:var(--accent)">{{(dbStats.artUserPicked||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statArtUserPicked') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num" style="color:var(--accent)">{{(dbStats.withReplaygain||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statReplayGain') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num" style="color:var(--accent)">{{(dbStats.withCue||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statCueFiles') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num" style="color:var(--t2)">{{(dbStats.cueUnchecked||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statCueNotScanned') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.addedLast7Days||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statAdded7Days') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num">{{(dbStats.addedLast30Days||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statAdded30Days') }}</div>
                    </div>
                    <div class="stat-chip" v-if="dbStats.oldestYear">
                      <div class="sc-num">{{dbStats.oldestYear}}&thinsp;&ndash;&thinsp;{{dbStats.newestYear}}</div>
                      <div class="sc-label">{{ t('admin.db.statYearRange') }}</div>
                    </div>
                    <div class="stat-chip">
                      <div class="sc-num" style="color:var(--accent)">{{(dbStats.waveformCount||0).toLocaleString()}}</div>
                      <div class="sc-label">{{ t('admin.db.statWaveforms') }}</div>
                    </div>
                    <div class="stat-chip" v-if="dbStats.totalDurationSec > 0">
                      <div class="sc-num" style="color:var(--primary)">{{formatDuration(dbStats.totalDurationSec)}}</div>
                      <div class="sc-label">{{ t('admin.db.statTotalDuration') }}</div>
                    </div>
                    <div class="stat-chip" v-if="dbStats.lastScannedTs">
                      <div class="sc-num" style="font-size:.82rem;color:var(--t1)">{{formatDate(dbStats.lastScannedTs)}}</div>
                      <div class="sc-label">{{ t('admin.db.statLastScan') }}</div>
                    </div>
                  </div>

                  <div class="stat-section-row">
                    <div class="stat-section" v-if="dbStats.formats.length > 1">
                      <div class="stat-section-title">{{ t('admin.db.statSectionFormats') }}</div>
                      <div v-for="f in dbStats.formats" class="stat-bar-row">
                        <span class="stat-bar-label">{{f.format ? f.format.toUpperCase() : '?'}}</span>
                        <div class="stat-bar-bg"><div class="stat-bar-fill" :style="{width: Math.round(f.cnt/dbStats.totalFiles*100)+'%'}"></div></div>
                        <span class="stat-bar-count">{{f.cnt.toLocaleString()}}</span>
                      </div>
                    </div>
                    <div class="stat-section" v-if="dbStats.topArtists.length > 0">
                      <div class="stat-section-title">{{ t('admin.db.statSectionTopArtists') }}</div>
                      <div v-for="a in dbStats.topArtists" class="stat-bar-row">
                        <span class="stat-bar-label">{{a.artist}}</span>
                        <div class="stat-bar-bg"><div class="stat-bar-fill" :style="{width: Math.round(a.cnt/dbStats.topArtists[0].cnt*100)+'%', background:'var(--accent)'}"></div></div>
                        <span class="stat-bar-count">{{a.cnt.toLocaleString()}}</span>
                      </div>
                    </div>
                    <div class="stat-section" v-if="dbStats.topGenres.length > 0">
                      <div class="stat-section-title">{{ t('admin.db.statSectionTopGenres') }}</div>
                      <div v-for="g in dbStats.topGenres" class="stat-bar-row">
                        <span class="stat-bar-label">{{g.genre}}</span>
                        <div class="stat-bar-bg"><div class="stat-bar-fill" :style="{width: Math.round(g.cnt/dbStats.topGenres[0].cnt*100)+'%', background:'var(--red)'}"></div></div>
                        <span class="stat-bar-count">{{g.cnt.toLocaleString()}}</span>
                      </div>
                    </div>
                    <div class="stat-section" v-if="dbStats.decades && dbStats.decades.length > 1">
                      <div class="stat-section-title">{{ t('admin.db.statSectionMusicByDecade') }}</div>
                      <div v-for="d in dbStats.decades" class="stat-bar-row">
                        <span class="stat-bar-label">{{d.decade}}s</span>
                        <div class="stat-bar-bg"><div class="stat-bar-fill" :style="{width: Math.round(d.cnt / Math.max(...dbStats.decades.map(x=>x.cnt)) * 100)+'%', background:'var(--t2)'}"></div></div>
                        <span class="stat-bar-count">{{d.cnt.toLocaleString()}}</span>
                      </div>
                    </div>
                    <div class="stat-section" v-if="dbStats.perVpath.length > 1">
                      <div class="stat-section-title">{{ t('admin.db.statSectionTracksPerFolder') }}</div>
                      <div v-for="v in dbStats.perVpath" class="stat-bar-row">
                        <span class="stat-bar-label">{{v.vpath}}</span>
                        <div class="stat-bar-bg"><div class="stat-bar-fill" :style="{width: Math.round(v.cnt/dbStats.totalFiles*100)+'%', background:'var(--accent)'}"></div></div>
                        <span class="stat-bar-count">{{v.cnt.toLocaleString()}}</span>
                      </div>
                    </div>
                  </div>

                </div>
                <div v-else-if="dbStats" style="color:var(--t2);font-size:.88rem;margin-top:.75rem">
                  {{(dbStats.fileCount||0).toLocaleString()}} files indexed &mdash; restart the server to see full statistics.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  methods: {
    _scanCountdown(ms) {
      if (!ms) return '';
      const diff = Math.max(0, ms - Date.now());
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      if (h > 0) return `${h}h ${String(m).padStart(2,'0')}m`;
      if (m > 0) return `${m}m ${String(s).padStart(2,'0')}s`;
      return `${s}s`;
    },
    async doRebuildArtists() {
      this.rebuildingArtists = true;
      try {
        // Start rebuild (or get 409 if one is already running) then poll status.
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/artists/rebuild-index` });

        let done = false;
        for (let i = 0; i < 600; i++) { // up to 10 minutes
          await new Promise(r => setTimeout(r, 1000));
          const st = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/artists/rebuild-status` });
          if (st.data?.running === false) {
            done = true;
            if (st.data.lastError) {
              iziToast.error({ title: this.t('admin.db.toastRebuildFailed'), message: st.data.lastError, position: 'topCenter', timeout: 7000 });
            } else {
              iziToast.success({ title: this.t('admin.db.toastArtistIndexRebuilt'), message: this.t('admin.db.toastReloadArtistLibrary'), position: 'topCenter', timeout: 4000 });
            }
            break;
          }
        }
        if (!done) {
          iziToast.error({ title: this.t('admin.db.toastRebuildTimedOut'), message: this.t('admin.db.toastRebuildTimedOutMsg'), position: 'topCenter', timeout: 7000 });
        }
      } catch (e) {
        const msg = (e?.response?.data?.error)
          ? e.response.data.error
          : (e?.message ?? 'Unknown error');
        // If rebuild is already running, keep loader visible and poll anyway.
        if (e?.response?.status === 409) {
          try {
            let done = false;
            for (let i = 0; i < 600; i++) {
              await new Promise(r => setTimeout(r, 1000));
              const st = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/artists/rebuild-status` });
              if (st.data?.running === false) {
                done = true;
                if (st.data.lastError) iziToast.error({ title: this.t('admin.db.toastRebuildFailed'), message: st.data.lastError, position: 'topCenter', timeout: 7000 });
                else iziToast.success({ title: this.t('admin.db.toastArtistIndexRebuilt'), message: this.t('admin.db.toastReloadArtistLibrary'), position: 'topCenter', timeout: 4000 });
                break;
              }
            }
            if (!done) iziToast.error({ title: this.t('admin.db.toastRebuildTimedOut'), message: this.t('admin.db.toastRebuildTimedOutMsg'), position: 'topCenter', timeout: 7000 });
          } catch (pollErr) {
            const pmsg = pollErr?.message ?? msg;
            iziToast.error({ title: this.t('admin.db.toastRebuildStatusCheckFailed'), message: pmsg, position: 'topCenter', timeout: 7000 });
          }
        } else {
          iziToast.error({ title: this.t('admin.db.toastRebuildFailed'), message: msg, position: 'topCenter', timeout: 7000 });
        }
      } finally {
        this.rebuildingArtists = false;
      }
    },
    pollProgress: async function() {
      try {
        const [progRes, resumeRes] = await Promise.all([
          API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/db/scan/progress` }),
          API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/db/scan/resume-state` }),
        ]);
        this.scanProgress = progRes.data;
        this.resumable = resumeRes.data.resumable || [];
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    },
    formatEta: function(sec) {
      if (!sec || sec <= 0) return null;
      if (sec < 60) return `${sec}s`;
      if (sec < 3600) return `${Math.floor(sec/60)}m ${sec%60}s`;
      return `${Math.floor(sec/3600)}h ${Math.floor((sec%3600)/60)}m`;
    },
    formatDuration: function(sec) {
      if (!sec || sec <= 0) return '0m';
      const d = Math.floor(sec / 86400);
      const h = Math.floor((sec % 86400) / 3600);
      const m = Math.floor((sec % 3600) / 60);
      if (d > 0) return `${d}d ${h}h ${m}m`;
      if (h > 0) return `${h}h ${m}m`;
      return `${m}m`;
    },
    formatDate: function(ms) {
      if (!ms) return '\u2014';
      return new Date(ms).toLocaleString();
    },
    formatElapsed: function(sec) {
      if (!sec || sec <= 0) return '0s';
      if (sec < 60) return `${sec}s`;
      if (sec < 3600) return `${Math.floor(sec/60)}m ${sec%60}s`;
      return `${Math.floor(sec/3600)}h ${Math.floor((sec%3600)/60)}m`;
    },
    truncatePath: function(fp, maxLen = 60) {
      if (!fp) return '';
      if (fp.length <= maxLen) return fp;
      return '\u2026' + fp.slice(-(maxLen - 1));
    },
    pullStats: async function() {
      try {
        this.isPullingStats = true;
        const res = await API.axios({
          method: 'GET',
          url: `${API.url()}/api/v1/admin/db/scan/stats`
        });

        this.dbStats = res.data
      } catch {
        iziToast.error({
          title: this.t('admin.db.toastFailedPullData'),
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.isPullingStats = false;
      }
    },
    sharedLinkUrl: function(id) {
      return window.location.origin + '/shared/' + id;
    },
    sharedExpiry: function(v) {
      if (!v.expires) { return this.t('admin.db.labelNeverExpires'); }
      if (v.expires * 1000 < Date.now()) { return this.t('admin.db.labelExpired'); }
      return this.t('admin.db.labelExpires', { date: new Date(v.expires * 1000).toLocaleDateString() });
    },
    copySharedLink: function(playlistId, evt) {
      const url = this.sharedLinkUrl(playlistId);
      navigator.clipboard.writeText(url).then(() => {
        const btn = evt.currentTarget;
        const orig = btn.textContent;
        btn.textContent = '\u2713 ' + this.t('admin.db.btnCopied');
        setTimeout(() => { btn.textContent = orig; }, 1800);
      }).catch(() => {
        iziToast.warning({ title: this.t('player.toast.copyFailed'), position: 'topCenter', timeout: 2000 });
      });
    },
    loadShared: async function() {
      try {
        this.isPullingShared = true;
        await ADMINDATA.getSharedPlaylists();
      } catch {
        iziToast.error({
          title: this.t('admin.db.toastFailedPullData'),
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.isPullingShared = false;
      }
    },
    deletePlaylist: async function(playlistObj) {
            adminConfirm(`Delete playlist <b>${playlistObj.playlistId}</b>?`, '', 'Delete', async () => {
        try {
                      await ADMINDATA.deleteSharedPlaylist(playlistObj);
                    } catch {
                      iziToast.error({
                        title: this.t('admin.db.toastFailedDeletePlaylist'),
                        position: 'topCenter',
                        timeout: 3500
                      });
                    }
      });
    },
    deleteUnxpShared: async function() {
            adminConfirm(`Delete all playlists without expiration dates?`, '', 'Delete', async () => {
        try {
                      this.isPullingShared = true;
                      await ADMINDATA.deleteUnxpShared();
                      await ADMINDATA.getSharedPlaylists();
                    } catch {
                      iziToast.error({
                        title: this.t('admin.db.toastFailedDeleteSharedPlaylists'),
                        position: 'topCenter',
                        timeout: 3500
                      });
                    } finally {
                      this.isPullingShared = false;
                    }
      });
    },
    deleteExpiredShared: async function() {
      try {
        this.isPullingShared = true;
        await ADMINDATA.deleteExpiredShared();
        await ADMINDATA.getSharedPlaylists();
      } catch {
        iziToast.error({
          title: this.t('admin.db.toastFailedPullData'),
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.isPullingShared = false;
      }
    },
    scanDB: async function() {
      try {
        // Clear any interrupted scan checkpoint first — start fresh from the beginning
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/db/scan/clear-state` });
        this.resumable = [];
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/db/scan/all` });
        iziToast.success({
          title: this.t('admin.db.toastScanStarted'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch {
        iziToast.error({
          title: this.t('admin.db.toastFailedStartScan'),
          position: 'topCenter',
          timeout: 3500
        });
      }
    },
    resumeScan: async function() {
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/db/scan/all` });
        iziToast.success({
          title: this.t('admin.db.toastScanStarted'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch {
        iziToast.error({
          title: this.t('admin.db.toastFailedStartScan'),
          position: 'topCenter',
          timeout: 3500
        });
      }
    },
    stopScan: async function() {
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/db/scan/stop` });
        iziToast.success({ title: this.t('admin.db.toastScanStopped'), position: 'topCenter', timeout: 3500 });
        this.scanProgress = [];
        // Immediately check for resumable checkpoints so the Resume button appears right away
        const r = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/db/scan/resume-state` });
        this.resumable = r.data.resumable || [];
      } catch {
        iziToast.error({ title: this.t('admin.db.toastFailedStopScan'), position: 'topCenter', timeout: 3500 });
      }
    },
    recompressImages: function() {
            adminConfirm(`<b>Compress All Images?</b>`, 'This process will run in the background', 'Start', async () => {
        try {
                      const res = await API.axios({
                        method: 'POST',
                        url: `${API.url()}/api/v1/admin/db/force-compress-images`,
                      });

                      if (res.data.started === true) {
                        iziToast.success({
                          title: 'Process Started',
                          position: 'topCenter',
                          timeout: 3500
                        });
                      } else {
                        iziToast.warning({
                          title: 'Image Compression In Progress',
                          position: 'topCenter',
                          timeout: 3500
                        });
                      }

                    } catch {
                      iziToast.error({
                        title: 'Failed',
                        position: 'topCenter',
                        timeout: 3500
                      });
                    }
      });
    },
    toggleCompressImage: function() {
            adminConfirm(`<b>${this.dbParams.compressImage === true ? 'Disable' : 'Enable'} Compress Images?</b>`, '', `${this.dbParams.compressImage === true ? 'Disable' : 'Enable'}`, () => {
        API.axios({
                      method: 'POST',
                      url: `${API.url()}/api/v1/admin/db/params/compress-image`,
                      data: { compressImage: !this.dbParams.compressImage }
                    }).then(() => {
                      // update frontend data
                      Vue.set(ADMINDATA.dbParams, 'compressImage', !this.dbParams.compressImage);

                      iziToast.success({
                        title: this.t('admin.common.updatedSuccessfully'),
                        position: 'topCenter',
                        timeout: 3500
                      });
                    }).catch(() => {
                      iziToast.error({
                        title: 'Failed',
                        position: 'topCenter',
                        timeout: 3500
                      });
                    });
      });
    },
    toggleAllowId3Edit: function() {
            adminConfirm(
        `<b>${this.dbParams.allowId3Edit ? 'Disable' : 'Enable'} ID3 Tag Editing?</b>`,
        this.dbParams.allowId3Edit
          ? 'Admins will no longer be able to edit ID3 tags in the Now Playing modal.'
          : 'Allows admins to edit ID3 tags (title, artist, album, year, genre…) in the Now Playing modal. Tags are written directly to the file via ffmpeg.',
        this.dbParams.allowId3Edit ? 'Disable' : 'Enable',
        () => {
          API.axios({
                        method: 'POST',
                        url: `${API.url()}/api/v1/admin/db/params/allow-id3edit`,
                        data: { allowId3Edit: !this.dbParams.allowId3Edit }
                      }).then(() => {
                        Vue.set(ADMINDATA.dbParams, 'allowId3Edit', !this.dbParams.allowId3Edit);
                        iziToast.success({ title: this.t('admin.common.updatedSuccessfully'), position: 'topCenter', timeout: 3500 });
                      }).catch(() => {
                        iziToast.error({ title: 'Failed', position: 'topCenter', timeout: 3500 });
                      });
        }
      );
    },
    toggleBootScanEnabled: function() {
      const enabling = !this.dbParams.bootScanEnabled;
      adminConfirm(
        `<b>${enabling ? 'Enable' : 'Disable'} Boot Scan?</b>`,
        enabling
          ? 'The database will be scanned automatically when the server starts.'
          : 'The database will NOT be scanned on startup. You can still trigger a manual scan at any time.',
        enabling ? 'Enable' : 'Disable',
        () => {
          API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/db/params/boot-scan-enabled`,
            data: { bootScanEnabled: enabling }
          }).then(() => {
            Vue.set(ADMINDATA.dbParams, 'bootScanEnabled', enabling);
            iziToast.success({ title: this.t('admin.common.updated'), position: 'topCenter', timeout: 3500 });
          }).catch(() => {
            iziToast.error({ title: this.t('admin.common.failed'), position: 'topCenter', timeout: 3500 });
          });
        }
      );
    },
    toggleSkipImg: function() {
            adminConfirm(`<b>${this.dbParams.skipImg === true ? 'Disable' : 'Enable'} Image Skip?</b>`, '', `${this.dbParams.skipImg === true ? 'Disable' : 'Enable'}`, () => {
        API.axios({
                      method: 'POST',
                      url: `${API.url()}/api/v1/admin/db/params/skip-img`,
                      data: { skipImg: !this.dbParams.skipImg }
                    }).then(() => {
                      // update frontend data
                      Vue.set(ADMINDATA.dbParams, 'skipImg', !this.dbParams.skipImg);

                      iziToast.success({
                        title: this.t('admin.common.updatedSuccessfully'),
                        position: 'topCenter',
                        timeout: 3500
                      });
                    }).catch(() => {
                      iziToast.error({
                        title: 'Failed',
                        position: 'topCenter',
                        timeout: 3500
                      });
                    });
      });
    },
    openModal: function(modalView) {
      modVM.currentViewModal = modalView;
      modVM.openModal();
    }
  }
});

const sharedPlaylistsView = Vue.component('shared-playlists-view', {
  data() {
    return {
      sharedPlaylists: ADMINDATA.sharedPlaylists,
      sharedPlaylistsTS: ADMINDATA.sharedPlaylistUpdated,
      isPullingShared: false,
    };
  },
  mounted() {
    this.loadShared();
  },
  template: `
    <div>
      <div class="container">
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">{{ t('admin.db.sharedPlaylistsTitle') }}</span>
                <div v-if="isPullingShared === true">
                  <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
                </div>
                <div v-else-if="sharedPlaylistsTS.ts !== 0 && sharedPlaylists.length > 0">
                  <div class="admin-shared-bulk-actions">
                    <a v-on:click="deleteUnxpShared" class="btn-small red">{{ t('admin.db.btnDeleteNoExpiry') }}</a>
                    <a v-on:click="deleteExpiredShared" class="btn-small red">{{ t('admin.db.btnDeleteExpired') }}</a>
                  </div>
                  <div class="admin-shared-links-list">
                    <div v-for="(v, k) in sharedPlaylists" :key="v.playlistId" :class="['admin-shared-link-row', v.expires && v.expires * 1000 < Date.now() ? 'admin-shared-expired' : '']">
                      <div class="admin-shared-link-info">
                        <div class="admin-shared-link-url">{{ sharedLinkUrl(v.playlistId) }}</div>
                        <div class="admin-shared-link-meta">
                          {{ t('admin.db.songCount', { count: v.playlist.length }) }}
                          &nbsp;&middot;&nbsp; {{ v.user }}
                          &nbsp;&middot;&nbsp; {{ sharedExpiry(v) }}
                          <span v-if="v.expires && v.expires * 1000 < Date.now()" class="admin-shared-expired-tag">{{ t('admin.db.labelExpired') }}</span>
                        </div>
                      </div>
                      <div class="admin-shared-link-actions">
                        <a v-on:click="copySharedLink(v.playlistId, $event)" class="btn-flat btn-small">{{ t('admin.db.btnCopyLink') }}</a>
                        <a :href="'/shared/' + v.playlistId" target="_blank" rel="noopener" class="btn-flat btn-small">{{ t('admin.db.btnOpenLink') }}</a>
                        <a v-on:click="deletePlaylist(v)" class="btn-small red">{{ t('admin.common.delete') }}</a>
                      </div>
                    </div>
                  </div>
                </div>
                <div v-else-if="sharedPlaylistsTS.ts !== 0 && sharedPlaylists.length === 0">
                  {{ t('admin.db.noSharedPlaylists') }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  methods: {
    sharedLinkUrl: function(id) {
      return window.location.origin + '/shared/' + id;
    },
    sharedExpiry: function(v) {
      if (!v.expires) { return this.t('admin.db.labelNeverExpires'); }
      if (v.expires * 1000 < Date.now()) { return this.t('admin.db.labelExpired'); }
      return this.t('admin.db.labelExpires', { date: new Date(v.expires * 1000).toLocaleDateString() });
    },
    copySharedLink: function(playlistId, evt) {
      const url = this.sharedLinkUrl(playlistId);
      navigator.clipboard.writeText(url).then(() => {
        const btn = evt.currentTarget;
        const orig = btn.textContent;
        btn.textContent = '\u2713 ' + this.t('admin.db.btnCopied');
        setTimeout(() => { btn.textContent = orig; }, 1800);
      }).catch(() => {
        iziToast.warning({ title: this.t('player.toast.copyFailed'), position: 'topCenter', timeout: 2000 });
      });
    },
    loadShared: async function() {
      try {
        this.isPullingShared = true;
        await ADMINDATA.getSharedPlaylists();
      } catch {
        iziToast.error({ title: this.t('admin.db.toastFailedPullData'), position: 'topCenter', timeout: 3500 });
      } finally {
        this.isPullingShared = false;
      }
    },
    deletePlaylist: async function(playlistObj) {
      adminConfirm(`Delete playlist <b>${playlistObj.playlistId}</b>?`, '', 'Delete', async () => {
        try {
          await ADMINDATA.deleteSharedPlaylist(playlistObj);
        } catch {
          iziToast.error({ title: this.t('admin.db.toastFailedDeletePlaylist'), position: 'topCenter', timeout: 3500 });
        }
      });
    },
    deleteUnxpShared: async function() {
      adminConfirm(`Delete all playlists without expiration dates?`, '', 'Delete', async () => {
        try {
          this.isPullingShared = true;
          await ADMINDATA.deleteUnxpShared();
          await ADMINDATA.getSharedPlaylists();
        } catch {
          iziToast.error({ title: this.t('admin.db.toastFailedDeleteSharedPlaylists'), position: 'topCenter', timeout: 3500 });
        } finally {
          this.isPullingShared = false;
        }
      });
    },
    deleteExpiredShared: async function() {
      try {
        this.isPullingShared = true;
        await ADMINDATA.deleteExpiredShared();
        await ADMINDATA.getSharedPlaylists();
      } catch {
        iziToast.error({ title: this.t('admin.db.toastFailedPullData'), position: 'topCenter', timeout: 3500 });
      } finally {
        this.isPullingShared = false;
      }
    },
  }
});

// ── Backup View ──────────────────────────────────────────────────────────────
const backupView = Vue.component('backup-view', {
  data() {
    return {
      backups: [],
      isLoading: true,
      isCreating: false,
    };
  },
  mounted: async function() {
    await this.loadBackups();
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{ t('admin.backup.title') }}</span>
              <p style="color:var(--t2);margin-bottom:1rem;">{{ t('admin.backup.desc') }}</p>
              <div v-if="isLoading" style="text-align:center;padding:2rem 0;">
                <svg class="spinner" width="40px" height="40px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
              </div>
              <div v-else>
                <div v-if="backups.length === 0" style="color:var(--t2);margin:.5rem 0 1rem;">{{ t('admin.backup.noBackups') }}</div>
                <table v-else>
                  <thead>
                    <tr>
                      <th>{{ t('admin.backup.colFilename') }}</th>
                      <th>{{ t('admin.backup.colSize') }}</th>
                      <th>{{ t('admin.backup.colCreated') }}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="b in backups" :key="b.filename">
                      <td style="font-family:monospace;font-size:.85rem;">{{b.filename}}</td>
                      <td>{{formatBytes(b.size)}}</td>
                      <td>{{formatDate(b.mtime)}}</td>
                      <td><a class="btn-sm btn-sm-download" title="Download" style="cursor:pointer;" @click="downloadBackup(b.filename)">{{ t('admin.backup.btnDownload') }}</a></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div class="card-action">
              <button class="btn" type="button" :disabled="isCreating" @click="createBackup()">
                <span v-if="isCreating">{{ t('admin.backup.btnCreating') }}</span>
                <span v-else>{{ t('admin.backup.btnCreate') }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  methods: {
    loadBackups: async function() {
      this.isLoading = true;
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/backups` });
        this.backups = res.data;
      } catch {
        iziToast.error({ title: this.t('admin.backup.toastFailedLoad'), position: 'topCenter', timeout: 3500 });
      }
      this.isLoading = false;
    },
    createBackup: async function() {
      this.isCreating = true;
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/backup` });
        iziToast.success({ title: this.t('admin.backup.toastCreated'), position: 'topCenter', timeout: 3500 });
        await this.loadBackups();
      } catch {
        iziToast.error({ title: this.t('admin.backup.toastFailed'), position: 'topCenter', timeout: 3500 });
        this.isCreating = false;
      }
      this.isCreating = false;
    },
    downloadBackup: async function(filename) {
      try {
        const response = await API.axios({
          url: `${API.url()}/api/v1/admin/backup/download/${encodeURIComponent(filename)}`,
          method: 'GET',
          responseType: 'blob',
        });
        const url = window.URL.createObjectURL(new Blob([response.data]));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', filename);
        document.body.appendChild(link);
        link.click();
        link.remove();
      } catch {
        iziToast.error({ title: this.t('admin.backup.toastDownloadFailed'), position: 'topCenter', timeout: 3500 });
      }
    },
    formatBytes: function(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    },
    formatDate: function(ms) {
      if (!ms) return '—';
      return new Date(ms).toLocaleString();
    },
  }
});

// ── Migrate View (Import-Export) ─────────────────────────────────────────────
const migrateView = Vue.component('migrate-view', {
  data() {
    return {
      // Export state
      exportJobId: null,          // null = idle
      exportStatus: null,         // 'building' | 'ready' | 'error'
      exportFilename: null,
      exportSizeBytes: null,
      exportError: null,
      exportPollTimer: null,
      includeWaveforms: true,
      includeArtistImages: false,
      isDownloading: false,
    };
  },
  beforeDestroy() {
    this.stopPoll();
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{ t('admin.migrate.title') }}</span>
              <p style="color:var(--t2);margin-bottom:1.5rem;">{{ t('admin.migrate.desc') }}</p>

              <!-- Export Section -->
              <div style="margin-bottom:2rem;">
                <h5 style="margin:0 0 1rem 0;color:var(--t1);">{{ t('admin.migrate.exportTitle') }}</h5>
                <p style="color:var(--t2);margin-bottom:1rem;font-size:.9rem;">{{ t('admin.migrate.exportDesc') }}</p>

                <!-- Idle: options + prepare button -->
                <div v-if="exportStatus === null">
                  <div style="margin-bottom:1rem;">
                    <label style="display:flex;align-items:center;gap:.75rem;cursor:pointer;">
                      <input type="checkbox" v-model="includeWaveforms">
                      <span style="font-size:.9rem;">{{ t('admin.migrate.includeWaveforms') }}</span>
                    </label>
                  </div>
                  <div style="margin-bottom:1.5rem;">
                    <label style="display:flex;align-items:center;gap:.75rem;cursor:not-allowed;opacity:.45;">
                      <input type="checkbox" disabled>
                      <span style="font-size:.9rem;">{{ t('admin.migrate.includeArtistImages') }}</span>
                    </label>
                    <p style="font-size:.8rem;color:var(--t3);margin:.25rem 0 0 2rem;">{{ t('admin.migrate.artistImagesUnavailable') }}</p>
                  </div>
                  <button class="btn" type="button" @click="startExport()">{{ t('admin.migrate.btnPrepare') }}</button>
                </div>

                <!-- Building: spinner -->
                <div v-if="exportStatus === 'building'" style="display:flex;align-items:center;gap:1rem;padding:.75rem 0;">
                  <div class="preloader-wrapper small active" style="width:24px;height:24px;">
                    <div class="spinner-layer"><div class="circle-clipper left"><div class="circle"></div></div><div class="gap-patch"><div class="circle"></div></div><div class="circle-clipper right"><div class="circle"></div></div></div>
                  </div>
                  <span style="color:var(--t2);font-size:.9rem;">{{ t('admin.migrate.exportBuilding') }}</span>
                </div>

                <!-- Ready: size + download button -->
                <div v-if="exportStatus === 'ready'" style="margin-top:.5rem;">
                  <div class="card" style="background:var(--raised);border:1px solid var(--border);margin-bottom:1rem;">
                    <div class="card-content" style="padding:1rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.75rem;">
                      <div>
                        <div style="font-weight:600;color:var(--t1);margin-bottom:.25rem;">{{ t('admin.migrate.exportReadyLabel') }}</div>
                        <div style="font-size:.85rem;color:var(--t2);">{{ exportFilename }}</div>
                        <div style="font-size:.85rem;color:var(--t2);">{{ t('admin.migrate.exportSizeLabel') }}: <b>{{ formatBytes(exportSizeBytes) }}</b></div>
                      </div>
                      <div style="display:flex;gap:.75rem;align-items:center;">
                        <button class="btn" type="button" :disabled="isDownloading" @click="downloadExport()">
                          <span v-if="isDownloading">{{ t('admin.migrate.btnExporting') }}</span>
                          <span v-else>{{ t('admin.migrate.btnDownloadExport') }}</span>
                        </button>
                        <a style="cursor:pointer;font-size:.85rem;color:var(--t3);" @click="resetExport()">{{ t('admin.migrate.btnNewExport') }}</a>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Error -->
                <div v-if="exportStatus === 'error'" style="margin-top:.5rem;">
                  <div style="color:var(--error,#e53935);font-size:.9rem;margin-bottom:.75rem;">{{ t('admin.migrate.toastExportFailed') }}: {{ exportError }}</div>
                  <button class="btn btn-flat" type="button" @click="resetExport()">{{ t('admin.migrate.btnNewExport') }}</button>
                </div>
              </div>

              <div style="border-top:1px solid var(--border);margin:2rem 0;"></div>

              <!-- Import Section (disabled) -->
              <div>
                <h5 style="margin:0 0 .5rem 0;color:var(--t1);">{{ t('admin.migrate.importTitle') }}</h5>
                <p style="color:var(--t3);font-size:.85rem;margin-bottom:1rem;">{{ t('admin.migrate.importDisabledDesc') }}</p>
                <div style="opacity:.4;pointer-events:none;user-select:none;">
                  <p style="color:var(--t2);margin-bottom:1rem;font-size:.9rem;">{{ t('admin.migrate.importDesc') }}</p>
                  <button class="btn" type="button" disabled>{{ t('admin.migrate.btnUpload') }}</button>
                </div>
              </div>

            </div>
          </div>
        </div>
      </div>
    </div>`,
  methods: {
    startExport: async function() {
      this.exportStatus = 'building';
      this.exportJobId = null;
      this.exportError = null;
      try {
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/migrate/export/start`,
          data: { includeWaveforms: this.includeWaveforms, includeArtistImages: this.includeArtistImages }
        });
        this.exportJobId = res.data.id;
        iziToast.info({ title: this.t('admin.migrate.toastExportStarted'), position: 'topCenter', timeout: 3000 });
        this.exportPollTimer = setInterval(() => this.pollExportStatus(), 2500);
      } catch (e) {
        this.exportStatus = 'error';
        this.exportError = e.response?.data?.error ?? e.message;
        iziToast.error({ title: this.t('admin.migrate.toastExportFailed'), position: 'topCenter', timeout: 3500 });
      }
    },
    pollExportStatus: async function() {
      if (!this.exportJobId) return;
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/migrate/export/status/${this.exportJobId}` });
        const { status, filename, sizeBytes, error } = res.data;
        if (status === 'ready') {
          this.stopPoll();
          this.exportStatus = 'ready';
          this.exportFilename = filename;
          this.exportSizeBytes = sizeBytes;
          iziToast.success({ title: this.t('admin.migrate.toastExportReady'), position: 'topCenter', timeout: 4000 });
        } else if (status === 'error') {
          this.stopPoll();
          this.exportStatus = 'error';
          this.exportError = error ?? 'Unknown error';
          iziToast.error({ title: this.t('admin.migrate.toastExportFailed'), position: 'topCenter', timeout: 3500 });
        }
      } catch { /* will retry on next tick */ }
    },
    stopPoll: function() {
      if (this.exportPollTimer) {
        clearInterval(this.exportPollTimer);
        this.exportPollTimer = null;
      }
    },
    downloadExport: async function() {
      if (!this.exportJobId) return;
      this.isDownloading = true;
      try {
        const response = await API.axios({
          url: `${API.url()}/api/v1/admin/migrate/export/download/${this.exportJobId}`,
          method: 'GET',
          responseType: 'blob',
        });
        const url = window.URL.createObjectURL(new Blob([response.data]));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', this.exportFilename ?? `velvet-export.zip`);
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(url);
        iziToast.success({ title: this.t('admin.migrate.toastExportSuccess'), position: 'topCenter', timeout: 3500 });
        this.resetExport();
      } catch (e) {
        iziToast.error({ title: this.t('admin.migrate.toastExportFailed'), position: 'topCenter', timeout: 3500 });
      } finally {
        this.isDownloading = false;
      }
    },
    resetExport: function() {
      this.stopPoll();
      this.exportJobId = null;
      this.exportStatus = null;
      this.exportFilename = null;
      this.exportSizeBytes = null;
      this.exportError = null;
    },
    formatBytes: function(bytes) {
      if (!bytes) return '—';
      if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
      if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
      return (bytes / 1024).toFixed(0) + ' KB';
    },
  }
});

const rpnView = Vue.component('rpn-view', {
  data() {
    return {
      activeTab: 'standard',
      submitPending: false
    };
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <h1>Velvet RPN</h1>
          <div class="card">
            <div class="tabs">
              <div class="tab"><button :class="{active: activeTab==='standard'}" @click="activeTab='standard'">Standard</button></div>
              <div class="tab"><button :class="{active: activeTab==='advanced'}" @click="activeTab='advanced'">Advanced</button></div>
            </div>
            <div id="test1" v-show="activeTab==='standard'">
              <form @submit.prevent="standardLogin">
                <div class="card-content">
                  <span class="card-title">Login</span>
                  <div class="row">
                    <div class="col s12 m6">
                      <div class="row">
                        <div class="input-field col s12">
                          <input id="rpn-simple-username" required type="text">
                          <label for="rpn-simple-username">Username</label>
                        </div>
                      </div>
                      <div class="row">
                        <div class="input-field col s12">
                          <input id="rpn-simple-password" required type="password">
                          <label for="rpn-simple-password">Password</label>
                        </div>
                      </div>
                    </div>
                    <div class="col s12 m6 hide-on-small-only">
                      <div class="row">
                        <h5 class="center-align">Help Support Velvet</h5>
                      </div>
                      <div class="row">
                        <div class="col s2"></div>
                        <a target="_blank" href="https://velvet.io/reverse-proxy-network" class="btn blue">Sign Up</a>
                        <div class="col s2"></div>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="card-action">
                  <button class="btn" type="submit" :disabled="submitPending === true">
                    {{submitPending === false ? 'Login to RPN' : 'Pending...'}}
                  </button>
                </div>
              </form>
            </div>
            <div id="test2" v-show="activeTab==='advanced'">
              <form @submit.prevent="advancedLogin">
                <div class="card-content">
                  <span class="card-title">Config</span>
                  <div class="row">
                    <div class="col s12 m12 l6">
                      <div class="row">
                        <div class="input-field col s12">
                          <input id="rpn-advanced-address" required type="text">
                          <label for="rpn-advanced-address">Server Address</label>
                        </div>
                      </div>
                      <div class="row">
                        <div class="input-field col s12">
                          <input id="rpn-advanced-port" required type="number" type="number" min="2" max="65535">
                          <label for="rpn-advanced-port">Port</label>
                        </div>
                      </div>
                      <div class="row">
                        <div class="input-field col s12">
                          <input id="rpn-advanced-domain" required type="text">
                          <label for="rpn-advanced-domain">Server Domain</label>
                        </div>
                      </div>
                      <div class="row">
                        <div class="input-field col s12">
                          <input id="rpn-advanced-password" required type="password">
                          <label for="rpn-advanced-password">Server Key</label>
                        </div>
                      </div>
                    </div>
                    <div class="col s12 m12 l6">
                      <h5>
                        <a target="_blank" href="https://github.com/fog-machine/tunnel-server">
                          Check the docs to learn how to deploy your own server
                        </a>
                      </h5>
                    </div>
                  </div>
                </div>
                <div class="card-action">
                  <button class="btn" type="submit" :disabled="submitPending === true">
                    {{submitPending === false ? 'Connect To Server' : 'Connecting...'}}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
      <div class="row">
        <h4>Features</h4>
        <ul class="browser-default">
          <li>Choose your own domain @ https://your-name.velvet.io</li>
          <li>Automatic SSL Encryption for your server</li>
          <li>'Hole Punching' software guarantees your server stays online as long as you have a working internet connection</li>
          <li>IP Obfuscation hides your IP address and adds an additional layer of security</li>  
        </ul>
      </div>
    </div>`,
  methods: {
    standardLogin: function() {
      console.log('STAND')
    },
    advancedLogin: function() {
      console.log('ADV')
    }
  }
});

const infoView = Vue.component('info-view', {
  data() {
    return {
      version: ADMINDATA.version,
      telemetryPending: false,
    };
  },
  template: `
    <div class="container">
      <div class="row logo-row-velvet" style="display:flex;align-items:center;gap:14px;padding:0 0 8px;">
        <img src="/assets/img/velvet-logo.svg" alt="Velvet" width="72" height="72">
        <div>
          <div style="font-size:1.6rem;font-weight:700;line-height:1.1;color:var(--t1);">Velvet</div>
          <div style="font-size:.8rem;color:var(--t3);margin-top:2px;">{{t('admin.info.adminPanel')}}</div>
        </div>
      </div>
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <h4 style="margin:0 0 .25rem;font-size:1.3rem;font-weight:700;color:var(--t1);">Velvet <span style="color:var(--primary);font-size:1rem;">v{{version.val}}</span></h4>
              <p style="margin:0 0 1.25rem;color:var(--t2);font-size:.85rem;">{{t('admin.info.creditMaintainer')}}</p>
              <div style="margin-bottom:1.25rem;display:flex;gap:.75rem;flex-wrap:wrap;">
                <a href="https://github.com/aroundmyroom/Velvet" target="_blank" style="display:inline-flex;align-items:center;gap:8px;background:var(--raised);border:1px solid var(--border);color:var(--t1);text-decoration:none;padding:.5rem 1rem;border-radius:6px;font-size:.85rem;font-weight:600;">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12c0 4.418 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.868-.013-1.703-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836a9.59 9.59 0 0 1 2.504.337c1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.202 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z"/></svg>
                  {{t('admin.info.btnGithub')}}
                </a>
                <a href="https://discord.gg/KfsTCYrTkS" target="_blank" style="display:inline-flex;align-items:center;gap:8px;background:#5865F2;color:#fff;text-decoration:none;padding:.5rem 1rem;border-radius:6px;font-size:.85rem;font-weight:600;">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
                  {{t('admin.info.btnDiscord')}}
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{t('admin.info.telemetryTitle')}}</span>
              <p style="color:var(--t2);margin-bottom:.75rem;">{{t('admin.info.telemetryDesc')}}</p>
              <p style="color:var(--t2);margin-bottom:.5rem;font-size:.85rem;"><strong style="color:var(--t1);">{{t('admin.info.telemetryDataTitle')}}</strong></p>
              <pre style="background:var(--raised);border:1px solid var(--border);border-radius:6px;padding:.65rem .9rem;font-size:.78rem;color:var(--t2);margin:0 0 1rem;overflow-x:auto;">{"id":"&lt;random UUID, generated once on first boot&gt;","version":"&lt;current version&gt;","platform":"linux","runtime":"docker","lastSeen":"2026-04-04T12:34:49.943Z"}</pre>
              <p style="color:var(--t2);font-size:.85rem;margin-bottom:0;">{{t('admin.info.telemetryPrivacy')}}</p>
            </div>
          </div>
        </div>
      </div>
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{t('admin.info.legalTitle')}}</span>
              <p style="color:var(--t2);font-size:.85rem;line-height:1.6;margin-bottom:.9rem;">
                {{t('admin.info.legalGpl')}}
                <a href="https://www.gnu.org/licenses/gpl-3.0.html" target="_blank" rel="noopener" style="color:var(--primary);">GNU General Public License v3.0</a>.
                {{t('admin.info.legalNoWarranty')}}
              </p>
              <div style="background:var(--raised);border:1px solid var(--border);border-radius:6px;padding:.7rem 1rem;font-size:.82rem;color:var(--t2);line-height:1.7;margin-bottom:.9rem;">
                <div>© 2015–2026 IrosTheBeggar &mdash; {{t('admin.info.legalOriginalAuthor')}}</div>
                <div>© 2026 AroundMyRoom &mdash; {{t('admin.info.legalForkAuthor')}}</div>
              </div>
              <p style="color:var(--t3);font-size:.8rem;margin-bottom:0;">
                {{t('admin.info.legalSourceRef')}}
                <a href="https://github.com/IrosTheBeggar/Velvet" target="_blank" rel="noopener" style="color:var(--t2);">github.com/IrosTheBeggar/Velvet</a>.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>`
});

// ── Sonos Admin View ────────────────────────────────────────────────────────
const sonosView = Vue.component('sonos-view', {
  data() {
    return {
      enabled:      true,
      transcodeOpus: false,
      togglingTranscodeOpus: false,
      rooms:        [],
      scanning:     false,
      probing:      false,
      testing:      false,
      stopping:     false,
      savingDefault: false,
      togglingEnabled: false,
      seedIp:       '',
      probeIp:      '',
      testIp:       '',
      probeResult:  null,
      testResult:   null,
      defaultRoom:  null,
      error:        null,
      lastScan:     null,
      infoRoom:     null,
      infoData:     null,
      infoLoading:  false,
    };
  },
  template: `
    <div class="admin-panel">
      <h2 class="admin-section-title">{{ this.t('admin.sonos.title') }}</h2>
      <p class="admin-description">{{ this.t('admin.sonos.desc') }}</p>

      <!-- Enable/Disable toggle -->
      <div class="admin-card" style="margin-bottom:1.5rem;">
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="padding:.5rem 0;">
              <b>{{ this.t('admin.sonos.labelEnabled') }}</b>
              <span v-if="enabled" style="display:inline-block;margin-left:8px;padding:2px 10px;border-radius:12px;background:var(--green);color:#fff;font-size:.82rem;font-weight:600">{{ this.t('admin.sonos.statusEnabled') }}</span>
              <span v-else style="display:inline-block;margin-left:8px;padding:2px 10px;border-radius:12px;background:var(--t3,#888);color:#fff;font-size:.82rem;font-weight:600">{{ this.t('admin.sonos.statusDisabled') }}</span>
              <div style="font-size:.82rem;color:var(--t2);margin-top:4px">{{ this.t('admin.sonos.helpEnabled') }}</div>
            </td>
            <td style="text-align:right;white-space:nowrap;">
              <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none" :title="enabled ? this.t('admin.sonos.btnDisable') : this.t('admin.sonos.btnEnable')">
                <span style="position:relative;display:inline-block;width:44px;height:24px">
                  <input type="checkbox" :checked="enabled" @change="toggleEnabled()" style="opacity:0;width:0;height:0;position:absolute" :disabled="togglingEnabled">
                  <span :style="{ position:'absolute', inset:0, borderRadius:'12px', background: enabled ? 'var(--primary,#6366f1)' : 'var(--t3,#888)', transition:'background 0.2s', cursor: togglingEnabled ? 'not-allowed' : 'pointer' }"></span>
                  <span :style="{ position:'absolute', top:'3px', left: enabled ? '23px' : '3px', width:'18px', height:'18px', borderRadius:'50%', background:'#fff', transition:'left 0.2s', pointerEvents:'none' }"></span>
                </span>
                <span style="font-size:.85rem;color:var(--t2)">{{ enabled ? this.t('admin.sonos.btnDisable') : this.t('admin.sonos.btnEnable') }}</span>
              </label>
            </td>
          </tr>
        </table>
      </div>

      <!-- Sonos Opus Transcoding -->
      <div class="admin-card" style="margin-bottom:1.5rem;">
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="padding:.5rem 0;">
              <b>{{ this.t('admin.sonos.labelTranscode') }}</b>
              <div style="font-size:.82rem;color:var(--t2);margin-top:4px">{{ this.t('admin.sonos.helpTranscode') }}</div>
            </td>
            <td style="text-align:right;white-space:nowrap;">
              <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none">
                <span style="position:relative;display:inline-block;width:44px;height:24px">
                  <input type="checkbox" :checked="transcodeOpus" @change="toggleTranscodeOpus()" style="opacity:0;width:0;height:0;position:absolute" :disabled="togglingTranscodeOpus">
                  <span :style="{ position:'absolute', inset:0, borderRadius:'12px', background: transcodeOpus ? 'var(--primary,#6366f1)' : 'var(--t3,#888)', transition:'background 0.2s', cursor: togglingTranscodeOpus ? 'not-allowed' : 'pointer' }"></span>
                  <span :style="{ position:'absolute', top:'3px', left: transcodeOpus ? '23px' : '3px', width:'18px', height:'18px', borderRadius:'50%', background:'#fff', transition:'left 0.2s', pointerEvents:'none' }"></span>
                </span>
                <span style="font-size:.85rem;color:var(--t2)">{{ transcodeOpus ? this.t('admin.sonos.statusEnabled') : this.t('admin.sonos.statusDisabled') }}</span>
              </label>
            </td>
          </tr>
        </table>
      </div>

      <div class="admin-card" style="margin-bottom:1.5rem;">
        <h3 style="margin:0 0 .75rem;font-size:1rem;">{{ this.t('admin.sonos.probeTitle') }}</h3>
        <p style="margin:0 0 .75rem;font-size:.85rem;opacity:.7;">{{ this.t('admin.sonos.probeDesc') }}</p>
        <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;">
          <input class="admin-input" type="text" v-model="probeIp" placeholder="192.168.1.x" style="width:180px;" @keyup.enter="probeDevice" />
          <button class="btn btn-primary" :disabled="probing || !probeIp.trim()" @click="probeDevice">
            <span v-if="probing">{{ this.t('admin.sonos.probing') }}</span>
            <span v-else>{{ this.t('admin.sonos.probeBtn') }}</span>
          </button>
        </div>
        <div v-if="probeResult" style="margin-top:.75rem;padding:.75rem;border-radius:6px;background:var(--raised);font-size:.9rem;">
          <div v-if="probeResult.ok" style="color:var(--green);">
            ✓ {{ probeResult.name }} <span style="opacity:.6;font-size:.8rem;">({{ probeResult.model }})</span>
          </div>
          <div v-else style="color:var(--red);">
            ✗ {{ this.t('admin.sonos.probeNoDevice') }}: {{ probeResult.error }}
          </div>
        </div>
      </div>

      <!-- Probe a single IP -->
      <div class="admin-card" style="margin-bottom:1.5rem;">
        <h3 style="margin:0 0 .75rem;font-size:1rem;">{{ this.t('admin.sonos.discoverTitle') }}</h3>
        <p style="margin:0 0 .75rem;font-size:.85rem;opacity:.7;">{{ this.t('admin.sonos.discoverDesc') }}</p>
        <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:.75rem;">
          <input class="admin-input" type="text" v-model="seedIp" :placeholder="this.t('admin.sonos.seedIpPlaceholder')" style="width:180px;" />
          <button class="btn btn-primary" :disabled="scanning" @click="scanDevices">
            <span v-if="scanning">{{ this.t('admin.sonos.scanning') }}</span>
            <span v-else>{{ this.t('admin.sonos.scanBtn') }}</span>
          </button>
        </div>
        <div v-if="error" style="color:var(--red);margin-bottom:.75rem;font-size:.85rem;">{{ error }}</div>
        <div v-if="lastScan" style="opacity:.55;font-size:.78rem;margin-bottom:.75rem;">
          {{ this.t('admin.sonos.lastScan') }}: {{ new Date(lastScan).toLocaleTimeString() }}
        </div>
        <div v-if="defaultRoom" style="margin-bottom:.75rem;font-size:.85rem;padding:.5rem .75rem;border-radius:6px;background:var(--raised);">
          ★ {{ this.t('admin.sonos.defaultRoom') }}: <strong>{{ defaultRoom.name }}</strong> <span style="opacity:.6;font-family:monospace;font-size:.8rem;">({{ defaultRoom.ip }})</span>
        </div>
        <div v-if="rooms.length === 0 && !scanning" style="opacity:.55;font-size:.9rem;">
          {{ this.t('admin.sonos.noRooms') }}
        </div>
        <div v-if="rooms.length > 0">
          <table style="width:100%;border-collapse:collapse;font-size:.88rem;">
            <thead>
              <tr style="border-bottom:1px solid var(--border);opacity:.6;">
                <th style="text-align:left;padding:.4rem .5rem;">{{ this.t('admin.sonos.colRoom') }}</th>
                <th style="text-align:left;padding:.4rem .5rem;">{{ this.t('admin.sonos.colIp') }}</th>
                <th style="text-align:left;padding:.4rem .5rem;">{{ this.t('admin.sonos.colModel') }}</th>
                <th style="text-align:left;padding:.4rem .5rem;">{{ this.t('admin.sonos.colGroup') }}</th>
                <th style="padding:.4rem .5rem;"></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="r in rooms" :key="r.uuid || r.ip">
              <tr style="border-bottom:1px solid var(--border2);">
                <td style="padding:.4rem .5rem;font-weight:500;">
                  <span v-if="defaultRoom && defaultRoom.ip === r.ip" style="color:var(--accent);margin-right:.35rem;" title="Default cast target">★</span>{{ r.name }}
                </td>
                <td style="padding:.4rem .5rem;font-family:monospace;font-size:.82rem;">{{ r.ip }}</td>
                <td style="padding:.4rem .5rem;opacity:.7;">{{ r.model }}</td>
                <td style="padding:.4rem .5rem;opacity:.7;">{{ r.groupName || '—' }}</td>
                <td style="padding:.4rem .5rem;white-space:nowrap;">
                  <button class="btn btn-small" style="font-size:.75rem;padding:.2rem .5rem;margin-right:.25rem;" :disabled="testing" @click="testIp = r.ip; testResult = null; testPlay()">▶ Test</button>
                  <button class="btn btn-small" :disabled="savingDefault" style="font-size:.75rem;padding:.2rem .5rem;margin-right:.25rem;" :style="defaultRoom && defaultRoom.ip === r.ip ? 'opacity:.4;cursor:default;' : ''" @click="saveDefault(r)">
                    <span v-if="savingDefault && testIp === r.ip">{{ this.t('admin.sonos.savingDefault') }}</span>
                    <span v-else>★ {{ this.t('admin.sonos.setDefault') }}</span>
                  </button>
                  <button class="btn btn-small" style="font-size:.75rem;padding:.2rem .4rem;" :style="infoRoom === r.ip ? 'background:var(--primary);color:#fff;' : ''" @click="fetchDeviceInfo(r)" title="Device info">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="display:inline;vertical-align:middle;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                  </button>
                </td>
              </tr>
              <tr v-if="infoRoom === r.ip" style="background:color-mix(in srgb,var(--bg2) 70%,var(--surface));">
                <td colspan="5" style="padding:.6rem 1rem .75rem;">
                  <div v-if="infoLoading" style="font-size:.82rem;opacity:.55;padding:.25rem 0;">Loading…</div>
                  <div v-else-if="infoData" style="font-size:.82rem;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:.25rem .75rem;">
                    <div v-if="infoData.firmware"><span style="opacity:.55;">Firmware:</span> <strong>{{ infoData.firmware }}</strong><span v-if="infoData.firmwareDate" style="opacity:.5;"> · {{ infoData.firmwareDate }}</span></div>
                    <div v-if="infoData.ipAddress"><span style="opacity:.55;">IP:</span> <strong style="font-family:monospace;">{{ infoData.ipAddress }}</strong></div>
                    <div v-if="infoData.macAddress"><span style="opacity:.55;">MAC:</span> <strong style="font-family:monospace;">{{ infoData.macAddress }}</strong></div>
                    <div v-if="infoData.model"><span style="opacity:.55;">Hardware:</span> <strong>{{ infoData.model }}</strong></div>
                    <div v-if="infoData.seriesId"><span style="opacity:.55;">Series:</span> <strong>{{ infoData.seriesId }}</strong></div>
                    <div v-if="infoData.wifi"><span style="opacity:.55;">Network:</span> <strong>{{ infoData.wifi }}</strong><span v-if="infoData.wifiMode" style="opacity:.5;"> · {{ infoData.wifiMode }}</span></div>
                    <div v-if="infoData.battery && infoData.battery.supported"><span style="opacity:.55;">Battery:</span> <strong :style="infoData.battery.level <= 20 ? 'color:#f97316' : infoData.battery.level <= 50 ? 'color:#facc15' : ''">{{ infoData.battery.powerSource === 'USB_POWER' ? '⚡' : '🔋' }} {{ infoData.battery.level }}%</strong><span v-if="!/^(good|green|ok|okay|normal)$/i.test(infoData.battery.health)" style="opacity:.5;"> · {{ infoData.battery.health.replaceAll(/_/g,' ').toLowerCase() }}</span><span v-if="infoData.battery.temperature && infoData.battery.temperature !== 'NORMAL'" style="opacity:.5;"> ⚠&#xFE0E; {{ infoData.battery.temperature.replaceAll(/_/g,' ').toLowerCase() }}</span></div>
                  </div>
                  <div v-else style="font-size:.82rem;color:var(--red);">Failed to load</div>
                </td>
              </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Test Playback -->
      <div class="admin-card">
        <h3 style="margin:0 0 .75rem;font-size:1rem;">{{ this.t('admin.sonos.testTitle') }}</h3>
        <p style="margin:0 0 .75rem;font-size:.85rem;opacity:.7;">{{ this.t('admin.sonos.testDesc') }}</p>
        <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:.75rem;">
          <input class="admin-input" type="text" v-model="testIp" placeholder="192.168.1.x" style="width:180px;" @keyup.enter="testPlay" />
          <button class="btn btn-primary" :disabled="testing || stopping || !testIp.trim()" @click="testPlay">
            <span v-if="testing">{{ this.t('admin.sonos.testPlaying') }}</span>
            <span v-else>{{ this.t('admin.sonos.testBtn') }}</span>
          </button>
          <button class="btn" :disabled="testing || stopping || !testIp.trim()" @click="stopPlay" style="background:var(--raised);">
            <span v-if="stopping">…</span>
            <span v-else>⏹ {{ this.t('admin.sonos.stopBtn') }}</span>
          </button>
        </div>
        <div v-if="testResult" style="margin-top:.5rem;padding:.75rem;border-radius:6px;background:var(--raised);font-size:.9rem;">
          <div v-if="testResult.ok" style="color:var(--green);">
            ✓ {{ this.t('admin.sonos.testOk') }} <strong>{{ testResult.artist }}</strong> — {{ testResult.title }}
          </div>
          <div v-else style="color:var(--red);">
            ✗ {{ this.t('admin.sonos.testFail') }}: {{ testResult.error }}
          </div>
        </div>
      </div>
    </div>`,
  async mounted() {
    await this.loadDevices();
  },
  methods: {
    async loadDevices() {
      this.scanning = true; this.error = null;
      try {
        const r = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/sonos/devices` });
        this.rooms = r.data.rooms || [];
        this.lastScan = r.data.lastScan;
        this.defaultRoom = r.data.defaultRoom || null;
        this.enabled = r.data.enabled !== false;
        this.transcodeOpus = r.data.transcodeOpus === true;
        if (this.rooms.length > 0 && !this.testIp) this.testIp = this.rooms[0].ip;
      } catch (e) {
        this.error = e?.response?.data?.error || e.message;
      } finally { this.scanning = false; }
    },
    async toggleEnabled() {
      const next = !this.enabled;
      this.togglingEnabled = true;
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/sonos`, data: { enabled: next } });
        this.enabled = next;
      } catch (e) {
        this.error = e?.response?.data?.error || e.message;
      } finally { this.togglingEnabled = false; }
    },
    async toggleTranscodeOpus() {
      const next = !this.transcodeOpus;
      this.togglingTranscodeOpus = true;
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/sonos`, data: { transcodeOpus: next } });
        this.transcodeOpus = next;
      } catch (e) {
        this.error = e?.response?.data?.error || e.message;
      } finally { this.togglingTranscodeOpus = false; }
    },
    async scanDevices() {
      this.scanning = true; this.error = null; this.rooms = [];
      try {
        const body = this.seedIp.trim() ? { seedIp: this.seedIp.trim() } : {};
        const r = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/sonos/scan`, data: body });
        this.rooms = r.data.rooms || [];
        this.lastScan = r.data.lastScan;
        if (this.rooms.length > 0 && !this.testIp) this.testIp = this.rooms[0].ip;
        if (this.rooms.length === 0) this.error = this.t('admin.sonos.noRoomsFound');
      } catch (e) {
        this.error = e?.response?.data?.error || e.message;
      } finally { this.scanning = false; }
    },
    async saveDefault(room) {
      this.savingDefault = true;
      try {
        const r = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/sonos/save-default`, data: { ip: room.ip, name: room.name, uuid: room.uuid || '' } });
        this.defaultRoom = r.data.defaultRoom;
      } catch (e) {
        this.error = e?.response?.data?.error || e.message;
      } finally { this.savingDefault = false; }
    },
    async fetchDeviceInfo(room) {
      if (this.infoRoom === room.ip) { this.infoRoom = null; this.infoData = null; return; }
      this.infoRoom = room.ip; this.infoData = null; this.infoLoading = true;
      try {
        const [infoRes, batRes] = await Promise.all([
          API.axios({ method: 'GET', url: `${API.url()}/api/v1/sonos/device-info?ip=${encodeURIComponent(room.ip)}` }),
          API.axios({ method: 'GET', url: `${API.url()}/api/v1/sonos/battery?ip=${encodeURIComponent(room.ip)}` }).catch(() => ({ data: { supported: false } })),
        ]);
        this.infoData = { ...infoRes.data, battery: batRes.data };
      } catch {
        this.infoData = null;
      } finally { this.infoLoading = false; }
    },
    async probeDevice() {
      const ip = this.probeIp.trim(); if (!ip) return;
      this.probing = true; this.probeResult = null;
      try {
        const r = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/sonos/probe?ip=${encodeURIComponent(ip)}` });
        this.probeResult = r.data;
        // Auto-fill testIp when probe succeeds
        if (r.data.ok) this.testIp = ip;
      } catch (e) {
        this.probeResult = { ok: false, error: e?.response?.data?.error || e.message };
      } finally { this.probing = false; }
    },
    async testPlay() {
      const ip = this.testIp.trim(); if (!ip) return;
      this.testing = true; this.testResult = null;
      try {
        const r = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/sonos/test-play`, data: { ip } });
        this.testResult = r.data;
      } catch (e) {
        this.testResult = { ok: false, error: e?.response?.data?.error || e.message };
      } finally { this.testing = false; }
    },
    async stopPlay() {
      const ip = this.testIp.trim(); if (!ip) return;
      this.stopping = true;
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/sonos/set-pause`, data: { ip, paused: true } });
        this.testResult = null;
      } catch (e) {
        this.testResult = { ok: false, error: e?.response?.data?.error || e.message };
      } finally { this.stopping = false; }
    },
  },
});

// ── Server Audio Admin View ────────────────────────────────────────────────
const serverAudioView = Vue.component('server-audio-view', {
  data() {
    return {
      params: ADMINDATA.serverAudioParams,
      paramsTS: ADMINDATA.serverAudioParamsUpdated,
      mpvPath: '',
      detecting: false,
      detectResult: null,
      healthLoading: false,
      healthFixing: false,
      audioHealth: null,
      actionBusy: {
        detect: false,
        start: false,
        stop: false,
        check: false,
        fix: false,
        guided: false,
        tone: false,
      },
      lastAction: {
        ok: null,
        message: '',
        at: 0,
      },
      guidedSteps: [],
    };
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card" style="margin-bottom:10px">
            <div class="card-content">
              <span class="card-title">{{t('admin.serverAudio.title')}} <span style="font-size:.7em;font-weight:400;color:var(--t2)">{{t('admin.serverAudio.subtitleMpv')}}</span></span>
              <p style="color:var(--t2);font-size:.92rem;margin-bottom:18px">
                {{t('admin.serverAudio.desc')}}
                {{t('admin.serverAudio.remoteHint')}}
              </p>
              <div v-if="paramsTS.ts === 0" style="padding:16px 0;display:flex;justify-content:center">
                <svg class="spinner" width="48px" height="48px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
              </div>
              <div v-else>
                <table>
                  <tbody>
                    <tr>
                      <td>
                        <b>{{t('admin.serverAudio.labelStatus')}}</b>
                        <span v-if="params.running" style="display:inline-block;margin-left:8px;padding:2px 10px;border-radius:12px;background:var(--green);color:#fff;font-size:.82rem;font-weight:600">{{t('admin.serverAudio.statusRunning')}}</span>
                        <span v-else-if="params.enabled" style="display:inline-block;margin-left:8px;padding:2px 10px;border-radius:12px;background:var(--orange,#f97316);color:#fff;font-size:.82rem;font-weight:600">{{t('admin.serverAudio.statusEnabled')}}</span>
                        <span v-else style="display:inline-block;margin-left:8px;padding:2px 10px;border-radius:12px;background:var(--t3,#888);color:#fff;font-size:.82rem;font-weight:600">{{t('admin.serverAudio.statusDisabled')}}</span>
                        <div style="font-size:.82rem;color:var(--t2);margin-top:4px">{{t('admin.serverAudio.helpStatus')}}</div>
                      </td>
                      <td>
                        <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none">
                          <span style="position:relative;display:inline-block;width:44px;height:24px">
                            <input type="checkbox" :checked="params.enabled" @change="toggleEnabled()" style="opacity:0;width:0;height:0;position:absolute">
                            <span :style="{ position:'absolute', inset:0, borderRadius:'12px', background: params.enabled ? 'var(--primary,#6366f1)' : 'var(--t3,#888)', transition:'background 0.2s', cursor:'pointer' }"></span>
                            <span :style="{ position:'absolute', top:'3px', left: params.enabled ? '23px' : '3px', width:'18px', height:'18px', borderRadius:'50%', background:'#fff', transition:'left 0.2s', pointerEvents:'none' }"></span>
                          </span>
                          <span style="font-size:.85rem;color:var(--t2)">{{params.enabled ? t('admin.serverAudio.btnDisable') : t('admin.serverAudio.btnEnable')}}</span>
                        </label>
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <b>{{t('admin.serverAudio.labelAutoUnmute')}}</b>
                        <div style="font-size:.82rem;color:var(--t2);margin-top:4px">{{t('admin.serverAudio.helpAutoUnmute')}}</div>
                      </td>
                      <td>
                        <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none">
                          <span style="position:relative;display:inline-block;width:44px;height:24px">
                            <input type="checkbox" :checked="params.autoUnmute !== false" @change="toggleAutoUnmute()" style="opacity:0;width:0;height:0;position:absolute">
                            <span :style="{ position:'absolute', inset:0, borderRadius:'12px', background: params.autoUnmute !== false ? 'var(--primary,#6366f1)' : 'var(--t3,#888)', transition:'background 0.2s', cursor:'pointer' }"></span>
                            <span :style="{ position:'absolute', top:'3px', left: params.autoUnmute !== false ? '23px' : '3px', width:'18px', height:'18px', borderRadius:'50%', background:'#fff', transition:'left 0.2s', pointerEvents:'none' }"></span>
                          </span>
                          <span style="font-size:.85rem;color:var(--t2)">{{params.autoUnmute !== false ? t('admin.common.on') : t('admin.common.off')}}</span>
                        </label>
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <b>{{t('admin.serverAudio.labelMpvPath')}}</b> <code>{{params.mpvBin || 'mpv'}}</code>
                        <div style="font-size:.82rem;color:var(--t2);margin-top:4px">{{t('admin.serverAudio.helpMpvPath')}}</div>
                      </td>
                      <td>
                        <a v-on:click="changeMpvBin()" class="btn-sm btn-sm-edit">{{t('admin.common.edit')}}</a>
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <b>{{t('admin.serverAudio.btnDetectMpv')}}</b>
                        <div style="font-size:.82rem;color:var(--t2);margin-top:4px">{{t('admin.serverAudio.explainDetectMpv')}}</div>
                      </td>
                      <td><a v-on:click="detectMpv()" class="btn-sm" :title="t('admin.serverAudio.tipDetectMpv')" :style="{ opacity: actionBusy.detect ? 0.6 : 1, pointerEvents: actionBusy.detect ? 'none' : 'auto' }">{{actionBusy.detect ? t('admin.serverAudio.btnDetectMpvBusy') : t('admin.serverAudio.btnDetectMpv')}}</a></td>
                    </tr>
                    <tr>
                      <td>
                        <b>{{t('admin.serverAudio.btnStart')}}</b>
                        <div style="font-size:.82rem;color:var(--t2);margin-top:4px">{{t('admin.serverAudio.explainStartMpv')}}</div>
                      </td>
                      <td><a v-on:click="startMpv()" class="btn-sm" :title="t('admin.serverAudio.tipStartMpv')" :style="{ opacity: actionBusy.start ? 0.6 : 1, pointerEvents: actionBusy.start ? 'none' : 'auto' }">{{actionBusy.start ? t('admin.serverAudio.btnStartBusy') : t('admin.serverAudio.btnStart')}}</a></td>
                    </tr>
                    <tr>
                      <td>
                        <b>{{t('admin.serverAudio.btnStop')}}</b>
                        <div style="font-size:.82rem;color:var(--t2);margin-top:4px">{{t('admin.serverAudio.explainStopMpv')}}</div>
                      </td>
                      <td><a v-on:click="stopMpv()" class="btn-sm" :title="t('admin.serverAudio.tipStopMpv')" :style="{ opacity: actionBusy.stop ? 0.6 : 1, pointerEvents: actionBusy.stop ? 'none' : 'auto' }">{{actionBusy.stop ? t('admin.serverAudio.btnStopBusy') : t('admin.serverAudio.btnStop')}}</a></td>
                    </tr>
                    <tr>
                      <td>
                        <b>{{t('admin.serverAudio.btnAudioCheck')}}</b>
                        <div style="font-size:.82rem;color:var(--t2);margin-top:4px">{{t('admin.serverAudio.explainAudioCheck')}}</div>
                      </td>
                      <td><a v-on:click="runAudioCheck()" class="btn-sm" :title="t('admin.serverAudio.tipAudioCheck')" :style="{ opacity: actionBusy.check ? 0.6 : 1, pointerEvents: actionBusy.check ? 'none' : 'auto' }">{{actionBusy.check ? t('admin.serverAudio.btnAudioCheckBusy') : t('admin.serverAudio.btnAudioCheck')}}</a></td>
                    </tr>
                    <tr>
                      <td>
                        <b>{{t('admin.serverAudio.btnAudioFix')}}</b>
                        <div style="font-size:.82rem;color:var(--t2);margin-top:4px">{{t('admin.serverAudio.explainAudioFix')}}</div>
                      </td>
                      <td><a v-on:click="applyAudioFix()" class="btn-sm" :title="t('admin.serverAudio.tipAudioFix')" :style="{ opacity: actionBusy.fix ? 0.6 : 1, pointerEvents: actionBusy.fix ? 'none' : 'auto' }">{{actionBusy.fix ? t('admin.serverAudio.btnAudioFixBusy') : t('admin.serverAudio.btnAudioFix')}}</a></td>
                    </tr>
                    <tr>
                      <td>
                        <b>{{t('admin.serverAudio.btnGuidedTest')}}</b>
                        <div style="font-size:.82rem;color:var(--t2);margin-top:4px">{{t('admin.serverAudio.explainGuidedTest')}}</div>
                      </td>
                      <td><a v-on:click="runGuidedSoundTest()" class="btn-sm" :title="t('admin.serverAudio.tipGuidedTest')" :style="{ opacity: actionBusy.guided ? 0.6 : 1, pointerEvents: actionBusy.guided ? 'none' : 'auto' }">{{actionBusy.guided ? t('admin.serverAudio.btnGuidedTestBusy') : t('admin.serverAudio.btnGuidedTest')}}</a></td>
                    </tr>
                    <tr>
                      <td>
                        <b>{{t('admin.serverAudio.btnTestTone')}}</b>
                        <div style="font-size:.82rem;color:var(--t2);margin-top:4px">{{t('admin.serverAudio.explainTestTone')}}</div>
                      </td>
                      <td><a v-on:click="playTestTone()" class="btn-sm" :title="t('admin.serverAudio.tipTestTone')" :style="{ opacity: actionBusy.tone ? 0.6 : 1, pointerEvents: actionBusy.tone ? 'none' : 'auto' }">{{actionBusy.tone ? t('admin.serverAudio.btnTestToneBusy') : t('admin.serverAudio.btnTestTone')}}</a></td>
                    </tr>
                    <tr>
                      <td>
                        <b>{{t('admin.serverAudio.btnOpenRemote')}}</b>
                        <div style="font-size:.82rem;color:var(--t2);margin-top:4px">{{t('admin.serverAudio.explainOpenRemote')}}</div>
                      </td>
                      <td><a href="/server-remote" target="_blank" class="btn-sm btn-sm-edit" :title="t('admin.serverAudio.tipOpenRemote')">{{t('admin.serverAudio.btnOpenRemote')}}</a></td>
                    </tr>
                    <tr v-if="lastAction.message">
                      <td colspan="2" style="padding:6px 0 0">
                        <div style="padding:8px 10px;border-radius:6px;border:1px solid var(--border);font-size:.84rem;line-height:1.4" :style="{ color: lastAction.ok === false ? 'var(--red)' : 'var(--green)' }">
                          <b>{{t('admin.serverAudio.lastAction')}}:</b> {{lastAction.message}}
                        </div>
                      </td>
                    </tr>
                    <tr v-if="detectResult !== null">
                      <td colspan="2" style="font-size:.87rem;color:var(--t2)">
                        <span v-if="detectResult.found" style="color:var(--green)">
                          {{t('admin.serverAudio.detectFound', { version: detectResult.version, path: detectResult.path })}}
                        </span>
                        <span v-else style="color:var(--red)">
                          {{t('admin.serverAudio.detectNotFound', { path: detectResult.path })}}
                        </span>
                      </td>
                    </tr>
                    <tr v-if="audioHealth !== null">
                      <td colspan="2" style="font-size:.86rem;color:var(--t2);line-height:1.6;padding-top:10px">
                        <div><b style="color:var(--t1)">{{t('admin.serverAudio.healthTitle')}}</b>:
                          <span :style="{ color: audioHealth.healthy ? 'var(--green)' : 'var(--orange,#f97316)' }">
                            {{audioHealth.healthy ? t('admin.serverAudio.healthOk') : t('admin.serverAudio.healthNeedsFix')}}
                          </span>
                        </div>
                        <div v-if="audioHealth.mpv && !audioHealth.mpv.found" style="color:var(--red)">
                          {{t('admin.serverAudio.healthMpvMissing', { path: audioHealth.mpv.path || (params.mpvBin || 'mpv') })}}
                        </div>
                        <div v-if="audioHealth.issues && audioHealth.issues.includes('amixer-not-found')" style="color:var(--red)">
                          {{t('admin.serverAudio.healthAmixerMissing')}}
                        </div>
                        <div v-if="audioHealth.alsa && audioHealth.alsa.mutedControls && audioHealth.alsa.mutedControls.length" style="color:var(--orange,#f97316)">
                          {{t('admin.serverAudio.healthMutedControls', { controls: audioHealth.alsa.mutedControls.join(', ') })}}
                        </div>
                        <div v-if="audioHealth.alsa && audioHealth.alsa.cards && audioHealth.alsa.cards.length">
                          <span style="color:var(--t1)">{{t('admin.serverAudio.healthCards')}}</span>
                          <div v-for="line in audioHealth.alsa.cards" :key="line">{{line}}</div>
                        </div>
                        <div style="margin-top:6px">{{t('admin.serverAudio.healthHint')}}</div>
                      </td>
                    </tr>
                    <tr v-if="guidedSteps.length">
                      <td colspan="2" style="font-size:.86rem;color:var(--t2);line-height:1.55;padding-top:10px">
                        <div style="color:var(--t1);font-weight:600;margin-bottom:4px">{{t('admin.serverAudio.guidedReportTitle')}}</div>
                        <div v-for="(step, idx) in guidedSteps" :key="idx" style="display:flex;gap:8px;align-items:flex-start;padding:2px 0">
                          <span :style="{ color: step.ok ? 'var(--green)' : (step.warn ? 'var(--orange,#f97316)' : 'var(--red)') }">{{step.ok ? 'OK' : (step.warn ? 'WARN' : 'FAIL')}}</span>
                          <span><b style="color:var(--t1)">{{step.title}}:</b> {{step.detail}}</span>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{t('admin.serverAudio.howItWorksTitle')}}</span>
              <ul style="color:var(--t2);font-size:.9rem;line-height:1.7;padding-left:1.2em;list-style:disc">
                <li>{{t('admin.serverAudio.how1')}}</li>
                <li>{{t('admin.serverAudio.how2')}}</li>
                <li>{{t('admin.serverAudio.how3')}}</li>
                <li>{{t('admin.serverAudio.how4before')}} <a href="https://github.com/AroundMyRoom/Velvet/blob/master/docs/server-audio.md" target="_blank" style="color:var(--primary)">{{t('admin.serverAudio.how4link')}}</a> {{t('admin.serverAudio.how4after')}}</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  methods: {
    setLastAction(ok, message) {
      this.lastAction.ok = ok;
      this.lastAction.message = message;
      this.lastAction.at = Date.now();
    },
    pushGuidedStep(title, detail, mode = 'ok') {
      this.guidedSteps.push({
        title,
        detail,
        ok: mode === 'ok',
        warn: mode === 'warn',
      });
    },
    async saveServerAudioPatch(patch) {
      await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/server-audio`, data: patch });
      Object.keys(patch).forEach(k => Vue.set(ADMINDATA.serverAudioParams, k, patch[k]));
      await ADMINDATA.getServerAudioParams();
    },
    toggleEnabled() {
      const next = !this.params.enabled;
      adminConfirm(
        `<b>${next ? this.t('admin.serverAudio.confirmEnableTitle') : this.t('admin.serverAudio.confirmDisableTitle')}</b>`,
        next ? this.t('admin.serverAudio.confirmEnableMsg') : this.t('admin.serverAudio.confirmDisableMsg'),
        next ? this.t('admin.common.enable') : this.t('admin.common.disable'),
        async () => {
          await this.saveServerAudioPatch({ enabled: next });
          if (!next) Vue.set(ADMINDATA.serverAudioParams, 'running', false);
        }
      );
    },
    toggleAutoUnmute() {
      const next = this.params.autoUnmute === false;
      adminConfirm(
        `<b>${next ? this.t('admin.serverAudio.confirmAutoUnmuteEnableTitle') : this.t('admin.serverAudio.confirmAutoUnmuteDisableTitle')}</b>`,
        next ? this.t('admin.serverAudio.confirmAutoUnmuteEnableMsg') : this.t('admin.serverAudio.confirmAutoUnmuteDisableMsg'),
        next ? this.t('admin.common.enable') : this.t('admin.common.disable'),
        async () => { await this.saveServerAudioPatch({ autoUnmute: next }); }
      );
    },
    changeMpvBin() {
      modVM.currentViewModal = 'server-audio-mpvbin-modal';
      modVM.openModal();
    },
    async detectMpv() {
      if (this.actionBusy.detect) return;
      this.actionBusy.detect = true;
      this.detecting = true; this.detectResult = null;
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/server-playback/detect` });
        this.detectResult = res.data;
        this.setLastAction(!!res.data?.found, res.data?.found
          ? this.t('admin.serverAudio.actionDetectOk', { version: res.data.version || 'unknown' })
          : this.t('admin.serverAudio.actionDetectFail', { path: res.data?.path || (this.params.mpvBin || 'mpv') }));
      } catch {
        this.detectResult = { found: false, path: this.params.mpvBin || 'mpv' };
        this.setLastAction(false, this.t('admin.serverAudio.actionDetectFail', { path: this.params.mpvBin || 'mpv' }));
      }
      this.detecting = false;
      this.actionBusy.detect = false;
      return this.detectResult;
    },
    async startMpv() {
      if (this.actionBusy.start) return;
      this.actionBusy.start = true;
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/server-audio/start` });
        await ADMINDATA.getServerAudioParams();
        await this.runAudioCheck();
        this.setLastAction(true, this.t('admin.serverAudio.actionStartOk'));
      } catch {
        this.setLastAction(false, this.t('admin.serverAudio.actionStartFail'));
      } finally {
        this.actionBusy.start = false;
      }
    },
    async stopMpv() {
      if (this.actionBusy.stop) return;
      this.actionBusy.stop = true;
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/server-audio/stop` });
        Vue.set(ADMINDATA.serverAudioParams, 'running', false);
        this.setLastAction(true, this.t('admin.serverAudio.actionStopOk'));
      } catch {
        this.setLastAction(false, this.t('admin.serverAudio.actionStopFail'));
      } finally {
        this.actionBusy.stop = false;
      }
    },
    async runAudioCheck() {
      if (this.actionBusy.check) return;
      this.actionBusy.check = true;
      this.healthLoading = true;
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/server-playback/audio-health` });
        this.audioHealth = res.data;
        this.setLastAction(res.data?.healthy !== false,
          res.data?.healthy ? this.t('admin.serverAudio.actionCheckOk') : this.t('admin.serverAudio.actionCheckWarn'));
      } catch {
        this.audioHealth = null;
        this.setLastAction(false, this.t('admin.serverAudio.actionCheckFail'));
      } finally {
        this.healthLoading = false;
        this.actionBusy.check = false;
      }
      return this.audioHealth;
    },
    async applyAudioFix() {
      if (this.actionBusy.fix) return;
      this.actionBusy.fix = true;
      this.healthFixing = true;
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/server-playback/audio-health/fix` });
        this.audioHealth = res.data?.health || null;
        this.setLastAction(true, this.t('admin.serverAudio.actionFixOk'));
      } catch {
        this.setLastAction(false, this.t('admin.serverAudio.actionFixFail'));
      } finally {
        this.healthFixing = false;
        this.actionBusy.fix = false;
      }
    },
    async runGuidedSoundTest() {
      if (this.actionBusy.guided) return;
      this.actionBusy.guided = true;
      this.guidedSteps = [];
      try {
        const det = await this.detectMpv();
        if (!det?.found) {
          this.pushGuidedStep(this.t('admin.serverAudio.stepDetectMpv'), this.t('admin.serverAudio.stepDetectMpvFail', { path: (det?.path) || (this.params.mpvBin || 'mpv') }), 'fail');
          this.setLastAction(false, this.t('admin.serverAudio.guidedFinishedFail'));
          return;
        }
        this.pushGuidedStep(this.t('admin.serverAudio.stepDetectMpv'), this.t('admin.serverAudio.stepDetectMpvOk', { version: det.version || 'unknown' }), 'ok');

        let health = await this.runAudioCheck();
        if (!health) {
          this.pushGuidedStep(this.t('admin.serverAudio.stepAudioCheck'), this.t('admin.serverAudio.stepAudioCheckFail'), 'fail');
          this.setLastAction(false, this.t('admin.serverAudio.guidedFinishedFail'));
          return;
        }

        if (health.issues?.includes('amixer-not-found')) {
          this.pushGuidedStep(this.t('admin.serverAudio.stepAudioCheck'), this.t('admin.serverAudio.stepNeedAlsaUtils'), 'fail');
          this.setLastAction(false, this.t('admin.serverAudio.guidedFinishedFail'));
          return;
        }

        if (health.alsa?.mutedControls?.length > 0) {
          this.pushGuidedStep(this.t('admin.serverAudio.stepAudioCheck'), this.t('admin.serverAudio.stepMutedFound', { controls: health.alsa.mutedControls.join(', ') }), 'warn');
          await this.applyAudioFix();
          health = await this.runAudioCheck();
          if (health?.alsa?.mutedControls?.length === 0) {
            this.pushGuidedStep(this.t('admin.serverAudio.stepApplyFix'), this.t('admin.serverAudio.stepApplyFixOk'), 'ok');
          } else {
            this.pushGuidedStep(this.t('admin.serverAudio.stepApplyFix'), this.t('admin.serverAudio.stepApplyFixWarn'), 'warn');
          }
        } else {
          this.pushGuidedStep(this.t('admin.serverAudio.stepAudioCheck'), this.t('admin.serverAudio.stepAudioCheckOk'), 'ok');
        }

        if (!this.params.running) {
          await this.startMpv();
          await ADMINDATA.getServerAudioParams();
        }
        if (this.params.running) {
          this.pushGuidedStep(this.t('admin.serverAudio.stepStartMpv'), this.t('admin.serverAudio.stepStartMpvOk'), 'ok');
        } else {
          this.pushGuidedStep(this.t('admin.serverAudio.stepStartMpv'), this.t('admin.serverAudio.stepStartMpvFail'), 'fail');
        }

        this.pushGuidedStep(this.t('admin.serverAudio.stepOpenRemote'), this.t('admin.serverAudio.stepOpenRemoteHint'), 'ok');
        this.setLastAction(true, this.t('admin.serverAudio.guidedFinishedOk'));
      } catch {
        this.pushGuidedStep(this.t('admin.serverAudio.stepUnexpected'), this.t('admin.serverAudio.stepUnexpectedDetail'), 'fail');
        this.setLastAction(false, this.t('admin.serverAudio.guidedFinishedFail'));
      } finally {
        this.actionBusy.guided = false;
      }
    },
    async playTestTone() {
      if (this.actionBusy.tone) return;
      this.actionBusy.tone = true;
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/server-playback/test-tone` });
        this.setLastAction(true, this.t('admin.serverAudio.actionTestToneOk'));
      } catch (e) {
        const msg = e?.response?.data?.error || e.message;
        this.setLastAction(false, this.t('admin.serverAudio.actionTestToneFail') + ': ' + msg);
      } finally {
        this.actionBusy.tone = false;
      }
    },
  },
  mounted() {
    this.runAudioCheck();
  }
});

const transcodeView = Vue.component('transcode-view', {
  data() {
    return {
      params: ADMINDATA.transcodeParams,
      paramsTS: ADMINDATA.transcodeParamsUpdated,
      downloadPending: ADMINDATA.downloadPending,
    };
  },
  template: `
    <div class="container">
      <div class="powered-by-row">
        <span class="powered-by-label">{{t('admin.transcode.poweredBy')}}</span>
        <svg class="ffmpeg-logo" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 224.44334 60.186738">
          <defs>
            <radialGradient id="a" gradientUnits="userSpaceOnUse" cy="442.72311" cx="-122.3936" gradientTransform="matrix(1,0,0,-1,134.4463,453.7334)" r="29.5804">
              <stop stop-color="#fff" offset="0"/>
              <stop stop-color="#007808" offset="1"/>
            </radialGradient>
          </defs>
          <g>
            <polygon points="0.511 12.364 0.511 5.078 5.402 6.763 5.402 13.541" fill="#0b4819"/>
            <polygon points="4.455 42.317 4.455 15.226 9.13 16.215 9.13 41.393" fill="#0b4819"/>
            <polygon points="27.321 5.066 15.306 18.846 15.306 24.71 33.126 4.617 61.351 2.432 19.834 45.706 25.361 45.997 55.516 15.154 55.516 44.305 52.166 47.454 60.662 47.913 60.662 55.981 34.012 53.917 47.597 40.738 47.597 34.243 28.175 53.465 4.919 51.667 42.222 11.55 36.083 11.882 9.13 41.393 9.13 16.215 11.683 13.201 5.402 13.541 5.402 6.763" fill="#105c80"/>
            <polygon points="4.455 15.226 7.159 11.971 11.683 13.201 9.13 16.215" fill="#0b4819"/>
            <polygon points="11.004 18.039 15.306 18.846 15.306 24.71 11.004 24.358" fill="#084010"/>
            <polygon points="15.82 47.006 19.834 45.706 25.361 45.997 21.714 47.346" fill="#0c541e"/>
            <polygon points="23.808 3.106 27.321 5.066 15.306 18.846 11.004 18.039" fill="#1a5c34"/>
            <polygon points="11.004 24.358 30.022 2.58 33.126 4.617 15.306 24.71" fill="#0b4819"/>
            <polygon points="33.195 10.432 36.083 11.882 9.13 41.393 4.455 42.317" fill="#1a5c34"/>
            <polygon points="0 53.344 39.798 10.042 42.222 11.55 4.919 51.667" fill="#0b4819"/>
            <polygon points="45.597 34.677 47.597 34.243 28.175 53.465 24.721 55.437" fill="#1a5c34"/>
            <polygon points="45.597 41.737 45.597 34.677 47.597 34.243 47.597 40.738" fill="#0b4819"/>
            <polygon points="30.973 55.965 45.597 41.737 47.597 40.738 34.012 53.917" fill="#0b4819"/>
            <polygon points="54.168 45.648 50.538 49.059 52.166 47.454 55.516 44.305" fill="#13802d"/>
            <polygon points="21.714 47.346 54.168 13.9 55.516 15.154 25.361 45.997" fill="#0b4819"/>
            <polygon points="54.168 13.9 55.516 15.154 55.516 44.305 54.168 45.648" fill="#084010"/>
            <polygon points="59.759 49.604 60.662 47.913 60.662 55.981 59.759 58.403" fill="#084010"/>
            <polygon points="60.507 0 61.351 2.432 19.834 45.706 15.82 47.006" fill="#1a5c34"/>
            <polygon points="23.808 3.106 11.004 18.039 11.004 24.358 30.022 2.58 60.507 0 15.82 47.006 21.714 47.346 54.168 13.9 54.168 45.648 50.538 49.059 59.759 49.604 59.759 58.403 30.973 55.965 45.597 41.737 45.597 34.677 24.721 55.437 0 53.344 39.798 10.042 33.195 10.432 4.455 42.317 4.455 15.226 7.159 11.971 0.511 12.364 0.511 5.078" fill="url(#a)"/>
          </g>
          <g class="ffmpeg-text" transform="matrix(2.6160433,0,0,2.6160433,70,-145)">
            <polygon points="2.907 66.777 6.825 66.777 6.825 69.229 2.907 69.229 2.907 74.687 0.797 74.687 0.797 74.688 0.797 61.504 8.218 61.504 8.218 63.965 2.907 63.965"/>
            <polygon points="11.13 66.777 15.049 66.777 15.049 69.229 11.13 69.229 11.13 74.687 9.021 74.687 9.021 74.688 9.021 61.504 16.442 61.504 16.442 63.965 11.13 63.965"/>
            <path d="m19.69 69.063v5.625h-2.461v-8.534l2.461-0.264v0.782c0.551-0.517 1.254-0.773 2.109-0.773 1.113 0 1.963 0.337 2.549 1.011 0.645-0.674 1.611-1.011 2.9-1.011 1.113 0 1.963 0.337 2.549 1.011 0.586 0.675 0.879 1.45 0.879 2.329v5.449h-2.461v-4.834c0-0.586-0.132-1.04-0.396-1.362-0.264-0.321-0.691-0.491-1.283-0.51-0.486 0.035-0.908 0.357-1.266 0.967-0.029 0.183-0.044 0.366-0.044 0.555v5.186h-2.461v-4.834c0-0.586-0.132-1.04-0.396-1.362-0.264-0.321-0.689-0.492-1.281-0.511-0.539 0.034-1.005 0.394-1.398 1.08z"/>
            <path d="m31.913 78.379v-12.225l2.461-0.264v0.703c0.656-0.47 1.301-0.703 1.934-0.703 1.348 0 2.417 0.438 3.208 1.317 0.791 0.88 1.187 1.904 1.187 3.076s-0.396 2.197-1.187 3.076-1.86 1.318-3.208 1.318c-0.879-0.06-1.523-0.296-1.934-0.712v4.421l-2.461-0.007zm2.461-8.885v1.425c0.117 0.983 0.732 1.562 1.846 1.73 1.406-0.111 2.197-0.841 2.373-2.188-0.059-1.642-0.85-2.49-2.373-2.55-1.114 0.176-1.729 0.704-1.846 1.583z"/>
            <path d="m41.094 70.293c0-1.289 0.41-2.345 1.23-3.164 0.82-0.82 1.875-1.23 3.164-1.23s2.314 0.41 3.076 1.23c0.762 0.819 1.143 1.875 1.143 3.164v0.879h-6.064c0.059 0.469 0.264 0.835 0.615 1.099s0.762 0.396 1.23 0.396c0.82 0 1.553-0.233 2.197-0.702l1.406 1.405c-0.645 0.879-1.846 1.318-3.604 1.318-1.289 0-2.344-0.41-3.164-1.23s-1.229-1.875-1.229-3.165zm5.625-1.977c-0.352-0.264-0.762-0.396-1.23-0.396s-0.879 0.132-1.23 0.396-0.527 0.63-0.527 1.099h3.516c-0.002-0.469-0.178-0.835-0.529-1.099z"/>
            <path d="m59.037 66.163v7.822c0 1.23-0.366 2.259-1.099 3.085s-1.655 1.263-2.769 1.311l-0.527 0.053c-1.699-0.035-3.018-0.521-3.955-1.459l1.143-1.318c0.645 0.47 1.427 0.732 2.347 0.791 0.938 0 1.572-0.22 1.902-0.659 0.332-0.438 0.497-0.923 0.497-1.449v-0.439c-0.656 0.527-1.418 0.791-2.285 0.791-1.348 0-2.358-0.396-3.032-1.187s-1.011-1.86-1.011-3.208c0-1.289 0.366-2.345 1.099-3.164 0.733-0.82 1.772-1.23 3.12-1.23 0.996 0.06 1.699 0.325 2.109 0.8v-0.8l2.461 0.26zm-2.461 4.921v-1.424c-0.117-0.983-0.732-1.562-1.846-1.73-1.465 0.053-2.256 0.782-2.373 2.188 0.059 1.642 0.85 2.49 2.373 2.55 1.114-0.177 1.729-0.705 1.846-1.584z"/>
          </g>
        </svg>
      </div>
      <div v-if="paramsTS.ts === 0" class="row">
        <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
      </div>
      <div v-else class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{t('admin.transcode.settingsTitle')}}</span>
              <table>
                <tbody>
                  <tr>
                    <td><b>{{t('admin.transcode.labelEnabled')}}</b> {{params.enabled === true ? t('admin.common.enabled') : t('admin.common.disabled')}}</td>
                    <td>
                      <a v-on:click="toggleEnabled()" class="btn-sm btn-sm-edit">{{t('admin.common.edit')}}</a>
                    </td>
                  </tr>
                  <tr>
                    <td><b>{{t('admin.transcode.labelFfmpegDir')}}</b> {{params.ffmpegDirectory}}</td>
                    <td style="color:var(--t2);font-size:.82rem">{{t('admin.transcode.editInConfig')}}</td>
                  </tr>
                  <tr>
                    <td><b>{{t('admin.transcode.labelFfmpegDownloaded')}}</b> {{downloadPending.val === true ? t('admin.transcode.pending') : params.downloaded}}</td>
                    <td>
                      <a v-on:click="downloadFFMpeg()" class="btn-sm">{{t('admin.transcode.btnDownload')}}</a>
                    </td>
                  </tr>
                  <tr>
                    <td><b>{{t('admin.transcode.labelDefaultCodec')}}</b> {{params.defaultCodec}}</td>
                    <td>
                      <a v-on:click="changeCodec()" class="btn-sm btn-sm-edit">{{t('admin.common.edit')}}</a>
                    </td>
                  </tr>
                  <tr>
                    <td><b>{{t('admin.transcode.labelDefaultBitrate')}}</b> {{params.defaultBitrate}}</td>
                    <td>
                      <a v-on:click="changeBitrate()" class="btn-sm btn-sm-edit">{{t('admin.common.edit')}}</a>
                    </td>
                  </tr>
                  <tr>
                  <td><b>{{t('admin.transcode.labelDefaultAlgorithm')}}</b> {{params.algorithm}}</td>
                  <td>
                    <a v-on:click="changeAlgorithm()" class="btn-sm btn-sm-edit">{{t('admin.common.edit')}}</a>
                  </td>
                </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  methods: {
    toggleEnabled: function() {
            adminConfirm(
              `<b>${this.params.enabled === true ? this.t('admin.transcode.confirmDisableTitle') : this.t('admin.transcode.confirmEnableTitle')}</b>`,
              this.t('admin.transcode.confirmToggleMsg'),
              this.params.enabled === true ? this.t('admin.common.disable') : this.t('admin.common.enable'),
              async () => {
        try {
                      await API.axios({
                        method: 'POST',
                        url: `${API.url()}/api/v1/admin/transcode/enable`,
                        data: { enable: !this.params.enabled }
                      });
                      Vue.set(ADMINDATA.transcodeParams, 'enabled', !this.params.enabled);

                      // download ffmpeg
                      if (this.params.enabled === true) { this.downloadFFMpeg(); }

                      iziToast.success({
                        title: this.t('admin.common.updatedSuccessfully'),
                        position: 'topCenter',
                        timeout: 3500
                      });
                    } catch {
                      iziToast.error({
                        title: this.t('admin.common.failed'),
                        position: 'topCenter',
                        timeout: 3500
                      });
                    }
      }
      );
    },
    changeCodec: function() {
      modVM.currentViewModal = 'edit-transcode-codec-modal';
      modVM.openModal();
    },
    changeBitrate: function() {
      modVM.currentViewModal = 'edit-transcode-bitrate-modal';
      modVM.openModal();
    },
    changeAlgorithm: function() {
      modVM.currentViewModal = 'edit-transcode-algorithm-modal';
      modVM.openModal();
    },
    downloadFFMpeg: async function() {
      if (this.downloadPending.val === true) {
        return;
      }

      try {
        this.downloadPending.val = true;
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/transcode/download`,
        });
        Vue.set(ADMINDATA.transcodeParams, 'downloaded', true);
        iziToast.success({
          title: this.t('admin.transcode.toastFfmpegDownloaded'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch {
        iziToast.error({
          title: this.t('admin.transcode.toastFailedDownload'),
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.downloadPending.val = false;
      }
    },
    changeFolder: function() {}
  }
});

const federationMainPanel = Vue.component('federation-main-panel', { // activeTab-patched
  data() {
    return {
      params: ADMINDATA.federationParams,
      paramsTS: ADMINDATA.federationParamsUpdated,
      enabled: ADMINDATA.federationEnabled,
      syncthingUrl: "",
      activeTab: 'federation',
      enablePending: false,

      currentToken: '',
      inviteServerUrl: '',
      parsedTokenData: null,
      submitPending: false
    };
  },
  template: `
    <div>
      <div class="tabs">
        <div class="tab"><button :class="{active: activeTab==='federation'}" @click="activeTab='federation'">{{t('admin.federation.tabFederation')}}</button></div>
        <div class="tab"><button :class="{active: activeTab==='syncthing'}" @click="activeTab='syncthing'; setSyncthingUrl()">{{t('admin.federation.tabSyncthing')}}</button></div>
      </div>
      <div id="sync-tab-1" v-show="activeTab==='federation'">
        <div class="container">
          <div class="row">
            <div class="col s12">
              <div class="card">
                <div class="card-content">
                  <span class="card-title">{{t('admin.federation.title')}}</span>
                  <table>
                    <tbody>
                      <tr>
                        <td><b>{{t('admin.federation.labelDeviceId')}}</b> {{params.deviceId}}</td>
                      </tr>
                    </tbody>
                  </table>
                  <button type="button" class="btn-flat btn-small" style="margin-top:.25rem;" @click="openFederationGenerateInviteModal()">{{t('admin.federation.btnGenerateInvite')}}</button>
                </div>
                <div class="card-action flow-root">
                  <a v-on:click="enableFederation()" v-bind:class="{ 'red': enabled.val }" class="btn">{{enabled.val ? t('admin.federation.btnDisable') : t('admin.federation.btnEnable')}}</a>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="big-container">
          <div class="row">
            <div class="col s12">
              <div class="card">
                <div class="card-content">
                  <span class="card-title">{{t('admin.federation.acceptInviteTitle')}}</span>
                  <div class="row">
                    <div class="col s12 m12 l6">
                      <div class="row">
                        <div class="col s12">
                          <label for="fed-invite-token">{{t('admin.federation.labelToken')}}</label>
                          <textarea id="fed-invite-token" v-model="currentToken" style="height: auto;" rows="4" cols="60" :placeholder="t('admin.federation.tokenPlaceholder')"></textarea>
                        </div>
                      </div>
                      <div class="input-field" style="margin-top:.5rem;">
                        <label for="fed-invite-url">{{t('admin.federation.labelServerUrl')}}</label>
                        <input id="fed-invite-url" v-model="inviteServerUrl" type="text" placeholder="https://your-server.example.com">
                      </div>
                    </div>
                    <div class="col s12 m12 l6">
                      <form @submit.prevent="acceptInvite" v-if="parsedTokenData !== null">
                        <p>{{t('admin.federation.labelSelectFolders')}}</p>
                        <div v-for="(item, key, index) in parsedTokenData.vPaths">
                          <label>
                            <input type="checkbox" checked/>
                            <span>{{key}}</span>
                          </label>
                        </div>
                        <button class="btn" type="submit" :disabled="submitPending === true">
                          {{submitPending === false ? t('admin.federation.btnAcceptInvite') : t('admin.federation.btnWorking')}}
                        </button>
                      </form>
                      <div v-else>
                        <p>{{t('admin.federation.tokenHint')}}</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div id="sync-tab-2" v-show="activeTab==='syncthing'">
        <iframe id="syncthing-iframe" :src="syncthingUrl"></iframe>
      </div>
    </div>`,
  watch: {
    'currentToken': function(val, preVal) {
      try {
        if (!val) { 
          this.parsedTokenData = null;
          return;
        }

        const decoded = jwt_decode(val);
        this.parsedTokenData = decoded;
      } catch(err) {
        console.log(err)
        this.parsedTokenData = null;
      }
    }
  },
  methods: {
    editName: async function() {

    },
    acceptInvite: async function() {
      try {
        const postData = {
          invite: this.currentToken,
          paths: {}
        };
    
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/federation/invite/accept`,
          data: postData
        });
      } catch {
        iziToast.error({
          title: this.t('admin.federation.toastFailedAccept'),
          position: 'topCenter',
          timeout: 3500
        });
      }

  //   var folderNames = {};

  //   var decoded = jwt_decode($('#federation-invitation-code').val());
  //   Object.keys(decoded.vPaths).forEach(function(key) {
  //     if($("input[type=checkbox][value="+decoded.vPaths[key]+"]").is(":checked")){
  //       folderNames[key] = $("#" + decoded.vPaths[key]).val();
  //     }
  //   });

  //   if (Object.keys(folderNames).length === 0) {
  //     iziToast.error({
  //       title: 'No directories selected',
  //       position: 'topCenter',
  //       timeout: 3500
  //     });
  //   }

    // var sendThis = {
    //   invite: $('#federation-invitation-code').val(),
    //   paths: folderNames
    // };

  //   MSTREAMAPI.acceptFederationInvite(sendThis, function(res, err){
  //     if (err !== false) {
  //       boilerplateFailure(res, err);
  //       return;
  //     }

  //     iziToast.success({
  //       title: 'Federation Successful!',
  //       position: 'topCenter',
  //       timeout: 3500
  //     });
  //   });
    },
    setSyncthingUrl: function() {
      if (this.syncthingUrl !== '') { return; }
      this.syncthingUrl = '/api/v1/syncthing-proxy/?token=' + API.token();
    },
    openFederationGenerateInviteModal: function() {
      modVM.currentViewModal = 'federation-generate-invite-modal';
      modVM.openModal();
    },
    enableFederation: function() {
      adminConfirm(
        this.enabled.val === true ? this.t('admin.federation.confirmDisableTitle') : this.t('admin.federation.confirmEnableTitle'),
        '',
        this.enabled.val === true ? this.t('admin.common.disable') : this.t('admin.common.enable'),
        async () => {
        try {
          this.enablePending = true;
          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/federation/enable`,
            data: { enable: !this.enabled.val }
          });
          Vue.set(ADMINDATA.federationEnabled, 'val', !this.enabled.val);
          iziToast.success({
            title: this.enabled.val === true ? this.t('admin.federation.toastEnabled') : this.t('admin.federation.toastDisabled'),
            position: 'topCenter',
            timeout: 3500
          });
        } catch {
          iziToast.error({
            title: this.t('admin.federation.toastToggleFailed'),
            position: 'topCenter',
            timeout: 3500
          });
        } finally {
          this.enablePending = false;
        }
      }
      );
    }
  }
});

const federationView = Vue.component('federation-view', {
  data() {
    return {
      paramsTS: ADMINDATA.federationParamsUpdated,
      enabled: ADMINDATA.federationEnabled,
      enablePending: false,
    };
  },
  template: `
    <div v-if="paramsTS.ts === 0" class="row">
      <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
    </div>
    <div v-else-if="enabled.val === false" class="row">
      <div class="container">
        <div class="powered-by-row">
          <span class="powered-by-label">{{t('admin.federation.poweredBy')}}</span>
          <svg xmlns="http://www.w3.org/2000/svg" class="syncthing-logo" viewBox="0 0 429 117.3"><linearGradient id="a" gradientUnits="userSpaceOnUse" x1="58.666" y1="117.332" x2="58.666" y2="0"><stop offset="0" stop-color="#0882c8"/><stop offset="1" stop-color="#26b6db"/></linearGradient><circle fill="url(#a)" cx="58.7" cy="58.7" r="58.7"/><circle fill="none" stroke="#FFF" stroke-width="6" stroke-miterlimit="10" cx="58.7" cy="58.5" r="43.7"/><path fill="#FFF" d="M94.7 47.8c4.7 1.6 9.8-.9 11.4-5.6 1.6-4.7-.9-9.8-5.6-11.4-4.7-1.6-9.8.9-11.4 5.6-1.6 4.7.9 9.8 5.6 11.4z"/><path fill="none" stroke="#FFF" stroke-width="6" stroke-miterlimit="10" d="M97.6 39.4l-30.1 25"/><path fill="#FFF" d="M77.6 91c-.4 4.9 3.2 9.3 8.2 9.8 5 .4 9.3-3.2 9.8-8.2.4-4.9-3.2-9.3-8.2-9.8-5-.4-9.4 3.2-9.8 8.2z"/><path fill="none" stroke="#FFF" stroke-width="6" stroke-miterlimit="10" d="M86.5 91.8l-19-27.4"/><path fill="#FFF" d="M60 69.3c2.7 4.2 8.3 5.4 12.4 2.7 4.2-2.7 5.4-8.3 2.7-12.4-2.7-4.2-8.3-5.4-12.4-2.7-4.2 2.6-5.4 8.2-2.7 12.4z"/><g><path fill="#FFF" d="M21.2 61.4c-4.3-2.5-9.8-1.1-12.3 3.1-2.5 4.3-1.1 9.8 3.1 12.3 4.3 2.5 9.8 1.1 12.3-3.1s1.1-9.7-3.1-12.3z"/><path fill="none" stroke="#FFF" stroke-width="6" stroke-miterlimit="10" d="M16.6 69.1l50.9-4.7"/></g><g fill="#0891D1"><path d="M163.8 50.2c-.6-.7-6.3-4.1-11.4-4.1-3.4 0-5.2 1.2-5.2 3.5 0 2.9 3.2 3.7 8.9 5.2 8.2 2.2 13.3 5 13.3 12.9 0 9.7-7.8 13-16 13-6.2 0-13.1-2-18.2-5.3l4.3-8.6c.8.8 7.5 5 14 5 3.5 0 5.2-1.1 5.2-3.2 0-3.2-4.4-4-10.3-5.8-7.9-2.4-11.5-5.3-11.5-11.8 0-9 7.2-13.9 15.7-13.9 6.1 0 11.6 2.5 15.4 4.7l-4.2 8.4zM175 85.1c1.7.5 3.3.8 4.4.8 2 0 3.3-1.5 4.2-5.5l-11.9-31.5h9.8l7.4 23.3 6.3-23.3h8.9L192 85.5c-1.7 5.3-6.2 8.7-11.8 8.8-1.7 0-3.5-.2-5.3-.9v-8.3zM239.3 80.3h-9.6V62.6c0-4.1-1.7-5.9-4.3-5.9-2.6 0-5.8 2.3-7 5.6v18.1h-9.6V48.8h8.6v5.3c2.3-3.7 6.8-5.9 12.2-5.9 8.2 0 9.5 6.7 9.5 11.9v20.2zM261.6 48.2c7.2 0 12.3 3.4 14.8 8.3l-9.4 2.8c-1.2-1.9-3.1-3-5.5-3-4 0-7 3.2-7 8.2 0 5 3.1 8.3 7 8.3 2.4 0 4.6-1.3 5.5-3.1l9.4 2.9c-2.3 4.9-7.6 8.3-14.8 8.3-10.6 0-16.9-7.7-16.9-16.4s6.2-16.3 16.9-16.3zM302.1 78.7c-2.6 1.1-6.2 2.3-9.7 2.3-4.7 0-8.8-2.3-8.8-8.4V56.1h-4v-7.3h4v-10h9.6v10h6.4v7.3h-6.4v13.1c0 2.1 1.2 2.9 2.8 2.9 1.4 0 3-.6 4.2-1.1l1.9 7.7zM337.2 80.3h-9.6V62.6c0-4.1-1.8-5.9-4.6-5.9-2.3 0-5.5 2.2-6.7 5.6v18.1h-9.6V36.5h9.6v17.6c2.3-3.7 6.3-5.9 10.9-5.9 8.5 0 9.9 6.5 9.9 11.9v20.2zM343.4 45.2v-8.7h9.6v8.7h-9.6zm0 35.1V48.8h9.6v31.5h-9.6zM389.9 80.3h-9.6V62.6c0-4.1-1.7-5.9-4.3-5.9-2.6 0-5.8 2.3-7 5.6v18.1h-9.6V48.8h8.6v5.3c2.3-3.7 6.8-5.9 12.2-5.9 8.2 0 9.5 6.7 9.5 11.9v20.2zM395.5 64.6c0-9.2 6-16.3 14.6-16.3 4.7 0 8.4 2.2 10.6 5.8v-5.2h8.3v29.3c0 9.6-7.5 15.5-18.2 15.5-6.8 0-11.5-2.3-15-6.3l5.1-5.2c2.3 2.6 6 4.3 9.9 4.3 4.6 0 8.6-2.4 8.6-8.3v-3.1c-1.9 3.5-5.9 5.3-10 5.3-8.3.1-13.9-7.1-13.9-15.8zm23.9 3.9v-6.6c-1.3-3.3-4.2-5.5-7.1-5.5-4.1 0-7 4-7 8.4 0 4.6 3.2 8 7.5 8 2.9 0 5.3-1.8 6.6-4.3z"/></g></svg>
        </div>
        <a v-on:click="enableFederation()" class="btn-large">{{t('admin.federation.btnEnable')}}</a>
      </div>
    </div>
    <federation-main-panel v-else>
    </federation-main-panel>`,
  methods: {
    enableFederation: async function() {
      try {
        this.enablePending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/federation/enable`,
          data: {
            enable: !this.enabled.val,
          }
        });

        // update frontend data
        Vue.set(ADMINDATA.federationEnabled, 'val', !this.enabled.val);
  
        iziToast.success({
          title: this.enabled.val === true ? this.t('admin.federation.toastEnabled') : this.t('admin.federation.toastDisabled'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch {
        iziToast.error({
          title: this.t('admin.federation.toastToggleFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.enablePending = false;
      }
    }
  }
});

const logsView = Vue.component('logs-view', {
  data() {
    return {
      params: ADMINDATA.serverParams,
      paramsTS: ADMINDATA.serverParamsUpdated
    };
  },
  template: `
    <div v-if="paramsTS.ts === 0" class="row">
      <svg class="spinner" width="65px" height="65px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
    </div>
    <div v-else>
      <div class="container">
        <div class="row">
          <div class="col s12">
            <div class="card">
              <div class="card-content">
                <span class="card-title">{{ t('admin.logs.title') }}</span>
                <table>
                  <tbody>
                    <tr>
                      <td><b>{{ t('admin.logs.labelWriteLogs') }}</b> {{params.writeLogs === true ? t('admin.logs.writeLogsEnabled') : t('admin.logs.writeLogsDisabled')}}</td>
                      <td>
                        <a v-on:click="toggleWriteLogs" class="btn-sm btn-sm-edit">edit</a>
                      </td>
                    </tr>
                    <tr>
                      <td><b>{{ t('admin.logs.labelLogsDirectory') }}</b> {{params.storage.logsDirectory}}</td>
                      <td style="color:var(--t2);font-size:.82rem">{{ t('admin.settings.editInConfigHint') }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="card-action">
                <a v-on:click="downloadLogs()" class="btn">{{ t('admin.logs.btnDownload') }}</a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  methods: {
    downloadLogs: async function() {
      try {
        const response = await API.axios({
          url: `${API.url()}/api/v1/admin/logs/download`, //your url
          method: 'GET',
          responseType: 'blob', // important
        });

        const url = window.URL.createObjectURL(new Blob([response.data]));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', 'velvet-logs.zip'); //or any other extension
        document.body.appendChild(link);
        link.click();
      } catch (err) {
        console.log(err)
        iziToast.error({
          title: this.t('admin.logs.toastDownloadFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }
    },
    toggleWriteLogs: function() {
            adminConfirm(`<b>${this.params.writeLogs === true ? 'Disable' : 'Enable'} Writing Logs To Disk?</b>`, '', `${this.params.writeLogs === true ? 'Disable' : 'Enable'}`, () => {
        API.axios({
                      method: 'POST',
                      url: `${API.url()}/api/v1/admin/config/write-logs`,
                      data: { writeLogs: !this.params.writeLogs }
                    }).then(() => {
                      // update frontend data
                      Vue.set(ADMINDATA.serverParams, 'writeLogs', !this.params.writeLogs);

                      iziToast.success({
                        title: this.t('admin.common.updatedSuccessfully'),
                        position: 'topCenter',
                        timeout: 3500
                      });
                    }).catch(() => {
                      iziToast.error({
                        title: 'Failed',
                        position: 'topCenter',
                        timeout: 3500
                      });
                    });
      });
    },
  }
});

const lockView = Vue.component('lock-view', {
  data() {
    return {};
  },
  template: `
    <div class="container">
      <div class="card">
        <div class="card-content">
          <span class="card-title">{{ t('admin.lock.title') }}</span>
          <p style="color:var(--t2);">{{ t('admin.lock.desc') }}</p>
          <p style="color:var(--t2);">{{ t('admin.lock.reenableIntro') }}</p>
          <ul style="color:var(--t2);padding-left:1.25rem;margin:.25rem 0 1rem;line-height:1.9;">
            <li>{{ t('admin.lock.step1') }}</li>
            <li>{{ t('admin.lock.step2') }}</li>
            <li>{{ t('admin.lock.step3') }}</li>
          </ul>
        </div>
        <div class="card-action">
          <button class="btn red" type="button" @click="disableAdmin()">{{ t('admin.lock.btnDisable') }}</button>
        </div>
      </div>
    </div>`,

    methods: {
      disableAdmin: function() {
                adminConfirm(this.t('admin.lock.confirmTitle'), '', this.t('admin.lock.confirmLabel'), () => {
          API.axios({
                          method: 'POST',
                          url: `${API.url()}/api/v1/admin/lock-api`,
                          data: { lock: true }
                        }).then(() => {
                          window.location.reload();
                        }).catch(() => {
                          iziToast.error({
                            title: this.t('admin.lock.toastFailed'),
                            position: 'topCenter',
                            timeout: 3500
                          });
                        });
        });
      }
    }
});

const lyricsView = Vue.component('lyrics-view', {
  data() {
    return {
      enabled: true,
      pending: false,
    };
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{ t('admin.lyrics.title') }}</span>
              <p style="margin-bottom:0.5rem;">{{t('admin.lyrics.desc1before')}} <a href="https://lrclib.net" target="_blank" rel="noopener">lrclib.net</a> {{t('admin.lyrics.desc1after')}}</p>
              <p style="margin-bottom:1rem;font-size:0.85rem;color:#999;">{{t('admin.lyrics.desc2')}}</p>
              <table>
                <tbody>
                  <tr>
                    <td style="width:140px"><b>{{ t('admin.lyrics.labelEnable') }}</b></td>
                    <td><input type="checkbox" v-model="enabled" style="margin:0;width:auto;height:auto;" /> {{ t('admin.lyrics.checkboxEnable') }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="card-action">
              <button class="btn" v-on:click="save()" :disabled="pending">
                {{ pending ? t('admin.common.saving') : t('admin.common.save') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  async mounted() {
    try {
      const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/lyrics/config` });
      this.enabled = res.data.enabled !== false;
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  },
  methods: {
    save: async function() {
      this.pending = true;
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/lyrics/config`,
          data: { enabled: this.enabled }
        });
        iziToast.success({ title: this.t('admin.lyrics.toastSaved'), position: 'topCenter', timeout: 3000 });
      } catch {
        iziToast.error({ title: this.t('admin.lyrics.toastFailed'), position: 'topCenter', timeout: 3000 });
      } finally {
        this.pending = false;
      }
    }
  }
});

const lastFMView = Vue.component('lastfm-view', {
  data() {
    return {
      enabled: true,
      apiKey: '',
      apiSecret: '',
      pending: false,
    };
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{ t('admin.lastfm.title') }}</span>
              <p style="margin-bottom:0.5rem;">{{t('admin.lastfm.desc1')}} <a href="https://www.last.fm/api/account/create" target="_blank" rel="noopener">{{t('admin.lastfm.ownKeyLink')}}</a>.</p>
              <p style="margin-bottom:1rem;font-size:0.85rem;color:#999;">{{t('admin.lastfm.secretHint')}}</p>
              <table>
                <tbody>
                  <tr>
                    <td style="width:140px"><b>{{ t('admin.lastfm.labelEnable') }}</b></td>
                    <td><input type="checkbox" v-model="enabled" style="margin:0;width:auto;height:auto;" /> {{ t('admin.lastfm.checkboxEnable') }}</td>
                  </tr>
                  <tr>
                    <td><b>{{ t('admin.lastfm.labelApiKey') }}</b></td>
                    <td><input v-model="apiKey" type="text" :placeholder="t('admin.lastfm.apiKeyPlaceholder')" autocomplete="off" data-form-type="other" data-lpignore="true" data-1p-ignore data-bwignore spellcheck="false" style="margin:0" /></td>
                  </tr>
                  <tr>
                    <td><b>{{ t('admin.lastfm.labelSharedSecret') }}</b></td>
                    <td><input v-model="apiSecret" type="password" :placeholder="t('admin.lastfm.secretPlaceholder')" autocomplete="new-password" data-form-type="other" data-lpignore="true" data-1p-ignore data-bwignore style="margin:0" /></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="card-action">
              <button class="btn" v-on:click="save()" :disabled="pending">
                {{ pending ? t('admin.common.saving') : t('admin.common.save') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  async mounted() {
    try {
      const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/lastfm/config` });
      this.enabled   = res.data.enabled !== false;
      this.apiKey    = res.data.apiKey    || '';
      this.apiSecret = res.data.apiSecret || '';
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  },
  methods: {
    save: async function() {
      this.pending = true;
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/lastfm/config`,
          data: { enabled: this.enabled, apiKey: this.apiKey.trim(), apiSecret: this.apiSecret.trim() }
        });
        iziToast.success({ title: this.t('admin.lastfm.toastSaved'), position: 'topCenter', timeout: 3000 });
      } catch {
        iziToast.error({ title: this.t('admin.lastfm.toastFailed'), position: 'topCenter', timeout: 3000 });
      } finally {
        this.pending = false;
      }
    }
  }
});

const listenBrainzView = Vue.component('listenbrainz-view', {
  data() {
    return { enabled: false, pending: false };
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{ t('admin.listenbrainz.title') }}</span>
              <p style="margin-bottom:1rem;">{{t('admin.listenbrainz.desc1')}} <a href="https://listenbrainz.org/profile/" target="_blank" rel="noopener">{{t('admin.listenbrainz.profileLink')}}</a>.</p>
              <table><tbody>
                <tr>
                  <td style="width:140px"><b>{{ t('admin.listenbrainz.labelEnable') }}</b></td>
                  <td><input type="checkbox" v-model="enabled" style="margin:0;width:auto;height:auto;" /> {{ t('admin.listenbrainz.checkboxEnable') }}</td>
                </tr>
              </tbody></table>
            </div>
            <div class="card-action">
              <button class="btn" v-on:click="save()" :disabled="pending">
                {{ pending ? t('admin.common.saving') : t('admin.common.save') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  async mounted() {
    try {
      const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/listenbrainz/config` });
      this.enabled = res.data.enabled === true;
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  },
  methods: {
    save: async function() {
      this.pending = true;
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/listenbrainz/config`, data: { enabled: this.enabled } });
        iziToast.success({ title: this.t('admin.listenbrainz.toastSaved'), position: 'topCenter', timeout: 3000 });
      } catch {
        iziToast.error({ title: this.t('admin.listenbrainz.toastFailed'), position: 'topCenter', timeout: 3000 });
      } finally { this.pending = false; }
    }
  }
});

const discordWebhookView = Vue.component('discord-webhook-view', {
  data() {
    return { enabled: false, url: '', pending: false };
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{ t('admin.discordWebhook.title') }}</span>
              <p style="margin-bottom:1rem;">{{ t('admin.discordWebhook.desc') }}</p>
              <table><tbody>
                <tr>
                  <td style="width:140px"><b>{{ t('admin.discordWebhook.labelEnable') }}</b></td>
                  <td><input type="checkbox" v-model="enabled" style="margin:0;width:auto;height:auto;" /> {{ t('admin.discordWebhook.checkboxEnable') }}</td>
                </tr>
                <tr>
                  <td><b>{{ t('admin.discordWebhook.labelUrl') }}</b></td>
                  <td><input v-model="url" type="text" :placeholder="t('admin.discordWebhook.urlPlaceholder')" autocomplete="off" data-form-type="other" data-lpignore="true" data-1p-ignore data-bwignore spellcheck="false" style="margin:0;width:100%;max-width:520px" /></td>
                </tr>
                <tr>
                  <td></td>
                  <td style="font-size:0.82rem;color:#999;">{{ t('admin.discordWebhook.urlHint') }}</td>
                </tr>
              </tbody></table>
            </div>
            <div class="card-action">
              <button class="btn" v-on:click="save()" :disabled="pending">
                {{ pending ? t('admin.common.saving') : t('admin.common.save') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  async mounted() {
    try {
      const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/discord-webhook/config` });
      this.enabled = res.data.enabled === true;
      this.url     = res.data.url || '';
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  },
  methods: {
    save: async function() {
      this.pending = true;
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/discord-webhook/config`, data: { enabled: this.enabled, url: this.url } });
        iziToast.success({ title: this.t('admin.discordWebhook.toastSaved'), position: 'topCenter', timeout: 3000 });
      } catch(err) {
        const msg = err?.response?.data?.error || this.t('admin.discordWebhook.toastFailed');
        iziToast.error({ title: msg, position: 'topCenter', timeout: 4000 });
      } finally { this.pending = false; }
    }
  }
});

const customWebhooksView = Vue.component('custom-webhooks-view', {
  data() {
    return {
      discord: { enabled: false, url: '' },
      webhooks: [
        { name: '', url: '', enabled: false },
        { name: '', url: '', enabled: false },
      ],
      pending: false,
    };
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{ t('admin.customWebhooks.title') }}</span>
              <p style="margin-bottom:1.25rem;">{{ t('admin.customWebhooks.desc') }}</p>

              <!-- Discord webhook slot -->
              <div style="border:1px solid #ddd;border-radius:6px;padding:1rem;margin-bottom:1rem;">
                <div style="font-weight:600;margin-bottom:.75rem;">Discord Webhook</div>
                <table><tbody>
                  <tr>
                    <td style="width:140px"><b>{{ t('admin.customWebhooks.labelEnable') }}</b></td>
                    <td><input type="checkbox" v-model="discord.enabled" style="margin:0;width:auto;height:auto;" /> {{ t('admin.customWebhooks.checkboxEnable') }}</td>
                  </tr>
                  <tr>
                    <td><b>{{ t('admin.customWebhooks.labelUrl') }}</b></td>
                    <td><input v-model="discord.url" type="text" placeholder="https://discord.com/api/webhooks/…" autocomplete="off" data-form-type="other" data-lpignore="true" data-1p-ignore spellcheck="false" style="margin:0;width:100%;max-width:520px" /></td>
                  </tr>
                  <tr>
                    <td></td>
                    <td style="font-size:0.82rem;color:#999;">{{ t('admin.discordWebhook.urlHint') }}</td>
                  </tr>
                </tbody></table>
              </div>

              <!-- Custom webhook slots -->
              <div v-for="(wh, i) in webhooks" :key="i" style="border:1px solid #ddd;border-radius:6px;padding:1rem;margin-bottom:1rem;">
                <div style="font-weight:600;margin-bottom:.75rem;">{{ t('admin.customWebhooks.slotLabel', { n: i + 1 }) }}</div>
                <table><tbody>
                  <tr>
                    <td style="width:140px"><b>{{ t('admin.customWebhooks.labelEnable') }}</b></td>
                    <td><input type="checkbox" v-model="wh.enabled" style="margin:0;width:auto;height:auto;" /> {{ t('admin.customWebhooks.checkboxEnable') }}</td>
                  </tr>
                  <tr>
                    <td><b>{{ t('admin.customWebhooks.labelName') }}</b></td>
                    <td><input v-model="wh.name" type="text" :placeholder="t('admin.customWebhooks.namePlaceholder')" autocomplete="off" data-form-type="other" data-lpignore="true" data-1p-ignore spellcheck="false" style="margin:0;width:100%;max-width:320px" /></td>
                  </tr>
                  <tr>
                    <td><b>{{ t('admin.customWebhooks.labelUrl') }}</b></td>
                    <td><input v-model="wh.url" type="text" :placeholder="t('admin.customWebhooks.urlPlaceholder')" autocomplete="off" data-form-type="other" data-lpignore="true" data-1p-ignore spellcheck="false" style="margin:0;width:100%;max-width:520px" /></td>
                  </tr>
                  <tr>
                    <td></td>
                    <td style="font-size:0.82rem;color:#999;">{{ t('admin.customWebhooks.urlHint') }}</td>
                  </tr>
                </tbody></table>
              </div>
            </div>
            <div class="card-action">
              <button class="btn" v-on:click="save()" :disabled="pending">
                {{ pending ? t('admin.common.saving') : t('admin.common.save') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  async mounted() {
    try {
      const [dw, cw] = await Promise.all([
        API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/discord-webhook/config` }),
        API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/custom-webhooks/config` }),
      ]);
      this.discord = { enabled: dw.data.enabled === true, url: dw.data.url || '' };
      const slots = cw.data.webhooks || [];
      this.webhooks = [0, 1].map(i => ({
        name:    slots[i]?.name    || '',
        url:     slots[i]?.url     || '',
        enabled: slots[i]?.enabled === true,
      }));
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  },
  methods: {
    save: async function() {
      this.pending = true;
      try {
        await Promise.all([
          API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/discord-webhook/config`, data: { enabled: this.discord.enabled, url: this.discord.url } }),
          API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/custom-webhooks/config`, data: { webhooks: this.webhooks } }),
        ]);
        iziToast.success({ title: this.t('admin.customWebhooks.toastSaved'), position: 'topCenter', timeout: 3000 });
      } catch(err) {
        const msg = err?.response?.data?.error || this.t('admin.customWebhooks.toastFailed');
        iziToast.error({ title: msg, position: 'topCenter', timeout: 4000 });
      } finally { this.pending = false; }
    }
  }
});

const languagesView = Vue.component('languages-view', {
  data() {
    return {
      all: [
        { code: 'en', name: 'English' },
        { code: 'nl', name: 'Nederlands' },
        { code: 'de', name: 'Deutsch' },
        { code: 'fr', name: 'Français' },
        { code: 'es', name: 'Español' },
        { code: 'it', name: 'Italiano' },
        { code: 'pt', name: 'Português' },
        { code: 'pl', name: 'Polski' },
        { code: 'ru', name: 'Русский' },
        { code: 'zh', name: '中文' },
        { code: 'ja', name: '日本語' },
        { code: 'ko', name: '한국어' },
      ],
      enabled: [],
      pending: false,
    };
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{ t('admin.languages.title') }}</span>
              <p style="margin-bottom:1rem;">{{ t('admin.languages.desc') }}</p>
              <table>
                <tbody>
                  <tr v-for="lang in all" :key="lang.code">
                    <td style="width:40px;padding:6px 4px;">
                      <input
                        type="checkbox"
                        :checked="isEnabled(lang.code)"
                        :disabled="lang.code === 'en'"
                        @change="toggle(lang.code)"
                        style="margin:0;width:auto;height:auto;"
                      />
                    </td>
                    <td style="padding:6px 8px;"><b>{{ lang.name }}</b> <small style="color:#888;">({{ lang.code }})</small></td>
                    <td style="padding:6px 4px;color:#888;font-size:.82rem;font-style:italic;">
                      <span v-if="lang.code === 'en'">{{ t('admin.languages.alwaysOn') }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="card-action">
              <button class="btn" @click="save()" :disabled="pending">
                {{ pending ? t('admin.common.saving') : t('admin.common.save') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  async mounted() {
    try {
      const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/languages/config` });
      this.enabled = res.data.enabled || this.all.map(l => l.code);
    } catch {
      this.enabled = this.all.map(l => l.code);
    }
  },
  methods: {
    isEnabled(code) {
      return code === 'en' || this.enabled.includes(code);
    },
    toggle(code) {
      if (code === 'en') return;
      const idx = this.enabled.indexOf(code);
      if (idx === -1) this.enabled = [...this.enabled, code];
      else this.enabled = this.enabled.filter(c => c !== code);
    },
    save: async function() {
      this.pending = true;
      try {
        const toSave = ['en', ...this.enabled.filter(c => c !== 'en')];
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/languages/config`,
          data: { enabled: toSave }
        });
        iziToast.success({ title: this.t('admin.languages.toastSaved'), position: 'topCenter', timeout: 3000 });
      } catch {
        iziToast.error({ title: this.t('admin.languages.toastFailed'), position: 'topCenter', timeout: 3000 });
      } finally {
        this.pending = false;
      }
    }
  }
});

const discogsView = Vue.component('discogs-view', {
  data() {
    return {
      enabled: false,
      allowArtUpdate: false,
      apiKey: '',
      apiSecret: '',
      userAgentTag: '',
      itunesEnabled: true,
      deezerEnabled: true,
      pending: false,
    };
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{ t('admin.discogs.title') }}</span>
              <p style="margin-bottom:0.5rem;">{{t('admin.discogs.desc1')}}</p>
              <p style="margin-bottom:0.5rem;">{{t('admin.discogs.desc2')}}</p>
              <p style="margin-bottom:1rem; font-size:0.85rem; color:#999;">{{t('admin.discogs.secretHint')}}</p>
              <table>
                <tbody>
                  <tr>
                    <td style="width:160px"><b>{{ t('admin.discogs.labelEnable') }}</b></td>
                    <td><input type="checkbox" v-model="enabled" style="margin:0;width:auto;height:auto;" /> {{ t('admin.discogs.checkboxEnable') }}</td>
                  </tr>
                  <tr>
                    <td><b>{{ t('admin.discogs.labelAllowArtUpdate') }}</b></td>
                    <td>
                      <input type="checkbox" v-model="allowArtUpdate" style="margin:0;width:auto;height:auto;" /> {{ t('admin.discogs.checkboxAllowArtUpdate') }}
                      <div style="font-size:0.78rem;color:#999;margin-top:4px;">{{t('admin.discogs.allowArtUpdateDesc')}}</div>
                    </td>
                  </tr>
                  <tr>
                    <td><b>{{ t('admin.discogs.labelApiKey') }}</b></td>
                    <td><input v-model="apiKey" type="text" :placeholder="t('admin.discogs.apiKeyPlaceholder')" autocomplete="off" data-form-type="other" data-lpignore="true" data-1p-ignore data-bwignore spellcheck="false" style="margin:0" /></td>
                  </tr>
                  <tr>
                    <td><b>{{ t('admin.discogs.labelApiSecret') }}</b></td>
                    <td><input v-model="apiSecret" type="password" :placeholder="t('admin.discogs.apiSecretPlaceholder')" autocomplete="new-password" data-form-type="other" data-lpignore="true" data-1p-ignore data-bwignore style="margin:0" /></td>
                  </tr>
                  <tr>
                    <td><b>{{ t('admin.discogs.labelInstanceTag') }}</b></td>
                    <td>
                      <input v-model="userAgentTag" type="text" maxlength="4" placeholder="e.g. amr" autocomplete="off" spellcheck="false" style="margin:0;width:80px;text-transform:lowercase" />
                      <div style="font-size:0.78rem;color:#999;margin-top:4px;">{{t('admin.discogs.instanceTagDesc')}}</div>
                    </td>
                  </tr>
                  <tr>
                    <td><b>{{ t('admin.discogs.labelItunes') }}</b></td>
                    <td>
                      <input type="checkbox" v-model="itunesEnabled" style="margin:0;width:auto;height:auto;" /> {{ t('admin.discogs.checkboxItunes') }}
                      <div style="font-size:0.78rem;color:#999;margin-top:4px;">{{t('admin.discogs.itunesDesc')}}</div>
                    </td>
                  </tr>
                  <tr>
                    <td><b>{{ t('admin.discogs.labelDeezer') }}</b></td>
                    <td>
                      <input type="checkbox" v-model="deezerEnabled" style="margin:0;width:auto;height:auto;" /> {{ t('admin.discogs.checkboxDeezer') }}
                      <div style="font-size:0.78rem;color:#999;margin-top:4px;">{{t('admin.discogs.deezerDesc')}}</div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="card-action">
              <button class="btn" v-on:click="save()" :disabled="pending">
                {{ pending ? t('admin.common.saving') : t('admin.common.save') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  async mounted() {
    try {
      const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/discogs/config` });
      this.enabled        = !!res.data.enabled;
      this.allowArtUpdate = !!res.data.allowArtUpdate;
      this.apiKey         = res.data.apiKey       || '';
      this.apiSecret      = res.data.apiSecret    || '';
      this.userAgentTag   = res.data.userAgentTag || '';
      this.itunesEnabled  = res.data.itunesEnabled !== false;
      this.deezerEnabled  = res.data.deezerEnabled !== false;
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  },
  methods: {
    save: async function() {
      this.pending = true;
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/discogs/config`,
          data: {
            enabled: this.enabled,
            allowArtUpdate: this.allowArtUpdate,
            apiKey: this.apiKey.trim(),
            apiSecret: this.apiSecret.trim(),
            userAgentTag: this.userAgentTag.trim().slice(0,4).replaceAll(/[^a-zA-Z0-9]/g,''),
            itunesEnabled: this.itunesEnabled,
            deezerEnabled: this.deezerEnabled,
          }
        });
        iziToast.success({ title: this.t('admin.discogs.toastSaved'), position: 'topCenter', timeout: 3000 });
      } catch {
        iziToast.error({ title: this.t('admin.discogs.toastFailed'), position: 'topCenter', timeout: 3000 });
      } finally {
        this.pending = false;
      }
    }
  }
});

const acoustidView = Vue.component('acoustid-view', {
  data() {
    return {
      enabled:  false,
      apiKey:   '',
      hasKey:   false,
      pending:  false,
      fpcalcAvailable: true,
      // worker status
      running:    false,
      stopping:   false,
      scanActive: false,
      stats: { total: 0, found: 0, not_found: 0, errors: 0, pending: 0, queued: 0 },
      startedAt: null,
      rateWindow: [], // [{processed, at}] rolling 10-min window for rate calc
      _pollTimer: null,
    };
  },
  computed: {
    fingerprinted() { return (this.stats.found || 0) + (this.stats.not_found || 0) + (this.stats.errors || 0); },
    noMatch()        { return (this.stats.not_found || 0) + (this.stats.errors || 0); },
    pct() {
      const t = this.stats.total || 0;
      if (!t) return 0;
      return Math.round((this.fingerprinted / t) * 100);
    },
    elapsedLabel() {
      if (!this.startedAt || !this.running) return null;
      const s = Math.floor((Date.now() - this.startedAt) / 1000);
      const m = Math.floor(s / 60) % 60, h = Math.floor(s / 3600) % 24, d = Math.floor(s / 86400);
      if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
      if (h > 0) return h + 'h ' + m + 'm';
      return m + 'm';
    },
    actualRatePerSec() {
      if (!this.running || this.rateWindow.length < 2) return null;
      const oldest = this.rateWindow[0];
      const newest = this.rateWindow[this.rateWindow.length - 1];
      const elapsed = (newest.at - oldest.at) / 1000;
      if (elapsed < 60) return null;
      const processed = newest.processed - oldest.processed;
      if (processed <= 0) return null;
      return processed / elapsed;
    },
    rateStatus() {
      if (!this.running) return null;
      if (this.rateWindow.length < 2) return 'measuring';
      const oldest = this.rateWindow[0];
      const newest = this.rateWindow[this.rateWindow.length - 1];
      const elapsed = (newest.at - oldest.at) / 1000;
      if (elapsed < 60) return 'measuring';
      const processed = newest.processed - oldest.processed;
      if (processed <= 0) return 'stalled';
      return 'ok';
    },
    etaLabel() {
      const rate = this.actualRatePerSec;
      if (!rate) return null;
      const remaining = (this.stats.queued || 0) + (this.stats.pending || 0);
      if (remaining <= 0) return null;
      const sec = remaining / rate;
      if (sec < 3600) return Math.ceil(sec / 60) + 'm';
      if (sec < 86400) return (sec / 3600).toFixed(1) + 'h';
      return (sec / 86400).toFixed(1) + 'd';
    },
    statusLabel() {
      if (this.stopping)                   return this.t('admin.acoustid.statusStopping');
      if (this.running && this.scanActive) return this.t('admin.acoustid.statusWaitingScan');
      if (this.running)                   return this.t('admin.acoustid.statusRunning');
      return this.t('admin.acoustid.statusIdle');
    },
    statusColor() {
      if (this.running)  return 'var(--accent)';
      if (this.stopping) return '#f0a500';
      return '#888';
    },
    canStart() {
      return this.enabled && this.hasKey && this.fpcalcAvailable && !this.running && !this.stopping;
    },
    canStop() {
      return this.running && !this.stopping;
    },
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">

          <!-- Settings card -->
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{ t('admin.acoustid.title') }}</span>
              <p style="margin-bottom:0.5rem;">{{ t('admin.acoustid.desc1') }}</p>
              <p style="margin-bottom:0.5rem; font-size:0.85rem; color:#999;">{{ t('admin.acoustid.secretHint') }}</p>
              <div v-if="!fpcalcAvailable" style="background:#3a2a00;border-left:3px solid #e57373;padding:8px 12px;border-radius:4px;margin-bottom:1rem;font-size:0.85rem;color:#ef9a9a;">
                ⚠ {{ t('admin.acoustid.warnNoFpcalc') }}
              </div>
              <div v-if="!hasKey" style="background:#3a2a00;border-left:3px solid #f0a500;padding:8px 12px;border-radius:4px;margin-bottom:1rem;font-size:0.85rem;">
                ⚠ {{ t('admin.acoustid.warnNoKey') }}
              </div>
              <table>
                <tbody>
                  <tr>
                    <td style="width:160px"><b>{{ t('admin.acoustid.labelEnable') }}</b></td>
                    <td><input type="checkbox" v-model="enabled" style="margin:0;width:auto;height:auto;" /> {{ t('admin.acoustid.checkboxEnable') }}</td>
                  </tr>
                  <tr>
                    <td><b>{{ t('admin.acoustid.labelApiKey') }}</b></td>
                    <td>
                      <input v-model="apiKey" type="text"
                        :placeholder="t('admin.acoustid.apiKeyPlaceholder')"
                        autocomplete="off" data-form-type="other"
                        data-lpignore="true" data-1p-ignore data-bwignore
                        spellcheck="false" style="margin:0;font-family:monospace;" />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="card-action">
              <button class="btn" v-on:click="save()" :disabled="pending">
                {{ pending ? t('admin.common.saving') : t('admin.common.save') }}
              </button>
            </div>
          </div>

          <!-- Progress card -->
          <div class="card">
            <div class="card-content">
              <span class="card-title">
                {{ t('admin.acoustid.progressTitle') }}
                <span :style="{ color: statusColor, fontSize: '0.75rem', marginLeft: '10px', fontWeight: 'normal' }">
                  ● {{ statusLabel }}
                </span>
              </span>
              <div style="margin-bottom:1rem;">
                <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:0.9rem;">
                  <span>{{ t('admin.acoustid.statsFingerprinted') }}: <b>{{ fingerprinted.toLocaleString() }} / {{ stats.total.toLocaleString() }}</b></span>
                  <span><b>{{ pct }}%</b></span>
                </div>
                <div style="background:#333;border-radius:4px;height:8px;overflow:hidden;">
                  <div :style="{ width: pct + '%', background: 'var(--accent)', height: '100%', transition: 'width 0.5s' }"></div>
                </div>
              </div>
              <table style="font-size:0.85rem;width:auto;">
                <tbody>
                  <tr>
                    <td style="padding:2px 12px 2px 0;color:#4caf50;">{{ t('admin.acoustid.statsFound') }}</td>
                    <td><b>{{ (stats.found||0).toLocaleString() }}</b></td>
                  </tr>
                  <tr>
                    <td style="padding:2px 12px 2px 0;color:#888;">{{ t('admin.acoustid.statsNotFound') }}</td>
                    <td><b>{{ noMatch.toLocaleString() }}</b></td>
                  </tr>
                  <tr>
                    <td style="padding:2px 12px 2px 0;color:#aaa;">{{ t('admin.acoustid.statsQueued') }}</td>
                    <td><b>{{ (stats.queued||0).toLocaleString() }}</b></td>
                  </tr>
                </tbody>
              </table>
              <div v-if="running" style="margin-top:0.75rem;font-size:0.8rem;color:#aaa;">
                <span v-if="elapsedLabel">{{ t('admin.acoustid.elapsedLabel') }}: <b>{{ elapsedLabel }}</b></span>
                <span v-if="rateStatus === 'ok'"> &bull; {{ t('admin.acoustid.liveRate') }}: <b>~{{ actualRatePerSec.toFixed(2) }}/s</b></span>
                <span v-if="rateStatus === 'ok' && etaLabel"> &bull; {{ t('admin.acoustid.eta') }}: <b>~{{ etaLabel }}</b></span>
                <span v-if="rateStatus === 'measuring'" style="color:#888;"> &bull; {{ t('admin.acoustid.rateCalcWait') }}</span>
                <span v-if="rateStatus === 'stalled'" style="color:#e57373;"> &bull; {{ t('admin.acoustid.rateStalled') }}</span>
              </div>
              <p style="margin-top:0.5rem;font-size:0.78rem;color:#666;">{{ t('admin.acoustid.rateNote') }}</p>
            </div>
            <div class="card-action" style="display:flex;gap:0.5rem;flex-wrap:wrap;">
              <button class="btn" v-on:click="startScan()" :disabled="!canStart">
                {{ t('admin.acoustid.btnStart') }}
              </button>
              <button class="btn btn-flat" v-on:click="stopScan()" :disabled="!canStop" style="margin-left:0;">
                {{ stopping ? t('admin.acoustid.btnStopping') : t('admin.acoustid.btnStop') }}
              </button>
              <button v-if="stats.errors > 0" class="btn btn-flat" v-on:click="resetErrors()" style="margin-left:0;border-color:#e57373;color:#e57373;">
                {{ t('admin.acoustid.btnRetryErrors', { count: stats.errors }) }}
              </button>
            </div>
          </div>

        </div>
      </div>
    </div>`,
  async mounted() {
    await this.loadConfig();
    await this.loadStatus();
    // Poll status every 5 s while component is mounted
    this._pollTimer = setInterval(() => this.loadStatus(), 5000);
  },
  beforeUnmount() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  },
  methods: {
    async loadConfig() {
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/acoustid/config` });
        this.enabled = !!res.data.enabled;
        this.apiKey  = res.data.apiKey  || '';
        this.hasKey  = !!res.data.hasKey;
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    },
    async loadStatus() {
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/acoustid/status` });
        this.running         = !!res.data.running;
        this.stopping        = !!res.data.stopping;
        this.scanActive      = !!res.data.scanActive;
        this.startedAt       = res.data.startedAt || null;
        this.fpcalcAvailable = res.data.fpcalcAvailable !== false;
        if (res.data.stats) this.stats = res.data.stats;
        if (this.running) {
          const now = Date.now();
          this.rateWindow.push({ processed: this.fingerprinted, at: now });
          // Keep only last 10 minutes of samples (120 polls at 5s each)
          const cutoff = now - 10 * 60 * 1000;
          while (this.rateWindow.length > 1 && this.rateWindow[0].at < cutoff) this.rateWindow.shift();
        } else {
          this.rateWindow = [];
        }
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    },
    async save() {
      this.pending = true;
      try {
        await API.axios({
          method: 'POST',
          url:  `${API.url()}/api/v1/admin/acoustid/config`,
          data: { enabled: this.enabled, apiKey: this.apiKey.trim() },
        });
        iziToast.success({ title: this.t('admin.acoustid.toastSaved'), position: 'topCenter', timeout: 3000 });
        await this.loadConfig();
      } catch {
        iziToast.error({ title: this.t('admin.acoustid.toastFailed'), position: 'topCenter', timeout: 3000 });
      } finally {
        this.pending = false;
      }
    },
    async startScan() {
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/acoustid/start` });
        if (res?.data?.pending === true) {
          this.running = false;
          this.stopping = false;
          const queuedMsg = this.t('admin.bpmAnalysis.msgQueuedScan', { feature: this.t('admin.acoustid.title') });
          iziToast.info({ title: queuedMsg, position: 'topCenter', timeout: 4500 });
          await this.loadStatus();
          return;
        }
        await this.loadStatus();
      } catch(err) {
        const msg = err?.response?.data?.error || err.message || 'Unknown error';
        iziToast.error({ title: msg, position: 'topCenter', timeout: 4000 });
      }
    },
    async stopScan() {
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/acoustid/stop` });
        this.stopping = true;
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    },
    async resetErrors() {
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/acoustid/reset-errors` });
        iziToast.success({ title: this.t('admin.acoustid.toastErrorsReset', { count: res.data.reset || 0 }), position: 'topCenter', timeout: 3000 });
        await this.loadStatus();
      } catch(err) {
        iziToast.error({ title: err?.response?.data?.error || err.message || 'Failed', position: 'topCenter', timeout: 3000 });
      }
    },
  }
});

// ── Normalisation Workshop ────────────────────────────────────────────────────
const rgWorkshopView = Vue.component('rg-workshop-view', {
  data() {
    return {
      running:     false,
      stopping:    false,
      startedAt:   null,
      tool:        'ffmpeg',
      currentFile: null,
      rate:        0,
      stats: {
        total:           0,
        measured:        0,
        queued:          0,
        failed:          0,
        shelved:         0,
        has_tags:        0,
        measured_rsgain: 0,
        measured_ffmpeg: 0,
      },
      msg: '',
      _timer: null,
      failedModal:   false,
      failedFiles:   [],
      failedLoading: false,
      undoAvailable: false,
      undoCount:     0,
      undoResetAt:   null,
    };
  },
  computed: {
    statusLabel() {
      if (this.stopping) return this.t('admin.rg.statusStopping');
      if (this.running)  return this.t('admin.rg.statusRunning');
      return this.t('admin.rg.statusIdle');
    },
    progressPct() {
      if (!this.stats.total) return 0;
      const p = (this.stats.measured / this.stats.total) * 100;
      if (p < 1) return Number.parseFloat(p.toFixed(2));
      return Number.parseFloat(p.toFixed(1));
    },
    unmeasured() {
      return Math.max(0, (this.stats.total || 0) - (this.stats.measured || 0));
    },
    undoAgo() {
      if (!this.undoResetAt) return '';
      const secs = Math.floor(Date.now() / 1000) - this.undoResetAt;
      if (secs < 60) return this.t('admin.rg.undoAgoJustNow');
      const mins = Math.floor(secs / 60);
      if (mins < 60) return this.t('admin.rg.undoAgoMinutes', { n: mins });
      const hrs = Math.floor(mins / 60);
      return this.t('admin.rg.undoAgoHours', { n: hrs });
    },
  },
  mounted() { this.loadStatus(); },
  beforeUnmount() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  },
  methods: {
    async loadStatus() {
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/rg/status` });
        const d = res.data;
        const wasRunning = this.running;
        this.running     = d.running  || false;
        this.stopping    = d.stopping || false;
        this.startedAt   = d.startedAt || null;
        this.tool        = d.tool     || 'ffmpeg';
        this.currentFile = d.currentFile || null;
        if (d.undo) {
          this.undoAvailable = d.undo.available || false;
          this.undoCount     = d.undo.count     || 0;
          this.undoResetAt   = d.undo.resetAt   || null;
        }
        if (d.stats) {
          if (this.running && wasRunning && this._prevMeasured != null) {
            const delta = (d.stats.measured || 0) - this._prevMeasured;
            const deltaSec = (Date.now() - this._prevTime) / 1000;
            if (delta > 0 && deltaSec > 0) {
              this.rate = Math.round(delta / deltaSec * 60);
            }
          }
          if (!this.running) this.rate = 0;
          this._prevMeasured = d.stats.measured || 0;
          this._prevTime = Date.now();
          Object.assign(this.stats, d.stats);
        }
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      this._timer = setTimeout(() => this.loadStatus(), this.running ? 3000 : 15000);
    },
    async start() {
      this.msg = '';
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/rg/start` });
        if (res?.data?.status === 'pending') {
          this.running = false;
          this.stopping = false;
          const queuedMsg = this.t('admin.bpmAnalysis.msgQueuedScan', { feature: this.t('admin.rg.title') });
          this.msg = queuedMsg;
          iziToast.info({ title: queuedMsg, position: 'topCenter', timeout: 4500 });
          this.loadStatus();
          return;
        }
        this.running = true; this.stopping = false;
        this.msg = this.t('admin.rg.msgStarted');
      } catch(e) {
        this.msg = e?.response?.data?.error || e.message || 'Error';
        iziToast.error({ title: this.msg, position: 'topCenter', timeout: 3500 });
      }
    },
    async stop() {
      this.msg = '';
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/rg/stop` });
        this.stopping = true;
        this.msg = this.t('admin.rg.msgStopping');
      } catch(e) { this.msg = e.message || 'Error'; }
    },
    async resetFailed() {
      this.msg = '';
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/rg/reset-failed` });
        const reset  = res.data.reset  || 0;
        const purged = res.data.purged || 0;
        if (purged > 0 && reset > 0)
          this.msg = this.t('admin.rg.msgResetAndPurged', { reset, purged });
        else if (purged > 0)
          this.msg = this.t('admin.rg.msgPurged', { count: purged });
        else
          this.msg = this.t('admin.rg.msgReset', { count: reset });
        await this.loadStatus();
      } catch(e) { this.msg = e.message || 'Error'; }
    },
    async openFailedModal() {
      this.failedModal   = true;
      this.failedLoading = true;
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/rg/failed` });
        this.failedFiles = res.data.files || [];
      } catch(e) { this.msg = e.message || 'Error'; }
      this.failedLoading = false;
    },
    async shelveFile(id) {
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/rg/shelve`, data: { ids: [id] } });
        this.failedFiles = this.failedFiles.filter(f => f.id !== id);
        await this.loadStatus();
      } catch(e) { this.msg = e.message || 'Error'; }
    },
    async shelveAllFailed() {
      if (!this.failedFiles.length) return;
      const ids = this.failedFiles.map(f => f.id);
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/rg/shelve`, data: { ids } });
        this.msg = this.t('admin.rg.msgShelved', { count: res.data.shelved || 0 });
        this.failedFiles = [];
        this.failedModal = false;
        await this.loadStatus();
      } catch(e) { this.msg = e.message || 'Error'; }
    },
    reasonLabel(reason) {
      const map = {
        'measure_failed': this.t('admin.rg.reasonMeasureFailed'),
        'timed_out':      this.t('admin.rg.reasonTimedOut'),
        'file_not_found': this.t('admin.rg.reasonFileNotFound'),
        'missing_vpath':  this.t('admin.rg.reasonMissingVpath'),
        'resource_fork':  this.t('admin.rg.reasonResourceFork'),
      };
      return map[reason] || reason;
    },
    durationLabel(secs) {
      if (!secs) return '';
      const s = Math.round(secs);
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60), h = Math.floor(m / 60);
      if (h) return h + 'h\u00a0' + (m % 60) + 'm';
      return m + 'm';
    },
    async resetAll() {
      if (!window.confirm(this.t('admin.rg.confirmResetAll'))) return;
      this.msg = '';
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/rg/reset-all` });
        this.msg = this.t('admin.rg.msgResetAll', { count: res.data.reset || 0 });
        await this.loadStatus();
      } catch(e) { this.msg = e?.response?.data?.error || e.message || 'Error'; }
    },
    async undoResetAll() {
      if (!window.confirm(this.t('admin.rg.confirmUndoReset', { count: this.undoCount.toLocaleString() }))) return;
      this.msg = '';
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/rg/undo-reset-all` });
        this.msg = this.t('admin.rg.msgUndoDone', { count: res.data.restored || 0 });
        await this.loadStatus();
      } catch(e) { this.msg = e?.response?.data?.error || e.message || 'Error'; }
    },
    pct(n) { return this.stats.total ? ((n / this.stats.total) * 100).toFixed(1) : '0'; },
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{ t('admin.rg.title') }}</span>
              <p style="margin-bottom:0.75rem; color:#aaa; font-size:0.88rem;">{{ t('admin.rg.desc') }}</p>

              <!-- Tool banner -->
              <div style="background:rgba(255,255,255,0.04); border-left:3px solid var(--primary); border-radius:0 4px 4px 0; padding:0.5rem 0.75rem; margin-bottom:1rem; font-size:0.82rem; color:#bbb;">
                <span v-if="tool === 'rsgain'">&#x2705; {{ t('admin.rg.toolRsgain') }}</span>
                <span v-else>&#x26A1; {{ t('admin.rg.toolFfmpeg') }}</span>
              </div>

              <!-- Progress overview -->
              <div style="background:var(--raised2); border-radius:8px; padding:1rem; margin-bottom:1rem;">
                <b style="display:block; margin-bottom:0.5rem;">{{ t('admin.rg.overviewTitle') }}</b>
                <div style="margin-bottom:0.5rem; font-size:0.88rem; color:#aaa;">
                  {{ stats.measured.toLocaleString() }} / {{ stats.total.toLocaleString() }} {{ t('admin.rg.measured') }}
                  &mdash; {{ progressPct }}%
                  <span v-if="running && rate > 0" style="margin-left:0.5rem; color:#7986cb; font-size:0.82rem;">({{ rate }} files/min)</span>
                </div>
                <div style="background:rgba(255,255,255,0.08); border-radius:4px; height:6px; margin-bottom:1rem;">
                  <div :style="'background:var(--primary);height:6px;border-radius:4px;width:'+progressPct+'%;transition:width .4s;'"></div>
                </div>
                <table style="font-size:0.85rem; border-collapse:collapse; width:100%;">
                  <tr>
                    <td style="padding:2px 0 2px 0; color:#4caf50; min-width:160px;">{{ t('admin.rg.statsMeasured') }}</td>
                    <td style="padding:2px 12px 2px 0; text-align:right; font-variant-numeric:tabular-nums;"><b>{{ (stats.measured||0).toLocaleString() }}</b></td>
                    <td style="color:#666; font-size:0.78rem; text-align:right; min-width:46px;">{{ pct(stats.measured) }}%</td>
                  </tr>
                  <tr v-if="stats.measured_rsgain">
                    <td style="padding:2px 0 2px 1rem; color:#81c784;">&#x21B3; rsgain</td>
                    <td style="text-align:right; font-variant-numeric:tabular-nums;"><b>{{ (stats.measured_rsgain||0).toLocaleString() }}</b></td>
                    <td></td>
                  </tr>
                  <tr v-if="stats.measured_ffmpeg">
                    <td style="padding:2px 0 2px 1rem; color:#aaa;">&#x21B3; ffmpeg</td>
                    <td style="text-align:right; font-variant-numeric:tabular-nums;"><b>{{ (stats.measured_ffmpeg||0).toLocaleString() }}</b></td>
                    <td></td>
                  </tr>
                  <tr>
                    <td style="padding:2px 0 2px 0; color:#aaa;">{{ t('admin.rg.statsQueued') }}</td>
                    <td style="padding:2px 12px 2px 0; text-align:right; font-variant-numeric:tabular-nums;"><b>{{ (stats.queued||0).toLocaleString() }}</b></td>
                    <td style="color:#666; font-size:0.78rem; text-align:right;">{{ pct(stats.queued||0) }}%</td>
                  </tr>
                  <tr v-if="stats.failed">
                    <td style="padding:2px 0 2px 0; color:#e57373; cursor:pointer; user-select:none;" @click="openFailedModal" :title="t('admin.rg.failedModalTitle')">{{ t('admin.rg.statsFailed') }} &#x2139;</td>
                    <td style="text-align:right; font-variant-numeric:tabular-nums;"><b>{{ (stats.failed||0).toLocaleString() }}</b></td>
                    <td></td>
                  </tr>
                  <tr v-if="stats.shelved">
                    <td style="padding:2px 0 2px 0; color:#888;">{{ t('admin.rg.statsShelved') }}</td>
                    <td style="text-align:right; font-variant-numeric:tabular-nums;"><b>{{ (stats.shelved||0).toLocaleString() }}</b></td>
                    <td></td>
                  </tr>
                  <tr v-if="stats.has_tags">
                    <td style="padding:2px 0 2px 0; color:#7986cb;">{{ t('admin.rg.statsHasTags') }}</td>
                    <td style="text-align:right; font-variant-numeric:tabular-nums;"><b>{{ (stats.has_tags||0).toLocaleString() }}</b></td>
                    <td></td>
                  </tr>
                </table>
              </div>

              <!-- Controls -->
              <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-bottom:0.75rem;">
                <button class="btn btn-small" @click="start" :disabled="running || stopping">
                  {{ t('admin.rg.btnStart') }}
                </button>
                <button class="btn btn-small btn-flat" @click="stop" :disabled="!running || stopping">
                  {{ t('admin.rg.btnStop') }}
                </button>
                <button class="btn btn-small btn-flat" @click="resetFailed" :disabled="running || !stats.failed" style="margin-left:auto;">
                  {{ t('admin.rg.btnResetFailed') }} ({{ stats.failed || 0 }})
                </button>
                <button class="btn btn-small btn-flat" @click="resetAll" :disabled="running" style="color:#e57373;">
                  {{ t('admin.rg.btnResetAll') }}
                </button>
              </div>

              <!-- Undo banner -->
              <div v-if="undoAvailable && !running" style="display:flex; align-items:center; gap:0.75rem; background:rgba(255,167,38,0.08); border:1px solid rgba(255,167,38,0.3); border-radius:6px; padding:0.5rem 0.75rem; margin-bottom:0.75rem; font-size:0.83rem;">
                <span style="flex:1; color:#ffa726;">&#x21B6; {{ t('admin.rg.undoBanner', { count: undoCount.toLocaleString(), ago: undoAgo }) }}</span>
                <button class="btn btn-small" @click="undoResetAll" style="background:#ffa726; color:#000; padding:0.2rem 0.7rem; font-size:0.8rem; min-width:0;">
                  {{ t('admin.rg.btnUndoReset') }}
                </button>
              </div>

              <div v-if="running || stopping" style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.5rem; font-size:0.85rem; color:#aaa;">
                <span class="dot-spin"></span>
                {{ statusLabel }}
              </div>
              <div v-if="running && currentFile" style="font-size:0.78rem; color:#777; margin-top:0.25rem; word-break:break-all; font-family:monospace;">&#x25B6; {{ currentFile }}</div>
              <div v-if="msg" style="font-size:0.83rem; color:#aaa; margin-top:0.25rem;">{{ msg }}</div>

            </div>
          </div>
        </div>
      </div>

      <!-- Failed files modal -->
      <div v-if="failedModal" @click.self="failedModal=false"
           style="position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:1000;display:flex;align-items:center;justify-content:center;">
        <div style="background:#1e1e2e;border-radius:8px;padding:1.25rem 1.5rem;max-width:780px;width:95%;max-height:80vh;display:flex;flex-direction:column;gap:0.75rem;">
          <!-- header -->
          <div style="display:flex;align-items:center;gap:0.75rem;">
            <b style="font-size:1rem;color:#e57373;">{{ t('admin.rg.failedModalTitle') }}</b>
            <span style="flex:1;"></span>
            <button class="btn btn-small btn-flat" @click="shelveAllFailed" :disabled="!failedFiles.length"
                    style="color:#e57373;font-size:0.8rem;">
              {{ t('admin.rg.btnShelveAll') }}
            </button>
            <button class="btn btn-small btn-flat" @click="failedModal=false" style="font-size:0.9rem;">&#x2715;</button>
          </div>
          <!-- list -->
          <div v-if="failedLoading" style="color:#aaa;font-size:0.85rem;">Loading&hellip;</div>
          <div v-else-if="!failedFiles.length" style="color:#aaa;font-size:0.85rem;">{{ t('admin.rg.noFailedFiles') }}</div>
          <div v-else style="overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:0.3rem;">
            <div v-for="f in failedFiles" :key="f.id"
                 style="display:flex;align-items:center;gap:0.5rem;padding:0.3rem 0.5rem;background:rgba(255,255,255,0.04);border-radius:4px;font-size:0.8rem;">
              <div style="flex:1;min-width:0;overflow:hidden;">
                <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" :title="f.vpath+'/'+f.filepath">{{ f.filepath.split('/').pop() }}</div>
                <div v-if="f.error" style="font-size:0.72rem;color:#666;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px;" :title="f.error">{{ f.error }}</div>
              </div>
              <span style="color:#e57373;white-space:nowrap;font-size:0.75rem;">{{ reasonLabel(f.reason) }}</span>
              <span v-if="f.duration" style="color:#666;white-space:nowrap;font-size:0.75rem;">{{ durationLabel(f.duration) }}</span>
              <button class="btn btn-small btn-flat" @click="shelveFile(f.id)"
                      style="padding:0.1rem 0.5rem;font-size:0.75rem;min-width:0;white-space:nowrap;">
                {{ t('admin.rg.btnShelve') }}
              </button>
            </div>
          </div>
          <!-- footer hint -->
          <div style="font-size:0.72rem;color:#555;border-top:1px solid rgba(255,255,255,0.06);padding-top:0.5rem;">
            {{ t('admin.rg.shelveHint') }}
          </div>
        </div>
      </div>
    </div>
  `,
});

const bpmWorkshopView = Vue.component('bpm-workshop-view', {
  data() {
    return {
      ab: {
        running: false, stopping: false, currentFile: null, processedCount: 0,
        stats: { total: 0, done: 0, not_found: 0, errors: 0, queued: 0 },
      },
      essentia: {
        running: false, stopping: false, currentFile: null, processedCount: 0,
        binaryAvailable: false,
        stats: { total: 0, done: 0, errors: 0, queued: 0 },
      },
      coverage: { hasBpm: 0, hasKey: 0, total: 0, bySource: { tag: 0, acousticbrainz: 0, essentia: 0 } },
      resetConfirm: false,
      genreCorrect: { pending: false, dryRunResult: null, corrections: [], undoConfirm: false },
      msg: '',
      _timer: null,
    };
  },
  computed: {
    abStatusLabel() {
      if (this.ab.stopping) return this.t('admin.bpmAnalysis.statusStopping');
      if (this.ab.running)  return this.t('admin.bpmAnalysis.statusRunning');
      return this.t('admin.bpmAnalysis.statusIdle');
    },
    essentiaStatusLabel() {
      if (this.essentia.stopping) return this.t('admin.bpmAnalysis.statusStopping');
      if (this.essentia.running)  return this.t('admin.bpmAnalysis.statusRunning');
      return this.t('admin.bpmAnalysis.statusIdle');
    },
    bpmPct() {
      if (!this.coverage.total) return '0.0';
      return ((this.coverage.hasBpm / this.coverage.total) * 100).toFixed(1);
    },
    keyPct() {
      if (!this.coverage.total) return '0.0';
      return ((this.coverage.hasKey / this.coverage.total) * 100).toFixed(1);
    },
  },
  mounted() { this.loadStatus(); },
  beforeUnmount() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  },
  methods: {
    async loadStatus() {
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/bpm/status` });
        const d = res.data;
        this.ab       = { ...this.ab, ...d.ab };
        this.essentia = { ...this.essentia, ...d.essentia };
        this.coverage = d.coverage || this.coverage;
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      const isRunning = this.ab.running || this.essentia.running;
      this._timer = setTimeout(() => this.loadStatus(), isRunning ? 2000 : 30000);
    },
    async abStart() {
      this.msg = '';
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/bpm/ab/start` });
        const status = res?.data?.status || '';
        if (status === 'pending') {
          this.ab.running = false;
          this.ab.stopping = false;
          const queuedMsg = this.t('admin.bpmAnalysis.msgQueuedScan', { feature: this.t('admin.bpmAnalysis.abTitle') });
          this.msg = queuedMsg;
          iziToast.info({ title: queuedMsg, position: 'topCenter', timeout: 4500 });
          this.loadStatus();
          return;
        }
        this.ab.running = true; this.ab.stopping = false;
        this.msg = this.t('admin.bpmAnalysis.msgStarted');
        this.loadStatus();
      } catch(e) {
        this.msg = e?.response?.data?.error || e.message || 'Error';
        iziToast.error({ title: this.msg, position: 'topCenter', timeout: 3500 });
      }
    },
    async abStop() {
      this.msg = '';
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/bpm/ab/stop` });
        this.ab.stopping = true;
        this.msg = this.t('admin.bpmAnalysis.msgStopping');
      } catch(e) { this.msg = e?.response?.data?.error || e.message || 'Error'; }
    },
    async abResetFailed() {
      this.msg = '';
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/bpm/ab/reset-failed` });
        this.msg = this.t('admin.bpmAnalysis.msgResetErrors', { count: res.data.reset || 0 });
        this.loadStatus();
      } catch(e) { this.msg = e?.response?.data?.error || e.message || 'Error'; }
    },
    async abResetNotFound() {
      this.msg = '';
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/bpm/ab/reset-not-found` });
        this.msg = this.t('admin.bpmAnalysis.msgResetNotFound', { count: res.data.reset || 0 });
        this.loadStatus();
      } catch(e) { this.msg = e?.response?.data?.error || e.message || 'Error'; }
    },
    async essentiaStart() {
      this.msg = '';
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/bpm/essentia/start` });
        const status = res?.data?.status || '';
        if (status === 'pending') {
          this.essentia.running = false;
          this.essentia.stopping = false;
          const queuedMsg = this.t('admin.bpmAnalysis.msgQueuedScan', { feature: this.t('admin.bpmAnalysis.essentiaTitle') });
          this.msg = queuedMsg;
          iziToast.info({ title: queuedMsg, position: 'topCenter', timeout: 4500 });
          this.loadStatus();
          return;
        }
        this.essentia.running = true; this.essentia.stopping = false;
        this.msg = this.t('admin.bpmAnalysis.msgStarted');
        this.loadStatus();
      } catch(e) {
        this.msg = e?.response?.data?.error || e.message || 'Error';
        iziToast.error({ title: this.msg, position: 'topCenter', timeout: 3500 });
      }
    },
    async essentiaStop() {
      this.msg = '';
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/bpm/essentia/stop` });
        this.essentia.stopping = true;
        this.msg = this.t('admin.bpmAnalysis.msgStopping');
      } catch(e) { this.msg = e?.response?.data?.error || e.message || 'Error'; }
    },
    async essentiaResetFailed() {
      this.msg = '';
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/bpm/essentia/reset-failed` });
        this.msg = this.t('admin.bpmAnalysis.msgEssentiaResetErrors', { count: res.data.reset || 0 });
        this.loadStatus();
      } catch(e) { this.msg = e?.response?.data?.error || e.message || 'Error'; }
    },
    async resetAll() {
      if (!this.resetConfirm) { this.resetConfirm = true; return; }
      this.resetConfirm = false;
      this.msg = '';
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/bpm/reset-all` });
        this.msg = this.t('admin.bpmAnalysis.msgResetAll', { count: res.data.reset || 0 });
        this.loadStatus();
      } catch(e) { this.msg = e?.response?.data?.error || e.message || 'Error'; }
    },
    async genreCorrectDryRun() {
      this.genreCorrect.pending = true;
      this.genreCorrect.dryRunResult = null;
      this.genreCorrect.corrections = [];
      this.msg = '';
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/bpm/genre-correct?dryRun=true` });
        this.genreCorrect.dryRunResult = res.data;
        this.genreCorrect.corrections = (res.data.corrections || []).map(c => ({ ...c, _checked: true }));
      } catch(e) { this.msg = e?.response?.data?.error || e.message || 'Error'; }
      this.genreCorrect.pending = false;
    },
    async genreCorrectApplySelected() {
      const toApply = this.genreCorrect.corrections
        .filter(c => c._checked)
        .map(({ filepath, vpath, corrected, bpm }) => ({ filepath, vpath, corrected, bpm }));
      if (!toApply.length) { this.msg = 'No tracks selected'; return; }
      this.genreCorrect.pending = true;
      this.msg = '';
      try {
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/bpm/genre-correct-selected`,
          data: { corrections: toApply },
        });
        this.genreCorrect.dryRunResult = null;
        this.genreCorrect.corrections = [];
        this.msg = this.t('admin.bpmAnalysis.genreCorrectApplied', { count: res.data.applied || 0 });
        this.loadStatus();
      } catch(e) { this.msg = e?.response?.data?.error || e.message || 'Error'; }
      this.genreCorrect.pending = false;
    },
    genreCorrectToggleFamily(family, val) {
      for (const c of this.genreCorrect.corrections) {
        if (c.family === family) c._checked = val;
      }
    },
    genreCorrectToggleAll(val) {
      for (const c of this.genreCorrect.corrections) c._checked = val;
    },
    genreCorrectSelectedCount() {
      return this.genreCorrect.corrections.filter(c => c._checked).length;
    },
    genreCorrectFamilyRows(family) {
      return this.genreCorrect.corrections.filter(c => c.family === family);
    },
    async genreCorrectUndo() {
      if (!this.genreCorrect.undoConfirm) { this.genreCorrect.undoConfirm = true; return; }
      this.genreCorrect.undoConfirm = false;
      this.genreCorrect.pending = true;
      this.msg = '';
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/bpm/genre-correct-undo` });
        this.msg = this.t('admin.bpmAnalysis.genreCorrectUndone', { count: res.data.restored || 0 });
        this.loadStatus();
      } catch(e) { this.msg = e?.response?.data?.error || e.message || 'Error'; }
      this.genreCorrect.pending = false;
    },
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{ t('admin.bpmAnalysis.title') }}</span>
              <p style="margin-bottom:1rem;color:#aaa;font-size:.88rem;">{{ t('admin.bpmAnalysis.desc') }}</p>

              <!-- Library Coverage -->
              <div style="background:var(--raised2);border-radius:8px;padding:1rem;margin-bottom:1.25rem;">
                <b style="display:block;margin-bottom:.6rem;">{{ t('admin.bpmAnalysis.coverageTitle') }}</b>
                <div style="margin-bottom:.35rem;font-size:.88rem;">
                  <span style="color:#4caf50;">{{ t('admin.bpmAnalysis.coverageHasBpm') }}:</span>
                  <b style="margin:0 .4rem;">{{ (coverage.hasBpm||0).toLocaleString() }} / {{ (coverage.total||0).toLocaleString() }}</b>
                  <span style="color:#666;">({{ bpmPct }}%)</span>
                  <div style="background:rgba(255,255,255,.08);border-radius:3px;height:4px;margin-top:.3rem;">
                    <div :style="'background:#4caf50;height:4px;border-radius:3px;width:'+bpmPct+'%;transition:width .4s;'"></div>
                  </div>
                </div>
                <div style="margin-bottom:.6rem;font-size:.88rem;">
                  <span style="color:#7986cb;">{{ t('admin.bpmAnalysis.coverageHasKey') }}:</span>
                  <b style="margin:0 .4rem;">{{ (coverage.hasKey||0).toLocaleString() }} / {{ (coverage.total||0).toLocaleString() }}</b>
                  <span style="color:#666;">({{ keyPct }}%)</span>
                  <div style="background:rgba(255,255,255,.08);border-radius:3px;height:4px;margin-top:.3rem;">
                    <div :style="'background:#7986cb;height:4px;border-radius:3px;width:'+keyPct+'%;transition:width .4s;'"></div>
                  </div>
                </div>
                <div style="font-size:.82rem;color:#888;">
                  {{ t('admin.bpmAnalysis.coverageSource', { tags: (coverage.bySource.tag||0).toLocaleString(), ab: (coverage.bySource.acousticbrainz||0).toLocaleString(), essentia: (coverage.bySource.essentia||0).toLocaleString() }) }}
                </div>
              </div>

              <!-- Step 1: AcousticBrainz -->
              <div style="border:1px solid var(--border);border-radius:8px;padding:1rem;margin-bottom:1rem;">
                <b style="display:block;margin-bottom:.4rem;">{{ t('admin.bpmAnalysis.abTitle') }}</b>
                <p style="margin:.3rem 0 .7rem;font-size:.84rem;color:#aaa;">{{ t('admin.bpmAnalysis.abDesc') }}</p>

                <div v-if="ab.stats.total === 0" style="font-size:.84rem;color:#f59e0b;margin-bottom:.7rem;">
                  {{ t('admin.bpmAnalysis.abPrereqNoMbids') }}
                </div>
                <div v-else-if="ab.stats.queued === 0 && !ab.running" style="font-size:.84rem;color:#4ade80;margin-bottom:.7rem;">
                  {{ t('admin.bpmAnalysis.abPrereqAllDone', { total: (ab.stats.total||0).toLocaleString() }) }}
                </div>

                <!-- controls -->
                <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-bottom:.6rem;">
                  <button class="btn btn-small" @click="abStart" :disabled="ab.running || ab.stopping || ab.stats.total === 0">
                    {{ t('admin.bpmAnalysis.btnStart') }}
                  </button>
                  <button class="btn btn-small btn-flat" @click="abStop" :disabled="!ab.running || ab.stopping">
                    <span v-if="ab.stopping">{{ t('admin.bpmAnalysis.btnStopping') }}</span>
                    <span v-else>{{ t('admin.bpmAnalysis.btnStop') }}</span>
                  </button>
                  <span v-if="ab.running || ab.stopping" style="display:inline-flex;align-items:center;gap:.35rem;font-size:.85rem;color:#aaa;">
                    <span class="dot-spin"></span>{{ abStatusLabel }}
                  </span>
                  <button class="btn btn-small btn-flat" @click="abResetFailed" :disabled="ab.running || !ab.stats.errors" style="margin-left:auto;">
                    {{ t('admin.bpmAnalysis.btnResetErrors') }} ({{ ab.stats.errors || 0 }})
                  </button>
                  <button class="btn btn-small btn-flat" @click="abResetNotFound" :disabled="ab.running || !ab.stats.not_found" :title="t('admin.bpmAnalysis.btnResetNotFoundTitle')">
                    {{ t('admin.bpmAnalysis.btnResetNotFound') }} ({{ ab.stats.not_found || 0 }})
                  </button>
                </div>

                <!-- stats table -->
                <table style="font-size:.84rem;border-collapse:collapse;width:100%;margin-bottom:.5rem;">
                  <tr>
                    <td style="padding:2px 0;color:#aaa;min-width:160px;">{{ t('admin.bpmAnalysis.statsTotal') }}</td>
                    <td style="padding:2px 8px;text-align:right;font-variant-numeric:tabular-nums;"><b>{{ (ab.stats.total||0).toLocaleString() }}</b></td>
                  </tr>
                  <tr>
                    <td style="padding:2px 0;color:#4caf50;">{{ t('admin.bpmAnalysis.statsDone') }}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums;"><b>{{ (ab.stats.done||0).toLocaleString() }}</b></td>
                  </tr>
                  <tr>
                    <td style="padding:2px 0;color:#aaa;">{{ t('admin.bpmAnalysis.statsNotFound') }}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums;"><b>{{ (ab.stats.not_found||0).toLocaleString() }}</b></td>
                  </tr>
                  <tr v-if="ab.stats.errors">
                    <td style="padding:2px 0;color:#e57373;">{{ t('admin.bpmAnalysis.statsErrors') }}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums;"><b>{{ (ab.stats.errors||0).toLocaleString() }}</b></td>
                  </tr>
                  <tr>
                    <td style="padding:2px 0;color:#888;">{{ t('admin.bpmAnalysis.statsQueued') }}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums;"><b>{{ (ab.stats.queued||0).toLocaleString() }}</b></td>
                  </tr>
                </table>

                <div v-if="ab.running && ab.currentFile" style="font-size:.78rem;color:#777;word-break:break-all;font-family:monospace;">&#x25B6; {{ ab.currentFile }}</div>
              </div>

              <!-- Step 2: Essentia -->
              <div style="border:1px solid var(--border);border-radius:8px;padding:1rem;margin-bottom:1rem;">
                <b style="display:block;margin-bottom:.4rem;">{{ t('admin.bpmAnalysis.essentiaTitle') }}</b>
                <p style="margin:.3rem 0 .7rem;font-size:.84rem;color:#aaa;">{{ t('admin.bpmAnalysis.essentiaDesc') }}</p>

                <div v-if="essentia.stats.queued === 0 && !essentia.running" style="font-size:.84rem;color:#4ade80;margin-bottom:.7rem;">
                  {{ t('admin.bpmAnalysis.essentiaAllDone') }}
                </div>

                <!-- controls -->
                <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-bottom:.6rem;">
                  <button class="btn btn-small" @click="essentiaStart" :disabled="essentia.running || essentia.stopping">
                    {{ t('admin.bpmAnalysis.btnStart') }}
                  </button>
                  <button class="btn btn-small btn-flat" @click="essentiaStop" :disabled="!essentia.running || essentia.stopping">
                    <span v-if="essentia.stopping">{{ t('admin.bpmAnalysis.btnStopping') }}</span>
                    <span v-else>{{ t('admin.bpmAnalysis.btnStop') }}</span>
                  </button>
                  <span v-if="essentia.running || essentia.stopping" style="display:inline-flex;align-items:center;gap:.35rem;font-size:.85rem;color:#aaa;">
                    <span class="dot-spin"></span>{{ essentiaStatusLabel }}
                    <span v-if="essentia.processedCount" style="margin-left:.3rem;color:#666;">({{ essentia.processedCount.toLocaleString() }} analysed)</span>
                  </span>
                  <button class="btn btn-small btn-flat" @click="essentiaResetFailed" :disabled="essentia.running || !essentia.stats.errors" style="margin-left:auto;">
                    {{ t('admin.bpmAnalysis.essentiaResetSkipped') }} ({{ essentia.stats.errors || 0 }})
                  </button>
                </div>

                <!-- stats table -->
                <table style="font-size:.84rem;border-collapse:collapse;width:100%;margin-bottom:.5rem;">
                  <tr>
                    <td style="padding:2px 0;color:#aaa;min-width:160px;">{{ t('admin.bpmAnalysis.statsTotal') }}</td>
                    <td style="padding:2px 8px;text-align:right;font-variant-numeric:tabular-nums;"><b>{{ (essentia.stats.total||0).toLocaleString() }}</b></td>
                  </tr>
                  <tr>
                    <td style="padding:2px 0;color:#4caf50;">{{ t('admin.bpmAnalysis.statsDone') }}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums;"><b>{{ (essentia.stats.done||0).toLocaleString() }}</b></td>
                  </tr>
                  <tr v-if="essentia.stats.errors">
                    <td style="padding:2px 0;color:#f0a040;">{{ t('admin.bpmAnalysis.statsSkipped') }}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums;"><b>{{ (essentia.stats.errors||0).toLocaleString() }}</b></td>
                  </tr>
                  <tr>
                    <td style="padding:2px 0;color:#888;">{{ t('admin.bpmAnalysis.statsQueued') }}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums;"><b>{{ (essentia.stats.queued||0).toLocaleString() }}</b></td>
                  </tr>
                </table>

                <!-- Skipped explanation (only when there are skipped files) -->
                <div v-if="essentia.stats.errors" style="font-size:.8rem;color:#888;background:rgba(240,160,64,.08);border:1px solid rgba(240,160,64,.25);border-radius:6px;padding:.55rem .75rem;margin-top:.4rem;margin-bottom:.3rem;line-height:1.5;">
                  {{ t('admin.bpmAnalysis.skippedNote') }}
                </div>

                <div v-if="essentia.running && essentia.currentFile" style="font-size:.78rem;color:#777;word-break:break-all;font-family:monospace;">&#x25B6; {{ essentia.currentFile }}</div>
              </div>

              <!-- Step 3: Genre-Matrix BPM Correction -->
              <div style="border:1px solid var(--border);border-radius:8px;padding:1rem;margin-bottom:1rem;">
                <b style="display:block;margin-bottom:.4rem;">{{ t('admin.bpmAnalysis.genreCorrectTitle') }}</b>
                <p style="margin:.3rem 0 .7rem;font-size:.84rem;color:#aaa;">{{ t('admin.bpmAnalysis.genreCorrectDesc') }}</p>
                <div v-if="essentia.running" style="margin-bottom:.6rem;font-size:.82rem;color:#f59e0b;">⚠ Stop the Essentia worker first to use this tool.</div>
                <!-- Trigger row -->
                <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-bottom:.6rem;">
                  <button class="btn btn-small btn-flat" @click="genreCorrectDryRun" :disabled="essentia.running || genreCorrect.pending">
                    {{ t('admin.bpmAnalysis.genreCorrectDryRun') }}
                  </button>
                  <span v-if="genreCorrect.pending" style="display:inline-flex;align-items:center;gap:.35rem;font-size:.85rem;color:#aaa;">
                    <span class="dot-spin"></span>{{ t('admin.bpmAnalysis.genreCorrectRunning') }}
                  </span>
                </div>
                <!-- Per-song selection result -->
                <div v-if="genreCorrect.corrections.length">
                  <!-- Summary + global actions -->
                  <div style="background:var(--raised2);border-radius:6px;padding:.55rem .8rem;margin-bottom:.6rem;font-size:.83rem;">
                    <div style="display:flex;gap:1.2rem;flex-wrap:wrap;margin-bottom:.5rem;">
                      <span style="color:#4caf50;">{{ t('admin.bpmAnalysis.genreCorrectWillChange') }}: <b>{{ (genreCorrect.dryRunResult.changed||0).toLocaleString() }}</b></span>
                      <span style="color:#888;">{{ t('admin.bpmAnalysis.genreCorrectAlreadyOk') }}: <b>{{ (genreCorrect.dryRunResult.alreadyOk||0).toLocaleString() }}</b></span>
                      <span style="color:#888;">{{ t('admin.bpmAnalysis.genreCorrectNoGenre') }}: <b>{{ (genreCorrect.dryRunResult.noGenre||0).toLocaleString() }}</b></span>
                      <span style="color:#888;">{{ t('admin.bpmAnalysis.genreCorrectNoFamily') }}: <b>{{ (genreCorrect.dryRunResult.noFamily||0).toLocaleString() }}</b></span>
                    </div>
                    <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;">
                      <button class="btn btn-small" @click="genreCorrectApplySelected" :disabled="essentia.running || genreCorrect.pending || !genreCorrectSelectedCount()">
                        Apply selected ({{ genreCorrectSelectedCount() }})
                      </button>
                      <button class="btn btn-small btn-flat" @click="genreCorrectToggleAll(true)" :disabled="genreCorrect.pending">Select all</button>
                      <button class="btn btn-small btn-flat" @click="genreCorrectToggleAll(false)" :disabled="genreCorrect.pending">Deselect all</button>
                    </div>
                  </div>
                  <!-- Per-family groups -->
                  <div v-for="(fdata, fname) in genreCorrect.dryRunResult.byFamily" :key="fname"
                       v-if="genreCorrectFamilyRows(fname).length > 0"
                       style="margin-bottom:.75rem;">
                    <div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.25rem;">
                      <b style="font-size:.85rem;color:#e0e0e0;text-transform:uppercase;letter-spacing:.04em;">{{ fname }}</b>
                      <span style="font-size:.78rem;color:#888;">{{ genreCorrectFamilyRows(fname).length }} tracks &nbsp; {{ fdata.halved }}↓ {{ fdata.doubled }}↑</span>
                      <button class="btn btn-small btn-flat" @click="genreCorrectToggleFamily(fname, true)" style="padding:1px 6px;font-size:.74rem;">✓ all</button>
                      <button class="btn btn-small btn-flat" @click="genreCorrectToggleFamily(fname, false)" style="padding:1px 6px;font-size:.74rem;">✗ none</button>
                    </div>
                    <div style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:4px;">
                      <table style="width:100%;border-collapse:collapse;font-size:.78rem;">
                        <thead style="position:sticky;top:0;background:var(--raised2);z-index:1;">
                          <tr style="color:#888;">
                            <th style="padding:3px 4px;width:24px;"></th>
                            <th style="text-align:left;padding:3px 6px;font-weight:normal;">Artist</th>
                            <th style="text-align:left;padding:3px 6px;font-weight:normal;">Title</th>
                            <th style="text-align:left;padding:3px 6px;font-weight:normal;">Genre tag</th>
                            <th style="text-align:right;padding:3px 6px;font-weight:normal;">Was</th>
                            <th style="text-align:right;padding:3px 6px;font-weight:normal;">New</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr v-for="ex in genreCorrectFamilyRows(fname)" :key="ex.filepath"
                              :style="'border-top:1px solid var(--border);' + (ex._checked ? '' : 'opacity:.4;')">
                            <td style="padding:3px 4px;text-align:center;">
                              <input type="checkbox" v-model="ex._checked" style="cursor:pointer;">
                            </td>
                            <td style="padding:3px 6px;color:#aaa;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{{ ex.artist }}</td>
                            <td style="padding:3px 6px;color:#ccc;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{{ ex.title }}</td>
                            <td style="padding:3px 6px;color:#888;font-style:italic;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{{ ex.genre }}</td>
                            <td style="padding:3px 6px;text-align:right;color:#e57373;">{{ ex.bpm }}</td>
                            <td style="padding:3px 6px;text-align:right;color:#4caf50;font-weight:600;">{{ ex.corrected }}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
                <!-- Undo -->
                <div style="margin-top:.6rem;">
                  <button v-if="!genreCorrect.undoConfirm" class="btn btn-small btn-flat" @click="genreCorrectUndo" :disabled="essentia.running || genreCorrect.pending" style="color:#f59e0b;">
                    {{ t('admin.bpmAnalysis.genreCorrectUndoBtn') }}
                  </button>
                  <span v-if="genreCorrect.undoConfirm" style="display:inline-flex;align-items:center;gap:.5rem;flex-wrap:wrap;">
                    <span style="font-size:.85rem;color:#fbbf24;">{{ t('admin.bpmAnalysis.genreCorrectUndoConfirm') }}</span>
                    <button class="btn btn-small" @click="genreCorrectUndo" style="background:#f59e0b;">{{ t('admin.bpmAnalysis.genreCorrectUndoBtn') }}</button>
                    <button class="btn btn-small btn-flat" @click="genreCorrect.undoConfirm=false">Cancel</button>
                  </span>
                </div>
              </div>

              <!-- Reset All -->
              <div style="margin-top:.75rem;padding-top:.75rem;border-top:1px solid var(--border);">
                <button v-if="!resetConfirm" class="btn btn-small btn-flat" @click="resetAll" :disabled="ab.running || essentia.running" style="color:#e57373;">
                  {{ t('admin.bpmAnalysis.resetAllBtn') }}
                </button>
                <span v-if="resetConfirm" style="display:inline-flex;align-items:center;gap:.5rem;flex-wrap:wrap;">
                  <span style="font-size:.85rem;color:#fbbf24;">{{ t('admin.bpmAnalysis.resetAllConfirm') }}</span>
                  <button class="btn btn-small" @click="resetAll" style="background:#e57373;">{{ t('admin.bpmAnalysis.resetAllBtn') }}</button>
                  <button class="btn btn-small btn-flat" @click="resetConfirm=false">Cancel</button>
                </span>
              </div>

              <div v-if="msg" style="margin-top:.6rem;font-size:.83rem;color:#aaa;">{{ msg }}</div>

            </div>
          </div>
        </div>
      </div>
    </div>
  `,
});

// Module-level reactive batch state — survives component unmount so progress
// remains visible when the user navigates away and returns mid-batch.
const _tagBatchState = Vue.observable({
  running: false,
  albumDone: 0, albumTotal: 0,
  trackDone: 0, trackTotal: 0,
  currentAlbum: '',
});

const tagWorkshopView = Vue.component('tagworkshop-view', {
  data() {
    return {
      // status overview
      mb: { total: 0, done: 0, errors: 0, no_data: 0, queued: 0, acoustid_attempted: 0, acoustid_found: 0 },
      tags: { needs_review: 0, confirmed: 0, accepted: 0, skipped: 0 },
      coverage: { library_total: 0, ac_not_found: 0 },
      enrich: { running: false, stopping: false },
      textSearch: { queued: 0, found: 0, not_found: 0, skipped: 0, errors: 0, running: false, stopping: false },
      // album list
      albums: [], total: 0, page: 1, pageSize: 40,
      filter: 'all', sort: 'broken',
      search: '', searchDebounce: null,
      pageJump: '',
      // shelved tab
      tab: 'review',  // 'review' | 'shelved'
      shelvedAlbums: [], shelvedTotal: 0, shelvedPage: 1,
      // multi-select + batch accept
      selectedAlbums: [],
      _lastFilter: '', _lastSort: '',
      // album detail modal
      showDetail: false,
      detailTracks: [],
      detailEdits: {},
      detailReleaseId: '',
      detailAlbumDir: '',
      detailLabel: '',
      acceptErrors: [],
      acceptWriteDone: 0,
      acceptWriteTotal: 0,
      pending: false,
      bulkCasingConfirm: false,
      showEnrichErrors: false,
      enrichErrors: [],
      showTsErrors: false,
      tsErrors: [],
      msg: ''
    };
  },
  computed: {
    batchRunning()      { return _tagBatchState.running; },
    batchAlbumDone()    { return _tagBatchState.albumDone; },
    batchAlbumTotal()   { return _tagBatchState.albumTotal; },
    batchTrackDone()    { return _tagBatchState.trackDone; },
    batchTrackTotal()   { return _tagBatchState.trackTotal; },
    batchCurrentAlbum() { return _tagBatchState.currentAlbum; },
    totalPages() { return Math.ceil(this.total / (this.pageSize || 20)); },
    shelvedTotalPages() { return Math.ceil(this.shelvedTotal / (this.pageSize || 20)); },
    enrichProgress() {
      if (!this.mb.total) return 0;
      return Math.round(((this.mb.done + this.mb.errors + this.mb.no_data) / this.mb.total) * 100);
    },
    allOnPageSelected() {
      return this.albums.length > 0 && this.albums.every(a => this.isSelected(a));
    },
    covTotal()          { return this.coverage.library_total || 0; },
    covAcFound()        { return this.mb.acoustid_found || 0; },
    covTsFound()        { return this.textSearch.found || 0; },
    covIdentified()     { return this.mb.total || 0; },
    covUnidentified()   { return Math.max(0, this.covTotal - this.covIdentified); },
    covPctAc()          { return this.covTotal ? ((this.covAcFound / this.covTotal) * 100).toFixed(1) : '0.0'; },
    covPctTs()          { return this.covTotal ? ((this.covTsFound / this.covTotal) * 100).toFixed(1) : '0.0'; },
    covPctUnident()     { return this.covTotal ? ((this.covUnidentified / this.covTotal) * 100).toFixed(1) : '0.0'; },
    covBarAc()          { return this.covTotal ? (this.covAcFound / this.covTotal * 100).toFixed(2) : 0; },
    covBarTs()          { return this.covTotal ? (this.covTsFound / this.covTotal * 100).toFixed(2) : 0; },
  },
  mounted() {
    this.loadStatus(); this.loadAlbums(); this.loadShelved();
    // If a batch was running when the user navigated away, watch for it to
    // complete so we can reload the album list automatically.
    if (_tagBatchState.running) {
      this._batchWatcher = this.$watch(() => _tagBatchState.running, val => {
        if (!val) { this.loadStatus(); this.loadAlbums(); this._batchWatcher?.(); this._batchWatcher = null; }
      });
    }
  },
  beforeUnmount() {
    if (this._statusTimer) { clearTimeout(this._statusTimer); this._statusTimer = null; }
    if (this._batchWatcher) { this._batchWatcher(); this._batchWatcher = null; }
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
      <div class="card">
        <div class="card-content">
        <span class="card-title">{{ t('admin.tagworkshop.title') }}</span>
        <p style="margin-bottom:0.5rem; color:#aaa; font-size:0.88rem;">{{ t('admin.tagworkshop.desc') }}</p>
        <div style="background:rgba(255,255,255,0.04); border-left:3px solid var(--primary); border-radius:0 4px 4px 0; padding:0.5rem 0.75rem; margin-bottom:1rem; font-size:0.82rem; color:#bbb; line-height:1.7;">
          <div>ℹ {{ t('admin.tagworkshop.infoWriteFiles') }}</div>
          <div>ℹ {{ t('admin.tagworkshop.infoNoRecentlyAdded') }}</div>
        </div>

        <!-- Library coverage summary -->
        <div v-if="covTotal > 0" style="background:var(--raised2); border-radius:8px; padding:0.9rem 1rem; margin-bottom:1.25rem;">
          <b style="display:block; margin-bottom:0.65rem; font-size:0.92rem;">{{ t('admin.tagworkshop.coverageTitle') }}</b>
          <!-- stacked bar -->
          <div style="background:var(--raised3); border-radius:4px; height:10px; margin-bottom:0.75rem; overflow:hidden; display:flex;">
            <div :style="{ width: covBarAc + '%', background: '#4caf50', transition: 'width .4s' }" :title="t('admin.tagworkshop.coverageAcoustid') + ': ' + covPctAc + '%'"></div>
            <div :style="{ width: covBarTs + '%', background: '#42a5f5', transition: 'width .4s' }" :title="t('admin.tagworkshop.coverageTextSearch') + ': ' + covPctTs + '%'"></div>
          </div>
          <!-- legend table -->
          <table style="font-size:0.82rem; border-collapse:collapse; width:100%;">
            <tr>
              <td style="padding:2px 8px 2px 0; color:#aaa; white-space:nowrap;">{{ t('admin.tagworkshop.coverageLibrary') }}</td>
              <td style="padding:2px 8px; text-align:right; font-variant-numeric:tabular-nums;"><b>{{ covTotal.toLocaleString() }}</b></td>
              <td></td>
            </tr>
            <tr>
              <td style="padding:2px 8px 2px 0; color:#4caf50; white-space:nowrap;">
                <span style="display:inline-block; width:10px; height:10px; background:#4caf50; border-radius:2px; margin-right:5px; vertical-align:middle;"></span>
                {{ t('admin.tagworkshop.coverageAcoustid') }}
              </td>
              <td style="padding:2px 8px; text-align:right; font-variant-numeric:tabular-nums; color:#4caf50;"><b>{{ covAcFound.toLocaleString() }}</b></td>
              <td style="padding:2px 0; color:#666; font-size:0.78rem;">{{ covPctAc }}%</td>
            </tr>
            <tr>
              <td style="padding:2px 8px 2px 0; color:#42a5f5; white-space:nowrap;">
                <span style="display:inline-block; width:10px; height:10px; background:#42a5f5; border-radius:2px; margin-right:5px; vertical-align:middle;"></span>
                {{ t('admin.tagworkshop.coverageTextSearch') }}
              </td>
              <td style="padding:2px 8px; text-align:right; font-variant-numeric:tabular-nums; color:#42a5f5;"><b>{{ covTsFound.toLocaleString() }}</b></td>
              <td style="padding:2px 0; color:#666; font-size:0.78rem;">{{ covPctTs }}%</td>
            </tr>
            <tr>
              <td style="padding:2px 8px 2px 0; color:#666; white-space:nowrap;">
                <span style="display:inline-block; width:10px; height:10px; background:var(--raised3); border:1px solid #444; border-radius:2px; margin-right:5px; vertical-align:middle;"></span>
                {{ t('admin.tagworkshop.coverageUnidentified') }}
              </td>
              <td style="padding:2px 8px; text-align:right; font-variant-numeric:tabular-nums; color:#666;"><b>{{ covUnidentified.toLocaleString() }}</b></td>
              <td style="padding:2px 0; color:#555; font-size:0.78rem;">{{ covPctUnident }}%</td>
            </tr>
          </table>
          <div v-if="covUnidentified > 0" style="margin-top:0.55rem; font-size:0.78rem; color:#555; font-style:italic;">
            {{ t('admin.tagworkshop.coverageUnidentifiedHint') }}
          </div>
          <!-- review queue summary -->
          <div v-if="tags.needs_review > 0 || tags.confirmed > 0 || tags.accepted > 0" style="margin-top:0.75rem; padding-top:0.6rem; border-top:1px solid var(--border); font-size:0.82rem; color:#aaa; display:flex; gap:1.25rem; flex-wrap:wrap;">
            <span>{{ t('admin.tagworkshop.coverageQueue') }}:</span>
            <span style="color:#ff9800;">{{ t('admin.tagworkshop.statsNeedsReview') }}: <b>{{ tags.needs_review.toLocaleString() }}</b></span>
            <span style="color:#4caf50;">{{ t('admin.tagworkshop.statsMbDone') }}: <b>{{ tags.confirmed.toLocaleString() }}</b></span>
            <span v-if="tags.accepted > 0" style="color:#7986cb;">{{ t('admin.tagworkshop.statsAccepted') }}: <b>{{ tags.accepted.toLocaleString() }}</b></span>
            <span v-if="tags.skipped > 0" style="color:#888;">{{ t('admin.tagworkshop.statsSkipped') }}: <b>{{ tags.skipped.toLocaleString() }}</b></span>
          </div>
        </div>

        <!-- Step 1: MB Enrichment section -->
        <div style="background:var(--raised2); border-radius:8px; padding:1rem; margin-bottom:1.25rem;">
          <b style="display:block; margin-bottom:0.25rem;">{{ t('admin.tagworkshop.enrichTitle') }}</b>
          <p style="color:#aaa; font-size:0.82rem; margin:0 0 0.75rem 0;">{{ t('admin.tagworkshop.enrichHint') }}</p>

          <!-- Prereq: AcoustID never ran -->
          <div v-if="mb.acoustid_attempted === 0" style="background:rgba(255,152,0,0.1); border:1px solid rgba(255,152,0,0.35); border-radius:6px; padding:0.65rem 0.9rem; margin-bottom:0.85rem; font-size:0.83rem; color:#ffb74d; line-height:1.6;">
            ⚠ {{ t('admin.tagworkshop.prereqNoAcoustid') }}
            <span style="display:block; margin-top:0.2rem; font-size:0.78rem; color:#e6a020;">{{ t('admin.tagworkshop.prereqNoAcoustidHint') }}</span>
          </div>
          <!-- Prereq: AcoustID ran but zero matches -->
          <div v-else-if="mb.acoustid_found === 0" style="background:rgba(229,115,115,0.08); border:1px solid rgba(229,115,115,0.3); border-radius:6px; padding:0.65rem 0.9rem; margin-bottom:0.85rem; font-size:0.83rem; color:#ef9a9a; line-height:1.6;">
            ⚠ {{ t('admin.tagworkshop.prereqNoMatches', { attempted: mb.acoustid_attempted.toLocaleString() }) }}
          </div>
          <!-- All already enriched — nothing queued -->
          <div v-else-if="mb.queued === 0 && mb.total > 0 && !enrich.running" style="background:rgba(76,175,80,0.08); border:1px solid rgba(76,175,80,0.25); border-radius:6px; padding:0.65rem 0.9rem; margin-bottom:0.85rem; font-size:0.83rem; color:#81c784; line-height:1.5;">
            ✓ {{ t('admin.tagworkshop.prereqAllDone', { total: mb.total.toLocaleString() }) }}
          </div>

          <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; margin-bottom:0.75rem;">
            <button class="btn" style="min-width:140px;" :disabled="enrich.running || enrich.stopping || mb.queued === 0" @click="startEnrich">{{ t('admin.tagworkshop.btnStartEnrich') }}</button>
            <button class="btn btn-secondary" :disabled="!enrich.running || enrich.stopping" @click="stopEnrich">{{ enrich.stopping ? t('admin.tagworkshop.btnStopping') : t('admin.tagworkshop.btnStopEnrich') }}</button>
            <span v-if="enrich.running" style="color:#4caf50; font-size:0.85rem;">● {{ t('admin.tagworkshop.enrichRunning') }}</span>
            <span v-else-if="enrich.stopping" style="color:#ff9800; font-size:0.85rem;">● {{ t('admin.tagworkshop.enrichStopping') }}</span>
            <span v-else style="color:#888; font-size:0.85rem;">{{ t('admin.tagworkshop.enrichIdle') }}</span>
          </div>
          <div v-if="mb.total > 0">
            <div style="background:var(--raised3); border-radius:4px; height:6px; margin-bottom:0.4rem; overflow:hidden;">
              <div :style="{width: enrichProgress + '%', background:'#4caf50', height:'100%', transition:'width .3s'}"></div>
            </div>
            <div style="display:flex; gap:1.5rem; font-size:0.82rem; flex-wrap:wrap; align-items:center;">
              <span>{{ t('admin.tagworkshop.statsMbTotal') }}: <b>{{ mb.total.toLocaleString() }}</b></span>
              <span style="color:#4caf50;">{{ t('admin.tagworkshop.statsMbDone') }}: <b>{{ mb.done.toLocaleString() }}</b></span>
              <span style="color:#888;">{{ t('admin.tagworkshop.statsMbNoData') }}: <b>{{ mb.no_data.toLocaleString() }}</b></span>
              <span style="color:#e57373;">
                {{ t('admin.tagworkshop.statsMbErrors') }}: <b>{{ mb.errors.toLocaleString() }}</b>
                <button v-if="mb.errors > 0" class="btn-flat btn-small" style="margin-left:0.35rem; font-size:0.75rem; color:#e57373; padding:1px 7px;" @click="toggleEnrichErrors">{{ showEnrichErrors ? '▲' : '▼' }}</button>
              </span>
              <span style="color:#aaa;">{{ t('admin.tagworkshop.statsMbQueued') }}: <b>{{ mb.queued.toLocaleString() }}</b></span>
            </div>
            <!-- Error file list -->
            <div v-if="showEnrichErrors && enrichErrors.length > 0" style="margin-top:0.65rem; max-height:220px; overflow-y:auto; background:var(--raised3); border-radius:5px; border:1px solid rgba(229,115,115,0.25); padding:0.5rem 0.75rem;">
              <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.5rem;">
                <div style="font-size:0.75rem; color:#e57373; font-weight:600;">{{ t('admin.tagworkshop.enrichErrorsTitle') }} ({{ enrichErrors.length }})</div>
                <button class="btn-flat btn-small" style="font-size:0.75rem; color:#e57373; border-color:rgba(229,115,115,0.4);" @click="retryEnrichErrors" :title="t('admin.tagworkshop.enrichRetryHint')">{{ t('admin.tagworkshop.enrichRetry') }}</button>
              </div>
              <div v-for="row in enrichErrors" :key="row.filepath" style="font-size:0.75rem; padding:0.2rem 0; border-bottom:1px solid rgba(255,255,255,0.04);">
                <div style="color:#bbb; word-break:break-all;">{{ row.filepath }}</div>
                <div style="color:#e57373; margin-top:1px;">{{ enrichErrorMsg(row.mb_enrichment_error) }}</div>
              </div>
            </div>
          </div>
          <p v-else style="color:#666; font-size:0.81rem; margin:0.5rem 0 0 0; line-height:1.5;">{{ t('admin.tagworkshop.enrichExplainLong') }}</p>
        </div>

        <!-- Step 1b: MB Text Search (Fallback) section -->
        <div style="background:var(--raised2); border-radius:8px; padding:1rem; margin-bottom:1.25rem;">
          <b style="display:block; margin-bottom:0.25rem;">{{ t('admin.tagworkshop.tsTitle') }}</b>
          <p style="color:#aaa; font-size:0.82rem; margin:0 0 0.75rem 0;">{{ t('admin.tagworkshop.tsHint') }}</p>

          <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; margin-bottom:0.75rem;">
            <button class="btn" style="min-width:140px;" :disabled="textSearch.running || textSearch.stopping || textSearch.queued === 0" @click="startTextSearch">{{ t('admin.tagworkshop.btnStartTs') }}</button>
            <button class="btn btn-secondary" :disabled="!textSearch.running || textSearch.stopping" @click="stopTextSearch">{{ textSearch.stopping ? t('admin.tagworkshop.btnStopping') : t('admin.tagworkshop.btnStopTs') }}</button>
            <span v-if="textSearch.running" style="color:#4caf50; font-size:0.85rem;">● {{ t('admin.tagworkshop.tsRunning') }}</span>
            <span v-else-if="textSearch.stopping" style="color:#ff9800; font-size:0.85rem;">● {{ t('admin.tagworkshop.enrichStopping') }}</span>
            <span v-else style="color:#888; font-size:0.85rem;">{{ t('admin.tagworkshop.enrichIdle') }}</span>
          </div>

          <div style="display:flex; gap:1.5rem; font-size:0.82rem; flex-wrap:wrap; align-items:center;">
            <span style="color:#aaa;">{{ t('admin.tagworkshop.tsStat_queued') }}: <b>{{ textSearch.queued.toLocaleString() }}</b></span>
            <span style="color:#4caf50;">{{ t('admin.tagworkshop.tsStat_found') }}: <b>{{ textSearch.found.toLocaleString() }}</b></span>
            <span style="color:#888;">{{ t('admin.tagworkshop.tsStat_notFound') }}: <b>{{ textSearch.not_found.toLocaleString() }}</b>
              <button v-if="textSearch.not_found > 0" class="btn-flat btn-small" style="margin-left:0.35rem; font-size:0.75rem; color:#888; padding:1px 7px;" @click="retryTextSearchNotFound" :title="t('admin.tagworkshop.tsRetryHint')">↺</button>
            </span>
            <span style="color:#aaa;">{{ t('admin.tagworkshop.tsStat_skipped') }}: <b>{{ textSearch.skipped.toLocaleString() }}</b></span>
            <span style="color:#e57373;">{{ t('admin.tagworkshop.tsStat_errors') }}: <b>{{ textSearch.errors.toLocaleString() }}</b>
              <button v-if="textSearch.errors > 0" class="btn-flat btn-small" style="margin-left:0.35rem; font-size:0.75rem; color:#e57373; padding:1px 7px;" @click="toggleTsErrors">{{ showTsErrors ? '\u25b2' : '\u25bc' }}</button>
            </span>
          </div>
          <!-- Text search error file list -->
          <div v-if="showTsErrors && tsErrors.length > 0" style="margin-top:0.65rem; max-height:220px; overflow-y:auto; background:var(--raised3); border-radius:5px; border:1px solid rgba(229,115,115,0.25); padding:0.5rem 0.75rem;">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.5rem;">
              <div style="font-size:0.75rem; color:#e57373; font-weight:600;">{{ t('admin.tagworkshop.enrichErrorsTitle') }} ({{ tsErrors.length }})</div>
              <button class="btn-flat btn-small" style="font-size:0.75rem; color:#e57373; border-color:rgba(229,115,115,0.4);" @click="retryTsErrors" :title="t('admin.tagworkshop.enrichRetryHint')">{{ t('admin.tagworkshop.enrichRetry') }}</button>
            </div>
            <div v-for="f in tsErrors" :key="f.filepath" style="font-size:0.75rem; padding:0.2rem 0; border-bottom:1px solid rgba(255,255,255,0.04);">
              <div style="color:#bbb; word-break:break-all;">{{ f.filepath }}</div>
              <div style="color:#e57373; margin-top:1px;">{{ enrichErrorMsg(f.mb_text_search_error) }}</div>
            </div>
          </div>
        </div>

        <!-- Step 2: Tab bar -->
        <div v-if="tags.needs_review > 0 || tags.accepted > 0 || tags.skipped > 0">
          <div style="display:flex; border-bottom:2px solid var(--border); margin-bottom:1rem; gap:0;">
            <button @click="tab='review'" class="btn-flat" :style="{borderBottom: tab==='review' ? '2px solid var(--primary)' : 'none', marginBottom:'-2px', fontWeight: tab==='review' ? '600':'normal', paddingBottom:'6px'}">
              {{ t('admin.tagworkshop.reviewTitle') }}
              <span v-if="tags.needs_review > 0" style="margin-left:5px; background:#ff9800; color:#000; border-radius:10px; padding:1px 7px; font-size:0.75rem;">{{ tags.needs_review }}</span>
            </button>
            <button @click="tab='shelved'; loadShelved()" class="btn-flat" :style="{borderBottom: tab==='shelved' ? '2px solid var(--primary)' : 'none', marginBottom:'-2px', fontWeight: tab==='shelved' ? '600':'normal', paddingBottom:'6px'}">
              {{ t('admin.tagworkshop.shelvedTitle') }}
              <span v-if="tags.skipped > 0" style="margin-left:5px; background:var(--raised3); color:#aaa; border-radius:10px; padding:1px 7px; font-size:0.75rem;">{{ tags.skipped }}</span>
            </button>
          </div>

          <!-- REVIEW tab -->
          <div v-if="tab==='review'">
            <p style="color:#aaa; font-size:0.82rem; margin:0 0 0.75rem 0; line-height:1.5;">{{ t('admin.tagworkshop.reviewExplain') }}</p>
            <div style="display:flex; gap:1.5rem; font-size:0.85rem; flex-wrap:wrap; margin-bottom:0.9rem;">
              <span style="color:#ff9800;">{{ t('admin.tagworkshop.statsNeedsReview') }}: <b>{{ tags.needs_review.toLocaleString() }}</b></span>
              <span style="color:#aaa;">{{ t('admin.tagworkshop.statsConfirmed') }}: <b>{{ tags.confirmed.toLocaleString() }}</b></span>
              <span style="color:#4caf50;">{{ t('admin.tagworkshop.statsAccepted') }}: <b>{{ tags.accepted.toLocaleString() }}</b></span>
            </div>

            <!-- Search box -->
            <div style="margin-bottom:0.75rem;">
              <input v-model="search" @input="onSearchInput" type="text" style="width:100%; box-sizing:border-box; padding:0.45rem 0.65rem; border-radius:6px; border:1px solid var(--border); background:var(--raised2); color:var(--t1); font-size:0.88rem;" :placeholder="t('admin.tagworkshop.searchPlaceholder')">
            </div>

            <!-- Filters + bulk actions -->
            <div style="display:flex; flex-direction:column; gap:0.35rem; margin-bottom:0.75rem;">
              <!-- Row 1: Filter -->
              <div style="display:flex; gap:0.4rem; flex-wrap:wrap; align-items:center;">
                <span style="font-size:0.75rem; color:#666; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; white-space:nowrap; min-width:44px;">{{ t('admin.tagworkshop.labelFilter') }}</span>
                <button class="btn-flat btn-small" :class="{select: filter==='all'}"   :title="t('admin.tagworkshop.filterHint_all')"    @click="filter='all';    page=1; loadAlbums()">{{ t('admin.tagworkshop.filter_all') }}</button>
                <button class="btn-flat btn-small" :class="{select: filter==='missing'}" :title="t('admin.tagworkshop.filterHint_missing')" @click="filter='missing'; page=1; loadAlbums()">{{ t('admin.tagworkshop.filter_missing') }}</button>
                <button class="btn-flat btn-small" :class="{select: filter==='year'}"  :title="t('admin.tagworkshop.filterHint_year')"   @click="filter='year';   page=1; loadAlbums()">{{ t('admin.tagworkshop.filter_year') }}</button>
                <button class="btn-flat btn-small" :class="{select: filter==='artist'}" :title="t('admin.tagworkshop.filterHint_artist')" @click="filter='artist'; page=1; loadAlbums()">{{ t('admin.tagworkshop.filter_artist') }}</button>
                <button class="btn-flat btn-small" :class="{select: filter==='junk'}"   :title="t('admin.tagworkshop.filterHint_junk')"   @click="filter='junk';   page=1; loadAlbums()">{{ t('admin.tagworkshop.filter_junk') }}</button>
              </div>
              <!-- Row 2: Sort + bulk actions -->
              <div style="display:flex; gap:0.4rem; flex-wrap:wrap; align-items:center;">
                <span style="font-size:0.75rem; color:#666; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; white-space:nowrap; min-width:44px;">{{ t('admin.tagworkshop.labelSort') }}</span>
                <button class="btn-flat btn-small" :class="{select: sort==='broken'}" :title="t('admin.tagworkshop.sortHint_broken')" @click="sort='broken'; page=1; loadAlbums()">{{ t('admin.tagworkshop.sort_broken') }}</button>
                <button class="btn-flat btn-small" :class="{select: sort==='tracks'}" :title="t('admin.tagworkshop.sortHint_tracks')" @click="sort='tracks'; page=1; loadAlbums()">{{ t('admin.tagworkshop.sort_tracks') }}</button>
                <button class="btn-flat btn-small" :class="{select: sort==='alpha'}"  :title="t('admin.tagworkshop.sortHint_alpha')"  @click="sort='alpha';  page=1; loadAlbums()">{{ t('admin.tagworkshop.sort_alpha') }}</button>
                <span style="margin:0 0.3rem; color:#555;">|</span>
                <button class="btn-flat btn-small" :disabled="pending"
                  :title="bulkCasingConfirm ? t('admin.tagworkshop.btnBulkCasingConfirmHint') : t('admin.tagworkshop.btnBulkCasingHint')"
                  :style="bulkCasingConfirm ? 'color:#e53935; font-weight:600;' : ''"
                  @click="bulkCasingConfirm ? bulkAcceptCasing() : (bulkCasingConfirm=true)"
                  @blur="bulkCasingConfirm=false">
                  {{ bulkCasingConfirm ? t('admin.tagworkshop.btnBulkCasingConfirm') : t('admin.tagworkshop.btnBulkCasing') }}
                </button>
              </div>
            </div>

            <!-- Batch selection bar (always visible to prevent layout shift) -->
            <div style="padding:0.5rem 0.75rem; background:rgba(76,175,80,0.06); border:1px solid rgba(76,175,80,0.18); border-radius:6px; margin-bottom:0.75rem;">
              <div style="display:flex; align-items:center; gap:0.75rem; flex-wrap:wrap; margin-bottom:0.35rem;">
                <span v-if="!batchRunning" style="font-size:0.85rem; font-weight:600;" :style="selectedAlbums.length > 0 ? 'color:#4caf50;' : 'color:#666;'">{{ t('admin.tagworkshop.selectedCount', { count: selectedAlbums.length }) }}</span>
                <span v-else style="font-size:0.85rem; color:#4caf50; font-weight:600;">{{ t('admin.tagworkshop.batchProgressAlbum', { done: batchAlbumDone, total: batchAlbumTotal }) }}</span>
                <button class="btn btn-small" :disabled="pending || batchRunning || selectedAlbums.length === 0" @click="batchAcceptSelected" style="min-width:155px;">{{ t('admin.tagworkshop.btnAcceptSelected') }}</button>
                <!-- Select all + Deselect all grouped together on the right -->
                <div style="display:flex; align-items:center; gap:0.4rem; margin-left:auto; flex-shrink:0;">
                  <label style="display:flex; align-items:center; gap:0.3rem; font-size:0.82rem; cursor:pointer; color:var(--t2); white-space:nowrap; user-select:none;" :title="t('admin.tagworkshop.selectAllHint')">
                    <input type="checkbox" :checked="allOnPageSelected" @change="allOnPageSelected ? deselectAll() : selectAll()" :disabled="pending || batchRunning" style="cursor:pointer; width:15px; height:15px; accent-color:var(--primary);">
                    {{ t('admin.tagworkshop.selectAll') }}
                  </label>
                  <button class="btn-flat btn-small" :disabled="pending || batchRunning || selectedAlbums.length === 0" @click="deselectAll">{{ t('admin.tagworkshop.deselectAll') }}</button>
                </div>
              </div>
              <div v-if="batchRunning">
                <!-- Track progress bar -->
                <div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.2rem;">
                  <div style="flex:1; background:var(--border); border-radius:4px; height:5px; overflow:hidden;">
                    <div :style="{ width: (batchTrackTotal ? (batchTrackDone/batchTrackTotal*100) : 0)+'%', background:'#4caf50', height:'100%', transition:'width 0.15s' }"></div>
                  </div>
                  <span style="font-size:0.78rem; color:#aaa; white-space:nowrap;">{{ batchTrackDone }} / {{ batchTrackTotal }} {{ t('admin.tagworkshop.tracksSuffix') }}</span>
                </div>
                <div v-if="batchCurrentAlbum" style="font-size:0.75rem; color:#888; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{{ batchCurrentAlbum }}</div>
              </div>
            </div>

            <!-- Album cards -->
            <div v-if="albums.length === 0" style="color:#888; font-size:0.88rem; padding:1rem 0;">{{ t('admin.tagworkshop.noAlbums') }}</div>
            <div v-else>
              <div v-for="alb in albums" :key="alb.mb_release_id + '|' + (alb.mb_album_dir || '')"
                style="display:flex; align-items:center; gap:0.75rem; padding:0.65rem 0; border-bottom:1px solid var(--border);">
                <input type="checkbox" :checked="isSelected(alb)" @change="toggleSelect(alb)" :disabled="batchRunning" style="cursor:pointer; flex-shrink:0; width:16px; height:16px; accent-color:var(--primary);" :title="t('admin.tagworkshop.selectHint')">
                <img v-if="alb.album_art" :src="'/album-art/' + alb.album_art" style="width:48px; height:48px; border-radius:4px; object-fit:cover; flex-shrink:0;" alt="">
                <div v-else style="width:48px; height:48px; border-radius:4px; background:var(--raised3); flex-shrink:0;"></div>
                <div style="flex:1; min-width:0;">
                  <div style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{{ alb.mb_album }}</div>
                  <div style="font-size:0.82rem; color:#aaa;">{{ alb.mb_artist }}<span v-if="alb.mb_year"> · {{ alb.mb_year }}</span></div>
                  <div style="font-size:0.78rem; margin-top:3px;">
                    <span v-if="alb.tracks_needing_fix" style="color:#ff9800;">
                      ⚠ {{ alb.tracks_needing_fix }}/{{ alb.track_count }} {{ t('admin.tagworkshop.tracksNeedFix') }}
                    </span>
                    <span v-else style="color:#4caf50;">✓ {{ t('admin.tagworkshop.allTracksMatch') }}</span>
                    <span v-if="alb.has_text_search > 0" style="margin-left:6px; background:rgba(33,150,243,0.15); color:#64b5f6; border:1px solid rgba(33,150,243,0.35); border-radius:10px; padding:1px 7px; font-size:0.72rem;" :title="t('admin.tagworkshop.badgeTextMatchHint')">🔍 {{ t('admin.tagworkshop.badgeTextMatch') }}</span>
                  </div>
                </div>
                <div style="display:flex; flex-direction:column; gap:0.3rem; flex-shrink:0; align-items:flex-end;">
                  <button class="btn btn-small" :disabled="pending" @click="openDetail(alb)" style="white-space:nowrap; min-width:130px;">{{ t('admin.tagworkshop.btnReview') }}</button>
                  <button class="btn-flat btn-small" style="font-size:0.75rem; color:#888;" :disabled="pending" @click="shelve(alb.mb_release_id, alb.mb_album_dir || '')" :title="t('admin.tagworkshop.shelveHint')">{{ t('admin.tagworkshop.btnShelve') }}</button>
                </div>
              </div>

              <!-- Pagination -->
              <div style="display:flex; gap:0.5rem; justify-content:center; margin-top:0.75rem; font-size:0.85rem; align-items:center; flex-wrap:wrap;">
                <button class="btn-flat btn-small" :disabled="page<=1" @click="page=1; loadAlbums()">«</button>
                <button class="btn-flat btn-small" :disabled="page<=1" @click="page--; loadAlbums()">‹</button>
                <span style="color:#aaa;">{{ t('admin.tagworkshop.pageOf', { page, total: totalPages || 1 }) }}</span>
                <span style="color:#666; font-size:0.78rem;">({{ total.toLocaleString() }} {{ t('admin.tagworkshop.albumsTotal') }})</span>
                <input v-model.number="pageJump" @keydown.enter="jumpToPage" type="number" min="1" :max="totalPages" :placeholder="t('admin.tagworkshop.goToPage')" style="width:70px; padding:2px 6px; border-radius:4px; border:1px solid var(--border); background:var(--raised2); color:var(--t1); font-size:0.82rem; text-align:center;">
                <button class="btn-flat btn-small" @click="jumpToPage">{{ t('admin.tagworkshop.btnGo') }}</button>
                <button class="btn-flat btn-small" :disabled="page>=totalPages" @click="page++; loadAlbums()">›</button>
                <button class="btn-flat btn-small" :disabled="page>=totalPages" @click="page=totalPages; loadAlbums()">»</button>
              </div>
            </div>
          </div><!-- /review tab -->

          <!-- SHELVED tab -->
          <div v-if="tab==='shelved'">
            <p style="color:#aaa; font-size:0.82rem; margin:0 0 0.75rem 0; line-height:1.5;">{{ t('admin.tagworkshop.shelvedExplain') }}</p>
            <div v-if="shelvedAlbums.length === 0" style="color:#888; font-size:0.88rem; padding:1rem 0;">{{ t('admin.tagworkshop.shelvedEmpty') }}</div>
            <div v-else>
              <div v-for="alb in shelvedAlbums" :key="alb.mb_release_id + '|' + (alb.mb_album_dir || '')"
                style="display:flex; align-items:center; gap:0.75rem; padding:0.65rem 0; border-bottom:1px solid var(--border);">
                <img v-if="alb.album_art" :src="'/album-art/' + alb.album_art" style="width:48px; height:48px; border-radius:4px; object-fit:cover; flex-shrink:0; opacity:0.5;" alt="">
                <div v-else style="width:48px; height:48px; border-radius:4px; background:var(--raised3); flex-shrink:0;"></div>
                <div style="flex:1; min-width:0;">
                  <div style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; opacity:0.7;">{{ alb.mb_album }}</div>
                  <div style="font-size:0.82rem; color:#777;">{{ alb.mb_artist }}<span v-if="alb.mb_year"> · {{ alb.mb_year }}</span></div>
                  <div style="font-size:0.78rem; color:#666;">{{ alb.track_count }} {{ t('admin.tagworkshop.tracks') }}</div>
                </div>
                <div style="flex-shrink:0;">
                  <button class="btn btn-secondary btn-small" :disabled="pending" @click="unshelve(alb.mb_release_id, alb.mb_album_dir || '')">{{ t('admin.tagworkshop.btnUnshelve') }}</button>
                </div>
              </div>
              <!-- Pagination -->
              <div style="display:flex; gap:0.5rem; justify-content:center; margin-top:0.75rem; font-size:0.85rem; align-items:center;">
                <button class="btn-flat btn-small" :disabled="shelvedPage<=1" @click="shelvedPage--; loadShelved()">&laquo;</button>
                <span>{{ shelvedPage }} / {{ shelvedTotalPages || 1 }}</span>
                <button class="btn-flat btn-small" :disabled="shelvedPage>=shelvedTotalPages" @click="shelvedPage++; loadShelved()">&raquo;</button>
              </div>
            </div>
          </div><!-- /shelved tab -->
        </div>
        <div v-else-if="mb.done > 0" style="color:#4caf50; font-size:0.9rem; padding:0.5rem 0;">{{ t('admin.tagworkshop.allClean') }}</div>

        <p v-if="msg" style="margin-top:0.75rem; font-size:0.85rem; color:#4caf50;">{{ msg }}</p>
        </div><!-- /card-content -->
      </div><!-- /card -->
        </div><!-- /col -->
      </div><!-- /row -->

      <!-- Detail modal -->
      <div v-if="showDetail" style="position:fixed; inset:0; background:rgba(0,0,0,0.72); z-index:9999; display:flex; align-items:flex-start; justify-content:center; padding:2rem 1rem; overflow-y:auto;">
        <div style="background:var(--bg); border-radius:10px; max-width:960px; width:100%; padding:1.5rem; position:relative;">
          <button @click="showDetail=false; acceptErrors=[]" style="position:absolute; top:.75rem; right:.75rem; background:none; border:none; color:var(--t1); font-size:1.4rem; cursor:pointer;">&times;</button>
          <h5 style="margin:0 0 0.2rem;">{{ t('admin.tagworkshop.reviewModalTitle') }}</h5>
          <p v-if="detailLabel" style="color:#aaa; font-size:0.85rem; margin:0 0 1rem 0;">{{ detailLabel }}</p>

          <!-- What will happen notice -->
          <div style="background:rgba(255,152,0,0.1); border:1px solid rgba(255,152,0,0.3); border-radius:6px; padding:0.65rem 0.9rem; margin-bottom:1rem; font-size:0.83rem; color:#ffb74d; line-height:1.5;">
            {{ t('admin.tagworkshop.acceptWarning', { count: detailTracks.length }) }}
          </div>

          <!-- Tracks comparison table -->
          <div style="overflow-x:auto; margin-bottom:0.75rem;">
            <table style="width:100%; border-collapse:collapse; font-size:0.82rem;">
              <thead>
                <tr style="text-align:left; border-bottom:2px solid var(--border);">
                  <th style="padding:4px 8px; color:#aaa; font-weight:normal;">#</th>
                  <th style="padding:4px 8px; color:#aaa; font-weight:normal;">{{ t('admin.tagworkshop.colTitle') }}</th>
                  <th style="padding:4px 8px; color:#aaa; font-weight:normal;">{{ t('admin.tagworkshop.colArtist') }}</th>
                  <th style="padding:4px 8px; color:#aaa; font-weight:normal;">{{ t('admin.tagworkshop.colAlbum') }}</th>
                  <th style="padding:4px 8px; color:#aaa; font-weight:normal;">{{ t('admin.tagworkshop.colYear') }}</th>
                  <th style="padding:4px 8px; color:#aaa; font-weight:normal;"></th>
                </tr>
              </thead>
              <tbody>
                <template v-for="t_ in detailTracks" :key="t_.filepath">
                  <!-- Label row -->
                  <tr>
                    <td colspan="5" style="padding:6px 8px 1px 8px; font-size:0.72rem; color:#888; font-style:italic; border-top:1px solid var(--border); word-break:break-all;">{{ t_.filepath }}</td>
                    <td style="padding:6px 8px 1px 8px; border-top:1px solid var(--border); white-space:nowrap; text-align:right;">
                      <span v-if="t_.acoustid_id" style="background:rgba(255,152,0,0.15); color:#ffb74d; border:1px solid rgba(255,152,0,0.4); border-radius:10px; padding:1px 7px; font-size:0.7rem;" :title="t('admin.tagworkshop.badgeAcoustidHint')">🎵 AcoustID</span>
                      <span v-else-if="t_.mb_text_search_score != null" style="background:rgba(33,150,243,0.15); color:#64b5f6; border:1px solid rgba(33,150,243,0.35); border-radius:10px; padding:1px 7px; font-size:0.7rem;" :title="t('admin.tagworkshop.badgeTextMatchHint')">🔍 {{ t('admin.tagworkshop.badgeTextMatch') }} {{ Math.round(t_.mb_text_search_score * 100) }}%</span>
                    </td>
                  </tr>
                  <!-- Current file row -->
                  <tr style="opacity:0.7;" :title="t('admin.tagworkshop.yourFile')">
                    <td style="padding:2px 8px; color:#888; font-size:0.78rem;">{{ t_.track || '–' }}</td>
                    <td style="padding:2px 8px; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">{{ t_.title || '–' }}</td>
                    <td style="padding:2px 8px; white-space:nowrap;">{{ t_.artist || '–' }}</td>
                    <td style="padding:2px 8px; white-space:nowrap;">{{ t_.album || '–' }}</td>
                    <td style="padding:2px 8px;">{{ t_.year || '–' }}</td>
                    <td style="padding:2px 8px; font-size:0.72rem; color:#888; white-space:nowrap;">← {{ t('admin.tagworkshop.labelYourFile') }}</td>
                  </tr>
                  <!-- MusicBrainz suggestion row — per-cell color, inline-editable -->
                  <tr style="font-weight:500; border-bottom:1px solid var(--border);" :title="t('admin.tagworkshop.cellEditHint')">
                    <td style="padding:2px 8px; font-size:0.78rem;" :style="{color: cellColor(t_,'track')}">{{ t_.mb_track || '–' }}</td>
                    <td style="padding:2px 8px; max-width:180px;" :style="{color: cellColor(t_,'title')}"><input type="text" :value="detailEdits[t_.filepath] !== undefined && detailEdits[t_.filepath].title !== undefined ? detailEdits[t_.filepath].title : (t_.mb_title || '')" @input="setDetailEdit(t_.filepath, 'title', $event.target.value)" style="border:none; background:transparent; color:inherit; font:inherit; width:100%; padding:0; cursor:text;" /></td>
                    <td style="padding:2px 8px;" :style="{color: cellColor(t_,'artist')}"><input type="text" :value="detailEdits[t_.filepath] !== undefined && detailEdits[t_.filepath].artist !== undefined ? detailEdits[t_.filepath].artist : (t_.mb_artist || '')" @input="setDetailEdit(t_.filepath, 'artist', $event.target.value)" style="border:none; background:transparent; color:inherit; font:inherit; width:100%; padding:0; cursor:text;" /></td>
                    <td style="padding:2px 8px;" :style="{color: cellColor(t_,'album')}"><input type="text" :value="detailEdits[t_.filepath] !== undefined && detailEdits[t_.filepath].album !== undefined ? detailEdits[t_.filepath].album : (t_.mb_album || '')" @input="setDetailEdit(t_.filepath, 'album', $event.target.value)" style="border:none; background:transparent; color:inherit; font:inherit; width:100%; padding:0; cursor:text;" /></td>
                    <td style="padding:2px 8px;" :style="{color: cellColor(t_,'year')}"><input type="text" :value="detailEdits[t_.filepath] !== undefined && detailEdits[t_.filepath].year !== undefined ? detailEdits[t_.filepath].year : (t_.mb_year || '')" @input="setDetailEdit(t_.filepath, 'year', $event.target.value)" style="border:none; background:transparent; color:inherit; font:inherit; width:60px; padding:0; cursor:text;" /></td>
                    <td style="padding:2px 8px; font-size:0.72rem; white-space:nowrap;" :style="{color: '#aaa'}">← {{ t('admin.tagworkshop.labelMbSuggestion') }}</td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>

          <!-- Legend -->
          <div style="font-size:0.78rem; color:#aaa; margin-bottom:1rem; display:flex; gap:1.25rem; flex-wrap:wrap;">
            <span style="opacity:0.5;">── {{ t('admin.tagworkshop.labelYourFile') }}</span>
            <span><b style="color:#4caf50;">■</b> {{ t('admin.tagworkshop.legendMatch') }}</span>
            <span><b style="color:#ff9800;">■</b> {{ t('admin.tagworkshop.legendDiff') }}</span>
          </div>

          <!-- Write errors (shown after a failed accept) -->
          <div v-if="acceptErrors.length" style="background:rgba(229,115,115,0.1); border:1px solid rgba(229,115,115,0.4); border-radius:6px; padding:0.65rem 0.9rem; margin-bottom:1rem; font-size:0.83rem; color:#ef9a9a; line-height:1.5;">
            <b>{{ t('admin.tagworkshop.writeErrorsTitle') }}</b><br>
            <span v-for="e in acceptErrors" :key="e.filepath" style="display:block; font-size:0.78rem; margin-top:2px; opacity:0.85;">{{ e.filepath.split('/').pop() }}: {{ e.error }}</span>
          </div>

          <!-- Write progress (shown while accepting) -->
          <div v-if="pending && acceptWriteTotal > 0" style="margin-bottom:1rem;">
            <div style="font-size:0.83rem; color:#aaa; margin-bottom:0.4rem;">{{ t('admin.tagworkshop.progressProcessing', { done: acceptWriteDone, total: acceptWriteTotal }) }}</div>
            <div style="background:var(--border); border-radius:4px; height:6px; overflow:hidden;">
              <div :style="{ width: (acceptWriteTotal ? (acceptWriteDone / acceptWriteTotal * 100) : 0) + '%', background: '#4caf50', height: '100%', transition: 'width 0.2s' }"></div>
            </div>
          </div>

          <div style="display:flex; gap:0.75rem; justify-content:flex-end; align-items:center; flex-wrap:wrap;">
            <button class="btn btn-secondary" :disabled="pending" @click="showDetail=false; acceptErrors=[]">{{ t('admin.tagworkshop.btnCancel') }}</button>
            <button class="btn btn-secondary" :disabled="pending" @click="shelveDetail" :title="t('admin.tagworkshop.shelveHint')">{{ t('admin.tagworkshop.btnShelve') }}</button>
            <button class="btn" style="min-width:170px;" :disabled="pending" @click="acceptDetail">{{ pending ? t('admin.tagworkshop.btnAccepting') : t('admin.tagworkshop.btnAccept') }}</button>
          </div>
        </div>
      </div>
    </div>
  `,
  methods: {
    cellColor(t_, field) {
      const n = s => (s || '').toLowerCase().replaceAll(/[^a-z0-9]/g, '');
      switch (field) {
        case 'track':  return (!t_.mb_track  || t_.mb_track == t_.track)                           ? '#4caf50' : '#ff9800';
        case 'title':  return (!t_.mb_title  || n(t_.title)  === n(t_.mb_title))                   ? '#4caf50' : '#ff9800';
        case 'artist': return (!t_.mb_artist || n(t_.artist) === n(t_.mb_artist))                  ? '#4caf50' : '#ff9800';
        case 'album':  return (!t_.mb_album  || n(t_.album)  === n(t_.mb_album))                   ? '#4caf50' : '#ff9800';
        case 'year':   return (!t_.mb_year   || Math.abs((t_.year || 0) - t_.mb_year) <= 1)        ? '#4caf50' : '#ff9800';
        default: return '';
      }
    },
    async loadStatus() {
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/tagworkshop/status` });
        this.mb         = res.data.mb         || this.mb;
        this.tags       = res.data.tags       || this.tags;
        this.coverage   = res.data.coverage   || this.coverage;
        this.enrich     = res.data.enrich     || this.enrich;
        this.textSearch = res.data.textSearch || this.textSearch;
        // Only reschedule when the request succeeded and the worker is still running
        if (this.enrich.running || this.textSearch.running) {
          this._statusTimer = setTimeout(() => { this.loadStatus(); this.loadAlbums(); }, 8000);
        }
      } catch {
        // Server unreachable — stop polling to avoid console flood
      }
    },
    async loadAlbums() {
      try {
        // Clear selection when filter or sort changes (but not on page change alone)
        if (this.filter !== this._lastFilter || this.sort !== this._lastSort) {
          this.selectedAlbums = [];
          this._lastFilter = this.filter;
          this._lastSort = this.sort;
        }
        const q = this.search.trim();
        const url = `${API.url()}/api/v1/tagworkshop/albums?page=${this.page}&filter=${this.filter}&sort=${this.sort}${q ? '&q=' + encodeURIComponent(q) : ''}`;
        const res = await API.axios({ method: 'GET', url });
        this.albums   = res.data.albums   || [];
        this.total    = res.data.total    || 0;
        this.pageSize = res.data.pageSize || 40;
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    },
    onSearchInput() {
      clearTimeout(this.searchDebounce);
      this.searchDebounce = setTimeout(() => { this.page = 1; this.loadAlbums(); }, 350);
    },
    jumpToPage() {
      const p = Number.parseInt(this.pageJump, 10);
      if (p >= 1 && p <= (this.totalPages || 1)) {
        this.page = p;
        this.loadAlbums();
      }
      this.pageJump = '';
    },
    async startEnrich() {
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/tagworkshop/enrich/start` });
        if (res?.data?.pending === true) {
          this.enrich.running = false;
          this.enrich.stopping = false;
          const queuedMsg = this.t('admin.bpmAnalysis.msgQueuedScan', { feature: this.t('admin.tagworkshop.enrichTitle') });
          iziToast.info({ title: queuedMsg, position: 'topCenter', timeout: 4500 });
          this._statusTimer = setTimeout(() => { this.loadStatus(); }, 2000);
          return;
        }
        this.enrich.running = true;
        this._statusTimer = setTimeout(() => { this.loadStatus(); }, 2000);
      } catch (e) {
        iziToast.error({ title: e?.response?.data?.error || e.message || 'Error', position: 'topCenter', timeout: 3500 });
      }
    },
    async stopEnrich() {
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/tagworkshop/enrich/stop` });
        this.enrich.stopping = true;
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    },
    async startTextSearch() {
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/tagworkshop/text-search/start` });
        if (res?.data?.pending === true) {
          this.textSearch.running = false;
          this.textSearch.stopping = false;
          const queuedMsg = this.t('admin.bpmAnalysis.msgQueuedScan', { feature: this.t('admin.tagworkshop.tsTitle') });
          iziToast.info({ title: queuedMsg, position: 'topCenter', timeout: 4500 });
          this._statusTimer = setTimeout(() => { this.loadStatus(); }, 2000);
          return;
        }
        this.textSearch.running = true;
        this._statusTimer = setTimeout(() => { this.loadStatus(); }, 2000);
      } catch (e) {
        iziToast.error({ title: e?.response?.data?.error || e.message || 'Error', position: 'topCenter', timeout: 3500 });
      }
    },
    async stopTextSearch() {
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/tagworkshop/text-search/stop` });
        this.textSearch.stopping = true;
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    },
    async retryTextSearchNotFound() {
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/tagworkshop/text-search/retry-notfound` });
        await this.loadStatus();
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    },
    async toggleEnrichErrors() {
      this.showEnrichErrors = !this.showEnrichErrors;
      if (this.showEnrichErrors && this.enrichErrors.length === 0) {
        try {
          const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/tagworkshop/enrich/errors` });
          this.enrichErrors = res.data.errors || [];
        } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      }
    },
    async retryEnrichErrors() {
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/tagworkshop/enrich/retry-errors` });
        this.enrichErrors = [];
        this.showEnrichErrors = false;
        await this.loadStatus();
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    },
    enrichErrorMsg(raw) {
      if (!raw) return this.t('admin.tagworkshop.enrichErrorUnknown');
      if (raw.includes('503') || raw.toLowerCase().includes('temporarily unavailable')) return this.t('admin.tagworkshop.errMbUnavailable');
      if (raw.includes('429') || raw.toLowerCase().includes('rate limit'))               return this.t('admin.tagworkshop.errMbRateLimit');
      if (raw.toLowerCase().includes('timeout'))                                          return this.t('admin.tagworkshop.errMbTimeout');
      const m = raw.match(/HTTP (\d+)/);
      if (m) return this.t('admin.tagworkshop.errMbHttp', { code: m[1] });
      return raw;
    },
    async toggleTsErrors() {
      this.showTsErrors = !this.showTsErrors;
      if (this.showTsErrors && this.tsErrors.length === 0) {
        try {
          const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/tagworkshop/text-search/errors` });
          this.tsErrors = res.data.errors ?? [];
        } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      }
    },
    async retryTsErrors() {
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/tagworkshop/text-search/retry-errors` });
        this.tsErrors = [];
        this.showTsErrors = false;
        await this.loadStatus();
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    },
    setDetailEdit(fp, field, val) {
      this.detailEdits = { ...this.detailEdits, [fp]: { ...this.detailEdits[fp], [field]: val } };
    },
    async openDetail(alb) {
      this.detailReleaseId     = alb.mb_release_id;
      this.detailAlbumDir      = alb.mb_album_dir || '';
      this.detailLabel         = [alb.mb_artist, alb.mb_album, alb.mb_year ? '(' + alb.mb_year + ')' : ''].filter(Boolean).join(' — ');
      this.detailEdits = {};
      this.acceptErrors = [];
      this.detailTracks = [];
      this.showDetail = true;
      try {
        const albumDirParam = this.detailAlbumDir ? `&album_dir=${encodeURIComponent(this.detailAlbumDir)}` : '';;
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/tagworkshop/album/${encodeURIComponent(alb.mb_release_id)}?dummy=1${albumDirParam}` });
        this.detailTracks = res.data.tracks || [];
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    },
    async acceptDetail() {
      if (!this.detailReleaseId) return;
      this.pending = true;
      this.acceptErrors = [];
      this.acceptWriteDone  = 0;
      this.acceptWriteTotal = this.detailTracks.length;
      try {
        let accepted = 0, skippedEqual = 0;
        for (const track of this.detailTracks) {
          try {
            const perTrack = this.detailEdits[track.filepath] || {};
            const overrides = {
              ...(perTrack.artist === undefined ? {} : { artist: perTrack.artist }),
              ...(perTrack.album  === undefined ? {} : { album:  perTrack.album  }),
              ...(perTrack.title  === undefined ? {} : { title:  perTrack.title  }),
              ...(perTrack.year   === undefined ? {} : { year:   perTrack.year   }),
            };
            const r = await API.axios({
              method: 'POST',
              url: `${API.url()}/api/v1/tagworkshop/accept-track`,
              data: { mb_release_id: this.detailReleaseId, filepath: track.filepath, vpath: track.vpath, overrides },
            });
            if (r.data.error) {
              this.acceptErrors.push({ filepath: track.filepath, error: r.data.error });
            } else if (r.data.skippedEqual) {
              skippedEqual++;
            } else {
              accepted++;
            }
          } catch {
            this.acceptErrors.push({ filepath: track.filepath, error: this.t('admin.tagworkshop.toastError') });
          }
          this.acceptWriteDone++;
        }

        if (this.acceptErrors.length) {
          this.msg = this.t('admin.tagworkshop.toastWritePartial', { written: accepted, failed: this.acceptErrors.length });
        } else {
          this.msg = skippedEqual > 0
            ? this.t('admin.tagworkshop.toastAcceptedWithSkipped', { written: accepted, skipped: skippedEqual })
            : this.t('admin.tagworkshop.toastAccepted', { count: accepted });
          this.showDetail = false;
        }
        await this.loadStatus();
        await this.loadAlbums();
      } catch {
        this.msg = this.t('admin.tagworkshop.toastError');
      } finally {
        this.pending = false;
        this.acceptWriteTotal = 0;
        this.acceptWriteDone  = 0;
      }
    },
    async shelve(mb_release_id, album_dir = '') {
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/tagworkshop/skip`, data: { mb_release_id, album_dir } });
        await this.loadAlbums();
        await this.loadStatus();
        await this.loadShelved();
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    },
    async shelveDetail() {
      await this.shelve(this.detailReleaseId, this.detailAlbumDir);
      this.showDetail = false;
    },
    async unshelve(mb_release_id, album_dir = '') {
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/tagworkshop/unshelve`, data: { mb_release_id, album_dir } });
        await this.loadShelved();
        await this.loadAlbums();
        await this.loadStatus();
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    },
    async loadShelved() {
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/tagworkshop/shelved?page=${this.shelvedPage}` });
        this.shelvedAlbums = res.data.albums || [];
        this.shelvedTotal  = res.data.total  || 0;
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    },
    albumKey(a) { return a.mb_release_id + '|' + (a.mb_album_dir || ''); },
    isSelected(a) { const k = this.albumKey(a); return this.selectedAlbums.some(s => this.albumKey(s) === k); },
    toggleSelect(a) {
      const k = this.albumKey(a);
      const idx = this.selectedAlbums.findIndex(s => this.albumKey(s) === k);
      if (idx === -1) this.selectedAlbums.push(a);
      else this.selectedAlbums.splice(idx, 1);
    },
    selectAll() {
      for (const a of this.albums) { if (!this.isSelected(a)) this.selectedAlbums.push(a); }
    },
    deselectAll() { this.selectedAlbums = []; },
    async batchAcceptSelected() {
      if (!this.selectedAlbums.length || _tagBatchState.running) return;
      _tagBatchState.running = true;
      const batch = [...this.selectedAlbums];
      _tagBatchState.albumTotal = batch.length;
      _tagBatchState.albumDone  = 0;
      _tagBatchState.trackDone  = 0;
      _tagBatchState.trackTotal = 0;
      _tagBatchState.currentAlbum = '';
      let totalTracks = 0, totalErrors = 0;
      try {
        // Phase 1: fetch all track lists to get a total track count up-front
        const trackLists = [];
        for (const alb of batch) {
          try {
            const albumDirParam = alb.mb_album_dir ? `&album_dir=${encodeURIComponent(alb.mb_album_dir)}` : '';
            const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/tagworkshop/album/${encodeURIComponent(alb.mb_release_id)}?dummy=1${albumDirParam}` });
            trackLists.push({ alb, tracks: res.data.tracks || [] });
            _tagBatchState.trackTotal += (res.data.tracks || []).length;
          } catch { trackLists.push({ alb, tracks: [] }); totalErrors++; }
        }
        // Phase 2: write tracks, update counters immediately after each one
        for (const { alb, tracks } of trackLists) {
          _tagBatchState.currentAlbum = [alb.mb_artist, alb.mb_album].filter(Boolean).join(' — ');
          for (const track of tracks) {
            try {
              const r = await API.axios({
                method: 'POST',
                url: `${API.url()}/api/v1/tagworkshop/accept-track`,
                data: { mb_release_id: alb.mb_release_id, filepath: track.filepath, vpath: track.vpath, overrides: {} },
              });
              if (r.data.error) totalErrors++;
              else if (!r.data.skipped) totalTracks++;
            } catch { totalErrors++; }
            _tagBatchState.trackDone++;
          }
          _tagBatchState.albumDone++;
        }
        this.selectedAlbums = [];
        _tagBatchState.currentAlbum = '';
        this.msg = totalErrors > 0
          ? this.t('admin.tagworkshop.batchErrors', { albums: batch.length, errors: totalErrors })
          : this.t('admin.tagworkshop.batchDone', { albums: batch.length, tracks: totalTracks });
        await this.loadStatus();
        await this.loadAlbums();
      } catch {
        this.msg = this.t('admin.tagworkshop.toastError');
      } finally {
        _tagBatchState.running      = false;
        _tagBatchState.albumDone    = 0;
        _tagBatchState.albumTotal   = 0;
        _tagBatchState.trackDone    = 0;
        _tagBatchState.trackTotal   = 0;
        _tagBatchState.currentAlbum = '';
      }
    },
    async bulkAcceptCasing() {
      this.bulkCasingConfirm = false;
      this.pending = true;
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/tagworkshop/bulk-accept-casing` });
        this.msg = this.t('admin.tagworkshop.toastBulkAccepted', { count: res.data.accepted + res.data.dbOnly });
        await this.loadStatus();
        await this.loadAlbums();
      } catch {
        this.msg = this.t('admin.tagworkshop.toastError');
      } finally {
        this.pending = false;
      }
    },
  }
});

const radioView = Vue.component('radio-view', {
  data() {
    return {
      enabled: false,
      maxRecordingMinutes: ADMINDATA.dbParams.maxRecordingMinutes || 180,
      pending: false,
    };
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{ t('admin.radio.title') }}</span>
              <p style="margin-bottom:0.5rem;">{{t('admin.radio.desc1')}}</p>
              <p style="margin-bottom:1rem;font-size:0.85rem;color:#999;">{{t('admin.radio.desc2')}}</p>
              <table>
                <tbody>
                  <tr>
                    <td style="width:140px"><b>{{ t('admin.radio.labelEnable') }}</b></td>
                    <td><input type="checkbox" v-model="enabled" style="margin:0;width:auto;height:auto;" /> {{ t('admin.radio.checkboxEnable') }}</td>
                  </tr>
                  <tr v-if="enabled">
                    <td><b>{{ t('admin.radio.labelMaxRecording') }}</b></td>
                    <td>
                      <input type="number" v-model.number="maxRecordingMinutes" min="1" step="1" style="width:80px;display:inline-block;margin:0 6px 0 0;" />
                      {{ t('admin.radio.maxRecordingUnit') }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="card-action">
              <button class="btn" v-on:click="save()" :disabled="pending">
                {{ pending ? t('admin.common.saving') : t('admin.common.save') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>`,
  async mounted() {
    try {
      const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/radio/config` });
      this.enabled = res.data.enabled === true;
    } catch (e) { console.debug('[velvet]', e?.message ?? e); }
  },
  methods: {
    save: async function() {
      this.pending = true;
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/radio/config`,
          data: { enabled: this.enabled }
        });
        if (this.enabled) {
          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/db/params/max-recording-minutes`,
            data: { maxRecordingMinutes: this.maxRecordingMinutes }
          });
          Vue.set(ADMINDATA.dbParams, 'maxRecordingMinutes', this.maxRecordingMinutes);
        }
        iziToast.success({ title: this.t('admin.radio.toastSaved'), position: 'topCenter', timeout: 3000 });
      } catch {
        iziToast.error({ title: this.t('admin.radio.toastFailed'), position: 'topCenter', timeout: 3000 });
      } finally {
        this.pending = false;
      }
    }
  }
});

// ── Genre Enricher Admin View ─────────────────────────────────────────────
const genreEnricherView = Vue.component('genre-enricher-view', {
  data() {
    return {
      running:  false,
      stopping: false,
      pendingStart: false,
      currentArtist: null,
      currentPhase: null,
      processedCount: 0,
      stats: {
        total: 0, done: 0, found: 0, not_found: 0, errors: 0, queued: 0,
        lfQueue: 0, mbQueue: 0, dgQueue: 0,
        bySource: { lastfm: 0, mb: 0, discogs: 0 },
        byState: { lastfm: { ok: 0, nf: 0, error: 0, queued: 0 }, mb: { ok: 0, nf: 0, error: 0, queued: 0 }, discogs: { ok: 0, nf: 0, error: 0, queued: 0 } },
        mismatch: 0, fillableEmpty: 0, anyFound: 0,
      },
      msg: '',
      resetConfirm: false,
      resetSourceConfirm: '', // 'lastfm' | 'mb' | 'discogs'
      // Comparison table
      compareFilter: 'enriched',
      compareSearch: '',
      compareGenreFilter: '',
      _compareSearchTimer: null,
      compareRows: [],
      compareTotal: 0,
      compareOffset: 0,
      compareLimit: 50,
      comparePending: false,
      // Per-artist source choice (key = artist name → 'lastfm'|'mb'|'discogs')
      pickedSource: {},
      selectedArtists: new Set(),
      applyConfirm: false,
      applyAllConfirm: false,
      applyAllConsensusConfirm: false,
      applyAllMajorityConfirm: false,
      applyAllSource: 'preferred',
      _timer: null,
    };
  },
  computed: {
    statusLabel() {
      if (this.stopping)    return this.t('admin.genreEnricher.statusStopping');
      if (this.running)     return this.t('admin.genreEnricher.statusRunning');
      if (this.pendingStart) return this.t('admin.genreEnricher.statusPending');
      return this.t('admin.genreEnricher.statusIdle');
    },
    donePct() {
      if (!this.stats.total) return '0.0';
      return ((this.stats.done / this.stats.total) * 100).toFixed(1);
    },
    comparePages() {
      return Math.max(1, Math.ceil(this.compareTotal / this.compareLimit));
    },
    comparePage() {
      return Math.floor(this.compareOffset / this.compareLimit) + 1;
    },
  },
  mounted() { this.loadStatus(); this.loadCompare(); },
  beforeUnmount() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  },
  methods: {
    async loadStatus() {
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/genre-enricher/status` });
        const d = res.data;
        this.running        = d.running;
        this.stopping       = d.stopping;
        this.pendingStart   = d.pendingStart ?? false;
        this.currentArtist  = d.currentArtist;
        this.currentPhase   = d.currentPhase;
        this.processedCount = d.processedCount;
        if (d.stats) this.stats = d.stats;
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      this._timer = setTimeout(() => this.loadStatus(), (this.running || this.pendingStart) ? 2000 : 15000);
    },
    async loadCompare() {
      this.comparePending = true;
      try {
        const params = { filter: this.compareFilter, limit: this.compareLimit, offset: this.compareOffset };
        if (this.compareSearch.trim())      params.search      = this.compareSearch.trim();
        if (this.compareGenreFilter.trim()) params.currentGenre = this.compareGenreFilter.trim();
        const res = await API.axios({
          method: 'GET',
          url: `${API.url()}/api/v1/admin/genre-enricher/compare`,
          params,
        });
        this.compareRows  = res.data.rows  ?? [];
        this.compareTotal = res.data.total ?? 0;
        this.selectedArtists = new Set();
        // Default per-row picker: prefer MB → Discogs → Last.fm
        const picked = {};
        for (const r of this.compareRows) {
          if (r.mb_genre)                                        picked[r.artist] = 'mb';
          else if (r.discogs_genre)                            picked[r.artist] = 'discogs';
          else if (r.lastfm_genre)                             picked[r.artist] = 'lastfm';
          // All 3 sources returned nothing but the track already has a genre → keep it
          else if (r.current_genre)                            picked[r.artist] = 'keep';
          else                                                 picked[r.artist] = 'lastfm';
        }
        this.pickedSource = picked;
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
      this.comparePending = false;
    },
    pickSource(artist, source) {
      this.pickedSource = { ...this.pickedSource, [artist]: source };
    },
    async setCurrentGenre(row, raw) {
      const value = String(raw || '').trim().toLowerCase();
      if (value === (row.current_genre || '').toLowerCase()) return;
      try {
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/genre-enricher/set-genre`,
          data: { artist: row.artist, genre: value },
        });
        row.current_genre = value || null;
        iziToast.success({ title: this.t('admin.genreEnricher.msgCurrentSet', { count: res.data.updated || 0 }), position: 'topCenter', timeout: 3000 });
      } catch (e) { iziToast.error({ title: e?.response?.data?.error || e.message || 'Error', position: 'topCenter', timeout: 4000 }); }
    },
    toggleSelect(artist) {
      if (this.selectedArtists.has(artist)) this.selectedArtists.delete(artist);
      else this.selectedArtists.add(artist);
      // Force Vue reactivity on the Set
      this.selectedArtists = new Set(this.selectedArtists);
    },
    toggleSelectAll() {
      if (this.selectedArtists.size === this.compareRows.length) {
        this.selectedArtists = new Set();
      } else {
        this.selectedArtists = new Set(this.compareRows.map(r => r.artist));
      }
    },
    async start() {
      this.msg = '';
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/genre-enricher/start` });
        if (res?.data?.pending === true) {
          this.running = false;
          this.stopping = false;
          const queuedMsg = this.t('admin.bpmAnalysis.msgQueuedScan', { feature: this.t('admin.genreEnricher.title') });
          this.msg = queuedMsg;
          iziToast.info({ title: queuedMsg, position: 'topCenter', timeout: 4500 });
          this.loadStatus();
          return;
        }
        this.running = true; this.stopping = false;
        this.msg = this.t('admin.genreEnricher.msgStarted');
        this.loadStatus();
      } catch (e) {
        this.msg = e?.response?.data?.error || e.message || 'Error';
        iziToast.error({ title: this.msg, position: 'topCenter', timeout: 3500 });
      }
    },
    async stop() {
      this.msg = '';
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/genre-enricher/stop` });
        this.running = false; this.stopping = false;
        this.msg = this.t('admin.genreEnricher.msgStopping');
      } catch (e) { this.msg = e?.response?.data?.error || e.message || 'Error'; }
    },
    async resetErrors() {
      this.msg = '';
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/genre-enricher/reset-errors` });
        this.msg = this.t('admin.genreEnricher.msgResetErrors', { count: res.data.reset || 0 });
        this.loadStatus();
      } catch (e) { this.msg = e?.response?.data?.error || e.message || 'Error'; }
    },
    async resetNotFound() {
      this.msg = '';
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/genre-enricher/reset-not-found` });
        this.msg = this.t('admin.genreEnricher.msgResetNotFound', { count: res.data.reset || 0 });
        this.loadStatus();
      } catch (e) { this.msg = e?.response?.data?.error || e.message || 'Error'; }
    },
    async resetAll() {
      if (!this.resetConfirm) { this.resetConfirm = true; return; }
      this.resetConfirm = false;
      this.msg = '';
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/genre-enricher/reset-all` });
        this.msg = this.t('admin.genreEnricher.msgResetAll', { count: res.data.reset || 0 });
        this.loadStatus(); this.loadCompare();
      } catch (e) { this.msg = e?.response?.data?.error || e.message || 'Error'; }
    },
    async applySelected() {
      if (!this.selectedArtists.size) return;
      if (!this.applyConfirm) { this.applyConfirm = true; return; }
      this.applyConfirm = false;
      this.msg = '';
      try {
        // Include ALL selected artists — 'keep' items are marked as reviewed
        // server-side without changing their genre.
        const items = [...this.selectedArtists].map(a => ({
          artist: a,
          source: this.pickedSource[a] || 'lastfm',
        }));
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/genre-enricher/apply`,
          data: { items },
        });
        iziToast.success({ title: this.t('admin.genreEnricher.msgApplied', { count: res.data.updated || 0 }), position: 'topCenter', timeout: 3000 });
        // Remove all acted-upon rows immediately (including kept ones).
        const actedSet = new Set(items.map(it => (it.artist || '').toLowerCase()));
        this.compareRows = this.compareRows.filter(r => !actedSet.has((r.artist || '').toLowerCase()));
        this.compareTotal = Math.max(0, (this.compareTotal || 0) - actedSet.size);
        this.selectedArtists = new Set();
        this.loadCompare();
      } catch (e) { iziToast.error({ title: e?.response?.data?.error || e.message || 'Error', position: 'topCenter', timeout: 4000 }); }
    },
    async applyAllConsensus() {
      if (!this.applyAllConsensusConfirm) { this.applyAllConsensusConfirm = true; return; }
      this.applyAllConsensusConfirm = false;
      this.msg = '';
      try {
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/genre-enricher/apply-all-consensus`,
        });
        iziToast.success({ title: this.t('admin.genreEnricher.msgAppliedConsensus', { count: res.data.updated || 0 }), position: 'topCenter', timeout: 3000 });
        this.loadStatus(); this.loadCompare();
      } catch (e) { iziToast.error({ title: e?.response?.data?.error || e.message || 'Error', position: 'topCenter', timeout: 4000 }); }
    },
    async applyAllMajority() {
      if (!this.applyAllMajorityConfirm) { this.applyAllMajorityConfirm = true; return; }
      this.applyAllMajorityConfirm = false;
      this.msg = '';
      try {
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/genre-enricher/apply-all-majority`,
        });
        iziToast.success({ title: this.t('admin.genreEnricher.msgAppliedMajority', { count: res.data.updated || 0 }), position: 'topCenter', timeout: 3000 });
        this.loadStatus(); this.loadCompare();
      } catch (e) { iziToast.error({ title: e?.response?.data?.error || e.message || 'Error', position: 'topCenter', timeout: 4000 }); }
    },
    async applyAllEmpty() {
      if (!this.applyAllConfirm) { this.applyAllConfirm = true; return; }
      this.applyAllConfirm = false;
      this.msg = '';
      try {
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/genre-enricher/apply-all-empty`,
          data: { source: this.applyAllSource },
        });
        iziToast.success({ title: this.t('admin.genreEnricher.msgAppliedEmpty', { count: res.data.updated || 0 }), position: 'topCenter', timeout: 3000 });
        this.loadStatus(); this.loadCompare();
      } catch (e) { iziToast.error({ title: e?.response?.data?.error || e.message || 'Error', position: 'topCenter', timeout: 4000 }); }
    },
    // Returns 'agree' when all 3 sources resolved to the same genre,
    // 'empty' when all 3 sources found nothing, or null otherwise.
    rowConsensus(row) {
      const lf = (row.lastfm_genre ?? '').toLowerCase().trim();
      const mb = (row.mb_genre ?? '').toLowerCase().trim();
      const dg = (row.discogs_genre ?? '').toLowerCase().trim();
      if (lf && mb && dg && lf === mb && mb === dg) return 'agree';
      // 2/3: two sources agree, third has no data yet
      if (lf && mb && lf === mb && !dg) return 'majority';
      if (lf && dg && lf === dg && !mb) return 'majority';
      if (mb && dg && mb === dg && !lf) return 'majority';
      if (!lf && !mb && !dg) return 'empty';
      return null;
    },
    rowConsensusGenre(row) {
      const lf = (row.lastfm_genre ?? '').toLowerCase().trim();
      const mb = (row.mb_genre ?? '').toLowerCase().trim();
      const dg = (row.discogs_genre ?? '').toLowerCase().trim();
      if (lf && mb && lf === mb) return lf;
      if (lf && dg && lf === dg) return lf;
      if (mb && dg && mb === dg) return mb;
      return lf || mb || dg || '';
    },
    async quickApply(row) {
      const consensus = this.rowConsensus(row);
      if (!consensus) return;
      let source;
      if (consensus === 'empty') {
        source = 'keep';
      } else {
        const lf = (row.lastfm_genre ?? '').toLowerCase().trim();
        const mb = (row.mb_genre ?? '').toLowerCase().trim();
        const dg = (row.discogs_genre ?? '').toLowerCase().trim();
        if (lf && mb && lf === mb) source = 'lastfm';
        else if (lf && dg && lf === dg) source = 'lastfm';
        else source = 'mb'; // mb=dg case
      }
      try {
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/genre-enricher/apply`,
          data: { items: [{ artist: row.artist, source }] },
        });
        if (consensus !== 'empty') row.current_genre = this.rowConsensusGenre(row);
        iziToast.success({ title: this.t('admin.genreEnricher.msgApplied', { count: res.data.updated || 0 }), position: 'topCenter', timeout: 2000 });
        this.compareRows = this.compareRows.filter(r => r.artist !== row.artist);
        this.compareTotal = Math.max(0, (this.compareTotal || 0) - 1);
      } catch (e) { iziToast.error({ title: e?.response?.data?.error || e.message || 'Error', position: 'topCenter', timeout: 4000 }); }
    },
    async resetSource(source) {
      if (this.resetSourceConfirm !== source) { this.resetSourceConfirm = source; return; }
      this.resetSourceConfirm = '';
      this.msg = '';
      try {
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/genre-enricher/reset-source`,
          data: { source },
        });
        this.msg = this.t('admin.genreEnricher.msgResetSource', { source, count: res.data.reset || 0 });
        this.loadStatus(); this.loadCompare();
      } catch (e) { this.msg = e?.response?.data?.error || e.message || 'Error'; }
    },
    setFilter(f) {
      if (this.compareFilter === f) return;
      this.compareFilter = f;
      this.compareOffset = 0;
      this.compareSearch = '';
      this.compareGenreFilter = '';
      this.loadCompare();
    },
    onSearchInput() {
      if (this._compareSearchTimer) clearTimeout(this._compareSearchTimer);
      this._compareSearchTimer = setTimeout(() => {
        this.compareOffset = 0;
        this.loadCompare();
      }, 350);
    },
    onGenreFilterInput() {
      if (this._compareSearchTimer) clearTimeout(this._compareSearchTimer);
      this._compareSearchTimer = setTimeout(() => {
        this.compareOffset = 0;
        this.loadCompare();
      }, 350);
    },
    prevPage() {
      if (this.compareOffset === 0) return;
      this.compareOffset = Math.max(0, this.compareOffset - this.compareLimit);
      this.loadCompare();
    },
    nextPage() {
      if (this.compareOffset + this.compareLimit >= this.compareTotal) return;
      this.compareOffset += this.compareLimit;
      this.loadCompare();
    },
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{ t('admin.genreEnricher.title') }}</span>
              <p style="margin-bottom:1rem;color:#aaa;font-size:.88rem;">{{ t('admin.genreEnricher.desc') }}</p>

              <!-- Progress bar -->
              <div style="background:var(--raised2);border-radius:8px;padding:1rem;margin-bottom:1.25rem;">
                <b style="display:block;margin-bottom:.6rem;">{{ t('admin.genreEnricher.coverageTitle') }}</b>
                <div style="font-size:.88rem;margin-bottom:.35rem;">
                  <span style="color:#4caf50;">{{ t('admin.genreEnricher.statsFound') }}:</span>
                  <b style="margin:0 .4rem;">{{ (stats.found||0).toLocaleString() }} / {{ (stats.total||0).toLocaleString() }}</b>
                  <span style="color:#666;">({{ donePct }}%)</span>
                  <div style="background:rgba(255,255,255,.08);border-radius:3px;height:6px;margin-top:.4rem;">
                    <div :style="'background:#4caf50;height:6px;border-radius:3px;width:'+donePct+'%;transition:width .4s;'"></div>
                  </div>
                </div>
                <table style="font-size:.84rem;border-collapse:collapse;width:100%;margin-top:.6rem;">
                  <tr>
                    <td style="padding:2px 0;color:#aaa;min-width:160px;">{{ t('admin.genreEnricher.statsTotal') }}</td>
                    <td style="padding:2px 8px;text-align:right;font-variant-numeric:tabular-nums;"><b>{{ (stats.total||0).toLocaleString() }}</b></td>
                  </tr>
                  <tr>
                    <td style="padding:2px 0;color:#4caf50;">{{ t('admin.genreEnricher.statsFound') }}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums;"><b>{{ (stats.found||0).toLocaleString() }}</b></td>
                  </tr>
                  <tr>
                    <td style="padding:2px 0;color:#aaa;" :title="t('admin.genreEnricher.statsNotFoundTitle')">{{ t('admin.genreEnricher.statsNotFound') }}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums;"><b>{{ (stats.artistsNf||0).toLocaleString() }}</b></td>
                  </tr>
                  <tr v-if="stats.errors">
                    <td style="padding:2px 0;color:#e57373;">{{ t('admin.genreEnricher.statsErrors') }}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums;"><b>{{ (stats.errors||0).toLocaleString() }}</b></td>
                  </tr>
                  <tr>
                    <td style="padding:2px 0;color:#888;" :title="t('admin.genreEnricher.statsRemainingTitle')">{{ t('admin.genreEnricher.statsRemaining') }}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums;"><b>{{ (stats.artistsQueued||0).toLocaleString() }}</b></td>
                  </tr>
                  <tr v-if="stats.mismatch" style="border-top:1px solid rgba(255,255,255,.06);">
                    <td style="padding:4px 0 2px;color:#ffb74d;">{{ t('admin.genreEnricher.statsMismatch') }}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums;padding-top:4px;"><b style="color:#ffb74d;">{{ (stats.mismatch||0).toLocaleString() }}</b></td>
                  </tr>
                  <tr v-if="stats.fillableEmpty">
                    <td style="padding:2px 0;color:#64b5f6;">{{ t('admin.genreEnricher.statsFillable') }}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums;"><b style="color:#64b5f6;">{{ (stats.fillableEmpty||0).toLocaleString() }}</b></td>
                  </tr>
                </table>
                <div v-if="stats.bySource && (stats.bySource.mb || stats.bySource.discogs)" style="margin-top:.7rem;font-size:.80rem;color:#888;display:flex;gap:.8rem;flex-wrap:wrap;">
                  <span style="color:#aaa;">{{ t('admin.genreEnricher.sourceBreakdown') }}:</span>
                  <span v-if="stats.bySource.lastfm">&#x1F3B5; Last.fm <b style="color:#4caf50;">{{ (stats.bySource.lastfm||0).toLocaleString() }}</b></span>
                  <span v-if="stats.bySource.mb">&#x1F4BF; MusicBrainz <b style="color:#64b5f6;">{{ (stats.bySource.mb||0).toLocaleString() }}</b></span>
                  <span v-if="stats.bySource.discogs">&#x1F4C0; Discogs <b style="color:#ffb74d;">{{ (stats.bySource.discogs||0).toLocaleString() }}</b></span>
                </div>
                <div v-if="stats.lfQueue || stats.mbQueue || stats.dgQueue" style="margin-top:.4rem;font-size:.78rem;color:#666;">
                  <span style="color:#555;">{{ t('admin.genreEnricher.pendingCallsLabel') }}: </span>
                  <span v-if="stats.lfQueue">&#x1F3B5; Last.fm {{ (stats.lfQueue||0).toLocaleString() }}</span>
                  <span v-if="stats.mbQueue"> &nbsp;&#x1F4BF; MusicBrainz {{ (stats.mbQueue||0).toLocaleString() }}</span>
                  <span v-if="stats.dgQueue"> &nbsp;&#x1F4C0; Discogs {{ (stats.dgQueue||0).toLocaleString() }}</span>
                </div>
              </div>

              <!-- Controls -->
              <div style="border:1px solid var(--border);border-radius:8px;padding:1rem;margin-bottom:1rem;">
                <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-bottom:.6rem;">
                  <button class="btn btn-small" @click="start" :disabled="running || stopping || pendingStart">
                    {{ pendingStart ? t('admin.genreEnricher.btnStartPending') : t('admin.genreEnricher.btnStart') }}
                  </button>
                  <button class="btn btn-small btn-flat" @click="stop" :disabled="!running && !stopping && !pendingStart">
                    <span v-if="stopping">{{ t('admin.genreEnricher.btnStopping') }}</span>
                    <span v-else>{{ t('admin.genreEnricher.btnStop') }}</span>
                  </button>
                  <span v-if="running || stopping || pendingStart" style="display:inline-flex;align-items:center;gap:.35rem;font-size:.85rem;color:#aaa;">
                    <span class="dot-spin"></span>{{ statusLabel }}
                  </span>
                  <span v-if="!running && !stopping && !pendingStart" style="font-size:.85rem;color:#666;">{{ statusLabel }}</span>
                  <div style="margin-left:auto;display:flex;gap:.4rem;flex-wrap:wrap;">
                    <button class="btn btn-small btn-flat" @click="resetErrors" :disabled="running || !stats.errors" :title="t('admin.genreEnricher.btnResetErrors')">
                      {{ t('admin.genreEnricher.btnResetErrors') }} ({{ stats.errors||0 }})
                    </button>
                    <button class="btn btn-small btn-flat" @click="resetNotFound" :disabled="running || !stats.not_found" :title="t('admin.genreEnricher.btnResetNotFound')">
                      {{ t('admin.genreEnricher.btnResetNotFound') }} ({{ stats.not_found||0 }})
                    </button>
                    <button class="btn btn-small btn-flat" @click="resetAll" :disabled="running" :style="resetConfirm ? 'color:#e57373;border-color:#e57373;' : ''">
                      {{ resetConfirm ? t('admin.genreEnricher.btnConfirm') : t('admin.genreEnricher.btnResetAll') }}
                    </button>
                  </div>
                </div>
                <div v-if="!running" style="display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.4rem;padding-top:.4rem;border-top:1px solid rgba(255,255,255,.05);font-size:.78rem;color:#888;align-items:center;">
                  <span>{{ t('admin.genreEnricher.rescanSource') }}:</span>
                  <button class="btn btn-small btn-flat" @click="resetSource('lastfm')"
                          :style="resetSourceConfirm==='lastfm' ? 'color:#4caf50;border-color:#4caf50;' : 'color:#4caf50;'">
                    {{ resetSourceConfirm==='lastfm' ? t('admin.genreEnricher.btnConfirm') : 'Last.fm' }}
                  </button>
                  <button class="btn btn-small btn-flat" @click="resetSource('mb')"
                          :style="resetSourceConfirm==='mb' ? 'color:#64b5f6;border-color:#64b5f6;' : 'color:#64b5f6;'">
                    {{ resetSourceConfirm==='mb' ? t('admin.genreEnricher.btnConfirm') : 'MusicBrainz' }}
                  </button>
                  <button class="btn btn-small btn-flat" @click="resetSource('discogs')"
                          :style="resetSourceConfirm==='discogs' ? 'color:#ffb74d;border-color:#ffb74d;' : 'color:#ffb74d;'">
                    {{ resetSourceConfirm==='discogs' ? t('admin.genreEnricher.btnConfirm') : 'Discogs' }}
                  </button>
                </div>
                <div v-if="running && currentArtist" style="font-size:.78rem;color:#777;word-break:break-all;font-family:monospace;margin-top:.4rem;">
                  <span v-if="currentPhase" :style="'margin-right:.5rem;font-family:sans-serif;font-size:.75rem;padding:1px 5px;border-radius:3px;' + (currentPhase==='lastfm' ? 'background:#1b3a1b;color:#4caf50;' : currentPhase==='musicbrainz' ? 'background:#1a2b40;color:#64b5f6;' : 'background:#3a2a10;color:#ffb74d;')">{{ currentPhase === 'lastfm' ? 'Last.fm' : currentPhase === 'musicbrainz' ? 'MusicBrainz' : 'Discogs' }}</span>&#x25B6; {{ currentArtist }}
                </div>
                <div v-if="msg" style="font-size:.84rem;margin-top:.5rem;color:#aaa;">{{ msg }}</div>
              </div>

              <!-- Comparison table -->
              <div style="border:1px solid var(--border);border-radius:8px;padding:1rem;">
                <b style="display:block;margin-bottom:.5rem;">{{ t('admin.genreEnricher.compareTitle') }}</b>
                <p style="font-size:.84rem;color:#aaa;margin-bottom:.7rem;">{{ t('admin.genreEnricher.compareDesc') }}</p>

                <!-- Filter tabs: Enriched = work queue | Empty genre only | Applied = done -->
                <div style="display:flex;gap:.4rem;margin-bottom:.75rem;flex-wrap:wrap;align-items:center;">
                  <button :class="'btn btn-small' + (compareFilter==='enriched' ? '' : ' btn-flat')" @click="setFilter('enriched')">
                    {{ t('admin.genreEnricher.filterEnriched') }} ({{ (stats.enriched||0).toLocaleString() }})
                  </button>
                  <button :class="'btn btn-small' + (compareFilter==='empty' ? '' : ' btn-flat')" @click="setFilter('empty')"
                          :title="t('admin.genreEnricher.filterEmptyTitle')">
                    {{ t('admin.genreEnricher.filterEmpty') }} ({{ (stats.fillableEmpty||0).toLocaleString() }})
                  </button>
                  <button :class="'btn btn-small' + (compareFilter==='applied' ? '' : ' btn-flat')" @click="setFilter('applied')">
                    {{ t('admin.genreEnricher.filterApplied') }} ({{ (stats.applied||0).toLocaleString() }})
                  </button>
                  <!-- Bulk majority action: 2/3 agree, third has no data yet -->
                  <button v-if="stats.majority"
                          class="btn btn-small"
                          @click="applyAllMajority"
                          :title="t('admin.genreEnricher.btnApplyAllMajorityHint')"
                          :style="applyAllMajorityConfirm ? 'background:#ffb74d;color:#000;' : 'background:rgba(255,183,77,.1);border-color:#ffb74d;color:#ffb74d;'">
                    {{ applyAllMajorityConfirm ? t('admin.genreEnricher.btnConfirm') : t('admin.genreEnricher.btnApplyAllMajority') }}
                    ({{ (stats.majority||0).toLocaleString() }})
                  </button>
                  <!-- Bulk consensus action: visible when at least one artist has all 3 sources in agreement -->
                  <button v-if="stats.consensus"
                          class="btn btn-small"
                          @click="applyAllConsensus"
                          :title="t('admin.genreEnricher.btnApplyAllConsensusHint')"
                          :style="applyAllConsensusConfirm ? 'background:#4caf50;color:#fff;' : 'background:rgba(76,175,80,.12);border-color:#4caf50;color:#4caf50;'">
                    {{ applyAllConsensusConfirm ? t('admin.genreEnricher.btnConfirm') : t('admin.genreEnricher.btnApplyAllConsensus') }}
                    ({{ (stats.consensus||0).toLocaleString() }})
                  </button>
                  <span style="margin-left:auto;font-size:.82rem;color:#666;align-self:center;">
                    {{ compareTotal.toLocaleString() }} {{ t('admin.genreEnricher.artists') }}
                  </span>
                </div>

                <!-- Artist search + genre filter -->
                <div style="margin-bottom:.75rem;display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;">
                  <input type="search" v-model="compareSearch" @input="onSearchInput" @search="onSearchInput"
                    :placeholder="t('admin.genreEnricher.searchPlaceholder')"
                    style="flex:1;min-width:160px;max-width:280px;padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg2,#1e1e1e);color:inherit;font-size:.84rem;">
                  <input type="search" v-model="compareGenreFilter" @input="onGenreFilterInput" @search="onGenreFilterInput"
                    :placeholder="t('admin.genreEnricher.genreFilterPlaceholder')"
                    :title="t('admin.genreEnricher.genreFilterTitle')"
                    style="flex:1;min-width:140px;max-width:220px;padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg2,#1e1e1e);color:inherit;font-size:.84rem;">
                  <span v-if="compareSearch || compareGenreFilter" style="font-size:.82rem;color:#666;">
                    {{ compareTotal.toLocaleString() }} {{ t('admin.genreEnricher.artists') }}
                  </span>
                </div>

                <!-- Table -->
                <div style="overflow-x:auto;">
                  <table v-if="compareRows.length" style="width:100%;border-collapse:collapse;font-size:.84rem;">
                    <thead>
                      <tr style="border-bottom:1px solid var(--border);">
                        <th style="padding:4px 6px;text-align:left;width:30px;">
                          <input type="checkbox" :checked="selectedArtists.size===compareRows.length && compareRows.length>0" @change="toggleSelectAll" style="cursor:pointer;">
                        </th>
                        <th style="padding:4px 6px;text-align:left;">{{ t('admin.genreEnricher.colArtist') }}</th>
                        <th style="padding:4px 6px;text-align:right;white-space:nowrap;">{{ t('admin.genreEnricher.colFiles') }}</th>
                        <th style="padding:4px 6px;text-align:left;">{{ t('admin.genreEnricher.colCurrentGenre') }}</th>
                        <th style="padding:4px 6px;text-align:left;color:#4caf50;">Last.fm</th>
                        <th style="padding:4px 6px;text-align:left;color:#64b5f6;">MusicBrainz</th>
                        <th style="padding:4px 6px;text-align:left;color:#ffb74d;">Discogs</th>
                        <th style="padding:4px 6px;text-align:left;" :title="t('admin.genreEnricher.colApplyAsHint')">
                          {{ t('admin.genreEnricher.colApplyAs') }} <span style="font-size:.72rem;color:#666;">&#9660;</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="row in compareRows" :key="row.artist"
                          :style="'border-bottom:1px solid rgba(255,255,255,.04);' + (selectedArtists.has(row.artist) ? 'background:rgba(76,175,80,.08);' : '')">
                        <td style="padding:4px 6px;">
                          <input type="checkbox" :checked="selectedArtists.has(row.artist)" @click="toggleSelect(row.artist)" style="cursor:pointer;">
                        </td>
                        <td style="padding:4px 6px;cursor:pointer;" @click="toggleSelect(row.artist)">{{ row.display_name || row.artist }}</td>
                        <td style="padding:4px 6px;text-align:right;color:#666;">{{ row.file_count }}</td>
                        <td style="padding:4px 6px;color:#888;">
                          <input type="text"
                                 :value="row.current_genre || ''"
                                 @change="setCurrentGenre(row, $event.target.value)"
                                 @keydown.enter="$event.target.blur()"
                                 :placeholder="t('admin.genreEnricher.currentGenrePlaceholder')"
                                 :title="t('admin.genreEnricher.currentGenreHint')"
                                 style="width:100%;font-size:.82rem;background:transparent;color:#bbb;border:1px solid transparent;padding:1px 4px;border-radius:3px;"
                                 onfocus="this.style.borderColor='var(--border)';this.style.background='var(--raised2)';"
                                 onblur="this.style.borderColor='transparent';this.style.background='transparent';">
                        </td>
                        <td style="padding:4px 6px;color:#4caf50;"
                            :style="row.lastfm_genre ? 'cursor:pointer;' : ''"
                            @click="row.lastfm_genre && pickSource(row.artist, 'lastfm')"
                            :title="row.lastfm_genre ? t('admin.genreEnricher.stateOk', {source:'Last.fm'}) : row.lf_state === 'nf' ? t('admin.genreEnricher.stateNf', {source:'Last.fm'}) : row.lf_state === 'error' ? t('admin.genreEnricher.stateError', {source:'Last.fm'}) : t('admin.genreEnricher.stateQueued', {source:'Last.fm'})">
                          <span v-if="row.lastfm_genre">{{ row.lastfm_genre }}</span>
                          <span v-else-if="row.lf_state === 'error'" style="color:#e57373;" :title="t('admin.genreEnricher.stateError', {source:'Last.fm'})">⚠ error</span>
                          <span v-else-if="row.lf_state === 'nf'" style="color:#555;">{{ t('admin.genreEnricher.stateNfShort') }}</span>
                          <span v-else style="color:#444;font-style:italic;">{{ t('admin.genreEnricher.stateQueuedShort') }}</span>
                        </td>
                        <td style="padding:4px 6px;color:#64b5f6;"
                            :style="row.mb_genre ? 'cursor:pointer;' : ''"
                            @click="row.mb_genre && pickSource(row.artist, 'mb')"
                            :title="row.mb_genre ? t('admin.genreEnricher.stateOk', {source:'MusicBrainz'}) : row.mb_state === 'nf' ? t('admin.genreEnricher.stateNf', {source:'MusicBrainz'}) : row.mb_state === 'error' ? t('admin.genreEnricher.stateError', {source:'MusicBrainz'}) : t('admin.genreEnricher.stateQueued', {source:'MusicBrainz'})">
                          <span v-if="row.mb_genre">{{ row.mb_genre }}</span>
                          <span v-else-if="row.mb_state === 'error'" style="color:#e57373;">⚠ error</span>
                          <span v-else-if="row.mb_state === 'nf'" style="color:#555;">{{ t('admin.genreEnricher.stateNfShort') }}</span>
                          <span v-else style="color:#444;font-style:italic;">{{ t('admin.genreEnricher.stateQueuedShort') }}</span>
                        </td>
                        <td style="padding:4px 6px;color:#ffb74d;"
                            :style="row.discogs_genre ? 'cursor:pointer;' : ''"
                            @click="row.discogs_genre && pickSource(row.artist, 'discogs')"
                            :title="row.discogs_genre ? t('admin.genreEnricher.stateOk', {source:'Discogs'}) : row.dg_state === 'nf' ? t('admin.genreEnricher.stateNf', {source:'Discogs'}) : row.dg_state === 'error' ? t('admin.genreEnricher.stateError', {source:'Discogs'}) : t('admin.genreEnricher.stateQueued', {source:'Discogs'})">
                          <span v-if="row.discogs_genre">{{ row.discogs_genre }}</span>
                          <span v-else-if="row.dg_state === 'error'" style="color:#e57373;">⚠ error</span>
                          <span v-else-if="row.dg_state === 'nf'" style="color:#555;">{{ t('admin.genreEnricher.stateNfShort') }}</span>
                          <span v-else style="color:#444;font-style:italic;">{{ t('admin.genreEnricher.stateQueuedShort') }}</span>
                        </td>
                        <td style="padding:4px 6px;">
                          <!-- All 3 sources agree on the same genre: one-click apply -->
                          <div v-if="rowConsensus(row) === 'agree'" style="display:flex;align-items:center;gap:5px;">
                            <span style="color:#4caf50;font-size:.77rem;font-weight:600;white-space:nowrap;" :title="t('admin.genreEnricher.consensusAgreeHint')">✓ {{ rowConsensusGenre(row) }}</span>
                            <button class="btn btn-small" @click="quickApply(row)" style="padding:1px 7px;font-size:.72rem;">{{ t('admin.genreEnricher.quickApply') }}</button>
                          </div>
                          <!-- 2/3 sources agree, third has no data yet -->
                          <div v-else-if="rowConsensus(row) === 'majority'" style="display:flex;align-items:center;gap:5px;">
                            <span style="color:#ffb74d;font-size:.77rem;font-weight:600;white-space:nowrap;" :title="t('admin.genreEnricher.consensusMajorityHint')">⅔ {{ rowConsensusGenre(row) }}</span>
                            <button class="btn btn-small" @click="quickApply(row)" style="padding:1px 7px;font-size:.72rem;">{{ t('admin.genreEnricher.quickApply') }}</button>
                          </div>
                          <!-- All 3 sources found nothing: one-click mark as reviewed -->
                          <div v-else-if="rowConsensus(row) === 'empty'" style="display:flex;align-items:center;gap:5px;">
                            <span style="color:#555;font-size:.77rem;white-space:nowrap;" :title="t('admin.genreEnricher.consensusEmptyHint')">{{ t('admin.genreEnricher.consensusEmptyBadge') }}</span>
                            <button class="btn btn-small btn-flat" @click="quickApply(row)" style="padding:1px 7px;font-size:.72rem;">{{ t('admin.genreEnricher.quickDone') }}</button>
                          </div>
                          <!-- Mixed sources: normal picker -->
                          <select v-else :value="pickedSource[row.artist] || 'lastfm'" @change="pickSource(row.artist, $event.target.value)"
                                  :title="t('admin.genreEnricher.applyPickHint')"
                                  style="font-size:.78rem;background:var(--raised2);color:#ddd;border:1px solid var(--border);padding:1px 4px;border-radius:3px;cursor:pointer;">
                            <option value="lastfm" :disabled="!row.lastfm_genre">Last.fm{{ row.lastfm_genre ? ' ✓' : '' }}</option>
                            <option value="mb"     :disabled="!row.mb_genre">MusicBrainz{{ row.mb_genre ? ' ✓' : '' }}</option>
                            <option value="discogs" :disabled="!row.discogs_genre">Discogs{{ row.discogs_genre ? ' ✓' : '' }}</option>
                            <option value="keep">{{ t('admin.genreEnricher.applyKeep') }}</option>
                          </select>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <div v-else-if="comparePending" style="padding:.75rem 0;color:#666;font-size:.85rem;">…</div>
                  <div v-else style="padding:.75rem 0;color:#666;font-size:.85rem;">{{ t('admin.genreEnricher.noResults') }}</div>
                </div>

                <!-- Pagination -->
                <div v-if="compareTotal > compareLimit" style="display:flex;align-items:center;gap:.5rem;margin-top:.6rem;">
                  <button class="btn btn-small btn-flat" @click="prevPage" :disabled="compareOffset===0">&#8592;</button>
                  <span style="font-size:.82rem;color:#888;">{{ comparePage }} / {{ comparePages }}</span>
                  <button class="btn btn-small btn-flat" @click="nextPage" :disabled="compareOffset+compareLimit>=compareTotal">&#8594;</button>
                </div>

                <!-- Apply actions -->
                <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.75rem;padding-top:.75rem;border-top:1px solid var(--border);align-items:center;">
                  <button class="btn btn-small" @click="applySelected" :disabled="!selectedArtists.size"
                          :style="applyConfirm ? 'background:#4caf50;' : ''">
                    {{ applyConfirm ? t('admin.genreEnricher.btnConfirm') : t('admin.genreEnricher.btnApplySelected') }}
                    <span v-if="selectedArtists.size"> ({{ selectedArtists.size }})</span>
                  </button>
                  <div style="display:flex;align-items:center;gap:.4rem;margin-left:auto;font-size:.82rem;color:#888;">
                    <span>{{ t('admin.genreEnricher.applyAllSource') }}:</span>
                    <select v-model="applyAllSource"
                            style="font-size:.82rem;background:var(--raised2);color:#ddd;border:1px solid var(--border);padding:2px 6px;border-radius:3px;">
                      <option value="preferred">{{ t('admin.genreEnricher.sourcePreferred') }}</option>
                      <option value="mb">MusicBrainz</option>
                      <option value="discogs">Discogs</option>
                      <option value="lastfm">Last.fm</option>
                    </select>
                    <button class="btn btn-small btn-flat" @click="applyAllEmpty"
                            :title="t('admin.genreEnricher.btnApplyAllEmptyHint')"
                            :style="applyAllConfirm ? 'color:#4caf50;border-color:#4caf50;' : 'color:#888;'">
                      {{ applyAllConfirm ? t('admin.genreEnricher.btnConfirm') : t('admin.genreEnricher.btnApplyAllEmpty') }}
                    </button>
                  </div>
                </div>
              </div>

            </div>
          </div>
        </div>
      </div>
    </div>
  `,
});

// ── Duplicate Workshop Admin View ──────────────────────────────────────────
const dupWorkshopView = Vue.component('dup-workshop-view', {
  data() {
    return {
      tab: 'songs',
      match: 'exact',
      threshold: 90,
      page: 1,
      pageSize: 25,
      groups: [],
      folderGroups: [],
      total: 0,
      folderTotal: 0,
      status: { state: 'idle', summary: null, lastScan: null },
      deleteEnabled: false,
      queued: {},
      confirmModal: null,
      pending: false,
      loadErr: null,
    };
  },
  computed: {
    scanning()    { return this.status.state === 'scanning'; },
    done()        { return this.status.state === 'done'; },
    queuedCount() { return Object.keys(this.queued).length; },
    totalPages()  { return Math.max(1, Math.ceil(this.total    / this.pageSize)); },
    folderPages() { return Math.max(1, Math.ceil(this.folderTotal / this.pageSize)); },
    tierDesc() {
      if (this.match === 'exact')   return 'Files that are byte-for-byte identical — same file hash. 100% certain duplicates.';
      if (this.match === 'audio')   return 'Same audio content re-tagged or converted to a different format — same audio hash, different file hash.';
      return `Same artist + title with duration difference ≤ ${100 - this.threshold}% of average length (currently within ~${this._secThresh()}s for a 4 min track). Catches different masters, re-edits or format variants.`;
    },
  },
  methods: {
    _secThresh() {
      // for a 4-minute (240s) track, how many seconds is the allowed delta?
      return Math.round(240 * (100 - this.threshold) / 100);
    },
    async _get(path) {
      const r = await API.axios({ method: 'GET', url: `${API.url()}/${path}` });
      return r.data;
    },
    async _post(path, body) {
      const r = await API.axios({ method: 'POST', url: `${API.url()}/${path}`, data: body ?? {} });
      return r.data;
    },
    async onMounted() {
      await this.loadStatus();
    },
    async loadStatus() {
      try {
        const d = await this._get('api/v1/admin/dup-workshop/status');
        this.status = d;
        if (d.threshold) this.threshold = d.threshold;
        if (d.state === 'done') {
          await this.loadSongs();
          await this.loadFolders();
        }
      } catch (e) {
        this.loadErr = e.message ?? 'Failed to load status';
      }
    },
    async loadSongs() {
      this.pending = true;
      try {
        const offset = (this.page - 1) * this.pageSize;
        const d = await this._get(`api/v1/admin/dup-workshop/songs?match=${this.match}&limit=${this.pageSize}&offset=${offset}`);
        this.groups = d.groups ?? [];
        this.total  = d.total  ?? 0;
        this.queued = {};
      } catch { /* silent */ } finally { this.pending = false; }
    },
    async loadFolders() {
      try {
        const offset = (this.page - 1) * this.pageSize;
        const d = await this._get(`api/v1/admin/dup-workshop/folders?limit=${this.pageSize}&offset=${offset}`);
        this.folderGroups = d.groups ?? [];
        this.folderTotal  = d.total  ?? 0;
      } catch { /* silent */ }
    },
    async startScan() {
      if (this.pending || this.scanning) return;
      this.pending = true;
      this.groups = []; this.folderGroups = []; this.total = 0; this.folderTotal = 0;
      this.queued = {}; this.loadErr = null;
      try {
        await this._post('api/v1/admin/dup-workshop/scan', { threshold: this.threshold });
        this.status = { state: 'scanning', summary: null, lastScan: null };
        this._poll();
      } catch (e) {
        iziToast.error({ title: 'Scan failed', message: e.message, position: 'topCenter', timeout: 4000 });
      } finally { this.pending = false; }
    },
    async cancelScan() {
      try { await this._post('api/v1/admin/dup-workshop/cancel'); } catch { /* no-op */ }
    },
    _poll() {
      if (this._pollTimer) clearTimeout(this._pollTimer);
      this._pollTimer = setTimeout(async () => {
        try {
          const d = await this._get('api/v1/admin/dup-workshop/status');
          this.status = d;
          if (d.state === 'scanning') {
            this._poll();
          } else if (d.state === 'done') {
            await this.loadSongs();
            await this.loadFolders();
          }
        } catch { this._poll(); } // retry on network hiccup
      }, 2000);
    },
    async onTabChange(tab) {
      this.tab = tab; this.page = 1;
      if (tab === 'songs') await this.loadSongs();
      else await this.loadFolders();
    },
    async onMatchChange(match) {
      this.match = match; this.page = 1; this.queued = {};
      await this.loadSongs();
    },
    async prevPage() {
      if (this.page <= 1) return;
      this.page--;
      if (this.tab === 'songs') await this.loadSongs(); else await this.loadFolders();
    },
    async nextPage() {
      const max = this.tab === 'songs' ? this.totalPages : this.folderPages;
      if (this.page >= max) return;
      this.page++;
      if (this.tab === 'songs') await this.loadSongs(); else await this.loadFolders();
    },
    toggleQueued(gi, fi) {
      const key = gi + ':' + fi;
      const n = { ...this.queued };
      if (n[key]) delete n[key]; else n[key] = true;
      this.queued = n;
    },
    deselectAll() { this.queued = {}; },
    collectQueuedPaths() {
      const paths = [];
      for (const key of Object.keys(this.queued)) {
        const [gi, fi] = key.split(':').map(Number);
        const g = this.groups[gi];
        if (g?.paths[fi]) paths.push(g.paths[fi]);
      }
      return paths;
    },
    openConfirm() {
      const paths = this.collectQueuedPaths();
      if (!paths.length) return;
      this.confirmModal = { paths };
    },
    async confirmDelete() {
      const paths = this.confirmModal.paths;
      this.confirmModal = null;
      this.pending = true;
      try {
        const r = await this._post('api/v1/admin/dup-workshop/delete', { filepaths: paths });
        const deleted = r.deleted?.length ?? 0;
        const failed  = r.failed?.length  ?? 0;
        if (deleted) iziToast.success({ title: `${deleted} file(s) deleted`, position: 'topCenter', timeout: 3000 });
        if (failed)  iziToast.error({ title: `${failed} file(s) could not be deleted`, position: 'topCenter', timeout: 4000 });
        if (deleted) {
          await this.loadSongs();
          await this.loadStatus();
        }
      } catch (e) {
        iziToast.error({ title: 'Delete failed', message: e.message, position: 'topCenter', timeout: 4000 });
      } finally { this.pending = false; }
    },
    fmtDur(s) {
      if (!s) return '—';
      return Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
    },
    shortPath(p) {
      const parts = p.split('/');
      return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p;
    },
    songTabs() {
      return [
        { v: 'exact',   l: this.t('admin.dupWorkshop.matchExact') },
        { v: 'audio',   l: this.t('admin.dupWorkshop.matchAudio') },
        { v: 'similar', l: this.t('admin.dupWorkshop.matchSimilar') },
      ];
    },
  },
  template: `
    <div style="padding:1.5rem;max-width:920px;">
      <h4 style="margin:0 0 .25rem;">{{ this.t('admin.dupWorkshop.title') }}</h4>
      <p style="color:var(--t2);margin:0 0 1.25rem;font-size:.875rem;">{{ this.t('admin.dupWorkshop.desc') }}</p>

      <!-- Scan controls -->
      <div style="display:flex;align-items:flex-start;gap:.75rem;flex-wrap:wrap;margin-bottom:1.25rem;">
        <button class="btn btn-primary" :disabled="pending||scanning" @click="startScan">
          {{ done ? this.t('admin.dupWorkshop.btnRescan') : this.t('admin.dupWorkshop.btnScan') }}
        </button>
        <button class="btn btn-secondary" v-if="scanning" @click="cancelScan">
          {{ this.t('admin.dupWorkshop.btnCancel') }}
        </button>
        <span v-if="scanning" style="color:var(--t2);font-size:.875rem;line-height:2.2;">⏳ {{ this.t('admin.dupWorkshop.scanning') }}</span>
        <span v-if="loadErr" style="color:var(--red);font-size:.875rem;line-height:2.2;">⚠ {{ loadErr }}</span>
      </div>

      <!-- Status summary after scan -->
      <div v-if="done && status.summary" style="background:var(--card2);border-radius:8px;padding:.75rem 1rem;margin-bottom:1.25rem;font-size:.875rem;display:flex;gap:1.5rem;flex-wrap:wrap;">
        <span><strong>{{ status.summary.groups }}</strong> duplicate groups found</span>
        <span style="color:var(--t2);">{{ status.summary.files }} removable files</span>
        <span style="color:var(--t2);">Last scan: {{ status.lastScan ? new Date(status.lastScan).toLocaleString() : '—' }}</span>
      </div>

      <!-- Pre-scan idle notice -->
      <div v-if="status.state==='idle'" style="color:var(--t2);font-size:.875rem;margin-bottom:1rem;">
        {{ this.t('admin.dupWorkshop.idle') }}
      </div>

      <!-- Delete toggle — only show after scan -->
      <div v-if="done" style="margin-bottom:1rem;display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;">
        <button :class="deleteEnabled ? 'btn btn-danger' : 'btn btn-secondary'" @click="deleteEnabled=!deleteEnabled" style="font-size:.8125rem;">
          {{ deleteEnabled ? '🔓 ' + this.t('admin.dupWorkshop.deleteEnabled') : '🔒 ' + this.t('admin.dupWorkshop.deleteDisabled') }}
        </button>
        <span v-if="deleteEnabled" style="font-size:.8125rem;color:var(--orange);font-weight:600;">⚠ {{ this.t('admin.dupWorkshop.deleteWarning') }}</span>
      </div>

      <!-- Tabs -->
      <div v-if="done" style="display:flex;gap:.25rem;border-bottom:1px solid var(--border);margin-bottom:1.25rem;">
        <button :class="tab==='songs'   ? 'tab-btn tab-active' : 'tab-btn'" @click="onTabChange('songs')">
          {{ this.t('admin.dupWorkshop.tabSongs') }} ({{ total }})
        </button>
        <button :class="tab==='folders' ? 'tab-btn tab-active' : 'tab-btn'" @click="onTabChange('folders')">
          {{ this.t('admin.dupWorkshop.tabFolders') }} ({{ folderTotal }})
        </button>
      </div>

      <!-- ── Songs tab ───────────────────────────────────────────────────── -->
      <div v-if="done && tab==='songs'">

        <!-- Tier selector -->
        <div style="display:flex;gap:.5rem;margin-bottom:.5rem;flex-wrap:wrap;">
          <button v-for="m in songTabs()" :key="m.v"
            :class="match===m.v ? 'chip chip-active' : 'chip'"
            @click="onMatchChange(m.v)">{{ m.l }}</button>
        </div>

        <!-- Tier description -->
        <div style="font-size:.8125rem;color:var(--t2);margin-bottom:.875rem;padding:.5rem .75rem;background:var(--card2);border-radius:6px;line-height:1.5;">
          {{ tierDesc }}
          <template v-if="match==='similar'">
            <br>
            <label style="display:inline-flex;align-items:center;gap:.5rem;margin-top:.4rem;color:var(--t1);">
              {{ this.t('admin.dupWorkshop.thresholdLabel') }}: <strong>{{ threshold }}%</strong>
              <input type="range" min="50" max="100" step="1" v-model.number="threshold" style="width:100px;" @change="onMatchChange('similar')">
              <span style="color:var(--t2);font-size:.75rem;">(max duration gap: {{ _secThresh() }}s per 4-min track)</span>
            </label>
          </template>
        </div>

        <!-- Bulk action bar -->
        <div v-if="queuedCount>0" style="display:flex;align-items:center;gap:.75rem;margin-bottom:.75rem;padding:.5rem .75rem;background:var(--card2);border-radius:6px;">
          <span style="font-size:.875rem;">{{ queuedCount }} file(s) queued for deletion</span>
          <button v-if="deleteEnabled" class="btn btn-danger btn-sm" @click="openConfirm" :disabled="pending">
            {{ this.t('admin.dupWorkshop.btnDeleteQueued', { n: queuedCount }) }}
          </button>
          <button class="btn btn-secondary btn-sm" @click="deselectAll">{{ this.t('admin.dupWorkshop.btnDeselect') }}</button>
          <span v-if="!deleteEnabled" style="font-size:.8rem;color:var(--t2);">Enable deletions above first</span>
        </div>

        <!-- Empty -->
        <div v-if="!groups.length && !pending" style="color:var(--t2);font-size:.875rem;padding:1rem 0;">
          {{ this.t('admin.dupWorkshop.noResults') }}
        </div>

        <!-- Loading -->
        <div v-if="pending" style="color:var(--t2);font-size:.875rem;">Loading…</div>

        <!-- Group list -->
        <div v-for="(g, gi) in groups" :key="gi"
          style="margin-bottom:.625rem;border:1px solid var(--border);border-radius:8px;overflow:hidden;">
          <!-- Header -->
          <div style="padding:.55rem .875rem;background:var(--card2);display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;">
            <div style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
              <span style="font-weight:600;font-size:.9rem;">{{ g.artist || '—' }}</span>
              <span style="color:var(--t2);font-size:.875rem;"> — {{ g.title || '—' }}</span>
              <span v-if="g.album" style="color:var(--t2);font-size:.8rem;margin-left:.4rem;">({{ g.album }})</span>
            </div>
            <span style="font-size:.8rem;font-weight:600;" :style="g.similarity===100?'color:var(--red)':g.similarity>=95?'color:var(--orange)':'color:var(--t2)'">
              {{ g.similarity }}%
            </span>
            <span style="font-size:.8rem;color:var(--t2);">{{ fmtDur(g.duration) }}</span>
            <span style="font-size:.8rem;color:var(--t2);">{{ g.paths.length }} copies</span>
          </div>
          <!-- Files -->
          <div v-for="(fp, fi) in g.paths" :key="fi"
            style="padding:.4rem .875rem;display:flex;align-items:center;gap:.75rem;border-top:1px solid var(--border);font-size:.8125rem;">
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--t2);" :data-tip="fp">
              {{ shortPath(fp) }}
            </span>
            <span style="color:var(--t2);min-width:38px;text-align:right;font-size:.75rem;">{{ (g.formats[fi]||'').toUpperCase() }}</span>
            <template v-if="deleteEnabled">
              <!-- First file = suggest keeping; others can be queued -->
              <span v-if="fi===0" style="font-size:.75rem;color:var(--t2);min-width:52px;text-align:center;">{{ this.t('admin.dupWorkshop.keepLabel') }}</span>
              <button v-else
                :class="queued[gi+':'+fi] ? 'btn-micro btn-delete-queued' : 'btn-micro btn-delete'"
                @click="toggleQueued(gi, fi)"
                style="min-width:52px;">
                {{ queued[gi+':'+fi] ? '✓ queued' : this.t('admin.dupWorkshop.deleteLabel') }}
              </button>
            </template>
          </div>
        </div>

        <!-- Pagination -->
        <div v-if="totalPages>1" style="display:flex;align-items:center;gap:.5rem;margin-top:.75rem;font-size:.875rem;">
          <button class="btn btn-secondary btn-sm" @click="prevPage" :disabled="page<=1||pending">‹</button>
          <span style="color:var(--t2);">{{ page }} / {{ totalPages }}</span>
          <button class="btn btn-secondary btn-sm" @click="nextPage" :disabled="page>=totalPages||pending">›</button>
        </div>
      </div>

      <!-- ── Folders tab ─────────────────────────────────────────────────── -->
      <div v-if="done && tab==='folders'">
        <div style="font-size:.8125rem;color:var(--t2);margin-bottom:.875rem;padding:.5rem .75rem;background:var(--card2);border-radius:6px;line-height:1.5;">
          Folders where <strong>every track has 100% identical audio content</strong> (matched by audio fingerprint / file hash) — even if the folder names, artist tags or album tags are completely different. Use this to find duplicate album rips stored in different locations.
        </div>

        <div v-if="!folderGroups.length" style="color:var(--t2);font-size:.875rem;padding:1rem 0;">
          {{ this.t('admin.dupWorkshop.noResults') }}
        </div>

        <div v-for="(g, gi) in folderGroups" :key="gi"
          style="margin-bottom:.625rem;border:1px solid var(--border);border-radius:8px;overflow:hidden;">
          <div style="padding:.55rem .875rem;background:var(--card2);display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;">
            <div style="flex:1;min-width:0;">
              <span style="font-weight:600;font-size:.9rem;">{{ g.copies[0].artist || '(no artist tag)' }}</span>
              <span v-if="g.copies[0].album" style="color:var(--t2);font-size:.875rem;"> — {{ g.copies[0].album }}</span>
            </div>
            <span style="font-size:.8rem;color:var(--t2);">{{ g.trackCount }} tracks</span>
            <span style="font-size:.8rem;font-weight:600;color:var(--orange);">{{ this.t('admin.dupWorkshop.folderCopies', { n: g.copies.length }) }}</span>
          </div>
          <div v-for="(c, ci) in g.copies" :key="ci"
            style="padding:.4rem .875rem;display:flex;align-items:center;gap:.75rem;border-top:1px solid var(--border);font-size:.8125rem;">
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--t2);" :data-tip="c.dir">
              {{ shortPath(c.dir) }}
            </span>
          </div>
        </div>

        <div v-if="folderPages>1" style="display:flex;align-items:center;gap:.5rem;margin-top:.75rem;font-size:.875rem;">
          <button class="btn btn-secondary btn-sm" @click="prevPage" :disabled="page<=1">‹</button>
          <span style="color:var(--t2);">{{ page }} / {{ folderPages }}</span>
          <button class="btn btn-secondary btn-sm" @click="nextPage" :disabled="page>=folderPages">›</button>
        </div>
      </div>

      <!-- Confirm modal -->
      <div v-if="confirmModal"
        style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9000;display:flex;align-items:center;justify-content:center;"
        @click.self="confirmModal=null">
        <div style="background:var(--card);border-radius:12px;padding:1.5rem;max-width:480px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.4);">
          <h5 style="margin:0 0 .75rem;">{{ this.t('admin.dupWorkshop.confirmTitle') }}</h5>
          <p style="margin:0 0 .875rem;font-size:.875rem;color:var(--t2);">
            {{ this.t('admin.dupWorkshop.confirmMsg', { n: confirmModal.paths.length }) }}
          </p>
          <div style="max-height:160px;overflow-y:auto;margin-bottom:1rem;font-size:.8rem;color:var(--t2);">
            <div v-for="p in confirmModal.paths" :key="p" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">{{ p }}</div>
          </div>
          <div style="display:flex;gap:.75rem;justify-content:flex-end;">
            <button class="btn btn-secondary" @click="confirmModal=null">{{ this.t('admin.dupWorkshop.btnCancel') }}</button>
            <button class="btn btn-danger" @click="confirmDelete" :disabled="pending">{{ this.t('admin.dupWorkshop.deleteLabel') }}</button>
          </div>
        </div>
      </div>
    </div>
  `,
  mounted() { this.onMounted(); },
  beforeDestroy() { if (this._pollTimer) clearTimeout(this._pollTimer); },
});

// ── Genre Groups Admin View ────────────────────────────────────────────────
const genreGroupsView = Vue.component('genre-groups-view', {
  data() {
    return {
      groups: [],        // [{name, genres:[str], collapsed:false}, ...]
      allGenres: [],     // all genre strings from library
      isDefault: false,  // true = showing auto-defaults (nothing saved yet)
      pending: false,
      dragSrc: null,     // {groupIdx, genreIdx} — groupIdx=-2 means search results
      dropTargetIdx: null,
      newGroupName: '',
      renamingIdx: null,
      renamingVal: '',
      searchQuery: '',
    };
  },
  computed: {
    otherGroupIdx() {
      return this.groups.findIndex(g => g.name.toLowerCase() === 'other');
    },
    searchResults() {
      const raw = this.searchQuery.trim();
      if (!raw) return [];
      // Parse tokens: -word = exclude, +word or bare word = must include
      const must = [], exclude = [];
      for (const token of raw.toLowerCase().split(/\s+/)) {
        if (!token) continue;
        if (token.startsWith('-') && token.length > 1) exclude.push(token.slice(1));
        else if (token.startsWith('+') && token.length > 1) must.push(token.slice(1));
        else must.push(token);
      }
      if (!must.length && !exclude.length) return [];
      // Build full genre universe
      const allGenreSet = new Set(this.allGenres);
      for (const grp of this.groups) for (const g of grp.genres) allGenreSet.add(g);
      return [...allGenreSet].filter(g => {
        const gl = g.toLowerCase();
        return must.every(t => gl.includes(t)) && !exclude.some(t => gl.includes(t));
      }).sort((a, b) => a.localeCompare(b));
    },
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card">
            <div class="card-content">
              <span class="card-title">{{ t('admin.genreGroups.title') }}</span>
              <p style="margin-bottom:.5rem;">{{ t('admin.genreGroups.desc') }}<br><small style="color:var(--t2)">{{ t('admin.genreGroups.hint') }} {{ t('admin.genreGroups.dropHintNoDelete') }}</small></p>
              <div v-if="isDefault" style="background:var(--raised);border-left:3px solid var(--accent,#6366f1);padding:10px 14px;border-radius:4px;margin-top:10px;font-size:.875rem;color:var(--t2);">{{ t('admin.genreGroups.autoDetectedNotice') }}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="gg-layout">
        <!-- LEFT: group names as drop targets -->
        <div class="gg-left">
          <div v-for="(grp, gi) in groups" :key="gi"
               class="gg-left-item"
               :class="{'gg-left-active': dropTargetIdx === gi}"
               @dragover.prevent="dropTargetIdx = gi"
               @dragleave="onDragleave($event, gi)"
               @drop.prevent="onDropToGroup(gi)">
            <span class="gg-chevron-sm" @click="toggleCollapse(gi)" :title="grp.collapsed ? t('admin.genreGroups.expand') : t('admin.genreGroups.collapse')">{{grp.collapsed ? '▶' : '▼'}}</span>
            <span v-if="renamingIdx !== gi" class="gg-left-name" @dblclick="startRename(gi)" :title="t('admin.genreGroups.doubleClickRename')">{{grp.name}}</span>
            <input v-else v-model="renamingVal" class="gg-rename-inp gg-left-rename" @blur="commitRename(gi)" @keydown.enter="commitRename(gi)" @keydown.esc="renamingIdx=null" ref="renameInput">
            <span class="gg-left-cnt">{{grp.genres.length}}</span>
            <button v-if="grp.genres.length === 0" class="gg-del-btn" @click.stop="deleteGroup(gi)" :title="t('admin.genreGroups.deleteEmptyGroup')">&#x2715;</button>
          </div>
          <div class="gg-add-row">
            <input v-model="newGroupName" type="text" :placeholder="t('admin.genreGroups.newGroupPlaceholder')" class="gg-add-inp" @keydown.enter="addGroup">
            <button class="btn btn-small" @click="addGroup" :disabled="!newGroupName.trim()">+</button>
          </div>
        </div>

        <!-- RIGHT: search + collapsible genre sections -->
        <div class="gg-right">
          <!-- Search bar -->
          <div class="gg-search-row">
            <span class="gg-search-icon">&#128269;</span>
            <input v-model="searchQuery" type="text" :placeholder="t('admin.genreGroups.searchPlaceholder')" class="gg-search-inp" @keydown.esc="searchQuery=''">
            <button v-if="searchQuery" class="gg-search-clear" @click="searchQuery=''" :title="t('admin.common.delete')">&#x2715;</button>
          </div>

          <!-- Search results panel -->
          <div v-if="searchQuery.trim()" class="gg-search-panel">
            <div class="gg-search-panel-head">{{ t('admin.genreGroups.resultsFor') }} <b>"{{searchQuery.trim()}}"</b> <span style="color:var(--t3);font-weight:400;">{{ t('admin.genreGroups.syntaxHint') }}</span></div>
            <div class="gg-chips" style="padding:10px 14px;">
              <span v-if="searchResults.length === 0" class="gg-empty-hint">{{ t('admin.genreGroups.noGenresMatch') }}</span>
              <span v-for="(g, si) in searchResults" :key="g"
                    class="gg-chip gg-chip-search"
                    :class="{dragging: dragSrc && dragSrc.groupIdx===-2 && dragSrc.genreIdx===si}"
                    draggable="true"
                    @dragstart="onDragStartSearch(si)"
                    @dragend="dragSrc=null">
                {{g}}
                <span class="gg-chip-group-hint">{{groupOf(g)}}</span>
              </span>
            </div>
          </div>
          <div v-for="(grp, gi) in groups" :key="gi" class="gg-group">
            <div class="gg-group-head"
                 :class="{'gg-drop-over': dropTargetIdx === gi}"
                 @dragover.prevent="dropTargetIdx = gi"
                 @dragleave="onDragleave($event, gi)"
                 @drop.prevent="onDropToGroup(gi)">
              <span class="gg-chevron" @click="toggleCollapse(gi)" style="cursor:pointer;margin-right:6px;">{{grp.collapsed ? '▶' : '▼'}}</span>
              <span v-if="renamingIdx !== gi" style="flex:1;cursor:text;font-weight:700;" @dblclick="startRename(gi)">{{grp.name}}</span>
              <input v-else v-model="renamingVal" class="gg-rename-inp" style="flex:1;" @blur="commitRename(gi)" @keydown.enter="commitRename(gi)" @keydown.esc="renamingIdx=null">
              <small style="color:var(--t2);">{{grp.genres.length}}</small>
            </div>
            <div v-show="!grp.collapsed" class="gg-chips"
                 :class="{'gg-drop-over': dropTargetIdx === gi}"
                 @dragover.prevent="dropTargetIdx = gi"
                 @dragleave="onDragleave($event, gi)"
                 @drop.prevent="onDropToGroup(gi)">
              <span v-for="(g, gei) in grp.genres" :key="g"
                    class="gg-chip"
                    :class="{dragging: dragSrc && dragSrc.groupIdx===gi && dragSrc.genreIdx===gei}"
                    draggable="true"
                    @dragstart="onDragStart(gi, gei)"
                    @dragend="dragSrc=null">
                {{g}}<span v-if="gi !== otherGroupIdx && otherGroupIdx !== -1" class="gg-chip-remove" @click.stop="moveToOther(gi, gei)" :title="t('admin.genreGroups.moveToOther')">↓</span>
              </span>
              <span v-if="grp.genres.length === 0" class="gg-empty-hint">{{ t('admin.genreGroups.dropHere') }}</span>
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;">
            <button class="btn-flat" @click="resetToDefault">{{ t('admin.genreGroups.btnResetToAuto') }}</button>
            <button class="btn" @click="save" :disabled="pending">{{ pending ? t('admin.genreGroups.btnSaving') : t('admin.genreGroups.btnSave') }}</button>
          </div>
        </div>
      </div>
    </div>`,
  async mounted() {
    await this.load();
  },
  watch: {
    renamingIdx(v) {
      if (v !== null) this.$nextTick(() => { const el = this.$refs.renameInput; if (el) { const arr = Array.isArray(el) ? el[0] : el; arr?.focus?.(); } });
    }
  },
  methods: {
    async load() {
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/genre-groups` });
        this.allGenres = res.data.allGenres || [];
        this.isDefault = !!res.data.isDefault;
        this.groups = (res.data.groups || []).map(g => ({ name: g.name, genres: [...g.genres], collapsed: false }));
        // If nothing is in the DB yet, seed it now so it persists immediately
        if (this.isDefault) await this._autoSave();
      } catch { iziToast.error({ title: this.t('admin.genreGroups.toastFailedLoad'), position: 'topCenter', timeout: 3000 }); }
    },
    toggleCollapse(gi) {
      this.groups[gi].collapsed = !this.groups[gi].collapsed;
      // collapse state is UI-only, no need to persist
    },
    async addGroup() {
      const name = this.newGroupName.trim();
      if (!name) return;
      this.groups.push({ name, genres: [], collapsed: false });
      this.newGroupName = '';
      await this._autoSave();
    },
    async deleteGroup(gi) {
      if (this.groups[gi].genres.length > 0) return;
      this.groups.splice(gi, 1);
      await this._autoSave();
    },
    async moveToOther(gi, gei) {
      const [g] = this.groups[gi].genres.splice(gei, 1);
      const oi = this.otherGroupIdx;
      if (oi === -1) {
        this.groups.push({ name: 'Other', genres: [g], collapsed: false });
      } else {
        this.groups[oi].genres.push(g);
      }
      await this._autoSave();
    },
    startRename(gi) { this.renamingIdx = gi; this.renamingVal = this.groups[gi].name; },
    async commitRename(gi) {
      if (this.renamingVal.trim()) this.groups[gi].name = this.renamingVal.trim();
      this.renamingIdx = null;
      await this._autoSave();
    },
    // ── Drag-and-drop ────────────────────────────────────────────
    onDragStart(groupIdx, genreIdx) { this.dragSrc = { groupIdx, genreIdx }; this.dropTargetIdx = null; },
    onDragStartSearch(si) { this.dragSrc = { groupIdx: -2, genreIdx: si }; this.dropTargetIdx = null; },
    groupOf(genre) {
      const grp = this.groups.find(g => g.genres.includes(genre));
      return grp ? grp.name : this.t('admin.genreGroups.unassigned');
    },
    onDragleave(e, gi) {
      if (!e.currentTarget.contains(e.relatedTarget)) {
        if (this.dropTargetIdx === gi) this.dropTargetIdx = null;
      }
    },
    async onDropToGroup(destGi) {
      const src = this.dragSrc;
      this.dragSrc = null;
      this.dropTargetIdx = null;
      if (!src) return;
      let genre;
      if (src.groupIdx === -2) {
        // Drag from search results — find genre by value and remove from its current group
        genre = this.searchResults[src.genreIdx];
        if (!genre) return;
        for (const grp of this.groups) {
          const idx = grp.genres.indexOf(genre);
          if (idx !== -1) { grp.genres.splice(idx, 1); break; }
        }
      } else {
        if (src.groupIdx === destGi) return;
        genre = this.groups[src.groupIdx].genres.splice(src.genreIdx, 1)[0];
      }
      if (!genre) return;
      this.groups[destGi].genres.push(genre);
      await this._autoSave();
    },
    // ── Auto-save (silent, called after every mutation) ──────────
    async _autoSave() {
      try {
        const payload = this.groups.map(g => ({ name: g.name, genres: g.genres }));
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/genre-groups`, data: payload });
        this.isDefault = false;
      } catch { iziToast.error({ title: this.t('admin.genreGroups.toastAutoSaveFailed'), position: 'topCenter', timeout: 3000 }); }
    },
    resetToDefault() {
      adminConfirm(this.t('admin.genreGroups.confirmResetTitle'), this.t('admin.genreGroups.confirmResetMsg'), this.t('admin.genreGroups.confirmResetLabel'), async () => {
        try {
          await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/genre-groups`, data: [] });
          await this.load();
          iziToast.success({ title: this.t('admin.genreGroups.toastReset'), position: 'topCenter', timeout: 2500 });
        } catch { iziToast.error({ title: this.t('admin.genreGroups.toastResetFailed'), position: 'topCenter', timeout: 3000 }); }
      });
    },
    async save() {
      this.pending = true;
      try {
        // Save all groups (including empty ones) so renamed group names are preserved
        const payload = this.groups.map(g => ({ name: g.name, genres: g.genres }));
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/genre-groups`, data: payload });
        this.isDefault = false;
        iziToast.success({ title: this.t('admin.genreGroups.toastSaved'), position: 'topCenter', timeout: 2500 });
      } catch { iziToast.error({ title: this.t('admin.genreGroups.toastSaveFailed'), position: 'topCenter', timeout: 3000 }); }
      finally { this.pending = false; }
    }
  }
});

const artistsAdminView = Vue.component('artists-admin-view', {
  data() {
    return {
      loading: false,
      kind: 'missing',
      counts: { missing: 0, noImage: 0, wrong: 0, withImage: 0 },
      sessionStartMissing: null,
      artists: [],
      selected: null,
      candidateLoading: false,
      candidates: [],
      tadbCandidates: [],
      tadbLoading: false,
      searchQuery: '',
      searchResults: [],
      searchLoading: false,
      customImageUrl: '',
      customImagePreviewError: false,
      applying: false,
      hydration: {
        running: false,
        queueLength: 0,
        queueLimit: 0,
        stats: { startedAt: 0, enqueued: 0, dropped: 0, processed: 0, succeeded: 0, noImage: 0, failed: 0 },
        delayMs: { ok: 0, noImage: 0, error: 0 },
        discogs: { enabled: false, hasApiCredentials: false },
      },
      seedPending: false,
      seedTadbPending: false,
      seedTotal: 0,
      pollTimer: null,
      placeholderHasCustom: false,
      placeholderPreviewKey: Date.now(),
      placeholderUploading: false,
    };
  },
  mounted() {
    this.load('missing');
    this.startPolling();
    this.checkPlaceholder();
  },
  beforeDestroy() {
    this.stopPolling();
  },
  computed: {
    discogsReady() {
      return !!(this.hydration.discogs?.enabled && this.hydration.discogs?.hasApiCredentials);
    },
    hydratedThisSession() {
      if (!Number.isFinite(this.sessionStartMissing)) return null;
      return Math.max(0, this.sessionStartMissing - (this.counts.missing || 0));
    },
    customImagePreviewUrl() {
      const url = String(this.customImageUrl || '').trim();
      if (!/^https?:\/\//i.test(url)) return '';
      return url;
    },
  },
  methods: {
    startPolling() {
      this.stopPolling();
      this.pollTimer = setInterval(() => {
        this.loadHydrationStatus();
      }, 5000);
      this.loadHydrationStatus();
    },
    stopPolling() {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    },
    async loadHydrationStatus() {
      try {
        const res = await API.axios({
          method: 'GET',
          url: `${API.url()}/api/v1/admin/artists/hydration-status`
        });
        this.hydration = res.data || this.hydration;
        if (!this.hydration.queueLength) this.seedTotal = 0;
        const c = res.data?.counts || null;
        if (c) {
          this.counts = c;
          if (!Number.isFinite(this.sessionStartMissing)) this.sessionStartMissing = c.missing || 0;
        }
      } catch {
        // Non-fatal polling failure; keep existing status UI.
      }
    },
    async load(kind = this.kind) {
      this.loading = true;
      this.kind = kind;
      this.selected = null;
      this.candidates = [];
      try {
        const res = await API.axios({
          method: 'GET',
          url: `${API.url()}/api/v1/admin/artists/image-audit`,
          params: { kind, limit: 300 }
        });
        this.counts = res.data.counts || { missing: 0, noImage: 0, wrong: 0, withImage: 0 };
        if (!Number.isFinite(this.sessionStartMissing)) this.sessionStartMissing = this.counts.missing || 0;
        this.artists = res.data.artists || [];
      } catch (e) {
        iziToast.error({ title: this.t('admin.artists.toastFailedLoad'), message: e.message || '', position: 'topCenter', timeout: 3000 });
      } finally {
        this.loading = false;
      }
    },
    async seedHydration(limit = 500) {
      if (this.seedPending) return;
      this.seedPending = true;
      try {
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/artists/hydration-seed`,
          data: { limit }
        });
        this.hydration = res.data || this.hydration;
        this.counts = res.data?.counts || this.counts;
        if (res.data?.enqueued) this.seedTotal = res.data.enqueued;
        iziToast.success({ title: this.t('admin.artists.toastQueued', { count: res.data?.enqueued || 0 }), position: 'topCenter', timeout: 1800 });
      } catch (e) {
        iziToast.error({ title: this.t('admin.artists.toastFailedQueue'), message: e.message || '', position: 'topCenter', timeout: 2500 });
      } finally {
        this.seedPending = false;
      }
    },
    async seedTadbRetry(limit = 500) {
      if (this.seedTadbPending) return;
      this.seedTadbPending = true;
      try {
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/artists/hydrate-tadb-noimage`,
          data: { limit }
        });
        this.hydration = res.data || this.hydration;
        this.counts = res.data?.counts || this.counts;
        if (res.data?.enqueued) this.seedTotal = res.data.enqueued;
        iziToast.success({ title: this.t('admin.artists.toastTadbQueued', { count: res.data?.enqueued || 0 }), position: 'topCenter', timeout: 1800 });
      } catch (e) {
        iziToast.error({ title: this.t('admin.artists.toastFailedQueue'), message: e.message || '', position: 'topCenter', timeout: 2500 });
      } finally {
        this.seedTadbPending = false;
      }
    },
    async selectArtist(row) {
      this.selected = row;
      this.candidates = [];
      this.tadbCandidates = [];
      this.customImageUrl = '';
      this.customImagePreviewError = false;
      // Load Discogs + TheAudioDB candidates in parallel
      this.candidateLoading = true;
      this.tadbLoading = true;
      const discogsP = this.discogsReady
        ? API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/artists/discogs-candidates`, params: { artistKey: row.artistKey } })
            .then(res => { this.candidates = res.data.candidates || []; })
            .catch(e => { iziToast.error({ title: this.t('admin.artists.toastFailedCandidates'), message: e.message || '', position: 'topCenter', timeout: 3000 }); })
            .finally(() => { this.candidateLoading = false; })
        : Promise.resolve().then(() => { this.candidateLoading = false; });
      const tadbP = API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/artists/tadb-candidates`, params: { artistKey: row.artistKey } })
        .then(res => { this.tadbCandidates = res.data.candidates || []; })
        .catch(() => {})
        .finally(() => { this.tadbLoading = false; });
      await Promise.all([discogsP, tadbP]);
    },
    async searchArtists() {
      const q = (this.searchQuery || '').trim();
      if (q.length < 2) { this.searchResults = []; return; }
      this.searchLoading = true;
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/artists/search`, params: { q } });
        this.searchResults = res.data.artists || [];
      } catch {
        this.searchResults = [];
      } finally {
        this.searchLoading = false;
      }
    },
    async applyImage(url, source = 'discogs') {
      if (!this.selected || !url || this.applying) return;
      this.applying = true;
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/artists/apply-image`,
          data: { artistKey: this.selected.artistKey, imageUrl: url, source }
        });
        iziToast.success({ title: this.t('admin.artists.toastImageUpdated'), position: 'topCenter', timeout: 1800 });
        await this.load(this.kind);
      } catch (e) {
        iziToast.error({ title: this.t('admin.artists.toastFailedSetImage'), message: e.message || '', position: 'topCenter', timeout: 3000 });
      } finally {
        this.applying = false;
      }
    },
    onCustomPreviewLoad() {
      this.customImagePreviewError = false;
    },
    onCustomPreviewError() {
      this.customImagePreviewError = true;
    },
    async setWrong(row, wrong) {
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/artists/mark-image-wrong`,
          data: { artistKey: row.artistKey, wrong: !!wrong }
        });
        iziToast.success({
          title: wrong ? this.t('admin.artists.toastMarkedWrong') : this.t('admin.artists.toastMarkedOk'),
          position: 'topCenter',
          timeout: 1500
        });
        await this.load(this.kind);
      } catch (e) {
        iziToast.error({ title: this.t('admin.artists.toastFailedUpdateStatus'), message: e.message || '', position: 'topCenter', timeout: 2500 });
      }
    },
    imgSrc(imageFile) {
      return `${API.url()}/api/v1/artists/images/${encodeURIComponent(imageFile)}`;
    },
    async checkPlaceholder() {
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/artists/placeholder-info` });
        this.placeholderHasCustom = !!(res.data?.hasCustom);
      } catch {
        this.placeholderHasCustom = false;
      }
    },
    placeholderSrc() {
      return `${API.url()}/api/v1/artists/placeholder?t=${this.placeholderPreviewKey}`;
    },
    async uploadPlaceholder(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      this.placeholderUploading = true;
      try {
        const formData = new FormData();
        formData.append('image', file);
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/artists/placeholder`, data: formData });
        this.placeholderHasCustom = true;
        this.placeholderPreviewKey = Date.now();
        iziToast.success({ title: this.t('admin.artists.placeholderUploaded'), position: 'topCenter', timeout: 2000 });
      } catch (e) {
        iziToast.error({ title: this.t('admin.artists.placeholderUploadFailed'), message: e.message || '', position: 'topCenter', timeout: 3000 });
      } finally {
        this.placeholderUploading = false;
        event.target.value = '';
      }
    },
    async resetPlaceholder() {
      try {
        await API.axios({ method: 'DELETE', url: `${API.url()}/api/v1/admin/artists/placeholder` });
        this.placeholderHasCustom = false;
        this.placeholderPreviewKey = Date.now();
        iziToast.success({ title: this.t('admin.artists.placeholderReset'), position: 'topCenter', timeout: 2000 });
      } catch (e) {
        iziToast.error({ title: e.message || 'Failed', position: 'topCenter', timeout: 3000 });
      }
    },
  },
  template: `
  <div>
    <div class="card z-depth-1" style="padding:18px 20px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
        <div>
          <span class="card-title">{{ t('admin.artists.title') }}</span>
          <div style="font-size:.9rem;color:var(--t2);margin-top:2px;">{{ t('admin.artists.desc') }}</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn-flat" @click="load('missing')" :style="kind==='missing' ? 'border-color:var(--primary);color:var(--primary);' : ''">{{ t('admin.artists.tabPending', { count: counts.missing || 0 }) }}</button>
          <button class="btn-flat" @click="load('no-image')" :style="kind==='no-image' ? 'border-color:var(--warn,#b45309);color:var(--warn,#b45309);' : ''">{{ t('admin.artists.tabNoImage', { count: counts.noImage || 0 }) }}</button>
          <button class="btn-flat" @click="load('with-image')" :style="kind==='with-image' ? 'border-color:var(--ok,#16a34a);color:var(--ok,#16a34a);' : ''">{{ t('admin.artists.tabWithImage', { count: counts.withImage || 0 }) }}</button>
          <button class="btn-flat" @click="load('wrong')" :style="kind==='wrong' ? 'border-color:var(--warn,#b45309);color:var(--warn,#b45309);' : ''">{{ t('admin.artists.tabWrong', { count: counts.wrong || 0 }) }}</button>
          <button class="btn-flat" @click="seedHydration(500)" :disabled="seedPending">{{ seedPending ? t('admin.artists.btnQueueing') : t('admin.artists.btnQueueNext') }}</button>
          <button class="btn-flat" @click="seedHydration(counts.missing || 9999)" :disabled="seedPending || !(counts.missing > 0)">{{ t('admin.artists.btnQueueAll', { count: counts.missing || 0 }) }}</button>
          <button class="btn" @click="load(kind)" :disabled="loading">{{ loading ? t('admin.artists.btnRefreshing') : t('admin.artists.btnRefresh') }}</button>
        </div>
      </div>

      <div style="margin-top:12px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface);display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;">
        <div style="font-size:.82rem;color:var(--t2);">{{ t('admin.artists.hydrationStatus') }} <b :style="hydration.running ? 'color:var(--ok,#16a34a);' : 'color:var(--t2);'">{{ hydration.running ? t('admin.artists.hydrationRunning') : t('admin.artists.hydrationIdle') }}</b></div>
        <div style="font-size:.82rem;color:var(--t2);">{{ t('admin.artists.hydrationQueue') }} <b>{{ hydration.queueLength || 0 }}</b>{{ seedTotal ? ' / ' + seedTotal : '' }}</div>
        <div style="font-size:.82rem;color:var(--t2);">{{ t('admin.artists.hydrationSessionFixed') }} <b>{{ hydratedThisSession == null ? 0 : hydratedThisSession }}</b></div>
        <div style="font-size:.82rem;color:var(--t2);">{{ t('admin.artists.hydrationSuccessRate') }} <b>{{ hydration.stats.succeeded || 0 }}</b> / {{ hydration.stats.noImage || 0 }} / {{ hydration.stats.failed || 0 }}</div>
        <div style="font-size:.82rem;color:var(--t2);">{{ t('admin.artists.hydrationDropped') }} <b>{{ hydration.stats.dropped || 0 }}</b></div>
        <div v-if="hydration.throughputPerMin != null" style="font-size:.82rem;color:var(--t2);">Throughput <b>{{ hydration.throughputPerMin }}</b> /min</div>
        <div style="font-size:.82rem;color:var(--t2);">{{ t('admin.artists.hydrationDiscogs') }} <b :style="discogsReady ? 'color:var(--ok,#16a34a);' : 'color:var(--warn,#b45309);'">{{ discogsReady ? t('admin.artists.discogsReady') : t('admin.artists.discogsNotReady') }}</b></div>
        <div v-if="hydration.stats.lastArtist" style="font-size:.82rem;color:var(--t2);grid-column:1/-1;">Now processing: <b style="color:var(--t1);">{{ hydration.stats.lastArtist }}</b></div>
        <div v-if="hydration.stats.lastError" style="font-size:.82rem;color:var(--warn,#b45309);grid-column:1/-1;">Last error: {{ hydration.stats.lastError }}</div>
      </div>
      <div v-if="hydration.stats.recentLog && hydration.stats.recentLog.length" style="margin-top:8px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);">
        <div style="font-size:.78rem;font-weight:600;color:var(--t2);margin-bottom:4px;">Recent activity (last 10)</div>
        <div v-for="entry in [...hydration.stats.recentLog].reverse().slice(0,10)" :key="entry.ts" style="font-size:.78rem;display:flex;gap:8px;align-items:center;padding:1px 0;">
          <span :style="entry.result==='success' ? 'color:var(--ok,#16a34a);' : entry.result==='no-image' ? 'color:var(--t2);' : 'color:var(--warn,#b45309);'" style="min-width:60px;">{{ entry.result }}</span>
          <span style="color:var(--t1);">{{ entry.name }}</span>
        </div>
      </div>
      <div v-if="!hydration.running && (hydration.queueLength || 0) === 0 && (counts.missing || 0) > 0" style="margin-top:8px;font-size:.82rem;color:var(--t2);">
        {{ t('admin.artists.hydrationIdleHint') }}
      </div>
      <div v-if="(counts.noImage || 0) > 0" style="margin-top:8px;font-size:.82rem;color:var(--t2);display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <span>{{ t('admin.artists.noImageHint', { count: counts.noImage || 0 }) }}</span>
        <button class="btn-flat btn-small" @click="seedTadbRetry(500)" :disabled="seedTadbPending" style="font-size:.78rem;padding:3px 10px;">{{ seedTadbPending ? t('admin.artists.btnQueueing') : t('admin.artists.btnRetryTadb') }}</button>
        <button class="btn-flat btn-small" @click="seedTadbRetry(counts.noImage || 9999)" :disabled="seedTadbPending" style="font-size:.78rem;padding:3px 10px;">{{ t('admin.artists.btnRetryTadbAll', { count: counts.noImage || 0 }) }}</button>
      </div>
    </div>

    <!-- ── Placeholder image ───────────────────────────────────────────────────────────────────────── -->
    <div class="card z-depth-1" style="padding:14px 18px;margin-top:12px;">
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
        <img :src="placeholderSrc()" alt="placeholder" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:1px solid var(--border);flex-shrink:0;" />
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:.95rem;">{{ t('admin.artists.placeholderTitle') }}</div>
          <div style="font-size:.82rem;color:var(--t2);margin-top:2px;">{{ placeholderHasCustom ? t('admin.artists.placeholderCustomActive') : t('admin.artists.placeholderDefaultActive') }}</div>
          <div style="font-size:.78rem;color:var(--t2);margin-top:3px;">{{ t('admin.artists.placeholderCacheHint') }}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <label class="btn-flat" style="cursor:pointer;display:inline-flex;align-items:center;gap:5px;" :style="placeholderUploading ? 'opacity:.5;pointer-events:none;' : ''">
            {{ placeholderUploading ? t('admin.artists.placeholderUploading') : t('admin.artists.placeholderUploadBtn') }}
            <input type="file" accept="image/*" style="display:none;" @change="uploadPlaceholder($event)" :disabled="placeholderUploading" />
          </label>
          <button v-if="placeholderHasCustom" class="btn-flat" style="color:var(--warn,#b45309);border-color:var(--warn,#b45309);" @click="resetPlaceholder()">{{ t('admin.artists.placeholderResetBtn') }}</button>
        </div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:minmax(340px,1fr) minmax(360px,1fr);gap:12px;margin-top:12px;align-items:start;">
      <div class="card z-depth-1" style="padding:10px 0;">
        <div style="padding:0 14px 8px;display:flex;gap:8px;align-items:center;">
          <input v-model="searchQuery" @input="searchArtists" type="search" :placeholder="t('admin.artists.searchPlaceholder')" style="flex:1;font-size:.86rem;padding:5px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--t1);" />
          <button v-if="searchQuery" class="btn-flat" style="padding:0 8px;font-size:.8rem;" @click="searchQuery='';searchResults=[];">✕</button>
        </div>
        <div v-if="!searchQuery" style="padding:0 14px 8px;font-size:.82rem;color:var(--t2);">{{ t('admin.artists.artistCount', { count: artists.length }) }}</div>
        <div style="max-height:64vh;overflow:auto;">
          <div v-if="searchQuery && searchLoading" style="padding:12px 14px;color:var(--t2);">{{ t('admin.artists.searching') }}</div>
          <template v-else-if="searchQuery">
            <div v-if="!searchResults.length" style="padding:12px 14px;color:var(--t2);">{{ t('admin.artists.searchNoResults') }}</div>
            <button v-for="a in searchResults" :key="a.artistKey" @click="selectArtist(a)" class="btn-flat" :style="selected && selected.artistKey===a.artistKey ? 'width:100%;text-align:left;display:flex;align-items:center;gap:10px;border-radius:0;border-left:none;border-right:none;border-top:none;padding:9px 14px;background:var(--raised);' : 'width:100%;text-align:left;display:flex;align-items:center;gap:10px;border-radius:0;border-left:none;border-right:none;border-top:none;padding:9px 14px;'">
              <img v-if="a.imageFile" :src="imgSrc(a.imageFile)" alt="" style="width:42px;height:42px;border-radius:50%;object-fit:cover;flex-shrink:0;border:1px solid var(--border);" />
              <div v-else style="width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--raised);color:var(--t2);font-weight:700;flex-shrink:0;">{{ (a.canonicalName||'?').replace(/^The +/i,'').charAt(0).toUpperCase() }}</div>
              <div style="min-width:0;flex:1;">
                <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">{{ a.canonicalName }}</div>
                <div style="font-size:.78rem;color:var(--t2);">{{ t('admin.artists.songCount', { count: a.songCount || 0 }) }}<span v-if="a.imageFile"> • ✓ image</span></div>
              </div>
            </button>
          </template>
          <template v-else>
            <div v-if="!artists.length && !loading" style="padding:12px 14px;color:var(--t2);">{{ t('admin.artists.listEmpty') }}</div>
            <button v-for="a in artists" :key="a.artistKey" @click="selectArtist(a)" class="btn-flat" :style="selected && selected.artistKey===a.artistKey ? 'width:100%;text-align:left;display:flex;align-items:center;gap:10px;border-radius:0;border-left:none;border-right:none;border-top:none;padding:9px 14px;background:var(--raised);' : 'width:100%;text-align:left;display:flex;align-items:center;gap:10px;border-radius:0;border-left:none;border-right:none;border-top:none;padding:9px 14px;'">
              <img v-if="a.imageFile" :src="imgSrc(a.imageFile)" alt="" style="width:42px;height:42px;border-radius:50%;object-fit:cover;flex-shrink:0;border:1px solid var(--border);" />
              <div v-else style="width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--raised);color:var(--t2);font-weight:700;flex-shrink:0;">{{ (a.canonicalName||'?').replace(/^The +/i,'').charAt(0).toUpperCase() }}</div>
              <div style="min-width:0;flex:1;">
                <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">{{ a.canonicalName }}</div>
                <div style="font-size:.78rem;color:var(--t2);">{{ t('admin.artists.songCount', { count: a.songCount || 0 }) }}<span v-if="a.imageSource"> • {{ a.imageSource }}</span><span v-if="kind === 'no-image'"> • {{ t('admin.artists.statusNoImageTried') }}</span></div>
              </div>
              <span v-if="a.wrongFlag" style="font-size:.72rem;padding:3px 7px;border-radius:999px;background:rgba(180,83,9,.18);color:var(--warn,#b45309);">{{ t('admin.artists.badgeWrong') }}</span>
            </button>
          </template>
        </div>
      </div>

      <div class="card z-depth-1" style="padding:14px;min-height:220px;">
        <div v-if="!selected" style="color:var(--t2);">{{ t('admin.artists.selectPrompt') }}</div>
        <div v-else>
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
            <div style="display:flex;align-items:center;gap:12px;">
              <div v-if="selected.imageFile" style="flex-shrink:0;">
                <img :src="imgSrc(selected.imageFile)" alt="" style="width:80px;height:80px;border-radius:10px;object-fit:cover;border:1px solid var(--border);display:block;" />
                <div style="font-size:.7rem;color:var(--t3);text-align:center;margin-top:3px;">{{ selected.imageSource || 'custom' }}</div>
              </div>
              <div v-else style="width:80px;height:80px;border-radius:10px;background:var(--raised);display:flex;align-items:center;justify-content:center;color:var(--t3);font-size:.72rem;text-align:center;flex-shrink:0;">{{ t('admin.artists.noImageYet') }}</div>
              <div>
                <div style="font-size:1rem;font-weight:700;">{{ selected.canonicalName }}</div>
                <div style="font-size:.82rem;color:var(--t2);">{{ t('admin.artists.songCount', { count: selected.songCount || 0 }) }}<span v-if="kind === 'no-image'"> • {{ t('admin.artists.statusNoImageTried') }}</span></div>
              </div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button v-if="selected.imageFile || selected.wrongFlag" class="btn-flat" @click="setWrong(selected, false)">{{ t('admin.artists.btnImageOk') }}</button>
              <button v-if="selected.imageFile || !selected.wrongFlag" class="btn-flat" style="border-color:var(--warn,#b45309);color:var(--warn,#b45309);" @click="setWrong(selected, true)">{{ t('admin.artists.btnMarkWrong') }}</button>
            </div>
          </div>

          <div style="margin-bottom:12px;">
            <div style="font-size:.82rem;color:var(--t2);margin-bottom:6px;">{{ t('admin.artists.labelApplyUrl') }}</div>
            <div style="display:flex;gap:8px;">
              <input v-model="customImageUrl" @input="customImagePreviewError = false" type="url" :placeholder="t('admin.artists.urlPlaceholder')" style="flex:1;" />
              <button class="btn" @click="applyImage(customImageUrl, 'custom')" :disabled="!customImageUrl || applying">{{ t('admin.artists.btnApply') }}</button>
            </div>
            <div v-if="customImagePreviewUrl" style="margin-top:10px;padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--surface);display:flex;gap:12px;align-items:flex-start;">
              <img v-show="!customImagePreviewError" :src="customImagePreviewUrl" @load="onCustomPreviewLoad" @error="onCustomPreviewError" alt="Custom preview" style="width:112px;height:112px;border-radius:10px;object-fit:cover;display:block;background:var(--raised);border:1px solid var(--border);flex-shrink:0;" />
              <div style="min-width:0;display:flex;flex-direction:column;gap:6px;">
                <div style="font-size:.82rem;font-weight:600;">{{ t('admin.artists.previewTitle') }}</div>
                <div v-if="customImagePreviewError" style="font-size:.8rem;color:var(--warn,#b45309);line-height:1.4;">{{ t('admin.artists.previewError') }}</div>
                <div v-else style="font-size:.8rem;color:var(--t2);line-height:1.4;">{{ t('admin.artists.previewDesc', { artist: selected.canonicalName }) }}</div>
                <div style="font-size:.74rem;color:var(--t3);word-break:break-all;">{{ customImagePreviewUrl }}</div>
              </div>
            </div>
          </div>

          <!-- TheAudioDB candidates -->
          <div style="font-size:.82rem;color:var(--t2);margin-bottom:8px;">TheAudioDB</div>
          <div v-if="tadbLoading" style="padding:8px 0;color:var(--t2);">{{ t('admin.artists.discogsLoading') }}</div>
          <div v-else-if="!tadbCandidates.length" style="padding:8px 0;color:var(--t2);">{{ t('admin.artists.discogsNone') }}</div>
          <div v-else style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;margin-bottom:16px;">
            <div v-for="c in tadbCandidates" :key="c.imageUrl" style="border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--surface);">
              <img :src="c.thumbUrl || c.imageUrl" alt="" style="width:100%;aspect-ratio:1;object-fit:cover;display:block;" />
              <div style="padding:8px;">
                <div style="font-size:.76rem;font-weight:600;line-height:1.3;max-height:2.2em;overflow:hidden;">{{ c.title }}</div>
                <div v-if="c.genre || c.country" style="font-size:.7rem;color:var(--t3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">{{ [c.genre, c.country].filter(Boolean).join(' · ') }}</div>
                <div style="display:flex;gap:6px;margin-top:7px;">
                  <button class="btn btn-small" style="flex:1;" @click="applyImage(c.imageUrl, 'theaudiodb')" :disabled="applying">{{ t('admin.artists.btnUse') }}</button>
                  <a v-if="c.sourceUrl" class="btn-flat btn-small" :href="c.sourceUrl" target="_blank" rel="noopener" style="padding:0 8px;">{{ t('admin.artists.btnView') }}</a>
                </div>
              </div>
            </div>
          </div>

          <!-- Discogs candidates -->
          <div style="font-size:.82rem;color:var(--t2);margin-bottom:8px;">{{ t('admin.artists.labelDiscogsSuggestions') }}</div>
          <div v-if="!discogsReady" style="padding:8px 0;color:var(--warn,#b45309);">{{ t('admin.artists.discogsDisabledHint') }}</div>
          <div v-else-if="candidateLoading" style="padding:8px 0;color:var(--t2);">{{ t('admin.artists.discogsLoading') }}</div>
          <div v-else-if="!candidates.length" style="padding:8px 0;color:var(--t2);">{{ t('admin.artists.discogsNone') }}</div>
          <div v-else style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;">
            <div v-for="c in candidates" :key="c.imageUrl" style="border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--surface);">
              <img :src="c.thumbUrl || c.imageUrl" alt="" style="width:100%;aspect-ratio:1;object-fit:cover;display:block;" />
              <div style="padding:8px;">
                <div style="font-size:.76rem;font-weight:600;line-height:1.3;max-height:2.2em;overflow:hidden;">{{ c.title }}</div>
                <div style="display:flex;gap:6px;margin-top:7px;">
                  <button class="btn btn-small" style="flex:1;" @click="applyImage(c.imageUrl, 'discogs')" :disabled="applying || !discogsReady">{{ t('admin.artists.btnUse') }}</button>
                  <a v-if="c.sourceUrl" class="btn-flat btn-small" :href="c.sourceUrl" target="_blank" rel="noopener" style="padding:0 8px;">{{ t('admin.artists.btnView') }}</a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  `
});

const dlnaView = Vue.component('dlna-view', {
  data() {
    return {
      params:    ADMINDATA.dlnaParams,
      paramsTS:  ADMINDATA.dlnaParamsUpdated,
      busy:      false,
      lastOk:    null,
      lastMsg:   '',
    };
  },
  methods: {
    async save(patch) {
      this.busy = true;
      try {
        const res = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/dlna/config`, data: patch });
        Object.assign(this.params, patch, { running: res.data.running });
        await ADMINDATA.getDlnaParams();
        this.lastOk = true;
        this.lastMsg = this.t('admin.dlna.saved');
      } catch (e) {
        this.lastOk = false;
        this.lastMsg = e?.response?.data?.error || this.t('admin.dlna.saveFailed');
      }
      this.busy = false;
    },
    toggleEnabled() { this.save({ enabled: !this.params.enabled }); },
  },
  template: `
    <div class="container">
      <div class="row">
        <div class="col s12">
          <div class="card" style="margin-bottom:10px">
            <div class="card-content">
              <span class="card-title">{{t('admin.dlna.title')}}</span>
              <p style="color:var(--t2);font-size:.92rem;margin-bottom:18px">{{t('admin.dlna.desc')}}</p>
              <div v-if="paramsTS.ts === 0" style="padding:16px 0;display:flex;justify-content:center">
                <svg class="spinner" width="48px" height="48px" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
              </div>
              <div v-else>
                <table>
                  <tbody>
                    <tr>
                      <td>
                        <b>{{t('admin.dlna.labelStatus')}}</b>
                        <span v-if="params.running" style="display:inline-block;margin-left:8px;padding:2px 10px;border-radius:12px;background:var(--green);color:#fff;font-size:.82rem;font-weight:600">{{t('admin.dlna.statusRunning')}}</span>
                        <span v-else-if="params.enabled" style="display:inline-block;margin-left:8px;padding:2px 10px;border-radius:12px;background:var(--orange,#f97316);color:#fff;font-size:.82rem;font-weight:600">{{t('admin.dlna.statusEnabled')}}</span>
                        <span v-else style="display:inline-block;margin-left:8px;padding:2px 10px;border-radius:12px;background:var(--t3,#888);color:#fff;font-size:.82rem;font-weight:600">{{t('admin.dlna.statusDisabled')}}</span>
                        <div style="font-size:.82rem;color:var(--t2);margin-top:4px">{{t('admin.dlna.helpStatus')}}</div>
                      </td>
                      <td>
                        <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none">
                          <span style="position:relative;display:inline-block;width:44px;height:24px">
                            <input type="checkbox" :checked="params.enabled" @change="toggleEnabled()" style="opacity:0;width:0;height:0;position:absolute" :disabled="busy">
                            <span :style="{ position:'absolute', inset:0, borderRadius:'12px', background: params.enabled ? 'var(--primary,#6366f1)' : 'var(--t3,#888)', transition:'background 0.2s', cursor:'pointer', opacity: busy ? 0.5 : 1 }"></span>
                            <span :style="{ position:'absolute', top:'3px', left: params.enabled ? '23px' : '3px', width:'18px', height:'18px', borderRadius:'50%', background:'#fff', transition:'left 0.2s', pointerEvents:'none' }"></span>
                          </span>
                          <span style="font-size:.85rem;color:var(--t2)">{{params.enabled ? t('admin.dlna.btnDisable') : t('admin.dlna.btnEnable')}}</span>
                        </label>
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <b>{{t('admin.dlna.labelPort')}}</b>
                        <div style="font-size:.82rem;color:var(--t2);margin-top:4px">{{t('admin.dlna.helpPort')}}</div>
                      </td>
                      <td>
                        <input type="number" min="1024" max="65535" :value="params.port || 10293"
                          @change="save({ port: Number.parseInt($event.target.value, 10) })"
                          style="width:100px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:4px 8px;color:var(--t1)" :disabled="busy">
                      </td>
                    </tr>
                    <tr>
                      <td>
                        <b>{{t('admin.dlna.labelName')}}</b>
                        <div style="font-size:.82rem;color:var(--t2);margin-top:4px">{{t('admin.dlna.helpName')}}</div>
                      </td>
                      <td>
                        <input type="text" :value="params.name || 'Velvet'"
                          @change="save({ name: $event.target.value })"
                          style="width:180px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:4px 8px;color:var(--t1)" :disabled="busy">
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p v-if="lastMsg" :style="{ marginTop:'12px', color: lastOk ? 'var(--green)' : 'var(--red,#f87171)', fontSize:'.88rem' }">{{lastMsg}}</p>
                <div style="margin-top:20px;padding:14px 16px;background:var(--surface2);border-radius:8px;border-left:3px solid var(--orange,#f97316)">
                  <b style="font-size:.88rem">{{t('admin.dlna.warningTitle')}}</b>
                  <p style="font-size:.85rem;color:var(--t2);margin:6px 0 0">{{t('admin.dlna.warningBody')}}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
});

// ── Smart Playlist ML admin view ──────────────────────────────────────────
const smartPlaylistView = Vue.component('smart-playlist-view', {
  data() {
    return {
      enabled: false,
      profiles: [],
      generated: [],
      slotCounts: [],
      loaded: false,
      generating: false,
      resetting: false,
      error: null,
      _pollTimer: null,
    };
  },
  mounted() {
    this.load();
    this._pollTimer = setInterval(() => this.load(), 30000);
  },
  beforeDestroy() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  },
  computed: {
    slotLabel() {
      return {
        morning:   this.t('admin.smartPlaylist.slotMorning'),
        afternoon: this.t('admin.smartPlaylist.slotAfternoon'),
        evening:   this.t('admin.smartPlaylist.slotEvening'),
        night:     this.t('admin.smartPlaylist.slotNight'),
      };
    },
    userIds() {
      const ids = new Set([
        ...this.profiles.map(p => p.user_id),
        ...this.generated.map(g => g.user_id),
      ]);
      return [...ids].sort((a, b) => String(a).localeCompare(String(b)));
    },
  },
  methods: {
    async load() {
      this.error = null;
      try {
        const r = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/smartplaylist/status` });
        this.enabled     = r.data.enabled;
        this.profiles    = r.data.stats?.profiles   ?? [];
        this.generated   = r.data.stats?.generated  ?? [];
        this.slotCounts  = r.data.stats?.slotCounts ?? [];
        this.loaded      = true;
      } catch (e) {
        this.error = e?.response?.data?.error ?? e.message;
      }
    },
    profilesForUser(userId) {
      return this.profiles.filter(p => p.user_id === userId);
    },
    generatedForUser(userId) {
      return this.generated.filter(g => g.user_id === userId);
    },
    rawEventCount(userId, slot) {
      const row = this.slotCounts.find(c => c.user_id === userId);
      return row ? (row[slot] ?? 0) : 0;
    },
    generatedAt(userId, slot) {
      const g = this.generated.find(g => g.user_id === userId && g.slot === slot);
      if (!g) return this.t('admin.smartPlaylist.never');
      return new Date(g.generated_at).toLocaleString();
    },
    trackCount(userId, slot) {
      const g = this.generated.find(g => g.user_id === userId && g.slot === slot);
      return g?.track_count ?? 0;
    },
    async generate() {
      this.generating = true;
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/smartplaylist/generate` });
        iziToast.success({ title: this.t('admin.smartPlaylist.generateSuccess'), position: 'topCenter', timeout: 3000 });
        setTimeout(() => this.load(), 4000);
      } catch (e) {
        iziToast.error({ title: e?.response?.data?.error ?? e.message, position: 'topCenter', timeout: 4000 });
      } finally {
        this.generating = false;
      }
    },
    async resetProfiles(userId) {
      if (!confirm(this.t('admin.smartPlaylist.resetConfirm'))) return;
      this.resetting = true;
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/smartplaylist/reset-profiles`, data: { userId } });
        iziToast.success({ title: this.t('admin.smartPlaylist.resetSuccess'), position: 'topCenter', timeout: 2500 });
        await this.load();
      } catch (e) {
        iziToast.error({ title: e?.response?.data?.error ?? e.message, position: 'topCenter', timeout: 4000 });
      } finally {
        this.resetting = false;
      }
    },
  },
  template: `
    <div>
      <h2 class="admin-section-title">{{ t('admin.smartPlaylist.title') }}</h2>
      <p style="color:var(--t2);font-size:.88rem;margin-bottom:16px;">{{ t('admin.smartPlaylist.subtitle') }}</p>

      <div v-if="!enabled" style="display:inline-flex;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 14px;margin-bottom:18px;font-size:.87rem;color:var(--t2);">
        <svg xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        {{ t('admin.smartPlaylist.betaNotice') }}
      </div>

      <div v-if="error" style="color:var(--red,#c33);margin-bottom:12px;font-size:.87rem;">{{ error }}</div>

      <div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;">
        <button class="btn-sm" @click="generate" :disabled="generating">
          {{ generating ? t('admin.smartPlaylist.generating') : t('admin.smartPlaylist.triggerGenerate') }}
        </button>
        <button class="btn-sm" @click="load">↺</button>
      </div>

      <div v-if="loaded && userIds.length === 0" style="color:var(--t3);font-size:.87rem;">
        {{ t('admin.smartPlaylist.noData') }}
      </div>

      <div v-for="uid in userIds" :key="uid" style="margin-bottom:24px;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
          <strong style="font-size:.92rem;">{{ uid }}</strong>
          <button class="btn-sm" @click="resetProfiles(uid)" :disabled="resetting" style="font-size:.75rem;padding:2px 8px;">
            {{ t('admin.smartPlaylist.resetProfiles') }}
          </button>
        </div>
        <table style="font-size:.83rem;border-collapse:collapse;width:100%;max-width:660px;">
          <thead>
            <tr>
              <th style="text-align:left;padding:3px 8px;color:var(--t2);">{{ t('admin.smartPlaylist.slotLabel') }}</th>
              <th style="text-align:right;padding:3px 8px;color:var(--t2);">{{ t('admin.smartPlaylist.plays') }}</th>
              <th style="text-align:right;padding:3px 8px;color:var(--t2);">{{ t('admin.smartPlaylist.totalEvents') }}</th>
              <th style="text-align:right;padding:3px 8px;color:var(--t2);">{{ t('admin.smartPlaylist.tracks') }}</th>
              <th style="text-align:right;padding:3px 8px;color:var(--t2);">{{ t('admin.smartPlaylist.lastGenerated') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="slot in ['morning','afternoon','evening','night']" :key="slot" style="border-top:1px solid var(--border)">
              <td style="padding:3px 8px;">{{ slotLabel[slot] }}</td>
              <td style="padding:3px 8px;text-align:right;" :title="t('admin.smartPlaylist.playsHint')">
                {{ (profilesForUser(uid).find(p => p.slot === slot) || {}).play_count || 0 }}
              </td>
              <td style="padding:3px 8px;text-align:right;font-weight:600;" :title="t('admin.smartPlaylist.totalEventsHint')">
                {{ rawEventCount(uid, slot) }}
              </td>
              <td style="padding:3px 8px;text-align:right;">{{ trackCount(uid, slot) }}</td>
              <td style="padding:3px 8px;text-align:right;color:var(--t3);font-size:.8rem;">{{ generatedAt(uid, slot) }}</td>
            </tr>
          </tbody>
        </table>
        <div style="font-size:.77rem;color:var(--t3);margin-top:5px;">{{ t('admin.smartPlaylist.playsNote') }}</div>
      </div>
    </div>
  `,
});

const vm = new Vue({
  el: '#content',
  components: {
    'folders-view': foldersView,
    'users-view': usersView,
    'db-view': dbView,
    'backup-view': backupView,
    'migrate-view': migrateView,
    'advanced-view': advancedView,
    'info-view': infoView,
    'transcode-view': transcodeView,
    'server-audio-view': serverAudioView,
    'sonos-view': sonosView,
    'dlna-view': dlnaView,
    'federation-view': federationView,
    'logs-view': logsView,
    'rpn-view': rpnView,
    'lock-view': lockView,
    'scan-errors-view': scanErrorsView,
    'artist-albums-diag-view': artistAlbumsDiagView,
    'wrapped-admin-view': wrappedAdminView,
    'lastfm-view': lastFMView,
    'listenbrainz-view': listenBrainzView,
    'discord-webhook-view': discordWebhookView,
    'custom-webhooks-view': customWebhooksView,
    'discogs-view': discogsView,
    'lyrics-view': lyricsView,
    'radio-view': radioView,
    'acoustid-view': acoustidView,
    'tagworkshop-view': tagWorkshopView,
    'rg-workshop-view': rgWorkshopView,
    'bpm-workshop-view': bpmWorkshopView,
    'genre-enricher-view': genreEnricherView,
    'dup-workshop-view': dupWorkshopView,
    'shared-playlists-view': sharedPlaylistsView,
    'genre-groups-view': genreGroupsView,
    'artists-admin-view': artistsAdminView,
    'languages-view': languagesView,
    'smart-playlist-view': smartPlaylistView,
  },
  data: {
    currentViewMain: 'folders-view',
    componentKey: false
  }
});

function changeView(viewName, el){
  if (vm.currentViewMain === viewName) { return; }

  const _content = document.getElementById('content');
  if (_content) _content.scrollTop = 0;
  vm.currentViewMain = viewName;

  const elements = document.querySelectorAll('.side-nav-item'); // or:
  elements.forEach(elm => {
    elm.classList.remove("select")
  });

  el.classList.add("select");

  // close nav on mobile
  closeSideMenu();
}

const fileExplorerModal = Vue.component('file-explorer-modal', {
  data() {
    return {
      componentKey: false, // Flip this value to force re-render,
      pending: false,
      currentDirectory: null,
      winDrives: ADMINDATA.winDrives,
      contents: []
    };
  },
  template: `
    <div>
      <div style="display:flex;align-items:center;justify-content:space-between;padding:1rem 1.5rem .75rem;border-bottom:1px solid var(--border);">
        <h5 style="margin:0;">{{ this.t('admin.modal.browseTitle') }}</h5>
        <button class="modal-close-x" type="button" :title="this.t('admin.modal.btnClose')" @click="closeModal">&times;</button>
      </div>

      <div style="padding:.65rem 1.5rem;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;">
        <button class="btn-flat btn-small" type="button" @click="goToDirectory(currentDirectory, '..')" :title="this.t('admin.modal.browseBtnUp')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          {{ this.t('admin.modal.browseBtnUp') }}
        </button>
        <button class="btn-flat btn-small" type="button" @click="goToDirectory('~')" :title="this.t('admin.modal.browseBtnHome')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          {{ this.t('admin.modal.browseBtnHome') }}
        </button>
        <button class="btn-flat btn-small" type="button" @click="goToDirectory(currentDirectory)" :title="this.t('admin.modal.browseBtnRefresh')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          {{ this.t('admin.modal.browseBtnRefresh') }}
        </button>
        <div style="margin-left:auto;display:flex;align-items:center;gap:.5rem;">
          <select @change="goToDirectory($event.target.value)" v-if="winDrives.length > 0" style="width:auto;padding:.25rem .4rem;font-size:.82rem;background:var(--raised);color:var(--t1);border:1px solid var(--border);border-radius:6px;">
            <option v-for="(value) in winDrives" :selected="currentDirectory && currentDirectory.startsWith(value)" :value="value">{{ value }}</option>
          </select>
          <button class="btn btn-small" type="button" @click="selectDirectory(currentDirectory)" :disabled="currentDirectory === null">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Select Current
          </button>
        </div>
      </div>

      <div v-if="currentDirectory !== null" style="padding:.4rem 1.5rem;background:var(--card);border-bottom:1px solid var(--border);">
        <code style="font-size:.8rem;color:var(--accent);word-break:break-all;">{{ currentDirectory }}</code>
      </div>

      <div v-if="currentDirectory === null || pending === true" style="display:flex;justify-content:center;padding:2rem;">
        <svg class="spinner" width="40" height="40" viewBox="0 0 66 66" xmlns="http://www.w3.org/2000/svg"><circle class="spinner-path" fill="none" stroke-width="6" stroke-linecap="round" cx="33" cy="33" r="30"></circle></svg>
      </div>
      <div v-else style="max-height:50vh;overflow-y:auto;">
        <div v-if="contents.length === 0" style="padding:1.25rem 1.5rem;color:var(--t3);text-align:center;">{{ this.t('admin.modal.browseNoSubdirs') }}</div>
        <ul class="collection" style="margin:0;border-radius:0;border-left:none;border-right:none;" v-else>
          <li
            v-for="dir in contents"
            class="collection-item"
            @click="goToDirectory(currentDirectory, dir.name)"
            style="display:flex;align-items:center;gap:.75rem;padding:.5rem 1.25rem;cursor:pointer;">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" height="20" style="flex-shrink:0;"><path fill="#FFA000" d="M38 12H22l-4-4H8c-2.2 0-4 1.8-4 4v24c0 2.2 1.8 4 4 4h31c1.7 0 3-1.3 3-3V16c0-2.2-1.8-4-4-4z"/><path fill="#FFCA28" d="M42.2 18H15.3c-1.9 0-3.6 1.4-3.9 3.3L8 40h31.7c1.9 0 3.6-1.4 3.9-3.3l2.5-14c.5-2.4-1.4-4.7-3.9-4.7z"/></svg>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{{ dir.name }}</span>
            <button class="btn-small" type="button" @click.stop="selectDirectory(currentDirectory, dir.name)">{{ this.t('admin.modal.browseBtnSelectFolder') }}</button>
          </li>
        </ul>
      </div>
    </div>`,
  created: async function () {
    this.goToDirectory('~');
  },
  methods: {
    goToDirectory: async function (dir, joinDir) {
      if (this.pending) { return; }
      this.pending = true;
      try {
        const params = { directory: dir };
        if (joinDir) { params.joinDirectory = joinDir; }
  
        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/file-explorer`,
          data: params
        });
  
        this.currentDirectory = res.data.path
  
        while (this.contents.length > 0) {
          this.contents.pop();
        }
  
        res.data.directories.forEach(d => {
          this.contents.push(d);
        });

        this.$nextTick(() => {
          // scroll modal back to top after navigation
          const dlg = document.querySelector('.modal-dialog');
          if (dlg) dlg.scrollTop = 0;
        });
      } catch {
        iziToast.error({
          title: this.t('admin.modal.browseToastFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.pending = false;
      }
    },
    closeModal: function () {
      modVM.closeModal();
    },
    selectDirectory: async function (dir, joinDir) {
      try {
        let selectThis = dir;

        if (joinDir) {
          const res = await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/file-explorer`,
            data: { directory: dir, joinDirectory: joinDir }
          });  
  
          selectThis = res.data.path
        }
  
        Vue.set(ADMINDATA.sharedSelect, 'value', selectThis);
  
        // close the modal
        modVM.closeModal();
      }catch {
        iziToast.error({
          title: this.t('admin.modal.browseToastCannotSelect'),
          position: 'topCenter',
          timeout: 3500
        });
      }
    }
  }
});

const userPasswordView = Vue.component('user-password-view', {
  data() {
    return {
      users: ADMINDATA.users,
      currentUser: ADMINDATA.selectedUser,
      resetPassword: '',
      showResetPassword: false,
      subsonicPassword: '',
      showSubsonicPassword: false,
      submitPending: false
    };
  }, 
  template: `
    <form @submit.prevent="updatePassword">
      ${mHead("{{ t('admin.modal.resetPasswordTitle') }}", '{{"User: " + currentUser.value}}')}
      <div class="modal-body">
        <div class="field-group">
          <label for="reset-password">New Velvet Password</label>
          <div class="pwd-wrap">
            <input v-model="resetPassword" id="reset-password" :type="showResetPassword ? 'text' : 'password'" placeholder="Leave blank to keep unchanged" autocomplete="new-password">
            <button type="button" class="pwd-toggle" @click="showResetPassword = !showResetPassword" tabindex="-1" :title="showResetPassword ? 'Hide' : 'Show'">
              <svg v-if="!showResetPassword" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            </button>
          </div>
        </div>
        <div class="field-group" style="margin-top:1rem;">
          <label for="subsonic-password">Subsonic API Password</label>
          <div style="font-size:.78rem;color:var(--t2);margin-bottom:.35rem;">Used by Subsonic-compatible apps (Ultrasonic, DSub, Symfonium, etc.). Must be stored in plain text for MD5 token auth.</div>
          <div class="pwd-wrap">
            <input v-model="subsonicPassword" id="subsonic-password" :type="showSubsonicPassword ? 'text' : 'password'" placeholder="Leave blank to keep unchanged" autocomplete="new-password">
            <button type="button" class="pwd-toggle" @click="showSubsonicPassword = !showSubsonicPassword" tabindex="-1" :title="showSubsonicPassword ? 'Hide' : 'Show'">
              <svg v-if="!showSubsonicPassword" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            </button>
          </div>
        </div>
      </div>
      ${mFoot("t('admin.modal.btnUpdatePassword')", "t('admin.modal.btnUpdating')")}
    </form>`,
  methods: {
    updatePassword: async function() {
      try {
        this.submitPending = true;

        if (!this.resetPassword && !this.subsonicPassword) {
          iziToast.warning({
            title: 'Nothing to update',
            message: 'Enter a new Velvet password, Subsonic password, or both.',
            position: 'topCenter',
            timeout: 3500
          });
          this.submitPending = false;
          return;
        }

        if (this.resetPassword) {
          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/users/password`,
            data: {
              username: this.currentUser.value,
              password: this.resetPassword
            }
          });
        }

        if (this.subsonicPassword) {
          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/users/subsonic-password`,
            data: {
              username: this.currentUser.value,
              password: this.subsonicPassword
            }
          });
        }
  
        // close & reset the modal
        modVM.closeModal();

        iziToast.success({
          title: 'Password Updated',
          position: 'topCenter',
          timeout: 3500
        });
      }catch {
        iziToast.error({
          title: 'Password Reset Failed',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const usersVpathsView = Vue.component('user-vpaths-view', {
  data() {
    return {
      users: ADMINDATA.users,
      directories: ADMINDATA.folders,
      currentUser: ADMINDATA.selectedUser,
      selectedDirs: [],
      submitPending: false,
      selectInstance: null
    };
  },
  template: `
    <form @submit.prevent="updateFolders">
      ${mHead("{{ t('admin.modal.folderAccessTitle') }}", '{{"User: " + currentUser.value}}')}
      <div class="modal-body">
        <div class="field-group">
          <label for="edit-user-dirs">Accessible Folders</label>
          <select id="edit-user-dirs" :disabled="Object.keys(directories).length === 0" multiple :size="Math.max(2, Object.keys(directories).length)" v-model="selectedDirs">
            <option disabled v-if="Object.keys(directories).length === 0">No directories available</option>
            <option v-for="(val, key) in directories" :key="key" :value="key">{{ key }}</option>
          </select>
          <span class="field-hint">{{ t('admin.modal.federationHoldCtrl') }}</span>
        </div>
      </div>
      ${mFoot()}
    </form>`,
    mounted: function () {
      if (this.currentUser.value && this.users[this.currentUser.value]) {
        this.selectedDirs = (this.users[this.currentUser.value].vpaths || []).slice();
      }
    },
    beforeDestroy: function() {
    },
    methods: {
      updateFolders: async function() {
        try {
          this.submitPending = true;

          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/users/vpaths`,
            data: {
              username: this.currentUser.value,
              vpaths: this.selectedDirs
            }
          });

          // update frontend data
          Vue.set(ADMINDATA.users[this.currentUser.value], 'vpaths', this.selectedDirs.slice());
    
          // close & reset the modal
          modVM.closeModal();
  
          iziToast.success({
            title: 'User Permissions Updated',
            position: 'topCenter',
            timeout: 3500
          });
        } catch {
          iziToast.error({
            title: 'Failed to Update Folders',
            position: 'topCenter',
            timeout: 3500
          });
        }finally {
          this.submitPending = false;
        }
      }
    }
});

const userAccessView = Vue.component('user-access-view', {
  data() {
    return {
      users: ADMINDATA.users,
      currentUser: ADMINDATA.selectedUser,
      submitPending: false,
      isAdmin: ADMINDATA.users[ADMINDATA.selectedUser.value].admin
    };
  },
  template: `
    <form @submit.prevent="updateUser">
      ${mHead("{{ t('admin.modal.userAccessTitle') }}", '{{"User: " + currentUser.value}}')}
      <div class="modal-body">
        <div style="display:flex;align-items:center;gap:.6rem;">
          <input id="user-admin-cb" type="checkbox" v-model="isAdmin" style="width:auto;margin:0;">
          <label for="user-admin-cb" style="font-size:.95rem;color:var(--t1);">Grant admin access</label>
        </div>
        <p class="field-hint" style="color:var(--red);" v-if="!isAdmin">Warning: removing the last admin account will lock you out of this panel.</p>
      </div>
      ${mFoot()}
    </form>`,
    methods: {
      updateUser: async function() {
        try {

          // Note: guard against removing admin from the last admin user
            // is handled server-side

          this.submitPending = true;

          await API.axios({
            method: 'POST',
            url: `${API.url()}/api/v1/admin/users/access`,
            data: {
              username: this.currentUser.value,
              admin: this.isAdmin
            }
          });

          // update frontend data
          Vue.set(ADMINDATA.users[this.currentUser.value], 'admin', this.isAdmin);
    
          // close & reset the modal
          modVM.closeModal();
  
          iziToast.success({
            title: 'User Permissions Updated',
            position: 'topCenter',
            timeout: 3500
          });
        } catch {
          iziToast.error({
            title: 'Failed to Update User',
            position: 'topCenter',
            timeout: 3500
          });
        }finally {
          this.submitPending = false;
        }
      }
    }
});

const editRequestSizeModal = Vue.component('edit-request-size-modal', {
  data() {
    return {
      params: ADMINDATA.serverParams,
      submitPending: false,
      maxRequestSize: ADMINDATA.serverParams.maxRequestSize
    };
  },
  template: `
    <form @submit.prevent="updatePort">
      ${mHead("{{ t('admin.modal.maxRequestSizeTitle') }}", "{{ t('admin.modal.maxRequestSizeSubtitle') }}")}
      <div class="modal-body">
        <div class="field-group">
          <label for="edit-max-request-size">{{ t('admin.modal.maxRequestSizeTitle') }}</label>
          <input v-model="maxRequestSize" id="edit-max-request-size" required type="text" placeholder="e.g. 50mb">
          <span class="field-hint">{{ t('admin.modal.maxRequestSizeWarning') }}</span>
        </div>
      </div>
      ${mFoot("t('admin.modal.btnUpdate')", "t('admin.modal.btnUpdating')")}
    </form>`,
  mounted: function () {
  },
  methods: {
    updatePort: async function() {
      try {
        this.submitPending = true;
        this.maxRequestSize = this.maxRequestSize.replaceAll(' ', '');

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/config/max-request-size`,
          data: { maxRequestSize: this.maxRequestSize }
        });

        // update frontend data
        Vue.set(ADMINDATA.serverParams, 'maxRequestSize', this.maxRequestSize);
  
        // close & reset the modal
        modVM.closeModal();

        iziToast.success({
          title: this.t('admin.modal.toastMaxRequestSizeSuccess'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch {
        iziToast.error({
          title: 'Failed to Update',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});


const editPortModal = Vue.component('edit-port-modal', {
  data() {
    return {
      params: ADMINDATA.serverParams,
      submitPending: false,
      currentPort: ADMINDATA.serverParams.port
    };
  },
  template: `
    <form @submit.prevent="updatePort">
      ${mHead("{{ t('admin.modal.portTitle') }}", "{{ t('admin.modal.portSubtitle') }}")}
      <div class="modal-body">
        <div class="field-group">
          <label for="edit-port">{{ t('admin.modal.labelPortNumber') }}</label>
          <input v-model="currentPort" id="edit-port" required type="number" min="2" max="65535" placeholder="3000">
          <span class="field-hint">{{ t('admin.modal.portWarning') }}</span>
        </div>
      </div>
      ${mFoot("t('admin.modal.btnUpdate')", "t('admin.modal.btnUpdating')")}
    </form>`,
  mounted: function () {
  },
  methods: {
    updatePort: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/config/port`,
          data: { port: this.currentPort }
        });

        // update frontend data
        // Vue.set(ADMINDATA.serverParams, 'port', this.currentPort);
  
        // close & reset the modal
        modVM.closeModal();

        setTimeout(() => {
          window.location.href = window.location.href.replace(`:${ADMINDATA.serverParams.port}`, `:${this.currentPort}`); 
        }, 4000);

        iziToast.success({
          title: this.t('admin.modal.toastPortUpdated'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch {
        iziToast.error({
          title: 'Failed to Update Port',
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editAddressModal = Vue.component('edit-address-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.serverParams.address
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      ${mHead("{{ t('admin.modal.addressTitle') }}", "{{ t('admin.modal.serverAddressSubtitle') }}")}
      <div class="modal-body">
        <div class="field-group">
          <label for="edit-server-address">{{ t('admin.modal.labelBindAddress') }}</label>
          <input v-model="editValue" id="edit-server-address" required type="text" placeholder="0.0.0.0">
          <span class="field-hint">{{ t('admin.modal.addressHint') }}</span>
        </div>
      </div>
      ${mFoot("t('admin.modal.btnUpdate')", "t('admin.modal.btnUpdating')")}
    </form>`,
  mounted: function () {
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/config/address`,
          data: { address: this.editValue }
        });

        // update frontend data
        Vue.set(ADMINDATA.serverParams, 'address', this.editValue);
  
        // close & reset the modal
        modVM.closeModal();

        iziToast.success({
          title: this.t('admin.modal.toastAddressUpdated'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch {
        iziToast.error({
          title: this.t('admin.common.updateFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editMaxScanModal = Vue.component('edit-max-scans-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.dbParams.maxConcurrentTasks
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      ${mHead("{{ t('admin.modal.maxConcurrentScansTitle') }}")}
      <div class="modal-body">
        <div class="field-group">
          <label for="edit-max-scans">{{ t('admin.modal.maxConcurrentScansTitle') }}</label>
          <input v-model="editValue" id="edit-max-scans" required type="number" min="1">
          <span class="field-hint">{{ t('admin.modal.maxConcurrentScansHint') }}</span>
        </div>
      </div>
      ${mFoot("t('admin.modal.btnUpdate')", "t('admin.modal.btnUpdating')")}
    </form>`,
  mounted: function () {
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/max-concurrent-scans`,
          data: { maxConcurrentTasks: this.editValue }
        });

        // update frontend data
        Vue.set(ADMINDATA.dbParams, 'maxConcurrentTasks', this.editValue);
  
        // close & reset the modal
        modVM.closeModal();

        iziToast.success({
          title: this.t('admin.common.updatedSuccessfully'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch {
        iziToast.error({
          title: this.t('admin.common.updateFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editBootScanView = Vue.component('edit-boot-scan-delay-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.dbParams.bootScanDelay
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      ${mHead("{{ t('admin.modal.bootScanDelayTitle') }}", "{{ t('admin.modal.bootScanDelaySubtitle') }}")}
      <div class="modal-body">
        <div class="field-group">
          <label for="edit-scan-delay">{{ t('admin.modal.labelDelaySeconds') }}</label>
          <input v-model="editValue" id="edit-scan-delay" required type="number" min="1">
        </div>
      </div>
      ${mFoot("t('admin.modal.btnUpdate')", "t('admin.modal.btnUpdating')")}
    </form>`,
  mounted: function () {
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/boot-scan-delay`,
          data: { bootScanDelay: this.editValue }
        });

        // update frontend data
        Vue.set(ADMINDATA.dbParams, 'bootScanDelay', this.editValue);
  
        // close & reset the modal
        modVM.closeModal();

        iziToast.success({
          title: this.t('admin.common.updatedSuccessfully'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch {
        iziToast.error({
          title: this.t('admin.common.updateFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editScanIntervalView = Vue.component('edit-scan-interval-modal', {
  data() {
    return {
      submitPending: false,
      editInterval: ADMINDATA.dbParams.scanInterval,
      editStartTime: ADMINDATA.dbParams.scanStartTime || ''
    };
  },
  computed: {
    startTimeValid() {
      if (!this.editStartTime) return true; // empty = clear, valid
      return /^\d{1,2}:\d{2}$/.test(this.editStartTime.trim());
    }
  },
  template: `
    <form @submit.prevent="updateParam">
      ${mHead("{{ t('admin.modal.scanSettingsTitle') }}", "{{ t('admin.modal.scanSettingsSubtitle') }}")}
      <div class="modal-body">
        <div class="field-group">
          <label for="edit-scan-interval">{{ t('admin.db.labelScanInterval') }}</label>
          <input v-model="editInterval" id="edit-scan-interval" required type="number" min="0">
          <span class="field-hint">{{ t('admin.db.scanIntervalHint') }}</span>
        </div>
        <div class="field-group" style="margin-top:16px">
          <label for="edit-scan-start-time">{{ t('admin.db.labelScanStartTime') }}</label>
          <input v-model="editStartTime" id="edit-scan-start-time" type="text" placeholder="e.g. 01:13 or 14:45">
          <span class="field-hint" :style="!startTimeValid ? 'color:var(--danger)' : ''">{{ t('admin.db.scanStartTimeHint') }}</span>
        </div>
      </div>
      ${mFoot("t('admin.modal.btnUpdate')", "t('admin.modal.btnUpdating')")}
    </form>`,
  methods: {
    updateParam: async function() {
      if (!this.startTimeValid) return;
      try {
        this.submitPending = true;

        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/db/params/scan-interval`, data: { scanInterval: Number(this.editInterval) } });
        const stRes = await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/db/params/scan-start-time`, data: { scanStartTime: this.editStartTime || null } });

        Vue.set(ADMINDATA.dbParams, 'scanInterval', Number(this.editInterval));
        Vue.set(ADMINDATA.dbParams, 'scanStartTime', this.editStartTime || null);
        Vue.set(ADMINDATA.dbParams, 'nextScanAt', stRes.data.nextScanAt || null);

        modVM.closeModal();
        iziToast.success({ title: this.t('admin.common.updatedSuccessfully'), position: 'topCenter', timeout: 3500 });
      } catch {
        iziToast.error({ title: this.t('admin.common.updateFailed'), position: 'topCenter', timeout: 3500 });
      } finally {
        this.submitPending = false;
      }
    }
  }
});

const editMaxZipMbModal = Vue.component('edit-max-zip-mb-modal', {
  data() {
    return {
      params: ADMINDATA.dbParams,
      submitPending: false,
      editValue: ADMINDATA.dbParams.maxZipMb || 500
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      ${mHead("{{ t('admin.modal.maxZipSizeTitle') }}", "{{ t('admin.modal.maxZipSizeSubtitle') }}")}
      <div class="modal-body">
        <div class="field-group">
          <label for="edit-max-zip-mb">{{ t('admin.modal.labelMaxSizeMb') }}</label>
          <input v-model.number="editValue" id="edit-max-zip-mb" required type="number" min="1" step="1">
          <span class="field-hint">{{ t('admin.modal.zipSizeHint') }}</span>
        </div>
      </div>
      ${mFoot("t('admin.modal.btnUpdate')", "t('admin.modal.btnUpdating')")}
    </form>`,
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/max-zip-mb`,
          data: { maxZipMb: this.editValue }
        });
        Vue.set(ADMINDATA.dbParams, 'maxZipMb', this.editValue);
        modVM.closeModal();
        iziToast.success({ title: this.t('admin.common.updatedSuccessfully'), position: 'topCenter', timeout: 3500 });
      } catch {
        iziToast.error({ title: this.t('admin.common.updateFailed'), position: 'topCenter', timeout: 3500 });
      } finally {
        this.submitPending = false;
      }
    }
  }
});

const editSslModal =  Vue.component('edit-ssl-modal', {
  data() {
    const ssl = ADMINDATA.serverParams?.ssl;
    return {
      certPath: (ssl?.cert) || '',
      keyPath: (ssl?.key) || '',
      submitPending: false
    };
  },
  template: `
    <form @submit.prevent="updateSSL">
      ${mHead("{{ t('admin.modal.sslTitle') }}", "{{ t('admin.modal.sslSubtitle') }}")}
      <div class="modal-body">
        <div class="field-group">
          <label for="edit-ssl-cert">{{ t('admin.modal.labelCertFile') }}</label>
          <input v-model="certPath" id="edit-ssl-cert" required type="text" placeholder="/path/to/cert.pem">
        </div>
        <div class="field-group">
          <label for="edit-ssl-key">{{ t('admin.modal.labelKeyFile') }}</label>
          <input v-model="keyPath" id="edit-ssl-key" required type="text" placeholder="/path/to/key.pem">
          <span class="field-hint">{{ t('admin.modal.sslWarning') }}</span>
        </div>
      </div>
      ${mFoot("t('admin.modal.btnUpdate')", "t('admin.modal.btnUpdating')")}
    </form>`,
  methods: {
    updateSSL: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/ssl`,
          data: { cert: this.certPath, key: this.keyPath }
        });

        // update frontend data
        if (!ADMINDATA.serverParams.ssl) Vue.set(ADMINDATA.serverParams, 'ssl', {});
        Vue.set(ADMINDATA.serverParams.ssl, 'cert', this.certPath);
        Vue.set(ADMINDATA.serverParams.ssl, 'key', this.keyPath);
  
        modVM.closeModal();

        iziToast.success({
          title: this.t('admin.modal.toastSslUpdated'),
          position: 'topCenter',
          timeout: 5000
        });

        setTimeout(() => {
          window.location.href = window.location.href.replaceAll('http://', 'https://');
        }, 5000);
      } catch {
        iziToast.error({
          title: this.t('admin.common.updateFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.submitPending = false;
      }
    }
  }
});

const serverAudioMpvBinModal = Vue.component('server-audio-mpvbin-modal', {
  data() {
    return {
      editValue: ADMINDATA.serverAudioParams.mpvBin || 'mpv',
      submitPending: false,
    };
  },
  template: `
    <form @submit.prevent="save">
      ${(()=>'')()}
      <div class="modal-header"><div><div class="modal-title">{{ t('admin.modal.labelMpvBinPath') }}</div><div class="modal-subtitle">{{ t('admin.modal.mpvBinDesc') }}</div></div><button class="modal-close-x" type="button" @click="closeModal">&times;</button></div>
      <div class="modal-body">
        <label class="modal-label">{{ t('admin.modal.mpvBinBinaryLabel') }}</label>
        <input class="modal-input" type="text" v-model="editValue" placeholder="mpv" spellcheck="false" autocorrect="off">
        <p style="color:var(--t2);font-size:.82rem;margin-top:6px">{{ t('admin.modal.mpvBinExample') }} <code>/usr/bin/mpv</code> {{ t('admin.modal.mpvBinOrLeaveAs') }} <code>mpv</code> {{ t('admin.modal.mpvBinIfSystemWide') }}</p>
      </div>
      <div class="modal-footer-row">
        <button class="btn-flat" type="button" @click="closeModal">{{ t('admin.modal.btnCancel') }}</button>
        <button class="btn" type="submit" :disabled="submitPending">{{ submitPending ? t('admin.modal.btnSaving') : t('admin.modal.btnSave') }}</button>
      </div>
    </form>`,
  methods: {
    async save() {
      this.submitPending = true;
      try {
        await API.axios({ method: 'POST', url: `${API.url()}/api/v1/admin/server-audio`, data: { mpvBin: this.editValue } });
        Vue.set(ADMINDATA.serverAudioParams, 'mpvBin', this.editValue);
        this.closeModal();
      } finally { this.submitPending = false; }
    }
  }
});

const editTranscodeCodecModal = Vue.component('edit-transcode-codec-modal', {
  data() {
    return {
      params: ADMINDATA.transcodeParams,
      submitPending: false,
      editValue: ADMINDATA.transcodeParams.defaultCodec,
      selectInstance: null
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      ${mHead("{{ t('admin.modal.codecTitle') }}", "{{ t('admin.modal.codecSubtitle') }}")}
      <div class="modal-body">
        <div class="field-group">
          <label for="transcode-codec-dropdown">{{ t('admin.modal.codecLabel') }}</label>
          <select v-model="editValue" id="transcode-codec-dropdown">
            <option value="mp3">{{ t('admin.modal.codecMp3') }}</option>
            <option value="opus">{{ t('admin.modal.codecOpus') }}</option>
            <option value="aac">{{ t('admin.modal.codecAac') }}</option>
          </select>
        </div>
      </div>
      ${mFoot("t('admin.modal.btnUpdate')", "t('admin.modal.btnUpdating')")}
    </form>`,
  mounted: function () {
  },
  beforeDestroy: function() {
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/transcode/default-codec`,
          data: { defaultCodec: this.editValue }
        });

        // update frontend data
        Vue.set(ADMINDATA.transcodeParams, 'defaultCodec', this.editValue);
  
        // close & reset the modal
        modVM.closeModal();

        iziToast.success({
          title: this.t('admin.common.updatedSuccessfully'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch {
        iziToast.error({
          title: this.t('admin.common.updateFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editTranscodeDefaultAlgorithm = Vue.component('edit-transcode-algorithm-modal', {
  data() {
    return {
      params: ADMINDATA.transcodeParams,
      submitPending: false,
      editValue: ADMINDATA.transcodeParams.algorithm,
      selectInstance: null
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      ${mHead("{{ t('admin.modal.algorithmTitle') }}", "{{ t('admin.modal.algorithmSubtitle') }}")}
      <div class="modal-body">
        <div class="field-group">
          <label for="transcode-algorithm-dropdown">{{ t('admin.modal.algorithmLabel') }}</label>
          <select v-model="editValue" id="transcode-algorithm-dropdown">
            <option value="buffer">{{ t('admin.modal.algoBuffer') }}</option>
            <option value="stream">{{ t('admin.modal.algoStream') }}</option>
          </select>
        </div>
      </div>
      ${mFoot("t('admin.modal.btnUpdate')", "t('admin.modal.btnUpdating')")}
    </form>`,
  mounted: function () {
  },
  beforeDestroy: function() {
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/transcode/default-algorithm`,
          data: { algorithm: this.editValue }
        });

        // update frontend data
        Vue.set(ADMINDATA.transcodeParams, 'algorithm', this.editValue);
  
        // close & reset the modal
        modVM.closeModal();

        iziToast.success({
          title: this.t('admin.common.updatedSuccessfully'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch {
        iziToast.error({
          title: this.t('admin.common.updateFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const editTranscodeDefaultBitrate = Vue.component('edit-transcode-bitrate-modal', {
  data() {
    return {
      params: ADMINDATA.transcodeParams,
      submitPending: false,
      editValue: ADMINDATA.transcodeParams.defaultBitrate,
      selectInstance: null
    };
  },
  template: `
    <form @submit.prevent="updateParam">
      ${mHead("{{ t('admin.modal.bitrateTitle') }}", "{{ t('admin.modal.bitrateSubtitle') }}")}
      <div class="modal-body">
        <div class="field-group">
          <label for="transcode-bitrate-dropdown">{{ t('admin.modal.bitrateLabel') }}</label>
          <select v-model="editValue" id="transcode-bitrate-dropdown">
            <option value="64k">{{ t('admin.modal.bitrate64k') }}</option>
            <option value="96k">{{ t('admin.modal.bitrate96k') }}</option>
            <option value="128k">{{ t('admin.modal.bitrate128k') }}</option>
            <option value="192k">{{ t('admin.modal.bitrate192k') }}</option>
          </select>
        </div>
      </div>
      ${mFoot("t('admin.modal.btnUpdate')", "t('admin.modal.btnUpdating')")}
    </form>`,
  mounted: function () {
  },
  beforeDestroy: function() {
  },
  methods: {
    updateParam: async function() {
      try {
        this.submitPending = true;

        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/transcode/default-bitrate`,
          data: { defaultBitrate: this.editValue }
        });

        // update frontend data
        Vue.set(ADMINDATA.transcodeParams, 'defaultBitrate', this.editValue);
  
        // close & reset the modal
        modVM.closeModal();

        iziToast.success({
          title: this.t('admin.common.updatedSuccessfully'),
          position: 'topCenter',
          timeout: 3500
        });
      } catch {
        iziToast.error({
          title: this.t('admin.common.updateFailed'),
          position: 'topCenter',
          timeout: 3500
        });
      }finally {
        this.submitPending = false;
      }
    }
  }
});

const federationGenerateInvite = Vue.component('federation-generate-invite-modal', {
  data() {
    return {
      submitPending: false,
      selectInstance: null,
      fedDirs: [],
      directories: ADMINDATA.folders,
      federationInviteToken: ADMINDATA.federationInviteToken
    };
  },
  template: `
    <div>
      ${mHead("{{ t('admin.modal.federationInviteTitle') }}", "{{ t('admin.modal.federationInviteSubtitle') }}")}
      <form @submit.prevent="generateToken">
        <div class="modal-body">
          <div class="field-group">
            <label for="fed-invite-dirs">{{ t('admin.modal.federationFoldersLabel') }}</label>
            <select id="fed-invite-dirs" :disabled="Object.keys(directories).length === 0" multiple :size="Math.max(2, Object.keys(directories).length)" v-model="fedDirs">
              <option disabled value="" v-if="Object.keys(directories).length === 0">{{ t('admin.modal.federationNoDirectories') }}</option>
              <option v-for="(val, key) in directories" :key="key" :value="key">{{ key }}</option>
            </select>
            <span class="field-hint">{{ t('admin.modal.federationHoldCtrl') }}</span>
          </div>
          <div class="field-group" v-if="federationInviteToken.val">
            <label>{{ t('admin.modal.federationInviteTokenLabel') }}</label>
            <textarea v-model="federationInviteToken.val" id="fed-textarea" rows="5" readonly style="resize:none;font-size:.82rem;font-family:monospace;"></textarea>
            <a href="#" class="fed-copy-button btn-flat btn-small" data-clipboard-target="#fed-textarea" style="align-self:flex-start;margin-top:.25rem;">{{ t('admin.modal.federationCopyClipboard') }}</a>
          </div>
        </div>
        ${mFoot("t('admin.modal.btnCreateInvite')", "t('admin.modal.btnCreating')")}
      </form>
    </div>`,
  mounted: function () {
  },
  beforeDestroy: function() {
  },
  methods: {
    generateToken: async function() {
      try {
        this.submitPending = true;
        const selectedDirs = this.fedDirs;

        if(selectedDirs.length === 0) {
          iziToast.warning({
            title: this.t('admin.modal.federationNothingToFederate'),
            position: 'topCenter',
            timeout: 3500
          });
          return;
        }

        const postData =  { vpaths: selectedDirs };
        if (window.location.protocol === 'https:') {
          postData.url = window.location.origin;
        }

        const res = await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/federation/invite/generate`,
          data: postData
        });

        this.federationInviteToken.val = res.data.token;
      } catch (err) {
        console.log(err)
        iziToast.error({
          title: this.t('admin.federation.toastFailedInvite'),
          position: 'topCenter',
          timeout: 3500
        });
      } finally {
        this.submitPending = false;
      }
    }
  }
});


const nullModal = Vue.component('null-modal', {
  template: '<div>NULL MODAL ERROR: How did you get here?</div>'
});

// ── Album Version Tags component ─────────────────────────────────────────────
Vue.component('album-version-tags-card', {
  data() {
    return {
      tags: [...ADMINDATA.albumVersionTags],
      inventory: ADMINDATA.albumVersionInventory,
      newTag: '',
      saving: false,
      loadingInv: false,
      inventoryLoaded: false,
    };
  },
  mounted() {
    this.loadTags();
  },
  methods: {
    async loadTags() {
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/db/params` });
        const raw = res.data.albumVersionTags;
        if (Array.isArray(raw)) {
          this.tags = [...raw];
          ADMINDATA.albumVersionTags.splice(0, ADMINDATA.albumVersionTags.length, ...raw);
        } else {
          // Server has none configured — show the default list
          this.tags = [
            'TIT3','SUBTITLE','DISCSUBTITLE',
            'TXXX:EDITION','TXXX:VERSION','TXXX:ALBUMVERSION',
            'TXXX:QUALITY','TXXX:REMASTER','TXXX:DESCRIPTION',
            'EDITION','VERSION','ALBUMVERSION','QUALITY','REMASTER'
          ];
        }
      } catch (e) { console.debug('[velvet]', e?.message ?? e); }
    },
    async loadInventory() {
      if (this.loadingInv) return;
      this.loadingInv = true;
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/db/album-version-inventory` });
        this.inventory = res.data;
        ADMINDATA.albumVersionInventory.splice(0, ADMINDATA.albumVersionInventory.length, ...res.data);
        this.inventoryLoaded = true;
      } catch {
        iziToast.error({ title: 'Failed to load inventory', position: 'topCenter', timeout: 2500 });
      } finally {
        this.loadingInv = false;
      }
    },
    addTag() {
      const v = this.newTag.trim().toUpperCase();
      if (!v || this.tags.includes(v)) { this.newTag = ''; return; }
      this.tags.push(v);
      this.newTag = '';
    },
    removeTag(i) {
      this.tags.splice(i, 1);
    },
    moveUp(i) {
      if (i === 0) return;
      const t = this.tags.splice(i, 1)[0];
      this.tags.splice(i-1, 0, t);
    },
    moveDown(i) {
      if (i >= this.tags.length - 1) return;
      const t = this.tags.splice(i, 1)[0];
      this.tags.splice(i+1, 0, t);
    },
    async save() {
      this.saving = true;
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/album-version-tags`,
          data: { tags: this.tags }
        });
        ADMINDATA.albumVersionTags.splice(0, ADMINDATA.albumVersionTags.length, ...this.tags);
        iziToast.success({ title: 'Album version tags saved', position: 'topCenter', timeout: 2500 });
      } catch {
        iziToast.error({ title: 'Save failed', position: 'topCenter', timeout: 3000 });
      } finally {
        this.saving = false;
      }
    }
  },
  template: `
    <div>
      <details style="margin-bottom:14px;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 12px;">
        <summary style="cursor:pointer;font-size:.85rem;font-weight:600;color:var(--t2);user-select:none;">Field name reference — what to enter here</summary>
        <div style="margin-top:10px;font-size:.83rem;color:var(--t1);line-height:1.6;">
          <p style="margin:0 0 8px"><b>TIT3 / SUBTITLE / DISCSUBTITLE</b> — Standard subtitle fields. Many rippers (EAC, dBpoweramp, MusicBrainz Picard) write the edition text here automatically.<br>
          <span style="color:var(--t3)">Example value: <code>2016 Remaster</code></span></p>

          <p style="margin:0 0 6px"><b>What is TXXX?</b><br>
          <code>TXXX</code> is a <em>user-defined</em> text frame in MP3 files (ID3v2 standard). Because the ID3 standard cannot cover every possible piece of metadata, it provides one open-ended slot where you choose both the name and the value. Each TXXX frame has two parts:</p>
          <pre style="margin:4px 0 10px;padding:6px 10px;background:var(--bg2);border-radius:4px;font-size:.8rem;overflow-x:auto;">TXXX : EDITION  =  Deluxe Edition
       ↑ name        ↑ value you fill in
       (you choose)</pre>
          <p style="margin:0 0 8px">In this field list you write it as <code>TXXX:EDITION</code> — the colon separates the frame type from the name you chose. <b>TXXX only exists in MP3.</b> For FLAC/Opus/WavPack the scanner reads the same key as a plain Vorbis/APE tag automatically.</p>

          <table style="border-collapse:collapse;width:100%;max-width:560px;margin-bottom:10px;">
            <thead><tr style="border-bottom:1px solid var(--border)">
              <th style="text-align:left;padding:3px 8px;color:var(--t2);">Goal</th>
              <th style="text-align:left;padding:3px 8px;color:var(--t2);">Enter in tagger</th>
              <th style="text-align:left;padding:3px 8px;color:var(--t2);">Add here as</th>
              <th style="text-align:left;padding:3px 8px;color:var(--t2);">Example value</th>
            </tr></thead>
            <tbody>
              <tr style="border-top:1px solid var(--border)"><td style="padding:3px 8px">Edition label</td><td style="padding:3px 8px;font-family:monospace;font-size:.8rem">TXXX → EDITION</td><td style="padding:3px 8px;font-family:monospace;font-size:.8rem">TXXX:EDITION</td><td style="padding:3px 8px;color:var(--t3)">Deluxe Edition</td></tr>
              <tr style="border-top:1px solid var(--border)"><td style="padding:3px 8px">Version string</td><td style="padding:3px 8px;font-family:monospace;font-size:.8rem">TXXX → VERSION</td><td style="padding:3px 8px;font-family:monospace;font-size:.8rem">TXXX:VERSION</td><td style="padding:3px 8px;color:var(--t3)">2016 Remaster</td></tr>
              <tr style="border-top:1px solid var(--border)"><td style="padding:3px 8px">Audio quality</td><td style="padding:3px 8px;font-family:monospace;font-size:.8rem">TXXX → QUALITY</td><td style="padding:3px 8px;font-family:monospace;font-size:.8rem">TXXX:QUALITY</td><td style="padding:3px 8px;color:var(--t3)">24bit/96kHz</td></tr>
              <tr style="border-top:1px solid var(--border)"><td style="padding:3px 8px">Remaster info</td><td style="padding:3px 8px;font-family:monospace;font-size:.8rem">TXXX → REMASTER</td><td style="padding:3px 8px;font-family:monospace;font-size:.8rem">TXXX:REMASTER</td><td style="padding:3px 8px;color:var(--t3)">2003 Remaster</td></tr>
            </tbody>
          </table>

          <p style="margin:0 0 4px"><b>How to set TXXX in your tagger:</b></p>
          <ul style="margin:0 0 6px;padding-left:18px;">
            <li><b>Mp3tag</b>: Tag panel → click <code>+</code> → field name <code>TXXX:EDITION</code> → value <code>Deluxe Edition</code></li>
            <li><b>foobar2000</b>: Properties → <code>…</code> button → New field → name <code>EDITION</code> → value <code>Deluxe Edition</code></li>
            <li><b>MusicBrainz Picard</b>: Writes <code>DISCSUBTITLE</code> automatically for releases tagged as remasters</li>
          </ul>
          <p style="margin:0;color:var(--t3);font-size:.8rem">Fields are tried top-to-bottom. First non-empty value wins. If nothing matches, the scanner falls back to keyword detection on the album title and folder name.</p>
        </div>
      </details>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;align-items:center;">
        <span v-for="(tag, i) in tags" :key="i" style="display:inline-flex;align-items:center;gap:2px;background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:.82rem;font-family:monospace;">
          <span>{{tag}}</span>
          <button @click="moveUp(i)" style="background:none;border:none;cursor:pointer;color:var(--t2);padding:0 2px;" title="Move up">↑</button>
          <button @click="moveDown(i)" style="background:none;border:none;cursor:pointer;color:var(--t2);padding:0 2px;" title="Move down">↓</button>
          <button @click="removeTag(i)" style="background:none;border:none;cursor:pointer;color:var(--red,#c00);padding:0 2px;" title="Remove">✕</button>
        </span>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:12px;">
        <input v-model="newTag" @keyup.enter="addTag" type="text" placeholder="e.g. TXXX:EDITION" style="flex:1;min-width:0;padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--t1);font-family:monospace;font-size:.85rem;">
        <button @click="addTag" class="btn-sm">Add</button>
        <button @click="save" class="btn-sm" :disabled="saving">{{ saving ? 'Saving…' : 'Save Order' }}</button>
      </div>
      <div>
        <button @click="loadInventory" class="btn-sm" :disabled="loadingInv" style="margin-bottom:8px;">
          {{ loadingInv ? 'Loading…' : 'Show Version Source Breakdown' }}
        </button>
        <table v-if="inventoryLoaded && inventory.length > 0" style="font-size:.83rem;border-collapse:collapse;width:100%;max-width:500px;">
          <thead><tr><th style="text-align:left;padding:3px 8px;color:var(--t2);">Source</th><th style="text-align:right;padding:3px 8px;color:var(--t2);">Files</th></tr></thead>
          <tbody>
            <tr v-for="row in inventory" :key="row.album_version_source" style="border-top:1px solid var(--border)">
              <td style="padding:3px 8px;font-family:monospace;">{{row.album_version_source}}</td>
              <td style="padding:3px 8px;text-align:right;">{{row.cnt}}</td>
            </tr>
          </tbody>
        </table>
        <p v-else-if="inventoryLoaded" style="font-size:.85rem;color:var(--t3);">No version data yet — rescan your library first.</p>
      </div>
    </div>`
});

// ── Album Category Folders component ─────────────────────────────────────────
// Manages the list of folder names that are treated as category containers
// (e.g. [Live], [Compilations]) instead of artist names in the Albums browser.
Vue.component('album-category-folders-card', {
  data() {
    return {
      folders: [],
      newFolder: '',
      saving: false,
    };
  },
  mounted() { this.loadFolders(); },
  methods: {
    async loadFolders() {
      try {
        const res = await API.axios({ method: 'GET', url: `${API.url()}/api/v1/admin/db/params` });
        const raw = res.data.albumCategoryFolders;
        this.folders = Array.isArray(raw) ? [...raw] : [...this.defaultFolders()];
      } catch {
        this.folders = [...this.defaultFolders()];
      }
    },
    defaultFolders() {
      // Common English folder names (with and without brackets)
      // and the most frequent translations used across European libraries.
      return [
        '[Live]', '[Compilations]', '[Compilation]', '[Singles]', '[EPs]',
        '[Demos]', '[Bootlegs]', '[Rarities]', '[B-Sides]', '[Instrumentals]',
        '[Remixes]', '[Acoustic]', '[Bonus]',
        'Live', 'Compilations', 'Compilation', 'Singles', 'EPs',
        'Demos', 'Bootlegs', 'Rarities', 'B-Sides',
        // NL (Dutch)
        '[Compilaties]', 'Compilaties', '[Live Optredens]',
        // DE (German)
        '[Kompilationen]', 'Kompilationen', '[Raritäten]', 'Raritäten',
        // FR (French)
        '[Compilations]',  // same word, already included
        '[Raretés]', 'Raretés',
        // IT (Italian)
        '[Raccolte]', 'Raccolte', '[Rarità]', 'Rarità',
        // ES (Spanish)
        '[Recopilaciones]', 'Recopilaciones', '[Rarezas]', 'Rarezas',
      ];
    },
    addFolder() {
      const v = this.newFolder.trim();
      if (!v || this.folders.includes(v)) { this.newFolder = ''; return; }
      this.folders.push(v);
      this.newFolder = '';
      this.save();
    },
    removeFolder(i) { this.folders.splice(i, 1); this.save(); },
    async save() {
      this.saving = true;
      try {
        await API.axios({
          method: 'POST',
          url: `${API.url()}/api/v1/admin/db/params/album-category-folders`,
          data: { folders: this.folders }
        });
        iziToast.success({ title: 'Album category folders saved', position: 'topCenter', timeout: 2500 });
      } catch {
        iziToast.error({ title: 'Save failed', position: 'topCenter', timeout: 3000 });
      } finally {
        this.saving = false;
      }
    },
  },
  template: `
    <div>
      <p style="color:var(--t2);font-size:.85rem;margin-bottom:14px;">
        Folder names in this list are treated as <strong>category containers</strong>, not artist names.
        Albums inside them are grouped under the parent artist with a category label (e.g. <em>Live</em>, <em>Compilations</em>).
        Add names in the exact form used in your file system — both <code>[Live]</code> and <code>Live</code> are distinct entries.
        After saving, the Albums browser will apply the new grouping immediately (no rescan needed).
      </p>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;align-items:center;">
        <span v-for="(f, i) in folders" :key="i"
          style="display:inline-flex;align-items:center;gap:3px;background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-size:.82rem;font-family:monospace;">
          <span>{{ f }}</span>
          <button @click="removeFolder(i)"
            style="background:none;border:none;cursor:pointer;color:var(--red,#c00);padding:0 2px;line-height:1;"
            title="Remove">✕</button>
        </span>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:0;">
        <input v-model="newFolder" @keyup.enter="addFolder" type="text"
          placeholder="e.g. [Live] or Compilations"
          style="flex:1;min-width:0;padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--t1);font-family:monospace;font-size:.85rem;">
        <button @click="addFolder" class="btn-sm">Add</button>
        <button @click="save" class="btn-sm" :disabled="saving">{{ saving ? 'Saving…' : 'Save' }}</button>
      </div>
    </div>
  `,
});


const modVM = new Vue({
  el: '#admin-modal-wrapper',
  components: {
    'user-password-modal': userPasswordView,
    'user-vpaths-modal': usersVpathsView,
    'user-access-modal': userAccessView,
    'file-explorer-modal': fileExplorerModal,
    'edit-port-modal': editPortModal,
    'edit-request-size-modal': editRequestSizeModal,
    'edit-address-modal': editAddressModal,
    'edit-scan-interval-modal': editScanIntervalView,
    'edit-boot-scan-delay-modal': editBootScanView,
    'edit-transcode-codec-modal': editTranscodeCodecModal,
    'edit-transcode-bitrate-modal': editTranscodeDefaultBitrate,
    'edit-transcode-algorithm-modal': editTranscodeDefaultAlgorithm,
    'server-audio-mpvbin-modal': serverAudioMpvBinModal,
    'edit-max-scan-modal': editMaxScanModal,
    'edit-ssl-modal': editSslModal,
    'federation-generate-invite-modal': federationGenerateInvite,
    'edit-max-zip-mb-modal': editMaxZipMbModal,
    'dir-access-test-modal': dirAccessTestModal,
    'null-modal': nullModal
  },
  data: {
    currentViewModal: 'null-modal',
    modalOpen: false
  },
  methods: {
    openModal() { this.modalOpen = true; },
    closeModal() { this.modalOpen = false; this.currentViewModal = 'null-modal'; }
  }
});


const confirmVM = new Vue({
  el: '#confirm-modal-wrapper',
  data: {
    show: false,
    title: '',
    message: '',
    confirmLabel: 'Confirm',
    _onConfirm: null
  },
  methods: {
    ask(title, message, confirmLabel, onConfirm) {
      this.title = title;
      this.message = message || '';
      this.confirmLabel = confirmLabel || 'Confirm';
      this._onConfirm = onConfirm;
      this.show = true;
    },
    confirm() {
      this.show = false;
      if (this._onConfirm) this._onConfirm();
    },
    cancel() {
      this.show = false;
    }
  }
});
