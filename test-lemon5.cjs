const jwt = require('jsonwebtoken');
const https = require('https');
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('/home/velvet/save/conf/default.json', 'utf8'));

const token = jwt.sign({ username: 'lemon' }, cfg.secret);

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'music.aroundtheworld.net', port: 3000, path, method: 'POST',
      headers: { 'x-access-token': token, 'content-type': 'application/json', 'content-length': data.length },
      rejectUnauthorized: false
    };
    const req = https.request(opts, r => {
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(b) }));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function main() {
  // Find a file in 12-inches vpath
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('/home/velvet/save/db/velvet.sqlite');
  const row = db.prepare(`SELECT vpath, filepath FROM files WHERE filepath LIKE '12 inches A-Z/%' LIMIT 1`).get();
  if (!row) { console.log('No 12-inches files found'); return; }
  
  const fp = row.vpath + '/' + row.filepath;
  console.log('Testing file:', fp);
  
  // Test metadata endpoint
  const meta = await post('/api/v1/db/metadata', { filepath: fp });
  console.log('metadata status:', meta.status, 'has metadata:', !!meta.body?.metadata);
  
  // Test waveform endpoint
  const wave = await post('/api/v1/db/waveform', { filepath: fp });
  console.log('waveform status:', wave.status);
  
  // Test that a Disco file is blocked
  const disco = db.prepare(`SELECT vpath, filepath FROM files WHERE filepath LIKE 'Disco/%' LIMIT 1`).get();
  if (disco) {
    const discoFp = disco.vpath + '/' + disco.filepath;
    const discoMeta = await post('/api/v1/db/metadata', { filepath: discoFp });
    console.log('Disco file blocked (expect 500 or no metadata):', discoMeta.status, JSON.stringify(discoMeta.body).slice(0, 100));
  }
}

main().catch(console.error);
