'use strict';
// Official Meta Graph API client. Real errors are returned, retryable on network/5xx.
const crypto = require('crypto');
const { redact, safeEq } = require('./util');
const fail = (code, message, retryable) => ({ ok: false, code, retryable, message: redact(message) });

class Meta {
    constructor(o) { this.base = (o.base || 'https://graph.facebook.com'); this.ver = (o.ver || 'v18.0'); this.appId = o.appId; this.secret = o.secret; }
    get configured() { return !!(this.ver && this.appId && this.secret); }

    async call(method, p, { token, params = {}, body = {} } = {}) {
        if (!this.ver) return fail('config', 'GRAPH_VERSION is not set in env', false);
        const u = new URL(this.base + '/' + this.ver + p);
        for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
        const h = { 'content-type': 'application/json' };
        if (token) h.Authorization = `Bearer ${token}`;
        let res; try { res = await fetch(u, { method, headers: h, body: method === 'GET' ? undefined : JSON.stringify(body) }); }
        catch (e) { return fail('network', 'Network problem: ' + redact(e.message), true); }
        let j = null; try { j = await res.json(); } catch (e) { /* not json */ }
        if (res.ok && j && !j.error) return { ok: true, data: j };
        const er = (j && j.error) || {}, code = er.code || res.status;
        return { ok: false, code, subcode: er.error_subcode, message: redact(er.message || `HTTP ${res.status}`), retryable: [4, 17, 32, 341, 613, 614].includes(code) || res.status >= 500 };
    }

    replyToComment(token, commentId, text) { return this.call('POST', '/' + commentId + '/comments', { token, body: { message: text } }); }
    sendDM(token, pageId, psid, text) { return this.call('POST', '/' + pageId + '/messages', { token, body: { recipient: { id: psid }, message: { text } } }); }
    sendImage(token, pageId, psid, url) { return this.call('POST', '/' + pageId + '/messages', { token, body: { recipient: { id: psid }, message: { attachment: { type: 'image', payload: { url, is_reusable: true } } } } }); }

    async publishPost(token, pageId, message, imageUrls) {
        if (imageUrls && imageUrls.length > 0) {
            const ids = [];
            for (const url of imageUrls.slice(0, 10)) {
                const r = await this.call('POST', '/' + pageId + '/photos', { token, body: { url, published: false } });
                if (r.ok && r.data && r.data.id) ids.push({ media_fbid: r.data.id });
            }
            if (ids.length > 0) {
                return this.call('POST', '/' + pageId + '/feed', { token, body: { message, attached_media: ids } });
            }
        }
        return this.call('POST', '/' + pageId + '/feed', { token, body: { message } });
    }

    loginUrl(redirect, state, configId) {
        const p = new URLSearchParams({ client_id: this.appId, redirect_uri: redirect, state, response_type: 'code', scope: 'pages_show_list,pages_messaging' });
        if (configId) p.set('config_id', configId);
        return `${this.base}/dialog/oauth?${p.toString()}`;
    }

    async connectPages(code, redirect) {
        const l = await this.call('GET', '/oauth/access_token', { params: { client_id: this.appId, client_secret: this.secret, redirect_uri: redirect, code } });
        if (!l.ok) return l;
        const me = await this.call('GET', '/me/accounts', { token: l.data.access_token, params: { fields: 'id,name,access_token,tasks' } });
        if (!me.ok) return me;
        return { ok: true, data: { access_token: l.data.access_token, accounts: me.data.data } };
    }

    verifySignature(raw, header) {
        if (!this.secret || !header) return false;
        const [algo, sig] = header.split('=');
        if (algo !== 'sha256') return false;
        const h = crypto.createHmac('sha256', this.secret).update(raw).digest('hex');
        return safeEq(h, sig);
    }
}

module.exports = Meta;