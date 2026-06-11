// Applies saved theme immediately (before body renders) to prevent flash of wrong theme.
(function() {
  var t = null;
  for (var i = 0; i < localStorage.length; i++) {
    var key = localStorage.key(i);
    if (key && key.indexOf('ms2_theme_') === 0) { t = localStorage.getItem(key); break; }
  }
  if (!t) t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'velvet' : 'light';
  if (t === 'dark')  document.documentElement.classList.add('dark');
  if (t === 'light') document.documentElement.classList.add('light');
})();
// Injects the Velvet SVG as the favicon so it shows correctly in the browser tab.
(function() {
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="lvg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ff1293"/><stop offset="50%" stop-color="#9d1ae6"/><stop offset="100%" stop-color="#380bb0"/></linearGradient><linearGradient id="rvg" x1="0%" y1="100%" x2="100%" y2="0%"><stop offset="0%" stop-color="#380bb0"/><stop offset="50%" stop-color="#195ee6"/><stop offset="100%" stop-color="#00a2ff"/></linearGradient></defs><path d="M2.5 8C6.4 7.7 13 12.2 16 26c-1.9-2-7.8-10.2-13.5-18z" fill="url(#lvg)"/><path d="M29.5 8C25.6 7.7 19 12.2 16 26c1.9-2 7.8-10.2 13.5-18z" fill="url(#rvg)"/></svg>';
  var href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  document.querySelectorAll('link[rel*="icon"]').forEach(function(el) { el.href = href; });
})();
