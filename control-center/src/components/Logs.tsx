import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Logs tab — selector de fuente curada (alerts, doctor, retention, etc.)
// + tail vivo del archivo seleccionado con auto-refresh opcional. La lista
// de fuentes vive en src-tauri/src/logs.rs::catalog().

type LogSource = {
  id: string;
  label: string;
  path: string;
  exists: boolean;
  size_bytes: number;
  last_modified: string | null;
  kind: string;
  description: string;
};

// Severity classification — substring match against the raw line. Kept
// pragmatic: same words the underlying Python / PS scripts emit.
const ERROR_RE = /\b(error|critical|fatal|exception|traceback|fail(ed|ure)?|0xc[0-9a-f]+)\b/i;
const WARN_RE = /\b(warn(ing)?|deprecated|skipped|retr(y|ying)|timeout)\b/i;

type LineSeverity = "error" | "warn" | "info";

function classifyLine(line: string): LineSeverity {
  if (ERROR_RE.test(line)) return "error";
  if (WARN_RE.test(line)) return "warn";
  return "info";
}

type LogTail = {
  source_id: string;
  path: string;
  total_lines: number;
  tail: string[];
  truncated: boolean;
};

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function formatRel(iso: string | null): string {
  if (!iso) return "-";
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

const LINE_OPTIONS = [100, 200, 500, 1000, 2000];

export function Logs() {
  const [sources, setSources] = useState<LogSource[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tail, setTail] = useState<LogTail | null>(null);
  const [lineCount, setLineCount] = useState(200);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [search, setSearch] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const preRef = useRef<HTMLDivElement | null>(null);

  async function loadSources() {
    try {
      const r = await invoke<LogSource[]>("list_logs");
      setSources(r);
      if (!selected) {
        const firstExisting = r.find((s) => s.exists) ?? r[0];
        if (firstExisting) setSelected(firstExisting.id);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function loadTail(id: string, lines: number) {
    setLoading(true);
    try {
      const r = (await invoke("tail_log", { sourceId: id, lines })) as LogTail;
      setTail(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSources();
  }, []);

  useEffect(() => {
    if (selected) loadTail(selected, lineCount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, lineCount]);

  useEffect(() => {
    if (!autoRefresh || !selected) return;
    const t = window.setInterval(() => {
      void loadTail(selected, lineCount);
      void loadSources();
    }, 3000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, selected, lineCount]);

  // Scroll the pre to the bottom on every tail update so the freshest
  // line is visible without the user fighting the scrollbar.
  useEffect(() => {
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [tail]);

  const classified = useMemo(() => {
    if (!tail) return [] as { line: string; severity: LineSeverity }[];
    return tail.tail.map((l) => ({ line: l, severity: classifyLine(l) }));
  }, [tail]);

  const filteredLines = useMemo(() => {
    if (classified.length === 0) return [];
    const q = search.trim().toLowerCase();
    return classified.filter((entry) => {
      if (errorsOnly && entry.severity === "info") return false;
      if (!q) return true;
      return entry.line.toLowerCase().includes(q);
    });
  }, [classified, search, errorsOnly]);

  const counts = useMemo(() => {
    let errors = 0;
    let warns = 0;
    for (const c of classified) {
      if (c.severity === "error") errors += 1;
      else if (c.severity === "warn") warns += 1;
    }
    return { errors, warns };
  }, [classified]);

  const sourcesSorted = useMemo(
    () =>
      [...sources].sort(
        (a, b) =>
          (b.last_modified ?? "").localeCompare(a.last_modified ?? "") ||
          a.label.localeCompare(b.label),
      ),
    [sources],
  );

  const sel = sources.find((s) => s.id === selected) ?? null;

  return (
    <div className="flex h-full overflow-hidden">
      <aside
        className="flex w-[300px] shrink-0 flex-col overflow-hidden border-r"
        style={{ borderColor: "var(--color-border)" }}
      >
        <header
          className="border-b px-4 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <h1 className="text-[16px] font-semibold leading-tight">Logs</h1>
          <p
            className="mt-1 text-[11px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {sources.filter((s) => s.exists).length} / {sources.length} sources present
          </p>
        </header>
        <div className="flex-1 overflow-auto p-2">
          {sourcesSorted.map((s) => {
            const active = s.id === selected;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setSelected(s.id)}
                disabled={!s.exists}
                className="block w-full rounded px-2.5 py-2 text-left transition-colors disabled:opacity-40"
                style={{
                  background: active ? "var(--color-surface-3)" : "transparent",
                  border: `1px solid ${active ? "var(--color-border-strong)" : "transparent"}`,
                }}
              >
                <div className="flex items-baseline gap-2">
                  <span
                    className="truncate text-[12px] font-medium"
                    style={{ color: "var(--color-text)" }}
                  >
                    {s.label}
                  </span>
                  <span
                    className="ml-auto shrink-0 text-[10px]"
                    style={{ color: "var(--color-text-faint)" }}
                  >
                    {s.exists ? formatBytes(s.size_bytes) : "missing"}
                  </span>
                </div>
                <div
                  className="mt-0.5 truncate text-[10px]"
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--color-text-faint)",
                  }}
                  title={s.path}
                >
                  {s.path}
                </div>
                {s.last_modified && (
                  <div
                    className="mt-0.5 text-[10px]"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {formatRel(s.last_modified)}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        <header
          className="flex items-center gap-2 border-b px-4 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold">{sel?.label ?? "-"}</div>
            {sel?.description && (
              <div
                className="mt-0.5 text-[11px] leading-relaxed"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {sel.description}
              </div>
            )}
            <div
              className="mt-0.5 truncate text-[10.5px]"
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--color-text-faint)",
              }}
            >
              {sel?.path ?? ""}
            </div>
          </div>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="filter..."
            className="w-44 rounded px-2 py-1 text-[12px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
              outline: "none",
            }}
          />
          <select
            value={lineCount}
            onChange={(e) => setLineCount(parseInt(e.target.value, 10))}
            className="rounded px-2 py-1 text-[12px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            {LINE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} lines
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setErrorsOnly(!errorsOnly)}
            className="rounded px-2.5 py-1 text-[11.5px] transition-colors"
            style={{
              background: errorsOnly
                ? "rgba(248, 81, 73, 0.08)"
                : "transparent",
              color: errorsOnly ? "var(--color-danger)" : "var(--color-text-tertiary)",
              border: `1px solid ${errorsOnly ? "rgba(248, 81, 73, 0.22)" : "var(--color-border-strong)"}`,
            }}
            title="Show only lines classified as error or warning"
          >
            {errorsOnly ? "Errors only" : "All lines"}
          </button>
          <button
            type="button"
            onClick={() => setAutoRefresh(!autoRefresh)}
            className="rounded px-2.5 py-1 text-[11.5px] transition-colors"
            style={{
              background: autoRefresh
                ? "rgba(63, 185, 80, 0.08)"
                : "transparent",
              color: autoRefresh ? "var(--color-success)" : "var(--color-text-tertiary)",
              border: `1px solid ${autoRefresh ? "rgba(63, 185, 80, 0.22)" : "var(--color-border-strong)"}`,
            }}
            title="Auto-refresh every 3s while this tab is visible"
          >
            {autoRefresh ? "Auto on" : "Auto off"}
          </button>
          <button
            type="button"
            onClick={() => selected && loadTail(selected, lineCount)}
            disabled={!selected || loading}
            className="rounded px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {loading ? "..." : "Refresh"}
          </button>
        </header>

        {error && (
          <div
            className="m-3 rounded p-3 text-[12px]"
            style={{
              background: "rgba(248, 81, 73, 0.06)",
              border: "1px solid rgba(248, 81, 73, 0.22)",
              color: "var(--color-danger)",
            }}
          >
            {error}
          </div>
        )}

        {tail && (
          <div
            className="flex items-baseline gap-3 border-b px-4 py-1.5 text-[10.5px]"
            style={{
              borderColor: "var(--color-border)",
              color: "var(--color-text-tertiary)",
            }}
          >
            <span>
              {filteredLines.length} / {tail.total_lines.toLocaleString()} lines
            </span>
            {counts.errors > 0 && (
              <span style={{ color: "var(--color-danger)" }}>
                {counts.errors} error{counts.errors === 1 ? "" : "s"}
              </span>
            )}
            {counts.warns > 0 && (
              <span style={{ color: "var(--color-warn)" }}>
                {counts.warns} warn
              </span>
            )}
            {tail.truncated && (
              <span style={{ color: "var(--color-warn)" }}>
                large file - tail read from end
              </span>
            )}
          </div>
        )}

        <div
          ref={preRef}
          className="flex-1 overflow-auto px-4 py-3 text-[11px] leading-relaxed"
          style={{
            background: "var(--color-surface-1)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {filteredLines.length === 0 && !loading && (
            <span style={{ color: "var(--color-text-faint)" }}>
              {sel?.exists === false
                ? "Log file does not exist yet."
                : search || errorsOnly
                  ? "No lines match the filter."
                  : "Empty."}
            </span>
          )}
          {filteredLines.map((entry, i) => {
            const color =
              entry.severity === "error"
                ? "var(--color-danger)"
                : entry.severity === "warn"
                  ? "var(--color-warn)"
                  : "var(--color-text-secondary)";
            const bg =
              entry.severity === "error"
                ? "rgba(248, 81, 73, 0.04)"
                : entry.severity === "warn"
                  ? "rgba(210, 153, 34, 0.03)"
                  : "transparent";
            return (
              <div
                key={i}
                style={{
                  color,
                  background: bg,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  padding: bg === "transparent" ? "0" : "0 4px",
                  borderRadius: 2,
                }}
              >
                {entry.line || " "}
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
