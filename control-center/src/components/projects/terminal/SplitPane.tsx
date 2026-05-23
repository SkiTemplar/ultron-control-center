// ULTRON Control Center 2.0 — Recursive split-pane renderer
//
// Renders a LayoutNode recursively. Splits draw a draggable sash between the
// two children; drag updates the parent's ratio via `onRatioChange`. Leaves
// delegate to <TerminalLeaf>.

import { useCallback, useRef } from "react";
import type { LayoutNode, Provider, SplitDirection } from "./layout-types";
import TerminalLeaf from "./TerminalLeaf";

type SplitPaneProps = {
  node: LayoutNode;
  onSplit: (leafId: string, direction: SplitDirection) => void;
  onClose: (leafId: string) => void;
  onSpawnPty: (leafId: string, provider: Provider) => void;
  onAttachExisting: (leafId: string, ptyId: string) => void;
  onKillPty: (leafId: string, ptyId: string) => void;
  onRatioChange: (childId: string, ratio: number) => void;
  projectId: string;
};

export default function SplitPane(props: SplitPaneProps) {
  const { node } = props;
  if (node.kind === "leaf") {
    return (
      <TerminalLeaf
        leafId={node.id}
        ptyId={node.pty_id}
        projectId={props.projectId}
        onSplit={props.onSplit}
        onClose={props.onClose}
        onSpawn={props.onSpawnPty}
        onAttachExisting={props.onAttachExisting}
        onKillPty={props.onKillPty}
      />
    );
  }
  return <SplitInner {...props} node={node} />;
}

function SplitInner(
  props: SplitPaneProps & { node: Extract<LayoutNode, { kind: "split" }> },
) {
  const { node } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      draggingRef.current = true;
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const ratio =
        node.direction === "h"
          ? (e.clientX - rect.left) / Math.max(1, rect.width)
          : (e.clientY - rect.top) / Math.max(1, rect.height);
      // Identify the split by the id of its left child.
      const leftId = idOf(node.left);
      props.onRatioChange(leftId, ratio);
    },
    [node, props],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      draggingRef.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    },
    [],
  );

  const isHorizontal = node.direction === "h";
  const ratioPct = `${node.ratio * 100}%`;
  const remainderPct = `${(1 - node.ratio) * 100}%`;

  return (
    <div
      ref={containerRef}
      className={
        isHorizontal ? "flex h-full w-full flex-row" : "flex h-full w-full flex-col"
      }
    >
      <div
        style={
          isHorizontal
            ? { width: ratioPct, minWidth: 80 }
            : { height: ratioPct, minHeight: 80 }
        }
        className="relative overflow-hidden"
      >
        <SplitPane {...props} node={node.left} />
      </div>
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="separator"
        aria-orientation={isHorizontal ? "vertical" : "horizontal"}
        className={
          isHorizontal
            ? "z-10 w-1 shrink-0 cursor-col-resize bg-[var(--color-border)] hover:bg-[var(--color-accent)]"
            : "z-10 h-1 shrink-0 cursor-row-resize bg-[var(--color-border)] hover:bg-[var(--color-accent)]"
        }
        style={{ touchAction: "none" }}
      />
      <div
        style={
          isHorizontal
            ? { width: remainderPct, minWidth: 80 }
            : { height: remainderPct, minHeight: 80 }
        }
        className="relative overflow-hidden"
      >
        <SplitPane {...props} node={node.right} />
      </div>
    </div>
  );
}

function idOf(node: LayoutNode): string {
  return node.kind === "leaf" ? node.id : idOf(node.left);
}
