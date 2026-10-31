'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DB } = require('../src/db');
const { createSupabaseStore } = require('../src/supabase-store');

function loadLocalEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith('#') || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

async function main() {
  const root = path.resolve(__dirname, '..');
  loadLocalEnv(path.join(root, '.env.local'));
  const dbFile = path.resolve(process.argv[2] || path.join(root, 'data', 'db.json'));
  if (!fs.existsSync(dbFile)) throw new Error('Local database file not found: ' + dbFile);

  const localState = new DB(path.dirname(dbFile), { initialData: JSON.parse(fs.readFileSync(dbFile, 'utf8')) });
  const store = createSupabaseStore(process.env);
  const lockToken = crypto.randomUUID();
  if (!await store.acquire(lockToken)) throw new Error('Could not get the Supabase database lock; retry shortly');
  try {
    const remote = await store.load();
    const remoteCount = remote.state.__backups.length + Object.values(remote.state).reduce((count, value) =>
      count + (value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : 0), 0);
    if (remote.revision !== 0 || remoteCount !== 0) {
      throw new Error('Supabase already contains app data; import stopped to avoid overwriting it');
    }

    const imagesDir = path.join(path.dirname(dbFile), 'images');
    let uploaded = 0;
    if (fs.existsSync(imagesDir)) {
      const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
      for (const name of fs.readdirSync(imagesDir)) {
        const type = types[path.extname(name).toLowerCase()];
        if (!type) continue;
        await store.imageStore.put(name, fs.readFileSync(path.join(imagesDir, name)), type);
        uploaded++;
      }
    }

    await store.save(remote.state, localState.d, remote.revision, lockToken);
    console.log('Imported the local database and ' + uploaded + ' image(s) into Supabase.');
    console.log('Keep .env.local and your local data backup private.');
  } finally {
    await store.release(lockToken);
  }
}

main().catch(error => {
  console.error('Supabase import failed:', error.message);
  process.exitCode = 1;
});
