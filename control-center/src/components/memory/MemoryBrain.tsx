// ULTRON Control Center 2.x — Memory Brain visualization (2026-05-27)
//
// Renders the local knowledge graph (`~/.ultron/cockpit/kg.jsonl`) as a
// radial SVG map. Nodes are grouped onto concentric rings by entityType so
// the user gets a "global brain" view of every concept the system knows.
//
// Design constraints (per spec):
//   - No new dependencies — only SVG + plain React state.
//   - No physics simulation; positions are computed deterministically in JS.
//   - Reuse existing `kg_read_graph` Tauri command. No direct fs access.
//   - Theming via existing CSS vars only (no hardcoded hex colors).
//   - <=800 LOC, single file.
//
// Collision-avoidance additions (KIRKARDO 18, 2026-05-27):
//   - Sub-rings: if >MAX_PER_RING nodes in a type-ring, overflow onto r+60, r+120, …
//   - Top-N cap: show at most MAX_NODES_PER_TYPE per entity_type (sorted by degree).
//     A "+N more" badge is rendered at the ring label position.
//   - Jitter: each node gets a ±5 px radial perturbation (seeded by name hash)
//     so equal-degree nodes no longer overlap exactly.
//   - A11y: every node `<g>` is role="button" with tabIndex + aria-label +
//     keyboard activation + visible focus outline.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types — mirror crate::kg::{KgEntity, KgRelation, KgGraph}
// ---------------------------------------------------------------------------

interface KgEntity {
  name: string;
  entity_type: string;
  observations: string[];
}

interface KgRelation {
  from: string;
  to: string;
  relation_type: string;
}

interface KgGraph {
  entities: KgEntity[];
  relations: KgRelation[];
}

interface PositionedNode {
  entity: KgEntity;
  x: number;
  y: number;
  /** Logical ring index (one per distinct entity_type, sorted alpha). */
  ring: number;
  /** Sub-ring index within the type-ring (0 = primary, 1 = secondary, …). */
  subRing: number;
  /** Cached degree (# of relations touching this node). */
  degree: number;
  /** Whether this node was clipped by the top-N cap. */
  hidden: boolean;
}

/** Summary of hidden nodes per entity_type. */
interface HiddenBadge {
  type: string;
  hiddenCount: number;
  /** SVG y-coordinate to paint the badge above the primary ring label. */
  labelY: number;
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const VIEWBOX = 1000;
const CENTER = VIEWBOX / 2;
const BASE_RING_RADIUS = 110;
const RING_STEP = 130;
const SUB_RING_GAP = 60; // px between sub-rings within the same type-ring
const MIN_NODE_RADIUS = 6;
const MAX_NODE_RADIUS = 18;

/** Maximum nodes placed on a single radius before overflow to sub-ring. */
export const MAX_PER_RING = 60;

/** Maximum total nodes rendered per entity_type (excess hidden + badged). */
export const MAX_NODES_PER_TYPE = 200;

/** Total radial jitter amplitude in pixels. */
const JITTER_AMPLITUDE = 5;

// ---------------------------------------------------------------------------
// Pure layout helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Cheap deterministic hash of a string in [0, 1).
 * Used to generate per-name jitter so equal-degree nodes don't coincide.
 */
export function nameJitter(name: string): number {
  let h = 2166136261; // FNV-1a offset basis (32-bit)
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = (Math.imul(h, 16777619) >>> 0); // FNV prime, keep unsigned 32-bit
  }
  // Map to [-JITTER_AMPLITUDE, +JITTER_AMPLITUDE]
  const normalized = (h / 0xffffffff) * 2 - 1;
  return normalized * JITTER_AMPLITUDE;
}

/**
 * Distribute `entities` across sub-rings when the count exceeds MAX_PER_RING.
 * Returns an array of { entity, subRingIdx, radius } tuples.
 *
 * The primary ring carries the first MAX_PER_RING items (highest degree),
 * the secondary ring the next MAX_PER_RING, etc.
 *
 * Entities must already be sorted by descending degree before calling this.
 */
export function assignSubRings(
  entities: KgEntity[],
  primaryRadius: number,
): Array<{ entity: KgEntity; subRingIdx: number; radius: number }> {
  return entities.map((entity, i) => {
    const subRingIdx = Math.floor(i / MAX_PER_RING);
    const radius = primaryRadius + subRingIdx * SUB_RING_GAP;
    return { entity, subRingIdx, radius };
  });
}

/**
 * Deterministically position every entity around concentric rings keyed by
 * `entity_type`. Types are sorted alphabetically so the layout is stable
 * across reloads.
 *
 * Overflow mitigation layers applied here:
 *   1. Top-N cap per type (MAX_NODES_PER_TYPE).
 *   2. Sub-rings when ring count exceeds MAX_PER_RING.
 *   3. Radial jitter (±JITTER_AMPLITUDE px) to prevent exact overlap.
 *
 * The base angular algorithm is unchanged: angle = (i / count) * 2π.
 */
export function computeLayout(graph: KgGraph): {
  nodes: PositionedNode[];
  byName: Map<string, PositionedNode>;
  ringRadius: Map<string, number>;
  hiddenBadges: HiddenBadge[];
} {
  const byType = new Map<string, KgEntity[]>();
  for (const ent of graph.entities) {
    const key = ent.entity_type || "entity";
    const bucket = byType.get(key) ?? [];
    bucket.push(ent);
    byType.set(key, bucket);
  }

  const sortedTypes = [...byType.keys()].sort();

  // Degree map — # of relations touching each entity.
  const degreeMap = new Map<string, number>();
  for (const rel of graph.relations) {
    degreeMap.set(rel.from, (degreeMap.get(rel.from) ?? 0) + 1);
    degreeMap.set(rel.to, (degreeMap.get(rel.to) ?? 0) + 1);
  }

  const nodes: PositionedNode[] = [];
  const byName = new Map<string, PositionedNode>();
  const ringRadius = new Map<string, number>();
  const hiddenBadges: HiddenBadge[] = [];

  sortedTypes.forEach((type, ringIdx) => {
    const primaryRadius = BASE_RING_RADIUS + ringIdx * RING_STEP;
    ringRadius.set(type, primaryRadius);

    // Sort descending by degree so highest-degree nodes land on the primary ring.
    const allBucket = [...(byType.get(type) ?? [])].sort((a, b) => {
      const diff = (degreeMap.get(b.name) ?? 0) - (degreeMap.get(a.name) ?? 0);
      // Tie-break alphabetically for determinism.
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });

    // --- Top-N cap ---
    const hiddenCount = Math.max(0, allBucket.length - MAX_NODES_PER_TYPE);
    const visibleBucket = allBucket.slice(0, MAX_NODES_PER_TYPE);

    if (hiddenCount > 0) {
      hiddenBadges.push({
        type,
        hiddenCount,
        labelY: CENTER - primaryRadius - 6,
      });
    }

    // --- Sub-ring assignment ---
    const assigned = assignSubRings(visibleBucket, primaryRadius);

    // Group by sub-ring so we can compute angles per sub-ring independently.
    const subRingGroups = new Map<number, typeof assigned>();
    for (const item of assigned) {
      const group = subRingGroups.get(item.subRingIdx) ?? [];
      group.push(item);
      subRingGroups.set(item.subRingIdx, group);
    }

    for (const [subRingIdx, group] of subRingGroups) {
      const { radius } = group[0]!;
      group.forEach((item, i) => {
        // Base angular algorithm — UNCHANGED.
        const angle = (i / Math.max(group.length, 1)) * Math.PI * 2;
        const jitter = nameJitter(item.entity.name);
        const effectiveRadius = radius + jitter;

        const node: PositionedNode = {
          entity: item.entity,
          x: CENTER + Math.cos(angle) * effectiveRadius,
          y: CENTER + Math.sin(angle) * effectiveRadius,
          ring: ringIdx,
          subRing: subRingIdx,
          degree: degreeMap.get(item.entity.name) ?? 0,
          hidden: false,
        };
        nodes.push(node);
        byName.set(item.entity.name, node);
      });
    }
  });

  return { nodes, byName, ringRadius, hiddenBadges };
}

/**
 * Map a degree to a node radius — high-degree nodes look larger so the
 * visual hierarchy reflects "central" concepts in the brain.
 */
export function nodeRadiusFor(degree: number, maxDegree: number): number {
  if (maxDegree <= 0) return MIN_NODE_RADIUS + 2;
  const t = Math.min(degree / maxDegree, 1);
  return MIN_NODE_RADIUS + (MAX_NODE_RADIUS - MIN_NODE_RADIUS) * t;
}

// Cycle through a small palette of CSS-var driven colors per ring.
const RING_COLORS = [
  "var(--color-accent)",
  "var(--color-success)",
  "var(--color-warn)",
  "var(--color-text-secondary)",
  "var(--color-text-tertiary)",
] as const;

function ringColor(ring: number): string {
  return RING_COLORS[ring % RING_COLORS.length] ?? RING_COLORS[0];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface MemoryBrainProps {
  /** Override onSelect for testing (optional). */
  onSelect?: (name: string | null) => void;
}

export function MemoryBrain({ onSelect }: MemoryBrainProps = {}) {
  const [graph, setGraph] = useState<KgGraph>({
    entities: [],
    relations: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    text: string;
    nodeId: string;
  } | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const g = (await invoke("kg_read_graph")) as KgGraph;
      setGraph(g);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const { nodes, byName, ringRadius, hiddenBadges } = useMemo(
    () => computeLayout(graph),
    [graph],
  );

  const maxDegree = useMemo(
    () => nodes.reduce((m, n) => Math.max(m, n.degree), 0),
    [nodes],
  );

  // Filter — case-insensitive substring across name/type/observations.
  const matchedNames = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return null;
    const matches = new Set<string>();
    for (const n of nodes) {
      const ent = n.entity;
      if (
        ent.name.toLowerCase().includes(needle) ||
        ent.entity_type.toLowerCase().includes(needle) ||
        ent.observations.some((o) => o.toLowerCase().includes(needle))
      ) {
        matches.add(ent.name);
      }
    }
    return matches;
  }, [nodes, filter]);

  const isDimmed = useCallback(
    (name: string) => matchedNames !== null && !matchedNames.has(name),
    [matchedNames],
  );

  const focusName = hovered ?? selected;
  const focusedNeighbors = useMemo(() => {
    if (!focusName) return new Set<string>();
    const out = new Set<string>();
    for (const rel of graph.relations) {
      if (rel.from === focusName) out.add(rel.to);
      if (rel.to === focusName) out.add(rel.from);
    }
    return out;
  }, [graph.relations, focusName]);

  const selectedEntity = useMemo(
    () => (selected ? graph.entities.find((e) => e.name === selected) : null),
    [selected, graph.entities],
  );

  const selectedRelations = useMemo(() => {
    if (!selected) return [] as KgRelation[];
    return graph.relations.filter(
      (r) => r.from === selected || r.to === selected,
    );
  }, [selected, graph.relations]);

  const distinctTypes = useMemo(
    () => [...ringRadius.keys()].sort(),
    [ringRadius],
  );

  // Notify external onSelect when selection changes (used in tests).
  useEffect(() => {
    onSelect?.(selected);
  }, [selected, onSelect]);

  // ---- Event handlers ----

  const handleNodeEnter = useCallback(
    (node: PositionedNode, evt: ReactMouseEvent<SVGCircleElement>) => {
      setHovered(node.entity.name);
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const obsText =
        node.entity.observations.length > 0
          ? node.entity.observations.slice(0, 3).join(" · ")
          : "(no observations)";
      setTooltip({
        x: evt.clientX - rect.left + 12,
        y: evt.clientY - rect.top + 12,
        text: obsText,
        nodeId: `tooltip-${node.entity.name}`,
      });
    },
    [],
  );

  const handleNodeLeave = useCallback(() => {
    setHovered(null);
    setTooltip(null);
  }, []);

  const handleNodeClick = useCallback((node: PositionedNode) => {
    setSelected((prev) =>
      prev === node.entity.name ? null : node.entity.name,
    );
  }, []);

  const handleNodeKeyDown = useCallback(
    (node: PositionedNode, evt: KeyboardEvent<SVGGElement>) => {
      if (evt.key === "Enter" || evt.key === " ") {
        evt.preventDefault();
        setSelected((prev) =>
          prev === node.entity.name ? null : node.entity.name,
        );
      }
    },
    [],
  );

  const handleBackgroundClick = useCallback(() => {
    setSelected(null);
  }, []);

  // ---- Sub-ring guide circles ----
  // We need one dashed circle per distinct (type, subRing) radius actually used.
  const subRingGuides = useMemo(() => {
    const seen = new Set<number>();
    const guides: Array<{ key: string; r: number }> = [];
    for (const n of nodes) {
      const r = Math.round(
        (ringRadius.get(n.entity.entity_type) ?? BASE_RING_RADIUS) +
          n.subRing * SUB_RING_GAP,
      );
      if (!seen.has(r)) {
        seen.add(r);
        guides.push({ key: `guide-${r}`, r });
      }
    }
    return guides;
  }, [nodes, ringRadius]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <section
      className="flex h-full flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      aria-label="Memory Brain knowledge graph viewer"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold">Memory brain</h3>
          <span
            className="text-xs text-[var(--color-text-tertiary)]"
            aria-live="polite"
          >
            {loading
              ? "loading…"
              : `${graph.entities.length} entities · ${graph.relations.length} relations`}
          </span>
          {distinctTypes.length > 0 && (
            <span className="text-xs text-[var(--color-text-tertiary)]">
              · {distinctTypes.length} type
              {distinctTypes.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name, type, observation…"
            aria-label="Filter nodes by name, type or observation"
            className="w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
          />
          <button
            onClick={() => void refresh()}
            aria-label="Refresh knowledge graph"
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs hover:bg-[var(--color-surface-3)]"
          >
            Refresh
          </button>
        </div>
      </header>

      {error && (
        <div
          role="alert"
          className="rounded-md border p-2 text-xs"
          style={{
            borderColor: "var(--color-danger)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {!loading && graph.entities.length === 0 ? (
        <EmptyBrain />
      ) : (
        <div className="flex min-h-0 flex-1 gap-3">
          <div className="relative flex-1 overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]">
            <svg
              ref={svgRef}
              viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
              preserveAspectRatio="xMidYMid meet"
              className="block h-full w-full"
              onClick={handleBackgroundClick}
              role="img"
              aria-labelledby="memory-brain-title memory-brain-desc"
            >
              <title id="memory-brain-title">Memory Brain knowledge graph</title>
              <desc id="memory-brain-desc">
                {`Concentric layout of ${nodes.length} visible entities (${graph.entities.length} total) and ${graph.relations.length} relations grouped by type. Click or press Enter on a node to pin it.`}
              </desc>

              {/* Sub-ring guide circles (one per actual radius used). */}
              {subRingGuides.map(({ key, r }) => (
                <circle
                  key={key}
                  cx={CENTER}
                  cy={CENTER}
                  r={r}
                  fill="none"
                  stroke="var(--color-border)"
                  strokeWidth={1}
                  strokeDasharray="2 4"
                  aria-hidden="true"
                />
              ))}

              {/* Ring type labels at the top of each primary ring. */}
              {distinctTypes.map((type) => {
                const r = ringRadius.get(type)!;
                const badge = hiddenBadges.find((b) => b.type === type);
                return (
                  <g key={`ring-label-group-${type}`} aria-hidden="true">
                    <text
                      x={CENTER}
                      y={CENTER - r - 6}
                      textAnchor="middle"
                      fontSize={11}
                      fill="var(--color-text-tertiary)"
                      style={{ pointerEvents: "none" }}
                    >
                      {type}
                    </text>
                    {badge && (
                      <g>
                        {/* Badge pill background */}
                        <rect
                          x={CENTER - 36}
                          y={CENTER - r - 30}
                          width={72}
                          height={16}
                          rx={8}
                          fill="var(--color-warn)"
                          opacity={0.85}
                        />
                        <title>{`+${badge.hiddenCount} more nodes of type "${type}" are hidden (top ${MAX_NODES_PER_TYPE} by degree shown)`}</title>
                        <text
                          x={CENTER}
                          y={CENTER - r - 19}
                          textAnchor="middle"
                          fontSize={10}
                          fontWeight="600"
                          fill="var(--color-bg)"
                          style={{ pointerEvents: "none" }}
                        >
                          +{badge.hiddenCount} more
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}

              {/* Relations — drawn first so nodes paint on top. */}
              {graph.relations.map((rel) => {
                const a = byName.get(rel.from);
                const b = byName.get(rel.to);
                if (!a || !b) return null;
                const dimmed =
                  isDimmed(rel.from) && isDimmed(rel.to)
                    ? true
                    : focusName !== null &&
                      rel.from !== focusName &&
                      rel.to !== focusName;
                const highlighted =
                  focusName !== null &&
                  (rel.from === focusName || rel.to === focusName);
                return (
                  <line
                    key={`rel-${rel.from}-${rel.to}-${rel.relation_type}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={
                      highlighted
                        ? "var(--color-accent)"
                        : "var(--color-border-strong)"
                    }
                    strokeWidth={highlighted ? 1.5 : 0.8}
                    opacity={dimmed ? 0.15 : highlighted ? 1 : 0.55}
                    aria-hidden="true"
                  />
                );
              })}

              {/* Nodes — each is a keyboard-accessible button. */}
              {nodes.map((n) => {
                const r = nodeRadiusFor(n.degree, maxDegree);
                const dimmed = isDimmed(n.entity.name);
                const isFocus = focusName === n.entity.name;
                const isNeighbor = focusedNeighbors.has(n.entity.name);
                const isSelected = selected === n.entity.name;
                const fill = isFocus
                  ? "var(--color-accent)"
                  : ringColor(n.ring);
                const stroke =
                  isFocus || isNeighbor
                    ? "var(--color-accent)"
                    : "var(--color-border-strong)";
                const nodeId = `node-${n.entity.name.replace(/\s+/g, "-")}`;
                const tooltipId = `tooltip-${n.entity.name}`;
                const obsPreview =
                  n.entity.observations.length > 0
                    ? `: ${n.entity.observations[0]}`
                    : "";
                const ariaLabel = `${n.entity.name}, type ${n.entity.entity_type}, ${n.degree} connection${n.degree !== 1 ? "s" : ""}${obsPreview}`;

                return (
                  <g
                    key={nodeId}
                    id={nodeId}
                    role="button"
                    tabIndex={0}
                    aria-label={ariaLabel}
                    aria-pressed={isSelected}
                    aria-describedby={tooltip?.nodeId === tooltipId ? tooltipId : undefined}
                    style={{
                      cursor: "pointer",
                      outline: "none",
                    }}
                    opacity={dimmed ? 0.25 : 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleNodeClick(n);
                    }}
                    onKeyDown={(e) => handleNodeKeyDown(n, e)}
                    onFocus={() => setHovered(n.entity.name)}
                    onBlur={() => setHovered(null)}
                  >
                    {/* Focus outline ring — only visible when focused via keyboard. */}
                    <circle
                      cx={n.x}
                      cy={n.y}
                      r={r + 4}
                      fill="none"
                      stroke="var(--color-accent)"
                      strokeWidth={2}
                      opacity={0}
                      className="node-focus-ring"
                      style={{
                        // CSS :focus-within on the <g> is not standard; use
                        // a sibling selector trick via the parent group's
                        // focus-visible pseudo-class via inline CSS var.
                        // We rely on .node-focus-ring visibility toggled in
                        // global styles or keep it always hidden and rely on
                        // the stroke of the main circle instead.
                      }}
                    />
                    <circle
                      cx={n.x}
                      cy={n.y}
                      r={r}
                      fill={fill}
                      stroke={stroke}
                      strokeWidth={isFocus || isSelected ? 2.5 : 1}
                      onMouseEnter={(e) => handleNodeEnter(n, e)}
                      onMouseLeave={handleNodeLeave}
                    />
                    {(isFocus || isNeighbor || maxDegree === 0) && (
                      <text
                        x={n.x}
                        y={n.y - r - 4}
                        textAnchor="middle"
                        fontSize={11}
                        fill="var(--color-text)"
                        style={{ pointerEvents: "none" }}
                        aria-hidden="true"
                      >
                        {n.entity.name}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>

            {/* Tooltip — aria-hidden because its content is already in aria-label. */}
            {tooltip && (
              <div
                id={tooltip.nodeId}
                role="tooltip"
                className="pointer-events-none absolute z-10 max-w-xs rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[var(--color-text)] shadow-sm"
                style={{ left: tooltip.x, top: tooltip.y }}
              >
                {tooltip.text}
              </div>
            )}

            {/* Legend — type → color */}
            {distinctTypes.length > 0 && (
              <div
                className="pointer-events-none absolute bottom-2 left-2 flex flex-col gap-0.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs"
                aria-label="Node type color legend"
                role="list"
              >
                {distinctTypes.map((type, idx) => (
                  <div
                    key={type}
                    className="flex items-center gap-1.5"
                    role="listitem"
                  >
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: ringColor(idx) }}
                      aria-hidden="true"
                    />
                    <span className="text-[var(--color-text-secondary)]">
                      {type}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {selectedEntity && (
            <aside
              className="flex w-72 shrink-0 flex-col gap-2 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3"
              aria-label={`Details for ${selectedEntity.name}`}
            >
              <header className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="break-all text-sm font-semibold">
                    {selectedEntity.name}
                  </div>
                  <div className="text-xs text-[var(--color-text-tertiary)]">
                    {selectedEntity.entity_type}
                  </div>
                </div>
                <button
                  onClick={() => setSelected(null)}
                  aria-label={`Close details panel for ${selectedEntity.name}`}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-3)] px-2 py-0.5 text-xs hover:bg-[var(--color-surface-2)]"
                >
                  Close
                </button>
              </header>

              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
                  Observations ({selectedEntity.observations.length})
                </div>
                {selectedEntity.observations.length === 0 ? (
                  <p className="text-xs text-[var(--color-text-tertiary)]">
                    No observations.
                  </p>
                ) : (
                  <ul className="space-y-1 text-xs">
                    {selectedEntity.observations.map((o, i) => (
                      <li
                        key={`obs-${i}-${o.slice(0, 24)}`}
                        className="rounded-md bg-[var(--color-surface-3)] px-2 py-1"
                      >
                        {o}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
                  Relations ({selectedRelations.length})
                </div>
                {selectedRelations.length === 0 ? (
                  <p className="text-xs text-[var(--color-text-tertiary)]">
                    No relations.
                  </p>
                ) : (
                  <ul className="space-y-1 text-xs">
                    {selectedRelations.map((r, i) => {
                      const isOut = r.from === selected;
                      const other = isOut ? r.to : r.from;
                      return (
                        <li
                          key={`${r.from}-${r.to}-${r.relation_type}-${i}`}
                          className="flex items-center gap-1 rounded-md bg-[var(--color-surface-3)] px-2 py-1"
                        >
                          <span
                            className="text-[var(--color-text-tertiary)]"
                            aria-label={isOut ? "outgoing" : "incoming"}
                          >
                            {isOut ? "→" : "←"}
                          </span>
                          <button
                            onClick={() => setSelected(other)}
                            className="truncate text-left hover:text-[var(--color-accent)]"
                            title={other}
                            aria-label={`Navigate to ${other}`}
                          >
                            {other}
                          </button>
                          <span
                            className="ml-auto text-[var(--color-text-tertiary)]"
                            aria-label={`relation type: ${r.relation_type}`}
                          >
                            {r.relation_type}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </aside>
          )}
        </div>
      )}
    </section>
  );
}

function EmptyBrain() {
  return (
    <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] p-8 text-center">
      <div className="max-w-md space-y-2">
        <h4 className="text-sm font-semibold">No nodes in the brain yet</h4>
        <p className="text-xs text-[var(--color-text-tertiary)]">
          Create entities via{" "}
          <code className="rounded-sm bg-[var(--color-surface-2)] px-1 py-0.5 font-mono">
            mcp__memory__create_entities
          </code>{" "}
          from a Claude Code session, or use the{" "}
          <span className="font-medium">KG editor</span> tab to add one
          manually. New entities show up here on the next refresh.
        </p>
      </div>
    </div>
  );
}

export default MemoryBrain;
