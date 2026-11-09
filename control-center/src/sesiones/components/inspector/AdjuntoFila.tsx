// Fila de un adjunto de la pestaña Adjuntos: miniatura (imagen) o insignia
// por extensión, nombre con la ruta absoluta en el tooltip y acciones Abrir,
// Abrir carpeta y Copiar ruta. Un fichero que ya no está en disco se marca
// como ausente con el motivo y sus acciones quedan desactivadas con
// explicación (nunca un botón que no hace nada).

import { useEffect, useState } from "react";
import { reportError } from "../../bootstrap";
import { useApi } from "../../context";
import type { PathStatus } from "../../types";
import { openViewer } from "../../ui";
import type { AttachmentItem } from "./adjuntos-collect";

const KINDS: [RegExp, string][] = [
  [/\.(mp4|webm|mov|mkv|avi|m4v|wmv)$/i, "video"],
  [/\.(mp3|wav|ogg|flac|m4a|aac|opus)$/i, "audio"],
  [/\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i, "imagen"],
  [/\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|md|txt|csv|log)$/i, "doc"],
  [/\.(zip|7z|gz|tar|rar)$/i, "archivo"],
];

function kindOf(name: string): string {
  return KINDS.find(([re]) => re.test(name))?.[1] ?? "fichero";
}

function ExtBadge({ name }: { name: string }) {
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toUpperCase() ?? "?";
  return <span className={`adj-ext adj-${kindOf(name)}`} aria-hidden="true">{ext}</span>;
}

function Preview({ it, path, isReady }: { it: AttachmentItem; path: string | undefined; isReady: boolean }) {
  const api = useApi();
  const [src, setSrc] = useState<string | null>(it.src ?? null);
  const [failed, setFailed] = useState(false);
  const canRead = it.isImage && !it.src && !!path && isReady;
  useEffect(() => {
    if (!canRead || !path) return;
    let alive = true;
    api.readImage(path).then(
      (url) => alive && setSrc(url),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [api, canRead, path]);
  if (!src || failed) return <ExtBadge name={it.name} />;
  return (
    <button className="adj-thumb" title="Ver la imagen" onClick={() => openViewer(src, it.name, path)}>
      <img src={src} alt="" />
    </button>
  );
}

function CopyPath({ path }: { path: string }) {
  const [done, setDone] = useState(false);
  const copy = () =>
    navigator.clipboard.writeText(path).then(() => {
      setDone(true);
      window.setTimeout(() => setDone(false), 1400);
    }, reportError);
  return (
    <button className="btn sm ghost" title={`Copiar ${path}`} onClick={() => void copy()}>
      {done ? "Copiada" : "Copiar ruta"}
    </button>
  );
}

/** Motivo de no poder actuar sobre el fichero, o `null` si se puede. */
function blockedReason(it: AttachmentItem, st: PathStatus | undefined, isChecking: boolean): string | null {
  if (!it.path) return "Solo existe en la conversación: no hay fichero en disco.";
  if (isChecking) return "Comprobando si el fichero existe…";
  if (st && !(st.exists && st.isFile)) return `No está en disco: ${st.error ?? it.path}`;
  return null;
}

export function AdjuntoFila({ it, st, isChecking, cwd }: { it: AttachmentItem; st: PathStatus | undefined; isChecking: boolean; cwd: string | undefined }) {
  const api = useApi();
  const path = st?.abs ?? it.path;
  const blocked = blockedReason(it, st, isChecking && !st);
  const isMissing = !!it.path && !!st && !(st.exists && st.isFile);
  const openBlocked = blocked ?? (st && !st.canOpen ? "Por seguridad, este tipo de fichero no se abre desde aquí (podría ejecutarse): usa «Abrir carpeta»." : null);
  return (
    <div className={`adj-row${isMissing ? " missing" : ""}`} data-testid="adjunto">
      <Preview it={it} path={path} isReady={!!st?.exists} />
      <div className="adj-body">
        <span className="adj-name" title={path ?? it.name}>{it.name}</span>
        {isMissing ? <span className="err-text">{blocked}</span> : <span className="adj-path" title={path}>{path ?? "sin fichero en disco"}</span>}
        {path && (
          <div className="adj-acts">
            <button className="btn sm" disabled={!!openBlocked} title={openBlocked ?? `Abrir ${path} con la app del sistema`}
              onClick={() => void api.openFile(path, cwd).catch(reportError)}>Abrir</button>
            <button className="btn sm" disabled={!!blocked} title={blocked ?? `Mostrar ${it.name} en el Explorador`}
              onClick={() => void api.revealPath(path, cwd).catch(reportError)}>Abrir carpeta</button>
            <CopyPath path={path} />
          </div>
        )}
      </div>
    </div>
  );
}
