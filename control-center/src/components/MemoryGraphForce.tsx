import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";

// Obsidian-style force-directed memory graph.
//
// Replaces the hash-based pseudo-UMAP scatter. Each node is a note from
// the vault corpus, edges are wikilinks (or tag-similarity if the vault
// has zero wikilinks — surfaced as a banner so the user knows).
//
// Physics: simple Verlet integration in pure JS, no D3. 200 pre-render
// frames before the SVG mounts so the layout settles before the user
// sees it. Drag to nudge a node, hover for tooltip, click for side
// panel + "Open file".

// ---------------------------------------------------------------------------
// Types — keep in sync with memory_highlights.rs::GraphNode/GraphEdge
// ---------------------------------------------------------------------------

type GraphNode = {
  id: string;
  title: string;
  path: string;
  category: string | null;
  tags: string[];
  size_bytes: number;
  last_modified: string | null;
  snippet: string;
  inbound: number;
  outbound: number;
};

type GraphEdge = {
  source: string;
  target: string;
  kind: "wikilink" | "tag" | string;
  weight: number;
};

type MemoryLinkGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  edge_source: "wikilinks" | "tags" | string;
  computed_at: string;
};

// ---------------------------------------------------------------------------
// Palette — 8 perceivable hues without the generic-tech blue.
// Mirrors the doctrine in the legacy MemoryGraph (Mike Tyson palette).
// ---------------------------------------------------------------------------

const PALETTE: string[] = [
  "var(--color-success)",
  "var(--color-warn)",
  "var(--color-danger)",
  "#a371f7",
  "#79c0ff",
  "#ffa657",
  "#f778ba",
  "#56d4dd",
];

function colorFor(key: string, keys: string[]): string {
  const i = keys.indexOf(key);
  if (i < 0) return "var(--color-text-tertiary)";
  return PALETTE[i % PALETTE.length];
}

// ---------------------------------------------------------------------------
// Physics state — held outside React state to avoid re-render churn.
// We only re-render when positions change in animation frames.
// ---------------------------------------------------------------------------

type Particle = {
  id: string;
  x: number;
  y: number;
  px: number; // previous-frame position for Verlet
  py: number;
  ax: number; // accumulated force
  ay: number;
  fixed: boolean; // user-pinned via drag
};

const VIEW = 1000;
const CENTER = VIEW / 2;
const NODE_RADIUS_BASE = 9; // bumped from 4 — bigger nodes, easier to click
const REPULSION = 500; // pairwise repulsion (reduced from 900 — denser, less explosive)
const SPRING_K = 0.04; // edge spring stiffness
const SPRING_REST = 80; // resting edge length
const GRAVITY = 0.015; // looser pull to center (was 0.03 — let cluster breathe)
const DAMPING = 0.6; // velocity retention per frame
const COLLIDE_RADIUS = 18; // grew with NODE_RADIUS_BASE so overlap stays sane
const COLLIDE_STRENGTH = 0.5;
const PRE_FRAMES = 320; // higher pre-render so the SVG mounts already settled
const MAX_RENDER_NODES = 200; // cap client-side; backend may still send more
const ALPHA_DECAY = 0.985; // multiplicative cooling on per-step force scale
const ALPHA_MIN = 0.01; // below this we freeze physics (alpha=0)
const MOTION_IDLE_THRESHOLD = 4.0; // per-frame total squared motion below this → idle
const IDLE_FRAMES_TO_STOP = 12;

function step(
  particles: Particle[],
  edges: GraphEdge[],
  idIndex: Map<string, number>,
  alpha: number,
) {
  const n = particles.length;
  if (alpha <= 0) return; // physics frozen — no force accumulation
  // Reset accumulated forces.
  for (const p of particles) {
    p.ax = 0;
    p.ay = 0;
  }
  // Pairwise repulsion (Coulomb-style). O(n^2). Capped at 200 nodes via
  // the backend selection so this stays under 40k pair-ops/frame.
  for (let i = 0; i < n; i++) {
    const a = particles[i];
    for (let j = i + 1; j < n; j++) {
      const b = particles[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 4) {
        // Jitter when two particles are on top of each other so they
        // can escape the singularity.
        dx = Math.random() - 0.5;
        dy = Math.random() - 0.5;
        d2 = dx * dx + dy * dy + 0.01;
      }
      const inv = 1 / d2;
      const fx = dx * inv * REPULSION * alpha;
      const fy = dy * inv * REPULSION * alpha;
      a.ax += fx;
      a.ay += fy;
      b.ax -= fx;
      b.ay -= fy;

      // Soft collision — push apart if closer than COLLIDE_RADIUS.
      const d = Math.sqrt(d2);
      if (d < COLLIDE_RADIUS) {
        const overlap = (COLLIDE_RADIUS - d) * COLLIDE_STRENGTH;
        const ux = dx / (d || 1);
        const uy = dy / (d || 1);
        a.ax += ux * overlap;
        a.ay += uy * overlap;
        b.ax -= ux * overlap;
        b.ay -= uy * overlap;
      }
    }
  }
  // Spring force along edges.
  for (const e of edges) {
    const i = idIndex.get(e.source);
    const j = idIndex.get(e.target);
    if (i === undefined || j === undefined) continue;
    const a = particles[i];
    const b = particles[j];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const stretch = d - SPRING_REST;
    const fx = (dx / d) * stretch * SPRING_K * (0.6 + e.weight * 0.6) * alpha;
    const fy = (dy / d) * stretch * SPRING_K * (0.6 + e.weight * 0.6) * alpha;
    a.ax += fx;
    a.ay += fy;
    b.ax -= fx;
    b.ay -= fy;
  }
  // Gravity to center.
  for (const p of particles) {
    p.ax += (CENTER - p.x) * GRAVITY * alpha;
    p.ay += (CENTER - p.y) * GRAVITY * alpha;
  }
  // Verlet integration with damping.
  for (const p of particles) {
    if (p.fixed) {
      p.px = p.x;
      p.py = p.y;
      continue;
    }
    const vx = (p.x - p.px) * DAMPING;
    const vy = (p.y - p.py) * DAMPING;
    p.px = p.x;
    p.py = p.y;
    p.x += vx + p.ax;
    p.y += vy + p.ay;
    // Box clamp so nodes don't fly off the SVG.
    if (p.x < 20) p.x = 20;
    if (p.x > VIEW - 20) p.x = VIEW - 20;
    if (p.y < 20) p.y = 20;
    if (p.y > VIEW - 20) p.y = VIEW - 20;
  }
}

function initParticles(nodes: GraphNode[]): Particle[] {
  // Seed positions deterministically (hash of id) so repeat opens give
  // the same starting layout — feels stable across refreshes.
  return nodes.map((n) => {
    let seed = 0;
    for (let i = 0; i < n.id.length; i++) seed = (seed * 31 + n.id.charCodeAt(i)) >>> 0;
    const rx = ((seed & 0xffff) / 0xffff) * (VIEW - 200) + 100;
    const ry = (((seed >>> 16) & 0xffff) / 0xffff) * (VIEW - 200) + 100;
    return { id: n.id, x: rx, y: ry, px: rx, py: ry, ax: 0, ay: 0, fixed: false };
  });
}

// ---------------------------------------------------------------------------
// React component
// ---------------------------------------------------------------------------

type Props = {
  /** External id to focus / select (drives the selection ring + pan-to). */
  selectedId?: string | null;
  /** Called when the user clicks a node — lets the parent pull details. */
  onSelect?: (n: GraphNode | null) => void;
  /** If true, hide the internal right-side detail aside (parent owns it). */
  hideAside?: boolean;
  /** If true, hide the bottom legend (compact embed mode). */
  hideLegend?: boolean;
};

export function MemoryGraphForce({
  selectedId,
  onSelect,
  hideAside,
  hideLegend,
}: Props = {}) {
  const [graph, setGraph] = useState<MemoryLinkGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [internalSelected, setInternalSelected] = useState<GraphNode | null>(null);
  const [hover, setHover] = useState<{
    node: GraphNode;
    sx: number;
    sy: number;
  } | null>(null);
  const [, forceRender] = useState(0);

  // Zoom + pan transform applied to the inner <g> element.
  // SVG coords transform = translate(tx, ty) scale(scale).
  // We keep this in a ref so wheel/drag don't trigger re-renders by
  // themselves; we manually forceRender to keep the loop visible.
  const transformRef = useRef<{ scale: number; tx: number; ty: number }>({
    scale: 1,
    tx: 0,
    ty: 0,
  });
  const panRef = useRef<{
    startClientX: number;
    startClientY: number;
    startTx: number;
    startTy: number;
  } | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const particlesRef = useRef<Particle[]>([]);
  const idIndexRef = useRef<Map<string, number>>(new Map());
  const rafRef = useRef<number | null>(null);
  const draggingRef = useRef<{ idx: number; offsetX: number; offsetY: number } | null>(null);
  const alphaRef = useRef<number>(1);

  // Resolved selected node: prefer parent-driven selectedId, fall back to
  // internal state so the component still works standalone.
  const selected: GraphNode | null = (() => {
    if (selectedId && graph) {
      return graph.nodes.find((n) => n.id === selectedId) ?? null;
    }
    return internalSelected;
  })();

  function pickSelected(n: GraphNode | null) {
    setInternalSelected(n);
    onSelect?.(n);
  }

  // Load graph on mount.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<MemoryLinkGraph>("compute_memory_link_graph")
      .then((g) => {
        if (cancelled) return;
        // Client-side cap: keep top-N highest-degree nodes so the
        // simulation stays stable on huge vaults (backend may evolve).
        if (g.nodes.length > MAX_RENDER_NODES) {
          const sorted = [...g.nodes].sort(
            (a, b) => b.inbound + b.outbound - (a.inbound + a.outbound),
          );
          const keep = new Set(
            sorted.slice(0, MAX_RENDER_NODES).map((n) => n.id),
          );
          g = {
            ...g,
            nodes: g.nodes.filter((n) => keep.has(n.id)),
            edges: g.edges.filter(
              (e) => keep.has(e.source) && keep.has(e.target),
            ),
          };
        }
        setGraph(g);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Initialise physics + pre-render PRE_FRAMES once graph arrives.
  // We pre-render with a cooling alpha so the layout converges and the
  // SVG mounts visually stable — no more "balls flying around".
  useEffect(() => {
    if (!graph) return;
    const parts = initParticles(graph.nodes);
    const idx = new Map<string, number>();
    parts.forEach((p, i) => idx.set(p.id, i));
    particlesRef.current = parts;
    idIndexRef.current = idx;
    let a = 1;
    for (let f = 0; f < PRE_FRAMES; f++) {
      step(parts, graph.edges, idx, a);
      a *= ALPHA_DECAY;
      if (a < ALPHA_MIN) {
        a = 0;
        break;
      }
    }
    // Post-pre-render: physics is essentially cold. Live tick will only
    // wake up if the user drags a node.
    alphaRef.current = a;
    forceRender((n) => n + 1);
  }, [graph]);

  // Continuous animation loop — gentle ongoing settle so dragging
  // interacts naturally. Stops itself once the simulation cools below
  // ALPHA_MIN (or motion is negligible for IDLE_FRAMES_TO_STOP frames).
  useEffect(() => {
    if (!graph) return;
    let idleFrames = 0;
    const tick = () => {
      const parts = particlesRef.current;
      const edges = graph.edges;
      const idx = idIndexRef.current;
      const alpha = alphaRef.current;
      if (alpha <= 0) {
        rafRef.current = null;
        return;
      }
      let totalMotion = 0;
      const before = parts.map((p) => [p.x, p.y] as [number, number]);
      step(parts, edges, idx, alpha);
      for (let i = 0; i < parts.length; i++) {
        const dx = parts[i].x - before[i][0];
        const dy = parts[i].y - before[i][1];
        totalMotion += dx * dx + dy * dy;
      }
      if (totalMotion < MOTION_IDLE_THRESHOLD) idleFrames++;
      else idleFrames = 0;

      // Cool the simulation each frame so it can't run forever.
      alphaRef.current = alpha * ALPHA_DECAY;
      if (alphaRef.current < ALPHA_MIN) alphaRef.current = 0;

      forceRender((n) => n + 1);
      if (idleFrames < IDLE_FRAMES_TO_STOP && alphaRef.current > 0) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [graph]);

  // Restart animation when the user drags (re-heat the simulation).
  function bumpAnimation() {
    if (!graph) return;
    // Re-heat: a small kick so the dragged node's neighbours respond,
    // but not full alpha=1 (that would re-explode the layout).
    alphaRef.current = Math.max(alphaRef.current, 0.3);
    if (rafRef.current !== null) return;
    const tick = () => {
      const parts = particlesRef.current;
      const alpha = alphaRef.current;
      if (alpha <= 0) {
        rafRef.current = null;
        return;
      }
      step(parts, graph.edges, idIndexRef.current, alpha);
      alphaRef.current = alpha * ALPHA_DECAY;
      if (alphaRef.current < ALPHA_MIN) alphaRef.current = 0;
      forceRender((n) => n + 1);
      if (alphaRef.current > 0) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  // Distinct categories sorted by frequency for the legend.
  const { catKeys, catCounts } = useMemo(() => {
    const c = new Map<string, number>();
    for (const n of graph?.nodes ?? []) {
      const key = n.category ?? n.tags[0] ?? "(uncat.)";
      c.set(key, (c.get(key) ?? 0) + 1);
    }
    const arr = [...c.entries()].sort((a, b) => b[1] - a[1]);
    return {
      catKeys: arr.map(([k]) => k),
      catCounts: arr.map(([, v]) => v),
    };
  }, [graph]);

  function nodeColor(n: GraphNode): string {
    const key = n.category ?? n.tags[0] ?? "(uncat.)";
    return colorFor(key, catKeys);
  }

  // Filter — substring match on title (case-insensitive).
  const visibleSet = useMemo(() => {
    if (!graph) return new Set<string>();
    if (!filter.trim()) return new Set(graph.nodes.map((n) => n.id));
    const f = filter.trim().toLowerCase();
    return new Set(
      graph.nodes
        .filter((n) => n.title.toLowerCase().includes(f))
        .map((n) => n.id),
    );
  }, [graph, filter]);

  // -------------------------------------------------------------------------
  // Mouse handlers — drag, hover, click
  // -------------------------------------------------------------------------

  // Convert a client (px) event point into the simulation/world coord
  // space, undoing the current transform so node-drag matches the
  // cursor even when the user has zoomed or panned.
  function svgPoint(e: { clientX: number; clientY: number }): {
    x: number;
    y: number;
  } {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const sx = ((e.clientX - rect.left) / rect.width) * VIEW;
    const sy = ((e.clientY - rect.top) / rect.height) * VIEW;
    const { scale, tx, ty } = transformRef.current;
    return { x: (sx - tx) / scale, y: (sy - ty) / scale };
  }

  // Wheel = zoom around the cursor. Holding ctrl/cmd accelerates.
  function onWheel(e: React.WheelEvent<SVGSVGElement>) {
    e.preventDefault();
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Cursor in svg viewBox coords (pre-transform).
    const cx = ((e.clientX - rect.left) / rect.width) * VIEW;
    const cy = ((e.clientY - rect.top) / rect.height) * VIEW;
    const t = transformRef.current;
    // World coord under cursor before zoom.
    const wx = (cx - t.tx) / t.scale;
    const wy = (cy - t.ty) / t.scale;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.max(0.25, Math.min(4, t.scale * factor));
    // Solve so the world point stays anchored under the cursor.
    t.tx = cx - wx * next;
    t.ty = cy - wy * next;
    t.scale = next;
    forceRender((n) => n + 1);
  }

  // Background drag = pan. Node-drag is intercepted earlier by the
  // circle's own pointerdown so we won't conflict.
  function onBackgroundPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    // Only react to primary button on the svg background (not on a node).
    if (e.button !== 0) return;
    const target = e.target as Element;
    if (target.tagName !== "svg" && target.tagName !== "rect") return;
    (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
    const t = transformRef.current;
    panRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startTx: t.tx,
      startTy: t.ty,
    };
  }

  function onBackgroundPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!panRef.current) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const dxClient = e.clientX - panRef.current.startClientX;
    const dyClient = e.clientY - panRef.current.startClientY;
    // Convert px delta to viewBox delta.
    const dx = (dxClient / rect.width) * VIEW;
    const dy = (dyClient / rect.height) * VIEW;
    transformRef.current.tx = panRef.current.startTx + dx;
    transformRef.current.ty = panRef.current.startTy + dy;
    forceRender((n) => n + 1);
  }

  function onBackgroundPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    if (!panRef.current) return;
    try {
      (e.currentTarget as SVGSVGElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    panRef.current = null;
  }

  function resetView() {
    transformRef.current = { scale: 1, tx: 0, ty: 0 };
    forceRender((n) => n + 1);
  }

  // When the parent changes selectedId (e.g. user clicked a Highlights
  // row in the sidebar), pan the view so the selected node is visible.
  useEffect(() => {
    if (!selectedId || !graph) return;
    const idx = idIndexRef.current.get(selectedId);
    if (idx === undefined) return;
    const p = particlesRef.current[idx];
    if (!p) return;
    const t = transformRef.current;
    // Center the node in the viewBox while keeping current scale.
    t.tx = CENTER - p.x * t.scale;
    t.ty = CENTER - p.y * t.scale;
    forceRender((n) => n + 1);
  }, [selectedId, graph]);

  function onNodePointerDown(
    e: React.PointerEvent<SVGCircleElement>,
    nodeId: string,
  ) {
    const idx = idIndexRef.current.get(nodeId);
    if (idx === undefined) return;
    (e.target as SVGCircleElement).setPointerCapture(e.pointerId);
    const pt = svgPoint(e);
    const p = particlesRef.current[idx];
    draggingRef.current = {
      idx,
      offsetX: pt.x - p.x,
      offsetY: pt.y - p.y,
    };
    p.fixed = true;
    bumpAnimation();
  }

  function onNodePointerMove(e: React.PointerEvent<SVGCircleElement>) {
    if (!draggingRef.current) return;
    const pt = svgPoint(e);
    const { idx, offsetX, offsetY } = draggingRef.current;
    const p = particlesRef.current[idx];
    p.x = pt.x - offsetX;
    p.y = pt.y - offsetY;
    p.px = p.x;
    p.py = p.y;
    forceRender((n) => n + 1);
  }

  function onNodePointerUp(e: React.PointerEvent<SVGCircleElement>) {
    if (!draggingRef.current) return;
    try {
      (e.target as SVGCircleElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const { idx } = draggingRef.current;
    particlesRef.current[idx].fixed = false;
    draggingRef.current = null;
    bumpAnimation();
  }

  function onNodeEnter(e: React.MouseEvent<SVGCircleElement>, n: GraphNode) {
    const rect = svgRef.current?.getBoundingClientRect();
    setHover({
      node: n,
      sx: rect ? e.clientX - rect.left : e.clientX,
      sy: rect ? e.clientY - rect.top : e.clientY,
    });
  }

  function openSelected() {
    if (!selected?.path) return;
    openPath(selected.path).catch((e) => setError(String(e)));
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const parts = particlesRef.current;
  const idIdx = idIndexRef.current;

  return (
    <div className="flex h-full min-h-[500px] flex-col">
      {/* Top bar — filter + status banner */}
      <div
        className="flex shrink-0 items-center gap-3 border-b px-4 py-2"
        style={{ borderColor: "var(--color-border)" }}
      >
        <span
          className="text-[10px] font-medium uppercase tracking-[0.06em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Filter
        </span>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Substring match on title..."
          className="w-[260px] rounded px-2 py-1 text-[12px]"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
            outline: "none",
          }}
        />
        <button
          type="button"
          onClick={resetView}
          className="rounded px-2 py-1 text-[10.5px] transition-colors"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border-strong)",
          }}
          title="Reset zoom + pan"
        >
          Reset view
        </button>
        {graph && graph.edge_source === "tags" && (
          <div
            className="rounded px-2 py-1 text-[10.5px]"
            style={{
              background: "rgba(210, 153, 34, 0.08)",
              border: "1px solid rgba(210, 153, 34, 0.28)",
              color: "var(--color-warn)",
            }}
            title="No [[wikilinks]] found in vault — graph uses tag similarity (Jaccard) as a fallback."
          >
            Fallback: tag-similarity edges
          </div>
        )}
        <div
          className="ml-auto text-[11px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {loading
            ? "Loading..."
            : graph
              ? `${graph.nodes.length} nodes · ${graph.edges.length} edges`
              : ""}
        </div>
      </div>

      {/* Canvas + side panel */}
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
          {!error && graph && (
            <svg
              ref={svgRef}
              viewBox={`0 0 ${VIEW} ${VIEW}`}
              preserveAspectRatio="xMidYMid meet"
              className="block h-full w-full"
              style={{
                background: "var(--color-bg)",
                cursor: panRef.current ? "grabbing" : "grab",
                touchAction: "none",
              }}
              onMouseLeave={() => setHover(null)}
              onWheel={onWheel}
              onPointerDown={onBackgroundPointerDown}
              onPointerMove={onBackgroundPointerMove}
              onPointerUp={onBackgroundPointerUp}
            >
              {/* Invisible capture rect so background drag has a hit target
                  on empty regions (between nodes). */}
              <rect
                x={0}
                y={0}
                width={VIEW}
                height={VIEW}
                fill="transparent"
              />
              <g
                transform={`translate(${transformRef.current.tx} ${transformRef.current.ty}) scale(${transformRef.current.scale})`}
              >
              {/* Edges */}
              <g>
                {graph.edges.map((e, i) => {
                  const si = idIdx.get(e.source);
                  const ti = idIdx.get(e.target);
                  if (si === undefined || ti === undefined) return null;
                  const a = parts[si];
                  const b = parts[ti];
                  if (!a || !b) return null;
                  const visible = visibleSet.has(e.source) && visibleSet.has(e.target);
                  const strokeColor =
                    e.kind === "wikilink"
                      ? "var(--color-text-faint)"
                      : "var(--color-border-strong)";
                  return (
                    <line
                      key={`e${i}`}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke={strokeColor}
                      strokeOpacity={visible ? (e.kind === "wikilink" ? 0.55 : 0.28) : 0.06}
                      strokeWidth={e.kind === "wikilink" ? 1.0 : 0.6}
                    />
                  );
                })}
              </g>

              {/* Nodes */}
              <g>
                {graph.nodes.map((n) => {
                  const i = idIdx.get(n.id);
                  if (i === undefined) return null;
                  const p = parts[i];
                  if (!p) return null;
                  const r =
                    NODE_RADIUS_BASE +
                    Math.min(8, Math.sqrt(n.inbound + n.outbound) * 1.8);
                  const isSel = selected?.id === n.id;
                  const isVis = visibleSet.has(n.id);
                  const fill = nodeColor(n);
                  return (
                    <g key={n.id}>
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={isSel ? r + 2 : r}
                        fill={fill}
                        fillOpacity={isVis ? (isSel ? 1 : 0.85) : 0.12}
                        stroke={isSel ? "var(--color-text)" : "rgba(0,0,0,0.55)"}
                        strokeWidth={isSel ? 1.5 : 0.4}
                        style={{ cursor: "pointer" }}
                        onMouseEnter={(e) => onNodeEnter(e, n)}
                        onMouseMove={(e) => onNodeEnter(e, n)}
                        onClick={() => pickSelected(n)}
                        onPointerDown={(e) => onNodePointerDown(e, n.id)}
                        onPointerMove={onNodePointerMove}
                        onPointerUp={onNodePointerUp}
                      >
                        <title>{n.title}</title>
                      </circle>
                      {/* Label — only render for nodes with edges so we
                          don't clutter the canvas with hundreds of
                          orphan labels. */}
                      {(n.inbound + n.outbound > 0 || isSel) && isVis && (
                        <text
                          x={p.x + r + 3}
                          y={p.y + 3}
                          fontSize={9}
                          fill="var(--color-text-secondary)"
                          style={{ pointerEvents: "none", userSelect: "none" }}
                        >
                          {n.title.length > 28
                            ? n.title.slice(0, 28) + "..."
                            : n.title}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
              </g>
            </svg>
          )}

          {hover && (
            <div
              className="pointer-events-none absolute rounded px-2 py-1.5"
              style={{
                left: Math.min(hover.sx + 14, 720),
                top: Math.max(hover.sy - 10, 8),
                background: "var(--color-surface-1)",
                border: "1px solid var(--color-border-strong)",
                maxWidth: 340,
                zIndex: 10,
                boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
              }}
            >
              <div
                className="truncate text-[11.5px] font-medium"
                style={{ color: "var(--color-text)" }}
              >
                {hover.node.title}
              </div>
              <div
                className="mt-0.5 text-[10px]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                in {hover.node.inbound} · out {hover.node.outbound}
                {hover.node.category && <> · {hover.node.category}</>}
              </div>
              {hover.node.snippet && (
                <div
                  className="mt-1 text-[10.5px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {hover.node.snippet.slice(0, 80)}
                  {hover.node.snippet.length > 80 ? "..." : ""}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Detail panel — hidden when the parent owns the sidebar
            (Memory.tsx unified layout). */}
        {!hideAside && (
        <aside
          className="w-[340px] shrink-0 overflow-auto border-l px-4 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          {selected ? (
            <div>
              {selected.category && (
                <div
                  className="text-[10px] font-medium uppercase tracking-[0.06em]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {selected.category}
                </div>
              )}
              <h3 className="mt-1 break-words text-[14px] font-semibold leading-snug">
                {selected.title}
              </h3>
              <div
                className="mt-1 text-[10.5px]"
                style={{ color: "var(--color-text-faint)" }}
              >
                in {selected.inbound} · out {selected.outbound}
                {selected.last_modified && <> · {selected.last_modified}</>}
              </div>
              {selected.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {selected.tags.slice(0, 12).map((t) => (
                    <span
                      key={t}
                      className="rounded px-1.5 py-0.5 text-[9.5px]"
                      style={{
                        background: "var(--color-surface-3)",
                        color: "var(--color-text-secondary)",
                      }}
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <p
                className="mt-3 whitespace-pre-wrap text-[11.5px] leading-relaxed"
                style={{ color: "var(--color-text-secondary)" }}
              >
                {selected.snippet || "(no snippet)"}
              </p>
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
                onClick={openSelected}
                className="mt-3 rounded px-3 py-1.5 text-[11.5px] font-medium transition-colors"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                Open file
              </button>
            </div>
          ) : (
            <div
              className="text-[12px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Click a node to see its details. Drag to nudge a node. Hover for
              a quick preview.
            </div>
          )}
        </aside>
        )}
      </div>

      {/* Legend */}
      {!hideLegend && (
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
          {catKeys.slice(0, 16).map((k, i) => (
            <div
              key={k}
              className="flex items-center gap-1.5 text-[11px]"
              style={{ color: "var(--color-text-secondary)" }}
              title={`${catCounts[i]} notes`}
            >
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: colorFor(k, catKeys) }}
              />
              <span>{k}</span>
              <span
                className="tabular-nums"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {catCounts[i]}
              </span>
            </div>
          ))}
        </div>
      </div>
      )}
    </div>
  );
}
