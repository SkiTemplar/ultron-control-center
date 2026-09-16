// ULTRON Control Center — AI Router: Modelo local (Ollama)
//
// Seccion de gestion del modelo local usado como autocompletado de codigo
// (interruptor de bandeja + extension de VS Code, ver
// plugins/vscode-ollama-tab). Consume los comandos de
// src-tauri/src/ollama/commands.rs:
//
//   ollama_status      — estado completo (instalado, servidor, version,
//                         modelo configurado, cargados, descargados)
//   ollama_activate    — carga el modelo en memoria (keep_alive: -1)
//   ollama_deactivate  — lo descarga de memoria
//   ollama_set_model   — cambia el modelo elegido (persiste + recarga si
//                         el anterior estaba cargado)
//   ollama_benchmark   — mide latencia con 5 peticiones FIM en caliente
//   ollama_pull        — descarga un modelo del registro (progreso via el
//                         evento "ollama_pull_progress")
//   ollama_delete      — borra un modelo de disco
//
// Refresco: sondeo cada 5 s mientras el componente esta montado (deja de
// sondear solo con desmontarlo — no hace falta trackear visibilidad
// aparte porque el padre, RouterDashboard, ya se desmonta al cambiar de
// sub-pestaña de AI Router).

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Tipos — espejo de src-tauri/src/ollama/api.rs
// ---------------------------------------------------------------------------

interface LoadedModel {
  name: string;
  size_vram: number;
  expires_at: string | null;
}

interface DownloadedModel {
  name: string;
  size: number;
  family: string | null;
  parameter_size: string | null;
  quantization_level: string | null;
}

type ConfiguredModelSource = "env" | "config" | "default";

interface OllamaStatus {
  installed: boolean;
  server_up: boolean;
  version: string | null;
  configured_model: string;
  configured_model_source: ConfiguredModelSource;
  loaded_models: LoadedModel[];
  downloaded_models: DownloadedModel[];
}

interface BenchmarkResult {
  model: string;
  samples_ms: number[];
  median_ms: number;
  max_ms: number;
  suggested_line: string;
}

interface PullProgressEvent {
  model: string;
  status: string;
  completed: number | null;
  total: number | null;
  percent: number | null;
  done: boolean;
  error: string | null;
}

const POLL_MS = 5_000;

const SOURCE_LABEL: Record<ConfiguredModelSource, string> = {
  env: "variable de entorno ULTRON_OLLAMA_MODEL",
  config: "elegido en esta pantalla",
  default: "valor por defecto",
};

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

/** "fijado" cuando Ollama devuelve un `expires_at` muy lejano en el futuro
 * (así es como marca `keep_alive: -1` — visto en runtime: ~300 años
 * vista). Si no, se muestra la hora local de expiracion. */
function formatExpiry(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return null;
  const yearsAhead = (date.getTime() - Date.now()) / (365 * 24 * 60 * 60 * 1000);
  if (yearsAhead > 10) return "fijado (sin expiracion)";
  if (yearsAhead < 0) return "expirado";
  return `hasta ${date.toLocaleTimeString()}`;
}

export function OllamaControl() {
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [benchmarking, setBenchmarking] = useState(false);
  const [benchmark, setBenchmarkResult] = useState<BenchmarkResult | null>(null);
  const [benchmarkError, setBenchmarkError] = useState<string | null>(null);

  const [pullName, setPullName] = useState("");
  const [pulling, setPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState<PullProgressEvent | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  const pullingModelRef = useRef<string | null>(null);

  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<OllamaStatus>("ollama_status");
      setStatus(s);
      setStatusError(null);
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Progreso de descarga — filtrado por el modelo que se esta pidiendo
  // ahora mismo (el evento es global; otra sesion/ventana podria emitirlo).
  useEffect(() => {
    const unlistenPromise = listen<PullProgressEvent>("ollama_pull_progress", (e) => {
      if (e.payload.model !== pullingModelRef.current) return;
      setPullProgress(e.payload);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const isLoaded = status?.loaded_models.some((m) => m.name === status.configured_model) ?? false;
  const isDownloaded =
    status?.downloaded_models.some((m) => m.name === status.configured_model) ?? false;

  const toggleActivation = useCallback(async () => {
    if (!status) return;
    setBusy(true);
    setActionError(null);
    try {
      if (isLoaded) {
        await invoke("ollama_deactivate", { model: status.configured_model });
      } else {
        await invoke("ollama_activate", { model: status.configured_model });
      }
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [status, isLoaded, refresh]);

  const changeModel = useCallback(
    async (name: string) => {
      setBusy(true);
      setActionError(null);
      try {
        const s = await invoke<OllamaStatus>("ollama_set_model", { name });
        setStatus(s);
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const runBenchmark = useCallback(async () => {
    if (!status) return;
    setBenchmarking(true);
    setBenchmarkError(null);
    setBenchmarkResult(null);
    try {
      const r = await invoke<BenchmarkResult>("ollama_benchmark", {
        model: status.configured_model,
      });
      setBenchmarkResult(r);
    } catch (e) {
      setBenchmarkError(e instanceof Error ? e.message : String(e));
    } finally {
      setBenchmarking(false);
    }
  }, [status]);

  const startPull = useCallback(async () => {
    const name = pullName.trim();
    if (!name) return;
    pullingModelRef.current = name;
    setPulling(true);
    setPullError(null);
    setPullProgress(null);
    try {
      await invoke("ollama_pull", { name });
      setPullName("");
      await refresh();
    } catch (e) {
      setPullError(e instanceof Error ? e.message : String(e));
    } finally {
      setPulling(false);
      pullingModelRef.current = null;
    }
  }, [pullName, refresh]);

  const confirmAndDelete = useCallback(
    async (name: string) => {
      setDeleting(true);
      setDeleteError(null);
      try {
        await invoke("ollama_delete", { name });
        setConfirmDelete(null);
        await refresh();
      } catch (e) {
        setDeleteError(e instanceof Error ? e.message : String(e));
      } finally {
        setDeleting(false);
      }
    },
    [refresh],
  );

  // -- Estado derivado para el badge --
  let badgeLabel = "comprobando…";
  let badgeColor = "var(--color-text-tertiary)";
  if (status) {
    if (!status.installed) {
      badgeLabel = "no instalado";
      badgeColor = "var(--color-text-faint, #555)";
    } else if (!status.server_up) {
      badgeLabel = "servidor parado";
      badgeColor = "var(--color-warn, #facc15)";
    } else if (busy) {
      badgeLabel = "trabajando…";
      badgeColor = "var(--color-warn, #facc15)";
    } else if (isLoaded) {
      badgeLabel = "cargado";
      badgeColor = "var(--color-success, #4ade80)";
    } else if (isDownloaded) {
      badgeLabel = "descargado (no cargado)";
      badgeColor = "var(--color-text-tertiary)";
    } else {
      badgeLabel = "modelo no descargado";
      badgeColor = "var(--color-danger, #f87171)";
    }
  } else if (statusError) {
    badgeLabel = "error";
    badgeColor = "var(--color-danger, #f87171)";
  }

  const loadedInfo = status?.loaded_models.find((m) => m.name === status.configured_model);

  return (
    <div>
      <div
        className="rounded-lg border p-5"
        style={{ background: "var(--color-surface-2)", borderColor: "var(--color-border)" }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>
                {status?.configured_model ?? "Modelo local"}
              </span>
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: badgeColor,
                  flexShrink: 0,
                }}
                title={badgeLabel}
              />
              <span className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                {badgeLabel}
              </span>
              {status?.version && (
                <span
                  className="rounded px-1.5 py-px text-[10.5px] font-medium"
                  style={{
                    fontFamily: "var(--font-mono)",
                    background: "var(--color-surface-3)",
                    color: "var(--color-text-secondary)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  ollama {status.version}
                </span>
              )}
            </div>
            <p className="text-[12px] leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
              Modelo elegido por {status ? SOURCE_LABEL[status.configured_model_source] : "…"}.
              {loadedInfo && (
                <>
                  {" "}
                  VRAM: {formatBytes(loadedInfo.size_vram)}
                  {formatExpiry(loadedInfo.expires_at) ? ` · ${formatExpiry(loadedInfo.expires_at)}` : ""}.
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void toggleActivation()}
            disabled={busy || !status?.installed}
            className="shrink-0 rounded-full px-5 py-2 text-[13px] font-semibold transition-colors"
            style={{
              background: isLoaded ? "var(--color-success, #4ade80)" : "var(--color-surface-3)",
              color: isLoaded ? "#062b13" : "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
              opacity: busy || !status?.installed ? 0.6 : 1,
              cursor: busy || !status?.installed ? "not-allowed" : "pointer",
              minWidth: 100,
            }}
          >
            {busy ? "…" : isLoaded ? "Desactivar" : "Activar"}
          </button>
        </div>

        {!status?.installed && status && (
          <div
            className="mt-3 rounded p-2.5 text-[11.5px] leading-relaxed"
            style={{
              background: "var(--color-surface-3)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-secondary)",
            }}
          >
            Ollama no esta instalado (no se encontro <code className="font-mono">ollama.exe</code> en
            PATH ni en la ruta de instalacion por defecto). Instalalo desde{" "}
            <code className="font-mono">ollama.com/download</code> y activa la carga en frio tarda
            hasta ~45 s la primera vez.
          </div>
        )}

        {statusError && (
          <div className="mt-3 text-[11.5px]" style={{ color: "var(--color-danger)" }}>
            No se pudo consultar el estado: {statusError}
          </div>
        )}

        {actionError && (
          <div className="mt-3 text-[11.5px]" style={{ color: "var(--color-danger)" }}>
            {actionError}
          </div>
        )}

        {/* Selector de modelo */}
        {status && status.downloaded_models.length > 0 && (
          <div className="mt-4 flex items-center gap-2">
            <label className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
              Modelo:
            </label>
            <select
              value={status.configured_model}
              onChange={(e) => void changeModel(e.target.value)}
              disabled={busy}
              className="rounded px-2 py-1 text-[12px]"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border)",
              }}
            >
              {status.downloaded_models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                  {m.parameter_size ? ` (${m.parameter_size})` : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Latencia */}
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void runBenchmark()}
            disabled={benchmarking || !isLoaded}
            className="rounded px-3 py-1.5 text-[12px] font-medium"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
              opacity: benchmarking || !isLoaded ? 0.6 : 1,
              cursor: benchmarking || !isLoaded ? "not-allowed" : "pointer",
            }}
            title={!isLoaded ? "Activa el modelo antes de medir latencia" : undefined}
          >
            {benchmarking ? "Midiendo…" : "Medir latencia"}
          </button>
          {benchmark && (
            <span className="text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
              mediana {benchmark.median_ms} ms · máx {benchmark.max_ms} ms · sugerencia:{" "}
              <code className="font-mono">{benchmark.suggested_line || "(vacia)"}</code>
            </span>
          )}
        </div>
        {benchmarkError && (
          <div className="mt-2 text-[11.5px]" style={{ color: "var(--color-danger)" }}>
            {benchmarkError}
          </div>
        )}
      </div>

      {/* Descargar modelo nuevo */}
      <div className="mt-4 rounded-lg border p-4" style={{ borderColor: "var(--color-border)" }}>
        <h3 className="mb-2 text-[12.5px] font-semibold" style={{ color: "var(--color-text-secondary)" }}>
          Descargar modelo
        </h3>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={pullName}
            onChange={(e) => setPullName(e.target.value)}
            placeholder="p. ej. qwen2.5-coder:7b"
            disabled={pulling}
            className="min-w-0 flex-1 rounded px-2 py-1.5 text-[12px]"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
              fontFamily: "var(--font-mono)",
            }}
          />
          <button
            type="button"
            onClick={() => void startPull()}
            disabled={pulling || !pullName.trim()}
            className="shrink-0 rounded px-3 py-1.5 text-[12px] font-medium"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
              opacity: pulling || !pullName.trim() ? 0.6 : 1,
              cursor: pulling || !pullName.trim() ? "not-allowed" : "pointer",
            }}
          >
            {pulling ? "Descargando…" : "Descargar"}
          </button>
        </div>
        {pulling && (
          <div className="mt-2">
            <div
              className="h-1.5 w-full overflow-hidden rounded-full"
              style={{ background: "var(--color-surface-3)" }}
            >
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${pullProgress?.percent ?? 5}%`,
                  background: "var(--color-accent, #60a5fa)",
                }}
              />
            </div>
            <p className="mt-1 text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
              {pullProgress?.status ?? "iniciando…"}
              {pullProgress?.percent != null ? ` · ${pullProgress.percent}%` : ""}
            </p>
          </div>
        )}
        {pullError && (
          <div className="mt-2 text-[11.5px]" style={{ color: "var(--color-danger)" }}>
            {pullError}
          </div>
        )}
      </div>

      {/* Modelos descargados — borrar */}
      {status && status.downloaded_models.length > 0 && (
        <div className="mt-4 rounded-lg border p-4" style={{ borderColor: "var(--color-border)" }}>
          <h3 className="mb-2 text-[12.5px] font-semibold" style={{ color: "var(--color-text-secondary)" }}>
            Modelos en disco
          </h3>
          <div className="space-y-1.5">
            {status.downloaded_models.map((m) => {
              const loaded = status.loaded_models.some((l) => l.name === m.name);
              return (
                <div
                  key={m.name}
                  className="flex items-center justify-between gap-2 rounded px-2.5 py-1.5 text-[12px]"
                  style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
                >
                  <div className="min-w-0 flex-1">
                    <span className="font-mono" style={{ color: "var(--color-text)" }}>
                      {m.name}
                    </span>{" "}
                    <span style={{ color: "var(--color-text-tertiary)" }}>
                      {formatBytes(m.size)}
                      {m.quantization_level ? ` · ${m.quantization_level}` : ""}
                      {loaded ? " · cargado" : ""}
                    </span>
                  </div>
                  {confirmDelete === m.name ? (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="text-[11px]" style={{ color: "var(--color-danger)" }}>
                        ¿Borrar?
                      </span>
                      <button
                        type="button"
                        onClick={() => void confirmAndDelete(m.name)}
                        disabled={deleting}
                        className="rounded px-2 py-1 text-[11px] font-semibold"
                        style={{ background: "var(--color-danger, #f87171)", color: "#2a0a0a" }}
                      >
                        {deleting ? "…" : "Si"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(null)}
                        disabled={deleting}
                        className="rounded px-2 py-1 text-[11px]"
                        style={{
                          background: "var(--color-surface-3)",
                          color: "var(--color-text-secondary)",
                          border: "1px solid var(--color-border)",
                        }}
                      >
                        No
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(m.name)}
                      disabled={loaded}
                      className="shrink-0 rounded px-2 py-1 text-[11px]"
                      style={{
                        background: "var(--color-surface-3)",
                        color: "var(--color-text-secondary)",
                        border: "1px solid var(--color-border)",
                        opacity: loaded ? 0.5 : 1,
                        cursor: loaded ? "not-allowed" : "pointer",
                      }}
                      title={loaded ? "Descarga el modelo de memoria antes de borrarlo" : undefined}
                    >
                      Borrar
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {deleteError && (
            <div className="mt-2 text-[11.5px]" style={{ color: "var(--color-danger)" }}>
              {deleteError}
            </div>
          )}
        </div>
      )}

      <p className="mt-3 text-[11px]" style={{ color: "var(--color-text-faint)" }}>
        Interruptor rapido tambien disponible en la bandeja del sistema. Config persistida en{" "}
        <code className="font-mono">~/.ultron/cockpit/ollama/config.json</code>.
      </p>
    </div>
  );
}
