import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import type { SettingsSaveResult, SettingsSnapshot } from "../types";
import { AuthStatus } from "./AuthStatus";
import { ModeSwitcher, useUltronMode } from "./ModeSwitcher";

// v15.2 F7: MCPRow / McpServer type removed from Settings — MCP enable/disable
// now lives in the MCPs top-level tab (see EnableDisableSection in MCPs.tsx).

// ---------------------------------------------------------------------------
// JSON editor — replaces the old read-only preview. Lets the user edit the
// whole settings.json as text, validates on every keystroke, and (optionally)
// asks Codex to rewrite it from a natural-language instruction. The diff
// goes through the normal Save flow (timestamped backup, atomic write).
// ---------------------------------------------------------------------------

function extractJsonFromText(s: string): string | null {
  // Codex sometimes wraps replies in ```json fences. Strip them aggressively.
  const trimmed = s.trim();
  const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) return fenced[1].trim();
  // Otherwise look for the first '{' and the last '}' — must form a balanced
  // object. We do a very cheap balance check.
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return trimmed.slice(first, last + 1).trim();
}

// v15.2 F7: light-weight settings.json schema validator. We do not pretend to
// implement Claude Code's full schema — that would be a moving target — but
// we catch the structural mistakes that actually cause Claude to crash on
// SessionStart: wrong shape for the well-known keys (`hooks`, `mcpServers`,
// `env`, `model`). Anything outside that whitelist is left alone.
function validateSettingsSchema(obj: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return ["Root must be a JSON object."];
  }
  if ("hooks" in obj) {
    const h = obj.hooks as unknown;
    if (h === null || typeof h !== "object" || Array.isArray(h)) {
      errors.push("`hooks` must be an object keyed by event name.");
    } else {
      for (const [event, val] of Object.entries(h as Record<string, unknown>)) {
        if (!Array.isArray(val)) {
          errors.push(`hooks.${event} must be an array of matcher groups.`);
        }
      }
    }
  }
  if ("mcpServers" in obj) {
    const m = obj.mcpServers as unknown;
    if (m === null || typeof m !== "object" || Array.isArray(m)) {
      errors.push("`mcpServers` must be an object keyed by server name.");
    } else {
      for (const [name, val] of Object.entries(m as Record<string, unknown>)) {
        if (val === null || typeof val !== "object" || Array.isArray(val)) {
          errors.push(`mcpServers.${name} must be an object.`);
          continue;
        }
        const cfg = val as Record<string, unknown>;
        const hasCommand = typeof cfg.command === "string";
        const hasUrl = typeof cfg.url === "string";
        if (!hasCommand && !hasUrl) {
          errors.push(`mcpServers.${name} needs either \`command\` or \`url\`.`);
        }
        if ("args" in cfg && cfg.args !== undefined && !Array.isArray(cfg.args)) {
          errors.push(`mcpServers.${name}.args must be an array of strings.`);
        }
        if ("env" in cfg && cfg.env !== undefined) {
          const e = cfg.env;
          if (e === null || typeof e !== "object" || Array.isArray(e)) {
            errors.push(`mcpServers.${name}.env must be an object.`);
          }
        }
      }
    }
  }
  if ("env" in obj) {
    const e = obj.env as unknown;
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      errors.push("`env` must be an object of string-valued keys.");
    }
  }
  if ("model" in obj && typeof obj.model !== "string") {
    errors.push("`model` must be a string.");
  }
  return errors;
}

// v15.2 F7: collapsible navigator that scrolls the textarea to the line where
// each top-level key appears. We index the live text rather than the parsed
// object so the indices stay accurate when the user is mid-edit.
function indexTopLevelKeys(text: string): Record<string, number> {
  // Match keys at indentation depth 2 (one level inside the root object).
  // settings.json is pretty-printed, so this is reliable enough for the
  // schema nav to "just work".
  const idx: Record<string, number> = {};
  const lines = text.split("\n");
  const re = /^\s{2}"([^"\\]+)"\s*:/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m && idx[m[1]] === undefined) {
      idx[m[1]] = i;
    }
  }
  return idx;
}

function JsonEditor({
  obj,
  onChange,
}: {
  obj: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  // We hold a draft string so the user can mid-type invalid JSON without
  // losing the buffer. When it parses cleanly we propagate up.
  const initial = useMemo(() => JSON.stringify(obj, null, 2), [obj]);
  const [text, setText] = useState(initial);
  const [parseError, setParseError] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiInfo, setAiInfo] = useState<string | null>(null);
  // v15.2 F7: schema validation + scroll navigator.
  const [schemaErrors, setSchemaErrors] = useState<string[] | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // External `obj` changes (e.g. after Save reload) overwrite the textarea
  // — otherwise the buffer would go stale silently.
  useEffect(() => {
    setText(initial);
    setParseError(null);
  }, [initial]);

  function commitText(next: string) {
    setText(next);
    try {
      const parsed = JSON.parse(next);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        setParseError("Root must be an object.");
        return;
      }
      setParseError(null);
      onChange(parsed as Record<string, unknown>);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
    }
  }

  async function askCodex() {
    if (!aiPrompt.trim()) return;
    setAiBusy(true);
    setAiError(null);
    setAiInfo(null);
    try {
      // System-prompt style framing — Codex returns the FULL replacement.
      const sys =
        "Eres un asistente que devuelve EXCLUSIVAMENTE un objeto JSON válido (sin texto antes ni después, sin fences si es posible) que representa el contenido completo y actualizado de ~/.claude/settings.json. Mantén todos los campos no relacionados con la petición. No inventes mcpServers, hooks ni claves que no existan ya, salvo que la petición lo pida explícitamente.";
      const user = `Configuración actual:\n\n${text}\n\nPetición del usuario:\n${aiPrompt}\n\nDevuelve el JSON completo y modificado.`;
      const prompt = `${sys}\n\n---\n\n${user}`;
      const r = (await invoke("run_inline", {
        provider: "codex",
        model: null,
        prompt,
      })) as { success: boolean; stdout: string; stderr: string; exit_code: number | null };
      if (!r.success) {
        setAiError(r.stderr || `Codex exit ${r.exit_code ?? "?"}`);
        return;
      }
      const candidate = extractJsonFromText(r.stdout);
      if (!candidate) {
        setAiError("Codex no devolvió JSON parseable.");
        return;
      }
      try {
        const parsed = JSON.parse(candidate);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          setAiError("Codex devolvió algo que no es un objeto JSON.");
          return;
        }
        setText(JSON.stringify(parsed, null, 2));
        onChange(parsed as Record<string, unknown>);
        setParseError(null);
        setAiInfo("Codex aplicó cambios — revisa el diff y pulsa Save para confirmar.");
        setAiOpen(false);
        setAiPrompt("");
      } catch (e) {
        setAiError(`No pude parsear la respuesta: ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (e) {
      setAiError(String(e));
    } finally {
      setAiBusy(false);
    }
  }

  const lines = text.split("\n").length;
  const keyIndex = useMemo(() => indexTopLevelKeys(text), [text]);
  // The four sections users actually edit. We always show them so the user
  // can see what's available even if the key is missing in their file (a
  // click on an absent key is a no-op rather than a jump). Anything else is
  // lumped under "Other keys" so the nav stays clean.
  const KNOWN_SECTIONS: { key: string; label: string }[] = [
    { key: "hooks", label: "hooks" },
    { key: "mcpServers", label: "mcpServers" },
    { key: "model", label: "model" },
    { key: "env", label: "env" },
  ];
  const otherKeys = useMemo(() => {
    const known = new Set(KNOWN_SECTIONS.map((s) => s.key));
    return Object.keys(keyIndex)
      .filter((k) => !known.has(k))
      .sort();
  }, [keyIndex]);

  function scrollToLine(lineIndex: number) {
    const ta = textareaRef.current;
    if (!ta) return;
    // Compute approx pixel offset by averaging line height. This works for
    // the monospace textarea even though we don't have a real layout API.
    const lh = 18; // approximate; the editor uses 11.5px font + leading
    ta.focus();
    ta.scrollTop = Math.max(0, lineIndex * lh - lh * 2);
    // Move the caret to the start of that line so a follow-up edit lands
    // at the section the user clicked on.
    const beforeLines = text.split("\n").slice(0, lineIndex);
    const offset = beforeLines.reduce((acc, l) => acc + l.length + 1, 0);
    ta.setSelectionRange(offset, offset);
  }

  function validate() {
    if (parseError) {
      setSchemaErrors(["Fix the JSON parse error first."]);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        setSchemaErrors(["Root must be a JSON object."]);
        return;
      }
      const errs = validateSettingsSchema(parsed as Record<string, unknown>);
      setSchemaErrors(errs);
    } catch (e) {
      setSchemaErrors([e instanceof Error ? e.message : String(e)]);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div
          className="text-[11px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Editable copy of <span style={{ fontFamily: "var(--font-mono)" }}>~/.claude/settings.json</span> · {lines} líneas · cualquier cambio se hace efectivo al pulsar Save (backup automático)
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={validate}
            className="rounded px-2.5 py-1 text-[11px] font-medium transition-colors"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Lightweight structural validation of hooks/mcpServers/env/model"
          >
            Validate schema
          </button>
          <button
            type="button"
            onClick={() => setAiOpen(!aiOpen)}
            className="rounded px-2.5 py-1 text-[11px] font-medium transition-colors"
            style={{
              background: aiOpen ? "var(--color-surface-3)" : "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Pide a Codex que modifique este JSON con instrucciones en lenguaje natural"
          >
            {aiOpen ? "Close AI assist" : "Ask Codex…"}
          </button>
        </div>
      </div>

      {schemaErrors !== null && (
        <div
          className="rounded p-2 text-[11.5px]"
          style={{
            background: schemaErrors.length === 0
              ? "rgba(63, 185, 80, 0.08)"
              : "rgba(248, 81, 73, 0.06)",
            border: `1px solid ${schemaErrors.length === 0 ? "rgba(63, 185, 80, 0.22)" : "rgba(248, 81, 73, 0.22)"}`,
            color: schemaErrors.length === 0 ? "var(--color-success)" : "var(--color-danger)",
          }}
        >
          {schemaErrors.length === 0 ? (
            <span>Schema OK — hooks/mcpServers/env/model shapes look valid.</span>
          ) : (
            <ul className="list-disc space-y-0.5 pl-4">
              {schemaErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {aiOpen && (
        <div
          className="rounded p-3"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          <label
            className="block text-[10px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Instrucción para Codex
          </label>
          <textarea
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            placeholder="Ej: añade un hook PostToolUse que ejecute el script ensure-qdrant.ps1 después de cualquier Bash"
            className="mt-1 w-full rounded p-2 text-[12px] leading-relaxed"
            style={{
              fontFamily: "var(--font-mono)",
              background: "var(--color-surface-1)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
              outline: "none",
              minHeight: 70,
              resize: "vertical",
            }}
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setAiOpen(false);
                setAiPrompt("");
                setAiError(null);
              }}
              disabled={aiBusy}
              className="rounded px-2.5 py-1 text-[11px]"
              style={{
                background: "transparent",
                color: "var(--color-text-tertiary)",
                border: "1px solid var(--color-border)",
              }}
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={askCodex}
              disabled={aiBusy || !aiPrompt.trim()}
              className="rounded px-3 py-1 text-[11px] font-medium disabled:opacity-50"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-accent-text)",
              }}
            >
              {aiBusy ? "Codex pensando…" : "Aplicar cambios"}
            </button>
          </div>
          {aiError && (
            <div
              className="mt-2 rounded px-2 py-1 text-[11px]"
              style={{
                background: "rgba(248, 81, 73, 0.06)",
                color: "var(--color-danger)",
                border: "1px solid rgba(248, 81, 73, 0.22)",
              }}
            >
              {aiError}
            </div>
          )}
        </div>
      )}

      {aiInfo && (
        <div
          className="rounded px-2 py-1 text-[11px]"
          style={{
            background: "rgba(63, 185, 80, 0.08)",
            color: "var(--color-success)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
          }}
        >
          {aiInfo}
        </div>
      )}

      {/* v15.2 F7: Schema navigator (left) + editable textarea (right). */}
      <div className="flex gap-3">
        <aside
          className="w-[170px] shrink-0 rounded p-2"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border)",
          }}
        >
          <div
            className="mb-2 text-[10px] font-medium uppercase tracking-[0.06em]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Schemas
          </div>
          <ul className="space-y-px">
            {KNOWN_SECTIONS.map((s) => {
              const present = keyIndex[s.key] !== undefined;
              return (
                <li key={s.key}>
                  <button
                    type="button"
                    onClick={() => present && scrollToLine(keyIndex[s.key])}
                    disabled={!present}
                    className="flex w-full items-center justify-between rounded px-2 py-1 text-[11.5px] transition-colors"
                    style={{
                      background: "transparent",
                      color: present
                        ? "var(--color-text-secondary)"
                        : "var(--color-text-faint)",
                      cursor: present ? "pointer" : "default",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    <span>{s.label}</span>
                    {!present && (
                      <span className="text-[9.5px]" style={{ color: "var(--color-text-faint)" }}>
                        absent
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {otherKeys.length > 0 && (
            <>
              <div
                className="mt-3 mb-1 text-[10px] font-medium uppercase tracking-[0.06em]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Other keys
              </div>
              <ul className="space-y-px">
                {otherKeys.map((k) => (
                  <li key={k}>
                    <button
                      type="button"
                      onClick={() => scrollToLine(keyIndex[k])}
                      className="block w-full truncate rounded px-2 py-1 text-left text-[11.5px]"
                      style={{
                        color: "var(--color-text-tertiary)",
                        fontFamily: "var(--font-mono)",
                      }}
                      title={k}
                    >
                      {k}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p
            className="mt-3 text-[10px] leading-snug"
            style={{ color: "var(--color-text-faint)" }}
          >
            Visual form coming in F7+. For now this navigator scrolls to the
            section. Use "Validate schema" before Save.
          </p>
        </aside>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            commitText(e.target.value);
            // Any edit invalidates a previous Validate run.
            if (schemaErrors !== null) setSchemaErrors(null);
          }}
          spellCheck={false}
          className="flex-1 rounded p-3 text-[11.5px] leading-relaxed"
          style={{
            fontFamily: "var(--font-mono)",
            background: "var(--color-surface-1)",
            color: "var(--color-text)",
            border: `1px solid ${parseError ? "rgba(248, 81, 73, 0.4)" : "var(--color-border)"}`,
            outline: "none",
            minHeight: 380,
            resize: "vertical",
          }}
        />
      </div>
      {parseError && (
        <div
          className="rounded px-2 py-1 text-[11px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            color: "var(--color-danger)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
          }}
        >
          {parseError}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Disk backup status — surfaces the configured backup root mirror freshness.
// The actual root path comes from the backend (ULTRON_BACKUP_ROOT env override
// or %USERPROFILE%\BACKUP fallback), so the frontend just renders report.root.
// ---------------------------------------------------------------------------

type BackupEntry = {
  name: string;
  path: string;
  last_modified: string | null;
  age_hours: number | null;
  exists: boolean;
  status: string;
};

type BackupStatusReport = {
  root: string;
  root_exists: boolean;
  entries: BackupEntry[];
  overall_status: string;
};

function formatHours(h: number | null): string {
  if (h == null) return "—";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 24) return `${Math.round(h)}h`;
  const days = Math.floor(h / 24);
  const rem = Math.round(h % 24);
  return rem > 0 ? `${days}d ${rem}h` : `${days}d`;
}

function statusTint(s: string): { bg: string; color: string; border: string } {
  switch (s) {
    case "ok":
      return {
        bg: "rgba(63, 185, 80, 0.08)",
        color: "var(--color-success)",
        border: "rgba(63, 185, 80, 0.22)",
      };
    case "stale":
      return {
        bg: "rgba(210, 153, 34, 0.06)",
        color: "var(--color-warn)",
        border: "rgba(210, 153, 34, 0.22)",
      };
    case "cold":
    case "missing":
      return {
        bg: "rgba(248, 81, 73, 0.06)",
        color: "var(--color-danger)",
        border: "rgba(248, 81, 73, 0.22)",
      };
    default:
      return {
        bg: "var(--color-surface-2)",
        color: "var(--color-text-tertiary)",
        border: "var(--color-border)",
      };
  }
}

// v15.2 F7: editable backup root. Reads the current path from the backend
// (which resolves user-config → env → D:\BACKUP → ~/BACKUP), lets the user
// set a new one, and shows whether the path currently exists.
type BackupRootInfo = {
  current: string;
  suggested: string;
  exists: boolean;
  user_configured: boolean;
  config_path: string;
};

function BackupRootEditor({ onChanged }: { onChanged: () => void }) {
  const [info, setInfo] = useState<BackupRootInfo | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function load() {
    try {
      const r = (await invoke("get_backup_root")) as BackupRootInfo;
      setInfo(r);
      setDraft(r.current);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function save(path: string) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const r = (await invoke("set_backup_root", { path })) as BackupRootInfo;
      setInfo(r);
      setDraft(r.current);
      setSuccess(`Backup root set to ${r.current}${r.exists ? "" : " (path does not exist yet)"}.`);
      window.setTimeout(() => setSuccess(null), 3500);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="mb-5 rounded p-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-baseline justify-between">
        <h3 className="text-[13px] font-semibold">Backup root path</h3>
        {info?.user_configured && (
          <span
            className="text-[10.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            user-configured
          </span>
        )}
      </div>
      <p
        className="mt-1 text-[11.5px] leading-relaxed"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Where ULTRON mirrors its weekly backups. Default:{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>
          {info?.suggested ?? "D:\\BACKUP"}
        </span>
        . Override persisted to{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>
          {info?.config_path ?? "~/.ultron/.tmp/backup-root.txt"}
        </span>
        ; weekly-backup.ps1 honours{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>$env:ULTRON_BACKUP_ROOT</span>.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={info?.suggested ?? "D:\\BACKUP"}
          spellCheck={false}
          className="rounded px-3 py-1.5 text-[12.5px]"
          style={{
            background: "var(--color-surface-1)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
            outline: "none",
            fontFamily: "var(--font-mono)",
            minWidth: 280,
            flex: "1 1 280px",
          }}
        />
        <button
          type="button"
          onClick={() => save(draft.trim())}
          disabled={busy || draft.trim() === (info?.current ?? "")}
          className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => save("")}
          disabled={busy || !info?.user_configured}
          className="rounded px-2.5 py-1.5 text-[11.5px] transition-colors disabled:opacity-40"
          style={{
            background: "transparent",
            color: "var(--color-text-tertiary)",
            border: "1px solid var(--color-border-strong)",
          }}
          title="Clear the user override and fall back to env / D:\\BACKUP / ~/BACKUP"
        >
          Reset to default
        </button>
      </div>
      {info && (
        <div
          className="mt-2 text-[11px]"
          style={{
            color: info.exists ? "var(--color-text-tertiary)" : "var(--color-warn)",
          }}
        >
          {info.exists
            ? "Path exists. Mirror status below reflects this root."
            : "Path does not exist yet — create it before the next weekly backup runs."}
        </div>
      )}
      {error && (
        <div
          className="mt-2 rounded p-2 text-[11px]"
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
          className="mt-2 rounded p-2 text-[11px]"
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

function DiskBackupStatus() {
  const [report, setReport] = useState<BackupStatusReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = (await invoke("backup_status")) as BackupStatusReport;
      setReport(r);
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

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[13px] font-semibold">
          Disk mirror{report?.root ? ` (${report.root})` : ""}
        </h3>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="text-[11px] transition-colors disabled:opacity-50"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      <p
        className="mb-3 text-[11.5px]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Estado del mirror semanal (robocopy /MIR vía
        <span style={{ fontFamily: "var(--font-mono)" }}> weekly-backup.ps1</span>).
        Mtime del top-level subdir = última pasada efectiva.
      </p>

      {error && (
        <div
          className="mb-3 rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {!loading && report && !report.root_exists && (
        <div
          className="rounded p-4 text-[12.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          Root no encontrado: {report.root}. El disco no está montado o nunca
          se ejecutó el primer backup.
        </div>
      )}

      {!loading && report && report.root_exists && report.entries.length === 0 && (
        <div
          className="rounded p-4 text-[12.5px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-tertiary)",
          }}
        >
          El root existe pero no hay subcarpetas — primer backup aún no
          se completó.
        </div>
      )}

      {!loading && report && report.entries.length > 0 && (
        <div
          className="rounded"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          {report.entries.map((e, i) => {
            const tint = statusTint(e.status);
            return (
              <div
                key={e.name}
                className="flex items-baseline gap-3 px-3 py-2.5"
                style={{
                  borderTop:
                    i === 0 ? "none" : "1px solid var(--color-border)",
                }}
              >
                <span
                  className="rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
                  style={{
                    background: tint.bg,
                    color: tint.color,
                    border: `1px solid ${tint.border}`,
                    minWidth: 52,
                    textAlign: "center",
                  }}
                >
                  {e.status}
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className="text-[12.5px] font-medium"
                    style={{ color: "var(--color-text)" }}
                  >
                    {e.name}
                  </div>
                  <div
                    className="mt-0.5 truncate text-[10.5px]"
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--color-text-faint)",
                    }}
                    title={e.path}
                  >
                    {e.path}
                  </div>
                </div>
                <span
                  className="shrink-0 tabular-nums text-[11.5px]"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {formatHours(e.age_hours)}
                </span>
                <span
                  className="shrink-0 text-[10.5px]"
                  style={{ color: "var(--color-text-faint)" }}
                >
                  {e.last_modified ? e.last_modified.slice(0, 10) : "—"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// v15.2 F7: "mcps" section removed — MCP enable/disable lives in the MCPs
// top-level tab now. Kept the union without it so stale state references
// surface as compile errors.
type Section = "general" | "auth" | "mode" | "ai-router" | "raw" | "backups";

// ---------------------------------------------------------------------------
// AI Router section — pick which provider runs which zone of the UI.
// Persisted to ~/.ultron/.tmp/ai-router.json by the Rust backend. Call sites
// (Diagnose PC, summarize newsletter, plan brainstorm, etc.) will pick this
// up in subsequent iterations; for now we just persist the config.
// ---------------------------------------------------------------------------

type AiRouterConfig = {
  diagnose: string;
  summarize: string;
  brainstorm_plans: string;
  news_generate: string;
  skill_edit: string;
  mcp_create: string;
  repo_review: string;
};

const AI_PROVIDERS = ["claude", "codex", "gemini"] as const;

const AI_ROUTER_ZONES: { key: keyof AiRouterConfig; label: string; help: string }[] = [
  {
    key: "diagnose",
    label: "Diagnose PC",
    help: "Análisis del informe de diagnóstico del sistema (Dashboard / Doctor).",
  },
  {
    key: "summarize",
    label: "Summarize newsletter",
    help: "Resumen rápido de un newsletter HTML desde la pestaña News.",
  },
  {
    key: "brainstorm_plans",
    label: "Brainstorm de plans",
    help: "Generar borradores/refinar specs de planes desde la pestaña Plans.",
  },
  {
    key: "news_generate",
    label: "Generate newsletter",
    help: "Generación del cuerpo del newsletter (ULTRON Times).",
  },
  {
    key: "skill_edit",
    label: "Skill editor",
    help: "Asistencia AI al editar SKILL.md desde la pestaña Skills.",
  },
  {
    key: "mcp_create",
    label: "MCP generator",
    help: "Generar plantillas de servidores MCP a partir de descripción.",
  },
  {
    key: "repo_review",
    label: "Repo review",
    help: "Revisión adversarial de repos / cambios uncommitted.",
  },
];

function AiRouterSection() {
  const [config, setConfig] = useState<AiRouterConfig | null>(null);
  const [draft, setDraft] = useState<AiRouterConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = (await invoke("read_ai_router")) as AiRouterConfig;
      setConfig(r);
      setDraft({ ...r });
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
    setError(null);
    setSuccess(null);
    try {
      const r = (await invoke("save_ai_router", { config: draft })) as AiRouterConfig;
      setConfig(r);
      setDraft({ ...r });
      setSuccess("AI Router actualizado.");
      window.setTimeout(() => setSuccess(null), 2500);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const dirty = useMemo(() => {
    if (!config || !draft) return false;
    return AI_ROUTER_ZONES.some((z) => config[z.key] !== draft[z.key]);
  }, [config, draft]);

  function updateZone(key: keyof AiRouterConfig, value: string) {
    if (!draft) return;
    setDraft({ ...draft, [key]: value });
  }

  return (
    <div className="space-y-4">
      <header>
        <h3 className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
          AI Router
        </h3>
        <p
          className="mt-1 text-[11.5px] leading-relaxed"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Selecciona qué modelo dispara cada acción del Control Center: Diagnose
          PC, summarize newsletter, AI brainstorm de plans, generación de
          newsletter, skill editor, MCP generator y repo review. El config se
          persiste en{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>
            ~/.ultron/.tmp/ai-router.json
          </span>{" "}
          para que cualquier script de ULTRON pueda leerlo. Las próximas
          iteraciones cablearán cada zona para que respete este routing.
        </p>
      </header>

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

      {success && (
        <div
          className="rounded px-2 py-1 text-[11.5px]"
          style={{
            background: "rgba(63, 185, 80, 0.08)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {success}
        </div>
      )}

      {loading && !draft && (
        <div
          className="rounded p-4 text-[12px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-tertiary)",
          }}
        >
          Loading…
        </div>
      )}

      {draft && (
        <>
          <div
            className="rounded"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            {AI_ROUTER_ZONES.map((z, i) => (
              <div
                key={z.key}
                className="flex items-start gap-4 px-3 py-3"
                style={{
                  borderTop: i === 0 ? "none" : "1px solid var(--color-border)",
                }}
              >
                <div className="min-w-0 flex-1">
                  <div
                    className="text-[12.5px] font-medium"
                    style={{ color: "var(--color-text)" }}
                  >
                    {z.label}
                  </div>
                  <p
                    className="mt-0.5 text-[11px] leading-relaxed"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    {z.help}
                  </p>
                </div>
                <select
                  value={draft[z.key]}
                  onChange={(e) => updateZone(z.key, e.target.value)}
                  disabled={saving}
                  className="shrink-0 rounded px-2 py-1 text-[12px]"
                  style={{
                    background: "var(--color-surface-1)",
                    color: "var(--color-text)",
                    border: "1px solid var(--color-border-strong)",
                    outline: "none",
                    fontFamily: "var(--font-mono)",
                    minWidth: 110,
                  }}
                  title={`Provider para ${z.label}`}
                >
                  {AI_PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => config && setDraft({ ...config })}
              disabled={!dirty || saving}
              className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-40"
              style={{
                background: "transparent",
                color: "var(--color-text-tertiary)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              Reset
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!dirty || saving}
              className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-accent-text)",
              }}
            >
              {saving ? "Guardando…" : "Save"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function HotkeyEditor() {
  const [spec, setSpec] = useState<string>("");
  const [draft, setDraft] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  // F1.6: clicking the "Capturar tecla" button steals focus from the
  // <input>, so onKeyDown never fires. Refocus the input as soon as
  // capturing flips to true.
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
    if (capturing) {
      inputRef.current?.focus();
    }
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
      setSuccess(`Registered: ${r}`);
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
    // Only commit on a non-modifier key press.
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
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-baseline justify-between">
        <div className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
          Global hotkey
        </div>
        <span
          className="text-[10.5px]"
          style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}
        >
          stored in ~/.ultron/.tmp/hotkey.txt
        </span>
      </div>
      <p
        className="mt-1 text-[11.5px] leading-relaxed"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Pulsa esta combinación en cualquier app de Windows para mostrar/ocultar
        el Control Center. Formato: <span style={{ fontFamily: "var(--font-mono)" }}>
        Ctrl+Alt+U</span>, <span style={{ fontFamily: "var(--font-mono)" }}>Ctrl+Shift+F12</span>,
        etc. Necesita al menos un modificador (Ctrl/Alt/Shift/Meta).
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
          className="rounded px-2.5 py-1 text-[11px]"
          style={{
            background: capturing ? "var(--color-surface-3)" : "transparent",
            color: capturing ? "var(--color-text)" : "var(--color-text-tertiary)",
            border: `1px solid ${capturing ? "var(--color-border-strong)" : "var(--color-border)"}`,
          }}
          title="Activa la captura de teclas para grabar la combinación"
        >
          {capturing ? "Cancelar captura" : "Capturar tecla"}
        </button>
        <button
          type="button"
          onClick={apply}
          disabled={busy || !draft.trim() || draft === spec}
          className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {busy ? "Aplicando…" : "Aplicar"}
        </button>
        <span className="text-[11px]" style={{ color: "var(--color-text-faint)" }}>
          activo: <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }}>{spec || "—"}</span>
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

function GeneralSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Wipe legacy autostart artifacts (Startup-folder .lnk, dangling
  // StartupApproved record) before/after every interaction so the plugin's
  // registry value is the single source of truth. Best-effort: a failure
  // here must not block the user from reading the toggle state.
  async function purgeLegacy(): Promise<string[]> {
    try {
      const res = await invoke<{ removed: string[]; warnings: string[] }>(
        "purge_legacy_autostart",
      );
      return res.removed ?? [];
    } catch {
      return [];
    }
  }

  useEffect(() => {
    (async () => {
      await purgeLegacy();
      try {
        setEnabled(await isAutostartEnabled());
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  async function toggle() {
    if (enabled === null) return;
    setBusy(true);
    setError(null);
    try {
      if (enabled) {
        await disableAutostart();
        setEnabled(false);
      } else {
        await enableAutostart();
        setEnabled(true);
      }
      // After every toggle clean any rogue artifact so the registry stays
      // the only source of truth on subsequent isAutostartEnabled() reads.
      await purgeLegacy();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Autostart with Windows */}
      <div
        className="flex items-start gap-3 rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        <button
          type="button"
          onClick={toggle}
          disabled={busy || enabled === null}
          className="mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50"
          style={{
            background: enabled
              ? "var(--color-success)"
              : "var(--color-surface-3)",
            border: "1px solid var(--color-border-strong)",
            padding: "1px",
          }}
          title={
            enabled
              ? "Click to stop launching ULTRON at Windows logon"
              : "Click to launch ULTRON at Windows logon"
          }
        >
          <span
            className="block h-3.5 w-3.5 rounded-full transition-transform"
            style={{
              background: "var(--color-text)",
              transform: enabled ? "translateX(16px)" : "translateX(0)",
            }}
          />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
            Start with Windows
          </div>
          <p
            className="mt-1 text-[12px] leading-relaxed"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Adds <span style={{ fontFamily: "var(--font-mono)" }}>HKCU\Software\Microsoft\Windows\CurrentVersion\Run</span>{" "}
            entry so the Control Center launches on logon with{" "}
            <span style={{ fontFamily: "var(--font-mono)" }}>--from-autostart</span>.
            The main window opens automatically and appears in the taskbar.
          </p>
        </div>
      </div>

      {/* Global hotkey */}
      <HotkeyEditor />

      {/* In-app keyboard map — read-only reference. The bindings live in
          src/App.tsx (Alt+digit) and CommandPalette (Ctrl+K). When we add
          custom bindings the helper here should grow to reflect them. */}
      <div
        className="rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        <div className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
          In-app shortcuts
        </div>
        <p
          className="mt-1 text-[11.5px] leading-relaxed"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Atajos dentro del Control Center. Alt+digit no roba teclas si
          estas escribiendo en un input.
        </p>
        <div
          className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11.5px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {[
            ["Ctrl + K", "Command palette"],
            ["Ctrl + ,", "Settings"],
            ["Ctrl + R", "Refresh top-level state"],
            ["Alt + 1", "Dashboard"],
            ["Alt + 2", "Usage"],
            ["Alt + 3", "Notifications"],
            ["Alt + 4", "Sessions"],
            ["Alt + 5", "Projects"],
            ["Alt + 6", "Plans"],
            ["Alt + 7", "Memory"],
            ["Alt + 8", "Skills"],
            ["Alt + 9", "Logs"],
            ["Alt + 0", "Settings"],
          ].map(([k, label]) => (
            <div key={k} className="flex items-baseline justify-between gap-2">
              <kbd
                className="rounded px-1.5 py-px text-[10.5px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {k}
              </kbd>
              <span style={{ color: "var(--color-text-tertiary)" }}>{label}</span>
            </div>
          ))}
        </div>
      </div>


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
    </div>
  );
}

function ModeSection() {
  const { mode, autodetectDefault, isAuto, refresh } = useUltronMode();
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  async function resetToAuto() {
    setResetting(true);
    setResetError(null);
    try {
      await invoke("reset_mode_to_autodetect");
      refresh();
    } catch (e) {
      setResetError(String(e));
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="space-y-4">
      <header>
        <h3 className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
          Orchestration mode
        </h3>
        <p
          className="mt-1 text-[11.5px] leading-relaxed"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          The mode the hook system primes for the next ULTRON session. Source of truth:
          {" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>~/.ultron/.tmp/current-session.json</span>.
        </p>
      </header>

      {/* v15.2 F7: prominent current + default + reset row.
          - Currently active (big): the resolved mode now (or AUTO if user
            hit the reset button — the hooks will pick a concrete mode on
            the next SessionStart).
          - Default (small): what autodetect would pick — currently MEDIUM
            per mode-trigger.py heuristics. */}
      <div
        className="rounded p-4"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <div
              className="text-[10.5px] uppercase tracking-[0.08em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Currently active
            </div>
            <div
              className="mt-1 text-[24px] font-semibold leading-none tabular-nums"
              style={{ color: "var(--color-text)" }}
            >
              {isAuto ? "AUTO" : (mode ?? "—")}
            </div>
            <div
              className="mt-2 text-[11px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Default (autodetect would pick):{" "}
              <strong style={{ color: "var(--color-text-secondary)" }}>
                {autodetectDefault}
              </strong>
            </div>
          </div>
          <button
            type="button"
            onClick={resetToAuto}
            disabled={resetting}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Writes mode=auto to current-session.json — the next SessionStart hook will pick the mode from the prompt instead of using a stored override."
          >
            {resetting ? "Resetting…" : "Reset to autodetect"}
          </button>
        </div>
        {resetError && (
          <div
            className="mt-3 rounded p-2 text-[11.5px]"
            style={{
              background: "rgba(248, 81, 73, 0.06)",
              border: "1px solid rgba(248, 81, 73, 0.22)",
              color: "var(--color-danger)",
            }}
          >
            {resetError}
          </div>
        )}
      </div>

      <ModeSwitcher current={mode} onChange={() => refresh()} />
    </div>
  );
}

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

  // v15.2 F7: toggleMcp / mcps memo removed — MCP enable/disable now lives
  // in the MCPs top-level tab (EnableDisableSection in MCPs.tsx).

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
          // v15.2 F7: "MCPs" sub-tab removed — moved to top-level MCPs tab.
          { id: "raw" as Section, label: "Editor" },
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
        {section === "general" && <GeneralSection />}
        {section === "auth" && <AuthStatus />}
        {section === "mode" && <ModeSection />}
        {section === "ai-router" && <AiRouterSection />}
        {/* v15.2 F7: MCPs enable/disable moved to the top-level MCPs tab.
            The MCPRow / toggleMcp / mcps memo below remain in scope as
            inert helpers — kept for retrocompat in case external code
            imports them, will be removed in F8. */}

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
      </div>
    </div>
  );
}
