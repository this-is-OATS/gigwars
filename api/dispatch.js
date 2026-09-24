// DISPATCH — the shared community feed for GigWars.
//
//   GET  /api/dispatch                    → { enabled, threshold, beatThreshold, queue:[…], live:[…],
//                                            beatQueue:[…], beats:[…] }
//   POST /api/dispatch {action:"submit", title, choices?:[a,b], by, device}
//   POST /api/dispatch {action:"beat", scenario, choice:0|1, text, tone:"good"|"bad", by, device}
//   POST /api/dispatch {action:"vote", id, kind?:"beat", device}
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
import { screen } from '../lib/filter.js';

export const THRESHOLD = 5;
export const BEAT_THRESHOLD = 3;
const COLL = 'gigwarsDispatch';
const BEATS = 'gigwarsBeats';
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
function handleOf(by) {
  const h = String(by || '').toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]/g, '').slice(0, 16);
  if (!h) return '@roadie';
  return screen(h + ' ok').ok && screen(h + ' ok').text === h + ' ok' ? '@' + h : '@roadie';
}
const now = () => Date.now();

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

async function rateLimit(store, who) {
  const ref = store.collection(LIMITS).doc(who);
  return store.runTransaction(async (tx) => {
    const snap = await tx.get(ref); const d = snap.exists ? snap.data() : {};
    const t = now();
    let w = d.w || t, wc = d.wc || 0, day = d.day || t, dc = d.dc || 0;
    if (t - w > 10 * 60e3) { w = t; wc = 0; }
    if (t - day > 24 * 3600e3) { day = t; dc = 0; }
    if (wc >= PER_10_MIN) return 'slow down — 3 dispatches per 10 minutes';
    if (dc >= PER_DAY) return 'that\'s the daily limit — back tomorrow';
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
  const doc = { title, by: handleOf(body.by), status: 'PENDING', votes: 1, voters: [ip, dev], createdAt: now(), ...(choices ? { choices } : {}) };
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
  const doc = { scenario, scenarioTitle, choice, choiceLabel, text: f.text, tone, by: handleOf(body.by),
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
      : [400, { ok: false, error: 'action must be submit, beat or vote' }];
    return send(status, obj);
  } catch (err) {
    console.error(JSON.stringify({ event: 'dispatch-failed', reason: err.message || String(err) }));
    return send(err.status || 500, { ok: false, error: err.status ? err.message : 'dispatch hiccup — try again' });
  }
}
