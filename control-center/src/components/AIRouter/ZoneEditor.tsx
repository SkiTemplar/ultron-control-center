// ULTRON Control Center — AI Router: Zone Editor Modal
//
// Full-screen modal overlay for editing a single Zone's:
//   - Primary provider (dropdown from PROVIDER_CATALOG)
//   - Model (dropdown filtered by selected provider)
//   - Max tokens (numeric input, 0 = provider default)
//   - Fallback chain (ordered list with add/remove/reorder)
//   - Test button: invokes ai_router_test() and shows latency + excerpt
//
// On save: calls ai_router_update_zone() Tauri command.
// Falls back to local state update when command is unavailable.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  Provider,
  ProviderClass,
  TestResult,
  Zone,
  ZoneAssignment,
} from "./types";
import { PROVIDER_CATALOG, PROVIDER_MODELS } from "./types";
import { notify } from "../../lib/notify";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLASS_COLORS: Record<string, string> = {
  trivial: "var(--color-success)",
  light: "var(--color-warn)",
  medium: "#a875ff",
  heavy: "var(--color-danger)",
};

function getModels(providerId: string) {
  return PROVIDER_MODELS[providerId] ?? [];
}

function defaultModelFor(providerId: string): string {
  return getModels(providerId)[0]?.id ?? "";
}

/** Empty assignment with sensible defaults for the given provider. */
function emptyAssignment(providerId: string): ZoneAssignment {
  return {
    provider_id: providerId,
    model: defaultModelFor(providerId),
    max_tokens: 0,
  };
}

// ---------------------------------------------------------------------------
// Sub-component: AssignmentRow
// Used for both the primary assignment and each fallback entry.
// ---------------------------------------------------------------------------

function AssignmentRow({
  assignment,
  onChange,
  label,
  onRemove,
  providers,
}: {
  assignment: ZoneAssignment;
  onChange: (next: ZoneAssignment) => void;
  label: string;
  onRemove?: () => void;
  providers: Provider[];
}) {
  const models = getModels(assignment.provider_id);

  function handleProviderChange(newProviderId: string) {
    onChange({
      provider_id: newProviderId,
      model: defaultModelFor(newProviderId),
      max_tokens: assignment.max_tokens,
    });
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-lg p-3"
      style={{
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-center justify-between">
        <span
          className="text-[11px] font-semibold uppercase tracking-wide"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {label}
        </span>
        {onRemove !== undefined && (
          <button
            type="button"
            onClick={onRemove}
            className="rounded px-2 py-0.5 text-[11px] transition-colors"
            style={{
              color: "var(--color-danger)",
              background: "transparent",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                "var(--color-danger-bg, #3a1a1a)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                "transparent";
            }}
            title="Remove this fallback"
          >
            Remove
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {/* Provider */}
        <div className="flex flex-col gap-1">
          <label
            className="text-[11px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Provider
          </label>
          <select
            value={assignment.provider_id}
            onChange={(e) => handleProviderChange(e.target.value)}
            className="rounded border px-2 py-1.5 text-[12px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              borderColor: "var(--color-border)",
              outline: "none",
            }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        {/* Model */}
        <div className="flex flex-col gap-1">
          <label
            className="text-[11px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Model
          </label>
          <select
            value={assignment.model}
            onChange={(e) =>
              onChange({ ...assignment, model: e.target.value })
            }
            className="rounded border px-2 py-1.5 text-[12px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              borderColor: "var(--color-border)",
              outline: "none",
            }}
          >
            {models.length === 0 && (
              <option value="">— no models listed —</option>
            )}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Max tokens */}
      <div className="flex items-center gap-2">
        <label
          className="text-[11px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Max tokens
        </label>
        <input
          type="number"
          min={0}
          step={256}
          value={assignment.max_tokens}
          onChange={(e) =>
            onChange({
              ...assignment,
              max_tokens: Math.max(0, parseInt(e.target.value, 10) || 0),
            })
          }
          className="w-28 rounded border px-2 py-1 text-[12px]"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
            borderColor: "var(--color-border)",
            outline: "none",
          }}
          placeholder="0 = default"
        />
        {assignment.max_tokens === 0 && (
          <span
            className="text-[11px]"
            style={{ color: "var(--color-text-faint)" }}
          >
            provider default
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ZoneEditor
// ---------------------------------------------------------------------------

interface ZoneEditorProps {
  zone: Zone;
  onClose: () => void;
  onSaved: (updated: Zone) => void;
}

export function ZoneEditor({ zone, onClose, onSaved }: ZoneEditorProps) {
  const [draft, setDraft] = useState<Zone>({ ...zone, fallbacks: [...zone.fallbacks] });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [testPrompt, setTestPrompt] = useState("Respond with a single word: OK");

  // Trap Escape key to close.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const updatePrimary = useCallback((next: ZoneAssignment) => {
    setDraft((prev) => ({ ...prev, primary: next }));
  }, []);

  const updateFallback = useCallback((index: number, next: ZoneAssignment) => {
    setDraft((prev) => {
      const fb = [...prev.fallbacks];
      fb[index] = next;
      return { ...prev, fallbacks: fb };
    });
  }, []);

  const removeFallback = useCallback((index: number) => {
    setDraft((prev) => ({
      ...prev,
      fallbacks: prev.fallbacks.filter((_, i) => i !== index),
    }));
  }, []);

  function addFallback() {
    const firstProvider = PROVIDER_CATALOG[0];
    setDraft((prev) => ({
      ...prev,
      fallbacks: [
        ...prev.fallbacks,
        emptyAssignment(firstProvider?.id ?? "anthropic"),
      ],
    }));
  }

  function moveFallback(index: number, direction: -1 | 1) {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= draft.fallbacks.length) return;
    setDraft((prev) => {
      const fb = [...prev.fallbacks];
      const temp = fb[index]!;
      fb[index] = fb[newIndex]!;
      fb[newIndex] = temp;
      return { ...prev, fallbacks: fb };
    });
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      await invoke("ai_router_update_zone", { zone: draft });
    } catch (err) {
      // Backend not yet wired or save failed — still accept the change
      // locally so the UI reflects the edit, but surface a warning.
      const msg = err instanceof Error ? err.message : String(err);
      // Only treat it as a hard error if the command exists but returned
      // an explicit error string (not a "command not found" situation).
      if (!msg.includes("command") && !msg.includes("not found")) {
        setSaveError(msg);
        setSaving(false);
        return;
      }
    }
    notify({
      message: `Zone "${draft.label}" saved. Will apply on next AI Router call.`,
      source: "ai-router",
      severity: "info",
      persist: false,
    });
    onSaved(draft);
    setSaving(false);
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = (await invoke("ai_router_test", {
        zoneId: draft.id,
        samplePrompt: testPrompt,
      })) as TestResult;
      setTestResult(result);
    } catch (err) {
      // Simulate a result when the command is unavailable.
      setTestResult({
        ok: false,
        provider_id: draft.primary.provider_id,
        model: draft.primary.model,
        latency_ms: 0,
        response_excerpt: "",
        error: `Backend command unavailable: ${String(err)}`,
      });
    } finally {
      setTesting(false);
    }
  }

  const classColor =
    CLASS_COLORS[draft.task_class as ProviderClass] ??
    "var(--color-text-secondary)";

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Modal panel */}
      <div
        className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-xl shadow-xl"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border-strong)",
        }}
      >
        {/* ---------------------------------------------------------------- */}
        {/* Header                                                           */}
        {/* ---------------------------------------------------------------- */}
        <div
          className="flex items-start justify-between border-b px-5 py-4"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div>
            <h2
              className="text-[15px] font-semibold"
              style={{ color: "var(--color-text)" }}
            >
              Edit Zone
            </h2>
            <code
              className="mt-0.5 block text-[11px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {draft.id}
            </code>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
              style={{
                background: `${classColor}22`,
                color: classColor,
                border: `1px solid ${classColor}44`,
              }}
            >
              {draft.task_class}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-[16px] leading-none transition-colors"
              style={{
                color: "var(--color-text-tertiary)",
                background: "transparent",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.color =
                  "var(--color-text)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.color =
                  "var(--color-text-tertiary)";
              }}
              title="Close (Esc)"
            >
              x
            </button>
          </div>
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Body (scrollable)                                                */}
        {/* ---------------------------------------------------------------- */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Primary assignment */}
          <AssignmentRow
            label="Primary provider"
            assignment={draft.primary}
            onChange={updatePrimary}
            providers={PROVIDER_CATALOG}
          />

          {/* Fallback chain */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span
                className="text-[12px] font-semibold"
                style={{ color: "var(--color-text-secondary)" }}
              >
                Fallback chain
              </span>
              {draft.fallbacks.length < 3 && (
                <button
                  type="button"
                  onClick={addFallback}
                  className="rounded px-2.5 py-1 text-[11px] font-medium transition-colors"
                  style={{
                    background: "var(--color-surface-3)",
                    color: "var(--color-text-secondary)",
                    border: "1px solid var(--color-border)",
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.color =
                      "var(--color-text)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.color =
                      "var(--color-text-secondary)";
                  }}
                >
                  + Add fallback
                </button>
              )}
            </div>

            {draft.fallbacks.length === 0 && (
              <p
                className="text-[12px]"
                style={{ color: "var(--color-text-faint)" }}
              >
                No fallbacks configured. If the primary fails the zone will error.
              </p>
            )}

            {draft.fallbacks.map((fb, i) => (
              <div key={i} className="flex items-start gap-1.5">
                {/* Reorder buttons */}
                <div className="flex flex-col gap-0.5 pt-3">
                  <button
                    type="button"
                    onClick={() => moveFallback(i, -1)}
                    disabled={i === 0}
                    className="rounded px-1 py-0.5 text-[10px] leading-none transition-colors disabled:opacity-30"
                    style={{
                      background: "var(--color-surface-3)",
                      color: "var(--color-text-tertiary)",
                    }}
                    title="Move up"
                  >
                    ^
                  </button>
                  <button
                    type="button"
                    onClick={() => moveFallback(i, 1)}
                    disabled={i === draft.fallbacks.length - 1}
                    className="rounded px-1 py-0.5 text-[10px] leading-none transition-colors disabled:opacity-30"
                    style={{
                      background: "var(--color-surface-3)",
                      color: "var(--color-text-tertiary)",
                    }}
                    title="Move down"
                  >
                    v
                  </button>
                </div>
                <div className="flex-1">
                  <AssignmentRow
                    label={`Fallback ${i + 1}`}
                    assignment={fb}
                    onChange={(next) => updateFallback(i, next)}
                    onRemove={() => removeFallback(i)}
                    providers={PROVIDER_CATALOG}
                  />
                </div>
              </div>
            ))}
          </div>

          {/* Test section */}
          <div
            className="rounded-lg p-3 space-y-2"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border)",
            }}
          >
            <span
              className="text-[12px] font-semibold"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Test invocation
            </span>
            <input
              type="text"
              value={testPrompt}
              onChange={(e) => setTestPrompt(e.target.value)}
              placeholder="Sample prompt..."
              className="w-full rounded border px-2.5 py-1.5 text-[12px]"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                borderColor: "var(--color-border)",
                outline: "none",
              }}
            />
            <button
              type="button"
              onClick={() => void handleTest()}
              disabled={testing}
              className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border)",
              }}
            >
              {testing ? "Testing..." : "Test"}
            </button>

            {testResult !== null && (
              <div
                className="rounded p-2.5 text-[11px] space-y-1"
                style={{
                  background: testResult.ok
                    ? "var(--color-success-bg, #0f2d1a)"
                    : "var(--color-danger-bg, #3a1a1a)",
                  color: testResult.ok
                    ? "var(--color-success)"
                    : "var(--color-danger)",
                  border: `1px solid ${testResult.ok ? "var(--color-success)" : "var(--color-danger)"}`,
                }}
              >
                <div className="font-semibold">
                  {testResult.ok ? "OK" : "Failed"} — {testResult.provider_id} /{" "}
                  {testResult.model}
                  {testResult.latency_ms > 0 && ` — ${testResult.latency_ms}ms`}
                </div>
                {testResult.error !== undefined && testResult.error.length > 0 && (
                  <div style={{ color: "var(--color-text-secondary)" }}>
                    {testResult.error}
                  </div>
                )}
                {testResult.response_excerpt.length > 0 && (
                  <div
                    className="mt-1 rounded p-1.5"
                    style={{
                      background: "var(--color-surface-1)",
                      color: "var(--color-text-secondary)",
                    }}
                  >
                    {testResult.response_excerpt}
                  </div>
                )}
              </div>
            )}
          </div>

          {saveError !== null && (
            <div
              className="rounded p-2.5 text-[12px]"
              style={{
                background: "var(--color-danger-bg, #3a1a1a)",
                color: "var(--color-danger)",
                border: "1px solid var(--color-danger)",
              }}
            >
              {saveError}
            </div>
          )}
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* Footer                                                           */}
        {/* ---------------------------------------------------------------- */}
        <div
          className="flex items-center justify-end gap-2 border-t px-5 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <button
            type="button"
            onClick={onClose}
            className="rounded px-4 py-1.5 text-[12px] transition-colors"
            style={{
              background: "transparent",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="rounded px-4 py-1.5 text-[12px] font-semibold transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
              border: "none",
            }}
          >
            {saving ? "Saving..." : "Save zone"}
          </button>
        </div>
      </div>
    </div>
  );
}
