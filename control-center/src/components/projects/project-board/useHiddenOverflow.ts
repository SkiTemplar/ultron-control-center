import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Counts how many children of a scrollable container sit mostly (more than
 * half) past its visible edge — below it for `axis: "y"`, to its right for
 * `axis: "x"` — so a board can say that it holds more than it shows. The
 * container must be `position: relative` (offsets are measured against it).
 * Los hijos con `data-overflow-ignore` (espaciadores) no cuentan.
 * Recomputed on scroll, on resize and whenever `itemCount` changes.
 */
export function useHiddenOverflow<T extends HTMLElement>(
  itemCount: number,
  axis: "x" | "y",
) {
  const ref = useRef<T | null>(null);
  const [hidden, setHidden] = useState(0);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const limit =
      axis === "y" ? el.scrollTop + el.clientHeight : el.scrollLeft + el.clientWidth;
    let count = 0;
    for (const child of Array.from(el.children)) {
      const node = child as HTMLElement;
      if (node.dataset.overflowIgnore !== undefined) continue;
      const middle =
        axis === "y"
          ? node.offsetTop + node.offsetHeight / 2
          : node.offsetLeft + node.offsetWidth / 2;
      if (middle > limit) count += 1;
    }
    setHidden(count);
  }, [axis]);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, itemCount]);

  return { ref, hidden, onScroll: measure };
}
