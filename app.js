import { firebaseConfig } from './config.js';

// Pinned CDN builds. The service worker caches them, so the app opens offline after the first visit.
const FIREBASE = 'https://www.gstatic.com/firebasejs/12.19.0/';
const ANTHROPIC_SDK = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.132.1/+esm';
const MODEL = 'claude-opus-5-5';
const KEY_STORE = 'kc_api_key';
const LOCAL_STORE = 'kc_local_v1';
const TIP_STORE = 'kc_tip_done';

const PLACES = {fridge:'Fridge', freezer:'Freezer', pantry:'Pantry'};
const SLOTS = ['breakfast','lunch','dinner'];
const MON = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const MONTH = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const TABS = ['cabinet','cook','plan','shop'];
const MAX_PHOTOS = 5;

const state = {
  items:[], shopping:[], meals:{}, recipes:[], prefs:{}, waste:[],
  loaded:{items:false, shopping:false, recipes:false},
  place:'all', editing:null, draft:null, suggestions:[], weekStart:null, user:null,
};
let db = null, claude = null, fb = null, aiCtl = null, toastTimer = null, unsubs = [], installEvent = null;

// ---------- small helpers ----------
const $ = (s, el=document) => el.querySelector(s);
const pad = n => String(n).padStart(2,'0');
const iso = d => d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
const isDate = s => typeof s==='string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const parse = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); };
const today = () => iso(new Date());
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate()+n); return iso(d); };
const daysUntil = s => isDate(s) ? Math.round((parse(s) - parse(today())) / 86400000) : null;
const norm = s => String(s||'').trim().toLowerCase();
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const shortDate = s => { const d = parse(s); return MONTH[d.getMonth()]+' '+d.getDate(); };
const dayLabel = s => { const d = parse(s); return DOW[d.getDay()]+' '+d.getDate()+' '+MONTH[d.getMonth()]; };
const days2date = n => { const v = Math.round(Number(n)); return Number.isFinite(v) && v > 0 && v < 4000 ? addDays(today(), v) : ''; };
const USD = new Intl.NumberFormat('en-US', {style:'currency', currency:'USD'});
const money = n => USD.format(n || 0);
// Prices are dollars as numbers; anything blank, zero or unreadable means "no price".
const parsePrice = s => { const n = Number(String(s == null ? '' : s).replace(/[$,\s]/g, '')); return Number.isFinite(n) && n > 0 && n < 100000 ? Math.round(n * 100) / 100 : null; };
const priceText = n => n == null ? '' : n.toFixed(2);
const monthKey = (offset = 0) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset); return iso(d).slice(0, 7); };
const ls = {
  get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} },
};
const standalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function h(tag, attrs, ...kids){
  const el = document.createElement(tag); let val;
  for (const [k, v] of Object.entries(attrs || {})){
    if (v == null || v === false) continue;
    if (k === 'value'){ val = v; continue; }
    if (k === 'text') el.textContent = v;
    else if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)){ if (c == null || c === false) continue; el.append(c instanceof Node ? c : String(c)); }
  if (val !== undefined) el.value = val;
  return el;
}

function errText(e){
  if (e && e.mine) return e.message;
  switch (e && e.code){
    case 'cancelled': return '';
    case 'bad_key': return "Your Claude API key wasn't accepted. Check it in Settings.";
    case 'no_access': return "Your API key can't use this model. Check it in the Anthropic Console.";
    case 'rate_limited': return 'Claude is busy or your API key hit its limit. Try again in a minute.';
    case 'bad_request': return e.detail ? `Claude couldn't do that: ${e.detail}` : "Claude couldn't do that one. Try again.";
    case 'offline': return "Couldn't reach Claude. Check your connection.";
    case 'refused': return 'Claude declined that one. Try different wording or a different photo.';
    case 'invalid_json': return "Claude's answer didn't come through in a usable form. Try again.";
    case 'image_rejected': return "That photo couldn't be read. Try a different one.";
    case 'upstream_error': return "Claude didn't answer. Try again in a minute.";
    case 'permission-denied': return "This account isn't allowed to save here. Check the Firestore rules.";
    case 'unauthenticated': return 'Sign in again to keep syncing.';
    case 'resource-exhausted': return "Today's free sync limit is used up. Try again tomorrow.";
    case 'not-found': return 'That was already removed, maybe on another device.';
  }
  return "Couldn't save that. Check your connection and try again.";
}
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { const m = errText(e); if (m) toast(m); } };

function toast(msg, actions=[]){
  const t = $('#toast');
  t.replaceChildren(h('span', {text:msg}), h('span', {}, actions.map(a =>
    h('button', {class:'link', type:'button', onclick: guard(async () => { t.hidden = true; await a.fn(); })}, a.label))));
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, actions.length ? 7000 : 3500);
}

// One Claude call at a time, with a Stop button in the status line.
async function withAI(box, label, run){
  if (aiCtl) return;
  aiCtl = new AbortController();
  box.className = 'aistatus'; box.hidden = false;
  box.replaceChildren(h('span', {text:label}), h('button', {class:'link', type:'button', onclick: () => aiCtl && aiCtl.abort()}, 'Stop'));
  document.body.classList.add('busy');
  try { await run(aiCtl.signal); box.hidden = true; }
  catch (e) {
    const m = errText(e);
    if (m){ box.className = 'aistatus err'; box.replaceChildren(h('span', {text:m}), h('button', {class:'link', type:'button', onclick: () => { box.hidden = true; }}, 'Dismiss')); }
    else box.hidden = true;
  }
  finally { aiCtl = null; document.body.classList.remove('busy'); }
}

// ---------- storage ----------
// Both stores expose the same small surface the app uses: collection(path).add/onSnapshot and
// doc(path).set/update/delete/onSnapshot. Writes resolve at once and land in the local view
// immediately; a write the server later rejects shows a toast.

// Signed-in sync: each person's kitchen lives under users/<uid>/ in Firestore.
function cloudStore(base){
  const F = fb.F, fs = fb.firestore;
  const report = e => { const m = errText(e); if (m) toast(m); };
  const later = p => { p.catch(report); return Promise.resolve(); };
  const docSnap = s => ({id: s.id, exists: s.exists(), data: () => s.data()});
  const wrapDoc = ref => ({
    id: ref.id,
    set: data => later(F.setDoc(ref, data)),
    update: data => later(F.updateDoc(ref, data)),
    delete: () => later(F.deleteDoc(ref)),
    onSnapshot: (next, err) => F.onSnapshot(ref, s => next(docSnap(s)), err),
  });
  return {
    doc: path => wrapDoc(F.doc(fs, base + '/' + path)),
    collection: path => {
      const col = F.collection(fs, base + '/' + path);
      return {
        add: async data => { const ref = F.doc(col); later(F.setDoc(ref, data)); return {id: ref.id}; },
        onSnapshot: (next, err) => F.onSnapshot(col, s => next({docs: s.docs.map(docSnap)}), err),
      };
    },
  };
}

// No sync set up: keep everything in this browser.
function localStore(){
  let data;
  try { data = JSON.parse(ls.get(LOCAL_STORE)) || {}; } catch (e) { data = {}; }
  const subs = new Set();
  const save = () => { ls.set(LOCAL_STORE, JSON.stringify(data)); for (const f of subs) f(); };
  const copy = v => v && JSON.parse(JSON.stringify(v));
  const watch = f => { subs.add(f); queueMicrotask(f); return () => subs.delete(f); };
  const doc = path => {
    const i = path.lastIndexOf('/'), c = path.slice(0, i), id = path.slice(i + 1);
    return {
      id,
      set: async d => { (data[c] ||= {})[id] = copy(d); save(); },
      update: async d => { if (!data[c] || !data[c][id]) throw {code:'not-found'}; Object.assign(data[c][id], copy(d)); save(); },
      delete: async () => { if (data[c]) delete data[c][id]; save(); },
      onSnapshot: next => watch(() => { const v = data[c] && data[c][id]; next({id, exists: !!v, data: () => copy(v)}); }),
    };
  };
  return {
    doc,
    collection: c => ({
      add: async d => { const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); (data[c] ||= {})[id] = copy(d); save(); return {id}; },
      onSnapshot: next => watch(() => next({docs: Object.entries(data[c] || {}).map(([id, v]) => ({id, exists: true, data: () => copy(v)}))})),
    }),
  };
}

async function loadFirebase(){
  const [A0, A, F] = await Promise.all([import(FIREBASE + 'firebase-app.js'), import(FIREBASE + 'firebase-auth.js'), import(FIREBASE + 'firebase-firestore.js')]);
  const app = A0.initializeApp(firebaseConfig);
  let firestore;
  try { firestore = F.initializeFirestore(app, {localCache: F.persistentLocalCache({tabManager: F.persistentMultipleTabManager()})}); }
  catch (e) { firestore = F.getFirestore(app); }
  return {A, F, firestore, auth: A.getAuth(app)};
}

// Anything added before sync was set up moves into the signed-in kitchen once.
async function moveLocalData(){
  let data;
  try { data = JSON.parse(ls.get(LOCAL_STORE)); } catch (e) { data = null; }
  if (!data) return;
  let n = 0;
  for (const [c, docs] of Object.entries(data)) for (const [id, v] of Object.entries(docs || {})){ await db.doc(c + '/' + id).set(v); n++; }
  ls.set(LOCAL_STORE, null);
  if (n) toast(`Moved ${n} thing${n === 1 ? '' : 's'} from this device into your synced kitchen`);
}

// ---------- Claude ----------
// Calls go straight from this device to Anthropic with the viewer's own API key.
// Every request asks for JSON matching a schema, so answers always parse.
const obj = (props, req = Object.keys(props)) => ({type:'object', properties: props, required: req, additionalProperties: false});
const str = {type:'string'}, int = {type:'integer'}, strs = {type:'array', items: str};
const placeEnum = {type:'string', enum: Object.keys(PLACES)};
const RECIPE = {title: str, minutes: int, why: str, uses: strs, missing: strs, ingredients: strs, steps: strs};
const SCHEMA = {
  days: obj({days: int}),
  photo: obj({items: {type:'array', items: obj({name: str, qty: str, place: placeEnum, days: int, price: {type:'number'}})}}),
  price: obj({price: {type:'number'}}),
  putAway: obj({items: {type:'array', items: obj({name: str, place: placeEnum, days: int})}}),
  recipes: obj({recipes: {type:'array', items: obj(RECIPE)}}),
  plan: obj({dinners: {type:'array', items: obj({date: {type:'string', format:'date'}, ...RECIPE})}}),
  check: obj({ok: {type:'boolean'}}),
};

let sdk = null;
const loadSDK = () => sdk ||= import(ANTHROPIC_SDK).then(m => m.default).catch(e => { sdk = null; throw {code:'offline'}; });

function aiError(Anthropic, e){
  if (e && typeof e.code === 'string') return e;
  if (e instanceof Anthropic.APIUserAbortError || (e && e.name === 'AbortError')) return {code:'cancelled'};
  if (e instanceof Anthropic.AuthenticationError) return {code:'bad_key'};
  if (e instanceof Anthropic.PermissionDeniedError) return {code:'no_access'};
  if (e instanceof Anthropic.RateLimitError) return {code:'rate_limited'};
  if (e instanceof Anthropic.BadRequestError) return {code:'bad_request', detail: e.error && e.error.error && e.error.error.message};
  if (e instanceof Anthropic.APIConnectionError) return {code:'offline'};
  return {code:'upstream_error'};
}

function makeClaude(apiKey){
  if (!apiKey) return null;
  let client = null;
  async function json(prompt, {schema, images = [], signal, effort = 'medium'}){
    const Anthropic = await loadSDK();
    client ||= new Anthropic({apiKey, dangerouslyAllowBrowser: true});
    try {
      const content = images.map(img => ({type:'image', source:{type:'base64', media_type: img.type, data: img.data}}));
      content.push({type:'text', text: prompt});
      const res = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: {effort, format: {type:'json_schema', schema}},
        messages: [{role:'user', content}],
      }, {signal});
      if (res.stop_reason === 'refusal') throw {code:'refused'};
      if (res.stop_reason === 'max_tokens') throw {code:'invalid_json'};
      const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
      try { return JSON.parse(text); } catch (e) { throw {code:'invalid_json'}; }
    } catch (e) { throw aiError(Anthropic, e); }
  }
  return {json, test: signal => json('Reply with {"ok": true}.', {schema: SCHEMA.check, effort:'low', signal})};
}

function applyAI(){
  claude = makeClaude(ls.get(KEY_STORE));
  document.body.classList.toggle('no-ai', !claude);
}

// Photos are shrunk to about a megapixel as JPEG before sending: plenty to read a receipt, and small to upload.
async function prepImage(file){
  let src;
  try { src = await createImageBitmap(file, {imageOrientation:'from-image'}); }
  catch (e) {
    src = await new Promise((ok, bad) => { const img = new Image(); img.onload = () => ok(img); img.onerror = () => bad({code:'image_rejected'}); img.src = URL.createObjectURL(file); });
  }
  const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
  if (!w0 || !h0) throw {code:'image_rejected'};
  const k = Math.min(1, Math.sqrt(1.15e6 / (w0 * h0)));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  const blob = await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.85));
  if (!blob) throw {code:'image_rejected'};
  const data = await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.readAsDataURL(blob); });
  return {type:'image/jpeg', data};
}

// ---------- what's in the kitchen ----------
function itemStatus(it){
  const d = daysUntil(it.expires);
  if (d === null) return {group:'none', tone:'', label:'No date'};
  if (d < 0) return {group:'expired', tone:'bad', label: d === -1 ? 'Expired yesterday' : `Expired ${-d} days ago`};
  if (d === 0) return {group:'soon', tone:'bad', label:'Use today'};
  if (d === 1) return {group:'soon', tone:'warn', label:'Use by tomorrow'};
  if (d <= 3) return {group:'soon', tone:'warn', label:`${d} days left`};
  if (d <= 7) return {group:'week', tone:'ok', label:`${d} days left`};
  return {group:'later', tone:'', label: d > 60 ? `${Math.round(d/30)} months left` : `${d} days left`};
}
const GROUPS = [['expired','Expired'],['soon','Use soon'],['week','This week'],['later','Later'],['none','No use-by date']];
const stampFor = it => { const d = parse(it.expires); return (it.guessed ? 'EST. ' : '') + 'USE BY ' + pad(d.getDate()) + ' ' + MON[d.getMonth()]; };
const findItem = name => state.items.find(i => norm(i.name) === norm(name));

function renderStatus(){
  const ds = state.items.map(i => daysUntil(i.expires)).filter(d => d !== null);
  const exp = ds.filter(d => d < 0).length, soon = ds.filter(d => d >= 0 && d <= 3).length;
  const parts = [];
  if (exp) parts.push(`${exp} expired`);
  if (soon) parts.push(`${soon} to use within 3 days`);
  const s = $('#status');
  s.textContent = parts.join(' · ') || (state.items.length ? 'Nothing expiring soon' : '');
  s.className = 'status link' + (exp ? ' bad' : soon ? ' warn' : '');
}

function captureEdit(){
  const f = $('form[data-edit]');
  if (!f) return null;
  const v = {}; for (const el of f.querySelectorAll('[name]')) v[el.name] = el.value;
  return {id: f.dataset.edit, v};
}
function restoreEdit(k){
  if (!k) return;
  const f = $(`form[data-edit="${k.id}"]`);
  if (f) for (const el of f.querySelectorAll('[name]')) if (k.v[el.name] != null) el.value = k.v[el.name];
}

function renderCabinet(){
  const keep = captureEdit();
  const box = $('#items');
  box.replaceChildren();
  if (!state.loaded.items){ box.append(h('p', {class:'empty', text:'Opening your cabinet…'})); return; }
  const items = state.items.filter(i => state.place === 'all' || i.place === state.place);
  if (!items.length){
    box.append(h('p', {class:'empty', text: state.items.length ? `Nothing in the ${PLACES[state.place].toLowerCase()} yet.` :
      "Your cabinet is empty. Add what's in your fridge, freezer and pantry above."}));
    return;
  }
  for (const [g, label] of GROUPS){
    const rows = items.filter(i => itemStatus(i).group === g)
      .sort((a, b) => (a.expires || '9').localeCompare(b.expires || '9') || a.name.localeCompare(b.name));
    if (!rows.length) continue;
    const atStake = g === 'expired' ? rows.reduce((s, i) => s + (i.price || 0), 0) : 0;
    box.append(h('h2', {text:`${label} · ${rows.length}${atStake ? ' · ' + money(atStake) : ''}`}), h('div', {class:'list'}, rows.map(itemRow)));
  }
  restoreEdit(keep);
}

function itemRow(it){
  if (state.editing === it.id) return editRow(it);
  const st = itemStatus(it);
  return h('div', {class:'row ' + st.tone},
    h('button', {class:'rowmain', type:'button', 'aria-label':'Edit ' + it.name, onclick: () => { state.editing = it.id; renderCabinet(); }},
      h('span', {class:'name', text:it.name}),
      h('span', {class:'meta'}, it.qty ? h('span', {text:it.qty}) : null, h('span', {text: PLACES[it.place] || ''}),
        it.price != null ? h('span', {text: money(it.price)}) : null,
        it.expires ? h('span', {class:'stamp', text: stampFor(it)}) : null)),
    h('div', {class:'rowside'},
      st.tone ? h('span', {class:'pill ' + st.tone, text:st.label}) : h('span', {class:'soft', text:st.label}),
      h('div', {class:'rowbtns'},
        h('button', {class:'link', type:'button', onclick: guard(() => removeItem(it, 'used'))}, 'Used up'),
        h('button', {class:'link toss', type:'button', 'aria-label':'Threw out ' + it.name, onclick: guard(() => removeItem(it, 'tossed'))}, 'Tossed'))));
}

function placeSelect(v){
  return h('select', {name:'place', value: v || 'fridge'}, Object.entries(PLACES).map(([k, l]) => h('option', {value:k}, l)));
}

function editRow(it){
  const f = h('form', {class:'row edit', 'data-edit': it.id, onsubmit: guard(async e => {
    e.preventDefault();
    const val = n => f.querySelector(`[name="${n}"]`).value.trim();
    const v = {name: val('name'), qty: val('qty'), place: val('place'), expires: val('expires'), price: parsePrice(val('price'))};
    if (!v.name) return;
    if (v.expires !== (it.expires || '')) v.guessed = false;
    state.editing = null;
    await db.doc('items/' + it.id).update(v);
    renderCabinet();
  })},
    h('label', {class:'field'}, 'Item', h('input', {name:'name', value: it.name, required:true})),
    h('label', {class:'field'}, 'Amount', h('input', {name:'qty', value: it.qty || ''})),
    h('label', {class:'field'}, 'Kept in', placeSelect(it.place)),
    h('label', {class:'field'}, 'Use by', h('input', {name:'expires', type:'date', value: it.expires || ''})),
    h('label', {class:'field'}, 'Price', h('input', {name:'price', inputmode:'decimal', placeholder:'$0.00', value: priceText(it.price)})),
    h('div', {class:'editbar'},
      h('button', {class:'btn', type:'submit'}, 'Save'),
      h('button', {class:'link', type:'button', onclick: () => { state.editing = null; renderCabinet(); }}, 'Cancel'),
      h('button', {class:'link danger', type:'button', onclick: guard(() => { state.editing = null; return removeItem(it, 'deleted'); })}, 'Delete')));
  return f;
}

// how: 'used' (eaten), 'tossed' (thrown out, so it counts as waste), 'deleted' (entered by mistake).
async function removeItem(it, how){
  const {id, ...data} = it;
  await db.doc('items/' + id).delete();
  let wasteId = null;
  if (how === 'tossed'){
    const d = daysUntil(it.expires);
    const price = it.price == null ? null : it.price;
    const ref = await db.collection('waste').add({name: it.name, qty: it.qty || '', place: it.place || '', price, estimated: false,
      reason: d !== null && d < 0 ? 'expired' : 'tossed', expires: it.expires || '', date: today(), at: Date.now()});
    wasteId = ref.id;
    if (price == null && claude) guessPrice(wasteId, it);
  }
  const label = how === 'tossed' ? `Tossed ${it.name}${it.price != null ? ', ' + money(it.price) + ' wasted' : ''}` : how === 'deleted' ? `Deleted ${it.name}` : `Used up ${it.name}`;
  toast(label, [
    {label:'Undo', fn: async () => { await db.doc('items/' + id).set(data); if (wasteId) await db.doc('waste/' + wasteId).delete(); }},
    {label:'Add to list', fn: async () => { const n = await addShopping([it.name]); toast(n ? `${it.name} is on the list` : `${it.name} was already on the list`); }},
  ]);
}

// A tossed item with no price gets Claude's estimate of what it usually costs, marked as estimated.
async function guessPrice(wasteId, it){
  try {
    const g = await claude.json(`What does ${it.qty ? it.qty + ' of ' : ''}"${it.name}" typically cost at a US grocery store, in dollars? Answer with your best single estimate.`, {schema: SCHEMA.price, effort:'low'});
    const price = parsePrice(g && g.price);
    if (price == null || !state.waste.some(w => w.id === wasteId && w.price == null)) return;
    await db.doc('waste/' + wasteId).update({price, estimated: true});
  } catch (e) { /* the entry stays without a price; it can be filled in by hand */ }
}

async function guessDate(id, v){
  try {
    const g = await claude.json(`Today is ${today()}. How many days does "${v.name}" usually stay good, kept in the ${v.place}, from when it's bought? For dry or canned goods give the typical unopened shelf life. Answer with the number of days.`, {schema: SCHEMA.days, effort:'low'});
    const exp = days2date(g && g.days);
    const it = state.items.find(i => i.id === id);
    if (!exp || !it || it.expires) return;
    await db.doc('items/' + id).update({expires: exp, guessed: true});
    toast(`Estimated ${v.name} keeps until ${shortDate(exp)}`, [{label:'Change', fn: () => { showTab('cabinet'); state.editing = id; renderCabinet(); }}]);
  } catch (e) { /* an estimate is optional; the item is already saved */ }
}

// ---------- photo intake ----------
const photoPrompt = () => `These are photos of groceries: a receipt, a grocery haul, or the inside of a fridge or cupboard. Today is ${today()}.
List each food item you can identify. On a receipt, turn store abbreviations into plain names (for example "ORG BNLS CHKN BRST" becomes "chicken breast") and skip bags, deposits, tax, totals and anything that isn't food.
For each item give a short plain name, the amount if you can tell (for example "1.5 lb" or "2 cans", otherwise ""), where it is usually kept (fridge, freezer or pantry), and how many days it typically stays good from today when bought fresh. For dry or canned goods give the unopened shelf life.
For "price", give what was paid for that line in dollars when a receipt shows it, after any discount printed on the receipt for it; otherwise 0.`;

function renderDraft(){
  const box = $('#draft'), rows = state.draft;
  if (!rows){ box.hidden = true; box.replaceChildren(); return; }
  const n = rows.filter(r => r.keep).length;
  box.hidden = false;
  box.replaceChildren(
    h('h3', {text:`Found ${rows.length} item${rows.length === 1 ? '' : 's'}. Check them, then add.`}),
    rows.map(r => h('div', {class:'drow'},
      h('input', {type:'checkbox', checked: r.keep, 'aria-label':'Keep ' + r.name, onchange: e => { r.keep = e.target.checked; renderDraft(); }}),
      h('input', {value:r.name, 'aria-label':'Item', oninput: e => { r.name = e.target.value; }}),
      h('input', {value:r.qty, placeholder:'Qty', 'aria-label':'Amount', oninput: e => { r.qty = e.target.value; }}),
      h('input', {value:r.price, placeholder:'$', inputmode:'decimal', 'aria-label':'Price', oninput: e => { r.price = e.target.value; }}),
      h('div', {class:'wide'},
        h('select', {value:r.place, 'aria-label':'Kept in', onchange: e => { r.place = e.target.value; }}, Object.entries(PLACES).map(([k, l]) => h('option', {value:k}, l))),
        h('input', {type:'date', value:r.expires, 'aria-label':'Use by', onchange: e => { r.expires = e.target.value; r.guessed = false; }})))),
    h('div', {class:'bar'},
      h('button', {class:'btn', type:'button', disabled: !n, onclick: guard(async () => {
        const keep = state.draft.filter(r => r.keep && r.name.trim());
        state.draft = null; renderDraft();
        for (const r of keep) await db.collection('items').add({name:r.name.trim(), qty:r.qty.trim(), place:r.place, expires:r.expires, guessed:r.guessed && !!r.expires, price: parsePrice(r.price), added:Date.now()});
        toast(`Added ${keep.length} item${keep.length === 1 ? '' : 's'}`);
      })}, `Add ${n} item${n === 1 ? '' : 's'}`),
      h('button', {class:'link', type:'button', onclick: () => { state.draft = null; renderDraft(); }}, 'Discard')));
}

// ---------- shopping ----------
async function addShopping(names){
  const have = new Set(state.shopping.filter(s => !s.done).map(s => norm(s.name)));
  let n = 0;
  for (const raw of names){
    const name = String(raw).trim();
    if (!name || have.has(norm(name))) continue;
    have.add(norm(name));
    await db.collection('shopping').add({name, done:false, added:Date.now()});
    n++;
  }
  return n;
}
const onList = name => state.shopping.some(s => !s.done && norm(s.name) === norm(name));
const stillNeed = r => (r.missing || []).filter(n => !onList(n) && !findItem(n));

function renderShop(){
  const box = $('#shopList');
  const open = state.shopping.filter(s => !s.done).sort((a, b) => (a.added || 0) - (b.added || 0));
  const done = state.shopping.filter(s => s.done).sort((a, b) => (a.added || 0) - (b.added || 0));
  $('#shopCount').textContent = open.length ? String(open.length) : '';
  box.replaceChildren();
  if (!state.loaded.shopping) box.append(h('p', {class:'empty', text:'Opening your list…'}));
  else if (!state.shopping.length) box.append(h('p', {class:'empty', text:'Nothing on the list. Add things here, or from a recipe on the Cook tab.'}));
  else {
    const row = s => h('div', {class:'row shop' + (s.done ? ' done' : '')},
      h('input', {type:'checkbox', id:'s-' + s.id, checked: s.done, onchange: guard(e => db.doc('shopping/' + s.id).update({done: e.target.checked}))}),
      h('label', {class:'name', for:'s-' + s.id, text:s.name}),
      h('button', {class:'x', type:'button', 'aria-label':'Remove ' + s.name, onclick: guard(() => db.doc('shopping/' + s.id).delete())}, '×'));
    if (open.length) box.append(h('div', {class:'list'}, open.map(row)));
    if (done.length) box.append(h('h2', {text:`In the cart · ${done.length}`, style:'margin:16px 0 8px'}), h('div', {class:'list'}, done.map(row)));
  }
  $('#shopBar').hidden = !done.length;
  $('#putAway').textContent = `Put ${done.length} bought item${done.length === 1 ? '' : 's'} in the cabinet`;
}

const putAwayPrompt = names => `Today is ${today()}. Someone just bought these groceries:
${names.map(n => '- ' + n).join('\n')}
For each one, in the same order and with the same name, say where it is usually kept (fridge, freezer or pantry) and how many days it typically stays good from today when bought fresh. For dry or canned goods give the unopened shelf life.`;

// ---------- recipes ----------
function inventoryLines(){
  const lines = state.items.slice().sort((a, b) => (a.expires || '9999').localeCompare(b.expires || '9999'))
    .map(i => `- ${i.name}${i.qty ? ' | ' + i.qty : ''} | ${PLACES[i.place] || ''} | ${i.expires ? 'use by ' + i.expires + ' (' + itemStatus(i).label.toLowerCase() + ')' : 'no date'}`);
  return lines.join('\n') || '(nothing recorded yet)';
}
function prefsText(){
  const p = state.prefs || {};
  return [p.diet && `Diet: ${p.diet}`, p.dislikes && `Won't eat: ${p.dislikes}`, p.time && `Time to cook on a weeknight: ${p.time}`,
    p.servings && `Cooking for: ${p.servings}`, p.notes && `Other: ${p.notes}`].filter(Boolean).join('\n') || 'None given.';
}
function cleanRecipe(r){
  if (!r || typeof r.title !== 'string' || !r.title.trim()) return null;
  const arr = v => Array.isArray(v) ? v.map(String).map(s => s.trim()).filter(Boolean) : [];
  const m = Math.round(Number(r.minutes));
  return {title: r.title.trim(), minutes: Number.isFinite(m) && m > 0 ? m : null, why: typeof r.why === 'string' ? r.why : '',
    uses: arr(r.uses), missing: arr(r.missing), ingredients: arr(r.ingredients), steps: arr(r.steps)};
}
const recipeData = r => ({title:r.title, minutes:r.minutes, why:r.why, uses:r.uses, missing:r.missing, ingredients:r.ingredients, steps:r.steps});

const suggestPrompt = mood => `You help someone decide what to cook with what's already in their kitchen. Today is ${today()}.

What they have (name | amount | kept in | use-by):
${inventoryLines()}

Their tastes:
${prefsText()}
${mood ? `\nRight now they're in the mood for: ${mood}\n` : ''}
Suggest 4 recipes. Lean on whatever expires soonest, and skip anything already expired. Prefer recipes that need little or nothing from the store. Assume salt, pepper, cooking oil and water are on hand.

For each recipe: "why" is one short sentence on why it fits now (for example "Uses the spinach before tomorrow."). "uses" names items from their list exactly as written. "missing" is what they'd need to buy, as short shopping-list names. "ingredients" include amounts. At most 8 short steps.`;

function usesLine(r){
  if (!r.uses.length) return null;
  return h('p', {class:'why'}, 'Uses ' + r.uses.map(n => {
    const it = findItem(n); const st = it && itemStatus(it);
    return st && (st.group === 'soon' || st.group === 'expired') ? `${n} (${st.label.toLowerCase()})` : n;
  }).join(', '));
}

async function saveRecipe(r){
  if (r.savedId) return r.savedId;
  const ref = await db.collection('recipes').add({...recipeData(r), saved: Date.now()});
  r.savedId = ref.id;
  return ref.id;
}

function nextDays(n){ const t = today(); return Array.from({length:n}, (_, i) => addDays(t, i)); }

function recipeCard(r){
  const need = stillNeed(r);
  const day = h('select', {'aria-label':'Day', value: r.day || today(), onchange: e => { r.day = e.target.value; }}, nextDays(7).map(d => h('option', {value:d}, d === today() ? 'Today' : dayLabel(d))));
  const slot = h('select', {'aria-label':'Meal', value: r.slot || 'dinner', onchange: e => { r.slot = e.target.value; }}, SLOTS.map(s => h('option', {value:s}, cap(s))));
  return h('article', {class:'card'},
    h('h3', {text:r.title}),
    h('div', {class:'meta'}, r.minutes ? h('span', {text:`${r.minutes} min`}) : null),
    r.why ? h('p', {class:'why', text:r.why}) : null,
    usesLine(r),
    h('p', {class:'need'}, need.length ? [h('b', {text:'To buy: '}), need.join(', ')] : 'Nothing to buy'),
    h('details', {open: r.open, ontoggle: e => { r.open = e.target.open; }}, h('summary', {}, 'Ingredients and steps'),
      h('ul', {}, r.ingredients.map(x => h('li', {text:x}))), h('ol', {}, r.steps.map(x => h('li', {text:x})))),
    h('div', {class:'cardbar'},
      need.length ? h('button', {class:'btn ghost', type:'button', onclick: guard(async () => { const n = await addShopping(need); toast(`Added ${n} to the list`); })}, `Add ${need.length} to the list`) : null,
      h('button', {class:'btn ghost', type:'button', disabled: !!r.savedId, onclick: guard(async () => { await saveRecipe(r); renderSuggestions(); toast('Saved to your recipes'); })}, r.savedId ? 'Saved' : 'Save')),
    h('div', {class:'planrow'}, day, slot, h('button', {class:'btn', type:'button', onclick: guard(async () => {
      const id = await saveRecipe(r);
      await setSlot(day.value, slot.value, {title:r.title, recipeId:id});
      renderSuggestions();
      toast(`Planned ${slot.value} for ${day.value === today() ? 'today' : dayLabel(day.value)}`);
    })}, 'Plan it')));
}
function renderSuggestions(){ $('#suggestions').replaceChildren(...state.suggestions.map(recipeCard)); }

function renderSaved(){
  const box = $('#saved');
  box.replaceChildren();
  if (!state.loaded.recipes){ box.append(h('p', {class:'empty', text:'Opening your recipes…'})); return; }
  if (!state.recipes.length){ box.append(h('p', {class:'empty', text:'Recipes you save or plan show up here.'})); return; }
  const list = state.recipes.slice().sort((a, b) => (b.saved || 0) - (a.saved || 0));
  box.append(h('div', {class:'list'}, list.map(r => h('div', {class:'row'},
    h('button', {class:'rowmain', type:'button', onclick: () => openRecipe(r)},
      h('span', {class:'name', text:r.title}),
      h('span', {class:'meta'}, r.minutes ? h('span', {text:`${r.minutes} min`}) : null, h('span', {text:`${(r.ingredients || []).length} ingredients`})))))));
}

// Bottom sheet shared by recipes, settings and the waste summary.
function openSheet(label, build, onClose){
  const close = () => { sheet.remove(); document.removeEventListener('keydown', esc); if (onClose) onClose(); };
  const esc = e => { if (e.key === 'Escape') close(); };
  const panel = h('div', {class:'panel', role:'dialog', 'aria-modal':'true', 'aria-label': label});
  const sheet = h('div', {class:'sheet', onclick: e => { if (e.target === sheet) close(); }}, panel);
  panel.append(h('div', {class:'sheethead'}, h('h3', {text:label}), h('button', {class:'link', type:'button', onclick: close}, 'Close')), ...build(close));
  document.body.append(sheet);
  document.addEventListener('keydown', esc);
  panel.querySelector('.link').focus();
  return close;
}

function openRecipe(r){
  const need = stillNeed(r);
  openSheet(r.title, close => {
    let armed = false;
    const del = h('button', {class:'link danger', type:'button', onclick: guard(async () => {
      if (!armed){ armed = true; del.textContent = 'Tap again to delete'; return; }
      close(); await db.doc('recipes/' + r.id).delete(); toast(`Deleted ${r.title}`);
    })}, 'Delete recipe');
    return [
      r.minutes ? h('div', {class:'meta'}, `${r.minutes} min`) : null,
      r.why ? h('p', {class:'why', text:r.why}) : null,
      h('p', {class:'need'}, need.length ? [h('b', {text:'To buy: '}), need.join(', ')] : 'Nothing to buy'),
      h('h4', {}, 'Ingredients'), h('ul', {}, (r.ingredients || []).map(x => h('li', {text:x}))),
      h('h4', {}, 'Steps'), h('ol', {}, (r.steps || []).map(x => h('li', {text:x}))),
      h('div', {class:'bar'},
        need.length ? h('button', {class:'btn ghost', type:'button', onclick: guard(async () => { const n = await addShopping(need); close(); toast(`Added ${n} to the list`); })}, `Add ${need.length} to the list`) : null,
        del),
    ].filter(Boolean);
  });
}

// ---------- meal plan ----------
function slotValue(v){ return typeof v === 'string' ? (v ? {title:v} : null) : (v && v.title ? v : null); }

async function setSlot(date, slot, val){
  const cur = {...(state.meals[date] || {})};
  if (val) cur[slot] = val; else delete cur[slot];
  state.meals[date] = cur;
  await db.doc('meals/' + date).set(cur);
}

let planPending = false;
function renderPlan(){
  const box = $('#days');
  if (box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT'){ planPending = true; return; }
  const ws = state.weekStart;
  $('#weekLabel').textContent = ws === today() ? 'Next 7 days' : `${dayLabel(ws)} – ${dayLabel(addDays(ws, 6))}`;
  box.replaceChildren();
  for (let i = 0; i < 7; i++){
    const d = addDays(ws, i), m = state.meals[d] || {};
    box.append(h('div', {class:'day' + (d === today() ? ' today' : '')},
      h('h3', {}, dayLabel(d), d === today() ? h('span', {class:'tag', text:'Today'}) : null),
      SLOTS.map(s => slotRow(d, s, slotValue(m[s])))));
  }
}
function slotRow(d, s, val){
  const id = `m-${d}-${s}`;
  const recipe = val && val.recipeId && state.recipes.find(r => r.id === val.recipeId);
  return h('div', {class:'slot'},
    h('label', {for:id, text:cap(s)}),
    h('input', {id, value: val ? val.title : '', placeholder:'—', onchange: guard(e => {
      const t = e.target.value.trim();
      return setSlot(d, s, t ? {title:t, recipeId: val && t === val.title ? (val.recipeId || null) : null} : null);
    })}),
    recipe ? h('button', {class:'link', type:'button', onclick: () => openRecipe(recipe)}, 'Recipe') : h('span'));
}
function weekRecipes(){
  const out = [];
  for (let i = 0; i < 7; i++){
    const m = state.meals[addDays(state.weekStart, i)] || {};
    for (const s of SLOTS){ const v = slotValue(m[s]); const r = v && v.recipeId && state.recipes.find(x => x.id === v.recipeId); if (r) out.push(r); }
  }
  return out;
}

const planPrompt = (dates, planned) => `You plan dinners from what someone already has. Today is ${today()}.

What they have (name | amount | kept in | use-by):
${inventoryLines()}

Their tastes:
${prefsText()}

Meals already planned around these days (don't repeat them):
${planned.length ? planned.map(t => '- ' + t).join('\n') : 'none'}

Plan one dinner for each of these dates: ${dates.join(', ')}.
Use the items that expire soonest on the earliest dates, and skip anything already expired. Reuse ingredients across the week so the shopping list stays short. Assume salt, pepper, cooking oil and water are on hand.

For each dinner: "date" is one of the dates above. "why" is one short sentence on why it fits that day. "uses" names items from their list exactly as written. "missing" is what they'd need to buy, as short shopping-list names. "ingredients" include amounts. At most 6 short steps.`;

// ---------- waste ----------
// Every "Tossed" leaves a record in waste/. Totals count only entries that have a price.
const sumPrice = list => list.reduce((s, x) => s + (x.price || 0), 0);
const expiredNow = () => state.items.filter(i => itemStatus(i).group === 'expired');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
let wasteView = null;

function renderWasteBar(){
  const bar = $('#wasteBar');
  const staleCost = sumPrice(expiredNow());
  bar.hidden = !state.waste.length && !staleCost;
  if (!bar.hidden) bar.replaceChildren(
    h('span', {}, 'Wasted this month ', h('b', {text: money(sumPrice(state.waste.filter(w => (w.date || '').startsWith(monthKey()))))}),
      staleCost ? ` · ${money(staleCost)} expired in the cabinet` : ''),
    h('span', {class:'more', text:'Details ›'}));
  if (wasteView) wasteView();
}

function wasteRow(w){
  return h('div', {class:'wrow'},
    h('div', {},
      h('div', {class:'name', text: w.name}),
      h('div', {class:'meta', text: [w.date ? shortDate(w.date) : '', w.reason === 'expired' ? 'expired' : 'thrown out', w.qty].filter(Boolean).join(' · ')})),
    h('span', {class:'est', text: w.estimated ? '~' : ''}),
    h('input', {inputmode:'decimal', placeholder:'$', 'aria-label':'Price of ' + w.name, value: priceText(w.price),
      onchange: guard(e => db.doc('waste/' + w.id).update({price: parsePrice(e.target.value), estimated: false}))}),
    h('button', {class:'x', type:'button', 'aria-label':'Remove ' + w.name + ' from the waste log', onclick: guard(() => db.doc('waste/' + w.id).delete())}, '×'));
}

function openWaste(){
  const body = h('div', {class:'tab'});
  let pending = false;
  body.addEventListener('focusout', () => { if (pending){ pending = false; setTimeout(draw); } });
  const draw = () => {
    if (body.contains(document.activeElement) && document.activeElement.tagName === 'INPUT'){ pending = true; return; }
    const W = state.waste.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
    const since = prefix => W.filter(w => (w.date || '').startsWith(prefix));
    const stat = (label, list) => h('div', {class:'stat'}, h('b', {text: money(sumPrice(list))}), h('span', {text: `${label} · ${plural(list.length, 'item')}`}));
    const stale = expiredNow();
    const top = [...W.reduce((m, w) => {
      const t = m.get(norm(w.name)) || {name: w.name, n: 0, total: 0};
      t.n++; t.total += w.price || 0;
      return m.set(norm(w.name), t);
    }, new Map()).values()].filter(t => t.n > 1 || t.total > 0).sort((a, b) => b.total - a.total || b.n - a.n).slice(0, 5);
    const noPrice = W.filter(w => w.price == null).length;
    const notes = [noPrice ? `${plural(noPrice, 'item')} without a price ${noPrice === 1 ? "isn't" : "aren't"} in the totals; type a price to count ${noPrice === 1 ? 'it' : 'them'}.` : '',
      W.some(w => w.estimated) ? '~ marks prices Claude estimated.' : ''].filter(Boolean).join(' ');
    body.replaceChildren(...[
      h('div', {class:'stats'}, stat('This month', since(monthKey())), stat('Last month', since(monthKey(-1))), stat(today().slice(0, 4), since(today().slice(0, 4)))),
      stale.length ? h('p', {class:'note', text: `Still in your cabinet past its date: ${plural(stale.length, 'item')}${sumPrice(stale) ? ', ' + money(sumPrice(stale)) : ''}. Mark ${stale.length === 1 ? 'it' : 'them'} Tossed or Used up from the list.`}) : null,
      top.length ? h('h4', {}, 'Most wasted') : null,
      top.length ? h('ul', {}, top.map(t => h('li', {text: `${t.name}${t.n > 1 ? ' ×' + t.n : ''}${t.total ? ' · ' + money(t.total) : ''}`}))) : null,
      h('h4', {}, 'Thrown out'),
      W.length ? h('div', {}, W.map(wasteRow)) : h('p', {class:'note', text:'Nothing yet. When you throw something out, tap Tossed instead of Used up and it shows up here.'}),
      notes ? h('p', {class:'note', text: notes}) : null,
    ].filter(Boolean));
  };
  wasteView = draw;
  draw();
  openSheet('Food waste', () => [body], () => { wasteView = null; });
}

// ---------- settings ----------
function openSettings(){
  openSheet('Settings', close => {
    const keyIn = h('input', {type:'password', autocomplete:'off', autocapitalize:'off', spellcheck:'false', placeholder:'sk-ant-…', 'aria-label':'Claude API key', value: ls.get(KEY_STORE) || ''});
    const msg = h('p', {class:'keystatus', role:'status'});
    const say = (text, tone='') => { msg.className = 'keystatus' + (tone ? ' ' + tone : ''); msg.textContent = text; };
    const saveKey = () => {
      const k = keyIn.value.trim();
      ls.set(KEY_STORE, k || null);
      applyAI();
      return k;
    };
    let testing = null;
    const test = h('button', {class:'btn ghost', type:'button', onclick: async () => {
      if (testing){ testing.abort(); return; }
      if (!saveKey()){ say('Paste a key first.', 'err'); return; }
      testing = new AbortController();
      test.textContent = 'Stop'; say('Checking with Claude…');
      try { await claude.test(testing.signal); say('Your key works. Claude features are on.', 'ok'); }
      catch (e) { say(errText(e) || 'Check stopped.', e && e.code === 'cancelled' ? '' : 'err'); }
      finally { testing = null; test.textContent = 'Test key'; }
    }}, 'Test key');

    const syncPart = firebaseConfig
      ? (state.user ? [
          h('p', {class:'note', text:`Signed in as ${state.user.email}. Your kitchen syncs to every device you sign in on.`}),
          h('div', {class:'bar'}, h('button', {class:'btn ghost', type:'button', onclick: guard(async () => { close(); await fb.A.signOut(fb.auth); })}, 'Sign out')),
        ] : [h('p', {class:'note', text:'Not signed in.'})])
      : [h('p', {class:'note', text:"Sync isn't set up yet, so what you add stays on this device."})];

    const installPart = standalone() ? [] : [
      h('h4', {}, 'Put it on your home screen'),
      installEvent
        ? h('div', {class:'bar'}, h('button', {class:'btn ghost', type:'button', onclick: () => promptInstall()}, 'Install the app'))
        : h('p', {class:'note', text:'On iPhone, open this page in Safari, tap the Share button, then "Add to Home Screen". It then opens full screen like any other app.'}),
    ];

    return [
      h('h4', {}, 'Sync'), ...syncPart,
      h('h4', {}, 'Claude'),
      h('p', {class:'note'}, 'Photo reading, use-by estimates, recipe ideas and meal planning use your own Anthropic API key. It stays on this device and is only sent to Anthropic. Get one at ',
        h('a', {href:'https://console.anthropic.com/settings/keys', target:'_blank', rel:'noopener'}, 'console.anthropic.com'), '.'),
      keyIn,
      h('div', {class:'bar'},
        h('button', {class:'btn', type:'button', onclick: () => { say(saveKey() ? 'Saved. Claude features are on.' : 'Key removed. Claude features are off.', 'ok'); }}, 'Save'),
        test,
        h('button', {class:'link danger', type:'button', onclick: () => { keyIn.value = ''; saveKey(); say('Key removed. Claude features are off.'); }}, 'Remove')),
      msg,
      ...installPart,
    ];
  });
}

// ---------- install tip ----------
async function promptInstall(){
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => null);
  installEvent = null;
  renderTip();
}
function renderTip(){
  const tip = $('#installTip');
  const show = !standalone() && !ls.get(TIP_STORE) && (installEvent || isIOS());
  tip.hidden = !show;
  if (!show) return;
  const dismiss = h('button', {class:'link', type:'button', onclick: () => { ls.set(TIP_STORE, '1'); renderTip(); }}, 'Dismiss');
  tip.replaceChildren(
    h('span', {text: installEvent ? 'Install Kitchen Cabinet to open it from your home screen.' : 'Add this to your home screen: tap Share, then "Add to Home Screen".'}),
    h('span', {class:'bar'}, installEvent ? h('button', {class:'btn', type:'button', onclick: () => promptInstall()}, 'Install') : null, dismiss));
}

// ---------- tabs ----------
function showTab(t){
  for (const s of document.querySelectorAll('main > .tab')) s.hidden = s.id !== 'tab-' + t;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === t));
  ls.set('kc_tab', t);
  window.scrollTo(0, 0);
}
function initialTab(){
  const hash = location.hash.slice(1);
  if (TABS.includes(hash)) return hash;
  const t = ls.get('kc_tab');
  return TABS.includes(t) ? t : 'cabinet';
}

// ---------- wiring ----------
function wire(){
  for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => showTab(b.dataset.tab);
  $('#status').onclick = () => { state.place = 'all'; syncChips(); renderCabinet(); showTab('cabinet'); };
  $('#settingsBtn').onclick = openSettings;
  $('#wasteBar').onclick = openWaste;
  for (const b of document.querySelectorAll('[data-open-settings]')) b.onclick = openSettings;
  for (const c of document.querySelectorAll('#placeChips .chip')) c.onclick = () => { state.place = c.dataset.place; syncChips(); renderCabinet(); };

  $('#addForm').onsubmit = guard(async e => {
    e.preventDefault();
    const v = {name: $('#fName').value.trim(), qty: $('#fQty').value.trim(), place: $('#fPlace').value, expires: $('#fExp').value, price: parsePrice($('#fPrice').value)};
    if (!v.name) return;
    const ref = await db.collection('items').add({...v, guessed:false, added: Date.now()});
    $('#fName').value = ''; $('#fQty').value = ''; $('#fExp').value = ''; $('#fPrice').value = '';
    $('#fName').focus();
    if (!v.expires && claude) guessDate(ref.id, v);
  });

  $('#photoBtn').onclick = () => $('#photoInput').click();
  $('#photoInput').onchange = e => {
    const files = [...e.target.files].slice(0, MAX_PHOTOS);
    e.target.value = '';
    if (!files.length) return;
    withAI($('#cabAi'), files.length > 1 ? `Reading ${files.length} photos…` : 'Reading the photo…', async signal => {
      const images = await Promise.all(files.map(prepImage));
      const out = await claude.json(photoPrompt(), {schema: SCHEMA.photo, images, signal});
      const rows = (out && Array.isArray(out.items) ? out.items : []).filter(r => r && typeof r.name === 'string' && r.name.trim()).map(r => {
        const expires = days2date(r.days);
        return {name: r.name.trim(), qty: String(r.qty == null ? '' : r.qty).trim(), place: PLACES[r.place] ? r.place : 'pantry', expires, guessed: !!expires,
          price: priceText(parsePrice(r.price)), keep: true};
      });
      if (!rows.length) throw {mine:true, message:"Claude didn't find any food in that photo."};
      state.draft = rows; renderDraft();
    });
  };

  const prefIds = {diet:'#pDiet', dislikes:'#pDislikes', time:'#pTime', servings:'#pServings', notes:'#pNotes'};
  for (const sel of Object.values(prefIds)) $(sel).addEventListener('change', guard(() => {
    const p = {}; for (const [k, s] of Object.entries(prefIds)) p[k] = $(s).value.trim();
    state.prefs = p;
    return db.doc('settings/prefs').set(p);
  }));

  $('#suggestBtn').onclick = () => withAI($('#cookAi'), 'Thinking up recipes…', async signal => {
    const out = await claude.json(suggestPrompt($('#mood').value.trim()), {schema: SCHEMA.recipes, signal});
    const list = (out && Array.isArray(out.recipes) ? out.recipes : []).map(cleanRecipe).filter(Boolean);
    if (!list.length) throw {mine:true, message:'Claude came back with no recipes. Try again.'};
    state.suggestions = list; renderSuggestions();
  });

  $('#prevWeek').onclick = () => { state.weekStart = addDays(state.weekStart, -7); renderPlan(); };
  $('#nextWeek').onclick = () => { state.weekStart = addDays(state.weekStart, 7); renderPlan(); };
  $('#days').addEventListener('focusout', () => { if (planPending){ planPending = false; setTimeout(renderPlan); } });

  $('#planBtn').onclick = () => {
    const dates = []; const planned = [];
    for (let i = -7; i < 14; i++){
      const d = addDays(state.weekStart, i), m = state.meals[d] || {};
      for (const s of SLOTS){ const v = slotValue(m[s]); if (v) planned.push(v.title); }
      if (i >= 0 && i < 7 && d >= today() && !slotValue(m.dinner)) dates.push(d);
    }
    if (!dates.length){ toast('Every dinner on screen is already planned.'); return; }
    withAI($('#planAi'), `Planning ${dates.length} dinner${dates.length === 1 ? '' : 's'}…`, async signal => {
      const out = await claude.json(planPrompt(dates, planned), {schema: SCHEMA.plan, signal});
      const list = (out && Array.isArray(out.dinners) ? out.dinners : []).map(x => ({date: x && x.date, r: cleanRecipe(x)})).filter(x => x.r && dates.includes(x.date));
      if (!list.length) throw {mine:true, message:'Claude came back without a plan. Try again.'};
      for (const {date, r} of list){
        if (slotValue((state.meals[date] || {}).dinner)) continue;
        const ref = await db.collection('recipes').add({...recipeData(r), saved: Date.now()});
        await setSlot(date, 'dinner', {title:r.title, recipeId: ref.id});
      }
      const need = [...new Map(list.flatMap(x => stillNeed(x.r)).map(n => [norm(n), n])).values()];
      toast(`Planned ${list.length} dinner${list.length === 1 ? '' : 's'}`, need.length ? [{label:`Add ${need.length} to the list`, fn: async () => { const n = await addShopping(need); toast(`Added ${n} to the list`); }}] : []);
    });
  };

  $('#planShop').onclick = guard(async () => {
    const need = [...new Map(weekRecipes().flatMap(stillNeed).map(n => [norm(n), n])).values()];
    if (!need.length){ toast("These meals don't need anything that isn't already here or on the list."); return; }
    const n = await addShopping(need);
    toast(`Added ${n} to the list`, [{label:'Open list', fn: () => showTab('shop')}]);
  });

  $('#shopForm').onsubmit = guard(async e => {
    e.preventDefault();
    const name = $('#sName').value.trim();
    if (!name) return;
    $('#sName').value = '';
    const n = await addShopping([name]);
    if (!n) toast(`${name} is already on the list`);
  });

  $('#clearDone').onclick = guard(async () => {
    const done = state.shopping.filter(s => s.done);
    for (const s of done) await db.doc('shopping/' + s.id).delete();
    toast(`Cleared ${done.length}`, [{label:'Undo', fn: async () => { for (const {id, ...d} of done) await db.doc('shopping/' + id).set(d); }}]);
  });

  $('#putAway').onclick = () => {
    const bought = state.shopping.filter(s => s.done);
    if (!bought.length) return;
    withAI($('#shopAi'), `Putting away ${bought.length} item${bought.length === 1 ? '' : 's'}…`, async signal => {
      let info = [];
      if (claude){
        try { const out = await claude.json(putAwayPrompt(bought.map(b => b.name)), {schema: SCHEMA.putAway, effort:'low', signal}); if (out && Array.isArray(out.items)) info = out.items; }
        catch (e) { if (e && e.code === 'cancelled') throw e; }
      }
      for (const [i, b] of bought.entries()){
        const g = info.find(x => x && norm(x.name) === norm(b.name)) || info[i] || {};
        const expires = days2date(g.days);
        await db.collection('items').add({name: b.name, qty:'', place: PLACES[g.place] ? g.place : 'pantry', expires, guessed: !!expires, added: Date.now()});
        await db.doc('shopping/' + b.id).delete();
      }
      toast(`Put ${bought.length} item${bought.length === 1 ? '' : 's'} in the cabinet`, [{label:'See them', fn: () => showTab('cabinet')}]);
    });
  };

  wireSignIn();
}
function syncChips(){ for (const c of document.querySelectorAll('#placeChips .chip')) c.setAttribute('aria-pressed', String(c.dataset.place === state.place)); }

function fillPrefs(){
  const p = state.prefs || {};
  const map = {pDiet:'diet', pDislikes:'dislikes', pTime:'time', pServings:'servings', pNotes:'notes'};
  for (const [id, k] of Object.entries(map)){ const el = document.getElementById(id); if (el !== document.activeElement) el.value = p[k] || ''; }
}

function banner(text){ const b = $('#banner'); b.textContent = text || ''; b.hidden = !text; }
function dbLost(e){ banner(errText(e) || 'Lost the connection to your saved kitchen. Reload the app.'); }

function renderAll(){ renderCabinet(); renderStatus(); renderWasteBar(); renderShop(); renderSaved(); renderPlan(); renderSuggestions(); fillPrefs(); }

function subscribe(){
  const docs = s => s.docs.map(d => ({id: d.id, ...d.data()}));
  unsubs = [
    db.collection('items').onSnapshot(s => { state.items = docs(s); state.loaded.items = true; renderCabinet(); renderStatus(); renderWasteBar(); renderSuggestions(); }, dbLost),
    db.collection('waste').onSnapshot(s => { state.waste = docs(s); renderWasteBar(); }, dbLost),
    db.collection('shopping').onSnapshot(s => { state.shopping = docs(s); state.loaded.shopping = true; renderShop(); renderSuggestions(); }, dbLost),
    db.collection('recipes').onSnapshot(s => { state.recipes = docs(s); state.loaded.recipes = true; renderSaved(); renderPlan(); }, dbLost),
    db.collection('meals').onSnapshot(s => { state.meals = Object.fromEntries(s.docs.map(d => [d.id, d.data()])); renderPlan(); }, dbLost),
    db.doc('settings/prefs').onSnapshot(s => { state.prefs = s.exists ? s.data() : {}; fillPrefs(); }, dbLost),
  ];
}
function unsubscribe(){
  for (const u of unsubs) u();
  unsubs = []; db = null;
  Object.assign(state, {items:[], shopping:[], meals:{}, recipes:[], prefs:{}, waste:[], suggestions:[], draft:null, editing:null, loaded:{items:false, shopping:false, recipes:false}});
  renderDraft(); renderAll();
}

// ---------- sign-in ----------
const AUTH_MSG = {
  'auth/invalid-credential': "That email and password don't match.",
  'auth/wrong-password': "That email and password don't match.",
  'auth/user-not-found': "That email and password don't match.",
  'auth/invalid-email': "That doesn't look like an email address.",
  'auth/email-already-in-use': 'There is already an account with that email. Sign in instead.',
  'auth/weak-password': 'Use a password of at least 6 characters.',
  'auth/missing-password': 'Enter your password.',
  'auth/too-many-requests': 'Too many tries. Wait a few minutes, then try again.',
  'auth/network-request-failed': "Couldn't connect. Check your connection.",
  'auth/operation-not-allowed': "Email sign-in isn't turned on in Firebase yet.",
  'auth/admin-restricted-operation': 'New accounts are turned off for this app.',
};
let creating = false;
function siSay(text, ok){ const m = $('#siMsg'); m.textContent = text || ''; m.hidden = !text; m.className = 'simsg' + (ok ? ' ok' : ''); }
function setMode(c){
  creating = c;
  $('#siSubmit').textContent = c ? 'Create account' : 'Sign in';
  $('#siMode').textContent = c ? 'Have an account? Sign in' : 'New here? Create an account';
  $('#siIntro').textContent = c ? 'Make an account so your kitchen syncs across your devices.' : 'Sign in to see your kitchen on any device.';
  $('#siPass').autocomplete = c ? 'new-password' : 'current-password';
  $('#siReset').hidden = c;
  siSay('');
}
function wireSignIn(){
  $('#siMode').onclick = () => setMode(!creating);
  $('#signinForm').onsubmit = async e => {
    e.preventDefault();
    if (!fb) return;
    const email = $('#siEmail').value.trim(), pass = $('#siPass').value;
    const btn = $('#siSubmit'); btn.disabled = true; siSay('');
    try {
      if (creating) await fb.A.createUserWithEmailAndPassword(fb.auth, email, pass);
      else await fb.A.signInWithEmailAndPassword(fb.auth, email, pass);
      $('#siPass').value = '';
    } catch (err) { siSay(AUTH_MSG[err && err.code] || "Couldn't sign in. Try again."); }
    finally { btn.disabled = false; }
  };
  $('#siReset').onclick = async () => {
    if (!fb) return;
    const email = $('#siEmail').value.trim();
    if (!email){ siSay('Enter your email first, then tap Forgot password.'); $('#siEmail').focus(); return; }
    try { await fb.A.sendPasswordResetEmail(fb.auth, email); siSay('Check your email for a link to reset your password.', true); }
    catch (err) { siSay(AUTH_MSG[err && err.code] || "Couldn't send the reset email. Try again."); }
  };
}

// ---------- start ----------
async function boot(){
  state.weekStart = today();
  wire();
  applyAI();
  showTab(initialTab());
  renderAll();
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e; renderTip(); });
  renderTip();

  if (!firebaseConfig){
    banner("Sync isn't set up yet, so what you add stays on this device.");
    db = localStore();
    subscribe();
    return;
  }
  try { fb = await loadFirebase(); }
  catch (e) { banner("Couldn't load sync. Check your connection, then reopen the app."); return; }
  fb.A.onAuthStateChanged(fb.auth, async user => {
    $('#signin').hidden = !!user;
    if (!user){ state.user = null; if (db) unsubscribe(); setMode(false); return; }
    if (db) unsubscribe();
    state.user = user;
    db = cloudStore('users/' + user.uid);
    banner('');
    subscribe();
    await moveLocalData().catch(() => {});
  });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
boot();
