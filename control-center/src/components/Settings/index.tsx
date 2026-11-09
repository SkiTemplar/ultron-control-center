import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SettingsSaveResult, SettingsSnapshot } from "../../types";
import { AuthStatus } from "../AuthStatus";
import { JsonEditor } from "./EditorSection";
import { BackupsPanel } from "./BackupsSection";
import { LifecyclePanel } from "./LifecyclePanel";
import { ButtonPromptsSection } from "./ButtonPromptsSection";
import { ApiKeysSection } from "./ApiKeysSection";
import { McpAccountsSection } from "./McpAccountsSection";
import { AccountsSection } from "./AccountsSection";
import { ToolsSection } from "./ToolsSection";
import { MascotSection } from "./MascotSection";
import { SettingsJsonBackups } from "./SettingsJsonBackups";

// Tab order: General > Auth > API Keys > Backups > Button prompts > settings.json (raw)
// v2.5.2 (wave 2): "general" (legacy) and "plugins" sub-tabs removed.
// "lifecycle" relabeled to "General" — it now hosts autostart, rebuild,
// close, and the single global hotkey. Plugins lives in the Library tab.
// v2.8 (fullize 2026-06-01): "api-keys" moved back to Settings from AI Router
// so the user can manage all keys in one place.
type Section =
  | "general"
  | "auth"
  | "api-keys"
  | "mcp-accounts"
  | "accounts"
  | "tools"
  | "mascot"
  | "backups"
  | "button-prompts"
  | "raw";

// Etiquetas cortas para que las diez pestañas quepan en una línea (~830 px a
// 12 px); el nombre completo de la sección va en el tooltip y en su cabecera.
const TABS: ReadonlyArray<{ id: Section; label: string; full?: string }> = [
  { id: "general", label: "General" },
  { id: "auth", label: "Autenticación" },
  { id: "api-keys", label: "Claves API" },
  { id: "mcp-accounts", label: "Cuentas MCP" },
  { id: "accounts", label: "Modelos", full: "Cuentas y modelos" },
  { id: "tools", label: "Herramientas" },
  { id: "mascot", label: "Pupus" },
  { id: "backups", label: "Copias" },
  { id: "button-prompts", label: "Prompts", full: "Prompts de botones" },
  { id: "raw", label: "settings.json" },
];

/** Pestañas que consumen el snapshot de settings_read. */
const SNAPSHOT_SECTIONS: ReadonlyArray<Section> = ["raw", "backups"];

/** Sección pedida desde fuera (clic derecho en Pupus → Ajustes). */
export const SETTINGS_SECTION_KEY = "ultron.settings.section";

function takeRequestedSection(): Section | null {
  const s = sessionStorage.getItem(SETTINGS_SECTION_KEY);
  sessionStorage.removeItem(SETTINGS_SECTION_KEY);
  return s === "mascot" ? s : null;
}

export function Settings() {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>(() => takeRequestedSection() ?? "general");
  // Ya montado: la petición llega como evento de ventana.
  useEffect(() => {
    const onRequest = () => {
      const s = takeRequestedSection();
      if (s) setSection(s);
    };
    window.addEventListener(SETTINGS_SECTION_KEY, onRequest);
    return () => window.removeEventListener(SETTINGS_SECTION_KEY, onRequest);
  }, []);
  const [dirty, setDirty] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SettingsSaveResult | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = (await invoke("settings_read")) as SettingsSnapshot;
      setSnapshot(r);
      setDraft(JSON.parse(JSON.stringify(r.content)));
      setDirty(false);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setSaveResult(null);
    try {
      const r = (await invoke("settings_save", { content: draft })) as SettingsSaveResult;
      setSaveResult(r);
      // reload to pick up server-side normalization
      await load();
    } catch (e) {
      setSaveResult({
        success: false,
        backup_path: null,
        new_size_bytes: 0,
      });
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    if (snapshot) {
      setDraft(JSON.parse(JSON.stringify(snapshot.content)));
      setDirty(false);
      setSaveResult(null);
    }
  }

  // Solo settings.json y Copias consumen el snapshot: el resto de pestañas
  // trae su propio refresco, así que la cabecera no ofrece uno que no hace nada.
  const usesSnapshot = SNAPSHOT_SECTIONS.includes(section);

  return (
    <div className="px-10 py-8">
      <div className="max-w-[960px]">
        <header className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <div>
            <h1 className="text-[20px] font-semibold leading-tight">Ajustes</h1>
            {usesSnapshot && (
              <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
                Edita ~/.claude/settings.json · cada guardado deja una copia del fichero anterior
              </p>
            )}
          </div>
          {usesSnapshot && (
            <button
              type="button"
              onClick={load}
              disabled={loading || saving || dirty}
              title={
                dirty
                  ? "Guarda o descarta los cambios antes de recargar"
                  : "Vuelve a leer settings.json del disco"
              }
              className="shrink-0 rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              {loading ? "Cargando…" : "Recargar"}
            </button>
          )}
        </header>

        {/* Section tabs: una sola línea; si la ventana es más estrecha que la
            barra, scroll horizontal en vez de saltar a una segunda fila. */}
        <div
          role="tablist"
          aria-label="Secciones de Ajustes"
          className="flex w-fit max-w-full flex-nowrap gap-0.5 overflow-x-auto rounded p-0.5"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          {TABS.map((t) => {
            const selected = section === t.id;
            const pending = t.id === "raw" && dirty;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setSection(t.id)}
                title={pending ? "Cambios sin guardar" : t.full}
                className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-3 py-1 text-[12px] font-medium transition-colors"
                style={{
                  background: selected ? "var(--color-surface-3)" : "transparent",
                  color: selected ? "var(--color-text)" : "var(--color-text-tertiary)",
                }}
              >
                {t.label}
                {pending && (
                  <span
                    aria-label="cambios sin guardar"
                    className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{ background: "var(--color-warn)" }}
                  />
                )}
              </button>
            );
          })}
        </div>

        {usesSnapshot && error && (
          <div
            className="mt-4 rounded p-3 text-[12.5px]"
            style={{
              background: "rgba(248, 81, 73, 0.06)",
              border: "1px solid rgba(248, 81, 73, 0.22)",
              color: "var(--color-danger)",
            }}
          >
            {error}
          </div>
        )}

        {section === "raw" && saveResult && saveResult.success && (
          <div
            className="mt-4 rounded p-3 text-[12px]"
            style={{
              background: "rgba(63, 185, 80, 0.06)",
              border: "1px solid rgba(63, 185, 80, 0.22)",
              color: "var(--color-success)",
            }}
          >
            Guardado. Copia en{" "}
            <span style={{ fontFamily: "var(--font-mono)" }}>{saveResult.backup_path}</span>
          </div>
        )}

        <div className="mt-5">
          {/* Tab panels */}
          {section === "general" && <LifecyclePanel />}
          {section === "auth" && <AuthStatus onRecheck={load} />}
          {section === "api-keys" && <ApiKeysSection />}
          {section === "mcp-accounts" && <McpAccountsSection />}
          {section === "accounts" && <AccountsSection />}
          {section === "tools" && <ToolsSection />}
          {section === "mascot" && <MascotSection />}

          {section === "raw" && draft && (
            <>
              <JsonEditor
                obj={draft}
                onChange={(next) => {
                  setDraft(next);
                  setDirty(true);
                }}
              />
              {/* Barra pegada abajo: el formulario es largo y el guardado
                  tiene que verse desde cualquier campo. */}
              {dirty && (
                <div
                  className="sticky bottom-0 z-10 mt-4 flex items-center justify-end gap-2 rounded px-3 py-2"
                  style={{
                    background: "var(--color-surface-2)",
                    border: "1px solid var(--color-border-strong)",
                    boxShadow: "0 -6px 16px rgba(0, 0, 0, 0.45)",
                  }}
                >
                  <span className="mr-auto text-[12px]" style={{ color: "var(--color-warn)" }}>
                    Cambios sin guardar
                  </span>
                  <button
                    type="button"
                    onClick={discard}
                    disabled={saving}
                    className="rounded px-3 py-1.5 text-[12px] transition-colors"
                    style={{
                      background: "transparent",
                      color: "var(--color-text-tertiary)",
                      border: "1px solid var(--color-border-strong)",
                    }}
                  >
                    Descartar
                  </button>
                  <button
                    type="button"
                    onClick={save}
                    disabled={saving}
                    className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
                    style={{
                      background: "var(--color-accent)",
                      color: "var(--color-accent-text)",
                    }}
                  >
                    {saving ? "Guardando…" : "Guardar cambios"}
                  </button>
                </div>
              )}
            </>
          )}

          {section === "backups" && (
            <div>
              <BackupsPanel />
              {snapshot && (
                <SettingsJsonBackups dir={snapshot.backup_dir} files={snapshot.recent_backups} />
              )}
            </div>
          )}

          {section === "button-prompts" && <ButtonPromptsSection />}

          {/* v2.5.2 wave 2: "lifecycle" and "plugins" sub-tabs retired.
              Lifecycle content lives in "general"; Plugins lives in Library. */}
        </div>
      </div>
    </div>
  );
}
