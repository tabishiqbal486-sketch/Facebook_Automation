'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const U = require('./util'), { DB } = require('./db'), { Meta, parseWebhook } = require('./meta'), { Engine, STAGES } = require('./engine'), { price } = require('./brain');
const { uid, now, gbp, toPence, normPostcode, safeEq } = U;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const bad = (m, c) => Object.assign(new Error(m), { status: c || 400 });
function secretFile(dir, name, make) { const f = path.join(dir, name); if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim(); const v = make(); fs.writeFileSync(f, v, { mode: 0o600 }); return v; }
const slug = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
const list = x => Array.isArray(x) ? x.map(s => String(s).trim()).filter(Boolean) : String(x || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);

function seed(db) {
  const s = db.settings; if (db.d.seeded) return; db.d.seeded = true;
  Object.assign(s.business, { phone: '+44 7723 149286', location: 'Birmingham', delivery_text: 'Fast delivery in 1-2 days, free across the UK', payment_text: 'Cash on Delivery: you can inspect the furniture at home before you pay', visit_text: 'If you would like to visit, please send us your name and phone number and we will arrange a time' });
  db.put('products', { id: 'prod_dylan', sku: 'DYLAN-SOFA', name: 'Dylan Sofa', category: 'Sofas', price_pence: 34900, sale_price_pence: null, lowest_price_pence: 29900, description: '', specs: [], colours: [], images: [], stock: 'unknown', keywords: ['dylan'], addons: [{ name: 'Matching stool', price_pence: 5000 }], faqs: [], delivery_note: '', archived: false, created: now(), updated: now() });
  db.log('system', 'First run: starting business details and the Dylan Sofa were added from your earlier instructions'); db.save();
}
function productFrom(b, old) {
  const p = Object.assign({}, old || { id: uid('prod'), images: [], archived: false, created: now(), faqs: [] });
  if (b.name !== undefined) { if (!String(b.name).trim()) throw bad('Product name is required'); p.name = String(b.name).trim().slice(0, 120); }
  if (!p.name) throw bad('Product name is required');
  for (const [k, f] of [['price', 'price_pence'], ['sale_price', 'sale_price_pence'], ['lowest_price', 'lowest_price_pence']]) if (b[k] !== undefined) { const v = toPence(b[k]); if (Number.isNaN(v)) throw bad('Invalid ' + k.replace('_', ' ') + ' (use a positive amount such as 349 or £349)'); p[f] = v; }
  if (p.sale_price_pence != null && p.price_pence != null && p.sale_price_pence >= p.price_pence) throw bad('The sale price must be lower than the normal price');
  if (p.lowest_price_pence != null && p.price_pence != null && p.lowest_price_pence > p.price_pence) throw bad('The lowest price cannot be higher than the price');
  if (b.sku !== undefined || !p.sku) p.sku = String(b.sku || slug(p.name) || uid('SKU')).trim().toUpperCase();
  if (b.category !== undefined) p.category = String(b.category).trim().slice(0, 60);
  for (const k of ['description', 'delivery_note']) if (b[k] !== undefined) p[k] = String(b[k]).slice(0, 2000);
  if (b.specs !== undefined) p.specs = list(b.specs); if (b.colours !== undefined) p.colours = list(b.colours); if (b.keywords !== undefined) p.keywords = list(b.keywords).map(x => x.toLowerCase());
  if (b.stock !== undefined) { if (!['in_stock', 'out_of_stock', 'unknown'].includes(b.stock)) throw bad('Stock must be in_stock, out_of_stock or unknown'); p.stock = b.stock; } if (!p.stock) p.stock = 'unknown';
  if (b.addons !== undefined) p.addons = (b.addons || []).filter(a => a && a.name).map(a => { const v = toPence(a.price); if (v === null || Number.isNaN(v)) throw bad('Invalid add-on price'); return { name: String(a.name).trim(), price_pence: v }; });
  if (b.faqs !== undefined) p.faqs = (b.faqs || []).filter(f => f && f.q && f.a).map(f => ({ q: String(f.q).trim(), a: String(f.a).trim() }));
  if (b.archived !== undefined) p.archived = !!b.archived; p.updated = now(); return p;
}
function createApp(o = {}) {
  const env = o.env || process.env, dataDir = o.dataDir || path.join(process.cwd(), 'data'), memoryMode = Object.prototype.hasOwnProperty.call(o, 'initialData');
  if (!memoryMode) fs.mkdirSync(dataDir, { recursive: true });
  const adminKey = env.ADMIN_KEY || (memoryMode ? '' : secretFile(dataDir, 'admin.key', () => crypto.randomBytes(18).toString('base64url'))), adminFrom = env.ADMIN_KEY ? 'environment' : 'data/admin.key';
  const secret = env.SECRET_KEY || (memoryMode ? '' : secretFile(dataDir, 'secret.key', () => crypto.randomBytes(32).toString('hex')));
  if (adminKey.length < 12) throw new Error('ADMIN_KEY must be at least 12 characters');
  if (!secret) throw new Error('SECRET_KEY is required when using an external persistent database');
  const db = o.db || new DB(dataDir, memoryMode ? { initialData: o.initialData } : {}); seed(db);
  const meta = new Meta({ base: env.GRAPH_BASE, version: env.GRAPH_VERSION, appId: env.APP_ID, appSecret: env.APP_SECRET });
  const engine = new Engine(db, meta, { secret, baseUrl: env.BASE_URL, fast: !!o.fast });
  const pub = o.publicDir || path.join(__dirname, '..', 'public'), states = new Map(), fails = new Map(), routes = [];
  const R = (m, p, h, open) => routes.push({ m, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), h, open });
  const ids = (c) => (r) => db.get(c, r.params.id);
  // ---------- status / dashboard ----------
  const pageView = p => ({ id: p.id, name: p.name, token_status: p.token_status, connected_at: p.connected_at });
  R('POST', '/api/login', r => {
    const supplied = r.body.key || (r.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!safeEq(supplied, adminKey)) throw bad('Wrong key', 401);
    return { ok: true, key_source: adminFrom };
  }, true);
  R('GET', '/api/status', () => {
    const jobs = db.list('jobs'), cnt = s => jobs.filter(j => j.status === s).length, ev = db.list('events').sort((a, b) => b.ts - a.ts)[0];
    return { live: db.settings.live, autopilot: db.settings.autopilot, pages: db.list('pages').map(pageView), config: { graph_version: !!env.GRAPH_VERSION, app_id: !!env.APP_ID, app_secret: !!env.APP_SECRET, base_url: !!env.BASE_URL, verify_token: !!env.VERIFY_TOKEN, admin_key_source: adminFrom },
     meta_ready: meta.configured, last_event_at: ev ? ev.ts : null, jobs: { pending: cnt('pending'), done: cnt('done'), failed: cnt('failed'), cancelled: cnt('cancelled') }, failed: jobs.filter(j => j.status === 'failed').sort((a, b) => b.finished - a.finished).slice(0, 15).map(j => ({ id: j.id, type: j.type, error: j.error, text: (j.payload.text || j.payload.file || '').slice(0, 120), customer: (db.get('customers', j.customer_id) || {}).name, finished: j.finished, attempts: j.attempts })),
     caps: { replies_last_hour: jobs.filter(j => j.origin === 'auto' && j.status === 'done' && j.finished > now() - 3600e3).length, limit_hour: db.settings.caps.repliesPerHour, dms_today: jobs.filter(j => j.origin === 'auto' && j.status === 'done' && ['dm', 'private_reply'].includes(j.type) && j.finished > now() - 864e5).length, limit_day: db.settings.caps.dmsPerDay }, db: { version: db.d.version, bytes: db.file && fs.existsSync(db.file) ? fs.statSync(db.file).size : 0, last_backup: db.backups()[0] || null, recovered_from: db.recovered }, time: now() };
  });
  R('GET', '/api/bootstrap', () => ({
    products: db.list('products').filter(p => !p.archived).map(p => Object.assign({}, p, {
      posts: db.filter('posts', x => x.product_ids.includes(p.id)).map(x => x.post_id)
    })).sort((a, b) => a.name.localeCompare(b.name)),
    settings: db.settings,
    open_questions: db.filter('questions', q => q.status === 'open').length
  }));
  
  // Updated Dashboard API with Page Filter Support
  R('GET', '/api/dashboard', r => {
    const pageId = r.query.pageId || 'all';
    const cs = db.list('customers').filter(c => !c.merged_into), today = new Date().setHours(0, 0, 0, 0), msgs = db.list('messages');
    
    // Filter logic if specific page is selected
    const filterPage = items => pageId === 'all' ? items : items.filter(i => i.page_id === pageId);

    return {
      open_questions: filterPage(db.list('questions')).filter(q => q.status === 'open').length,
      new_enquiries: filterPage(db.list('leads')).filter(l => l.stage === 'new_enquiry').length,
      leads_active: filterPage(db.list('leads')).filter(l => !['won', 'lost'].includes(l.stage)).length,
      orders: Object.fromEntries(['new', 'confirmed', 'dispatched', 'delivered', 'cancelled'].map(s => [s, filterPage(db.list('orders')).filter(o => o.order_status === s).length])),
      orders_to_review: filterPage(db.list('orders')).filter(o => o.needs_review && o.order_status === 'new').length,
      messages_in_today: filterPage(msgs).filter(m => m.direction === 'in' && m.ts >= today).length,
      comments_today: filterPage(msgs).filter(m => m.direction === 'in' && m.channel === 'comment' && m.ts >= today).length,
      replies_sent_today: filterPage(msgs).filter(m => m.direction === 'out' && m.status === 'sent' && m.sent_at >= today).length,
      replies_dry_today: filterPage(msgs).filter(m => m.direction === 'out' && ['dry_run', 'simulated'].includes(m.status) && m.sent_at >= today).length,
      failed_jobs: filterPage(db.list('jobs')).filter(j => j.status === 'failed').length,
      customers: cs.length,
      products: db.filter('products', p => !p.archived).length,
      followups_manual: filterPage(db.list('followups')).filter(f => f.status === 'manual').length,
      recent: filterPage(db.list('logs')).sort((a, b) => b.ts - a.ts).slice(0, 12)
    };
  });

  // ---------- catalogue ----------
  R('GET', '/api/products', r => { const q = (r.query.q || '').toLowerCase(), arch = r.query.archived === '1'; return db.list('products').filter(p => !!p.archived === arch && (!q || [p.name, p.sku, p.category, (p.keywords || []).join(' ')].join(' ').toLowerCase().includes(q))).map(p => Object.assign({}, p, { posts: db.filter('posts', x => x.product_ids.includes(p.id)).map(x => x.post_id) })).sort((a, b) => a.name.localeCompare(b.name)); });
  R('POST', '/api/products', r => { const p = productFrom(r.body); if (db.find('products', x => x.sku === p.sku && !x.archived)) throw bad('SKU ' + p.sku + ' already exists'); db.put('products', p); db.log('catalogue', 'Added ' + p.name, p.id); db.save(); return p; });
  R('PUT', '/api/products/:id', r => { const old = ids('products')(r); if (!old) throw bad('Not found', 404); const p = productFrom(r.body, old); if (db.find('products', x => x.sku === p.sku && x.id !== p.id && !x.archived)) throw bad('SKU ' + p.sku + ' already exists'); db.put('products', p); db.log('catalogue', 'Updated ' + p.name + (old.price_pence !== p.price_pence ? ' (price ' + gbp(old.price_pence) + ' to ' + gbp(p.price_pence) + ')' : ''), p.id); db.save(); return p; });
  R('POST', '/api/products/:id/archive', r => { const p = ids('products')(r); if (!p) throw bad('Not found', 404); p.archived = r.body.archived !== false; p.updated = now(); db.log('catalogue', (p.archived ? 'Archived ' : 'Restored ') + p.name, p.id); db.save(); return p; });
  R('POST', '/api/products/:id/images', async r => {
    const p = ids('products')(r); if (!p) throw bad('Not found', 404); if (p.images.length >= 10) throw bad('A product can have up to 10 photos');
    const m = String(r.body.data || '').match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/); if (!m) throw bad('Send a JPEG, PNG or WebP image'); const buf = Buffer.from(m[2], 'base64'); if (buf.length > 5e6) throw bad('Photo is too large (max 5 MB)');
    const ok = (m[1] === 'jpeg' && buf[0] === 0xff && buf[1] === 0xd8) || (m[1] === 'png' && buf[0] === 0x89 && buf[1] === 0x50) || (m[1] === 'webp' && buf.subarray(8, 12).toString() === 'WEBP'); if (!ok) throw bad('That file is not a real ' + m[1].toUpperCase() + ' image');
    const f = crypto.randomBytes(12).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
    if (o.imageStore) await o.imageStore.put(f, buf, MIME['.' + (m[1] === 'jpeg' ? 'jpg' : m[1])]);
    else fs.writeFileSync(path.join(dataDir, 'images', f), buf);
    p.images.push(f); p.updated = now(); db.save(); return p;
  });
  R('DELETE', '/api/products/:id/images/:file', async r => { const p = ids('products')(r); if (!p) throw bad('Not found', 404); const f = path.basename(r.params.file); if (!p.images.includes(f)) throw bad('Photo not found', 404); p.images = p.images.filter(x => x !== f); if (o.imageStore) await o.imageStore.delete(f); else { try { fs.unlinkSync(path.join(dataDir, 'images', f)); } catch (e) { /* already gone */ } } db.save(); return p; });
  R('POST', '/api/products/:id/cover', r => { const p = ids('products')(r); const f = path.basename(String(r.body.file || '')); if (!p || !p.images.includes(f)) throw bad('Photo not found', 404); p.images = [f].concat(p.images.filter(x => x !== f)); db.save(); return p; });
  // ---------- post to product mapping ----------
  R('GET', '/api/posts', () => db.list('posts').map(x => Object.assign({}, x, { products: x.product_ids.map(id => (db.get('products', id) || {}).name) })).sort((a, b) => b.created - a.created));
  R('POST', '/api/posts', r => { const pid = String(r.body.post_id || '').trim(); if (!pid) throw bad('Facebook post ID is required'); const pr = list(r.body.product_ids); if (!pr.length || pr.some(i => !db.get('products', i))) throw bad('Choose existing products'); const ex = db.find('posts', x => x.post_id === pid); const rec = ex || { id: uid('post'), post_id: pid, page_id: r.body.page_id || null, caption: '', created: now() }; Object.assign(rec, { product_ids: pr, verified: true, source: 'owner' }); db.put('posts', rec); db.log('catalogue', 'Mapped post ' + pid + ' to ' + pr.length + ' product(s)', rec.id); db.save(); return rec; });
  R('DELETE', '/api/posts/:id', r => { db.del('posts', r.params.id); db.save(); return { ok: true }; });
  R('POST', '/api/posts/draft', r => { const p = db.get('products', r.body.product_id); if (!p) throw bad('Choose a product'); const b = db.settings.business, parts = [p.name + (p.price_pence != null ? ' - ' + gbp(p.sale_price_pence != null ? p.sale_price_pence : p.price_pence) : '')]; if (p.description) parts.push(p.description); if (p.colours.length) parts.push('Available in: ' + p.colours.join(', ')); if (b.delivery_text) parts.push(b.delivery_text); if (b.payment_text) parts.push(b.payment_text); if (b.phone) parts.push('WhatsApp: ' + b.phone); return { caption: parts.join('\n\n'), images: p.images, warnings: [p.price_pence == null ? 'This product has no price' : null, !p.images.length ? 'This product has no photos' : null, !p.description ? 'No description in the catalogue' : null].filter(Boolean) }; });
  R('POST', '/api/posts/publish', r => {
    if (!r.body.confirm) throw bad('Please preview and confirm before publishing'); const page = db.get('pages', r.body.page_id) || (db.settings.live ? null : { id: 'dry' }); if (!page) throw bad('Choose a connected Page'); const text = String(r.body.caption || '').trim(); if (!text) throw bad('Caption is empty');
    const prods = list(r.body.product_ids).map(i => db.get('products', i)); if (prods.some(p => !p)) throw bad('Product not found');
    const soon = now() + (engine.fast ? 20 : 1000), when = r.body.when ? Math.max(soon, +r.body.when) : soon; const j = engine.addJob({ type: 'publish_post', key: null, due_at: when, origin: 'owner', customer_id: 'none', page_id: page.id, payload: { text, files: prods.flatMap(p => p.images.slice(0, 3)), product_ids: prods.map(p => p.id) } });
    db.log('post', (db.settings.live ? 'Post queued' : 'Post recorded in dry-run mode (not published)') + ': ' + text.slice(0, 50), j.id); db.save(); return { job: j, live: db.settings.live };
  });
  // ---------- customers ----------
  const cview = c => Object.assign({}, c, { psid: undefined });
  R('GET', '/api/customers', r => { const q = (r.query.q || '').toLowerCase(); return db.list('customers').filter(c => !c.merged_into && (!q || [c.name, c.phone, c.address.postcode, c.address.line1].join(' ').toLowerCase().includes(q))).map(c => { const ms = engine.messagesOf(c.id), last = ms[ms.length - 1], l = engine.openLead(c.id); return { id: c.id, name: c.name || c.platform_id, platform: c.platform, postcode: c.address.postcode, last_text: last ? last.text.slice(0, 70) : '', last_ts: last ? last.ts : c.last_seen, stage: l ? l.stage : null, open_questions: db.filter('questions', x => x.customer_id === c.id && x.status === 'open').length, opt_out: c.opt_out }; }).sort((a, b) => b.last_ts - a.last_ts).slice(0, 200); });
  R('GET', '/api/customers/:id', r => { const c = ids('customers')(r); if (!c || c.merged_into) throw bad('Not found', 404); const l = engine.openLead(c.id), pids = [l && l.product_id].concat(engine.messagesOf(c.id).map(m => m.product_id)).filter(Boolean), pr = db.get('products', pids[0] || ''); return { customer: cview(c), messages: engine.messagesOf(c.id).slice(-80), lead: l, product: pr ? { id: pr.id, name: pr.name, price_pence: price(pr) } : null, orders: db.filter('orders', o => o.customer_id === c.id), quotes: db.filter('quotes', x => x.customer_id === c.id), followups: db.filter('followups', f => f.customer_id === c.id), questions: db.filter('questions', q => q.customer_id === c.id && q.status === 'open') }; });
  R('PUT', '/api/customers/:id', r => {
    const c = ids('customers')(r); if (!c) throw bad('Not found', 404); const b = r.body, a = b.address || {};
    if (b.name !== undefined) c.name = String(b.name).trim().slice(0, 80); if (b.notes !== undefined) c.notes = String(b.notes).slice(0, 2000); if (b.preferences !== undefined) c.preferences = String(b.preferences).slice(0, 1000); if (b.email !== undefined) c.email = String(b.email).trim().slice(0, 120);
    if (b.phone !== undefined) { const ph = String(b.phone).replace(/[^0-9+]/g, ''); if (ph && ph.length < 10) throw bad('Phone number looks too short'); const dup = ph && db.find('customers', x => x.id !== c.id && !x.merged_into && x.phone === ph); if (dup && !b.allow_duplicate) { const e = bad('Another customer already has this phone number', 409); e.extra = { duplicate: { id: dup.id, name: dup.name } }; throw e; } c.phone = ph; }
    if (a.postcode !== undefined) { if (a.postcode === '') c.address.postcode = ''; else { const pc = normPostcode(a.postcode); if (!pc) throw bad('That is not a valid UK postcode (example: M14 5TQ)'); c.address.postcode = pc; } }
    for (const k of ['line1', 'line2', 'city']) if (a[k] !== undefined) c.address[k] = String(a[k]).trim().slice(0, 120);
    if (b.opt_out !== undefined) { c.opt_out = !!b.opt_out; if (c.opt_out) for (const f of db.filter('followups', f => f.customer_id === c.id && f.status === 'pending')) f.status = 'skipped'; }
    db.log('customer', 'Updated ' + (c.name || c.id), c.id); db.save(); return cview(c);
  });
  R('POST', '/api/customers/:id/merge', r => cview(engine.mergeCustomers(r.params.id, r.body.into)));
  R('POST', '/api/customers/:id/message', r => { const c = ids('customers')(r); if (c && c.opt_out) throw bad('This customer asked not to be messaged', 409); return engine.sendManual(r.params.id, r.body.text); });
  // ---------- questions & knowledge ----------
  R('GET', '/api/questions', r => db.list('questions').filter(q => !r.query.status || q.status === r.query.status).sort((a, b) => (b.kind === 'complaint') - (a.kind === 'complaint') || b.created - a.created).map(q => {
    const c = db.get('customers', q.customer_id), ms = engine.messagesOf(q.customer_id).filter(m => m.ts <= (db.get('messages', q.message_id) || { ts: Infinity }).ts).slice(-6), po = q.post_id && db.find('posts', x => x.post_id === q.post_id);
    return Object.assign({}, q, { customer: c ? { id: c.id, name: c.name || c.platform_id } : null, context: ms.map(m => ({ dir: m.direction, text: m.text, ts: m.ts, channel: m.channel })), product: q.product_id ? (db.get('products', q.product_id) || {}).name : null, candidate_products: (q.candidates || []).map(i => { const p = db.get('products', i); return p && { id: p.id, name: p.name, price_pence: price(p) }; }).filter(Boolean), post: po ? { post_id: po.post_id, caption: po.caption, products: po.product_ids.map(i => (db.get('products', i) || {}).name) } : (q.post_id ? { post_id: q.post_id, caption: '', products: [] } : null), suggested_keywords: U.tokens(q.text).slice(0, 6) });
  }));
  R('POST', '/api/questions/:id/answer', r => engine.answerQuestion(r.params.id, r.body));
  R('POST', '/api/questions/:id/dismiss', r => engine.answerQuestion(r.params.id, { dismiss: true }));
  const kview = k => Object.assign({}, k, { product: k.product_id ? (db.get('products', k.product_id) || {}).name : null });
  R('GET', '/api/knowledge', r => { const q = (r.query.q || '').toLowerCase(); return db.list('knowledge').filter(k => !q || (k.keywords.join(' ') + ' ' + k.answer).toLowerCase().includes(q)).sort((a, b) => b.created - a.created).map(kview); });
  R('POST', '/api/knowledge', r => { const b = r.body, kws = list(b.keywords).map(x => x.toLowerCase()); if (!kws.length || !String(b.answer || '').trim()) throw bad('Keywords and an answer are needed'); if (b.product_id && !db.get('products', b.product_id)) throw bad('Product not found'); const k = db.put('knowledge', { id: uid('kn'), status: 'approved', kind: 'reply', keywords: kws, intent: b.intent || null, product_id: b.product_id || null, post_id: null, answer: String(b.answer).trim(), source_question: null, created: now(), uses: 0 }); db.log('correction', 'Knowledge added by owner: ' + kws.join(' '), k.id); db.save(); return kview(k); });
  R('PUT', '/api/knowledge/:id', r => { const k = ids('knowledge')(r); if (!k) throw bad('Not found', 404); const b = r.body; if (b.keywords !== undefined) { const kws = list(b.keywords).map(x => x.toLowerCase()); if (!kws.length) throw bad('Keep at least one keyword'); k.keywords = kws; } if (b.answer !== undefined) k.answer = String(b.answer).trim(); if (b.status !== undefined) k.status = b.status === 'approved' ? 'approved' : 'disabled'; if (b.product_id !== undefined) k.product_id = b.product_id || null; db.log('correction', 'Knowledge edited: ' + k.keywords.join(' '), k.id); db.save(); return kview(k); });
  R('DELETE', '/api/knowledge/:id', r => { const k = ids('knowledge')(r); if (!k) throw bad('Not found', 404); db.del('knowledge', k.id); db.log('correction', 'Knowledge deleted: ' + k.keywords.join(' '), k.id); db.save(); return { ok: true }; });
  // ---------- leads / quotes / orders / follow-ups ----------
  R('GET', '/api/leads', r => db.list('leads').filter(l => !r.query.stage || l.stage === r.query.stage).map(l => { const c = db.get('customers', l.customer_id), p = db.get('products', l.product_id || ''); return Object.assign({}, l, { customer: c ? { id: c.id, name: c.name || c.platform_id, postcode: c.address.postcode, phone: c.phone } : null, product: p ? p.name : null }); }).sort((a, b) => b.updated - a.updated));
  R('PUT', '/api/leads/:id', r => { const l = ids('leads')(r); if (!l) throw bad('Not found', 404); const b = r.body; if (b.stage !== undefined) { if (!STAGES.includes(b.stage)) throw bad('Unknown stage'); l.stage = b.stage; } if (b.follow_up_at !== undefined) l.follow_up_at = b.follow_up_at ? +b.follow_up_at : null; if (b.notes !== undefined) l.notes = String(b.notes).slice(0, 2000); l.updated = now(); db.log('lead', 'Lead ' + l.id + ' set to ' + l.stage, l.id); db.save(); return l; });
  R('POST', '/api/leads', r => { const c = db.get('customers', r.body.customer_id); if (!c) throw bad('Customer not found'); const l = db.put('leads', { id: uid('lead'), customer_id: c.id, product_id: r.body.product_id || null, stage: 'new_enquiry', quoted_pence: null, follow_up_at: null, notes: '', source: 'manual', created: now(), updated: now(), offered: false }); db.save(); return l; });
  R('GET', '/api/quotes', () => db.list('quotes').sort((a, b) => b.created - a.created));
  R('POST', '/api/quotes', r => engine.createQuote(r.body));
  R('POST', '/api/quotes/:id/send', r => { const q = ids('quotes')(r); if (!q) throw bad('Not found', 404); const j = engine.sendManual(q.customer_id, engine.quoteText(q)); q.status = 'sent'; const l = q.lead_id && db.get('leads', q.lead_id); if (l) { l.stage = 'price_quoted'; l.quoted_pence = q.total_pence; l.updated = now(); } db.save(); return j; });
  R('GET', '/api/orders', r => db.list('orders').map(o => { const c = db.get('customers', o.customer_id); return Object.assign({}, o, { customer: c ? { id: c.id, name: c.name || c.platform_id, phone: c.phone } : null }); }).sort((a, b) => b.created - a.created));
  R('POST', '/api/orders', r => engine.createOrder(r.body));
  R('PUT', '/api/orders/:id', r => engine.updateOrder(r.params.id, r.body));
  R('GET', '/api/followups', () => db.list('followups').sort((a, b) => b.due_at - a.due_at).map(f => Object.assign({}, f, { customer: (db.get('customers', f.customer_id) || {}).name })));
  R('POST', '/api/followups/:id/done', r => { const f = ids('followups')(r); if (!f) throw bad('Not found', 404); f.status = 'sent'; f.reason = 'Marked as sent by owner'; db.save(); return f; });
  R('POST', '/api/followups/:id/skip', r => { const f = ids('followups')(r); if (!f) throw bad('Not found', 404); f.status = 'skipped'; f.reason = 'Skipped by owner'; db.save(); return f; });
  // ---------- jobs ----------
  R('GET', '/api/jobs', r => db.list('jobs').filter(j => !r.query.status || j.status === r.query.status).sort((a, b) => b.created - a.created).slice(0, 200).map(j => Object.assign({}, j, { customer: (db.get('customers', j.customer_id) || {}).name })));
  R('POST', '/api/jobs/:id/retry', r => { const j = ids('jobs')(r); if (!j || j.status !== 'failed') throw bad('Only failed jobs can be retried', 409); j.status = 'pending'; j.attempts = 0; j.due_at = now() + 10; j.error = null; db.save(); return j; });
  R('POST', '/api/jobs/:id/cancel', r => { const j = ids('jobs')(r); if (!j || j.status !== 'pending') throw bad('Only waiting jobs can be cancelled', 409); j.status = 'cancelled'; j.error = 'Cancelled by owner'; const m = j.message_id && db.get('messages', j.message_id); if (m) m.status = 'cancelled'; db.save(); return j; });
  R('POST', '/api/tick', async () => { await engine.tick(); return { ok: true }; });
  // ---------- settings ----------
  R('GET', '/api/settings', () => db.settings);
  R('PUT', '/api/settings', r => {
    const b = r.body, s = db.settings, num = (v, lo, hi, n) => { v = Number(v); if (!(v >= lo && v <= hi)) throw bad(n + ' must be between ' + lo + ' and ' + hi); return v; };
    if (b.autopilot !== undefined) { if (!['on', 'paused', 'off'].includes(b.autopilot)) throw bad('Auto-Pilot must be on, paused or off'); s.autopilot = b.autopilot; }
    if (b.live !== undefined) { if (b.live && !b.confirm_live) throw bad('Live mode sends real messages to real customers. Confirm it first'); s.live = !!b.live; }
    if (b.delay) { const mn = num(b.delay.min, 0, 120, 'Minimum delay'), mx = num(b.delay.max, 0, 240, 'Maximum delay'); if (mx < mn) throw bad('Maximum delay must be at least the minimum'); s.delay = { min: mn, max: mx }; }
    if (b.caps) s.caps = { repliesPerHour: num(b.caps.repliesPerHour, 1, 500, 'Replies per hour'), dmsPerDay: num(b.caps.dmsPerDay, 1, 5000, 'Messages per day') };
    if (b.holding_reply !== undefined) s.holding_reply = !!b.holding_reply; if (b.max_images !== undefined) s.max_images = num(b.max_images, 1, 10, 'Photos per reply');
    if (b.business) { for (const k of ['name', 'phone', 'location', 'hours', 'delivery_text', 'payment_text', 'returns_text', 'visit_text']) if (b.business[k] !== undefined) s.business[k] = String(b.business[k]).slice(0, 600); if (b.business.delivery_charge !== undefined) { const v = b.business.delivery_charge === '' ? null : toPence(b.business.delivery_charge); if (b.business.delivery_charge !== '' && (v === null || Number.isNaN(v))) throw bad('Invalid delivery charge'); s.business.delivery_charge_pence = v; } }
    if (b.followups) { const f = b.followups; if (f.enabled !== undefined) s.followups.enabled = !!f.enabled; if (f.afterHours) s.followups.afterHours = list(f.afterHours).map(Number).filter(n => n > 0 && n <= 720).slice(0, 5); if (f.max !== undefined) s.followups.max = num(f.max, 0, 5, 'Follow-ups'); if (f.text !== undefined) s.followups.text = String(f.text).slice(0, 400); }
    if (b.categories) s.categories = list(b.categories).slice(0, 30);
    db.log('settings', 'Settings changed' + (b.live !== undefined ? ' (live mode ' + (s.live ? 'ON' : 'OFF') + ')' : '')); db.save(); return s;
  });
  R('GET', '/api/history', r => { const q = (r.query.q || '').toLowerCase(); return db.list('logs').filter(l => (!r.query.kind || l.kind === r.query.kind) && (!q || l.text.toLowerCase().includes(q))).sort((a, b) => b.ts - a.ts).slice(0, 300); });
  R('GET', '/api/decisions', r => db.list('decisions').sort((a, b) => b.ts - a.ts).slice(0, 100).map(d => Object.assign({}, d, { text: (db.get('messages', d.message_id) || {}).text, product: (db.get('products', d.product_id || '') || {}).name })));
  // ---------- groups & reviews (manual helpers) ----------
  R('GET', '/api/groups', () => db.list('groups').sort((a, b) => a.name.localeCompare(b.name)));
  R('POST', '/api/groups', r => { const l = String(r.body.link || '').trim(); if (!/^https:\/\/(www\.|m\.)?facebook\.com\//.test(l)) throw bad('Paste a facebook.com group link'); const g = db.put('groups', { id: uid('grp'), name: String(r.body.name || l.split('/').filter(Boolean).pop()).slice(0, 80), link: l, cooldown_days: Math.max(0, +r.body.cooldown_days || 1), last_posted: null }); db.save(); return g; });
  R('POST', '/api/groups/:id/posted', r => { const g = ids('groups')(r); if (!g) throw bad('Not found', 404); g.last_posted = now(); db.save(); return g; });
  R('DELETE', '/api/groups/:id', r => { db.del('groups', r.params.id); db.save(); return { ok: true }; });
  R('GET', '/api/reviews', () => db.list('reviews').sort((a, b) => b.created - a.created));
  R('POST', '/api/reviews', r => { const t = String(r.body.text || '').trim(); if (!t) throw bad('Paste the review text'); const rating = Math.min(5, Math.max(1, +r.body.rating || 3)), ph = db.settings.business.phone, nm = U.firstName(r.body.author); const draft = rating >= 4 ? 'Thank you' + (nm ? ' ' + nm : '') + ' for your kind review! We are glad you are happy and appreciate your support.' : 'Hello' + (nm ? ' ' + nm : '') + ', thank you for your feedback and we are sorry we did not meet your expectations. We would like to put this right' + (ph ? ': please contact us on ' + ph + '.' : '.'); const rv = db.put('reviews', { id: uid('rev'), author: String(r.body.author || '').slice(0, 80), rating, text: t.slice(0, 2000), draft, status: 'draft', created: now() }); db.save(); return rv; });
  R('PUT', '/api/reviews/:id', r => { const v = ids('reviews')(r); if (!v) throw bad('Not found', 404); if (r.body.draft !== undefined) v.draft = String(r.body.draft).slice(0, 2000); if (r.body.status !== undefined) v.status = r.body.status === 'replied' ? 'replied' : 'draft'; db.save(); return v; });
  R('DELETE', '/api/reviews/:id', r => { db.del('reviews', r.params.id); db.save(); return { ok: true }; });
  // ---------- test message, backups, legacy import ----------
  R('POST', '/api/simulate', r => {
    const t = String(r.body.text || '').slice(0, 1000), ch = r.body.channel === 'comment' ? 'comment' : 'inbox', name = String(r.body.name || 'Test Customer').slice(0, 60), key = U.normalise(name).replace(/ /g, '-') || 'tester';
    const ev = { id: 'sim:' + uid('e'), type: ch === 'comment' ? 'comment' : 'message', page_id: 'sim-page', post_id: r.body.post_id || null, comment_id: ch === 'comment' ? uid('simc') : null, from_id: 'sim-' + key, from_name: name, text: t, ts: now() };
    const out = engine.process(ev, { simulated: true }); for (const j of db.filter('jobs', j => j.status === 'pending' && j.event === ev.id)) j.due_at = now(); db.save(); return out.decision ? { action: out.action, intents: out.decision.intents, product_id: out.decision.product_id, reply: out.decision.reply || null } : out;
  });
  R('POST', '/api/backup', () => ({ file: db.backup('manual') }));
  R('GET', '/api/backups', () => db.backups());
  R('POST', '/api/import/legacy', r => {
    let o = r.body.json; if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { throw bad('That is not valid JSON'); } } if (!o || !Array.isArray(o.prods)) throw bad('This does not look like a Page Desk backup'); db.backup('before-import'); let np = 0, nl = 0, no = 0, skipped = [];
    for (const p of o.prods) { if (!p.n) continue; if (/generator|pressure|washer|tool/i.test(p.n + ' ' + (p.cat || ''))) { skipped.push(p.n); continue; } if (db.find('products', x => x.name.toLowerCase() === String(p.n).toLowerCase())) continue; db.put('products', productFrom({ name: p.n, category: p.cat || '', price: p.price, lowest_price: p.floor, description: p.det || '', colours: p.col || '', keywords: p.kw || '', addons: p.add ? [{ name: p.add, price: p.addp || 0 }] : [] })); np++; }
    const cust = (name, phone, postcode, address) => {
      let c = db.find('customers', x => x.platform === 'legacy' && x.name === String(name || 'unknown'));
      if (!c) c = engine.upsertCustomer('legacy', String(name || 'unknown'));
      if (name && !c.name) c.name = String(name);
      if (phone) c.phone = String(phone);
      if (postcode) c.address.postcode = normPostcode(postcode) || '';
      if (address) c.address.line1 = String(address);
      return c;
    };
    for (const lead of Array.isArray(o.leads) ? o.leads : []) {
      const c = cust(lead.n, lead.ph);
      db.put('leads', { id: uid('lead'), customer_id: c.id, product_id: null, stage: 'new_enquiry', quoted_pence: null, follow_up_at: null, notes: String(lead.s || ''), source: 'legacy-import', created: now(), updated: now(), offered: false });
      nl++;
    }
    for (const order of Array.isArray(o.orders) ? o.orders : []) {
      const c = cust(order.n, order.ph, order.pc, order.a);
      const product = db.find('products', p => p.name.toLowerCase() === String(order.item || '').toLowerCase());
      const amount = toPence(order.price);
      db.put('orders', { id: uid('ord'), customer_id: c.id, lead_id: null, quote_id: null, lines: product ? [{ product_id: product.id, name: product.name, qty: 1, unit_pence: amount, addons: [], line_total_pence: amount }] : [], total_pence: Number.isNaN(amount) || amount == null ? 0 : amount, payment_status: 'unpaid', order_status: 'new', delivery_status: 'not_dispatched', address: Object.assign({}, c.address), source: 'legacy-import', needs_review: true, created: now(), history: [{ ts: now(), text: 'Imported for owner review; verify order and payment status' }] });
      no++;
    }
    db.log('import', 'Imported ' + np + ' products, ' + nl + ' leads and ' + no + ' orders from legacy backup');
    db.save();
    return { products: np, leads: nl, orders: no, skipped };
  });

  const fetchHandler = async request => {
    const url = new URL(request.url), pathname = url.pathname, method = request.method;
    const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    try {
      if (pathname === '/webhook' && method === 'GET') {
        const q = url.searchParams;
        if (q.get('hub.mode') === 'subscribe' && safeEq(q.get('hub.verify_token') || '', env.VERIFY_TOKEN || '')) return new Response(q.get('hub.challenge') || '', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        return new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }

      if (pathname === '/webhook' && method === 'POST') {
        const raw = await request.text();
        if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024) throw bad('Webhook payload is too large', 413);
        if (!meta.verifySignature(raw, request.headers.get('x-hub-signature-256'))) return new Response('Invalid signature', { status: 403 });
        let payload;
        try { payload = JSON.parse(raw); } catch (e) { throw bad('Invalid webhook JSON'); }
        for (const event of parseWebhook(payload)) engine.process(event);
        db.save();
        return json(200, { ok: true });
      }

      if (pathname === '/auth/facebook/callback' && method === 'GET') {
        const state = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '', parts = state.split('.');
        const signed = parts.slice(0, 2).join('.'), expected = crypto.createHmac('sha256', secret).update(signed).digest('hex'), issued = Number(parts[0]);
        if (parts.length !== 3 || !safeEq(parts[2], expected) || !Number.isFinite(issued) || now() - issued > 10 * 60e3 || issued > now() + 60e3) throw bad('Facebook login state is invalid or expired', 400);
        if (!code) throw bad('Facebook did not return an authorization code', 400);
        const redirect = (env.BASE_URL || url.origin).replace(/\/$/, '') + '/auth/facebook/callback';
        const connected = await meta.connectPages(code, redirect);
        if (!connected.ok) throw bad('Facebook connection failed: ' + connected.message, 502);
        for (const page of connected.data.accounts || []) {
          if (!page.id || !page.access_token) continue;
          const sub = await meta.subscribePage(page.access_token, String(page.id));
          if (!sub.ok) throw bad('Could not subscribe Facebook Page ' + (page.name || page.id) + ': ' + sub.message, 502);
          db.put('pages', { id: String(page.id), name: page.name || String(page.id), token_enc: U.encrypt(page.access_token, secret), token_status: 'ok', connected_at: now() });
        }
        db.log('facebook', 'Connected ' + (connected.data.accounts || []).length + ' Facebook Page(s)');
        db.save();
        return new Response(null, { status: 302, headers: { location: '/' } });
      }

      if (pathname === '/api/facebook/login-url' && method === 'GET') {
        const supplied = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        if (!safeEq(supplied, adminKey)) return json(401, { error: 'Wrong key' });
        const issued = String(now()), nonce = crypto.randomBytes(24).toString('base64url'), signed = issued + '.' + nonce;
        const state = signed + '.' + crypto.createHmac('sha256', secret).update(signed).digest('hex');
        const redirect = (env.BASE_URL || url.origin).replace(/\/$/, '') + '/auth/facebook/callback';
        return json(200, { url: meta.loginUrl(redirect, state, env.CONFIG_ID) });
      }

      if (pathname.startsWith('/api/')) {
        const route = routes.find(x => x.m === method && x.re.test(pathname));
        if (!route) return json(404, { error: 'Not found' });
        if (!route.open) {
          const supplied = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
          if (!safeEq(supplied, adminKey)) return json(401, { error: 'Wrong key' });
        }
        const match = route.re.exec(pathname), params = {};
        for (const key of Object.keys(match.groups || {})) {
          try { params[key] = decodeURIComponent(match.groups[key]); } catch (e) { throw bad('Invalid URL parameter'); }
        }
        const raw = method === 'GET' || method === 'HEAD' ? '' : await request.text();
        if (Buffer.byteLength(raw, 'utf8') > 8 * 1024 * 1024) throw bad('Request body is too large', 413);
        let body = {};
        if (raw) {
          try { body = JSON.parse(raw); } catch (e) { throw bad('Invalid JSON body'); }
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('JSON body must be an object');
        }
        const result = await route.h({ body, params, query: Object.fromEntries(url.searchParams), headers: request.headers });
        return json(200, result === undefined ? null : result);
      }

      if (pathname.startsWith('/media/')) {
        const name = pathname.slice('/media/'.length);
        if (!name || path.basename(name) !== name || name.includes('\\')) return new Response(null, { status: 404 });
        if (o.imageStore) {
          const image = await o.imageStore.get(name);
          if (!image) return new Response(null, { status: 404 });
          return new Response(image.body, { status: 200, headers: { 'content-type': image.contentType || MIME[path.extname(name).toLowerCase()] || 'application/octet-stream', 'cache-control': 'public, max-age=3600' } });
        }
        const file = path.join(dataDir, 'images', name);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response(null, { status: 404 });
        return new Response(fs.readFileSync(file), { status: 200, headers: { 'content-type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream', 'cache-control': 'public, max-age=3600' } });
      }

      if (method !== 'GET' && method !== 'HEAD') return new Response(null, { status: 404 });
      if (o.assets) return o.assets.fetch(request);
      const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1)), file = path.resolve(pub, relative);
      if (file !== pub && !file.startsWith(path.resolve(pub) + path.sep)) return new Response(null, { status: 404 });
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response(null, { status: 404 });
      return new Response(method === 'HEAD' ? null : fs.readFileSync(file), { status: 200, headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' } });
    } catch (e) {
      const status = Number(e.status) || 500;
      if (status >= 500) console.error('Request failed:', U.redact(e.message));
      return json(status, Object.assign({ error: U.redact(e.message || 'Internal server error') }, e.extra || {}));
    }
  };
  const server = o.webWorker ? null : http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const request = new Request('http://' + (req.headers.host || 'localhost') + req.url, {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) || !body.length ? undefined : body
      });
      const response = await fetchHandler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: U.redact(e.message || 'Internal server error') }));
    }
  });
  let timer = null;
  if (!o.noTimer && !o.webWorker) {
    timer = setInterval(() => engine.tick().catch(e => console.error('Job processing failed:', U.redact(e.message))), 1000);
    if (timer.unref) timer.unref();
  }
  return {
    server, engine, db, meta, adminKey, adminFrom, fetch: fetchHandler,
    start: port => new Promise((resolve, reject) => {
      if (!server) return reject(new Error('The HTTP listener is disabled in Worker mode'));
      const onError = e => { server.removeListener('listening', onListening); reject(e); };
      const onListening = () => { server.removeListener('error', onError); resolve(server.address().port); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    }),
    stop: () => new Promise((resolve, reject) => {
      if (timer) clearInterval(timer);
      if (!server) return resolve();
      if (!server.listening) return resolve();
      server.close(e => e ? reject(e) : resolve());
    })
  };
}
if (require.main === module) {
  try { const f = path.join(process.pkg ? path.dirname(process.execPath) : process.cwd(), '.env'); if (fs.existsSync(f)) require('dotenv').config({ path: f }); } catch (e) {}
  const port = process.env.PORT || 3000;
  createApp().server.listen(port, () => console.log('Furniture Sales Assistant running on port ' + port));
}
module.exports = { createApp };
