// ULTRON Control Center 2.0 — Terminal split-pane layout types
//
// Mirrors `src-tauri/src/terminal_layout.rs`. Discriminated-union LayoutNode
// (leaf | split), per-project array of TerminalTab, and a top-level
// ProjectTerminalLayout with active tab id. All mutations through this module
// are immutable; helpers below produce a fresh tree on each edit.

export type Provider = "claude" | "codex" | "gemini";

export type SplitDirection = "h" | "v";

export type LayoutNode =
  | { kind: "leaf"; id: string; pty_id: string | null }
  | {
      kind: "split";
      direction: SplitDirection;
      ratio: number;
      left: LayoutNode;
      right: LayoutNode;
    };

export type TerminalTab = {
  id: string;
  label: string;
  default_provider: Provider | null;
  root: LayoutNode;
};

export type ProjectTerminalLayout = {
  schema_version: 1;
  tabs: TerminalTab[];
  active_tab_id: string | null;
};

// ---------------------------------------------------------------------------
// Pure helpers (no mutation — return a new tree).
// ---------------------------------------------------------------------------

let __counter = 0;
function genId(prefix: string): string {
  __counter += 1;
  return `${prefix}-${Date.now()}-${__counter}`;
}

export function makeLeaf(ptyId: string | null = null): LayoutNode {
  return { kind: "leaf", id: genId("leaf"), pty_id: ptyId };
}

export function makeTab(label: string): TerminalTab {
  return {
    id: genId("tab"),
    label,
    default_provider: null,
    root: makeLeaf(null),
  };
}

export function defaultLayout(): ProjectTerminalLayout {
  const tab = makeTab("Tab 1");
  return {
    schema_version: 1,
    tabs: [tab],
    active_tab_id: tab.id,
  };
}

/** Recursively rewrite the node identified by `leafId` using `update`.
 *  Returns the original tree if nothing matched. Pure. */
export function mapLeaf(
  node: LayoutNode,
  leafId: string,
  update: (leaf: LayoutNode & { kind: "leaf" }) => LayoutNode,
): LayoutNode {
  if (node.kind === "leaf") {
    if (node.id === leafId) return update(node);
    return node;
  }
  const left = mapLeaf(node.left, leafId, update);
  const right = mapLeaf(node.right, leafId, update);
  if (left === node.left && right === node.right) return node;
  return { ...node, left, right };
}

/** Split a leaf into a binary split with the original leaf on the left and a
 *  fresh empty leaf on the right. */
export function splitLeaf(
  root: LayoutNode,
  leafId: string,
  direction: SplitDirection,
): LayoutNode {
  return mapLeaf(root, leafId, (leaf) => ({
    kind: "split",
    direction,
    ratio: 0.5,
    left: leaf,
    right: makeLeaf(null),
  }));
}

/** Remove a leaf — collapses the containing split into the surviving sibling.
 *  If the leaf is the root, returns a fresh empty leaf to keep the tab alive. */
export function closeLeaf(root: LayoutNode, leafId: string): LayoutNode {
  if (root.kind === "leaf") {
    if (root.id === leafId) return makeLeaf(null);
    return root;
  }
  // If either direct child matches, collapse.
  if (root.left.kind === "leaf" && root.left.id === leafId) return root.right;
  if (root.right.kind === "leaf" && root.right.id === leafId) return root.left;
  // Otherwise recurse.
  const left = closeLeaf(root.left, leafId);
  const right = closeLeaf(root.right, leafId);
  if (left === root.left && right === root.right) return root;
  return { ...root, left, right };
}

/** Update the ratio of the split node that owns the sash being dragged.
 *  Splits are identified by the id of either child for simplicity. */
export function setSplitRatio(
  root: LayoutNode,
  splitChildId: string,
  ratio: number,
): LayoutNode {
  if (root.kind === "leaf") return root;
  const clamped = Math.max(0.05, Math.min(0.95, ratio));
  const matches =
    childId(root.left) === splitChildId || childId(root.right) === splitChildId;
  if (matches) {
    if (root.ratio === clamped) return root;
    return { ...root, ratio: clamped };
  }
  const left = setSplitRatio(root.left, splitChildId, ratio);
  const right = setSplitRatio(root.right, splitChildId, ratio);
  if (left === root.left && right === root.right) return root;
  return { ...root, left, right };
}

function childId(n: LayoutNode): string {
  return n.kind === "leaf" ? n.id : `${childId(n.left)}|${childId(n.right)}`;
}

/** Walk the tree and collect every leaf — used for PTY reattachment. */
export function collectLeaves(
  node: LayoutNode,
): Array<LayoutNode & { kind: "leaf" }> {
  if (node.kind === "leaf") return [node];
  return [...collectLeaves(node.left), ...collectLeaves(node.right)];
}

/** Replace the pty_id on a leaf (without changing anything else). */
export function setLeafPty(
  root: LayoutNode,
  leafId: string,
  ptyId: string | null,
): LayoutNode {
  return mapLeaf(root, leafId, (leaf) => ({ ...leaf, pty_id: ptyId }));
}
