// ── Global helpers used by the Vue app (index.js) ─────────────────────────────

function applyTheme(theme) {
  document.documentElement.classList.remove('dark', 'light');
  if (theme === 'dark')  document.documentElement.classList.add('dark');
  if (theme === 'light') document.documentElement.classList.add('light');
  localStorage.setItem('ms2_theme', theme);
  document.querySelectorAll('.theme-seg-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
}

function toggleSideMenu() {
  document.getElementById('sidenav').classList.toggle('open');
  document.getElementById('sidenav-cover').classList.toggle('open');
}

function closeSideMenu() {
  var nav = document.getElementById('sidenav');
  if (nav.classList.contains('open')) toggleSideMenu();
}

function gotoPlayer() {
  var playerOrigin = window.location.origin + '/';
  var w = window.open('', 'Velvet');
  if (!w || w === window) {
    window.open(playerOrigin, 'Velvet');
    return;
  }
  try {
    var href = w.location.href;
    if (!href || href === 'about:blank') {
      w.location.href = playerOrigin;
    }
  } catch(e) {
    w.location.href = playerOrigin;
  }
  w.focus();
}

// ── DOM setup — runs after full DOM (including Vue-rendered content) is ready ──

document.addEventListener('DOMContentLoaded', function() {

  // Theme toggle buttons (may be Vue-rendered, so wired after DOMContentLoaded)
  document.querySelectorAll('.theme-seg-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { applyTheme(btn.dataset.theme); });
  });
  applyTheme(localStorage.getItem('ms2_theme') || 'velvet');

  // Sidebar overlay close
  var sidenavCover = document.getElementById('sidenav-cover');
  if (sidenavCover) sidenavCover.addEventListener('click', function() { closeSideMenu(); });

  // ── Event delegation for sidebar nav items ─────────────────────────────────
  // Handles data-admin-view and data-admin-action attributes instead of inline
  // onclick handlers (which violate CSP script-src-attr 'none').
  document.addEventListener('click', function(e) {
    var item = e.target.closest('[data-admin-view]');
    if (item) {
      if (typeof changeView === 'function') {
        changeView(item.dataset.adminView, item);
      } else {
        console.error('[admin] changeView not available yet — index.js not loaded?');
      }
      closeSideMenu();
      return;
    }
    var action = e.target.closest('[data-admin-action]');
    if (!action) return;
    switch (action.dataset.adminAction) {
      case 'goto-player':
        gotoPlayer();
        closeSideMenu();
        break;
      case 'logout':
        if (typeof adminConfirm === 'function') {
          adminConfirm('Logout?', 'Music playing in the player tab will stop.', 'Logout', function() { API.logout(); });
        }
        break;
      case 'toggle-sidemenu':
        toggleSideMenu();
        break;
    }
  });

  // Build admin language picker from server-enabled locales
  I18N.ready.then(function() {
    var picker = document.getElementById('admin-lang-picker');
    if (!picker) return;
    var allLangs = I18N.listLanguages();
    function buildPicker(enabledCodes) {
      picker.innerHTML = '';
      allLangs.forEach(function(lang) {
        if (!enabledCodes.includes(lang.code)) return;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lang-flag-btn';
        btn.dataset.lang = lang.code;
        btn.setAttribute('aria-label', lang.label);
        btn.setAttribute('aria-pressed', lang.code === I18N.getLanguage() ? 'true' : 'false');
        if (lang.code === I18N.getLanguage()) btn.classList.add('active');
        var img = document.createElement('img');
        img.className = 'lang-flag-icon';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = '';
        if (lang.country) {
          img.src = 'https://flagcdn.com/24x18/' + lang.country + '.png';
        }
        var fallback = document.createElement('span');
        fallback.className = 'lang-flag-fallback';
        fallback.textContent = lang.flag;
        fallback.setAttribute('aria-hidden', 'true');
        if (lang.country) {
          fallback.style.display = 'none';
          img.onerror = function() {
            img.style.display = 'none';
            fallback.style.display = 'inline';
          };
        }
        btn.appendChild(img);
        btn.appendChild(fallback);
        btn.addEventListener('click', function() { I18N.loadLanguage(lang.code); });
        picker.appendChild(btn);
      });
      if (!enabledCodes.includes(I18N.getLanguage())) I18N.loadLanguage('en');
    }
    fetch('/api/v1/languages/enabled')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        buildPicker(d.enabled && d.enabled.length ? d.enabled : allLangs.map(function(lang) { return lang.code; }));
      })
      .catch(function() {
        buildPicker(allLangs.map(function(lang) { return lang.code; }));
      });
  });

  // ── Custom tooltip ──────────────────────────────────────────────────────────
  (function() {
    const tip = document.getElementById('tip-box');
    if (!tip) return;
    let hideT = null, autoT = null;
    function convertTitles(root) {
      const els = root ? [root, ...root.querySelectorAll('[title]')] : document.querySelectorAll('[title]');
      els.forEach(function(el) {
        if (el.hasAttribute && el.hasAttribute('title')) {
          el.setAttribute('data-tip', el.getAttribute('title'));
          el.removeAttribute('title');
        }
      });
    }
    convertTitles();
    new MutationObserver(function(muts) {
      muts.forEach(function(m) {
        if (m.type === 'childList') { m.addedNodes.forEach(function(n) { if (n.nodeType === 1) convertTitles(n); }); }
        else if (m.type === 'attributes' && m.target.hasAttribute('title')) { convertTitles(m.target); }
      });
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] });
    document.addEventListener('mouseover', function(e) {
      const el = e.target.closest('[data-tip]');
      if (!el) return;
      clearTimeout(hideT);
      tip.textContent = el.getAttribute('data-tip');
      const r = el.getBoundingClientRect();
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let x = r.left + r.width / 2 - tw / 2;
      let y = r.top - th - 8;
      if (x < 6) x = 6;
      if (x + tw > window.innerWidth - 6) x = window.innerWidth - tw - 6;
      if (y < 6) y = r.bottom + 8;
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
      tip.classList.add('tip-show');
      clearTimeout(autoT); autoT = setTimeout(function() { tip.classList.remove('tip-show'); }, 5000);
    });
    document.addEventListener('mouseout', function(e) {
      const el = e.target.closest('[data-tip]');
      if (!el) return;
      clearTimeout(autoT); hideT = setTimeout(function() { tip.classList.remove('tip-show'); }, 80);
    });
    document.addEventListener('mousedown', function() { clearTimeout(autoT); tip.classList.remove('tip-show'); });
  })();

});
