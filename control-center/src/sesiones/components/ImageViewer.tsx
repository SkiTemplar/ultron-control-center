// Visor de imágenes a pantalla completa: zoom con la rueda (o + y −), arrastre
// con el ratón cuando hay zoom, doble clic o «1» para 1:1, «0» para ajustar,
// ← y → entre las imágenes del hilo. Acciones: abrir con la app del sistema y
// mostrar en la carpeta (si hay ruta en disco), copiar y guardar.

import { useEffect, useRef, useState } from "react";
import { reportError } from "../bootstrap";
import { useApi } from "../context";
import { setUi, stepViewer, useUi, type ViewerItem } from "../ui";
import { IconClose } from "./icons";

const MIN_SCALE = 0.2;
const MAX_SCALE = 12;
const STEP = 1.15;

export interface View {
  scale: number;
  x: number;
  y: number;
}

const FIT: View = { scale: 1, x: 0, y: 0 };

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** Nuevo zoom; sin ampliación no hay nada que desplazar, así que vuelve al centro. */
export function zoomTo(v: View, scale: number): View {
  const next = clampScale(scale);
  return next <= 1 ? { scale: next, x: 0, y: 0 } : { ...v, scale: next };
}

/** Los botones de navegación viven dentro de la superficie de arrastre. */
export function fromButton(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("button") !== null;
}

/** PNG en el portapapeles a partir de cualquier imagen cargada. */
async function copyImage(img: HTMLImageElement): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d")?.drawImage(img, 0, 0);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!blob) throw new Error("no se pudo convertir la imagen");
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

function dataUrlOf(img: HTMLImageElement): string {
  if (img.src.startsWith("data:")) return img.src;
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d")?.drawImage(img, 0, 0);
  return canvas.toDataURL("image/png");
}

function Actions({ item, img }: { item: ViewerItem; img: React.RefObject<HTMLImageElement | null> }) {
  const api = useApi();
  const [note, setNote] = useState<string | null>(null);
  const flash = (t: string) => {
    setNote(t);
    window.setTimeout(() => setNote(null), 1600);
  };
  const run = (p: Promise<unknown>, ok?: string) => p.then(() => ok && flash(ok)).catch(reportError);
  return (
    <span className="viewer-acts">
      {note && <span className="live-tag">{note}</span>}
      {item.path && <button onClick={() => run(api.openImage(item.path ?? ""))}>Abrir</button>}
      {item.path && <button onClick={() => run(api.revealPath(item.path ?? ""))}>Carpeta</button>}
      <button onClick={() => img.current && run(copyImage(img.current), "Copiada")}>Copiar</button>
      <button onClick={() => img.current && run(api.saveImage(dataUrlOf(img.current), item.caption).then((p) => p && flash("Guardada")))}>Guardar</button>
    </span>
  );
}

export function ImageViewer() {
  const viewer = useUi((s) => s.viewer);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [view, setView] = useState<View>(FIT);
  const item = viewer ? viewer.items[viewer.index] : null;
  const many = (viewer?.items.length ?? 0) > 1;

  useEffect(() => setView(FIT), [item?.src]);

  useEffect(() => {
    if (!viewer) return;
    const prev = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setUi((s) => ({ ...s, viewer: null }));
      else if (e.key === "ArrowLeft") stepViewer(-1);
      else if (e.key === "ArrowRight") stepViewer(1);
      else if (e.key === "+" || e.key === "=") setView((v) => zoomTo(v, v.scale * STEP));
      else if (e.key === "-") setView((v) => zoomTo(v, v.scale / STEP));
      else if (e.key === "0") setView(FIT);
      else if (e.key === "1") oneToOne();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus();
    };
    // `viewer` cambia al pasar de imagen; el listener solo depende de que exista.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(viewer)]);

  useEffect(() => {
    const el = img.current;
    if (!el) return;
    el.style.setProperty("transform", `translate(${view.x}px, ${view.y}px) scale(${view.scale})`);
  }, [view]);

  function oneToOne() {
    const el = img.current;
    if (!el || !el.clientWidth) return;
    setView({ scale: clampScale(el.naturalWidth / el.clientWidth), x: 0, y: 0 });
  }

  if (!viewer || !item) return null;
  const close = () => setUi((s) => ({ ...s, viewer: null }));
  const zoomPct = Math.round(view.scale * 100);
  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={`Imagen: ${item.caption}`} onClick={close}>
      <div className="viewer-bar" onClick={(e) => e.stopPropagation()}>
        <span className="viewer-cap">{item.caption}{many ? ` · ${viewer.index + 1}/${viewer.items.length}` : ""} · {zoomPct} %</span>
        <Actions item={item} img={img} />
        <button ref={closeBtn} onClick={close}><IconClose /> Cerrar</button>
      </div>
      <div
        className="viewer-img"
        data-zoomed={view.scale > 1 || undefined}
        onClick={(e) => e.stopPropagation()}
        onWheel={(e) => setView((v) => zoomTo(v, v.scale * (e.deltaY < 0 ? STEP : 1 / STEP)))}
        onPointerDown={(e) => {
          // Capturar el puntero desde una flecha desviaba su `click` al
          // contenedor y la flecha no respondía; sin zoom no hay arrastre.
          if (fromButton(e.target) || view.scale <= 1) return;
          drag.current = { x: e.clientX - view.x, y: e.clientY - view.y };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current || view.scale <= 1) return;
          const start = drag.current;
          setView((v) => ({ ...v, x: e.clientX - start.x, y: e.clientY - start.y }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onDoubleClick={(e) => {
          // Dos clics seguidos en una flecha no deben ampliar la imagen.
          if (fromButton(e.target)) return;
          if (view.scale === 1) oneToOne();
          else setView(FIT);
        }}
      >
        <img ref={img} src={item.src} alt={item.caption} draggable={false} />
        {many && (
          <>
            <button className="viewer-nav prev" aria-label="Anterior" onClick={() => stepViewer(-1)}>‹</button>
            <button className="viewer-nav next" aria-label="Siguiente" onClick={() => stepViewer(1)}>›</button>
          </>
        )}
      </div>
    </div>
  );
}
