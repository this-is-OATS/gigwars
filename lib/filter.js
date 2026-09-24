// DISPATCH text filter. Three tiers, decided with Johnny on 2026-09-24:
//   - slurs / hate          → rejected outright
//   - strong profanity      → allowed but masked (f***)
//   - mild crew language    → allowed as typed (shit, crap, ass, damn, hell, piss —
//                             the bus rule depends on it)
// Plus spam: links and phone-number-looking runs are rejected.
//
// Detection runs on a normalized copy (lowercase, leetspeak undone, separators inside
// words removed, spaced-out single letters joined) so "sh1t", "f.u.c.k" and "f u c k"
// are all seen; the stored text keeps the player's own spelling, masked where needed.
// Tune the lists here; nothing else needs to change.

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'l', '+': 't' };

// Stems. Matched at the start of a normalized word (so plurals and -ing forms match).
const SLURS = [
  'nigg', 'nigr', 'negr0', 'chink', 'gook', 'spic', 'spick', 'wetback', 'beaner', 'kike', 'raghead',
  'towelhead', 'sandnigg', 'coon', 'jigaboo', 'porchmonk', 'faggot', 'fagot', 'fags', 'dyke', 'tranny',
  'shemale', 'retard', 'mongoloid', 'cripple', 'gyp', 'gypsy', 'redskin', 'squaw', 'paki', 'zipperhead',
  'heeb', 'hymie', 'kraut', 'wop', 'dago', 'golliwog', 'nazi', 'kkk', 'hitler', 'rape', 'rapist', 'molest', 'pedo',
];
const EXACT_SLURS = new Set(['fag', 'nig', 'jap', 'coon', 'spic', 'kike', 'gook', 'wop', 'fags']);
const STRONG = ['motherfuck', 'fuck', 'fuk', 'fck', 'cunt', 'cock', 'dick', 'pussy', 'bitch', 'whore', 'slut', 'twat', 'wank', 'jizz', 'cum', 'bastard', 'titties', 'tits'];
// Words that start like a stem but are fine.
const ALLOW = new Set(['cockpit', 'cocktail', 'cocktails', 'hancock', 'peacock', 'dickens', 'dickson', 'cumin', 'cumulus', 'cucumber',
  'scunthorpe', 'grape', 'grapes', 'drape', 'drapes', 'scrape', 'scraped', 'trapeze', 'therapist', 'paparazzi', 'gypsum', 'spice', 'spicy', 'spices',
  'raccoon', 'raccoons', 'tycoon', 'cocoon', 'cocoons', 'shitake', 'titanic', 'title', 'titles', 'wopr']);

function normWord(w) {
  return w.toLowerCase().split('').map((c) => LEET[c] || c).join('').replace(/[^a-z]/g, '');
}

// Words as the player wrote them, with their positions, so masking keeps punctuation.
function tokens(text) {
  const out = []; const re = /[A-Za-z0-9@$!|+][A-Za-z0-9@$!|+.*_'-]*/g; let m;
  while ((m = re.exec(text))) out.push({ raw: m[0], start: m.index, n: normWord(m[0]) });
  return out;
}

function hits(n, stems, exact) {
  if (!n || ALLOW.has(n)) return false;
  if (exact && exact.has(n)) return true;
  return stems.some((s) => n.startsWith(s) && (s.length >= 4 || n.length <= s.length + 3));
}

// Spaced-out letters: "f u c k" → one candidate word "fuck".
function spacedRuns(toks) {
  const runs = []; let run = [];
  for (const t of toks) {
    if (t.n.length === 1) run.push(t); else { if (run.length >= 3) runs.push(run); run = []; }
  }
  if (run.length >= 3) runs.push(run);
  return runs.map((r) => ({ n: r.map((t) => t.n).join(''), toks: r }));
}

function mask(word) { return word[0] + '*'.repeat(Math.max(2, word.length - 1)); }

/**
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function screen(input) {
  const text = String(input || '').replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, '').replace(/\s+/g, ' ').trim();
  if (text.length < 4) return { ok: false, reason: 'too short' };
  if (/https?:|www\.|\.(com|net|org|io|ly|gg|xyz|app)\b/i.test(text)) return { ok: false, reason: 'no links' };
  if (/\d[\d\s().-]{8,}\d/.test(text)) return { ok: false, reason: 'no phone numbers' };

  const toks = tokens(text);
  const squashedAll = normWord(text);
  for (const t of toks) if (hits(t.n, SLURS, EXACT_SLURS)) return { ok: false, reason: 'keep it clean of slurs' };
  for (const r of spacedRuns(toks)) if (hits(r.n, SLURS, EXACT_SLURS)) return { ok: false, reason: 'keep it clean of slurs' };
  if (/n+[i1]+g+[e3a4]+r|f+[a4@]+g+[o0]+t/i.test(squashedAll)) return { ok: false, reason: 'keep it clean of slurs' };

  // Mask strong profanity, working right-to-left so positions stay valid.
  let out = text;
  const toMask = [];
  for (const t of toks) if (hits(t.n, STRONG)) toMask.push({ start: t.start, len: t.raw.length, raw: t.raw });
  for (const r of spacedRuns(toks)) if (hits(r.n, STRONG)) for (const t of r.toks.slice(1)) toMask.push({ start: t.start, len: t.raw.length, raw: '*' });
  toMask.sort((a, b) => b.start - a.start);
  for (const m of toMask) out = out.slice(0, m.start) + (m.raw === '*' ? '*' : mask(m.raw)) + out.slice(m.start + m.len);
  return { ok: true, text: out };
}
