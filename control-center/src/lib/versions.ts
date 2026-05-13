import type { ChangelogEntry } from "../types";

// ---------------------------------------------------------------------------
// Version extraction & grouping.
//
// Entries persisted in cockpit/changelog.ndjson don't have a normalized
// "version" field — the version lives in the id (e.g. "v15-0-2-docker") or
// the title (e.g. "v15.0.2 Docker/Qdrant resilience..."). We extract it
// here so the UI can show real release notes grouped by version instead
// of one card per commit.
// ---------------------------------------------------------------------------

export type VersionId = string; // "15.0.2", "15.1"

export type VersionGroup = {
  version: VersionId;
  /** Earliest timestamp in the group (release start). */
  firstTs: string;
  /** Latest timestamp in the group (last touch). */
  lastTs: string;
  /** type=feat entries — the "real" release highlights. */
  highlights: ChangelogEntry[];
  /** Everything else (chore/fix/refactor/docs). Shown collapsed. */
  internal: ChangelogEntry[];
};

// Stricter regex: each numeric component capped at 2 digits so dates like
// "2026" (in synthetic ids hist-v14.2-2026-05-09-...) or audit revisions
// like "v2-2026-05" aren't misparsed as version components.
const VERSION_RE =
  /v(\d{1,2})(?!\d)[.\-_](\d{1,2})(?!\d)(?:[.\-_](\d{1,2})(?!\d))?(?:[.\-_]([a-z]+\d*))?/i;

export function extractVersion(entry: ChangelogEntry): VersionId | null {
  for (const source of [entry.id, entry.title, ...(entry.related_ids ?? [])]) {
    if (!source) continue;
    const m = source.match(VERSION_RE);
    if (m) {
      const major = m[1];
      const minor = m[2];
      const patch = m[3];
      // Drop pre-release tag suffix (v15.0b -> v15.0) — USER wants only
      // pure MAJOR.MINOR.PATCH. Also collapse trailing ".0" patch into the
      // bare "X.Y" form (v12.4.0 == v12.4).
      const usePatch = patch && patch !== "0";
      return usePatch ? `${major}.${minor}.${patch}` : `${major}.${minor}`;
    }
  }
  return null;
}

/**
 * Semver-aware descending compare. "15.1" > "15.0.3" > "15.0.2" > "15.0.0".
 * Pre-release tags are stripped by extractVersion so we only ever compare
 * pure MAJOR.MINOR.PATCH triples.
 */
export function compareVersionsDesc(a: VersionId, b: VersionId): number {
  const parse = (v: string): [number, number, number] => {
    const m = v.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
    if (!m) return [0, 0, 0];
    return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3] ?? "0", 10)];
  };
  const [aM, am, ap] = parse(a);
  const [bM, bm, bp] = parse(b);
  if (aM !== bM) return bM - aM;
  if (am !== bm) return bm - am;
  return bp - ap;
}

export function groupByVersion(entries: ChangelogEntry[]): {
  versioned: VersionGroup[];
  unversioned: ChangelogEntry[];
} {
  const groups = new Map<VersionId, VersionGroup>();
  const unversioned: ChangelogEntry[] = [];

  for (const e of entries) {
    const v = extractVersion(e);
    if (!v) {
      unversioned.push(e);
      continue;
    }
    let g = groups.get(v);
    if (!g) {
      g = {
        version: v,
        firstTs: e.ts,
        lastTs: e.ts,
        highlights: [],
        internal: [],
      };
      groups.set(v, g);
    }
    if (e.ts && e.ts < g.firstTs) g.firstTs = e.ts;
    if (e.ts && e.ts > g.lastTs) g.lastTs = e.ts;
    if (e.type === "feat") g.highlights.push(e);
    else g.internal.push(e);
  }

  // Sort each group by ts asc (chronological inside a release)
  for (const g of groups.values()) {
    g.highlights.sort((a, b) => a.ts.localeCompare(b.ts));
    g.internal.sort((a, b) => a.ts.localeCompare(b.ts));
  }

  const versioned = Array.from(groups.values()).sort((a, b) =>
    compareVersionsDesc(a.version, b.version),
  );

  return { versioned, unversioned };
}
