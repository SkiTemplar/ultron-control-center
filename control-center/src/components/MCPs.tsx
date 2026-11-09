import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { McpPingResult, McpMutationResult, SettingsSaveResult } from "../types";
import { useRoutingTitle } from "../lib/button-prompts";
import { notifyError } from "../lib/notify";
import { Card } from "./mcps/McpCard";
import { McpForm } from "./mcps/McpForm";
import { Modal } from "./mcps/Modal";
import type { EditableMcp, McpInfoExt } from "./mcps/types";
import {
  blankMcp,
  configToEditable,
  editableToConfig,
  parseOrigin,
  saveHidden,
  loadHidden,
  validateEditable,
} from "./mcps/utils";

const codeStyle = {
  fontFamily: "var(--font-mono)",
  background: "var(--color-surface-3)",
  color: "var(--color-text-primary)",
} as const;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function MCPs() {
  const [mcps, setMcps] = useState<McpInfoExt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => loadHidden());
  const [showHidden, setShowHidden] = useState(false);
  const [probing, setProbing] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  // P7: resultado del ping por servidor (botón «Probar»). Independiente del
  // JSON de la comprobación global: lanzar el proceso y hacer initialize es
  // mucho más fiable que leer mcp-health.json.
  const [pings, setPings] = useState<Record<string, McpPingResult>>({});
  const [pingBusy, setPingBusy] = useState<Set<string>>(new Set());
  // Estado activado/desactivado por tarjeta: nombre del MCP → activado.
  const [enabledMap, setEnabledMap] = useState<Record<string, boolean>>({});
  const [toggleBusy, setToggleBusy] = useState<Set<string>>(new Set());

  async function testMcp(name: string) {
    setPingBusy((s) => {
      const next = new Set(s);
      next.add(name);
      return next;
    });
    try {
      const r = (await invoke("mcp_ping", { name })) as McpPingResult;
      setPings((p) => ({ ...p, [name]: r }));
    } catch (e) {
      setPings((p) => ({
        ...p,
        [name]: {
          name,
          ok: false,
          latency_ms: null,
          error: String(e),
        },
      }));
    } finally {
      setPingBusy((s) => {
        const next = new Set(s);
        next.delete(name);
        return next;
      });
    }
  }
  const addWithAiTitle = useRoutingTitle(
    "mcps.add_with_ai",
    "Registra un servidor MCP nuevo con IA. cwd=instructions/mcps/ con GUIDE.md cargado automáticamente.",
  );

  // Modal state
  const [addOpen, setAddOpen] = useState(false);
  const [addModel, setAddModel] = useState<EditableMcp>(blankMcp());
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [editTarget, setEditTarget] = useState<string | null>(null);
  const [editModel, setEditModel] = useState<EditableMcp>(blankMcp());
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const deleteOrigin = mcps.find((m) => m.name === deleteTarget)?.origin;
  const [deleting, setDeleting] = useState(false);

  useEffect(() => saveHidden(hidden), [hidden]);

  // audit verify-audit-2 rank8: useCallback con deps [] para que el setInterval
  // del effect de abajo capture siempre la misma referencia y no se recree en
  // cada render. Las setters de useState son estables por garantía de React.
  const fetchList = useCallback(async () => {
    try {
      const list = (await invoke("list_mcps")) as McpInfoExt[];
      setMcps(list);
      setError(null);
      // Seed enabled/disabled state from the list itself: list_mcps marks
      // `disabled` both from the entry itself (`disabled: true`) AND from
      // Claude Code's `disabledMcpjsonServers` (project/.mcp.json scope), so
      // it's the single authoritative source — no separate settings read.
      const map: Record<string, boolean> = {};
      for (const m of list) map[m.name] = !m.disabled;
      setEnabledMap(map);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  async function toggleEnabled(name: string, origin?: string) {
    if (toggleBusy.has(name)) return;
    // Solo el ámbito proyecto tiene interruptor en Claude Code
    // (disabledMcpjsonServers). La tarjeta ya deshabilita el resto; si llega
    // aquí, se explica en vez de no hacer nada.
    if (!origin || !origin.startsWith("project:")) {
      showFlash(`'${name}' no tiene interruptor en Claude Code fuera del ámbito de proyecto.`);
      return;
    }
    setToggleBusy((s) => { const n = new Set(s); n.add(name); return n; });
    try {
      const wantDisabled = enabledMap[name] !== false; // toggling flips the state
      const res = (await invoke("mcp_set_disabled", {
        name,
        disabled: wantDisabled,
      })) as SettingsSaveResult;
      if (res.success) setEnabledMap((m) => ({ ...m, [name]: !wantDisabled }));
    } catch (e) {
      showFlash(`No se pudo cambiar el estado: ${e}`);
    } finally {
      setToggleBusy((s) => { const n = new Set(s); n.delete(name); return n; });
    }
  }

  // audit verify-audit-2 rank8: useCallback con deps [] — referencia estable
  // para el botón «Comprobar salud» sin recrear la función en cada render.
  const runProbe = useCallback(async () => {
    setProbing(true);
    try {
      // H15: chequeo real en Rust sobre la misma unión de fuentes que el
      // listado (el script antiguo solo leía settings.json).
      const list = (await invoke("mcp_health_check_all")) as McpInfoExt[];
      setMcps(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    void fetchList();
    const t = setInterval(() => void fetchList(), 30_000);
    return () => clearInterval(t);
  }, [fetchList]);

  function toggleHidden(name: string) {
    const next = new Set(hidden);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setHidden(next);
  }

  function showFlash(msg: string) {
    setFlash(msg);
    window.setTimeout(() => setFlash(null), 4500);
  }

  // -------------------------------------------------------------------------
  // Open Edit modal — reads the raw entry from ~/.claude.json (list_mcps
  // strips env, etc.).
  // -------------------------------------------------------------------------
  async function openEdit(name: string) {
    try {
      const cfg = (await invoke("mcp_get_config", { name })) as Record<string, unknown>;
      setEditModel(configToEditable(name, cfg));
      setEditTarget(name);
      setEditError(null);
    } catch (e) {
      showFlash(`No se pudo cargar la entrada: ${e}`);
    }
  }

  // -------------------------------------------------------------------------
  // Add
  // -------------------------------------------------------------------------
  async function submitAdd() {
    const err = validateEditable(addModel);
    if (err) {
      setAddError(err);
      return;
    }
    if (mcps.some((m) => m.name === addModel.name)) {
      setAddError(`'${addModel.name}' ya existe.`);
      return;
    }
    setAddSaving(true);
    setAddError(null);
    try {
      const config = editableToConfig(addModel);
      const res = (await invoke("add_mcp", {
        name: addModel.name,
        config,
      })) as McpMutationResult;
      setAddOpen(false);
      setAddModel(blankMcp());
      showFlash(
        `Añadido '${res.name}'. Backup: ${res.backup_path ?? "n/d"}. Reinicia Claude Code para que arranque el MCP nuevo.`,
      );
      await fetchList();
    } catch (e) {
      setAddError(String(e));
    } finally {
      setAddSaving(false);
    }
  }

  // -------------------------------------------------------------------------
  // Edit
  // -------------------------------------------------------------------------
  async function submitEdit() {
    const err = validateEditable(editModel, true);
    if (err) {
      setEditError(err);
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      const config = editableToConfig(editModel);
      const res = (await invoke("update_mcp", {
        name: editModel.name,
        config,
      })) as McpMutationResult;
      setEditTarget(null);
      showFlash(
        `Actualizado '${res.name}'. Backup: ${res.backup_path ?? "n/d"}. Reinicia Claude Code para aplicarlo.`,
      );
      await fetchList();
    } catch (e) {
      setEditError(String(e));
    } finally {
      setEditSaving(false);
    }
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------
  async function submitDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = (await invoke("delete_mcp", {
        name: deleteTarget,
      })) as McpMutationResult;
      setDeleteTarget(null);
      showFlash(
        `Borrado '${res.name}'. Backup: ${res.backup_path ?? "n/d"}. Reinicia Claude Code para aplicarlo.`,
      );
      await fetchList();
    } catch (e) {
      showFlash(`No se pudo borrar: ${e}`);
    } finally {
      setDeleting(false);
    }
  }

  const visible = mcps.filter((m) => !hidden.has(m.name) || showHidden);
  const okCount = mcps.filter((m) => m.status === "ok").length;
  const issueCount = mcps.filter(
    (m) => (m.status === "degraded" || m.status === "missing") && !m.expected_offline,
  ).length;

  return (
    <div className="px-10 py-8">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">MCPs</h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
            {mcps.length} {mcps.length === 1 ? "servidor" : "servidores"} · {okCount}{" "}
            {okCount === 1 ? "conectado" : "conectados"} · {issueCount}{" "}
            {issueCount === 1 ? "requiere atención" : "requieren atención"}
            {(() => {
              // Desglose por origen, para comprobar que aparecen los MCP de
              // plugin y de proyecto (otra herramienta mostraba muchos más
              // que Claude Code).
              const buckets = mcps.reduce<Record<string, number>>((acc, m) => {
                const k = parseOrigin(m.origin).kind;
                acc[k] = (acc[k] || 0) + 1;
                return acc;
              }, {});
              const parts: string[] = [];
              if (buckets.user) parts.push(`${buckets.user} de usuario`);
              if (buckets.project) parts.push(`${buckets.project} de proyecto`);
              if (buckets.plugin) parts.push(`${buckets.plugin} de plugin`);
              return parts.length > 0 ? <> · {parts.join(" · ")}</> : null;
            })()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setAddModel(blankMcp());
              setAddError(null);
              setAddOpen(true);
            }}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            + Añadir MCP
          </button>
          {/* «Generar desde prompt» se retiró en favor de «Añadir con IA»: el
              modal en línea fallaba con prompts con caracteres especiales y
              el flujo con wt.exe da a Claude la conversación completa, útil
              cuando hay que aclarar comando, args o env. */}
          <button
            type="button"
            onClick={async () => {
              try {
                const instr = (await invoke("instruction_path", {
                  kind: "mcps",
                })) as string;
                // v15.3.5: prompt now lives in the central catalog
                // (key `mcps.add_with_ai`) so it can be tuned from
                // Settings → Button prompts without recompiling.
                const { getPrompt } = await import("../lib/button-prompts");
                const prompt = await getPrompt("mcps.add_with_ai");
                await invoke("spawn_session", {
                  provider: "claude",
                  prompt,
                  cwd: instr,
                  flags: { dangerouslySkipPermissions: false },
                });
              } catch (e) {
                notifyError(`No se pudo crear el MCP con IA: ${String(e)}`, "mcps");
              }
            }}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-primary)",
              border: "1px solid var(--color-border-strong)",
            }}
            title={addWithAiTitle}
          >
            Añadir con IA
          </button>
          <button
            type="button"
            onClick={runProbe}
            disabled={probing}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text-primary)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Prueba todos los servidores activados de todas las fuentes (stdio: ejecuta el comando y espera a initialize; HTTP/SSE: envía initialize a la URL). «degradado» si tarda más de 5 s o pide autenticación; «no encontrado» si no responde. Escribe ~/.ultron/.tmp/mcp-health.json."
          >
            {probing ? "Comprobando…" : "Comprobar salud"}
          </button>
        </div>
      </header>

      {flash && (
        <div
          className="mb-4 rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(46, 160, 67, 0.07)",
            border: "1px solid rgba(46, 160, 67, 0.25)",
            color: "var(--color-success)",
          }}
        >
          {flash}
        </div>
      )}

      {error && (
        <div
          className="mb-4 rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {hidden.size > 0 && (
        <div className="mb-4 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          {hidden.size} ocultos ·{" "}
          <button
            type="button"
            onClick={() => setShowHidden(!showHidden)}
            className="underline-offset-2 hover:underline"
          >
            {showHidden ? "ocultarlos" : "mostrarlos"}
          </button>
        </div>
      )}

      {loading && (
        <div className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Cargando…
        </div>
      )}

      {!loading && mcps.length === 0 && (
        <div
          className="rounded p-6 text-center text-[13px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          No hay ningún MCP configurado (~/.claude.json, .mcp.json del proyecto o plugins).
        </div>
      )}

      {/* v2.6 (card-v26-7): grid 3-col. */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {visible.map((m) => (
          <Card
            key={m.name}
            mcp={m}
            hidden={hidden.has(m.name)}
            ping={pings[m.name]}
            pingBusy={pingBusy.has(m.name)}
            enabled={enabledMap[m.name] !== false}
            toggleBusy={toggleBusy.has(m.name)}
            onToggleEnabled={() => void toggleEnabled(m.name, m.origin)}
            onAction={(a) => {
              if (a === "hide") toggleHidden(m.name);
              else if (a === "edit") openEdit(m.name);
              else if (a === "delete") setDeleteTarget(m.name);
              else if (a === "test") void testMcp(m.name);
            }}
          />
        ))}
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Add modal                                                        */}
      {/* ---------------------------------------------------------------- */}
      {addOpen && (
        <Modal
          title="Añadir MCP"
          onClose={() => !addSaving && setAddOpen(false)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setAddOpen(false)}
                disabled={addSaving}
                className="rounded px-3 py-1.5 text-[12px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border)",
                }}
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={submitAdd}
                disabled={addSaving}
                className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                {addSaving ? "Guardando…" : "Añadir a ~/.claude.json"}
              </button>
            </>
          }
        >
          <McpForm value={addModel} onChange={setAddModel} lockName={false} />
          {addError && (
            <p
              className="mt-3 text-[12px]"
              style={{ color: "var(--color-danger)" }}
            >
              {addError}
            </p>
          )}
        </Modal>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Edit modal                                                       */}
      {/* ---------------------------------------------------------------- */}
      {editTarget && (
        <Modal
          title={`Editar MCP — ${editTarget}`}
          onClose={() => !editSaving && setEditTarget(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setEditTarget(null)}
                disabled={editSaving}
                className="rounded px-3 py-1.5 text-[12px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border)",
                }}
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={submitEdit}
                disabled={editSaving}
                className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                {editSaving ? "Guardando…" : "Guardar cambios"}
              </button>
            </>
          }
        >
          <McpForm value={editModel} onChange={setEditModel} lockName={true} />
          {editError && (
            <p
              className="mt-3 text-[12px]"
              style={{ color: "var(--color-danger)" }}
            >
              {editError}
            </p>
          )}
        </Modal>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Delete confirm                                                   */}
      {/* ---------------------------------------------------------------- */}
      {deleteTarget && (
        <Modal
          title={`¿Borrar ${deleteTarget}?`}
          onClose={() => !deleting && setDeleteTarget(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="rounded px-3 py-1.5 text-[12px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                  border: "1px solid var(--color-border)",
                }}
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={submitDelete}
                disabled={deleting}
                className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
                style={{
                  background: "rgba(248, 81, 73, 0.18)",
                  color: "var(--color-danger)",
                  border: "1px solid rgba(248, 81, 73, 0.45)",
                }}
              >
                {deleting ? "Borrando…" : "Borrar"}
              </button>
            </>
          }
        >
          <p
            className="text-[13px] leading-relaxed"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {deleteOrigin === "settings" ? (
              <>
                Esto quita la entrada sin uso <strong>{deleteTarget}</strong> de
                ~/.claude/settings.json. Se guarda un backup con fecha y hora en
                <code className="ml-1 rounded px-1.5 py-0.5" style={codeStyle}>
                  ~/.ultron/backups/control-center-settings/
                </code>
                .
              </>
            ) : (
              <>
                Esto quita <strong>{deleteTarget}</strong> del ámbito de usuario de
                ~/.claude.json. Se guarda un backup con fecha y hora en
                <code className="ml-1 rounded px-1.5 py-0.5" style={codeStyle}>
                  ~/.ultron/backups/claude-json/
                </code>
                .
              </>
            )}
          </p>
        </Modal>
      )}
    </div>
  );
}
