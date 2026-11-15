function applyTheme(light) {
  document.documentElement.classList.toggle('light', light);
}
function toggleTheme() {
  const isLight = document.documentElement.classList.contains('light');
  localStorage.setItem('ms2_theme', isLight ? '' : 'light');
  applyTheme(!isLight);
}
applyTheme(localStorage.getItem('ms2_theme') === 'light');

// Pre-fill username from GUIv2 session token
const token = localStorage.getItem('ms2_token');
if (token) {
  try {
    const decoded = jwt_decode(token);
    if (decoded.username) document.getElementById('server-username').value = decoded.username;
  } catch(e) { /* unreadable token, leave blank */ }
}
document.getElementById('server-url').value = window.location.origin;

function run() {
  const url  = document.getElementById('server-url').value.trim();
  const user = document.getElementById('server-username').value.trim();
  const pass = document.getElementById('server-password').value;
  const out  = document.getElementById('qr-output');

  if (!url || !user || !pass) {
    out.textContent = '';
    var ph1 = document.createElement('span');
    ph1.className = 'qr-placeholder';
    ph1.textContent = 'Fill in all fields to generate a QR code';
    out.appendChild(ph1);
    return;
  }

  try {
    // Encode as a deep-link URL so phone cameras open the mobile PWA directly.
    // The credentials are in the hash (never sent to server) for privacy.
    const hash = encodeURIComponent('|' + url + '|' + user + '|' + pass);
    const deepLink = url + '/mobile/#qr=' + hash;
    const QRC = qrcodegen.QrCode;
    const qr  = QRC.encodeText(deepLink, QRC.Ecc.MEDIUM);
    const svgText = qr.toSvgString(2).replace(/<\?xml[^?]*\?>\s*/i, '');
    const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svg = parsed.documentElement;
    out.textContent = '';
    if (svg && svg.nodeName.toLowerCase() === 'svg') {
      out.appendChild(svg);
    } else {
      var ph2 = document.createElement('span');
      ph2.className = 'qr-placeholder';
      ph2.textContent = 'Could not generate QR code';
      out.appendChild(ph2);
    }
  } catch(e) {
    out.textContent = '';
    var ph3 = document.createElement('span');
    ph3.className = 'qr-placeholder';
    ph3.textContent = 'Could not generate QR code';
    out.appendChild(ph3);
  }
}

document.getElementById('theme-btn').addEventListener('click', toggleTheme);
document.getElementById('regen-btn').addEventListener('click', run);
['server-url', 'server-username', 'server-password'].forEach(function(id) {
  document.getElementById(id).addEventListener('input', run);
});
run();
