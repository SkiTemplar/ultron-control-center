import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SettingsSaveResult, SettingsSnapshot } from "../../types";
import { AuthStatus } from "../AuthStatus";
import { GeneralSection } from "./GeneralSection";
import { ModeSection } from "./ModeSection";
import { AiRouterSection } from "./AiRouterSection";
import { ButtonPromptsSection } from "./ButtonPromptsSection";
import { FeaturesSection } from "./FeaturesSection";
import { JsonEditor } from "./EditorSection";
import { BackupRootEditor, BackupSourcesEditor, DiskBackupStatus } from "./BackupsSection";
import { LifecyclePanel } from "./LifecyclePanel";

// v15.2 F7: "mcps" section removed — MCP enable/disable lives in the MCPs
// top-level tab now. Kept the union without it so stale state references
// surface as compile errors.
type Section =
  | "general"
  | "auth"
  | "mode"
  | "ai-router"
  | "button-prompts"
  | "features"
  | "raw"
  | "backups"
  | "lifecycle";

export function Settings() {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("general");
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

  return (
    <div className="px-10 py-8">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">Settings</h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
            Edit ~/.claude/settings.json · backups automáticos a ~/.ultron/backups/control-center-settings
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <>
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
                Discard
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
                {saving ? "Saving…" : "Save changes"}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={load}
            disabled={loading || saving}
            className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            Reload
          </button>
        </div>
      </header>

      {/* Section tabs */}
      <div
        className="inline-flex rounded p-0.5"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border-strong)",
        }}
      >
        {[
          { id: "general" as Section, label: "General" },
          { id: "auth" as Section, label: "Auth" },
          { id: "mode" as Section, label: "Mode" },
          { id: "ai-router" as Section, label: "AI Router" },
          { id: "button-prompts" as Section, label: "Button prompts" },
          { id: "features" as Section, label: "Features" },
          // v15.2 F7: "MCPs" sub-tab removed — moved to top-level MCPs tab.
          { id: "raw" as Section, label: "Editor" },
          { id: "backups" as Section, label: "Backups" },
          { id: "lifecycle" as Section, label: "App lifecycle" },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSection(t.id)}
            className="rounded px-3 py-1 text-[12px] font-medium transition-colors"
            style={{
              background: section === t.id ? "var(--color-surface-3)" : "transparent",
              color: section === t.id ? "var(--color-text)" : "var(--color-text-tertiary)",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
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

      {saveResult && saveResult.success && (
        <div
          className="mt-4 rounded p-3 text-[12px]"
          style={{
            background: "rgba(63, 185, 80, 0.06)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          Saved. Backup at{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>
            {saveResult.backup_path}
          </span>
        </div>
      )}

      <div className="mt-5">
        {section === "general" && <GeneralSection />}
        {section === "auth" && <AuthStatus />}
        {section === "mode" && <ModeSection />}
        {section === "ai-router" && <AiRouterSection />}
        {section === "button-prompts" && <ButtonPromptsSection />}
        {section === "features" && <FeaturesSection />}

        {section === "raw" && draft && (
          <JsonEditor
            obj={draft}
            onChange={(next) => {
              setDraft(next);
              setDirty(true);
            }}
          />
        )}

        {section === "backups" && snapshot && (
          <div>
            <BackupRootEditor onChanged={() => { /* DiskBackupStatus refetches on mount */ }} />
            <BackupSourcesEditor onChanged={() => { /* persisted to backup-config.json; scripts re-read on next run */ }} />
            <DiskBackupStatus />
            <p
              className="mb-3 mt-6 text-[12px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Each Save creates a timestamped backup of the previous
              settings.json. Last 8 shown.
            </p>
            <div
              className="mb-3 truncate text-[10.5px]"
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--color-text-faint)",
              }}
            >
              {snapshot.backup_dir}
            </div>
            {snapshot.recent_backups.length === 0 ? (
              <div
                className="rounded p-6 text-center text-[12.5px]"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-tertiary)",
                }}
              >
                No backups yet. The first Save will create one.
              </div>
            ) : (
              <ul
                className="rounded"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                }}
              >
                {snapshot.recent_backups.map((b, i) => (
                  <li
                    key={b}
                    className="border-t px-3 py-2 text-[12px]"
                    style={{
                      borderColor: i === 0 ? "transparent" : "var(--color-border)",
                      fontFamily: "var(--font-mono)",
                      color: "var(--color-text-secondary)",
                    }}
                  >
                    {b}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {section === "lifecycle" && <LifecyclePanel />}
      </div>
    </div>
  );
}
