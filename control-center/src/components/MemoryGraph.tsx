import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";

// 2D Memory Map — scatter-plot projection of the brain_index corpus.
//
// Each point comes from `compute_memory_graph` on the Rust side. The
// (x, y) coordinates are deterministic pseudo-UMAP values (hashes of
// category/id/title/timestamp) so points are stable across reloads
// and group visually by category on the x-axis. This is NOT a real
// semantic projection — see memory_graph.rs for the rationale.

export type MemoryPoint = {
  id: string;
  x: number;
  y: number;
  category: string;
  title: string;
  snippet: string;
  timestamp: string;
  path: string;
};

// Status palette + a few neutral hues. We avoid mid-blue (looks too
// "generic tech") per the project's Mike Tyson palette doctrine —
// instead we mix in CSS-var-derived greys with a few amber/violet
// accents so each category gets a perceivable hue without breaking
// the monochromatic vibe of the rest of the app.
const PALETTE: string[] = [
  "var(--color-success)", // green
  "var(--color-warn)",    // amber
  "var(--color-danger)",  // red
  "#a371f7",              // violet
  "#79c0ff",              // sky
  "#ffa657",              // orange
  "#f778ba",              // pink
  "#56d4dd",              // teal
  "#d2a8ff",              // lavender
  "#e3b341",              // gold
];

function colorFor(category: string, categories: string[]): string {
  const idx = categories.indexOf(category);
  if (idx < 0) return "var(--color-text-tertiary)";
  return PALETTE[idx % PALETTE.length];
}

function trimSnippet(s: string, n: number): string {
  if (!s) return "";
  const cleaned = s.replace(/\s+/g, " ").trim();
  if (cleaned.length <= n) return cleaned;
  return cleaned.slice(0, n).trimEnd() + "...";
}

export function MemoryGraph() {
  const [points, setPoints] = useState<MemoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MemoryPoint | null>(null);
  const [hover, setHover] = useState<{
    p: MemoryPoint;
    sx: number;
    sy: number;
  } | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<MemoryPoint[]>("compute_memory_graph")
      .then((r) => {
        if (cancelled) return;
        setPoints(r);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(String(e));
        setPoints([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Distinct categories sorted by frequency (most common first). The
  // legend renders in this order, which doubles as the palette index
  // so categories with the most points get the strongest colours.
  const { categories, counts } = useMemo(() => {
    const c = new Map<string, number>();
    for (const p of points) {
      c.set(p.category, (c.get(p.category) ?? 0) + 1);
    }
    const arr = [...c.entries()].sort((a, b) => b[1] - a[1]);
    return {
      categories: arr.map(([k]) => k),
      counts: arr.map(([, v]) => v),
    };
  }, [points]);

  const visible = useMemo(() => {
    if (!categoryFilter) return points;
    return points.filter((p) => p.category === categoryFilter);
  }, [points, categoryFilter]);

  // Rescale raw (x, y) in [-0.5, 0.6] to the SVG viewBox [40, 960]
  // with a small margin so points don't kiss the edges.
  const VIEW = 1000;
  const PAD = 40;
  function project(raw: number): number {
    // raw is roughly in [-0.5, 0.7] — map to [PAD, VIEW - PAD]
    const min = -0.5;
    const max = 0.75;
    const t = Math.max(0, Math.min(1, (raw - min) / (max - min)));
    return PAD + t * (VIEW - 2 * PAD);
  }

  function onPointEnter(
    e: React.MouseEvent<SVGCircleElement>,
    p: MemoryPoint,
  ) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) {
      setHover({ p, sx: e.clientX, sy: e.clientY });
      return;
    }
    setHover({
      p,
      sx: e.clientX - rect.left,
      sy: e.clientY - rect.top,
    });
  }

  function openSelectedFile() {
    if (!selected?.path) return;
    openPath(selected.path).catch((e: unknown) => setError(String(e)));
  }

  return (
    <div className="flex h-full min-h-[500px] flex-col">
      {/* Top bar — category filter */}
      <div
        className="flex shrink-0 items-center gap-3 border-b px-4 py-2"
        style={{ borderColor: "var(--color-border)" }}
      >
        <span
          className="text-[10px] font-medium uppercase tracking-[0.06em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Category
        </span>
        <select
          value={categoryFilter ?? ""}
          onChange={(e) =>
            setCategoryFilter(e.target.value === "" ? null : e.target.value)
          }
          className="rounded px-2 py-1 text-[12px]"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
            outline: "none",
          }}
        >
          <option value="">All ({points.length})</option>
          {categories.map((c, i) => (
            <option key={c} value={c}>
              {c} ({counts[i]})
            </option>
          ))}
        </select>
        <div
          className="ml-auto text-[11px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {loading
            ? "Loading..."
            : `${visible.length} of ${points.length} points`}
        </div>
      </div>

      {/* Main canvas + side panel */}
      <div className="flex min-h-0 flex-1">
        <div className="relative flex-1 overflow-hidden">
          {error && (
            <div
              className="m-3 rounded p-3 text-[11.5px]"
              style={{
                background: "rgba(248, 81, 73, 0.06)",
                border: "1px solid rgba(248, 81, 73, 0.22)",
                color: "var(--color-danger)",
              }}
            >
              {error}
            </div>
          )}
          {!error && (
            <svg
              ref={svgRef}
              viewBox={`0 0 ${VIEW} ${VIEW}`}
              preserveAspectRatio="xMidYMid meet"
              className="block h-full w-full"
              style={{ background: "var(--color-bg)" }}
              onMouseLeave={() => setHover(null)}
            >
              {/* Subtle grid + axes — pure decoration */}
              <defs>
                <pattern
                  id="memgrid"
                  width={VIEW / 10}
                  height={VIEW / 10}
                  patternUnits="userSpaceOnUse"
                >
                  <path
                    d={`M ${VIEW / 10} 0 L 0 0 0 ${VIEW / 10}`}
                    fill="none"
                    stroke="var(--color-border)"
                    strokeWidth={0.5}
                  />
                </pattern>
              </defs>
              <rect width={VIEW} height={VIEW} fill="url(#memgrid)" />

              {visible.map((p) => {
                const cx = project(p.x);
                const cy = project(p.y);
                const isSelected = selected?.id === p.id;
                const fill = colorFor(p.category, categories);
                return (
                  <circle
                    key={p.id}
                    cx={cx}
                    cy={cy}
                    r={isSelected ? 7 : 4}
                    fill={fill}
                    fillOpacity={isSelected ? 1 : 0.78}
                    stroke={
                      isSelected ? "var(--color-text)" : "rgba(0,0,0,0.6)"
                    }
                    strokeWidth={isSelected ? 1.5 : 0.5}
                    style={{ cursor: "pointer", transition: "r 0.12s ease" }}
                    onMouseEnter={(e) => onPointEnter(e, p)}
                    onMouseMove={(e) => onPointEnter(e, p)}
                    onClick={() => setSelected(p)}
                  >
                    <title>{p.title}</title>
                  </circle>
                );
              })}
            </svg>
          )}

          {/* Hover tooltip — absolute over the SVG */}
          {hover && (
            <div
              className="pointer-events-none absolute rounded px-2 py-1.5"
              style={{
                left: Math.min(hover.sx + 14, 720),
                top: Math.max(hover.sy - 10, 8),
                background: "var(--color-surface-1)",
                border: "1px solid var(--color-border-strong)",
                maxWidth: 320,
                zIndex: 10,
                boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
              }}
            >
              <div
                className="truncate text-[11.5px] font-medium"
                style={{ color: "var(--color-text)" }}
              >
                {hover.p.title}
              </div>
              <div
                className="mt-0.5 text-[10.5px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {trimSnippet(hover.p.snippet, 80)}
              </div>
              <div
                className="mt-1 text-[9.5px]"
                style={{ color: "var(--color-text-faint)" }}
              >
                {hover.p.category}
              </div>
            </div>
          )}
        </div>

        {/* Detail panel */}
        <aside
          className="w-[320px] shrink-0 overflow-auto border-l px-4 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          {selected ? (
            <div>
              <div
                className="text-[10px] font-medium uppercase tracking-[0.06em]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {selected.category}
              </div>
              <h3 className="mt-1 break-words text-[14px] font-semibold leading-snug">
                {selected.title}
              </h3>
              <div
                className="mt-1 text-[10.5px]"
                style={{ color: "var(--color-text-faint)" }}
              >
                {selected.timestamp}
              </div>
              <p
                className="mt-3 whitespace-pre-wrap text-[11.5px] leading-relaxed"
                style={{ color: "var(--color-text-secondary)" }}
              >
                {selected.snippet || "(no snippet)"}
              </p>
              {selected.path && (
                <>
                  <div
                    className="mt-3 break-all text-[10px]"
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--color-text-faint)",
                    }}
                    title={selected.path}
                  >
                    {selected.path}
                  </div>
                  <button
                    type="button"
                    onClick={openSelectedFile}
                    className="mt-3 rounded px-3 py-1.5 text-[11.5px] font-medium transition-colors"
                    style={{
                      background: "var(--color-accent)",
                      color: "var(--color-accent-text)",
                    }}
                  >
                    Open file
                  </button>
                </>
              )}
            </div>
          ) : (
            <div
              className="text-[12px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Click a point to see its details. Hover for a quick preview.
            </div>
          )}
        </aside>
      </div>

      {/* Legend */}
      <div
        className="shrink-0 border-t px-4 py-2"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div
          className="mb-1 text-[10px] font-medium uppercase tracking-[0.06em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Categories
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {categories.map((c, i) => {
            const active = categoryFilter === c;
            return (
              <button
                key={c}
                type="button"
                onClick={() => setCategoryFilter(active ? null : c)}
                className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] transition-colors"
                style={{
                  background: active ? "var(--color-surface-3)" : "transparent",
                  color: active
                    ? "var(--color-text)"
                    : "var(--color-text-secondary)",
                  border: `1px solid ${active ? "var(--color-border-strong)" : "transparent"}`,
                }}
                title={`${counts[i]} points in '${c}'`}
              >
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: colorFor(c, categories) }}
                />
                <span>{c}</span>
                <span
                  className="tabular-nums"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {counts[i]}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
