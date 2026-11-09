// Abrir un prompt de la IA en Sessions (la ventana de chat de ULTRON).
//
// Los botones de IA de Plans y Library lanzaban `spawn_session`, que abre
// Windows Terminal fuera de ULTRON: la conversación no quedaba en Sessions
// (sin cola, sin historial, sin avisos). Este helper crea la sesión en el
// directorio pedido, le manda el prompt por la cola de Sessions (si Claude
// aún arranca, el envío espera turno) y enfoca la ventana.

import { invoke } from "@tauri-apps/api/core";

export interface OpenInSessionsOptions {
  /** Directorio de trabajo de la sesión (obligatorio en Sessions). */
  cwd: string;
  prompt: string;
  /**
   * Modo de permisos explícito. `"default"` fuerza permisos normales aunque
   * el perfil de lanzamiento de Sessions use otro (contenido ajeno o flujos
   * que antes mandaban `dangerouslySkipPermissions: false`); sin valor manda
   * la preferencia de Sessions.
   */
  permissionMode?: "default";
}

export interface OpenInSessionsResult {
  sessionId: string;
  /** El prompt quedó escrito o en la cola de la sesión. */
  sent: boolean;
  /** Si no se pudo enviar, el prompt se copia al portapapeles. */
  copied: boolean;
  /** Motivo del fallo de envío o de foco; `null` si todo fue bien. */
  warning: string | null;
}

interface SessionInfoLite {
  id: string;
}

function newClientId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `cc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Crea la sesión, envía el prompt y enfoca Sessions. Lanza si no se pudo
 * crear la sesión; un fallo posterior (envío o foco) se devuelve en
 * `warning` para que el botón lo diga en vez de quedarse callado.
 */
export async function openPromptInSessions(
  opts: OpenInSessionsOptions,
): Promise<OpenInSessionsResult> {
  const cwd = opts.cwd.trim();
  if (!cwd) throw new Error("Sessions necesita un directorio de trabajo para este prompt.");
  const info = await invoke<SessionInfoLite>("sesiones_create", {
    cwd,
    ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
  });
  const warnings: string[] = [];
  let sent = false;
  let copied = false;
  if (opts.prompt.trim()) {
    try {
      await invoke("sesiones_send", {
        id: info.id,
        text: opts.prompt,
        clientId: newClientId(),
      });
      sent = true;
    } catch (e) {
      warnings.push(`no se pudo enviar el prompt (${String(e)})`);
      try {
        await navigator.clipboard.writeText(opts.prompt);
        copied = true;
      } catch (copyErr) {
        warnings.push(`ni copiar al portapapeles (${String(copyErr)})`);
      }
    }
  }
  try {
    await invoke("sesiones_focus_session", { sessionId: info.id });
  } catch (e) {
    warnings.push(`no se pudo enfocar la ventana de Sessions (${String(e)})`);
  }
  return {
    sessionId: info.id,
    sent,
    copied,
    warning: warnings.length > 0 ? warnings.join("; ") : null,
  };
}

/** Texto para la barra de estado del botón que lanzó la sesión. */
export function openInSessionsMessage(label: string, r: OpenInSessionsResult): string {
  if (!r.warning) return `${label}: abierto en Sessions y prompt enviado.`;
  if (r.copied) {
    return `${label}: abierto en Sessions, pero ${r.warning}. El prompt está en el portapapeles: pégalo con Ctrl+V.`;
  }
  return `${label}: abierto en Sessions, pero ${r.warning}.`;
}

/**
 * Carpeta de `~/.ultron/instructions/<kind>` (GUIDE.md y esquemas): cwd neutro
 * de ULTRON para los flujos de IA que no pertenecen a un proyecto.
 */
export async function instructionsCwd(kind: "skills" | "mcps" | "plans"): Promise<string> {
  return (await invoke("instruction_path", { kind })) as string;
}
