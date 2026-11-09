// Adjuntos del composer: pegar, arrastrar o elegir. Lo que Claude Code puede leer
// se copia (base64 → sesiones_save_attachment); de lo demás basta la ruta original,
// sin tope de tamaño, y solo si no se puede obtener se copia también.

import { useCallback, useState } from "react";
import { useApi } from "../../context";
import type { SavedAttachment } from "../../types";
import { isReadable, MAX_BYTES } from "./attachment-kind";
import { localFilePath } from "./local-file-path";

export interface Attachment extends SavedAttachment {
  name: string;
  mediaType: string;
  /** Se envía solo su ruta en el texto, sin mención `@` (ver attachment-kind.ts). */
  isPathOnly?: boolean;
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("No se pudo leer el fichero"));
    reader.readAsDataURL(file);
  });
}

/** `initial`: adjuntos del borrador guardado de la sesión (ver drafts.ts). */
export function useAttachments(initial: readonly Attachment[] = []) {
  const api = useApi();
  const [items, setItems] = useState<Attachment[]>(() => [...initial]);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const add = useCallback(
    async (files: readonly File[]) => {
      setError(null);
      for (const file of files) {
        setBusy((n) => n + 1);
        try {
          const name = file.name || `pegado-${Date.now()}.png`;
          const mediaType = file.type || "application/octet-stream";
          const isPathOnly = !isReadable(name, file.size);
          const path = isPathOnly ? await localFilePath(file) : null;
          if (path) {
            const item: Attachment = { path, previewDataUrl: null, name, mediaType, isPathOnly };
            setItems((list) => (list.some((a) => a.path === path) ? list : [...list, item]));
            continue;
          }
          if (file.size > MAX_BYTES) {
            setError(`«${name}» supera los 20 MB y no se ha podido obtener su ruta en disco para enviarla.`);
            continue;
          }
          const saved = await api.saveAttachment({ name, dataBase64: await readBase64(file), mediaType });
          setItems((list) => [...list, { ...saved, name, mediaType, ...(isPathOnly ? { isPathOnly } : {}) }]);
        } catch (e) {
          setError(String(e));
        } finally {
          setBusy((n) => n - 1);
        }
      }
    },
    [api],
  );

  const remove = useCallback((path: string) => setItems((list) => list.filter((a) => a.path !== path)), []);
  const clear = useCallback(() => setItems([]), []);

  return { items, busy: busy > 0, error, add, remove, clear };
}
