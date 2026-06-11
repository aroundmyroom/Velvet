import fs from 'node:fs';
import https from 'node:https';

let loadJson;
try {
  loadJson = JSON.parse(process.argv.at(-1), 'utf8');
} catch (error) {
  console.error(`Warning: failed to parse JSON input`);
  console.error(error);
  process.exit(1);
}

// check if files exist
if (!fs.existsSync(loadJson.cert) || !fs.existsSync(loadJson.key)) {
  process.exit(1);
}

try {
  https.createServer({
    key: fs.readFileSync(loadJson.key),
    cert: fs.readFileSync(loadJson.cert)
  });
} catch (error) {
  console.error(error);
  process.exit(1);
}
