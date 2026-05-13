import { useState } from "react";
import type { ChangelogEntry } from "../types";
import { RenderBody } from "../lib/renderBody";
import { groupByVersion, type VersionGroup } from "../lib/versions";

type Props = { entries: ChangelogEntry[] };

function formatDateRange(first: string, last: string): string {
  const fmt = (iso: string) => {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-CA");
  };
  const a = fmt(first);
  const b = fmt(last);
  return a === b ? a : `${a} → ${b}`;
}

// ---------------------------------------------------------------------------
// Highlight (a single feat entry shown prominently)
// ---------------------------------------------------------------------------

function Highlight({ entry }: { entry: ChangelogEntry }) {
  const [open, setOpen] = useState(false);
  const hasBody = entry.body && entry.body.length > 0;

  return (
    <article
      className="rounded p-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-baseline gap-2">
        <span
          className="text-[10px] font-medium uppercase tracking-[0.06em]"
          style={{ color: "var(--color-success)" }}
        >
          added
        </span>
        <span className="text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
          {entry.scope}
        </span>
        <span
          className="ml-auto text-[11px] tabular-nums"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {entry.ts.slice(0, 10)}
        </span>
      </div>

      {/* Title — strip leading "v15.X.Y" since it's redundant at this level */}
      <h3 className="mt-1 text-[14px] font-semibold leading-snug">
        {entry.title.replace(/^v?\d+(\.\d+)+\s*[\-—:]?\s*/i, "")}
      </h3>

      {hasBody && (
        <>
          {open && (
            <div className="mt-3">
              <RenderBody body={entry.body} />
            </div>
          )}
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="mt-2 text-[11px] transition-colors"
            style={{ color: "var(--color-text-tertiary)" }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--color-text-secondary)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--color-text-tertiary)")}
          >
            {open ? "Hide details" : "Show details"}
          </button>
        </>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Internal change (chore/fix/refactor) — compact, collapsed by default
// ---------------------------------------------------------------------------

function InternalRow({ entry }: { entry: ChangelogEntry }) {
  const [open, setOpen] = useState(false);
  const hasBody = entry.body && entry.body.length > 0;
  const tag = entry.type;

  return (
    <li className="border-l py-2 pl-3" style={{ borderColor: "var(--color-border)" }}>
      <button
        type="button"
        onClick={() => hasBody && setOpen(!open)}
        className="flex w-full items-baseline gap-2 text-left"
        style={{ cursor: hasBody ? "pointer" : "default" }}
      >
        <span
          className="w-14 shrink-0 text-[10px] font-medium uppercase tracking-[0.06em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {tag}
        </span>
        <span
          className="flex-1 text-[12.5px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {entry.title.replace(/^v?\d+(\.\d+)+\s*[\-—:]?\s*/i, "")}
        </span>
        <span
          className="text-[10.5px] tabular-nums"
          style={{ color: "var(--color-text-faint)" }}
        >
          {entry.ts.slice(0, 10)}
        </span>
      </button>
      {open && hasBody && (
        <div className="mt-2 pl-16">
          <RenderBody body={entry.body} />
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Version section
// ---------------------------------------------------------------------------

function VersionSection({ g }: { g: VersionGroup }) {
  const [showInternal, setShowInternal] = useState(false);

  return (
    <section>
      <header className="mb-4 flex items-baseline gap-3">
        <h2
          className="text-[24px] font-semibold tabular-nums leading-none"
          style={{ letterSpacing: "-0.01em" }}
        >
          v{g.version}
        </h2>
        <div
          className="h-px flex-1"
          style={{ background: "var(--color-border)" }}
        />
        <span
          className="text-[11px] tabular-nums"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {formatDateRange(g.firstTs, g.lastTs)}
        </span>
      </header>

      {/* Highlights */}
      {g.highlights.length > 0 && (
        <div className="space-y-2.5">
          {g.highlights.map((e) => (
            <Highlight key={e.id} entry={e} />
          ))}
        </div>
      )}

      {/* Internal changes (collapsed) */}
      {g.internal.length > 0 && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowInternal(!showInternal)}
            className="text-[11px] transition-colors"
            style={{ color: "var(--color-text-tertiary)" }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--color-text-secondary)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--color-text-tertiary)")}
          >
            {showInternal
              ? `Hide ${g.internal.length} internal change${g.internal.length === 1 ? "" : "s"}`
              : `${g.internal.length} internal change${g.internal.length === 1 ? "" : "s"}`}
          </button>
          {showInternal && (
            <ul className="mt-2 space-y-0">
              {g.internal.map((e) => (
                <InternalRow key={e.id} entry={e} />
              ))}
            </ul>
          )}
        </div>
      )}

      {g.highlights.length === 0 && g.internal.length === 0 && (
        <div
          className="text-[12.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          No entries.
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function Changelog({ entries }: Props) {
  const { versioned, unversioned } = groupByVersion(entries);
  const [showLegacy, setShowLegacy] = useState(false);

  return (
    <div className="px-10 py-8">
      <header className="mb-10">
        <h1 className="text-[20px] font-semibold leading-tight">Release notes</h1>
        <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
          {versioned.length} versions · {entries.length} total entries
        </p>
      </header>

      {versioned.length === 0 && (
        <div
          className="rounded p-6 text-center text-[13px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          No versioned releases found in changelog.ndjson.
        </div>
      )}

      <div className="space-y-14">
        {versioned.map((g) => (
          <VersionSection key={g.version} g={g} />
        ))}
      </div>

      {/* Legacy pre-versioned entries hidden by default */}
      {unversioned.length > 0 && (
        <div className="mt-16 border-t pt-8" style={{ borderColor: "var(--color-border)" }}>
          <button
            type="button"
            onClick={() => setShowLegacy(!showLegacy)}
            className="text-[12px] transition-colors"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {showLegacy
              ? `Hide ${unversioned.length} legacy entries (pre-v15 series)`
              : `Show ${unversioned.length} legacy entries (pre-v15 series)`}
          </button>
          {showLegacy && (
            <ul className="mt-4 space-y-0">
              {unversioned
                .slice()
                .sort((a, b) => b.ts.localeCompare(a.ts))
                .map((e) => (
                  <InternalRow key={e.id} entry={e} />
                ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
