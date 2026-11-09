import { describe, expect, it } from "vitest";
import {
  EMPTY_VIEW,
  mergeNeighborhood,
  nodeIndexFromSvgId,
  toDot,
  viewFromNeighborhood,
  type CgEdge,
  type CgNeighborhood,
  type CgNode,
} from "../codegraph";

const node = (id: string, name = id, kind = "function"): CgNode => ({
  id,
  kind,
  name,
  qualified_name: name,
  file_path: "src/a.ts",
  language: "typescript",
  start_line: 1,
  end_line: 2,
  signature: null,
});

const edge = (source: string, target: string, kind = "calls"): CgEdge => ({ source, target, kind, line: 3 });

const hood = (center: string, nodes: CgNode[], edges: CgEdge[], truncated = false): CgNeighborhood => ({
  center,
  depth: 1,
  nodes,
  edges,
  truncated,
});

describe("mergeNeighborhood", () => {
  it("une vecindarios sin duplicar nodos ni aristas y sin mutar la entrada", () => {
    const first = viewFromNeighborhood(hood("a", [node("a"), node("b")], [edge("a", "b")]));
    const snapshot = JSON.stringify(first);
    const merged = mergeNeighborhood(first, hood("b", [node("b"), node("c")], [edge("a", "b"), edge("b", "c")]));
    expect(merged.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(merged.edges).toHaveLength(2);
    expect(JSON.stringify(first)).toBe(snapshot);
  });

  it("respeta el tope de nodos, marca el recorte y descarta las aristas colgantes", () => {
    const merged = mergeNeighborhood(
      EMPTY_VIEW,
      hood("a", [node("a"), node("b"), node("c")], [edge("a", "b"), edge("a", "c")]),
      2,
    );
    expect(merged.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(merged.edges).toEqual([edge("a", "b")]);
    expect(merged.truncated).toBe(true);
  });

  it("hereda el recorte que declara el backend", () => {
    expect(viewFromNeighborhood(hood("a", [node("a")], [], true)).truncated).toBe(true);
    expect(viewFromNeighborhood(hood("a", [node("a")], [])).truncated).toBe(false);
  });
});

describe("toDot", () => {
  it("escapa comillas y barras de los nombres y marca el seleccionado", () => {
    const view = viewFromNeighborhood(
      hood("a", [node("a", 'say "hi"\\'), node("b", "b", "file")], [edge("b", "a", "contains")]),
    );
    const dot = toDot(view, "a");
    expect(dot).toContain('label="say \\"hi\\"\\\\\\nfunction"');
    expect(dot).toContain('id="cg-0"');
    expect(dot).toContain("penwidth=2.5");
    expect(dot).toContain("shape=folder");
    expect(dot).toContain('n1 -> n0 [label="contains", style=dashed]');
  });

  it("ignora aristas cuyo extremo no está en el grafo", () => {
    const dot = toDot({ nodes: [node("a")], edges: [edge("a", "zzz")], truncated: false }, null);
    expect(dot).not.toContain("->");
  });
});

describe("nodeIndexFromSvgId", () => {
  it("solo acepta ids del visor", () => {
    expect(nodeIndexFromSvgId("cg-12")).toBe(12);
    expect(nodeIndexFromSvgId("node1")).toBeNull();
    expect(nodeIndexFromSvgId(null)).toBeNull();
    expect(nodeIndexFromSvgId("cg-1x")).toBeNull();
  });
});
