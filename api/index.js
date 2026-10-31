'use strict';

const crypto = require('crypto');
const path = require('path');
const { createApp } = require('../src/server');
const { createSupabaseStore } = require('../src/supabase-store');
const { redact, safeEq } = require('../src/util');

async function requestBody(req) {
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return req.body;
    return JSON.stringify(req.body);
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function writeResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  return response.arrayBuffer().then(body => res.end(Buffer.from(body)));
}

function sendFailure(res, error) {
  const conflict = error && error.code === '40001';
  const status = conflict ? 503 : Number(error && error.status) || 500;
  if (status >= 500) console.error('Vercel request failed:', redact(error && error.message));
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (conflict) res.setHeader('retry-after', '1');
  res.end(JSON.stringify({
    error: conflict ? 'Application data changed during this request; please retry' : redact(error && error.message || 'Internal server error')
  }));
}

module.exports = async function handler(req, res) {
  let store;
  let lockToken;
  try {
    store = createSupabaseStore(process.env);
    const url = new URL(req.url, 'https://' + (req.headers.host || 'localhost'));
    const routedPath = url.searchParams.get('__path');
    if (routedPath !== null) {
      url.searchParams.delete('__path');
      url.pathname = '/api/' + routedPath;
    }

    if (url.pathname === '/api/webhook') url.pathname = '/webhook';
    else if (url.pathname === '/api/auth/facebook/callback') url.pathname = '/auth/facebook/callback';
    else if (url.pathname.startsWith('/api/media/')) url.pathname = url.pathname.slice(4);

    if (url.pathname.startsWith('/api/media/')) {
      let name;
      try {
        name = decodeURIComponent(url.pathname.slice('/api/media/'.length));
      } catch {
        res.statusCode = 404;
        return res.end();
      }
      if (!name || path.basename(name) !== name || name.includes('\\')) {
        res.statusCode = 404;
        return res.end();
      }
      const image = await store.imageStore.get(name);
      if (!image) {
        res.statusCode = 404;
        return res.end();
      }
      res.statusCode = 200;
      res.setHeader('content-type', image.contentType || 'application/octet-stream');
      res.setHeader('cache-control', 'public, max-age=3600');
      return res.end(image.body);
    }

    const method = req.method || 'GET';
    const readOnly = ['GET', 'HEAD'].includes(method) ||
      (method === 'POST' && url.pathname === '/api/login');
    const requiresLock = !readOnly || url.pathname === '/auth/facebook/callback' || url.pathname === '/api/cron';

    async function acquireLock() {
      if (lockToken) return true;
      const token = crypto.randomUUID();
      if (!await store.acquire(token)) return false;
      lockToken = token;
      return true;
    }

    if (requiresLock && !await acquireLock()) {
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('retry-after', '2');
      return res.end(JSON.stringify({ error: 'The application is busy; retry shortly' }));
    }

    let { state, revision } = await store.load();
    if (readOnly && !state.seeded) {
      if (!await acquireLock()) {
        res.statusCode = 503;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('retry-after', '2');
        return res.end(JSON.stringify({ error: 'The application is busy; retry shortly' }));
      }
      ({ state, revision } = await store.load());
    }

    const before = JSON.parse(JSON.stringify(state));
    const app = createApp({
      env: process.env,
      initialData: state,
      imageStore: store.imageStore,
      noTimer: true,
      webWorker: true
    });

    if (url.pathname === '/api/cron') {
      const expected = process.env.CRON_SECRET;
      const supplied = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!expected || !safeEq(supplied, expected)) {
        res.statusCode = 401;
        return res.end('Unauthorized');
      }
      await app.engine.tick();
      await store.save(before, app.db.d, revision, lockToken);
      res.statusCode = 200;
      return res.end('ok');
    }

    const headers = new Headers(req.headers);
    for (const name of ['connection', 'content-length', 'host', 'transfer-encoding']) headers.delete(name);
    const body = ['GET', 'HEAD'].includes(method) ? undefined : await requestBody(req);
    const request = new Request(url, { method, headers, body: body && body.length ? body : undefined });
    const response = await app.fetch(request);
    if (lockToken) await store.save(before, app.db.d, revision, lockToken);
    return await writeResponse(res, response);
  } catch (error) {
    return sendFailure(res, error);
  } finally {
    if (store && lockToken) {
      try {
        await store.release(lockToken);
      } catch (error) {
        console.error('Failed to release Supabase application lock:', redact(error && error.message));
      }
    }
  }
};
