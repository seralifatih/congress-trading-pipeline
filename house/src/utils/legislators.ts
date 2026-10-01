import axios from 'axios';
import { formalToken, nameTokens } from './names.js';
import { withRetry } from './retry.js';
import { makeLogger } from './logger.js';
import { toErrorMessage } from './errors.js';

const log = makeLogger('legislators');

// Same upstream the Congress Lobbying x Stock Trades Overlap actor reads
// (lobbying-overlap/src/sources/legislators.py BASE_URL / FILES["legislators"]):
// the unitedstates/congress-legislators project's GitHub Pages mirror. Only
// the roster file is needed here (no committees), fetched once per run — the
// overlap actor's 30-day KV cache is skipped because a run's default
// key-value store does not persist across runs.
export const LEGISLATORS_URL = 'https://unitedstates.github.io/congress-legislators/legislators-current.json';

const BIOGUIDE_RE = /^[A-Z]\d{6}$/;

export interface RosterMember {
  bioguide_id: string;
  name: string;
  // Normalized name tokens per source of given-name variety: first, middle,
  // nickname (nicknames mapped to their formal form so "Tommy" == "Thomas").
  given: string[];
  last: string;
}

interface LegislatorJson {
  id?: { bioguide?: string };
  name?: { first?: string; middle?: string; nickname?: string; last?: string; official_full?: string };
  terms?: Array<{ type?: string }>;
}

/** Build roster members from legislators-current.json. House members (incl. delegates) only by default. */
export function buildRoster(raw: unknown, chambers: Array<'sen' | 'rep'> = ['rep']): RosterMember[] {
  if (!Array.isArray(raw)) throw new Error('legislators file: unexpected shape (not an array)');
  const out: RosterMember[] = [];
  for (const leg of raw as LegislatorJson[]) {
    const bioguide = leg.id?.bioguide;
    const terms = leg.terms ?? [];
    const lastTerm = terms[terms.length - 1];
    if (!bioguide || !lastTerm?.type || !chambers.includes(lastTerm.type as 'sen' | 'rep')) continue;

    const n = leg.name ?? {};
    const lastTokens = nameTokens(n.last ?? '');
    const last = lastTokens[lastTokens.length - 1];
    if (!last) continue;

    const given = new Set<string>();
    for (const part of [n.first, n.middle, n.nickname]) {
      for (const t of nameTokens(part ?? '')) given.add(formalToken(t));
    }
    out.push({
      bioguide_id: bioguide,
      name: n.official_full ?? `${n.first ?? ''} ${n.last ?? ''}`.trim(),
      given: [...given],
      last,
    });
  }
  return out;
}

// ─── NameResolver ─────────────────────────────────────────────────────────────
// Resolves a source display name to a bioguide id. A name resolves only when
// exactly ONE member fits — an ambiguous name resolves to null, never a guess.
//
//   tier 1: some given-name token of the source name (formal-normalized) +
//           last name, unique across the roster.
//           "Thomas H Tuberville" -> thomas|tuberville; the roster entry for
//           "Tommy Tuberville" carries given=[thomas] (first) + nickname tommy
//           -> thomas, so both resolve to T000278.
//   tier 2: a single-letter given token (initial) + last name, unique across
//           the roster. "R. Scott" -> r|scott resolves only because no other
//           sitting House member is an R. Scott.

export class NameResolver {
  private readonly byGiven = new Map<string, Set<string>>();
  private readonly byInitial = new Map<string, Set<string>>();
  private readonly byBioguide = new Map<string, RosterMember>();

  constructor(members: RosterMember[]) {
    for (const m of members) {
      this.byBioguide.set(m.bioguide_id, m);
      for (const g of m.given) {
        add(this.byGiven, `${g}|${m.last}`, m.bioguide_id);
        add(this.byInitial, `${g.charAt(0)}|${m.last}`, m.bioguide_id);
      }
    }
  }

  get size(): number {
    return this.byBioguide.size;
  }

  has(bioguide: string): boolean {
    return this.byBioguide.has(bioguide);
  }

  resolve(displayName: string): string | null {
    const tokens = nameTokens(displayName);
    if (tokens.length < 2) return null;
    const last = tokens[tokens.length - 1]!;
    const givens = tokens.slice(0, -1).map(formalToken);

    const exact = new Set<string>();
    for (const g of givens) {
      if (g.length < 2) continue; // an initial is not a name — tier 2 below
      for (const id of this.byGiven.get(`${g}|${last}`) ?? []) exact.add(id);
    }
    if (exact.size === 1) return [...exact][0]!;
    if (exact.size > 1) return null;

    const initial = new Set<string>();
    for (const g of givens) {
      for (const id of this.byInitial.get(`${g.charAt(0)}|${last}`) ?? []) initial.add(id);
    }
    return initial.size === 1 ? [...initial][0]! : null;
  }
}

function add(map: Map<string, Set<string>>, key: string, id: string): void {
  const set = map.get(key);
  if (set) set.add(id);
  else map.set(key, new Set([id]));
}

// ─── Loading ──────────────────────────────────────────────────────────────────

/** Fetch the current House roster. Never throws — returns null on failure so
 *  member filtering degrades to name-token matching and bioguide ids stay null. */
export async function loadHouseResolver(): Promise<NameResolver | null> {
  try {
    const res = await withRetry(
      () => axios.get<unknown>(LEGISLATORS_URL, { timeout: 60_000, proxy: false }),
      2,
      750,
    );
    const resolver = new NameResolver(buildRoster(res.data));
    log.info(`Loaded ${resolver.size} current House members from congress-legislators`);
    return resolver;
  } catch (err) {
    log.warn(
      `Could not load congress-legislators roster (${toErrorMessage(err)}) — ` +
      `member_bioguide_id will be null and members[] will match on name tokens only`,
    );
    return null;
  }
}

// ─── Member filter ────────────────────────────────────────────────────────────

export type MemberMatcher = (displayName: string) => boolean;

/**
 * Case-insensitive matcher for the `members` input. A source name matches an
 * input entry when ANY of these hold:
 *   - the entry is a bioguide id and the source name resolves to it;
 *   - the entry and the source name resolve to the same bioguide id (so
 *     "Tommy Tuberville" matches "Thomas H Tuberville");
 *   - every name token of the entry appears among the source name's tokens,
 *     after nickname -> formal mapping ("Tommy Tuberville" -> {thomas,
 *     tuberville} within {thomas, h, tuberville}). This is also the only path
 *     when the roster could not be loaded, or for filers who aren't current
 *     current House members, and it lets a bare last name ("Tuberville") match.
 */
export function buildMemberMatcher(inputs: string[], resolver: NameResolver | null): MemberMatcher {
  const entries = inputs
    .map((raw) => raw.trim())
    .filter((s) => s.length > 0)
    .map((raw) => {
      const isBioguide = BIOGUIDE_RE.test(raw.toUpperCase());
      return {
        bioguide: isBioguide ? raw.toUpperCase() : (resolver?.resolve(raw) ?? null),
        tokens: isBioguide ? [] : nameTokens(raw).map(formalToken),
      };
    });

  return (displayName: string): boolean => {
    const srcTokens = new Set(nameTokens(displayName).map(formalToken));
    let srcBioguide: string | null | undefined;
    for (const e of entries) {
      if (e.bioguide) {
        if (srcBioguide === undefined) srcBioguide = resolver?.resolve(displayName) ?? null;
        if (srcBioguide === e.bioguide) return true;
      }
      if (e.tokens.length > 0 && e.tokens.every((t) => srcTokens.has(t))) return true;
    }
    return false;
  };
}
