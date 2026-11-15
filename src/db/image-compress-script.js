import Joi from 'joi';
import fs from 'node:fs/promises';
import path from 'node:path';
import mime from 'mime-types';
import { writeArtWithThumbs } from '../util/art-cache.js';

let loadJson;
try {
  loadJson = JSON.parse(process.argv.at(-1), 'utf8');
} catch {
  console.error(`Warning: failed to parse JSON input`);
  process.exit(1);
}

// Validate input
const schema = Joi.object({
  albumArtDirectory: Joi.string().required(),
});

const { error: validationError } = schema.validate(loadJson);
if (validationError) {
  console.error(`Invalid JSON Input`);
  console.log(validationError);
  process.exit(1);
}

await run();

async function run() {
  let files;
  try {
    files = await fs.readdir(loadJson.albumArtDirectory);
  } catch (err) {
    console.log(err);
    process.exit(1);
  }

  for (const file of files) {
    let filepath;
    try {
      if (file.startsWith('zs-') || file.startsWith('zl-') || file.startsWith('zm-')) { continue; }
      const mimeType = mime.lookup(path.extname(file));
      if (!mimeType || !mimeType.startsWith('image')) { continue; }
      filepath = path.join(loadJson.albumArtDirectory, file);
      const stat = await fs.stat(filepath);
      if (stat.isDirectory()) { continue; }

      if (!await writeArtWithThumbs(loadJson.albumArtDirectory, await fs.readFile(filepath), file)) {
        console.log('error on file: ' + filepath + ' (could not decode, original copied as thumbnail)');
      }
    } catch (error) {
      console.log('error on file: ' + filepath);
      console.error(error);
    }
  }
}
