import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SettingsSaveResult, SettingsSnapshot } from "../../types";
import { AuthStatus } from "../AuthStatus";
import { ButtonPromptsSection } from "./ButtonPromptsSection";
import { JsonEditor } from "./EditorSection";
import { BackupsPanel } from "./BackupsSection";
import { LifecyclePanel } from "./LifecyclePanel";
import { AIRouter } from "../AIRouter";
import { ApiKeysSection } from "./ApiKeysSection";

// v15.2 F7: "mcps" section removed — MCP enable/disable lives in the MCPs
// top-level tab now. P7 (2.0): "raw" (settings.json) is the default tab and
// the Section union is reordered so the JSON editor leads.
// v2.5.2 (wave 2): "general" (legacy) and "plugins" sub-tabs removed.
// "lifecycle" relabeled to "General" — it now hosts autostart, rebuild,
// close, and the single global hotkey. Plugins lives in the Library tab.
// v2.7.2: "ai-router" sub-tab added — AI Router was demoted from a
// top-level sidebar entry to a Settings sub-tab so the sidebar stays
// focused on user-facing surfaces. The AIRouter component supports an
// `embedded` flag that drops its full-page chrome when rendered here.
type Section =
  | "raw"
  | "general"
  | "auth"
  | "api-keys"
  | "button-prompts"
  | "backups"
  | "ai-router";

type SettingsProps = {
  onNavigate?: (tab: string) => void;
};

export function Settings(_props: SettingsProps = {}) {
  // _props.onNavigate was used by the retired Plugins sub-tab. Kept in the
  // signature so callers (App.tsx) don't break, but no longer consumed.
  void _props;
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("raw");
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
            Edit ~/.claude/settings.json · automatic backups to ~/.ultron/backups/control-center-settings
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
            Refresh
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
          { id: "raw" as Section, label: "settings.json" },
          { id: "general" as Section, label: "General" },
          { id: "auth" as Section, label: "Auth" },
          { id: "api-keys" as Section, label: "API Keys" },
          { id: "button-prompts" as Section, label: "Button prompts" },
          { id: "ai-router" as Section, label: "AI Router" },
          { id: "backups" as Section, label: "Backups" },
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
        {/* v2.5.2 wave 2: "General" now points to the merged LifecyclePanel
            (autostart + rebuild + close + global hotkey). The old
            GeneralSection placeholder is no longer imported. */}
        {section === "general" && <LifecyclePanel />}
        {section === "auth" && <AuthStatus />}
        {section === "api-keys" && <ApiKeysSection />}
        {section === "button-prompts" && <ButtonPromptsSection />}
        {section === "ai-router" && <AIRouter embedded />}

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
            <BackupsPanel />
            <p
              className="mb-3 mt-6 text-[12px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Each Save creates a timestamped backup of the previous
              settings.json. Last 8 shown.
            </p>
            <div
              className="mb-3 truncate text-[11.5px]"
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

        {/* v2.5.2 wave 2: "lifecycle" and "plugins" sub-tabs retired.
            Lifecycle content lives in "general"; Plugins lives in Library. */}
      </div>
    </div>
  );
}
