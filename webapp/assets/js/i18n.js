// Velvet — i18n engine
// Adapted from upstream Velvet commit 67e11723, extended with onChange / ready.
// Usage:
//   I18N.t('key')                         → simple lookup (falls back to key)
//   I18N.t('key', { name: 'Alice' })      → {{name}} interpolation
//   I18N.t('count.songs', { count: 3 })   → plural object { one:'…', other:'…' }
//   window.t(key, params)                 → shorthand alias
//   data-i18n="key"                       → static HTML attribute (auto-translated)
//   I18N.onChange(fn)                     → subscribe to language changes
//   I18N.ready                            → Promise that resolves after first load
//   I18N.loadLanguage('nl')               → switch language
//   I18N.getLanguage()                    → current language code

const I18N = (() => {
  const mod = {};
  let strings  = {};
  let fallback = {};
  const DEFAULT_LANG = 'en';
  const SUPPORTED    = ['en', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ru', 'zh'];
  let currentLang = DEFAULT_LANG;
  const LANGUAGE_META = {
    en: { label: 'English',    flag: '🇬🇧', country: 'gb' },
    nl: { label: 'Nederlands', flag: '🇳🇱', country: 'nl' },
    de: { label: 'Deutsch',    flag: '🇩🇪', country: 'de' },
    fr: { label: 'Français',   flag: '🇫🇷', country: 'fr' },
    es: { label: 'Español',    flag: '🇪🇸', country: 'es' },
    it: { label: 'Italiano',   flag: '🇮🇹', country: 'it' },
    pt: { label: 'Português',  flag: '🇵🇹', country: 'pt' },
    pl: { label: 'Polski',     flag: '🇵🇱', country: 'pl' },
    ru: { label: 'Русский',    flag: '🇷🇺', country: 'ru' },
    zh: { label: '中文',        flag: '🇨🇳', country: 'cn' },
    ja: { label: '日本語',      flag: '🇯🇵', country: 'jp' },
    ko: { label: '한국어',      flag: '🇰🇷', country: 'kr' }
  };

  // Listeners notified after every successful language load.
  const changeListeners = new Set();

  // ── Key resolver ──────────────────────────────────────────────
  // Tries a direct flat key first ('admin.nav.users'), then falls back to
  // nested object walking so both key shapes work.
  function resolve(obj, key) {
    if (obj == null) { return undefined; }
    if (obj[key] !== undefined) { return obj[key]; }
    return key.split('.').reduce((o, k) => (o && o[k] !== undefined) ? o[k] : undefined, obj);
  }

  // ── Plural resolver ───────────────────────────────────────────
  // Supports { zero, one, two, few, many, other } objects.
  function pluralize(val, count) {
    if (typeof val !== 'object') { return val; }
    if (count === 0 && val.zero  !== undefined) { return val.zero;  }
    if (count === 1 && val.one   !== undefined) { return val.one;   }
    if (count === 2 && val.two   !== undefined) { return val.two;   }
    if (val.few   !== undefined && count >= 3 && count <= 10) { return val.few; }
    return val.other !== undefined ? val.other : (val.one || '');
  }

  // ── Core translate function ───────────────────────────────────
  mod.t = (key, params) => {
    let val = resolve(strings, key);
    if (val === undefined) { val = resolve(fallback, key); }

    // Handle plurals when params.count is provided
    if (params && typeof params.count === 'number' && typeof val === 'object') {
      val = pluralize(val, params.count);
    }

    let str = typeof val === 'string' ? val : key;

    // Parameter interpolation: replace {{param}} placeholders
    if (params) {
      Object.keys(params).forEach(p => {
        str = str.replace(new RegExp('\\{\\{' + p + '\\}\\}', 'g'), params[p]);
      });
    }

    return str;
  };

  // ── Language detection ────────────────────────────────────────
  let _langUser = ''; // set after login via I18N.setUser(username)
  function _langKey() { return _langUser ? 'velvet-lang_' + _langUser : 'velvet-lang'; }

  function detectLanguage() {
    const stored = localStorage.getItem(_langKey()) || localStorage.getItem('velvet-lang');
    if (stored && SUPPORTED.includes(stored)) { return stored; }
    const nav = (navigator.language || navigator.userLanguage || DEFAULT_LANG);
    const code = nav.split('-')[0].toLowerCase();
    return SUPPORTED.includes(code) ? code : DEFAULT_LANG;
  }

  // ── Simple hash ───────────────────────────────────────────────
  // djb2-inspired fingerprint for locale cache invalidation — fast, no crypto.
  function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }
    return h.toString(36);
  }

  function parseLocaleJson(str) {
    try {
      const parsed = JSON.parse(str);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ok: true, data: parsed };
      }
    } catch (_) {}
    return { ok: false };
  }

  function syncLanguagePickers(lang) {
    ['player-lang-picker', 'admin-lang-picker'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) { return; }
      if (el.tagName === 'SELECT') {
        el.value = lang;
      }
      el.querySelectorAll('[data-lang]').forEach(btn => {
        const active = btn.dataset.lang === lang;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    });
  }

  function showLanguageError(title, message) {
    if (window.iziToast && typeof window.iziToast.error === 'function') {
      window.iziToast.error({ title, message, position: 'topCenter', timeout: 4500 });
      return;
    }
    if (!document.body) {
      console.error(title + ': ' + message);
      return;
    }
    const toast = document.createElement('div');
    toast.className = 'ms-i18n-toast';
    toast.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:99999;max-width:min(92vw,540px);background:#7f1d1d;color:#fff;padding:12px 14px;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.28);font:13px/1.45 sans-serif;';
    const titleEl = document.createElement('strong');
    titleEl.style.display = 'block';
    titleEl.style.marginBottom = '2px';
    titleEl.textContent = title;
    const messageEl = document.createElement('span');
    messageEl.textContent = message;
    toast.append(titleEl, messageEl);
    document.body.appendChild(toast);
    setTimeout(() => { if (toast.parentNode) { toast.parentNode.removeChild(toast); } }, 4500);
  }

  function notifyLanguageLoadFailure(lang, reason) {
    const langLabel = String(lang || DEFAULT_LANG).toUpperCase();
    const titleKey = reason === 'invalid-json' ? 'settings.languageInvalidTitle' : 'settings.languageLoadFailedTitle';
    const msgKey = reason === 'invalid-json' ? 'settings.languageInvalidMessage' : 'settings.languageLoadFailedMessage';
    const title = mod.t(titleKey, { language: langLabel }) !== titleKey
      ? mod.t(titleKey, { language: langLabel })
      : (reason === 'invalid-json' ? 'Language file invalid' : 'Language switch failed');
    const message = mod.t(msgKey, { language: langLabel }) !== msgKey
      ? mod.t(msgKey, { language: langLabel })
      : (reason === 'invalid-json'
        ? langLabel + ' could not be activated because its locale JSON is invalid.'
        : langLabel + ' could not be activated because its locale file could not be loaded.');
    showLanguageError(title, message);
  }

  // ── Locale fetcher with localStorage cache ────────────────────
  // Uses cache:'no-cache' (conditional GET via ETag / Last-Modified) so the
  // browser always validates with the server — zero data transferred when
  // unchanged (304), fresh data delivered immediately when changed (200).
  // Content + hash are stored in localStorage so:
  //   • Translations load instantly from cache on repeat visits.
  //   • Any server-side update to a locale file is detected on the next page
  //     load via the hash comparison and the cache is refreshed automatically.
  //   • If the network is unavailable the cached copy is returned (offline OK).
  async function fetchLocale(code) {
    const lsDataKey = 'velvet-locale-' + code;
    const lsHashKey = 'velvet-locale-hash-' + code;

    // Fast path: return whatever is already stored in localStorage.
    let cached = null;
    const cachedStr = localStorage.getItem(lsDataKey);
    if (cachedStr) {
      const parsedCached = parseLocaleJson(cachedStr);
      if (parsedCached.ok) { cached = parsedCached.data; }
    }

    try {
      const r = await fetch(window.location.origin + '/locales/' + code + '.json', { cache: 'no-cache' });
      if (!r.ok) {
        throw new Error('HTTP ' + r.status);
      }
      const freshStr = await r.text();
      const parsedFresh = parseLocaleJson(freshStr);
      if (!parsedFresh.ok) {
        return { ok: false, error: 'invalid-json' };
      }
      const freshHash = simpleHash(freshStr);
      const storedHash = localStorage.getItem(lsHashKey);

      if (freshHash !== storedHash) {
        // File changed on server — refresh localStorage cache.
        try {
          localStorage.setItem(lsDataKey, freshStr);
          localStorage.setItem(lsHashKey, freshHash);
        } catch (_) { /* quota exceeded — skip caching */ }
        return { ok: true, data: parsedFresh.data };
      }

      // Content unchanged — use cached object (avoids a redundant JSON.parse).
      return { ok: true, data: cached || parsedFresh.data };
    } catch (_) {
      // Network failure — fall back to the localStorage cached copy.
      return cached ? { ok: true, data: cached, fromCache: true } : { ok: false, error: 'load-failed' };
    }
  }

  // ── Language loader ───────────────────────────────────────────
  mod.loadLanguage = async (lang) => {
    if (!lang) { lang = detectLanguage(); }
    if (!SUPPORTED.includes(lang)) { lang = DEFAULT_LANG; }
    const previousLang = currentLang;

    // English is always loaded as the fallback dictionary (once per page session).
    if (!Object.keys(fallback).length) {
      const fallbackResult = await fetchLocale(DEFAULT_LANG);
      fallback = fallbackResult.ok ? (fallbackResult.data || {}) : {};
    }

    if (lang === DEFAULT_LANG) {
      if (!Object.keys(fallback).length) {
        localStorage.setItem('velvet-lang', previousLang || DEFAULT_LANG);
        syncLanguagePickers(previousLang || DEFAULT_LANG);
        notifyLanguageLoadFailure(lang, 'invalid-json');
        return false;
      }
      strings = fallback;
    } else {
      const result = await fetchLocale(lang);
      if (!result.ok) {
        localStorage.setItem('velvet-lang', previousLang || DEFAULT_LANG);
        syncLanguagePickers(previousLang || DEFAULT_LANG);
        notifyLanguageLoadFailure(lang, result.error);
        return false;
      }
      strings = result.data || fallback;
    }

    currentLang = lang;
    localStorage.setItem(_langKey(), lang);
    localStorage.setItem('velvet-lang', lang); // keep global fallback in sync
    syncLanguagePickers(lang);
    mod.translatePage();
    changeListeners.forEach(fn => { try { fn(lang); } catch (_) { /* noop */ } });
    return true;
  };

  // ── Pub/Sub for language changes ──────────────────────────────
  // Returns an unsubscribe function.
  mod.onChange = (fn) => {
    changeListeners.add(fn);
    return () => changeListeners.delete(fn);
  };

  // Promise that resolves after the first loadLanguage() completes.
  // Useful for pages that build dynamic UI and need to await initial strings.
  mod.ready = new Promise(resolve => {
    const unsub = mod.onChange(() => { unsub(); resolve(); });
  });

  // ── Static DOM translation ────────────────────────────────────
  // Scan data-i18n attributes and replace textContent (or an attribute).
  // Called automatically after each language load.
  mod.translatePage = () => {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key  = el.getAttribute('data-i18n');
      const attr = el.getAttribute('data-i18n-attr');
      const translated = mod.t(key);
      if (translated === key) { return; } // no translation found — leave as-is
      if (attr) {
        // Support one or more space/comma-separated attributes (e.g. "title,aria-label").
        for (const a of attr.split(/[\s,]+/).filter(Boolean)) el.setAttribute(a, translated);
        // Icon-only controls usually carry only a title; mirror it to aria-label
        // so screen readers announce them (skip if already labelled or has text).
        if (/(^|[\s,])title([\s,]|$)/.test(attr) && !el.hasAttribute('aria-label')) {
          const txt = (el.textContent || '').trim();
          if (!txt && (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button')) {
            el.setAttribute('aria-label', translated);
          }
        }
      } else {
        el.textContent = translated;
      }
    });
  };

  // ── Utility getters ───────────────────────────────────────────
  mod.getLanguage   = () => currentLang;
  mod.detectLanguage = detectLanguage;
  mod.supported     = SUPPORTED;
  mod.listLanguages = () => SUPPORTED.map(code => ({ code, ...LANGUAGE_META[code] }));
  mod.getLanguageMeta = (code) => LANGUAGE_META[code] || { label: code.toUpperCase(), flag: code.toUpperCase(), country: null };

  // ── Per-user language preference ────────────────────────────
  // Called by app.js after login (username known). Reads this user's saved
  // language preference and applies it if it differs from the current one.
  // Pass '' (empty string) to reset to the anonymous/global key (on logout).
  mod.setUser = async (username) => {
    _langUser = username || '';
    const userLang = localStorage.getItem(_langKey());
    if (userLang && SUPPORTED.includes(userLang)) {
      // Per-user key exists — switch to it if different from current language.
      if (userLang !== currentLang) { await mod.loadLanguage(userLang); }
    } else if (_langUser && currentLang) {
      // First login for this user — seed the per-user key with the current
      // language so their preference is isolated from other users immediately.
      localStorage.setItem(_langKey(), currentLang);
    }
  };

  // Keep language in sync across browser tabs (admin <-> player).
  // Listens for both the global key ('velvet-lang') and the per-user key
  // ('velvet-lang_USERNAME') so changes made in one tab reach the other.
  window.addEventListener('storage', (ev) => {
    if (!ev.newValue) { return; }
    const globalKey = 'velvet-lang';
    const userKey   = _langUser ? 'velvet-lang_' + _langUser : null;
    if (ev.key !== globalKey && ev.key !== userKey) { return; }
    if (!SUPPORTED.includes(ev.newValue) || ev.newValue === currentLang) { return; }
    mod.loadLanguage(ev.newValue);
  });

  // Global shorthand: window.t(key, params)
  window.t    = mod.t;
  window.I18N = mod;   // expose on window so other scripts can call I18N.setUser()

  return mod;
})();
