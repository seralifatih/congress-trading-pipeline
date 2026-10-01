// ─── Name helpers (pure, no network) ─────────────────────────────────────────

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

// Common US first-name nicknames -> formal form. Same table as the Congress
// Lobbying x Stock Trades Overlap actor (lobbying-overlap/src/sources/ptr.py
// _NICKNAME_TO_FORMAL): only unambiguous pairs — nothing that maps two
// distinct formal names onto one key.
export const NICKNAME_TO_FORMAL: Record<string, string> = {
  abe: 'abraham', al: 'albert', andy: 'andrew', ben: 'benjamin',
  bernie: 'bernard', bill: 'william', billy: 'william',
  bob: 'robert', bobby: 'robert', charlie: 'charles',
  chuck: 'charles', dan: 'daniel', danny: 'daniel',
  dave: 'david', deb: 'deborah', debbie: 'deborah',
  dick: 'richard', don: 'donald', doug: 'douglas',
  ed: 'edward', eddie: 'edward', fred: 'frederick',
  greg: 'gregory', hank: 'henry', jeff: 'jeffrey',
  jerry: 'gerald', jim: 'james', jimmy: 'james', joe: 'joseph',
  joey: 'joseph', jon: 'jonathan', josh: 'joshua',
  kathy: 'kathleen', ken: 'kenneth', larry: 'lawrence',
  liz: 'elizabeth', matt: 'matthew', mike: 'michael',
  nick: 'nicholas', pete: 'peter', ray: 'raymond',
  rich: 'richard', rick: 'richard', ron: 'ronald',
  sam: 'samuel', sandy: 'sandra', steve: 'steven',
  sue: 'susan', ted: 'theodore', tim: 'timothy', tom: 'thomas',
  tommy: 'thomas', tony: 'anthony', vicki: 'victoria',
  will: 'william',
};

/** Lowercase, ASCII-fold, letters and spaces only. "Angus S. King, Jr." -> "angus s king jr". */
export function normName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalized name tokens with generational suffixes (Jr, III, ...) removed. */
export function nameTokens(name: string): string[] {
  return normName(name)
    .split(' ')
    .filter((t) => t.length > 0 && !NAME_SUFFIXES.has(t));
}

export function formalToken(token: string): string {
  return NICKNAME_TO_FORMAL[token] ?? token;
}

// ─── Casing ───────────────────────────────────────────────────────────────────
// Paper filings come back from the Senate listing in ALL CAPS ("RICHARD
// BLUMENTHAL") while electronic ones are mixed case ("Richard Blumenthal").
// Only a name with NO lowercase letters is re-cased; anything already mixed
// case is returned untouched.

const ROMAN_SUFFIX = /^(II|III|IV|VI|VII|VIII)$/;

function caseWord(word: string): string {
  if (word.length === 0) return word;
  if (ROMAN_SUFFIX.test(word)) return word;
  // Hyphenated parts and O'/D' prefixes are cased independently.
  return word
    .split('-')
    .map((part) =>
      part
        .split("'")
        .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase())
        .join("'"),
    )
    .join('-')
    // McCormick, McConnell — "Mc" followed by a letter capitalizes the next one.
    .replace(/^Mc([a-z])/, (_m, c: string) => `Mc${c.toUpperCase()}`);
}

export function hasLowercase(s: string): boolean {
  return /[a-z]/.test(s);
}

/** Re-case an ALL-CAPS name; mixed-case input is returned unchanged (trimmed). */
export function normalizeNameCase(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (!trimmed || hasLowercase(trimmed)) return trimmed;
  return trimmed
    .split(' ')
    .map((tok) => {
      // Keep single initials ("A.") and trailing-dot abbreviations uppercase-initial.
      if (/^[A-Z]\.?$/.test(tok)) return tok;
      // Strip a trailing comma/period so ROMAN_SUFFIX / casing see the bare word.
      const m = tok.match(/^(.*?)([.,]*)$/);
      const core = m?.[1] ?? tok;
      const tail = m?.[2] ?? '';
      if (/^(JR|SR)$/.test(core)) return core.charAt(0) + core.slice(1).toLowerCase() + tail;
      return caseWord(core) + tail;
    })
    .join(' ');
}
