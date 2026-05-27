// MemoryBrain — unit tests for collision-avoidance additions (KIRKARDO 18)
//
// Covers:
//   1. With 100 nodes in one entity_type → all land on primary sub-ring (subRing === 0).
//   2. With 250 nodes in one entity_type → 60+60+60+20 visible (200 max) + badge of 50.
//   3. Click on a node invokes the onSelect callback with the entity name.
//   4. nameJitter returns deterministic value in [-5, 5] range.
//   5. assignSubRings distributes correctly across sub-rings.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  computeLayout,
  assignSubRings,
  nameJitter,
  MAX_PER_RING,
  MAX_NODES_PER_TYPE,
  MemoryBrain,
} from "../MemoryBrain";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntities(
  count: number,
  type = "concept",
  degreeOverride?: (i: number) => number,
) {
  return Array.from({ length: count }, (_, i) => ({
    name: `node-${i}`,
    entity_type: type,
    observations: [`obs-${i}`],
    _degree: degreeOverride ? degreeOverride(i) : i,
  }));
}

function makeGraph(entities: ReturnType<typeof makeEntities>, relations = []) {
  // Build a minimal KgGraph with synthetic degree (one relation per node)
  const rels = entities.map((e) => ({
    from: e.name,
    to: "hub",
    relation_type: "related_to",
  }));
  return {
    entities: entities.map(({ name, entity_type, observations }) => ({
      name,
      entity_type,
      observations,
    })),
    relations: [...rels, ...relations],
  };
}

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe("nameJitter", () => {
  it("returns a value within ±5 px", () => {
    const names = ["alpha", "beta", "gamma delta", "node-0", "foo-bar-baz-99"];
    for (const name of names) {
      const j = nameJitter(name);
      expect(j).toBeGreaterThanOrEqual(-5);
      expect(j).toBeLessThanOrEqual(5);
    }
  });

  it("is deterministic — same name always produces same value", () => {
    expect(nameJitter("alpha")).toBe(nameJitter("alpha"));
    expect(nameJitter("node-42")).toBe(nameJitter("node-42"));
  });

  it("produces different values for different names", () => {
    // Not strictly guaranteed, but extremely unlikely to collide for these names.
    expect(nameJitter("alpha")).not.toBe(nameJitter("beta"));
  });
});

describe("assignSubRings", () => {
  it("places first MAX_PER_RING nodes on subRingIdx 0", () => {
    const entities = makeEntities(MAX_PER_RING).map(
      ({ name, entity_type, observations }) => ({
        name,
        entity_type,
        observations,
      }),
    );
    const result = assignSubRings(entities, 200);
    expect(result.every((r) => r.subRingIdx === 0)).toBe(true);
  });

  it("places node at index MAX_PER_RING on subRingIdx 1", () => {
    const entities = makeEntities(MAX_PER_RING + 1).map(
      ({ name, entity_type, observations }) => ({
        name,
        entity_type,
        observations,
      }),
    );
    const result = assignSubRings(entities, 200);
    expect(result[MAX_PER_RING]!.subRingIdx).toBe(1);
  });

  it("increments radius by SUB_RING_GAP (60) per sub-ring", () => {
    const entities = makeEntities(MAX_PER_RING * 2 + 1).map(
      ({ name, entity_type, observations }) => ({
        name,
        entity_type,
        observations,
      }),
    );
    const primaryRadius = 150;
    const result = assignSubRings(entities, primaryRadius);
    expect(result[0]!.radius).toBe(primaryRadius);
    expect(result[MAX_PER_RING]!.radius).toBe(primaryRadius + 60);
    expect(result[MAX_PER_RING * 2]!.radius).toBe(primaryRadius + 120);
  });
});

// ---------------------------------------------------------------------------
// computeLayout tests
// ---------------------------------------------------------------------------

describe("computeLayout — 100 nodes, one type", () => {
  it("all 100 nodes are visible (no truncation badge)", () => {
    const graph = makeGraph(makeEntities(100));
    const { nodes, hiddenBadges } = computeLayout(graph);

    // All 100 rendered (100 < MAX_NODES_PER_TYPE = 200)
    expect(nodes).toHaveLength(100);
    expect(hiddenBadges).toHaveLength(0);
  });

  it("first 60 nodes go on sub-ring 0, remaining 40 on sub-ring 1", () => {
    const graph = makeGraph(makeEntities(100));
    const { nodes } = computeLayout(graph);

    const bySubRing = nodes.reduce<Record<number, number>>((acc, n) => {
      acc[n.subRing] = (acc[n.subRing] ?? 0) + 1;
      return acc;
    }, {});
    // MAX_PER_RING = 60 → first ring full, second has the remaining 40
    expect(bySubRing[0]).toBe(MAX_PER_RING);      // 60
    expect(bySubRing[1]).toBe(100 - MAX_PER_RING); // 40
  });
});

describe("computeLayout — 250 nodes, one type", () => {
  it("renders exactly 200 visible nodes (top-200 cap)", () => {
    const graph = makeGraph(makeEntities(250));
    const { nodes } = computeLayout(graph);

    expect(nodes).toHaveLength(MAX_NODES_PER_TYPE); // 200
  });

  it("creates a hidden badge with count 50", () => {
    const graph = makeGraph(makeEntities(250));
    const { hiddenBadges } = computeLayout(graph);

    expect(hiddenBadges).toHaveLength(1);
    expect(hiddenBadges[0]!.hiddenCount).toBe(50); // 250 - 200 = 50
  });

  it("distributes 200 visible nodes across sub-rings 0, 1, 2, 3", () => {
    // 200 / MAX_PER_RING(60) = 3 full + 1 partial → sub-rings 0, 1, 2, 3
    const graph = makeGraph(makeEntities(250));
    const { nodes } = computeLayout(graph);

    const subRingCounts = nodes.reduce<Record<number, number>>((acc, n) => {
      acc[n.subRing] = (acc[n.subRing] ?? 0) + 1;
      return acc;
    }, {});

    expect(subRingCounts[0]).toBe(60); // primary
    expect(subRingCounts[1]).toBe(60); // secondary
    expect(subRingCounts[2]).toBe(60); // tertiary
    expect(subRingCounts[3]).toBe(20); // quaternary (200 - 60*3 = 20)
  });
});

describe("computeLayout — multiple entity types", () => {
  it("assigns one primary ring radius per distinct type", () => {
    const entities = [
      ...makeEntities(5, "concept"),
      ...makeEntities(5, "person"),
      ...makeEntities(5, "project"),
    ].map(({ name, entity_type, observations }) => ({
      name,
      entity_type,
      observations,
    }));
    const graph = { entities, relations: [] };
    const { ringRadius } = computeLayout(graph);

    expect(ringRadius.size).toBe(3);
    // Radii should be distinct multiples apart.
    const radii = [...ringRadius.values()].sort((a, b) => a - b);
    expect(radii[1]! - radii[0]!).toBe(130); // RING_STEP
    expect(radii[2]! - radii[1]!).toBe(130);
  });
});

describe("computeLayout — jitter applied", () => {
  it("nodes at same ring do NOT all share the exact same radius", () => {
    // All 5 nodes have the same degree — without jitter they'd be at
    // exactly primaryRadius from center. With jitter they should differ.
    const entities = makeEntities(5, "concept").map(
      ({ name, entity_type, observations }) => ({
        name,
        entity_type,
        observations,
      }),
    );
    const graph = { entities, relations: [] };
    const { nodes } = computeLayout(graph);

    // Compute actual radius of each node from center.
    const CENTER = 500;
    const radii = nodes.map((n) =>
      Math.sqrt((n.x - CENTER) ** 2 + (n.y - CENTER) ** 2),
    );

    // At least two radii differ (jitter must have moved at least one node).
    const allSame = radii.every((r) => Math.abs(r - radii[0]!) < 0.001);
    expect(allSame).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Component interaction tests
// ---------------------------------------------------------------------------

describe("MemoryBrain component", () => {
  it("calls onSelect when a rendered node is clicked", async () => {
    const onSelect = vi.fn();

    // Mock invoke to return a small graph synchronously.
    vi.mocked(invoke).mockResolvedValueOnce({
      entities: [
        { name: "Alpha", entity_type: "concept", observations: [] },
        { name: "Beta", entity_type: "concept", observations: [] },
      ],
      relations: [{ from: "Alpha", to: "Beta", relation_type: "links_to" }],
    });

    render(<MemoryBrain onSelect={onSelect} />);

    // Wait for the async invoke to resolve and nodes to appear.
    const alphaNode = await screen.findByRole("button", { name: /Alpha/i });
    fireEvent.click(alphaNode);

    expect(onSelect).toHaveBeenCalledWith("Alpha");
  });

  it("deselects on second click of the same node", async () => {
    const onSelect = vi.fn();

    vi.mocked(invoke).mockResolvedValueOnce({
      entities: [
        { name: "Alpha", entity_type: "concept", observations: [] },
      ],
      relations: [],
    });

    render(<MemoryBrain onSelect={onSelect} />);

    const alphaNode = await screen.findByRole("button", { name: /Alpha/i });

    // The useEffect fires once on mount with null — reset before our clicks.
    onSelect.mockClear();

    fireEvent.click(alphaNode);
    fireEvent.click(alphaNode);

    // First click selects, second click deselects (null).
    expect(onSelect).toHaveBeenNthCalledWith(1, "Alpha");
    expect(onSelect).toHaveBeenNthCalledWith(2, null);
  });

  it("activates node on Enter key", async () => {
    const onSelect = vi.fn();

    vi.mocked(invoke).mockResolvedValueOnce({
      entities: [
        { name: "Gamma", entity_type: "concept", observations: ["a note"] },
      ],
      relations: [],
    });

    render(<MemoryBrain onSelect={onSelect} />);

    const gammaNode = await screen.findByRole("button", { name: /Gamma/i });
    fireEvent.keyDown(gammaNode, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith("Gamma");
  });

  it("shows loading state then entity count after data loads", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      entities: [
        { name: "NodeA", entity_type: "concept", observations: [] },
        { name: "NodeB", entity_type: "concept", observations: [] },
      ],
      relations: [],
    });

    render(<MemoryBrain />);

    // Loading text should appear immediately.
    expect(screen.getByText("loading…")).toBeTruthy();

    // After resolve, entity count should be shown.
    await waitFor(() =>
      expect(screen.getByText(/2 entities/)).toBeTruthy(),
    );
  });

  it("renders the +N more badge when entity_type has >200 nodes", async () => {
    const entities = Array.from({ length: 250 }, (_, i) => ({
      name: `n-${i}`,
      entity_type: "concept",
      observations: [],
    }));

    vi.mocked(invoke).mockResolvedValueOnce({ entities, relations: [] });

    render(<MemoryBrain />);

    await waitFor(() => {
      // Two DOM elements match "+50 more": the SVG <title> and the <text> node.
      const matches = screen.getAllByText(/\+50 more/);
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ---------------------------------------------------------------------------
// A11y attribute tests (static render)
// ---------------------------------------------------------------------------

describe("MemoryBrain a11y attributes", () => {
  it("each node has role=button and aria-label with entity name", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      entities: [
        { name: "TestNode", entity_type: "concept", observations: ["obs1"] },
      ],
      relations: [],
    });

    render(<MemoryBrain />);

    const btn = await screen.findByRole("button", { name: /TestNode/i });
    expect(btn).toBeTruthy();
    expect(btn.getAttribute("aria-label")).toContain("TestNode");
    expect(btn.getAttribute("aria-label")).toContain("concept");
  });

  it("each node has tabIndex=0", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      entities: [
        { name: "TabNode", entity_type: "concept", observations: [] },
      ],
      relations: [],
    });

    render(<MemoryBrain />);

    const btn = await screen.findByRole("button", { name: /TabNode/i });
    expect(btn.getAttribute("tabindex")).toBe("0");
  });

  it("node aria-pressed reflects selection state", async () => {
    const onSelect = vi.fn();

    vi.mocked(invoke).mockResolvedValueOnce({
      entities: [
        { name: "PressNode", entity_type: "concept", observations: [] },
      ],
      relations: [],
    });

    render(<MemoryBrain onSelect={onSelect} />);

    const btn = await screen.findByRole("button", { name: /PressNode/i });
    expect(btn.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(btn);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });
});
