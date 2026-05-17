// Shared types + small formatters used by the Personal tab sub-components.
// Mirrors the backend structs in src-tauri/src/personal.rs. Kept in one
// place so the three sub-components (ProfileSection, KnownSection,
// StyleSection) don't drift on the shape of `known.json` / `profile.md`.

export type PersonalProfile = {
  path: string;
  content: string;
  last_modified: string | null;
  size_bytes: number;
  // True when the backend returned the default template instead of the
  // user's real content (file missing or below the "unedited" threshold).
  seeded: boolean;
};

export type WritingStyle = {
  tone: string;
  primary_language: string;
  code_switching: string;
  characteristic_phrases: string[];
  typo_patterns: string[];
  formatting_habits: string;
  average_message_length_chars: number;
  punctuation_quirks: string;
};

export type PersonalKnown = {
  style_fingerprint: string;
  writing_style: WritingStyle;
  recent_topics: string[];
  routines: string[];
  last_updated: string | null;
  source: string;
};

export type PersonalSample = {
  path: string;
  content: string;
  last_modified: string | null;
  exists: boolean;
};

export function isWritingStyleEmpty(w: WritingStyle | undefined | null): boolean {
  if (!w) return true;
  return (
    !w.tone.trim() &&
    !w.primary_language.trim() &&
    !w.code_switching.trim() &&
    w.characteristic_phrases.length === 0 &&
    w.typo_patterns.length === 0 &&
    !w.formatting_habits.trim() &&
    w.average_message_length_chars === 0 &&
    !w.punctuation_quirks.trim()
  );
}

export function isKnownEmpty(k: PersonalKnown | null): boolean {
  if (!k) return true;
  return (
    !k.style_fingerprint.trim() &&
    k.recent_topics.length === 0 &&
    k.routines.length === 0 &&
    !k.last_updated
  );
}

// "Real content" = bytes minus markdown structure noise. Used to decide
// whether profile.md is effectively empty even when the file technically
// exists. The default template (DEFAULT_TEMPLATE in personal.rs) is mostly
// section headers + parenthetical hints — strip those and what's left should
// be < ~50 chars for an unedited profile.
export function meaningfulProfileChars(md: string): number {
  if (!md) return 0;
  // Drop frontmatter, headings, blank lines, bullet markers, and
  // parenthetical "hint" lines so we measure prose the user actually wrote.
  const cleaned = md
    .replace(/^---[\s\S]*?---/m, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .filter((l) => !l.startsWith("#"))
    .filter((l) => !/^[-*+]\s*$/.test(l))
    .filter((l) => !/^\(.*\)$/.test(l))
    .join(" ")
    .replace(/[-*+]\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length;
}

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  return `${(b / 1024).toFixed(1)} KB`;
}

export function formatRel(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso;
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
