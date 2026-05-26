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
//   - <=600 LOC, single file.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
  ring: number;
  // Cached degree (# of relations touching this node).
  degree: number;
}

// ---------------------------------------------------------------------------
// Layout — concentric rings, one per distinct entity type.
// ---------------------------------------------------------------------------

const VIEWBOX = 1000;
const CENTER = VIEWBOX / 2;
const BASE_RING_RADIUS = 110;
const RING_STEP = 130;
const MIN_NODE_RADIUS = 6;
const MAX_NODE_RADIUS = 18;

/**
 * Deterministically position every entity around concentric rings keyed by
 * `entity_type`. Types are sorted alphabetically so the layout is stable
 * across reloads.
 */
function computeLayout(graph: KgGraph): {
  nodes: PositionedNode[];
  byName: Map<string, PositionedNode>;
  ringRadius: Map<string, number>;
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
  const degree = new Map<string, number>();
  for (const rel of graph.relations) {
    degree.set(rel.from, (degree.get(rel.from) ?? 0) + 1);
    degree.set(rel.to, (degree.get(rel.to) ?? 0) + 1);
  }

  const nodes: PositionedNode[] = [];
  const byName = new Map<string, PositionedNode>();
  const ringRadius = new Map<string, number>();

  sortedTypes.forEach((type, ringIdx) => {
    const bucket = byType.get(type)!;
    const radius = BASE_RING_RADIUS + ringIdx * RING_STEP;
    ringRadius.set(type, radius);

    // Sort entities inside a ring alphabetically for a stable layout.
    const sortedBucket = [...bucket].sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    sortedBucket.forEach((ent, i) => {
      const angle = (i / Math.max(sortedBucket.length, 1)) * Math.PI * 2;
      const node: PositionedNode = {
        entity: ent,
        x: CENTER + Math.cos(angle) * radius,
        y: CENTER + Math.sin(angle) * radius,
        ring: ringIdx,
        degree: degree.get(ent.name) ?? 0,
      };
      nodes.push(node);
      byName.set(ent.name, node);
    });
  });

  return { nodes, byName, ringRadius };
}

/**
 * Map a degree to a node radius — high-degree nodes look larger so the
 * visual hierarchy reflects "central" concepts in the brain.
 */
function nodeRadiusFor(degree: number, maxDegree: number): number {
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

export function MemoryBrain() {
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

  // Layout is recomputed when the graph changes.
  const { nodes, byName, ringRadius } = useMemo(
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

  // Pre-compute related-entity sets for the currently focused node.
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

  const handleNodeEnter = useCallback(
    (node: PositionedNode, evt: ReactMouseEvent<SVGCircleElement>) => {
      setHovered(node.entity.name);
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      setTooltip({
        x: evt.clientX - rect.left + 12,
        y: evt.clientY - rect.top + 12,
        text:
          node.entity.observations.length > 0
            ? node.entity.observations.slice(0, 3).join(" · ")
            : "(no observations)",
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

  const handleBackgroundClick = useCallback(() => {
    setSelected(null);
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <section className="flex h-full flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold">Memory brain</h3>
          <span className="text-xs text-[var(--color-text-tertiary)]">
            {loading
              ? "loading…"
              : `${graph.entities.length} entities · ${graph.relations.length} relations`}
          </span>
          {distinctTypes.length > 0 && (
            <span className="text-xs text-[var(--color-text-tertiary)]">
              · {distinctTypes.length} type{distinctTypes.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name, type, observation…"
            className="w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
          />
          <button
            onClick={() => void refresh()}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs hover:bg-[var(--color-surface-3)]"
          >
            Refresh
          </button>
        </div>
      </header>

      {error && (
        <div
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
            >
              {/* Concentric ring guides — one per entity type. */}
              {distinctTypes.map((type) => {
                const r = ringRadius.get(type)!;
                return (
                  <circle
                    key={`ring-${type}`}
                    cx={CENTER}
                    cy={CENTER}
                    r={r}
                    fill="none"
                    stroke="var(--color-border)"
                    strokeWidth={1}
                    strokeDasharray="2 4"
                  />
                );
              })}

              {/* Ring labels (type names) sit at the top of each ring. */}
              {distinctTypes.map((type) => {
                const r = ringRadius.get(type)!;
                return (
                  <text
                    key={`ring-label-${type}`}
                    x={CENTER}
                    y={CENTER - r - 6}
                    textAnchor="middle"
                    fontSize={11}
                    fill="var(--color-text-tertiary)"
                    style={{ pointerEvents: "none" }}
                  >
                    {type}
                  </text>
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
                  />
                );
              })}

              {/* Nodes. */}
              {nodes.map((n) => {
                const r = nodeRadiusFor(n.degree, maxDegree);
                const dimmed = isDimmed(n.entity.name);
                const isFocus = focusName === n.entity.name;
                const isNeighbor = focusedNeighbors.has(n.entity.name);
                const fill = isFocus
                  ? "var(--color-accent)"
                  : isNeighbor
                    ? ringColor(n.ring)
                    : ringColor(n.ring);
                const stroke =
                  isFocus || isNeighbor
                    ? "var(--color-accent)"
                    : "var(--color-border-strong)";
                return (
                  <g
                    key={`node-${n.entity.name}`}
                    style={{ cursor: "pointer" }}
                    opacity={dimmed ? 0.25 : 1}
                  >
                    <circle
                      cx={n.x}
                      cy={n.y}
                      r={r}
                      fill={fill}
                      stroke={stroke}
                      strokeWidth={isFocus ? 2 : 1}
                      onMouseEnter={(e) => handleNodeEnter(n, e)}
                      onMouseLeave={handleNodeLeave}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleNodeClick(n);
                      }}
                    />
                    {(isFocus || isNeighbor || maxDegree === 0) && (
                      <text
                        x={n.x}
                        y={n.y - r - 4}
                        textAnchor="middle"
                        fontSize={11}
                        fill="var(--color-text)"
                        style={{ pointerEvents: "none" }}
                      >
                        {n.entity.name}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>

            {tooltip && (
              <div
                className="pointer-events-none absolute z-10 max-w-xs rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[var(--color-text)] shadow-sm"
                style={{ left: tooltip.x, top: tooltip.y }}
              >
                {tooltip.text}
              </div>
            )}

            {/* Legend — type → color */}
            {distinctTypes.length > 0 && (
              <div className="pointer-events-none absolute bottom-2 left-2 flex flex-col gap-0.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs">
                {distinctTypes.map((type, idx) => (
                  <div key={type} className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: ringColor(idx) }}
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
            <aside className="flex w-72 shrink-0 flex-col gap-2 overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3">
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
                        key={i}
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
                          <span className="text-[var(--color-text-tertiary)]">
                            {isOut ? "→" : "←"}
                          </span>
                          <button
                            onClick={() => setSelected(other)}
                            className="truncate text-left hover:text-[var(--color-accent)]"
                            title={other}
                          >
                            {other}
                          </button>
                          <span className="ml-auto text-[var(--color-text-tertiary)]">
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
