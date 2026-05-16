import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";

// Curated "interesting zone" of the memory corpus. Replaces the
// pseudo-UMAP scatter with the user-visible takeaway sections that
// answer "what's actually in my vault?".
//
// All data comes from a single `compute_memory_highlights` invocation
// — the Rust side walks both vaults once and emits all five sections
// so we don't fan out N invokes from the React tree.

// ---------------------------------------------------------------------------
// Types — mirror memory_highlights.rs
// ---------------------------------------------------------------------------

type RecentNote = {
  path: string;
  relative: string;
  title: string;
  tags: string[];
  category: string | null;
  size_bytes: number;
  last_modified: string | null;
  snippet: string;
};

type NoteWithLinks = RecentNote & {
  inbound: number;
  outbound: number;
};

type MemoryHighlightsData = {
  most_linked: NoteWithLinks[];
  recently_active: RecentNote[];
  by_topic: Record<string, RecentNote[]>;
  orphans: RecentNote[];
  long_form: RecentNote[];
  computed_at: string;
  total_notes: number;
  total_wikilinks: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function relTime(iso: string | null): string {
  if (!iso) return "-";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso;
  const m = Math.floor((Date.now() - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// Strip the "NN__" sort prefix the backend injects to keep the BTreeMap
// in frequency order.
function topicLabel(key: string): string {
  const idx = key.indexOf("__");
  return idx >= 0 ? key.slice(idx + 2) : key;
}

// ---------------------------------------------------------------------------
// Reusable section shell
// ---------------------------------------------------------------------------

function Section({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-baseline justify-between px-4 py-3 text-left"
      >
        <div className="flex items-baseline gap-3">
          <span
            className="text-[10px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {open ? "Hide" : "Show"}
          </span>
          <h3
            className="text-[13.5px] font-semibold"
            style={{ color: "var(--color-text)" }}
          >
            {title}
          </h3>
          <span
            className="text-[11px] tabular-nums"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {count}
          </span>
        </div>
      </button>
      {open && (
        <div
          className="border-t px-4 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reusable row helpers — small monochrome list rows the user can click
// to open the underlying file.
// ---------------------------------------------------------------------------

function openFile(path: string, onError: (e: string) => void) {
  openPath(path).catch((e) => onError(String(e)));
}

function TagPills({ tags, max }: { tags: string[]; max: number }) {
  const shown = tags.slice(0, max);
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((t) => (
        <span
          key={t}
          className="rounded px-1.5 py-0.5 text-[9.5px]"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text-tertiary)",
          }}
        >
          {t}
        </span>
      ))}
      {tags.length > max && (
        <span
          className="text-[9.5px]"
          style={{ color: "var(--color-text-faint)" }}
        >
          +{tags.length - max}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function MemoryHighlights() {
  const [data, setData] = useState<MemoryHighlightsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({
    most_linked: true,
    recently_active: true,
    by_topic: true,
    orphans: false,
    long_form: false,
  });
  const [openTopics, setOpenTopics] = useState<Record<string, boolean>>({});
  const [marking, setMarking] = useState<string | null>(null);
  const [markedPaths, setMarkedPaths] = useState<Set<string>>(new Set());

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = (await invoke("compute_memory_highlights")) as MemoryHighlightsData;
      setData(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function markOrphan(path: string, title: string) {
    setMarking(path);
    try {
      await invoke("mark_orphan_for_review", { path, title });
      setMarkedPaths((s) => new Set(s).add(path));
    } catch (e) {
      setError(String(e));
    } finally {
      setMarking(null);
    }
  }

  function toggle(key: string) {
    setOpen((o) => ({ ...o, [key]: !o[key] }));
  }

  function toggleTopic(key: string) {
    setOpenTopics((o) => ({ ...o, [key]: !o[key] }));
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div
        className="flex shrink-0 items-baseline justify-between gap-3 border-b px-4 py-3"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div
          className="text-[11px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {data
            ? `${data.total_notes} notes scanned · ${data.total_wikilinks} wikilinks · computed ${relTime(data.computed_at)}`
            : loading
              ? "Computing highlights..."
              : ""}
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="rounded px-3 py-1 text-[11.5px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div
          className="m-4 rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 space-y-3 overflow-auto px-4 py-4">
        {data && data.total_wikilinks === 0 && (
          <div
            className="rounded p-3 text-[11.5px]"
            style={{
              background: "rgba(210, 153, 34, 0.06)",
              border: "1px solid rgba(210, 153, 34, 0.22)",
              color: "var(--color-warn)",
            }}
          >
            No <code>[[wikilinks]]</code> found in the vault. "Most linked"
            and "Orphans" are derived from wikilink counts — without any
            wikilinks every note is an orphan. Consider adding cross-note
            references in Obsidian to make these sections useful.
          </div>
        )}

        {/* Most linked */}
        <Section
          title="Most linked"
          count={data?.most_linked.length ?? 0}
          open={open.most_linked}
          onToggle={() => toggle("most_linked")}
        >
          {data && data.most_linked.length === 0 && (
            <div
              className="text-[11.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              No notes participate in wikilinks yet.
            </div>
          )}
          <table className="w-full text-[11.5px]">
            <thead>
              <tr style={{ color: "var(--color-text-tertiary)" }}>
                <th className="pb-1 text-left font-medium">Title</th>
                <th className="w-[60px] pb-1 text-right font-medium tabular-nums">
                  In
                </th>
                <th className="w-[60px] pb-1 text-right font-medium tabular-nums">
                  Out
                </th>
                <th className="pb-1 pl-3 text-left font-medium">Tags</th>
              </tr>
            </thead>
            <tbody>
              {data?.most_linked.map((n) => (
                <tr
                  key={n.path}
                  className="cursor-pointer"
                  onClick={() => openFile(n.path, setError)}
                  style={{ borderTop: "1px solid var(--color-border)" }}
                >
                  <td
                    className="py-1.5 pr-2"
                    style={{ color: "var(--color-text)" }}
                  >
                    {n.title}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {n.inbound}
                  </td>
                  <td
                    className="py-1.5 text-right tabular-nums"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {n.outbound}
                  </td>
                  <td className="py-1.5 pl-3">
                    <TagPills tags={n.tags} max={4} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        {/* Recently active */}
        <Section
          title="Recently active"
          count={data?.recently_active.length ?? 0}
          open={open.recently_active}
          onToggle={() => toggle("recently_active")}
        >
          <table className="w-full text-[11.5px]">
            <thead>
              <tr style={{ color: "var(--color-text-tertiary)" }}>
                <th className="pb-1 text-left font-medium">Title</th>
                <th className="w-[110px] pb-1 text-right font-medium">
                  Modified
                </th>
                <th className="w-[80px] pb-1 text-right font-medium">Size</th>
              </tr>
            </thead>
            <tbody>
              {data?.recently_active.map((n) => (
                <tr
                  key={n.path}
                  className="cursor-pointer"
                  onClick={() => openFile(n.path, setError)}
                  style={{ borderTop: "1px solid var(--color-border)" }}
                >
                  <td
                    className="py-1.5 pr-2"
                    style={{ color: "var(--color-text)" }}
                  >
                    {n.title}
                    <div
                      className="text-[10px]"
                      style={{
                        fontFamily: "var(--font-mono)",
                        color: "var(--color-text-faint)",
                      }}
                    >
                      {n.relative}
                    </div>
                  </td>
                  <td
                    className="py-1.5 text-right tabular-nums"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {relTime(n.last_modified)}
                  </td>
                  <td
                    className="py-1.5 text-right tabular-nums"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {fmtBytes(n.size_bytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        {/* By topic */}
        <Section
          title="By topic"
          count={data ? Object.keys(data.by_topic).length : 0}
          open={open.by_topic}
          onToggle={() => toggle("by_topic")}
        >
          <div className="space-y-1">
            {data &&
              Object.entries(data.by_topic).map(([key, notes]) => {
                const label = topicLabel(key);
                const topicOpen = !!openTopics[key];
                return (
                  <div
                    key={key}
                    className="rounded"
                    style={{
                      background: "var(--color-surface-1)",
                      border: "1px solid var(--color-border)",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => toggleTopic(key)}
                      className="flex w-full items-baseline justify-between px-3 py-1.5 text-left"
                    >
                      <span
                        className="text-[11.5px] font-medium"
                        style={{ color: "var(--color-text)" }}
                      >
                        {label}
                      </span>
                      <span
                        className="text-[10.5px] tabular-nums"
                        style={{ color: "var(--color-text-tertiary)" }}
                      >
                        {notes.length} notes
                      </span>
                    </button>
                    {topicOpen && (
                      <div
                        className="border-t px-3 py-2"
                        style={{ borderColor: "var(--color-border)" }}
                      >
                        {notes.map((n) => (
                          <button
                            key={n.path}
                            type="button"
                            onClick={() => openFile(n.path, setError)}
                            className="block w-full truncate py-1 text-left text-[11px]"
                            style={{ color: "var(--color-text-secondary)" }}
                            title={n.relative}
                          >
                            {n.title}{" "}
                            <span
                              style={{ color: "var(--color-text-faint)" }}
                            >
                              · {relTime(n.last_modified)}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </Section>

        {/* Orphans */}
        <Section
          title="Orphans"
          count={data?.orphans.length ?? 0}
          open={open.orphans}
          onToggle={() => toggle("orphans")}
        >
          <div
            className="mb-2 text-[11px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Notes with no wikilinks in or out. Candidates for connecting or
            pruning. "Mark for review" adds an entry to the inbox.
          </div>
          <table className="w-full text-[11.5px]">
            <thead>
              <tr style={{ color: "var(--color-text-tertiary)" }}>
                <th className="pb-1 text-left font-medium">Title</th>
                <th className="w-[110px] pb-1 text-right font-medium">
                  Modified
                </th>
                <th className="w-[150px] pb-1 text-right font-medium" />
              </tr>
            </thead>
            <tbody>
              {data?.orphans.map((n) => {
                const marked = markedPaths.has(n.path);
                return (
                  <tr
                    key={n.path}
                    style={{ borderTop: "1px solid var(--color-border)" }}
                  >
                    <td
                      className="cursor-pointer py-1.5 pr-2"
                      onClick={() => openFile(n.path, setError)}
                      style={{ color: "var(--color-text)" }}
                    >
                      {n.title}
                      <div
                        className="text-[10px]"
                        style={{
                          fontFamily: "var(--font-mono)",
                          color: "var(--color-text-faint)",
                        }}
                      >
                        {n.relative}
                      </div>
                    </td>
                    <td
                      className="py-1.5 text-right tabular-nums"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      {relTime(n.last_modified)}
                    </td>
                    <td className="py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => markOrphan(n.path, n.title)}
                        disabled={marking === n.path || marked}
                        className="rounded px-2 py-1 text-[10.5px] font-medium transition-colors disabled:opacity-50"
                        style={{
                          background: marked
                            ? "var(--color-surface-3)"
                            : "var(--color-surface-2)",
                          color: marked
                            ? "var(--color-success)"
                            : "var(--color-text-secondary)",
                          border: "1px solid var(--color-border-strong)",
                        }}
                      >
                        {marked
                          ? "Marked"
                          : marking === n.path
                            ? "Marking..."
                            : "Mark for review"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>

        {/* Long form */}
        <Section
          title="Long form"
          count={data?.long_form.length ?? 0}
          open={open.long_form}
          onToggle={() => toggle("long_form")}
        >
          <div
            className="mb-2 text-[11px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Notes over 2 KB. Substantial content worth re-reading.
          </div>
          <table className="w-full text-[11.5px]">
            <thead>
              <tr style={{ color: "var(--color-text-tertiary)" }}>
                <th className="pb-1 text-left font-medium">Title</th>
                <th className="w-[80px] pb-1 text-right font-medium">Size</th>
              </tr>
            </thead>
            <tbody>
              {data?.long_form.map((n) => (
                <tr
                  key={n.path}
                  className="cursor-pointer"
                  onClick={() => openFile(n.path, setError)}
                  style={{ borderTop: "1px solid var(--color-border)" }}
                >
                  <td
                    className="py-1.5 pr-2"
                    style={{ color: "var(--color-text)" }}
                  >
                    {n.title}
                    <div
                      className="mt-0.5 text-[10.5px]"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      {n.snippet.slice(0, 200)}
                      {n.snippet.length > 200 ? "..." : ""}
                    </div>
                  </td>
                  <td
                    className="py-1.5 text-right tabular-nums align-top"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {fmtBytes(n.size_bytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </div>
    </div>
  );
}
