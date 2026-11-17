// Desktop shell bootstrap for the main player page.
// Keep this external so CSP can remain strict.
(function () {
  document.cookie = 'ms2_ui=desktop; Path=/; Max-Age=31536000; SameSite=Lax';
  window.name = 'Velvet';
  // Load the last used skin before the first paint; app.js settles the real choice after login.
  let last = null;
  try { last = localStorage.getItem('ms2_skin'); } catch { /* storage blocked */ }
  const m = /^([a-z0-9_-]{1,40})\|([a-z0-9]*)$/.exec(last || '');
  if (!m) return;
  const link = document.createElement('link');
  link.id = 'skin-css';
  link.rel = 'stylesheet';
  link.href = `/skins/${m[1]}/skin.css?v=${m[2]}`;
  document.head.appendChild(link);
  document.documentElement.dataset.skin = m[1];
})();
