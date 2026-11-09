// Mascota — bocadillo pasivo de avisos (build/tests en rojo, entregas).
//
// No recibe el ratón (pointer-events: none): el clic va a Pupus, que es
// quien lleva al sitio (useDeskAlerts.takeClick). Se coloca solo, en su
// propio requestAnimationFrame, encima de la cabeza; si no cabe, debajo.
// Desaparece cuando useDeskAlerts retira el aviso (8 s; la agenda, 14 s).

import { useEffect, useRef, type MutableRefObject } from "react";
import type { MascotEngine } from "./engine";
import type { NoticeKind } from "./deskAlerts";

export interface Notice {
  id: number;
  kind: NoticeKind;
  text: string;
  /** Línea pequeña debajo: qué hace el siguiente clic. */
  hint?: string;
}

const MARGIN = 6;

export function NoticeBubble({
  notice,
  engineRef,
}: {
  notice: Notice | null;
  engineRef: MutableRefObject<MascotEngine | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!notice) return;
    let raf = 0;
    const place = () => {
      raf = requestAnimationFrame(place);
      const eng = engineRef.current;
      const el = ref.current;
      if (!eng || !el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const headY = eng.y - eng.height - 2 * eng.S;
      let y = headY - h - 14;
      if (y < MARGIN) y = Math.min(eng.y + 8, window.innerHeight - h - MARGIN);
      const x = Math.min(Math.max(eng.x - w / 2, MARGIN), window.innerWidth - w - MARGIN);
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    };
    raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [notice, engineRef]);

  if (!notice) return null;
  return (
    <div
      ref={ref}
      key={notice.id}
      className="mascot-notice"
      role="status"
      aria-live="polite"
      style={{ transform: "translate(-9999px, -9999px)" }}
    >
      {notice.text}
      {notice.hint && <div className="mascot-notice-hint">{notice.hint}</div>}
    </div>
  );
}
