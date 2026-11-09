import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import { confirmDialog } from "../../lib/dialog";
import { OPEN_ONBOARDING_EVENT } from "../Onboarding";
import { REBUILD_STARTED_MESSAGE, startRebuild } from "./rebuildFlow";
import { SettingsSwitch } from "./SettingsSwitch";

// ---------------------------------------------------------------------------
// LifecyclePanel — autostart toggle + Rebuild + Close + global hotkey.
// "Check for updates" removed (the user owns the binary).
// "Uninstall" removed (deprecated).
// v2.5.2 (wave 2): merged the "Show/hide Control Center" global hotkey
// editor from the old GeneralSection — it was the only hotkey worth
// keeping (in-app + project hotkeys were retired).
// ---------------------------------------------------------------------------

// HotkeyEditor inlined from the deleted GeneralSection. Single global
// shortcut to show/hide the Control Center.
function HotkeyEditor() {
  const [spec, setSpec] = useState<string>("");
  const [draft, setDraft] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    invoke<string>("get_global_hotkey")
      .then((s) => {
        setSpec(s);
        setDraft(s);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (capturing) inputRef.current?.focus();
  }, [capturing]);

  async function apply() {
    if (!draft.trim() || draft === spec) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const r = await invoke<string>("set_global_hotkey", { spec: draft.trim() });
      setSpec(r);
      setDraft(r);
      setSuccess(`Registrado: ${r}`);
      window.setTimeout(() => setSuccess(null), 2500);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function onCapture(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (["Control", "Alt", "Shift", "Meta", "OS"].includes(e.key)) return;
    const parts: string[] = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Meta");
    let k = e.key;
    if (k.length === 1) k = k.toUpperCase();
    parts.push(k);
    setDraft(parts.join("+"));
    setCapturing(false);
  }

  return (
    <div
      className="rounded p-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border-strong)",
      }}
    >
      <div className="flex items-baseline justify-between">
        <div className="text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
          Atajo para abrir ULTRON
        </div>
        <span
          className="text-[10.5px]"
          style={{ color: "var(--color-text-tertiary)", fontFamily: "var(--font-mono)" }}
        >
          ~/.ultron/.tmp/hotkey.txt
        </span>
      </div>
      <p
        className="mt-1 text-[11.5px] leading-relaxed"
        style={{ color: "var(--color-text-secondary)" }}
      >
        Pulsa esta combinación en cualquier app de Windows para mostrar u ocultar el
        Control Center. Formato: <span style={{ fontFamily: "var(--font-mono)" }}>Ctrl+Alt+U</span>,
        <span style={{ fontFamily: "var(--font-mono)" }}> Ctrl+Shift+F12</span>, etc.
        Necesita al menos un modificador.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onCapture}
          placeholder="Ctrl+Alt+U"
          className="rounded px-3 py-1.5 text-[12.5px]"
          style={{
            background: "var(--color-surface-1)",
            color: "var(--color-text)",
            border: `1px solid ${capturing ? "var(--color-accent)" : "var(--color-border-strong)"}`,
            outline: "none",
            fontFamily: "var(--font-mono)",
            minWidth: 220,
          }}
        />
        <button
          type="button"
          onClick={() => setCapturing(!capturing)}
          className="rounded px-2.5 py-1 text-[11.5px]"
          style={{
            background: capturing ? "var(--color-surface-3)" : "transparent",
            color: capturing ? "var(--color-text)" : "var(--color-text-tertiary)",
            border: `1px solid ${capturing ? "var(--color-border-strong)" : "var(--color-border)"}`,
          }}
        >
          {capturing ? "Cancelar captura" : "Capturar tecla"}
        </button>
        <button
          type="button"
          onClick={() => void apply()}
          disabled={busy || !draft.trim() || draft === spec}
          className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {busy ? "Aplicando…" : "Aplicar"}
        </button>
        <span className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          activo:{" "}
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }}>
            {spec || "—"}
          </span>
        </span>
      </div>

      {error && (
        <div
          className="mt-3 rounded px-2 py-1 text-[11.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}
      {success && (
        <div
          className="mt-3 rounded px-2 py-1 text-[11.5px]"
          style={{
            background: "rgba(63, 185, 80, 0.08)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {success}
        </div>
      )}
    </div>
  );
}

export function LifecyclePanel() {
  const [autostartEnabled, setAutostartEnabled] = useState<boolean | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // --- autostart helpers ---

  async function purgeLegacy(): Promise<void> {
    try {
      await invoke("purge_legacy_autostart");
    } catch {
      // best-effort
    }
  }

  useEffect(() => {
    (async () => {
      await purgeLegacy();
      try {
        setAutostartEnabled(await isAutostartEnabled());
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  async function toggleAutostart() {
    if (autostartEnabled === null) return;
    setAutostartBusy(true);
    setError(null);
    try {
      if (autostartEnabled) {
        await disableAutostart();
        setAutostartEnabled(false);
      } else {
        await enableAutostart();
        setAutostartEnabled(true);
      }
      await purgeLegacy();
    } catch (e) {
      setError(String(e));
    } finally {
      setAutostartBusy(false);
    }
  }

  // --- rebuild helper ---

  async function rebuild() {
    setBusy("update");
    setError(null);
    setStatus(null);
    try {
      const outcome = await startRebuild();
      if (outcome === "started") setStatus(REBUILD_STARTED_MESSAGE);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function closeControlCenter() {
    const msg =
      "¿Cerrar ULTRON Control Center?\n\nSale de la app por completo. Los atajos globales dejan de funcionar hasta que vuelvas a abrirla.";
    const ok = await confirmDialog(msg, { title: "Cerrar Control Center", kind: "warning" });
    if (!ok) return;
    try {
      await invoke("close_control_center");
    } catch (e) {
      console.error("close_control_center failed", e);
    }
  }

  return (
    <div className="space-y-4">
      {status && (
        <div
          className="rounded p-3 text-[12px]"
          style={{
            background: "rgba(63, 185, 80, 0.06)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {status}
        </div>
      )}
      {error && (
        <div
          className="rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {/* Global hotkey (only hotkey kept after v2.5.2 wave 2 — the in-app
          and project hotkey editors were retired). */}
      <HotkeyEditor />

      {/* Start with Windows */}
      <div
        className="flex items-center justify-between gap-4 rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border-strong)",
        }}
      >
        <div className="min-w-0">
          <div className="text-[13px] font-semibold">Iniciar con Windows</div>
          <p className="mt-0.5 text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
            Abre el Control Center al iniciar sesión en Windows mediante{" "}
            <code style={{ fontFamily: "var(--font-mono)" }}>HKCU\...\Run</code>.
          </p>
        </div>
        <SettingsSwitch
          checked={autostartEnabled === true}
          onChange={() => void toggleAutostart()}
          disabled={autostartBusy || autostartEnabled === null}
          label="Iniciar con Windows"
          title={autostartEnabled ? "Desactivar el inicio automático" : "Activar el inicio automático"}
        />
      </div>

      {/* Rebuild from source */}
      <div
        className="rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border-strong)",
        }}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">Recompilar desde el código</div>
            <p className="mt-0.5 text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
              Abre una terminal que hace git pull, npm install y{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>npm run build:local</code>{" "}
              (con Finance si están sus fuentes locales). ULTRON sigue abierto: el build aparta el
              ejecutable en uso y el binario nuevo entra al reiniciar la app.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void rebuild()}
            disabled={busy !== null}
            className="shrink-0 rounded px-4 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {busy === "update" ? "Abriendo…" : "Recompilar"}
          </button>
        </div>
      </div>

      {/* Pantalla de bienvenida (el pie del onboarding remite aquí) */}
      <div
        className="flex items-center justify-between gap-4 rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border-strong)",
        }}
      >
        <div className="min-w-0">
          <div className="text-[13px] font-semibold">Pantalla de bienvenida</div>
          <p className="mt-0.5 text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
            Vuelve a mostrar la introducción del primer arranque: pestañas principales y glosario.
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event(OPEN_ONBOARDING_EVENT))}
          className="shrink-0 rounded px-4 py-1.5 text-[12.5px] font-medium transition-colors"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          Mostrar
        </button>
      </div>

      {/* Close Control Center */}
      <div
        className="rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border-strong)",
        }}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">Cerrar Control Center</div>
            <p className="mt-0.5 text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
              Sale del proceso por completo (la X solo lo minimiza a la bandeja).
            </p>
          </div>
          <button
            type="button"
            onClick={() => void closeControlCenter()}
            disabled={busy !== null}
            className="shrink-0 rounded px-4 py-1.5 text-[12.5px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-danger)",
              border: "1px solid rgba(248, 81, 73, 0.32)",
            }}
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
