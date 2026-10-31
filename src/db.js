'use strict';
// Small, dependency-free JSON database: atomic writes, hourly backups, migrations, crash recovery.
const fs = require('fs'), path = require('path');
const VERSION = 2;
const COLS = ['products', 'posts', 'customers', 'messages', 'decisions', 'questions', 'knowledge', 'leads', 'quotes', 'orders', 'followups', 'jobs', 'events', 'logs', 'pages', 'groups', 'reviews'];
const defaults = () => ({
  autopilot: 'on', live: false, delay: { min: 3, max: 7 }, caps: { repliesPerHour: 30, dmsPerDay: 100 }, holding_reply: true, max_images: 3,
  business: { name: '', phone: '', location: '', hours: '', delivery_text: '', delivery_charge_pence: null, payment_text: '', returns_text: '', visit_text: '' },
  followups: { enabled: false, afterHours: [24, 72], max: 2, text: '' },
  categories: ['Sofas', 'Beds', 'Wardrobes', 'Dining tables']
});
const merge = (d, s) => { for (const k of Object.keys(d)) { if (s[k] === undefined) s[k] = d[k]; else if (d[k] && typeof d[k] === 'object' && !Array.isArray(d[k]) && s[k] && typeof s[k] === 'object') merge(d[k], s[k]); } return s; };
class DB {
  constructor(dir, options = {}) {
    this.dir = dir;
    this.recovered = null;
    this.lastBackup = 0;
    if (options.initialData) {
      this.file = null;
      this.d = JSON.parse(JSON.stringify(options.initialData));
      for (const c of COLS) if (!this.d[c] || typeof this.d[c] !== 'object') this.d[c] = {};
      this.d.settings = merge(defaults(), this.d.settings || {});
      this.d.version = VERSION;
      if (!Array.isArray(this.d.__backups)) this.d.__backups = [];
      return;
    }
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    this.file = path.join(dir, 'db.json');
    this.load();
  }
  backups() { return this.file ? fs.readdirSync(path.join(this.dir, 'backups')).filter(f => f.endsWith('.json')).sort().reverse() : (this.d.__backups || []).map(x => x.name).reverse(); }
  load() {
    let d = null, existed = fs.existsSync(this.file);
    if (existed) { try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { const b = this.backups(); if (!b.length) throw new Error('db.json is damaged and no backup exists'); d = JSON.parse(fs.readFileSync(path.join(this.dir, 'backups', b[0]), 'utf8')); this.recovered = b[0]; } }
    const old = d && (d.version || 1) < VERSION;
    if (old) this.backup('before-migration');
    d = d || { version: VERSION, settings: {} };
    for (const c of COLS) if (!d[c] || typeof d[c] !== 'object') d[c] = {};
    d.settings = merge(defaults(), d.settings || {});
    d.version = VERSION; this.d = d; if (!existed || old || this.recovered) this.save();
  }
  save() {
    if (!this.file) {
      if (Date.now() - this.lastBackup > 3600e3) this.backup('auto');
      return;
    }
    const t = this.file + '.tmp'; fs.writeFileSync(t, JSON.stringify(this.d)); fs.renameSync(t, this.file); if (Date.now() - this.lastBackup > 3600e3) { this.backup('auto'); }
  }
  backup(label) {
    if (!this.file) {
      const name = new Date().toISOString().replace(/[:.]/g, '-') + '-' + (label || 'manual') + '.json';
      const snapshot = JSON.parse(JSON.stringify(this.d));
      delete snapshot.__backups;
      this.d.__backups.push({ name, data: snapshot });
      this.d.__backups = this.d.__backups.slice(-30);
      this.lastBackup = Date.now();
      return name;
    }
    try { const n = new Date().toISOString().replace(/[:.]/g, '-'), f = path.join(this.dir, 'backups', n + '-' + (label || 'manual') + '.json'); if (fs.existsSync(this.file)) fs.copyFileSync(this.file, f); this.lastBackup = Date.now(); const all = this.backups(); all.slice(30).forEach(x => fs.unlinkSync(path.join(this.dir, 'backups', x))); return path.basename(f); } catch (e) { return null; }
  }
  get(c, id) { return this.d[c][id] || null; }
  put(c, o) { this.d[c][o.id] = o; return o; }
  del(c, id) { delete this.d[c][id]; }
  list(c) { return Object.values(this.d[c]); }
  find(c, fn) { return this.list(c).find(fn) || null; }
  filter(c, fn) { return this.list(c).filter(fn); }
  log(kind, text, ref) { const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6); this.d.logs[id] = { id, ts: Date.now(), kind, text: String(text).slice(0, 500), ref: ref || null }; const ids = Object.keys(this.d.logs); if (ids.length > 6000) ids.sort().slice(0, ids.length - 5000).forEach(k => delete this.d.logs[k]); }
  get settings() { return this.d.settings; }
}
module.exports = { DB, VERSION, defaults };
