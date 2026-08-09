#!/usr/bin/env node
/**
 * Build script — packages webapp/tizen/ into velvet-tv.wgt
 * A WGT file is a ZIP archive with .wgt extension.
 *
 * Usage:
 *   node scripts/build-tizen-wgt.cjs
 *
 * Output:
 *   dist/velvet-tv.wgt
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const SRC  = path.join(__dirname, '..', 'webapp', 'tizen');
const DIST = path.join(__dirname, '..', 'dist');
const OUT  = path.join(DIST, 'velvet-tv.wgt');

if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });

// Minimal ZIP builder (no compression for broad Tizen compat; STORE method)
function buildZip(entries) {
  const localHeaders = [];
  let offset = 0;
  const parts = [];

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const msdos = dateToDos(new Date());
    const crc = crc32(data);

    // Local file header
    const lh = Buffer.alloc(30 + nameBytes.length);
    lh.writeUInt32LE(0x04034b50, 0);  // signature
    lh.writeUInt16LE(20, 4);          // version needed (2.0)
    lh.writeUInt16LE(0, 6);           // flags
    lh.writeUInt16LE(0, 8);           // compression (STORE)
    lh.writeUInt16LE(msdos.time, 10);
    lh.writeUInt16LE(msdos.date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBytes.length, 26);
    lh.writeUInt16LE(0, 28);
    nameBytes.copy(lh, 30);

    localHeaders.push({ name, nameBytes, crc, size: data.length, offset, msdos });
    parts.push(lh, data);
    offset += lh.length + data.length;
  }

  // Central directory
  const cdParts = [];
  let cdSize = 0;
  const cdOffset = offset;

  for (const e of localHeaders) {
    const cd = Buffer.alloc(46 + e.nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0); // signature
    cd.writeUInt16LE(20, 4);          // version made by
    cd.writeUInt16LE(20, 6);          // version needed
    cd.writeUInt16LE(0, 8);           // flags
    cd.writeUInt16LE(0, 10);          // compression (STORE)
    cd.writeUInt16LE(e.msdos.time, 12);
    cd.writeUInt16LE(e.msdos.date, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.size, 20);
    cd.writeUInt32LE(e.size, 24);
    cd.writeUInt16LE(e.nameBytes.length, 28);
    cd.writeUInt16LE(0, 30);  // extra
    cd.writeUInt16LE(0, 32);  // comment
    cd.writeUInt16LE(0, 34);  // disk start
    cd.writeUInt16LE(0, 36);  // int attribs
    cd.writeUInt32LE(0, 38);  // ext attribs
    cd.writeUInt32LE(e.offset, 42);
    e.nameBytes.copy(cd, 46);
    cdParts.push(cd);
    cdSize += cd.length;
  }

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);   // disk num
  eocd.writeUInt16LE(0, 6);   // disk with cd
  eocd.writeUInt16LE(localHeaders.length, 8);
  eocd.writeUInt16LE(localHeaders.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);  // comment length

  return Buffer.concat([...parts, ...cdParts, eocd]);
}

function dateToDos(d) {
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { date, time };
}

function crc32(buf) {
  let crc = 0xffffffff;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })());
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Collect files (skip velvet-tv.config.json — build-time only)
function collectFiles(dir, base) {
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === 'velvet-tv.config.json') continue;
    const full = path.join(dir, name);
    const rel  = base ? base + '/' + name : name;
    if (fs.statSync(full).isDirectory()) {
      entries.push(...collectFiles(full, rel));
    } else {
      let data = fs.readFileSync(full);
      // Inject server URL into index.html meta tag
      if (rel === 'index.html') {
        let cfgUrl = '';
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(SRC, 'velvet-tv.config.json'), 'utf8'));
          cfgUrl = (cfg.serverUrl || '').trim();
        } catch (_) {}
        data = Buffer.from(data.toString('utf8').replace('__VELVET_SERVER_URL__', cfgUrl), 'utf8');
      }
      entries.push({ name: rel, data });
    }
  }
  return entries;
}

const entries = collectFiles(SRC, '');
const zip = buildZip(entries);
fs.writeFileSync(OUT, zip);

const kbSize = (zip.length / 1024).toFixed(1);
console.log('Built: dist/velvet-tv.wgt (' + kbSize + ' KB, ' + entries.length + ' files)');
for (const e of entries) console.log('  + ' + e.name + ' (' + e.data.length + ' B)');
