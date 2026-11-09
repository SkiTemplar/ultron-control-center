// ULTRON Control Center — AI Router: Modelo local (Ollama)
//
// Sección del autocompletado de código. Un solo mando: el motor del editor
// (`ollamaTab.engine` en el settings.json de VS Code, ver
// plugins/vscode-ollama-tab): tres niveles locales de Ollama, Copilot o
// apagado. La bandeja del sistema usa el mismo mando (alterna entre el último
// motor local y Copilot). Consume los comandos de
// src-tauri/src/ollama/commands.rs:
//
//   ollama_status      — estado (instalado, servidor, versión, modelo del
//                         motor local de referencia, cargados, descargados)
//   editor_engine_status / editor_engine_set — lee y cambia el motor; al
//                         cambiar suelta los modelos que no tocan y carga
//                         el del motor elegido
//   ollama_benchmark   — mide latencia con 5 peticiones FIM en caliente
//   ollama_pull        — descarga un modelo del registro (progreso vía el
//                         evento "ollama_pull_progress")
//   ollama_delete      — borra un modelo de disco
//
// Etiquetas y estados derivados: ollamaEngine.ts (puro, con tests).
//
// Refresco: sondeo cada 5 s mientras el componente está montado (deja de
// sondear solo con desmontarlo — el padre, RouterDashboard, ya se desmonta
// al cambiar de sub-pestaña de AI Router).

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  benchmarkBlockReason,
  engineOptions,
  findLoaded,
  formatExpiry,
  headerState,
  isConfiguredDownloaded,
  isLocalEngine,
  modelSizeLabel,
  type EditorEngineStatus,
  type HeaderTone,
  type OllamaStatus,
} from "./ollamaEngine";

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

const TONE_COLOR: Record<HeaderTone, string> = {
  ok: "var(--color-success, #4ade80)",
  warn: "var(--color-warn, #facc15)",
  danger: "var(--color-danger, #f87171)",
  muted: "var(--color-text-tertiary)",
  accent: "var(--color-accent, #58a6ff)",
};

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function OllamaControl() {
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

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

  const [engine, setEngine] = useState<EditorEngineStatus | null>(null);
  const [engineBusy, setEngineBusy] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<OllamaStatus>("ollama_status"));
      setStatusError(null);
    } catch (e) {
      setStatusError(errorText(e));
    }
    try {
      setEngine(await invoke<EditorEngineStatus>("editor_engine_status"));
    } catch (e) {
      setEngineError(errorText(e));
    }
  }, []);

  // Cambiar de motor mueve modelos de VRAM: puede tardar segundos. Se
  // refresca también si falla, porque el settings.json puede haber cambiado
  // aunque la carga del modelo no.
  const changeEngine = useCallback(
    async (next: string) => {
      setEngineBusy(true);
      setEngineError(null);
      setBenchmarkResult(null);
      try {
        setEngine(await invoke<EditorEngineStatus>("editor_engine_set", { engine: next }));
      } catch (e) {
        setEngineError(errorText(e));
      } finally {
        await refresh();
        setEngineBusy(false);
      }
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Progreso de descarga — filtrado por el modelo que se está pidiendo
  // ahora mismo (el evento es global; otra sesión/ventana podría emitirlo).
  useEffect(() => {
    const unlistenPromise = listen<PullProgressEvent>("ollama_pull_progress", (e) => {
      if (e.payload.model !== pullingModelRef.current) return;
      setPullProgress(e.payload);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

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
      setBenchmarkError(errorText(e));
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
      setPullError(errorText(e));
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
        setDeleteError(errorText(e));
      } finally {
        setDeleting(false);
      }
    },
    [refresh],
  );

  const header = headerState(status, engine, statusError, engineBusy);
  const loadedInfo = findLoaded(status);
  const isLocal = engine ? isLocalEngine(engine.engine) : false;
  const benchmarkBlock = benchmarkBlockReason(status, engine);
  const benchmarkDisabled = benchmarking || benchmarkBlock !== null;
  const engineDisabled = engineBusy || !engine?.available;
  const options = engine ? engineOptions(engine) : [];

  return (
    <div>
      <div
        className="rounded-lg border p-5"
        style={{ background: "var(--color-surface-2)", borderColor: "var(--color-border)" }}
      >
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>
            {header.title}
          </span>
          <span
            style={{
              display: "inline-block",
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: TONE_COLOR[header.tone],
              flexShrink: 0,
            }}
            title={header.label}
          />
          <span className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            {header.label}
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
          {status && engine && !isLocal && (
            <>
              Motor local de reserva: <code className="font-mono">{status.configured_model}</code>{" "}
              ({modelSizeLabel(status.configured_model)}); se carga al volver a un motor local.
            </>
          )}
          {isLocal && loadedInfo && (
            <>
              VRAM: {formatBytes(loadedInfo.size_vram)}
              {formatExpiry(loadedInfo.expires_at) ? ` · ${formatExpiry(loadedInfo.expires_at)}` : ""}.
            </>
          )}
          {isLocal && status?.server_up && !loadedInfo && !engineBusy && (
            isConfiguredDownloaded(status) ? (
              <>El modelo del motor no está en memoria: vuelve a pulsar su botón para cargarlo.</>
            ) : (
              <>
                <code className="font-mono">{status.configured_model}</code> no está descargado:
                descárgalo abajo, en «Descargar modelo», antes de usar este motor.
              </>
            )
          )}
        </p>

        {status && !status.installed && (
          <div
            className="mt-3 rounded p-2.5 text-[11.5px] leading-relaxed"
            style={{
              background: "var(--color-surface-3)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-secondary)",
            }}
          >
            Ollama no está instalado (no se encontró <code className="font-mono">ollama.exe</code> en
            PATH ni en la ruta de instalación por defecto). Instálalo desde{" "}
            <code className="font-mono">ollama.com/download</code>; la primera carga en frío de un
            modelo tarda hasta ~45 s.
          </div>
        )}

        {statusError && (
          <div className="mt-3 text-[11.5px]" style={{ color: "var(--color-danger)" }}>
            No se pudo consultar el estado: {statusError}
          </div>
        )}

        {/* Motor de autocompletado del editor: el único mando */}
        <div className="mt-4">
          <div className="mb-1.5 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            Motor del editor:
          </div>
          <div className="flex flex-wrap gap-1.5">
            {options.map((o) => {
              const active = engine?.engine === o.engine;
              return (
                <button
                  key={o.engine}
                  type="button"
                  onClick={() => void changeEngine(o.engine)}
                  disabled={engineDisabled}
                  title={o.title}
                  className="rounded px-2.5 py-1 text-[12px] font-medium transition-colors"
                  style={{
                    background: active ? "var(--color-accent, #58a6ff)" : "var(--color-surface-3)",
                    color: active ? "#04121f" : "var(--color-text-secondary)",
                    border: "1px solid var(--color-border)",
                    opacity: engineDisabled ? 0.6 : 1,
                    cursor: engineDisabled ? "not-allowed" : "pointer",
                  }}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
          {engine && !engine.available && (
            <p className="mt-1.5 text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
              No se encontró el settings.json de VS Code: el motor no se puede cambiar desde aquí.
            </p>
          )}
          {engineError && (
            <p className="mt-1.5 text-[11px]" style={{ color: "var(--color-danger)" }}>
              {engineError}
            </p>
          )}
        </div>

        {/* Latencia */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void runBenchmark()}
            disabled={benchmarkDisabled}
            className="rounded px-3 py-1.5 text-[12px] font-medium"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
              opacity: benchmarkDisabled ? 0.6 : 1,
              cursor: benchmarkDisabled ? "not-allowed" : "pointer",
            }}
            title={benchmarkBlock ?? undefined}
          >
            {benchmarking ? "Midiendo…" : "Medir latencia"}
          </button>
          {benchmarkBlock && !benchmarking && (
            <span className="text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
              {benchmarkBlock}
            </span>
          )}
          {benchmark && (
            <span className="text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
              mediana {benchmark.median_ms} ms · máx {benchmark.max_ms} ms · sugerencia:{" "}
              <code className="font-mono">{benchmark.suggested_line || "(vacía)"}</code>
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
                      title={loaded ? "Está cargado: cambia de motor (Copilot o Apagado lo sueltan) antes de borrarlo" : undefined}
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
        El mismo mando está en la bandeja del sistema: alterna entre el último motor local y
        Copilot. El último motor local se guarda en{" "}
        <code className="font-mono">~/.ultron/cockpit/ollama/config.json</code>.
      </p>
    </div>
  );
}
