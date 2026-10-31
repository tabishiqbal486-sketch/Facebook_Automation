'use strict';

const COLLECTIONS = [
  'products', 'posts', 'customers', 'messages', 'decisions', 'questions',
  'knowledge', 'leads', 'quotes', 'orders', 'followups', 'jobs', 'events',
  'logs', 'pages', 'groups', 'reviews'
];

function emptyState() {
  const state = { version: 2, settings: {}, seeded: false, __backups: [] };
  for (const name of COLLECTIONS) state[name] = {};
  return state;
}

function recordsFromState(state) {
  const records = new Map();
  const add = (collection, id, data) => records.set(collection + '\0' + id, { collection, record_id: id, data });
  add('__meta', 'root', { version: state.version, settings: state.settings, seeded: state.seeded });
  for (const collection of COLLECTIONS) {
    for (const [id, data] of Object.entries(state[collection] || {})) add(collection, id, data);
  }
  for (const backup of state.__backups || []) add('__backups', backup.name, backup);
  return records;
}

function createSupabaseStore(env = process.env, fetchImpl = fetch) {
  const supabaseUrl = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = env.SUPABASE_STORAGE_BUCKET || 'product-images';
  if (!supabaseUrl || !serviceKey) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(supabaseUrl);
  } catch {
    throw new Error('SUPABASE_URL must be a valid HTTPS URL');
  }
  if (parsedUrl.protocol !== 'https:') throw new Error('SUPABASE_URL must use HTTPS');

  async function request(path, options = {}) {
    const response = await fetchImpl(supabaseUrl + path, {
      ...options,
      headers: {
        apikey: serviceKey,
        authorization: 'Bearer ' + serviceKey,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers
      }
    });
    const text = await response.text();
    let result = null;
    if (text) {
      try {
        result = JSON.parse(text);
      } catch {
        throw new Error('Supabase returned an invalid response');
      }
    }
    if (!response.ok) {
      const error = new Error('Supabase request failed (' + response.status + ')');
      error.status = response.status;
      error.code = result && result.code;
      throw error;
    }
    return result;
  }

  async function load() {
    const snapshot = await request('/rest/v1/rpc/load_app_state', {
      method: 'POST',
      body: '{}'
    });
    if (!snapshot || !Array.isArray(snapshot.records) || !Number.isInteger(Number(snapshot.revision))) {
      throw new Error('Supabase returned an invalid application snapshot');
    }
    const state = emptyState();
    for (const row of snapshot.records) {
      if (row.collection === '__meta' && row.record_id === 'root') {
        state.version = row.data.version || 2;
        state.settings = row.data.settings || {};
        state.seeded = !!row.data.seeded;
      } else if (row.collection === '__backups') {
        state.__backups.push(row.data);
      } else if (Object.prototype.hasOwnProperty.call(state, row.collection)) {
        state[row.collection][row.record_id] = row.data;
      }
    }
    state.__backups.sort((a, b) => a.name.localeCompare(b.name));
    return { state, revision: Number(snapshot.revision) };
  }

  async function acquire(lockToken) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const acquired = await request('/rest/v1/rpc/acquire_app_lock', {
        method: 'POST',
        body: JSON.stringify({ p_lock_token: lockToken, p_lease_seconds: 120 })
      });
      if (acquired === true) return true;
      if (attempt < 19) await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  }

  async function release(lockToken) {
    await request('/rest/v1/rpc/release_app_lock', {
      method: 'POST',
      body: JSON.stringify({ p_lock_token: lockToken })
    });
  }

  async function save(before, state, revision, lockToken) {
    const oldRecords = recordsFromState(before);
    const newRecords = recordsFromState(state);
    const upserts = [];
    const deletes = [];
    for (const [key, record] of newRecords) {
      const old = oldRecords.get(key);
      if (!old || JSON.stringify(old.data) !== JSON.stringify(record.data)) upserts.push(record);
    }
    for (const [key, record] of oldRecords) {
      if (!newRecords.has(key)) deletes.push({ collection: record.collection, record_id: record.record_id });
    }
    if (upserts.length === 0 && deletes.length === 0) return revision;
    const next = await request('/rest/v1/rpc/commit_app_state', {
      method: 'POST',
      body: JSON.stringify({
        p_expected_revision: revision,
        p_upserts: upserts,
        p_deletes: deletes,
        p_lock_token: lockToken
      })
    });
    if (!Number.isInteger(Number(next))) throw new Error('Supabase returned an invalid write revision');
    return Number(next);
  }

  const imageStore = {
    async put(name, body, contentType) {
      await request('/storage/v1/object/' + encodeURIComponent(bucket) + '/' + encodeURIComponent(name), {
        method: 'POST',
        headers: { 'content-type': contentType, 'x-upsert': 'true' },
        body
      });
    },
    async delete(name) {
      await request('/storage/v1/object/' + encodeURIComponent(bucket) + '/' + encodeURIComponent(name), {
        method: 'DELETE'
      });
    },
    async get(name) {
      const response = await fetchImpl(
        supabaseUrl + '/storage/v1/object/public/' + encodeURIComponent(bucket) + '/' + encodeURIComponent(name),
        { method: 'GET' }
      );
      if (response.status === 404) return null;
      if (!response.ok) throw new Error('Supabase image request failed (' + response.status + ')');
      return {
        body: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get('content-type')
      };
    }
  };

  return { acquire, load, release, save, imageStore };
}

module.exports = { createSupabaseStore };
