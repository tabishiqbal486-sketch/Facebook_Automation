'use strict';
const U = require('./util');
const { decide, price } = require('./brain');
const { uid, now, gbp, tokens, normPostcode, firstName } = U;
const bad = (m, c) => Object.assign(new Error(m), { status: c || 400 });
const rnd = (a, b) => a + Math.random() * Math.max(0, b - a);
const BACKOFF = [60e3, 300e3, 900e3, 3600e3, 10800e3];
const STAGES = ['new_enquiry', 'interested', 'price_quoted', 'awaiting_response', 'follow_up_required', 'order_confirmed', 'won', 'lost'];
const ORDER_STATES = ['new', 'confirmed', 'dispatched', 'delivered', 'cancelled'];

class Engine {
  constructor(db, meta, o) { this.db = db; this.meta = meta; this.secret = o.secret; this.baseUrl = (o.baseUrl || '').replace(/\/$/, ''); this.fast = !!o.fast; this.ticking = false; }
  get s() { return this.db.settings; }
  // ---------- customers ----------
  upsertCustomer(platform, pid, name) {
    let c = this.db.find('customers', x => !x.merged_into && x.platform === platform && x.platform_id === String(pid));
    if (!c) c = this.db.put('customers', { id: uid('cus'), platform, platform_id: String(pid), name: name || '', phone: '', email: '', address: { line1: '', line2: '', city: '', postcode: '' }, notes: '', preferences: '', opt_out: false, psid: null, created: now(), last_seen: now() });
    else if (name && !c.name) c.name = name;
    c.last_seen = now(); return c;
  }
  messagesOf(cid, limit) { const m = this.db.filter('messages', x => x.customer_id === cid).sort((a, b) => a.ts - b.ts); return limit ? m.slice(-limit) : m; }
  openLead(cid) { return this.db.filter('leads', l => l.customer_id === cid && !['won', 'lost'].includes(l.stage)).sort((a, b) => b.updated - a.updated)[0] || null; }
  mergeCustomers(fromId, intoId) {
    if (fromId === intoId) throw bad('Choose two different customers');
    const a = this.db.get('customers', fromId), b = this.db.get('customers', intoId); if (!a || !b) throw bad('Customer not found');
    for (const c of ['messages', 'leads', 'orders', 'quotes', 'followups', 'questions']) for (const o of this.db.list(c)) if (o.customer_id === fromId) o.customer_id = intoId;
    for (const k of ['phone', 'email', 'notes', 'preferences', 'name']) if (!b[k] && a[k]) b[k] = a[k];
    for (const k of Object.keys(a.address)) if (!b.address[k] && a.address[k]) b.address[k] = a.address[k];
    a.merged_into = intoId; this.db.log('customer', 'Merged ' + (a.name || a.id) + ' into ' + (b.name || b.id), intoId); this.db.save(); return b;
  }
  // ---------- incoming ----------
  process(ev, opts = {}) {
    const db = this.db; if (db.d.events[ev.id]) { return { duplicate: true }; }
    db.d.events[ev.id] = { id: ev.id, ts: now() }; const ids = Object.keys(db.d.events); if (ids.length > 20000) ids.slice(0, 5000).forEach(k => delete db.d.events[k]);
    if (ev.type === 'comment' && ev.from_id && String(ev.from_id) === String(ev.page_id)) return { ignored: 'own comment' };
    const sim = !!opts.simulated, cust = this.upsertCustomer(sim ? 'sim' : 'facebook', ev.from_id || ('anon-' + ev.id), ev.from_name);
    if (ev.type === 'message' && !sim) cust.psid = String(ev.from_id);
    cancelFollowups(db, cust.id, 'customer replied');
    const msg = db.put('messages', { id: uid('msg'), customer_id: cust.id, direction: 'in', channel: ev.type === 'comment' ? 'comment' : 'inbox', text: ev.text, post_id: ev.post_id || null, comment_id: ev.comment_id || null, page_id: ev.page_id, ts: ev.ts || now(), status: 'received', event_id: ev.id });
    const out = this.handle(cust, msg, ev, opts); db.save(); return out;
  }
  handle(cust, msg, ev, opts) {
    const db = this.db, lead = this.openLead(cust.id), outs = this.messagesOf(cust.id).filter(m => m.direction === 'out');
    const ctx = { text: msg.text, channel: msg.channel, post_id: msg.post_id, customer: cust, lead, lastOutbound: outs[outs.length - 1] || null, products: db.list('products'), posts: db.list('posts'), knowledge: db.list('knowledge'), settings: this.s, forcedProductId: opts.forcedProductId, has_attachment: ev.has_attachment };
    const d = decide(ctx);
    db.put('decisions', { id: uid('dec'), message_id: msg.id, customer_id: cust.id, ts: now(), intents: d.intents, product_id: d.product_id, product_source: d.product_source, confidence: d.confidence, action: d.action, reason: d.reason, knowledge_id: d.knowledge_id || null });
    if (d.knowledge_id) { const k = db.get('knowledge', d.knowledge_id); if (k) { k.uses = (k.uses || 0) + 1; k.last_used = now(); } }
    db.log('decision', d.action + ' (' + (d.reason || '') + ') for ' + (cust.name || cust.platform_id) + ': ' + msg.text.slice(0, 80), msg.id);
    if (d.flags.optout) { cust.opt_out = true; cancelFollowups(db, cust.id, 'opt-out'); for (const j of db.filter('jobs', j => j.customer_id === cust.id && j.status === 'pending')) { j.status = 'cancelled'; j.error = 'Customer opted out'; } }
    if (d.flags.address) this.captureAddress(cust, d.flags.address, d, lead, msg);
    if (d.product_id && ['reply'].includes(d.action) && d.intents.some(i => ['price', 'buy', 'confirm', 'discount', 'photos', 'details', 'stock', 'colour'].includes(i))) this.touchLead(cust, d, lead, msg);
    if (d.action === 'ask_owner') {
      const q = db.put('questions', { id: uid('q'), status: 'open', kind: d.ask.kind, customer_id: cust.id, message_id: msg.id, text: msg.text, channel: msg.channel, post_id: msg.post_id, page_id: msg.page_id, intents: d.intents, interpretation: d.interpretation || null, need: d.ask.need, product_id: d.product_id || null, candidates: d.candidates || [], created: now() });
      if (this.s.holding_reply && ['no_info', 'product_unclear'].includes(d.ask.kind) && !cust.opt_out) { const recent = db.find('messages', m => m.customer_id === cust.id && m.direction === 'out' && m.holding && now() - m.ts < 3600e3); if (!recent) this.queueReplies(cust, msg, { reply: { dm: 'Thanks for your message! We are checking this for you and will get back to you shortly.', comment: 'Thanks for your message! We are checking this and will get back to you shortly.' }, images: [] }, { holding: true, origin: 'auto' }); }
      return { question: q.id, action: d.action };
    }
    if (d.action === 'reply' && d.reply) { this.queueReplies(cust, msg, d, { origin: 'auto' }); }
    return { action: d.action, decision: d };
  }
  captureAddress(cust, a, d, lead, msg) {
    const pc = a.postcode && normPostcode(a.postcode); if (pc) cust.address.postcode = pc;
    if (a.line1) cust.address.line1 = a.line1;
    if (pc && cust.address.line1 && lead && lead.product_id) {
      const dup = this.db.find('orders', o => o.customer_id === cust.id && o.lead_id === lead.id && !['cancelled', 'delivered'].includes(o.order_status));
      if (!dup) { const p = this.db.get('products', lead.product_id); const lines = p ? [{ product_id: p.id, name: p.name, qty: 1, unit_pence: lead.quoted_pence != null ? lead.quoted_pence : price(p) }] : []; this.createOrder({ customer_id: cust.id, lead_id: lead.id, lines, source: 'chat', needs_review: true }); this.db.log('order', 'New order request from ' + (cust.name || cust.platform_id), lead.id); }
    }
  }
  touchLead(cust, d, lead, msg) {
    const db = this.db; let l = lead;
    if (!l) l = db.put('leads', { id: uid('lead'), customer_id: cust.id, product_id: d.product_id, stage: 'new_enquiry', quoted_pence: null, follow_up_at: null, notes: '', source: msg.channel, created: now(), updated: now(), offered: false });
    l.product_id = d.product_id; l.updated = now();
    if (d.stage) { if (d.stage.quoted != null) l.quoted_pence = d.stage.quoted; if (d.stage.offered) l.offered = true; l.stage = d.stage.stage || (d.stage.quoted != null && l.stage === 'new_enquiry' ? 'price_quoted' : l.stage); }
    const f = this.s.followups; if (f.enabled && ['price_quoted', 'interested'].includes(l.stage)) this.scheduleFollowup(l, cust);
  }
  scheduleFollowup(l, cust) {
    const f = this.s.followups, done = this.db.filter('followups', x => x.lead_id === l.id && ['sent', 'manual'].includes(x.status)).length;
    if (done >= f.max || this.db.find('followups', x => x.lead_id === l.id && x.status === 'pending') || cust.opt_out) return;
    const hrs = f.afterHours[done] || f.afterHours[f.afterHours.length - 1] || 24; l.follow_up_at = now() + hrs * 3600e3;
    this.db.put('followups', { id: uid('fu'), lead_id: l.id, customer_id: cust.id, product_id: l.product_id, due_at: l.follow_up_at, status: 'pending', created: now() });
  }
  // ---------- outgoing ----------
  addJob(j) { if (j.key && this.db.find('jobs', x => x.key === j.key)) return null; return this.db.put('jobs', Object.assign({ id: uid('job'), status: 'pending', attempts: 0, created: now(), error: null }, j)); }
  imageUrl(file) { return this.baseUrl ? this.baseUrl + '/media/' + file : null; }
  queueReplies(cust, msg, d, o) {
    const db = this.db, mn = this.s.delay.min * 60e3, mx = this.s.delay.max * 60e3, owner = o.origin === 'owner', f = this.fast;
    let at = now(); const step = () => { at += f ? 50 : (owner ? rnd(3e3, 12e3) : rnd(mn, mx)); return at; };
    const base = { customer_id: cust.id, page_id: msg.page_id, origin: o.origin || 'auto', event: msg.event_id };
    const rec = (job, text, channel, extra) => { const m = db.put('messages', Object.assign({ id: uid('msg'), customer_id: cust.id, direction: 'out', channel, text, post_id: msg.post_id, ts: now(), status: 'queued', job_id: job.id, expect: d.expect || 'none', product_id: d.product_id || null, holding: !!o.holding }, extra || {})); job.message_id = m.id; return m; };
    if (msg.channel === 'comment') {
      if (d.reply.comment && !o.skipPublic) { const j = this.addJob(Object.assign({ type: 'comment_reply', key: 'cr:' + msg.id + (o.suffix || ''), due_at: step(), payload: { comment_id: msg.comment_id, text: d.reply.comment } }, base)); if (j) rec(j, d.reply.comment, 'comment'); }
      const j2 = this.addJob(Object.assign({ type: 'private_reply', key: 'pr:' + msg.id + (o.suffix || ''), due_at: step(), payload: { comment_id: msg.comment_id, text: d.reply.dm } }, base)); if (j2) rec(j2, d.reply.dm, 'inbox');
    } else { const j = this.addJob(Object.assign({ type: 'dm', key: 'dm:' + msg.id + (o.suffix || ''), due_at: step(), payload: { text: d.reply.dm } }, base)); if (j) rec(j, d.reply.dm, 'inbox'); }
    (d.images || []).forEach((im, i) => { const j = this.addJob(Object.assign({ type: 'image', key: 'im:' + msg.id + ':' + i + (o.suffix || ''), due_at: owner || f ? step() : (at += rnd(10e3, 30e3)), payload: { product_id: im.product_id, file: im.file } }, base)); if (j) rec(j, '[photo] ' + im.file, 'inbox', { is_image: true }); });
  }
  sendManual(cid, text) {
    const c = this.db.get('customers', cid); if (!c) throw bad('Customer not found'); if (!text || !text.trim()) throw bad('Write a message first');
    const last = this.db.filter('messages', m => m.customer_id === cid && m.direction === 'in').sort((a, b) => b.ts - a.ts)[0];
    const msg = last || { id: 'manual', page_id: this.db.list('pages')[0] && this.db.list('pages')[0].id, channel: 'inbox', event_id: 'manual' };
    const j = this.addJob({ type: msg.channel === 'comment' ? 'private_reply' : 'dm', key: null, due_at: now() + (this.fast ? 20 : 1000), origin: 'owner', customer_id: cid, page_id: msg.page_id, payload: { text: text.trim(), comment_id: msg.comment_id } });
    const m = this.db.put('messages', { id: uid('msg'), customer_id: cid, direction: 'out', channel: 'inbox', text: text.trim(), ts: now(), status: 'queued', job_id: j.id, manual: true }); j.message_id = m.id; this.db.log('message', 'Owner message queued to ' + (c.name || cid), cid); this.db.save(); return j;
  }
  async tick() {
    if (this.ticking) return; this.ticking = true;
    try {
      const db = this.db, due = db.filter('jobs', j => j.status === 'pending' && j.due_at <= now()).sort((a, b) => a.due_at - b.due_at).slice(0, 10);
      for (const j of due) await this.runJob(j);
      this.runFollowups(); db.save();
    } finally { this.ticking = false; }
  }
  windowOk(j, c) {
    const lastIn = this.db.filter('messages', m => m.customer_id === c.id && m.direction === 'in').sort((a, b) => b.ts - a.ts)[0];
    if (j.type === 'private_reply') { const cm = this.db.find('messages', m => m.comment_id === j.payload.comment_id && m.direction === 'in'); if (!cm) return 'Original comment not found'; if (now() - cm.ts > 7 * 864e5) return 'Private replies are only allowed within 7 days of the comment'; if (cm.private_used) return 'A private reply was already sent for this comment (Meta allows one)'; return null; }
    if (['dm', 'image'].includes(j.type)) { if (!lastIn || now() - lastIn.ts > 24 * 3600e3) return 'Outside the 24-hour messaging window. Send this manually or wait for the customer to message again'; }
    return null;
  }
  async runJob(j) {
    const db = this.db, c = db.get('customers', j.customer_id), m = j.message_id ? db.get('messages', j.message_id) : null, setM = (st, err, mid) => { if (m) { m.status = st; if (err) m.error = err; if (mid) m.meta_id = mid; m.sent_at = now(); } };
    const stop = (st, err) => { j.status = st; j.error = err; j.finished = now(); setM(st === 'cancelled' ? 'cancelled' : 'failed', err); db.log('job', st + ': ' + j.type + ' - ' + (err || ''), j.id); };
    if (j.origin === 'auto' && this.s.autopilot !== 'on') return;
    const isPost = j.type === 'publish_post';
    if (!c && !isPost) return stop('failed', 'Customer missing');
    if (c && c.opt_out && !(m && m.holding === false && j.payload.text === 'No problem, we will not message you again.') && j.payload.text !== 'No problem, we will not message you again.') return stop('cancelled', 'Customer opted out');
    if (j.origin === 'auto') { const hr = db.filter('jobs', x => x.origin === 'auto' && x.status === 'done' && x.finished > now() - 3600e3).length, dy = db.filter('jobs', x => x.origin === 'auto' && x.status === 'done' && ['dm', 'private_reply'].includes(x.type) && x.finished > now() - 864e5).length; if (hr >= this.s.caps.repliesPerHour || dy >= this.s.caps.dmsPerDay) { j.due_at = now() + 600e3; j.note = 'Delayed by safety limit'; return; } }
    const why = c ? this.windowOk(j, c) : null; if (why) return stop('failed', why);
    const page = db.get('pages', j.page_id), sim = !!c && c.platform === 'sim';
    if (!this.s.live || sim) { j.status = 'done'; j.result = sim ? 'simulated' : 'dry_run'; j.finished = now(); setM(sim ? 'simulated' : 'dry_run'); if (j.type === 'private_reply') { const cm = db.find('messages', x => x.comment_id === j.payload.comment_id && x.direction === 'in'); if (cm) cm.private_used = true; } return; }
    if (!page) return stop('failed', 'Facebook Page is not connected');
    let token; try { token = U.decrypt(page.token_enc, this.secret); } catch (e) { return stop('failed', 'Saved Page token cannot be read. Reconnect the Page'); }
    let r;
    if (j.type === 'comment_reply') r = await this.meta.replyToComment(token, j.payload.comment_id, j.payload.text);
    else if (j.type === 'private_reply') r = await this.meta.privateReply(token, page.id, j.payload.comment_id, j.payload.text);
    else if (j.type === 'dm') r = await this.meta.sendDM(token, page.id, c.psid || c.platform_id, j.payload.text);
    else if (j.type === 'image') { const url = this.imageUrl(j.payload.file); if (!url) return stop('failed', 'BASE_URL is not set, so Facebook cannot fetch the photo'); r = await this.meta.sendImage(token, page.id, c.psid || c.platform_id, url); }
    else if (j.type === 'publish_post') r = await this.meta.publishPost(token, page.id, j.payload.text, (j.payload.files || []).map(f => this.imageUrl(f)).filter(Boolean));
    else return stop('failed', 'Unknown job type');
    if (r.ok) {
      j.status = 'done'; j.finished = now(); j.result = 'sent'; const mid = r.data.message_id || r.data.id || null; j.meta_id = mid; setM('sent', null, mid);
      if (j.type === 'private_reply') { const cm = db.find('messages', x => x.comment_id === j.payload.comment_id && x.direction === 'in'); if (cm) cm.private_used = true; if (r.data.recipient_id) c.psid = String(r.data.recipient_id); }
      if (j.type === 'publish_post' && r.data.id) { const po = db.get('posts', 'pending:' + j.id); db.put('posts', { id: uid('post'), post_id: r.data.id, page_id: page.id, product_ids: j.payload.product_ids || [], caption: j.payload.text, verified: true, source: 'created-here', created: now() }); }
      db.log('job', 'sent ' + j.type, j.id); return;
    }
    j.attempts++; j.error = r.message; setM('queued', r.message);
    if (r.tokenExpired) { page.token_status = 'expired'; return stop('failed', 'Facebook access token expired. Reconnect the Page in Settings. (' + r.message + ')'); }
    if (r.permission) return stop('failed', 'Missing Meta permission or app review: ' + r.message);
    if (r.retryable && j.attempts < BACKOFF.length) { j.due_at = now() + (this.fast ? 40 : BACKOFF[j.attempts - 1]); j.note = 'Retrying after: ' + r.message; db.log('job', 'retry ' + j.attempts + ' ' + j.type + ': ' + r.message, j.id); return; }
    stop('failed', r.message);
  }
  runFollowups() {
    const db = this.db;
    for (const f of db.filter('followups', x => x.status === 'pending' && x.due_at <= now())) {
      const c = db.get('customers', f.customer_id), l = db.get('leads', f.lead_id), p = f.product_id && db.get('products', f.product_id);
      const skip = r => { f.status = 'skipped'; f.reason = r; };
      if (!c || !l) { skip('missing record'); continue; } if (c.opt_out) { skip('customer opted out'); continue; } if (['won', 'lost', 'order_confirmed'].includes(l.stage)) { skip('lead is ' + l.stage); continue; }
      if (db.find('orders', o => o.customer_id === c.id && o.lead_id === l.id && o.order_status !== 'cancelled')) { skip('order exists'); continue; }
      const lastIn = db.filter('messages', m => m.customer_id === c.id && m.direction === 'in').sort((a, b) => b.ts - a.ts)[0];
      if (lastIn && lastIn.ts > f.created) { skip('customer replied'); continue; }
      const text = (this.s.followups.text || 'Hi {name}, just checking if you have any questions about the {product}. We are happy to help.').replace(/\{name\}/g, firstName(c.name) || 'there').replace(/\{product\}/g, p ? p.name : 'furniture');
      f.text = text;
      if (lastIn && now() - lastIn.ts <= 24 * 3600e3 && this.s.autopilot === 'on') { f.status = 'sent'; this.addJob({ type: 'dm', key: 'fu:' + f.id, due_at: now() + 1000, origin: 'auto', customer_id: c.id, page_id: lastIn.page_id, payload: { text } }); l.stage = 'awaiting_response'; const jb = db.find('jobs', x => x.key === 'fu:' + f.id); const m = db.put('messages', { id: uid('msg'), customer_id: c.id, direction: 'out', channel: 'inbox', text, ts: now(), status: 'queued', job_id: jb.id, followup: true }); jb.message_id = m.id; }
      else { f.status = 'manual'; f.reason = 'Outside the 24-hour messaging window: send it yourself'; l.stage = 'follow_up_required'; }
      db.log('followup', f.status + ' follow-up for ' + (c.name || c.id), f.id); this.scheduleFollowup(l, c);
    }
  }
  // ---------- owner answers ----------
  answerQuestion(id, p) {
    const db = this.db, q = db.get('questions', id); if (!q) throw bad('Question not found'); if (q.status !== 'open') throw bad('This question was already handled');
    const cust = db.get('customers', q.customer_id), msg = db.get('messages', q.message_id), res = { queued: [], knowledge: null, mapped: null };
    if (p.dismiss) { q.status = 'dismissed'; q.answered_at = now(); db.log('question', 'Dismissed: ' + q.text.slice(0, 60), q.id); db.save(); return res; }
    const forced = p.product_id || null; if (forced && !db.get('products', forced)) throw bad('Product not found');
    let rememberProduct = null;
    if (p.reply_text && p.reply_text.trim()) {
      const d = { reply: { dm: p.reply_text.trim(), comment: 'Hi' + (cust.name ? ' ' + firstName(cust.name) : '') + '! We have sent you a private message. 📩' }, images: [], expect: 'none', product_id: forced };
      if (p.send !== false && !cust.opt_out) { this.queueReplies(cust, msg, d, { origin: 'owner', suffix: ':own' }); res.queued.push('owner reply'); }
    } else if (forced && p.send !== false) {
      const ctxMsg = Object.assign({}, msg); const outcome = this.handleForced(cust, ctxMsg, forced); res.queued.push('re-answered with the correct product'); res.redecision = outcome;
    }
    if (forced && p.map_post && q.post_id) { const ex = db.find('posts', x => x.post_id === q.post_id); if (ex) { if (!ex.product_ids.includes(forced)) ex.product_ids.push(forced); ex.verified = true; } else db.put('posts', { id: uid('post'), post_id: q.post_id, page_id: q.page_id, product_ids: [forced], caption: '', verified: true, source: 'owner-correction', created: now() }); res.mapped = { post_id: q.post_id, product_id: forced }; }
    const r = p.remember;
    if (r && r.save) {
      const kws = (r.keywords && r.keywords.length ? r.keywords : tokens(q.text).slice(0, 6)).map(x => String(x).toLowerCase()).filter(Boolean); if (!kws.length) throw bad('Add at least one keyword to remember');
      const kind = r.kind === 'product_map' ? 'product_map' : 'reply';
      if (kind === 'reply' && !(p.reply_text && p.reply_text.trim())) throw bad('Write the answer you want me to remember');
      if (kind === 'product_map' && !forced) throw bad('Choose the product to remember');
      const k = db.put('knowledge', { id: uid('kn'), status: 'approved', kind, keywords: kws, intent: r.intent || null, product_id: r.scope === 'product' || kind === 'product_map' ? (forced || q.product_id) : null, post_id: r.scope === 'post' || (kind === 'product_map' && r.scope === 'post') ? q.post_id : null, answer: kind === 'reply' ? p.reply_text.trim() : '', source_question: q.id, example: q.text, created: now(), uses: 0 });
      if (r.scope === 'product' && !k.product_id) throw bad('This situation has no product yet. Choose a product first'); res.knowledge = k;
    }
    q.status = 'answered'; q.answered_at = now(); q.answer = { reply_text: p.reply_text || '', product_id: forced, remembered: !!res.knowledge }; db.log('correction', 'Owner answered: "' + q.text.slice(0, 50) + '"' + (res.knowledge ? ' (saved as approved knowledge)' : ''), q.id); db.save(); return res;
  }
  handleForced(cust, msg, productId) {
    const outs = this.messagesOf(cust.id).filter(m => m.direction === 'out'), lead = this.openLead(cust.id);
    const d = decide({ text: msg.text, channel: msg.channel, post_id: msg.post_id, customer: cust, lead, lastOutbound: outs[outs.length - 1] || null, products: this.db.list('products'), posts: this.db.list('posts'), knowledge: this.db.list('knowledge'), settings: this.s, forcedProductId: productId });
    if (d.action === 'reply') { this.touchLead(cust, d, lead, msg); this.queueReplies(cust, msg, d, { origin: 'owner', suffix: ':fix' }); }
    else this.db.log('question', 'Even with the product chosen I still need info: ' + (d.ask && d.ask.need), msg.id);
    return { action: d.action, need: d.ask && d.ask.need };
  }
  // ---------- quotes & orders ----------
  calcQuote(b) {
    const lines = [], db = this.db; if (!Array.isArray(b.lines) || !b.lines.length) throw bad('Add at least one product');
    for (const l of b.lines) {
      const p = db.get('products', l.product_id); if (!p || p.archived) throw bad('Product not found: ' + l.product_id);
      const qty = parseInt(l.qty || 1, 10); if (!(qty >= 1 && qty <= 20)) throw bad('Quantity must be 1 to 20');
      let unit = price(p); if (unit == null) throw bad(p.name + ' has no price in the catalogue');
      if (l.unit_pence != null && l.unit_pence !== unit) { if (!(Number.isInteger(l.unit_pence) && l.unit_pence >= 0)) throw bad('Invalid price'); if (p.lowest_price_pence != null ? l.unit_pence < p.lowest_price_pence : l.unit_pence < unit) { if (!b.owner_override) throw bad('Price below the approved lowest price for ' + p.name + '. Set an approved lowest price in the catalogue or tick owner override'); } unit = l.unit_pence; }
      const addons = []; for (const a of l.addons || []) { const ad = (p.addons || []).find(x => x.name === a); if (!ad) throw bad('Unknown add-on: ' + a); addons.push({ name: ad.name, price_pence: ad.price_pence }); }
      const lt = (unit + addons.reduce((s, a) => s + a.price_pence, 0)) * qty; lines.push({ product_id: p.id, name: p.name, qty, unit_pence: unit, addons, line_total_pence: lt });
    }
    const subtotal = lines.reduce((s, l) => s + l.line_total_pence, 0);
    let discount = 0; if (b.discount_pence) { discount = parseInt(b.discount_pence, 10); if (!(discount > 0 && discount <= subtotal)) throw bad('Invalid discount'); if (!b.discount_approved) throw bad('Tick "approved by me" to apply a discount'); }
    const ch = this.s.business.delivery_charge_pence, delivery = b.include_delivery && ch != null ? ch : 0;
    return { lines, subtotal_pence: subtotal, discount_pence: discount, delivery_pence: delivery, delivery_note: b.include_delivery && ch == null ? 'Delivery charge is not configured in Business settings, so none was added' : '', total_pence: subtotal - discount + delivery };
  }
  createQuote(b) { const c = this.db.get('customers', b.customer_id); if (!c) throw bad('Customer not found'); const q = this.calcQuote(b); const rec = this.db.put('quotes', Object.assign({ id: uid('quo'), customer_id: c.id, lead_id: b.lead_id || null, status: 'draft', created: now() }, q)); this.db.log('quote', 'Quote ' + gbp(q.total_pence) + ' for ' + (c.name || c.id), rec.id); this.db.save(); return rec; }
  quoteText(q) { const c = this.db.get('customers', q.customer_id); return 'Hi' + (c && c.name ? ' ' + firstName(c.name) : '') + '! Here is your quote:\n' + q.lines.map(l => '• ' + l.qty + ' x ' + l.name + ' - ' + gbp(l.unit_pence) + (l.addons.length ? ' + ' + l.addons.map(a => a.name + ' ' + gbp(a.price_pence)).join(', ') : '')).join('\n') + (q.discount_pence ? '\nDiscount: -' + gbp(q.discount_pence) : '') + (q.delivery_pence ? '\nDelivery: ' + gbp(q.delivery_pence) : '') + '\nTotal: ' + gbp(q.total_pence); }
  createOrder(b) {
    const c = this.db.get('customers', b.customer_id); if (!c) throw bad('Customer not found'); let lines = b.lines, calc = null;
    if (b.quote_id) { const q = this.db.get('quotes', b.quote_id); if (!q) throw bad('Quote not found'); calc = q; lines = q.lines; }
    if (!lines || !lines.length) throw bad('An order needs at least one product');
    const total = calc ? calc.total_pence : lines.reduce((s, l) => s + (l.line_total_pence != null ? l.line_total_pence : l.unit_pence * l.qty), 0);
    const o = this.db.put('orders', { id: uid('ord'), customer_id: c.id, lead_id: b.lead_id || null, quote_id: b.quote_id || null, lines, total_pence: total, payment_status: 'unpaid', order_status: 'new', delivery_status: 'not_dispatched', address: Object.assign({}, c.address), source: b.source || 'manual', needs_review: !!b.needs_review, created: now(), history: [] });
    if (b.quote_id) this.db.get('quotes', b.quote_id).status = 'accepted';
    this.db.log('order', 'Order created for ' + (c.name || c.id) + ' (' + gbp(total) + ')', o.id); this.db.save(); return o;
  }
  updateOrder(id, b) {
    const o = this.db.get('orders', id); if (!o) throw bad('Order not found'); const h = (t) => { o.history.push({ ts: now(), text: t }); this.db.log('order', t, id); };
    if (b.order_status && b.order_status !== o.order_status) {
      if (!ORDER_STATES.includes(b.order_status)) throw bad('Unknown status'); const from = ORDER_STATES.indexOf(o.order_status), to = ORDER_STATES.indexOf(b.order_status);
      if (b.order_status !== 'cancelled' && to < from) throw bad('An order cannot go backwards'); if (o.order_status === 'cancelled' || o.order_status === 'delivered') throw bad('This order is closed');
      if (['dispatched', 'delivered'].includes(b.order_status) && !(b.confirm && b.note)) throw bad('Confirm that it really happened and add a note (for example the courier tracking)');
      if (b.order_status === 'confirmed') { const c = this.db.get('customers', o.customer_id); if (!c.address.postcode || !c.address.line1) throw bad('Add the customer delivery address and postcode before confirming'); o.address = Object.assign({}, c.address); o.needs_review = false; const l = o.lead_id && this.db.get('leads', o.lead_id); if (l) l.stage = 'order_confirmed'; }
      o.order_status = b.order_status; if (b.order_status === 'dispatched') o.delivery_status = 'dispatched'; if (b.order_status === 'delivered') { o.delivery_status = 'delivered'; const l = o.lead_id && this.db.get('leads', o.lead_id); if (l) l.stage = 'won'; } h('Order status set to ' + b.order_status + (b.note ? ' (' + b.note + ')' : ''));
    }
    if (b.payment_status && b.payment_status !== o.payment_status) {
      if (!['unpaid', 'cod_pending', 'paid'].includes(b.payment_status)) throw bad('Unknown payment status');
      if (b.payment_status === 'paid' && !(b.confirm && b.note)) throw bad('Confirm that the payment was really received and add a note (method, reference)');
      o.payment_status = b.payment_status; h('Payment status set to ' + b.payment_status + (b.note ? ' (' + b.note + ')' : ''));
    }
    this.db.save(); return o;
  }
}
function cancelFollowups(db, cid, why) { for (const f of db.filter('followups', x => x.customer_id === cid && x.status === 'pending')) { f.status = 'skipped'; f.reason = why; } }
module.exports = { Engine, STAGES, ORDER_STATES };
