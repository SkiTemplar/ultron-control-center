// Avisos de error de la ventana: cola de hasta `MAX_TOASTS`, con autocierre a los
// `TOAST_MS` (se pausa con el ratón encima) y el mismo error seguido agrupado con
// un contador. Antes había un único aviso que el siguiente error pisaba y que no
// se cerraba solo, tapando la barra de pestañas.

import { useEffect, useRef, useState } from "react";
import { store, useStore } from "../store";

export const MAX_TOASTS = 3;
export const TOAST_MS = 10_000;

interface Toast {
  id: number;
  text: string;
  count: number;
}

let seq = 0;

/** Añade el error a la cola: el mismo texto que el último suma uno; la cola guarda los últimos. */
export function pushToast(list: readonly Toast[], text: string): Toast[] {
  const last = list[list.length - 1];
  if (last && last.text === text) return [...list.slice(0, -1), { ...last, count: last.count + 1 }];
  seq += 1;
  return [...list, { id: seq, text, count: 1 }].slice(-MAX_TOASTS);
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const [hover, setHover] = useState(false);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (hover) return;
    const t = window.setTimeout(() => close.current(), TOAST_MS);
    return () => window.clearTimeout(t);
  }, [hover, toast.count]);
  return (
    <div className="toast" role="alert" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <span>{toast.text}{toast.count > 1 && <b className="toast-count"> ×{toast.count}</b>}</span>
      <button className="btn sm ghost" onClick={onClose}>Cerrar</button>
    </div>
  );
}

export function Toasts() {
  const error = useStore((s) => s.error);
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(() => {
    if (!error) return;
    setItems((list) => pushToast(list, error));
    // El store guarda un solo error: se vacía para que el mismo texto vuelva a entrar.
    store.dispatch({ type: "error", message: null });
  }, [error]);
  if (items.length === 0) return null;
  return (
    <div className="toasts">
      {items.map((t) => (
        <ToastItem key={t.id} toast={t} onClose={() => setItems((list) => list.filter((x) => x.id !== t.id))} />
      ))}
    </div>
  );
}
