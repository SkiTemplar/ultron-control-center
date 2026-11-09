// ULTRON Control Center — Publicar la rama actual (RepoModal).
//
// Se ofrece cuando la rama no tiene upstream: rama nueva o repo sin remoto.
// Publicar empuja a un servidor, así que pide confirmación explícita. La URL
// solo hace falta si el repo no tiene remoto (el backend crea `origin`); si
// la URL sobra o falta, git_publish lo rechaza con el motivo, que RepoModal
// enseña en su barra de error sin cerrar la confirmación.

import { useState } from "react";

interface PublishBranchProps {
  branch: string;
  busy: boolean;
  /** Publica con la URL indicada (null = remoto existente). true si salió bien. */
  onPublish: (remoteUrl: string | null) => Promise<boolean>;
}

const buttonStyle = {
  background: "rgba(34,197,94,0.12)",
  border: "1px solid rgba(34,197,94,0.35)",
  color: "#22c55e",
};

export function PublishBranch({ branch, busy, onPublish }: PublishBranchProps) {
  const [confirming, setConfirming] = useState(false);
  const [url, setUrl] = useState("");

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={busy}
        className="rounded px-2 py-1 text-[11px] disabled:opacity-40"
        style={buttonStyle}
        title="La rama no tiene upstream: git push --set-upstream"
      >
        Publicar rama
      </button>
    );
  }

  const submit = async () => {
    const ok = await onPublish(url.trim() || null);
    if (ok) {
      setConfirming(false);
      setUrl("");
    }
  };

  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <input
        aria-label="URL del remoto (opcional)"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="URL del remoto, solo si no tiene"
        className="w-56 rounded px-2 py-1 outline-none"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border-strong)",
          color: "var(--color-text)",
        }}
      />
      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy}
        className="rounded px-2 py-1 disabled:opacity-40"
        style={buttonStyle}
      >
        Publicar {branch}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={busy}
        className="rounded px-2 py-1 disabled:opacity-40"
        style={{ border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}
      >
        Cancelar
      </button>
    </div>
  );
}
