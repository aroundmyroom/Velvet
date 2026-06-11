// Player locale bootstrap for the main page.
// Kept external so it works with script-src 'self'.
I18N.loadLanguage();
I18N.ready.then(function () {
  var picker = document.getElementById('player-lang-picker');
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
      btn.title = lang.label;
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
    // If current language was disabled, fall back to English
    if (!enabledCodes.includes(I18N.getLanguage())) I18N.loadLanguage('en');
  }
  fetch('/api/v1/languages/enabled')
    .then(function(r) { return r.json(); })
    .then(function(d) { buildPicker(d.enabled && d.enabled.length ? d.enabled : allLangs.map(function(lang) { return lang.code; })); })
    .catch(function() { buildPicker(allLangs.map(function(lang) { return lang.code; })); });
});
