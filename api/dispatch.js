// DISPATCH — the shared community feed for GigWars.
//
//   GET  /api/dispatch                    → { enabled, threshold, beatThreshold, queue:[…], live:[…],
//                                            beatQueue:[…], beats:[…] }
//   POST /api/dispatch {action:"submit", title, choices?:[a,b], by, device}
//   POST /api/dispatch {action:"beat", scenario, choice:0|1, text, tone:"good"|"bad", by, device}
//   POST /api/dispatch {action:"vote", id, kind?:"beat", device}
//   POST /api/dispatch {action:"claim", handle}          → { handle, token, code }
//   POST /api/dispatch {action:"restore", handle, code}  → { handle, token }
//   POST /api/dispatch {action:"check", handle, token}   → { valid }
//   POST /api/dispatch {action:"recode", handle, token}  → { code, link, qr }   (old code stops working)
//
// Tour names (no Google, no email): a player claims a name; the browser keeps a secret token
// and gets a one-time recovery code. Posts carry the name only when the token checks out —
// otherwise they post as @roadie, so nobody can type someone else's name. Only hashes of
// the token and the code are stored. Restoring on a new device issues a new token, which
// signs the old browser out: one name, one browser.
//
// The recovery code also comes as a QR: a link to the game with the name and code after the
// '#' (never sent to a server, never in a log). Scanning it on a new phone offers the restore.
// The QR is drawn here from the freshly issued code, so the code never travels back up.
//
// Story mode (step 2): a scenario can carry two choices, which makes it a fork. A beat is
// "what happens next" after one choice; beats are voted in at BEAT_THRESHOLD and then every
// player who takes that road gets one of its live beats at random, so storylines grow turn by
// turn. Beats can hang off a live community fork ("<doc id>") or a starter fork shipped in the
// game ("fork:<id>", listed in STARTER_FORKS below — keep in step with FORKS in gw-data.jsx).
//
// Players submit cursed road moments; everyone votes; at THRESHOLD votes a submission goes
// LIVE and becomes a random event on every player's tour (its cash effect is rolled once,
// here, so everybody lives the same event).
//
// It writes to the shared Firebase project through the Admin SDK with a service-account key
// (FIREBASE_SERVICE_ACCOUNT, the whole JSON). The browser never talks to Firebase, so the
// project's rules — which guard MGMT and CrewFam — stay exactly as they are; these two
// collections have no client rules at all, which means clients are denied.
//
// Guard rails: a text filter (lib/filter.js), a rate limit per connection, one vote per
// device and per connection, and stored identities are salted hashes, never raw IPs.

import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { screen } from '../lib/filter.js';

export const THRESHOLD = 5;
export const BEAT_THRESHOLD = 3;
const COLL = 'gigwarsDispatch';
const BEATS = 'gigwarsBeats';
const NAMES = 'gigwarsNames';
const RESERVED = new Set(['roadie', 'admin', 'mod', 'mods', 'vinny', 'gigwars', 'oats', 'crew', 'anon', 'system', 'claude']);
const MAX_CHOICE = 26, MAX_BEAT = 140;
// Starter forks shipped in the game (FORKS in gw-data.jsx): the server keeps its own copy of
// the titles and choice labels, so a beat can't claim to belong to a road that says otherwise.
export const STARTER_FORKS = {
  dock:       { title: 'NOT ON THE LIST',          choices: ['SLIP HIM $50', 'NAME-DROP THE TM'] },
  gennie:     { title: 'SHORE POWER JUST DIED',    choices: ['RENT THE TACO GENNY', 'RIDE THE UPS'] },
  afterparty: { title: 'THE AFTER-PARTY INVITE',   choices: ['GO. JUST ONE.', 'SLEEP IN THE VAN'] },
  merch:      { title: 'THE MERCH GIRL QUIT',      choices: ['RUN THE TABLE', 'LET IT BURN'] },
};
const LIMITS = 'gigwarsLimits';
const PER_10_MIN = 3, PER_DAY = 12;
const NAME_PER_10_MIN = 8, NAME_PER_DAY = 30;   // claims + restores, separate from posting
const MAX_TITLE = 46;

let _db = null;
async function db() {
  if (_db) return _db;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const cred = JSON.parse(raw);
  if (cred.private_key) cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  const app = getApps()[0] || initializeApp({ credential: cert(cred) });
  _db = getFirestore(app);
  return _db;
}
// Tests swap the store in.
export function __setDb(fake) { _db = fake; }

const salt = () => process.env.DISPATCH_SALT || 'gigwars-dispatch';
const hash = (s) => crypto.createHash('sha256').update(salt() + ':' + s).digest('hex').slice(0, 24);
function ipOf(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}
const now = () => Date.now();

// --- tour names --------------------------------------------------------------------------
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function sameHash(a, b) {
  const x = Buffer.from(String(a || ''), 'hex'), y = Buffer.from(String(b || ''), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function cleanName(h) {
  const n = String(h || '').toLowerCase().replace(/^@/, '').trim();
  if (!/^[a-z0-9_]{3,16}$/.test(n)) return null;
  const f = screen(n + ' ok');
  return f.ok && f.text === n + ' ok' ? n : null;
}
// Crockford-ish alphabet, no 0/O/1/I/L — readable off a phone screen
const CODE_ABC = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function newCode() {
  const b = crypto.randomBytes(12); let s = '';
  for (let i = 0; i < 12; i++) s += CODE_ABC[b[i] % CODE_ABC.length];
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12);
}
const normCode = (c) => String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
const newToken = () => crypto.randomBytes(24).toString('base64url');

// Where a recovery link may point: this game's own hosts only, whatever the request claims.
function gameOrigin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  if (/^gigwars(-[a-z0-9-]+)?\.vercel\.app$/.test(host)) return 'https://' + host;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return 'http://' + host;
  return 'https://gigwars.vercel.app';
}
async function recovery(req, name, code) {
  const link = `${gameOrigin(req)}/#restore=${name}.${normCode(code)}`;
  const qr = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  return { code, link, qr };
}

// The name a post is attributed to: the claimed name if the token matches, else @roadie.
async function resolveBy(store, body) {
  const n = cleanName(body.handle);
  if (!n || !body.token) return '@roadie';
  const snap = await store.collection(NAMES).doc(n).get();
  return snap.exists && sameHash(snap.data().tokenHash, sha(body.token)) ? '@' + n : '@roadie';
}

async function claim(store, req, body) {
  const n = cleanName(body.handle);
  if (!n) return [422, { ok: false, error: '3–16 letters, numbers or _ — and keep it clean' }];
  if (RESERVED.has(n)) return [409, { ok: false, error: 'that name is reserved' }];
  const limited = await rateLimit(store, 'n' + hash(ipOf(req)), NAME_PER_10_MIN, NAME_PER_DAY);
  if (limited) return [429, { ok: false, error: limited }];
  const token = newToken(), code = newCode();
  const ref = store.collection(NAMES).doc(n);
  return store.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) return [409, { ok: false, error: 'that name is taken' }];
    tx.set(ref, { tokenHash: sha(token), codeHash: sha(normCode(code)), createdAt: now(), lastRestore: 0 });
    return [201, null];
  }).then(async (r) => r[1] ? r : [201, { ok: true, handle: '@' + n, token, ...(await recovery(req, n, code)) }]);
}

// A new recovery code (and QR) for a signed-in name; the old one stops working.
async function recode(store, req, body) {
  const n = cleanName(body.handle);
  if (!n || !body.token) return [401, { ok: false, error: 'sign in first' }];
  const limited = await rateLimit(store, 'n' + hash(ipOf(req)), NAME_PER_10_MIN, NAME_PER_DAY);
  if (limited) return [429, { ok: false, error: limited }];
  const code = newCode();
  const ref = store.collection(NAMES).doc(n);
  const res = await store.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || !sameHash(snap.data().tokenHash, sha(body.token))) return [401, { ok: false, error: 'sign in first' }];
    tx.update(ref, { codeHash: sha(normCode(code)), recodedAt: now() });
    return [200, null];
  });
  return res[1] ? res : [200, { ok: true, handle: '@' + n, ...(await recovery(req, n, code)) }];
}

async function restore(store, req, body) {
  const n = cleanName(body.handle);
  if (!n) return [422, { ok: false, error: 'no such name' }];
  const limited = await rateLimit(store, 'n' + hash(ipOf(req)), NAME_PER_10_MIN, NAME_PER_DAY);
  if (limited) return [429, { ok: false, error: limited }];
  const ref = store.collection(NAMES).doc(n);
  return store.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || !sameHash(snap.data().codeHash, sha(normCode(body.code)))) return [403, { ok: false, error: 'name and code don\'t match' }];
    const token = newToken();
    tx.update(ref, { tokenHash: sha(token), lastRestore: now() });
    return [200, { ok: true, handle: '@' + n, token }];
  });
}

async function check(store, body) {
  const by = await resolveBy(store, body);
  return [200, { ok: true, valid: by !== '@roadie' }];
}

function pub(id, d) {
  return { id, title: d.title, by: d.by, status: d.status, votes: d.votes || 0, createdAt: d.createdAt || 0,
    ...(Array.isArray(d.choices) && d.choices.length === 2 ? { choices: d.choices } : {}),
    ...(d.status === 'LIVE' ? { liveAt: d.liveAt || 0, effect: d.effect || { cash: 0 } } : {}) };
}
function pubBeat(id, d) {
  return { id, scenario: d.scenario, scenarioTitle: d.scenarioTitle, choice: d.choice, choiceLabel: d.choiceLabel,
    text: d.text, tone: d.tone, by: d.by, status: d.status, votes: d.votes || 0, createdAt: d.createdAt || 0,
    ...(d.status === 'LIVE' ? { liveAt: d.liveAt || 0, effect: d.effect || { cash: 0 } } : {}) };
}

async function list(store) {
  const [q, l, bq, bl] = await Promise.all([
    store.collection(COLL).where('status', '==', 'PENDING').limit(100).get(),
    store.collection(COLL).where('status', '==', 'LIVE').limit(200).get(),
    store.collection(BEATS).where('status', '==', 'PENDING').limit(100).get(),
    store.collection(BEATS).where('status', '==', 'LIVE').limit(400).get(),
  ]);
  const byVotes = (a, b) => b.votes - a.votes || b.createdAt - a.createdAt;
  const queue = q.docs.map((d) => pub(d.id, d.data())).sort(byVotes).slice(0, 40);
  const live = l.docs.map((d) => pub(d.id, d.data())).sort((a, b) => b.liveAt - a.liveAt);
  const beatQueue = bq.docs.map((d) => pubBeat(d.id, d.data())).sort(byVotes).slice(0, 40);
  const beats = bl.docs.map((d) => pubBeat(d.id, d.data())).sort((a, b) => b.liveAt - a.liveAt);
  return { queue, live, beatQueue, beats };
}

async function rateLimit(store, who, per10 = PER_10_MIN, perDay = PER_DAY) {
  const ref = store.collection(LIMITS).doc(who);
  return store.runTransaction(async (tx) => {
    const snap = await tx.get(ref); const d = snap.exists ? snap.data() : {};
    const t = now();
    let w = d.w || t, wc = d.wc || 0, day = d.day || t, dc = d.dc || 0;
    if (t - w > 10 * 60e3) { w = t; wc = 0; }
    if (t - day > 24 * 3600e3) { day = t; dc = 0; }
    if (wc >= per10) return per10 === PER_10_MIN ? 'slow down — 3 dispatches per 10 minutes' : 'too many tries — wait a few minutes';
    if (dc >= perDay) return 'that\'s the daily limit — back tomorrow';
    tx.set(ref, { w, wc: wc + 1, day, dc: dc + 1 });
    return null;
  });
}

async function submit(store, req, body) {
  const f = screen(body.title);
  if (!f.ok) return [422, { ok: false, error: f.reason }];
  const title = f.text.toUpperCase().slice(0, MAX_TITLE);
  let choices = null;
  if (Array.isArray(body.choices) && body.choices.some((c) => String(c || '').trim())) {
    if (body.choices.length !== 2 || body.choices.some((c) => !String(c || '').trim())) return [422, { ok: false, error: 'a fork needs both choices' }];
    choices = [];
    for (const c of body.choices) {
      const cf = screen(String(c).slice(0, MAX_CHOICE));
      if (!cf.ok) return [422, { ok: false, error: 'choice: ' + cf.reason }];
      choices.push(cf.text.toUpperCase());
    }
  }
  const ip = hash(ipOf(req)), dev = hash('d:' + String(body.device || ''));
  const limited = await rateLimit(store, ip);
  if (limited) return [429, { ok: false, error: limited }];
  // no duplicates of something already in the queue or live
  const dup = await store.collection(COLL).where('title', '==', title).limit(1).get();
  if (!dup.empty) return [409, { ok: false, error: 'already dispatched — go vote for it' }];
  const doc = { title, by: await resolveBy(store, body), status: 'PENDING', votes: 1, voters: [ip, dev], createdAt: now(), ...(choices ? { choices } : {}) };
  const ref = await store.collection(COLL).add(doc);
  return [201, { ok: true, item: pub(ref.id, doc) }];
}

async function beat(store, req, body) {
  const scenario = String(body.scenario || '');
  const choice = Number(body.choice);
  if (choice !== 0 && choice !== 1) return [400, { ok: false, error: 'pick a choice' }];
  let scenarioTitle = '', choiceLabel = '';
  const starter = /^fork:([a-z0-9_-]{2,24})$/.exec(scenario);
  if (starter) {
    const sf = STARTER_FORKS[starter[1]];
    if (!sf || !sf.choices[choice]) return [404, { ok: false, error: 'no such road' }];
    scenarioTitle = sf.title; choiceLabel = sf.choices[choice];
  } else {
    if (!/^[A-Za-z0-9]{10,40}$/.test(scenario)) return [400, { ok: false, error: 'bad scenario' }];
    const snap = await store.collection(COLL).doc(scenario).get();
    const d = snap.exists ? snap.data() : null;
    if (!d || d.status !== 'LIVE' || !Array.isArray(d.choices)) return [404, { ok: false, error: 'that road is not open' }];
    scenarioTitle = d.title; choiceLabel = d.choices[choice];
  }
  const f = screen(String(body.text || '').slice(0, MAX_BEAT));
  if (!f.ok) return [422, { ok: false, error: f.reason }];
  const tone = body.tone === 'good' ? 'good' : 'bad';
  const ip = hash(ipOf(req)), dev = hash('d:' + String(body.device || ''));
  const limited = await rateLimit(store, ip);
  if (limited) return [429, { ok: false, error: limited }];
  const doc = { scenario, scenarioTitle, choice, choiceLabel, text: f.text, tone, by: await resolveBy(store, body),
    status: 'PENDING', votes: 1, voters: [ip, dev], createdAt: now() };
  const ref = await store.collection(BEATS).add(doc);
  return [201, { ok: true, item: pubBeat(ref.id, doc) }];
}

function rollEffect(tone) {
  if (tone === 'good') return { cash: Math.round(60 + Math.random() * 240) };
  if (tone === 'bad') return { cash: -Math.round(40 + Math.random() * 180) };
  return { cash: Math.random() < 0.5 ? -Math.round(40 + Math.random() * 180) : Math.round(60 + Math.random() * 240) };
}

async function vote(store, req, body) {
  const id = String(body.id || '');
  if (!/^[A-Za-z0-9]{10,40}$/.test(id)) return [400, { ok: false, error: 'bad id' }];
  const isBeat = body.kind === 'beat';
  const need = isBeat ? BEAT_THRESHOLD : THRESHOLD, show = isBeat ? pubBeat : pub;
  const ip = hash(ipOf(req)), dev = hash('d:' + String(body.device || ''));
  const ref = store.collection(isBeat ? BEATS : COLL).doc(id);
  return store.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return [404, { ok: false, error: 'not found' }];
    const d = snap.data();
    if (d.status !== 'PENDING') return [409, { ok: false, error: 'already live', item: show(id, d) }];
    const voters = d.voters || [];
    if (voters.includes(ip) || voters.includes(dev)) return [409, { ok: false, error: 'you already voted', item: show(id, d) }];
    const votes = (d.votes || 0) + 1;
    const next = { votes, voters: [...voters, ip, dev].slice(-400) };
    if (votes >= need) Object.assign(next, { status: 'LIVE', liveAt: now(), effect: rollEffect(isBeat ? d.tone : null) });
    tx.update(ref, next);
    return [200, { ok: true, item: show(id, { ...d, ...next }), wentLive: next.status === 'LIVE' }];
  });
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 4096) throw Object.assign(new Error('too big'), { status: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

export default async function handler(req, res) {
  const send = (status, obj, cache) => {
    res.status(status).setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', cache || 'no-store');
    res.end(JSON.stringify(obj));
  };
  try {
    const store = await db();
    if (req.method === 'GET') {
      if (!store) return send(200, { ok: true, enabled: false, threshold: THRESHOLD, beatThreshold: BEAT_THRESHOLD, queue: [], live: [], beatQueue: [], beats: [] });
      return send(200, { ok: true, enabled: true, threshold: THRESHOLD, beatThreshold: BEAT_THRESHOLD, ...(await list(store)) }, 'public, s-maxage=10, stale-while-revalidate=30');
    }
    if (req.method !== 'POST') return send(405, { ok: false, error: 'GET or POST' });
    if (!store) return send(503, { ok: false, error: 'dispatch is not connected yet' });
    const body = await readJson(req);
    const [status, obj] = body.action === 'vote' ? await vote(store, req, body)
      : body.action === 'submit' ? await submit(store, req, body)
      : body.action === 'beat' ? await beat(store, req, body)
      : body.action === 'claim' ? await claim(store, req, body)
      : body.action === 'restore' ? await restore(store, req, body)
      : body.action === 'check' ? await check(store, body)
      : body.action === 'recode' ? await recode(store, req, body)
      : [400, { ok: false, error: 'unknown action' }];
    return send(status, obj);
  } catch (err) {
    console.error(JSON.stringify({ event: 'dispatch-failed', reason: err.message || String(err) }));
    return send(err.status || 500, { ok: false, error: err.status ? err.message : 'dispatch hiccup — try again' });
  }
}
