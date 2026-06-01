// Ranked client-side search for the Library inventory (Skills / Agents).
//
// Replaces the naive `name.includes(q)` substring filter that Skills.tsx and
// Agents.tsx used to ship. The old filter had no fuzzy matching, no ranking
// and no synonym awareness, so "multiplayer" never surfaced a "netcode"
// skill and a typo like "scurity" returned nothing.
//
// What this gives us instead:
//   - In-order fuzzy char matching with consecutive + word-boundary bonuses
//     (ported from CommandPalette.tsx `fuzzyScore`, the proven scorer).
//   - Synonym expansion: the query is fanned out through query-synonyms.json
//     so "multiplayer" also matches "replication / netcode / session".
//   - Field weighting: name > tags > description (a hit in the name ranks far
//     above a hit buried in a long description).
//   - Signal weighting: priority and usage_count nudge well-used / high-prio
//     items up when scores are otherwise close.
//
// Everything is synchronous and allocation-light so it can run inside a
// `useMemo` on every keystroke without a perceptible lag for the ~400 item
// inventories we deal with.

// ---------------------------------------------------------------------------
// Synonyms
// ---------------------------------------------------------------------------
//
// Embedded copy of ~/.ultron/cockpit/query-synonyms.json. That file lives
// outside the bundled frontend (it is consumed by the cockpit Python tools),
// so we keep an in-tree mirror to avoid a backend round-trip on every search.
// Keep this in sync if the cockpit file grows — it is intentionally small.
//
// Each value is the original "term OR term OR …" expansion string; we split
// it into individual lowercase terms at module load.

const SYNONYM_SOURCE: Record<string, string> = {
  desync: "desync OR replication OR NetUpdate OR RPC OR sync",
  lag: "lag OR replication OR netcode OR latency OR RTT",
  multiplayer: "multiplayer OR replication OR netcode OR session OR listen",
  rollback: "rollback OR netcode OR desync OR replication",
  ability: "ability OR GAS OR GameplayAbility OR ASC OR AttributeSet",
  attribute: "attribute OR AttributeSet OR GAS OR GameplayEffect",
  input: "input OR InputAction OR IMC OR EnhancedInput OR mapping",
  crash: "crash OR assert OR ensure OR UFUNCTION OR nullptr",
  package: "package OR uv OR pip OR pyproject OR dependency",
  lint: "lint OR ruff OR mypy OR ty OR format",
  test: "test OR pytest OR hypothesis OR coverage OR fixture",
  auth: "auth OR supabase OR GoTrue OR RLS OR cookie OR session",
  ssr: "ssr OR nextjs OR ServerComponent OR ServerAction OR hydration",
  database: "database OR supabase OR RLS OR migration OR schema OR SQL",
  skill: "skill OR SKILL OR persona OR routing OR ULTRON",
  hook: "hook OR SessionStart OR PostToolUse OR Stop OR UserPrompt",
  memory: "memory OR vault OR brain OR INDEX OR decay OR session",
  agent: "agent OR subagent OR dispatch OR parallel OR fork",
};

// Pre-split into a key → unique lowercase terms map (excluding the literal
// "or" connector and the key itself, which the caller already searches for).
const SYNONYM_MAP: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  for (const [key, expansion] of Object.entries(SYNONYM_SOURCE)) {
    const terms = expansion
      .split(/\s+OR\s+/i)
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 1 && t !== key);
    // De-dup while preserving order.
    out[key] = Array.from(new Set(terms));
  }
  return out;
})();

/// Expand a raw query into the original query terms plus any synonym terms
/// triggered by a whole-word match against the synonym table. Returns a list
/// of `{ term, weight }` where synonym terms carry a lower weight so a direct
/// hit always beats a synonym-mediated one.
export interface WeightedTerm {
  term: string;
  weight: number;
}

const SYNONYM_WEIGHT = 0.6;

export function expandQuery(raw: string): WeightedTerm[] {
  const q = raw.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  const out: WeightedTerm[] = [];

  // 1. The full query string is always the primary term (weight 1).
  if (!seen.has(q)) {
    seen.add(q);
    out.push({ term: q, weight: 1 });
  }

  // 2. Individual words (so "deep research" also matches "research").
  for (const w of words) {
    if (w.length > 1 && !seen.has(w)) {
      seen.add(w);
      out.push({ term: w, weight: 1 });
    }
    // 3. Synonyms triggered by each word.
    const syns = SYNONYM_MAP[w];
    if (syns) {
      for (const s of syns) {
        if (!seen.has(s)) {
          seen.add(s);
          out.push({ term: s, weight: SYNONYM_WEIGHT });
        }
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Fuzzy scorer (ported from CommandPalette.tsx)
// ---------------------------------------------------------------------------

/// In-order fuzzy scorer. Returns a positive score when every char of `q`
/// appears in `text` in order, with bonuses for consecutive matches and
/// word-boundary starts. Negative result means "no match".
export function fuzzyScore(text: string, q: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const query = q.toLowerCase();
  let ti = 0;
  let qi = 0;
  let score = 0;
  let streak = 0;
  let prevWasBoundary = true;
  while (ti < t.length && qi < query.length) {
    const tc = t[ti];
    if (tc === query[qi]) {
      score += 2 + streak; // bonus for consecutive matches
      if (prevWasBoundary) score += 3; // bonus for word-start matches
      streak += 1;
      qi += 1;
    } else {
      streak = 0;
    }
    prevWasBoundary = tc === " " || tc === "-" || tc === "_" || tc === "/";
    ti += 1;
  }
  if (qi < query.length) return -1; // incomplete match
  // Prefer shorter labels when scores are otherwise tied.
  return score - Math.floor(t.length / 40);
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/// Searchable view of an inventory item. `priority` (1–10) and `usageCount`
/// are optional; when absent they contribute nothing so the ranking still
/// works for agents (which carry neither in their on-disk shape).
export interface SearchableItem {
  name: string;
  description?: string | null;
  tags?: string[];
  origin?: string;
  priority?: number | null;
  usageCount?: number | null;
}

// Field weights — a name hit dominates, tags matter, description is weakest.
const W_NAME = 1.0;
const W_TAGS = 0.55;
const W_DESC = 0.3;
const W_ORIGIN = 0.2;

// How much priority / usage nudge the score. Kept small so they only act as
// tie-breakers between otherwise comparable text matches, never overriding a
// strong textual relevance signal.
const PRIORITY_NUDGE = 0.4; // per point above the neutral 5
const USAGE_NUDGE = 0.5; // applied to a log-scaled usage count

/// Score a single item against the (already expanded) weighted query terms.
/// Returns a non-negative score, or `-1` when no term matches any field.
export function scoreItem(item: SearchableItem, terms: WeightedTerm[]): number {
  if (terms.length === 0) return 0;

  const tagBlob = (item.tags ?? []).join(" ");
  let best = -1;

  for (const { term, weight } of terms) {
    const nameScore = fuzzyScore(item.name, term);
    const tagScore = tagBlob ? fuzzyScore(tagBlob, term) : -1;
    const descScore = item.description ? fuzzyScore(item.description, term) : -1;
    const originScore = item.origin ? fuzzyScore(item.origin, term) : -1;

    // Combine per-field, applying the field weight only to positive hits so a
    // "no match" (-1) field never drags the composite below a real hit.
    const fieldBest = Math.max(
      nameScore >= 0 ? nameScore * W_NAME : -1,
      tagScore >= 0 ? tagScore * W_TAGS : -1,
      descScore >= 0 ? descScore * W_DESC : -1,
      originScore >= 0 ? originScore * W_ORIGIN : -1,
    );

    if (fieldBest >= 0) {
      const weighted = fieldBest * weight;
      if (weighted > best) best = weighted;
    }
  }

  if (best < 0) return -1;

  // Signal nudges — only when the item actually matched.
  if (typeof item.priority === "number") {
    best += (item.priority - 5) * PRIORITY_NUDGE;
  }
  if (typeof item.usageCount === "number" && item.usageCount > 0) {
    best += Math.log1p(item.usageCount) * USAGE_NUDGE;
  }

  return best;
}

/// Rank `items` against `rawQuery`. With an empty query the input is returned
/// untouched (caller decides ordering). Otherwise items are filtered to those
/// with a non-negative score and sorted by score descending, with a stable
/// alphabetical tie-break on name.
export function rankBySearch<T extends SearchableItem>(
  items: T[],
  rawQuery: string,
): T[] {
  const q = rawQuery.trim();
  if (!q) return items;
  const terms = expandQuery(q);
  const scored = items
    .map((item) => ({ item, score: scoreItem(item, terms) }))
    .filter((entry) => entry.score >= 0);
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.item.name.localeCompare(b.item.name);
  });
  return scored.map((s) => s.item);
}
