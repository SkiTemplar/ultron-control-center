// Ruta real en disco de un `File`, que el navegador no expone: la da el host de
// WebView2 (`src-tauri/src/sesiones/ruta_fichero.rs`). Devuelve `null` fuera de
// WebView2, si el `File` no viene del disco (imagen pegada: la API lanza) o si
// el host no contesta; el llamante recurre entonces a copiar el fichero.

const TIMEOUT_MS = 3000;

interface WebviewHost {
  postMessageWithAdditionalObjects(message: string, objects: readonly unknown[]): void;
  addEventListener(type: "message", listener: (e: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (e: { data: unknown }) => void): void;
}

let lastId = 0;

function webviewHost(): WebviewHost | null {
  const host = (window as unknown as { chrome?: { webview?: Partial<WebviewHost> } }).chrome?.webview;
  return host?.postMessageWithAdditionalObjects ? (host as WebviewHost) : null;
}

export function localFilePath(file: File): Promise<string | null> {
  const host = webviewHost();
  if (!host) return Promise.resolve(null);
  lastId += 1;
  const id = `f${lastId}`;
  return new Promise((resolve) => {
    const finish = (path: string | null) => {
      window.clearTimeout(timer);
      host.removeEventListener("message", onMessage);
      resolve(path);
    };
    const onMessage = ({ data }: { data: unknown }) => {
      const reply = data as { ultronFilePath?: unknown; path?: unknown } | null;
      if (reply?.ultronFilePath !== id) return;
      finish(typeof reply.path === "string" && reply.path ? reply.path : null);
    };
    const timer = window.setTimeout(() => finish(null), TIMEOUT_MS);
    host.addEventListener("message", onMessage);
    try {
      host.postMessageWithAdditionalObjects(`ultronFilePath:${id}`, [file]);
    } catch {
      finish(null);
    }
  });
}
