// Applies saved theme immediately (before body renders) to prevent flash of wrong theme.
// Reads the same key and default as applyTheme() in admin-init-body.js.
(function() {
  var t = localStorage.getItem('ms2_theme') || 'velvet';
  if (t === 'dark')  document.documentElement.classList.add('dark');
  if (t === 'light') document.documentElement.classList.add('light');
})();
