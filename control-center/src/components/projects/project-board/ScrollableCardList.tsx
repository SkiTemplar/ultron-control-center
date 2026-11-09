import type { ReactNode } from "react";
import { useHiddenOverflow } from "./useHiddenOverflow";

type Props = {
  /** Number of cards rendered; re-measures the overflow when it changes. */
  itemCount: number;
  children: ReactNode;
};

/**
 * Scrollable card list for a board column. When cards remain below the
 * visible area it fades the bottom edge and shows "+N más", so a column
 * never hides cards without saying so.
 */
export function ScrollableCardList({ itemCount, children }: Props) {
  const { ref, hidden, onScroll } = useHiddenOverflow<HTMLDivElement>(itemCount, "y");
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={ref}
        onScroll={onScroll}
        className="relative min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2"
      >
        {children}
      </div>
      {hidden > 0 && (
        <div
          aria-live="polite"
          className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-1 pt-5 text-[10.5px] font-medium text-[var(--color-text-muted)]"
          style={{
            background:
              "linear-gradient(to top, var(--color-surface-1) 45%, transparent)",
          }}
        >
          +{hidden} más
        </div>
      )}
    </div>
  );
}
