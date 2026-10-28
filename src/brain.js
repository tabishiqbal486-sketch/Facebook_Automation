'use strict';
// Decision engine. Pure function: it reads verified data (catalogue, settings, owner-approved knowledge) and returns a decision.
// It never guesses: anything it cannot verify becomes a question for the owner.
const U = require('./util');
const { gbp, tokens, normalise, sameWord, parsePostcode, STREET, firstName } = U;

const INTENTS = {
  optout: { w: ['unsubscribe'], ph: ['stop messaging', 'dont message', 'do not message', 'leave me alone', 'stop texting', 'remove me', 'stop contacting'] },
  complaint: { w: ['damaged', 'broken', 'faulty', 'refund', 'complaint', 'scam', 'fraud', 'disappointed', 'terrible', 'awful', 'worst', 'rude', 'unacceptable', 'disgusting', 'cheated', 'fake'], ph: ['not delivered', 'never arrived', 'not arrived', 'poor quality', 'bad quality', 'money back', 'not happy', 'very late', 'still waiting', 'want to cancel'] },
  photos: { w: ['pic', 'pics', 'picture', 'pictures', 'photo', 'photos', 'image', 'images', 'tasveer'], ph: ['more pics', 'show me'] },
  price: { w: ['price', 'prices', 'cost', 'rate', 'qeemat', 'keemat', 'kimat', 'kitna', 'pricing'], ph: ['how much', 'how mch', 'whats the price'] },
  stock: { w: ['available', 'stock', 'instock'], ph: ['in stock', 'any left'] },
  delivery: { w: ['delivery', 'deliver', 'delivered', 'shipping', 'postage', 'dispatch', 'courier'], ph: ['how long', 'when will', 'how soon'] },
  details: { w: ['size', 'sizes', 'dimensions', 'dimension', 'measurements', 'material', 'width', 'height', 'depth', 'specs', 'specification', 'details', 'detail', 'info', 'information', 'describe'], ph: ['how big', 'what size'] },
  colour: { w: ['colour', 'colours', 'color', 'colors', 'shade', 'finish', 'finishes'], ph: [] },
  discount: { w: ['discount', 'cheaper', 'reduce', 'negotiable', 'offer'], ph: ['best price', 'last price', 'final price', 'too much', 'too expensive', 'any discount', 'lowest price', 'bit less', 'little less', 'can you do'] },
  payment: { w: ['payment', 'pay', 'cod', 'deposit', 'instalment', 'installments', 'finance', 'klarna'], ph: ['cash on delivery', 'pay on delivery', 'bank transfer', 'card payment'] },
  location: { w: ['location', 'showroom', 'visit', 'collect', 'collection', 'pickup'], ph: ['where are you', 'where is your', 'come and see', 'see it in person', 'your address', 'shop address'] },
  buy: { w: ['order', 'buy', 'purchase', 'reserve'], ph: ['i want', 'i will take', 'i ll take', 'i need this', 'want this', 'interested', 'i m interested', 'lets go', 'take it', 'i want to order'] },
  confirm: { w: ['confirm', 'confirmed'], ph: ['go ahead', 'book it', 'yes confirm'] },
  thanks: { w: ['thanks', 'thank', 'thx', 'cheers'], ph: ['thank you'] },
  greeting: { w: ['hi', 'hello', 'hey', 'hiya', 'salam', 'assalam'], ph: ['good morning', 'good evening', 'good afternoon'] },
  yes: { w: ['yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'sure', 'haan', 'han'], ph: [] }
};
const ORDER = ['optout', 'complaint', 'discount', 'photos', 'price', 'stock', 'delivery', 'payment', 'colour', 'details', 'location', 'confirm', 'buy', 'thanks', 'greeting', 'yes'];
const INJECT = /(ignore (all |any |the )?(previous|prior|above)|system prompt|you are now|developer mode|reveal (your )?(instructions|prompt)|act as|jailbreak|disregard (the )?(rules|instructions))/i;

function detectIntents(text) {
  const n = ' ' + normalise(text) + ' ', toks = n.trim().split(' '), found = [];
  for (const k of ORDER) { const d = INTENTS[k]; let hit = d.ph.some(p => n.includes(' ' + p + ' ') || n.includes(p)); if (!hit) hit = toks.some(t => d.w.some(w => (w.length <= 3 ? t === w : sameWord(t, w)))); if (hit) found.push(k); }
  return found;
}
function scoreProduct(p, toks, norm) {
  const words = new Set(tokens([p.name, p.sku, (p.keywords || []).join(' ')].join(' ')));
  let s = 0; for (const w of words) if (toks.some(t => sameWord(t, w))) s += (w.length > 3 ? 1 : 0.5);
  if (p.sku && norm.includes(normalise(p.sku))) s += 2;
  return s;
}
function matchKnowledge(ctx, toks, intents, productId) {
  let best = null;
  for (const k of ctx.knowledge) {
    if (k.status !== 'approved' || k.kind === 'product_map' || !k.keywords || !k.keywords.length) continue;
    if (k.product_id && k.product_id !== productId) continue;
    if (k.post_id && k.post_id !== ctx.post_id) continue;
    if (k.intent && intents.length && !intents.includes(k.intent)) continue;
    const hit = k.keywords.filter(w => toks.some(t => sameWord(t, w))).length, cov = hit / k.keywords.length;
    if (cov >= 0.8 && toks.length <= k.keywords.length * 3 + 3) { const sc = cov + (k.product_id ? 0.2 : 0) + (k.post_id ? 0.2 : 0); if (!best || sc > best.sc) best = { k, sc }; }
  }
  return best && best.k;
}
function resolveProduct(ctx, toks, norm) {
  const active = ctx.products.filter(p => !p.archived), byId = id => active.find(p => p.id === id) || null;
  if (ctx.forcedProductId) { const p = byId(ctx.forcedProductId); if (p) return { product: p, source: 'owner', confidence: 1, candidates: [] }; }
  for (const k of ctx.knowledge) if (k.status === 'approved' && k.kind === 'product_map' && k.keywords && k.keywords.length && (!k.post_id || k.post_id === ctx.post_id)) { if (k.keywords.every(w => toks.some(t => sameWord(t, w)))) { const p = byId(k.product_id); if (p) return { product: p, source: 'approved-mapping', confidence: 0.9, candidates: [] }; } }
  const scored = active.map(p => ({ p, s: scoreProduct(p, toks, norm) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
  const strong = scored.length && scored[0].s >= 1.5 && (scored.length === 1 || scored[0].s - scored[1].s >= 0.75) ? scored[0].p : null;
  const map = ctx.post_id ? ctx.posts.find(po => po.post_id === ctx.post_id && po.verified) : null;
  if (map) {
    const mapped = map.product_ids.map(byId).filter(Boolean);
    if (strong) return { product: strong, source: 'text', confidence: 0.85, candidates: [] };
    if (mapped.length === 1) return { product: mapped[0], source: 'post-mapping', confidence: 0.95, candidates: [] };
    if (mapped.length > 1) { const sub = scored.filter(x => mapped.some(m => m.id === x.p.id)); if (sub.length === 1) return { product: sub[0].p, source: 'text', confidence: 0.8, candidates: [] }; return { product: null, source: 'ambiguous-post', confidence: 0, candidates: mapped }; }
  }
  if (strong) return { product: strong, source: 'text', confidence: 0.8, candidates: [] };
  if (ctx.lead && ctx.lead.product_id && Date.now() - (ctx.lead.updated || 0) < 3 * 864e5) { const p = byId(ctx.lead.product_id); if (p) return { product: p, source: 'conversation', confidence: 0.7, candidates: [] }; }
  return { product: null, source: scored.length ? 'ambiguous-text' : 'none', confidence: 0, candidates: scored.slice(0, 4).map(x => x.p) };
}
const price = p => (p.sale_price_pence != null ? p.sale_price_pence : p.price_pence);
function priceLine(p) { if (p.price_pence == null) return null; return p.sale_price_pence != null ? 'The ' + p.name + ' is now ' + gbp(p.sale_price_pence) + ' (was ' + gbp(p.price_pence) + ').' : 'The ' + p.name + ' is ' + gbp(p.price_pence) + '.'; }
function deliveryLine(s) { const b = s.business; if (!b.delivery_text) return null; return b.delivery_text.replace(/\s*\.?$/, '.') + (b.delivery_charge_pence != null ? ' Delivery charge: ' + gbp(b.delivery_charge_pence) + '.' : ''); }

// ctx: {text, channel, post_id, customer, lead, lastOutbound, products, posts, knowledge, settings, forcedProductId}
function decide(ctx) {
  const text = String(ctx.text || ''), norm = normalise(text), toks = tokens(text), s = ctx.settings, b = s.business, cust = ctx.customer || {};
  const fn = firstName(cust.name), hi = fn ? 'Hi ' + fn + '! ' : 'Hi! ';
  const D = o => Object.assign({ intents: [], product_id: null, confidence: 0, flags: {} }, o);
  const ask = (kind, need, extra) => D(Object.assign({ action: 'ask_owner', ask: { kind, need }, reason: kind }, extra));
  if (!norm && !ctx.has_attachment) return D({ action: 'silent', reason: 'empty message' });
  if (!norm && ctx.has_attachment) return ask('attachment', 'The customer sent an image or file. Please look at it and tell me how to reply.');
  if (INJECT.test(text)) return ask('suspicious', 'This message tries to give the bot instructions. I have not replied. Please check it.', { flags: { suspicious: true } });
  const intents = detectIntents(text), pc = parsePostcode(text), street = STREET.test(text);
  if (intents.includes('optout')) return D({ action: 'reply', intents, reason: 'opt-out', flags: { optout: true }, reply: { dm: 'No problem, we will not message you again.', comment: 'No problem, we will not message you again.' } });
  if (intents.includes('complaint')) return ask('complaint', 'This sounds like a complaint or a sensitive issue. I have not replied. Please handle it personally.', { intents, interpretation: 'Complaint or problem with an order/product' });
  const pr = resolveProduct(ctx, toks, norm), p = pr.product;
  const common = { intents, product_id: p && p.id, confidence: pr.confidence, product_source: pr.source };
  // 1. approved knowledge from the owner
  const kn = matchKnowledge(ctx, toks, intents, p && p.id);
  if (kn) { const t = kn.answer.replace(/\{name\}/g, fn || 'there').replace(/\{product\}/g, p ? p.name : 'the item').replace(/\{price\}/g, p && price(p) != null ? gbp(price(p)) : ''); if (!/\{price\}/.test(kn.answer) || (p && price(p) != null)) return D(Object.assign({}, common, { action: 'reply', reason: 'approved knowledge', knowledge_id: kn.id, reply: { dm: t, comment: ctx.channel === 'comment' ? hi + 'We have sent you a private message. 📩' : t }, expect: 'none' })); }
  // 2. product FAQs
  if (p && p.faqs) for (const f of p.faqs) { const ks = tokens(f.q); if (ks.length && ks.filter(w => toks.some(t => sameWord(t, w))).length / ks.length >= 0.8) return D(Object.assign({}, common, { action: 'reply', reason: 'product FAQ', reply: { dm: f.a, comment: ctx.channel === 'comment' ? hi + 'We have sent you a private message. 📩' : f.a } })); }
  // 3. delivery address captured
  if (pc || street) {
    const line = street ? (text.match(STREET) || [''])[0] : '';
    return D(Object.assign({}, common, { intents: intents.concat('address'), action: 'reply', reason: 'address captured', flags: { address: { line1: line, postcode: pc } }, expect: pc && line ? 'none' : 'address',
      reply: { dm: pc && line ? 'Thank you' + (fn ? ' ' + fn : '') + '! We have noted your delivery address (' + line + ', ' + pc + '). We will confirm the details with you shortly.' : (pc ? 'Thanks! We have your postcode (' + pc + '). Could you also send your full delivery address (house number and street)?' : 'Thanks! Could you also send your postcode?') } }));
  }
  const need = intents.filter(i => ['price', 'stock', 'delivery', 'details', 'colour', 'photos', 'payment', 'location', 'discount', 'buy', 'confirm'].includes(i));
  const wantsProduct = need.some(i => ['price', 'stock', 'details', 'colour', 'photos', 'discount', 'buy', 'confirm'].includes(i));
  if (intents.includes('yes') && !need.length) {
    const lo = ctx.lastOutbound;
    if (lo && lo.expect === 'interest' && Date.now() - lo.ts < 864e5 && p) need.push('buy'); else if (!intents.includes('greeting') && !intents.includes('thanks')) return ask('unclear_reply', 'The customer said "' + text.slice(0, 60) + '" but I do not know what they are agreeing to.', Object.assign({}, common, { interpretation: 'A short yes/ok with no clear question before it' }));
  }
  if (!need.length) {
    if (intents.includes('thanks')) return D(Object.assign({}, common, { action: 'reply', reply: { dm: 'You are welcome! Message us any time if you need anything.', comment: 'You are welcome! 😊' }, reason: 'thanks' }));
    if (intents.includes('greeting')) return D(Object.assign({}, common, { action: 'reply', reason: 'greeting', expect: 'none', reply: { dm: hi + (p ? 'Are you interested in the ' + p.name + '? Ask me anything about it.' : 'Which furniture item are you interested in?'), comment: hi + 'How can we help?' } }));
    return ask('unknown_intent', 'I could not understand this message well enough to reply.', Object.assign({}, common, { interpretation: p ? 'Possibly about ' + p.name : null }));
  }
  // category browsing: "do you have wardrobes?"
  if (wantsProduct && !p) {
    const cats = [...new Set(ctx.products.filter(x => !x.archived).map(x => x.category).filter(Boolean))].filter(c => c.toLowerCase().split(' ').some(w => w.length >= 3 && toks.some(t => sameWord(t, w))));
    const list = ctx.products.filter(x => !x.archived && cats.includes(x.category) && x.price_pence != null && x.stock !== 'out_of_stock').slice(0, 6);
    if (list.length > 1 && pr.source !== 'ambiguous-post') return D(Object.assign({}, common, { action: 'reply', reason: 'category list', expect: 'which_product', reply: { dm: 'Yes, we have these:\n' + list.map(x => '• ' + x.name + ' - ' + gbp(price(x))).join('\n') + '\nWhich one would you like to know more about?', comment: hi + 'We have a few options. We have sent you the details in a private message. 📩' }, images: [] }));
    const why = pr.source === 'ambiguous-post' ? 'This post shows more than one product and the comment does not say which.' : (pr.candidates.length ? 'More than one product could match.' : 'I could not tell which product this is about.');
    return ask('product_unclear', why + ' I have not quoted any price or photo.', Object.assign({}, common, { candidates: pr.candidates.map(x => x.id), interpretation: 'Intent: ' + need.join(', ') }));
  }
  // build the reply from verified facts only
  const parts = [], missing = [], images = []; let expect = 'none', stage = null;
  for (const i of need) {
    if (i === 'price' || i === 'buy' || i === 'confirm' || i === 'discount') {
      if (!p || p.price_pence == null) { missing.push('the price of ' + (p ? p.name : 'this product')); continue; }
      if (i === 'discount') {
        const eff = price(p), low = p.lowest_price_pence;
        if (low != null && low < eff && !(ctx.lead && ctx.lead.offered)) { parts.push('I understand! For you I can do the ' + p.name + ' at ' + gbp(low) + '.'); stage = { offered: true, quoted: low }; expect = 'interest'; }
        else parts.push('I understand. The ' + p.name + ' is ' + gbp(eff) + ', which is our current price.');
      } else if (!parts.some(x => x.startsWith('The ' + p.name + ' is'))) { parts.push(priceLine(p)); stage = Object.assign(stage || {}, { quoted: price(p) }); }
      if (i === 'buy' || i === 'confirm') { const d = deliveryLine(s); if (d) parts.push(d); parts.push('To arrange delivery, please send your full delivery address and postcode.'); expect = 'address'; stage = Object.assign(stage || {}, { stage: 'interested' }); }
      else if (expect === 'none') { parts.push('Would you like us to arrange delivery for you?'); expect = 'interest'; }
    }
    if (i === 'stock') { if (!p || !p.stock || p.stock === 'unknown') missing.push('whether ' + (p ? p.name : 'this product') + ' is in stock'); else parts.push(p.stock === 'in_stock' ? 'Yes, the ' + p.name + ' is currently in stock.' : 'Sorry, the ' + p.name + ' is currently out of stock.'); }
    if (i === 'delivery') { const d = deliveryLine(s); if (!d) missing.push('your delivery information'); else parts.push(d); }
    if (i === 'payment') { if (!b.payment_text) missing.push('your payment options'); else parts.push(b.payment_text.replace(/\s*\.?$/, '.')); }
    if (i === 'location') { if (!b.location) missing.push('your business location'); else parts.push('We are based in ' + b.location + '.' + (b.visit_text ? ' ' + b.visit_text : '')); }
    if (i === 'details') { if (!p || (!p.description && !(p.specs && p.specs.length))) missing.push('the details of ' + (p ? p.name : 'this product')); else parts.push('The ' + p.name + ': ' + [p.description].concat(p.specs || []).filter(Boolean).join('. ').replace(/\.+$/, '') + '.'); }
    if (i === 'colour') { if (!p || !(p.colours && p.colours.length)) missing.push('the colours of ' + (p ? p.name : 'this product')); else parts.push('The ' + p.name + ' is available in: ' + p.colours.join(', ') + '.'); }
    if (i === 'photos') { if (!p || !(p.images && p.images.length)) missing.push('photos of ' + (p ? p.name : 'this product')); else { parts.push('Here are photos of the ' + p.name + '. 📷'); for (const im of p.images.slice(0, s.max_images || 3)) images.push({ product_id: p.id, file: im }); } }
  }
  if (missing.length) return ask('no_info', 'I do not have verified information about: ' + missing.join('; ') + '.', Object.assign({}, common, { interpretation: 'Customer asks about ' + need.join(', ') + (p ? ' for ' + p.name : '') }));
  const dm = hi + parts.join(' ');
  const short = need.length === 1 && need[0] === 'price' && p ? hi + priceLine(p) + ' We have sent you more details in a private message. 📩' : hi + 'Thanks for your interest! We have sent you the details in a private message. 📩';
  return D(Object.assign({}, common, { action: 'reply', reason: 'verified catalogue facts', reply: { dm, comment: short }, images, expect, stage }));
}
module.exports = { decide, detectIntents, resolveProduct, price, priceLine };
