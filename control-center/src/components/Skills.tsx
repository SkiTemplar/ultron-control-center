import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  SkillCreateResult,
  SkillDeleteResult,
  SkillInfo,
  SkillState,
  SkillUpdateResult,
} from "../types";
import { SkillRichView } from "./SkillRichView";
import { getHomeDir, joinPath } from "../lib/paths";

// Default body when creating a new skill. Keeps the user oriented without
// overwhelming the textarea.
const NEW_SKILL_TEMPLATE = `# Overview\n\nWhat does this skill do?\n\n# When to use\n\n- Trigger phrases\n- Concrete examples\n\n# Notes\n\n- Any constraints, references, follow-up TODOs\n`;

// ---------------------------------------------------------------------------
// State styling
// ---------------------------------------------------------------------------

type StateKey = "active" | "plugin" | "vaulted";

function stateBadge(s: SkillState): { color: string; bg: string; label: string } {
  switch (s) {
    case "active":
      return {
        color: "var(--color-success)",
        bg: "rgba(63, 185, 80, 0.08)",
        label: "active",
      };
    case "plugin":
      return {
        color: "var(--color-text-secondary)",
        bg: "var(--color-surface-3)",
        label: "plugin",
      };
    case "vaulted":
      return {
        color: "var(--color-text-tertiary)",
        bg: "var(--color-surface-2)",
        label: "vault",
      };
    default:
      return {
        color: "var(--color-text-tertiary)",
        bg: "var(--color-surface-2)",
        label: String(s),
      };
  }
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function Row({
  s,
  selected,
  onClick,
}: {
  s: SkillInfo;
  selected: boolean;
  onClick: () => void;
}) {
  const b = stateBadge(s.state);
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-baseline gap-3 rounded px-3 py-2 text-left transition-colors"
      style={{
        background: selected ? "var(--color-surface-3)" : "transparent",
        border: `1px solid ${selected ? "var(--color-border-strong)" : "transparent"}`,
      }}
      onMouseEnter={(e) => {
        if (!selected)
          (e.currentTarget as HTMLButtonElement).style.background =
            "var(--color-surface-2)";
      }}
      onMouseLeave={(e) => {
        if (!selected)
          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
      }}
    >
      <span
        className="shrink-0 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide tabular-nums"
        style={{ background: b.bg, color: b.color, minWidth: 56, textAlign: "center" }}
      >
        {b.label}
      </span>
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-[12.5px] font-medium"
          style={{ color: "var(--color-text)" }}
        >
          {s.name}
        </div>
        {s.description && (
          <div
            className="truncate text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {s.description}
          </div>
        )}
      </div>
      {s.usage_count > 0 && (
        <span
          className="shrink-0 tabular-nums text-[10.5px]"
          style={{ color: "var(--color-text-faint)" }}
          title={`Used ${s.usage_count} times`}
        >
          ×{s.usage_count}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Filter pill
// ---------------------------------------------------------------------------

function Pill({
  active,
  label,
  count,
  onClick,
  color,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] transition-colors"
      style={{
        background: active ? "var(--color-surface-3)" : "transparent",
        color: active ? "var(--color-text)" : "var(--color-text-tertiary)",
        border: `1px solid ${active ? "var(--color-border-strong)" : "var(--color-border)"}`,
      }}
    >
      {color && (
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: color, opacity: active ? 1 : 0.4 }}
        />
      )}
      <span>{label}</span>
      <span
        className="tabular-nums"
        style={{ color: active ? "var(--color-text-secondary)" : "var(--color-text-faint)" }}
      >
        {count}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Preview panel
// ---------------------------------------------------------------------------

// Tiny inline icon-buttons for the preview header. Match existing styling.
function HeaderBtn({
  label,
  onClick,
  disabled,
  variant = "default",
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "danger";
}) {
  const danger = variant === "danger";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded px-2 py-1 text-[11px] transition-colors disabled:opacity-40"
      style={{
        background: "var(--color-surface-2)",
        color: danger ? "var(--color-danger)" : "var(--color-text-secondary)",
        border: `1px solid ${danger ? "rgba(248, 81, 73, 0.32)" : "var(--color-border-strong)"}`,
      }}
    >
      {label}
    </button>
  );
}

type PreviewMode = "view" | "edit" | "ai-edit" | "confirm-delete";
type ViewKind = "rich" | "raw";

function Preview({
  skill,
  onMutated,
  onDeleted,
}: {
  skill: SkillInfo;
  onMutated: () => void;
  onDeleted: () => void;
}) {
  const [content, setContent] = useState<string>("");
  const [draft, setDraft] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<PreviewMode>("view");
  const [view, setView] = useState<ViewKind>("rich");
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiBusy, setAiBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setStatus(null);
    setMode("view");
    setContent("");
    setDraft("");
    invoke<string>("read_skill_md", { name: skill.name })
      .then((c) => {
        if (!cancelled) {
          setContent(c);
          setDraft(c);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [skill.name]);

  function flash(msg: string) {
    setStatus(msg);
    window.setTimeout(() => setStatus(null), 2500);
  }

  async function handleSaveEdit() {
    setBusy(true);
    setError(null);
    try {
      const res = await invoke<SkillUpdateResult>("update_skill_md", {
        name: skill.name,
        content: draft,
      });
      setContent(draft);
      setMode("view");
      flash(`Saved — backup at ${res.backup_path}`);
      onMutated();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleAiEdit() {
    if (!aiInstruction.trim()) return;
    setAiBusy(true);
    setError(null);
    try {
      // Spawn a Claude session in ~/.claude/skills/<name>/ with a prompt
      // that loads SKILL.md and applies the user's instruction. We use the
      // skill folder so Claude's auto-discovery picks up SKILL.md and any
      // sibling files (mode-*.md, references/, etc.) without us reading
      // them ourselves. The session lives in wt.exe so the user can iterate
      // turn-by-turn (Claude proposes a diff, user accepts / refines).
      const promptText = [
        `Quiero editar este skill (~/.claude/skills/${skill.name}/SKILL.md).`,
        "",
        "Instrucción:",
        aiInstruction.trim(),
        "",
        "Lee primero el SKILL.md actual y los archivos hermanos si son relevantes. Propon el cambio como diff antes de escribir. Mantén el frontmatter YAML válido.",
      ].join("\n");
      const skillDir =
        skill.path ?? joinPath(await getHomeDir(), ".claude", "skills", skill.name);
      // v15.2 AI Router: the "skill_edit" zone decides provider + model.
      // Default zone provider is claude (best at preserving SKILL.md
      // structure / YAML frontmatter). On any router error we fall back
      // to the previous hardcoded "claude" so the button keeps working.
      type Zone = { provider: string; model: string | null };
      let zone: Zone = { provider: "claude", model: null };
      try {
        const cfg = (await invoke("read_ai_router")) as Record<string, Zone>;
        if (cfg && cfg.skill_edit) zone = cfg.skill_edit;
      } catch {
        // keep default
      }
      await invoke("spawn_session", {
        provider: zone.provider,
        prompt: promptText,
        cwd: skillDir,
        flags: {
          dangerouslySkipPermissions: false,
          model: zone.model ?? undefined,
        },
      });
      setMode("view");
      setAiInstruction("");
      flash("Claude session abierta en wt.exe para editar este skill.");
    } catch (e) {
      setError(String(e));
    } finally {
      setAiBusy(false);
    }
  }

  async function handleDelete(soft: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await invoke<SkillDeleteResult>("delete_skill", {
        name: skill.name,
        soft,
      });
      flash(soft ? `Demoted to vault: ${res.to_path}` : `Archived: ${res.to_path}`);
      onDeleted();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  const b = stateBadge(skill.state);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header
        className="border-b px-5 py-4"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="flex items-center gap-2">
          <span
            className="rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
            style={{ background: b.bg, color: b.color }}
          >
            {b.label}
          </span>
          <h2 className="text-[15px] font-semibold leading-none">{skill.name}</h2>
          <div className="ml-auto flex items-center gap-1.5">
            {mode === "view" && (
              <>
                <div
                  className="flex items-center overflow-hidden rounded text-[10.5px]"
                  style={{ border: "1px solid var(--color-border-strong)" }}
                >
                  {(["rich", "raw"] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setView(v)}
                      className="px-2 py-1 uppercase tracking-wide"
                      style={{
                        background: view === v ? "var(--color-surface-3)" : "transparent",
                        color: view === v ? "var(--color-text)" : "var(--color-text-tertiary)",
                      }}
                    >
                      {v}
                    </button>
                  ))}
                </div>
                <HeaderBtn label="Edit" onClick={() => setMode("edit")} disabled={busy || loading} />
                <HeaderBtn
                  label="AI"
                  onClick={() => setMode("ai-edit")}
                  disabled={busy || loading}
                />
                <HeaderBtn
                  label="Delete"
                  variant="danger"
                  onClick={() => setMode("confirm-delete")}
                  disabled={busy || loading}
                />
              </>
            )}
            {mode === "edit" && (
              <>
                <HeaderBtn label="Cancel" onClick={() => { setDraft(content); setMode("view"); setError(null); }} disabled={busy} />
                <HeaderBtn label={busy ? "Saving…" : "Save"} onClick={handleSaveEdit} disabled={busy || draft === content} />
              </>
            )}
            {mode === "ai-edit" && (
              <HeaderBtn
                label="Cancel"
                onClick={() => {
                  setMode("view");
                  setAiInstruction("");
                  setError(null);
                }}
                disabled={aiBusy}
              />
            )}
            {mode === "confirm-delete" && (
              <HeaderBtn label="Cancel" onClick={() => { setMode("view"); setError(null); }} disabled={busy} />
            )}
          </div>
        </div>
        {skill.description && (
          <p
            className="mt-2 text-[12.5px] leading-relaxed"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {skill.description}
          </p>
        )}
        {skill.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {skill.tags.map((t) => (
              <span
                key={t}
                className="rounded px-1.5 py-px text-[10px]"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-tertiary)",
                }}
              >
                {t}
              </span>
            ))}
          </div>
        )}
        {skill.path && (
          <div
            className="mt-2 truncate text-[10.5px]"
            style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-faint)" }}
            title={skill.path}
          >
            {skill.path}
          </div>
        )}
        {status && (
          <div
            className="mt-2 rounded px-2 py-1 text-[11px]"
            style={{
              background: "rgba(63, 185, 80, 0.08)",
              color: "var(--color-success)",
              border: "1px solid rgba(63, 185, 80, 0.22)",
            }}
          >
            {status}
          </div>
        )}
        {error && (
          <div
            className="mt-2 rounded px-2 py-1 text-[11px]"
            style={{
              background: "rgba(248, 81, 73, 0.06)",
              border: "1px solid rgba(248, 81, 73, 0.22)",
              color: "var(--color-danger)",
            }}
          >
            {error}
          </div>
        )}
        {mode === "confirm-delete" && (
          <div
            className="mt-3 flex flex-wrap items-center gap-2 rounded p-2 text-[11.5px]"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border-strong)",
              color: "var(--color-text-secondary)",
            }}
          >
            <span>Confirm: remove this skill?</span>
            <HeaderBtn
              label={busy ? "Working…" : "Demote to vault"}
              onClick={() => handleDelete(true)}
              disabled={busy}
            />
            <HeaderBtn
              label={busy ? "Working…" : "Move to backup"}
              variant="danger"
              onClick={() => handleDelete(false)}
              disabled={busy}
            />
          </div>
        )}
        {mode === "ai-edit" && (
          <div
            className="mt-3 rounded p-3"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            <div
              className="text-[10px] font-medium uppercase tracking-[0.06em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Edit con Claude
            </div>
            <p
              className="mt-1 text-[11.5px] leading-relaxed"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Spawnea una sesion Claude en la carpeta del skill con SKILL.md
              precargada. Claude proposa un diff antes de escribir, tu lo
              aceptas/rechazas en wt.exe.
            </p>
            <textarea
              value={aiInstruction}
              onChange={(e) => setAiInstruction(e.target.value)}
              placeholder="Ej: anade un bloque triggers para 'modo nocturno', mantiene el resto intacto"
              className="mt-2 w-full rounded p-2 text-[12px] leading-relaxed"
              style={{
                fontFamily: "var(--font-mono)",
                background: "var(--color-surface-1)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
                minHeight: 90,
                resize: "vertical",
              }}
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <HeaderBtn
                label={aiBusy ? "Spawning..." : "Open Claude session"}
                onClick={handleAiEdit}
                disabled={aiBusy || !aiInstruction.trim()}
              />
            </div>
          </div>
        )}
      </header>
      <div className="flex-1 overflow-auto px-5 py-4">
        {loading && (
          <div className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            Loading SKILL.md…
          </div>
        )}
        {!loading && mode === "edit" && (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="h-full w-full resize-none rounded p-3 text-[11.5px] leading-relaxed"
            style={{
              fontFamily: "var(--font-mono)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
              outline: "none",
              minHeight: 320,
            }}
          />
        )}
        {!loading && mode !== "edit" && view === "rich" && (
          <SkillRichView raw={content} />
        )}
        {!loading && mode !== "edit" && view === "raw" && (
          <pre
            className="whitespace-pre-wrap text-[11.5px] leading-relaxed"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--color-text-secondary)",
            }}
          >
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// New-skill modal
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;

function NewSkillModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState(NEW_SKILL_TEMPLATE);
  const [layer, setLayer] = useState<"active" | "vaulted">("active");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slugOk = SLUG_RE.test(name);
  const descOk = description.trim().length > 0 && description.trim().length <= 300;
  const canSubmit = slugOk && descOk && !busy;

  async function handleSubmit() {
    setBusy(true);
    setError(null);
    try {
      const res = await invoke<SkillCreateResult>("create_skill", {
        name,
        description: description.trim(),
        body,
        layer,
      });
      onCreated(res.name);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-6"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-[640px] flex-col overflow-hidden rounded"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border-strong)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="flex items-center justify-between border-b px-5 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <h2 className="text-[14px] font-semibold">New skill</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-[12px]"
            style={{ color: "var(--color-text-tertiary)" }}
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <div className="flex-1 space-y-3 overflow-auto px-5 py-4">
          <div>
            <label
              className="mb-1 block text-[10px] font-medium uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Slug
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-new-skill"
              className="w-full rounded px-2.5 py-1.5 text-[12.5px]"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: `1px solid ${name && !slugOk ? "rgba(248, 81, 73, 0.4)" : "var(--color-border-strong)"}`,
                outline: "none",
                fontFamily: "var(--font-mono)",
              }}
            />
            <div
              className="mt-1 text-[10.5px]"
              style={{ color: name && !slugOk ? "var(--color-danger)" : "var(--color-text-faint)" }}
            >
              Lowercase letters, digits, dashes. 2–61 chars. Must start with [a-z0-9].
            </div>
          </div>

          <div>
            <label
              className="mb-1 block text-[10px] font-medium uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Description
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One-line summary that ends up in the YAML frontmatter."
              maxLength={300}
              className="w-full rounded px-2.5 py-1.5 text-[12.5px]"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
              }}
            />
            <div
              className="mt-1 text-[10.5px]"
              style={{ color: "var(--color-text-faint)" }}
            >
              {description.trim().length}/300
            </div>
          </div>

          <div>
            <label
              className="mb-1 block text-[10px] font-medium uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Layer
            </label>
            <div className="flex gap-1.5">
              {(["active", "vaulted"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setLayer(k)}
                  className="rounded px-2.5 py-1 text-[11px]"
                  style={{
                    background: layer === k ? "var(--color-surface-3)" : "transparent",
                    color: layer === k ? "var(--color-text)" : "var(--color-text-tertiary)",
                    border: `1px solid ${layer === k ? "var(--color-border-strong)" : "var(--color-border)"}`,
                  }}
                >
                  {k === "active" ? "Active (~/.claude/skills)" : "Vault (~/.ultron/skill-vault)"}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label
              className="mb-1 block text-[10px] font-medium uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Body (frontmatter auto-prepended)
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              spellCheck={false}
              className="w-full rounded p-2.5 text-[11.5px] leading-relaxed"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
                fontFamily: "var(--font-mono)",
                minHeight: 220,
                resize: "vertical",
              }}
            />
          </div>

          {error && (
            <div
              className="rounded p-2 text-[11.5px]"
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
        <footer
          className="flex items-center justify-end gap-2 border-t px-5 py-3"
          style={{ borderColor: "var(--color-border)" }}
        >
          <HeaderBtn label="Cancel" onClick={onClose} disabled={busy} />
          <HeaderBtn
            label={busy ? "Creating…" : "Create skill"}
            onClick={handleSubmit}
            disabled={!canSubmit}
          />
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function Skills() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [states, setStates] = useState<Set<StateKey>>(() => new Set(["active", "plugin"]));
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [onlyUsed, setOnlyUsed] = useState(false);
  const [tagFilter, setTagFilter] = useState<Set<string>>(() => new Set());
  const [showAllTags, setShowAllTags] = useState(false);
  const [showNewModal, setShowNewModal] = useState(false);

  function reload(): Promise<SkillInfo[]> {
    return invoke<SkillInfo[]>("list_skills")
      .then((list) => {
        setSkills(list);
        setError(null);
        return list;
      })
      .catch((e) => {
        setError(String(e));
        return [] as SkillInfo[];
      });
  }

  useEffect(() => {
    reload().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = useMemo(() => {
    const c: Record<StateKey, number> = { active: 0, plugin: 0, vaulted: 0 };
    for (const s of skills) {
      if (s.state in c) c[s.state as StateKey] += 1;
    }
    return c;
  }, [skills]);

  // Top tags computed once, ranked by frequency
  const allTags = useMemo(() => {
    const freq = new Map<string, number>();
    for (const s of skills) {
      if (!states.has(s.state as StateKey)) continue;
      for (const t of s.tags) {
        if (!t) continue;
        freq.set(t, (freq.get(t) ?? 0) + 1);
      }
    }
    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([tag, n]) => ({ tag, n }));
  }, [skills, states]);

  const usedCount = useMemo(
    () => skills.filter((s) => s.usage_count > 0 && states.has(s.state as StateKey)).length,
    [skills, states],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills
      .filter((s) => states.has(s.state as StateKey))
      .filter((s) => !onlyUsed || s.usage_count > 0)
      .filter((s) => {
        if (tagFilter.size === 0) return true;
        return s.tags.some((t) => tagFilter.has(t));
      })
      .filter((s) => {
        if (!q) return true;
        if (s.name.toLowerCase().includes(q)) return true;
        if ((s.description ?? "").toLowerCase().includes(q)) return true;
        if (s.tags.some((t) => t.toLowerCase().includes(q))) return true;
        return false;
      })
      .sort((a, b) => {
        const order = { active: 0, plugin: 1, vaulted: 2 } as Record<string, number>;
        const oa = order[a.state] ?? 3;
        const ob = order[b.state] ?? 3;
        if (oa !== ob) return oa - ob;
        // Within same state, used skills first
        if (a.usage_count !== b.usage_count) return b.usage_count - a.usage_count;
        return a.name.localeCompare(b.name);
      });
  }, [skills, states, query, onlyUsed, tagFilter]);

  const selectedSkill = useMemo(
    () => skills.find((s) => s.name === selected) ?? null,
    [skills, selected],
  );

  function toggleState(k: StateKey) {
    const next = new Set(states);
    if (next.has(k)) {
      if (next.size > 1) next.delete(k);
    } else {
      next.add(k);
    }
    setStates(next);
  }

  function toggleTag(t: string) {
    const next = new Set(tagFilter);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setTagFilter(next);
  }

  return (
    <div className="flex h-full">
      {/* Left: list */}
      <div className="flex w-[44%] min-w-[420px] flex-col overflow-hidden border-r" style={{ borderColor: "var(--color-border)" }}>
        <header
          className="border-b px-5 py-4"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-[18px] font-semibold leading-tight">Skills</h1>
              <p className="mt-1 text-[12px]" style={{ color: "var(--color-text-secondary)" }}>
                {skills.length} total · {filtered.length} shown
              </p>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <button
                type="button"
                onClick={async () => {
                  try {
                    const instr = (await invoke("instruction_path", {
                      kind: "skills",
                    })) as string;
                    await invoke("spawn_session", {
                      provider: "claude",
                      prompt:
                        "Vamos a crear un nuevo skill para Claude Code. Lee el GUIDE.md de esta carpeta para conocer el schema YAML, allowed-tools, layers (active/vault) y post-creation. Después pregúntame slug, descripción y triggers, y genera el SKILL.md completo en ~/.claude/skills/<slug>/ o ~/.ultron/skill-vault/<slug>/ según indique.",
                      cwd: instr,
                      flags: { dangerouslySkipPermissions: false },
                    });
                  } catch (e) {
                    console.error("create skill with AI failed", e);
                  }
                }}
                className="rounded px-2.5 py-1 text-[11.5px] font-medium"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
                title="Sesión Claude con cwd=instructions/skills/ y GUIDE.md auto-cargado"
              >
                AI
              </button>
              <button
                type="button"
                onClick={() => setShowNewModal(true)}
                className="rounded px-2.5 py-1 text-[11.5px]"
                style={{
                  background: "var(--color-surface-2)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                + New
              </button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            <Pill
              label="Active"
              count={counts.active}
              color="var(--color-success)"
              active={states.has("active")}
              onClick={() => toggleState("active")}
            />
            <Pill
              label="Plugin"
              count={counts.plugin}
              color="var(--color-text-secondary)"
              active={states.has("plugin")}
              onClick={() => toggleState("plugin")}
            />
            <Pill
              label="Vault"
              count={counts.vaulted}
              color="var(--color-text-tertiary)"
              active={states.has("vaulted")}
              onClick={() => toggleState("vaulted")}
            />
            <span className="mx-1 my-auto h-4 w-px" style={{ background: "var(--color-border-strong)" }} />
            <Pill
              label="Used"
              count={usedCount}
              active={onlyUsed}
              onClick={() => setOnlyUsed(!onlyUsed)}
            />
          </div>

          <input
            type="text"
            placeholder="Search by name, description, tag…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="mt-3 w-full rounded px-3 py-1.5 text-[12.5px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
              outline: "none",
            }}
          />

          {/* Tag filter chips */}
          {allTags.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 flex items-baseline justify-between">
                <span
                  className="text-[10px] font-medium uppercase tracking-[0.06em]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  Tags {tagFilter.size > 0 && `· ${tagFilter.size} selected`}
                </span>
                {tagFilter.size > 0 && (
                  <button
                    type="button"
                    onClick={() => setTagFilter(new Set())}
                    className="text-[10px]"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    clear
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-1">
                {(showAllTags ? allTags : allTags.slice(0, 14)).map(({ tag, n }) => {
                  const active = tagFilter.has(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => toggleTag(tag)}
                      className="rounded px-1.5 py-0.5 text-[10.5px] transition-colors"
                      style={{
                        background: active ? "var(--color-surface-3)" : "transparent",
                        color: active ? "var(--color-text)" : "var(--color-text-tertiary)",
                        border: `1px solid ${active ? "var(--color-border-strong)" : "var(--color-border)"}`,
                      }}
                    >
                      {tag}
                      <span
                        className="ml-1 tabular-nums"
                        style={{ color: active ? "var(--color-text-secondary)" : "var(--color-text-faint)" }}
                      >
                        {n}
                      </span>
                    </button>
                  );
                })}
                {allTags.length > 14 && (
                  <button
                    type="button"
                    onClick={() => setShowAllTags(!showAllTags)}
                    className="rounded px-1.5 py-0.5 text-[10.5px]"
                    style={{
                      color: "var(--color-text-tertiary)",
                      border: "1px dashed var(--color-border)",
                    }}
                  >
                    {showAllTags ? `less` : `+${allTags.length - 14} more`}
                  </button>
                )}
              </div>
            </div>
          )}
        </header>

        <div className="flex-1 overflow-auto px-2 py-2">
          {loading && (
            <div className="px-3 py-4 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
              Loading…
            </div>
          )}
          {error && (
            <div
              className="m-2 rounded p-3 text-[12px]"
              style={{
                background: "rgba(248, 81, 73, 0.06)",
                border: "1px solid rgba(248, 81, 73, 0.22)",
                color: "var(--color-danger)",
              }}
            >
              {error}
            </div>
          )}
          {!loading && filtered.length === 0 && skills.length > 0 && (
            <div className="px-3 py-4 text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
              No skills match the current filters.
            </div>
          )}
          <div className="space-y-px">
            {filtered.map((s) => (
              <Row
                key={s.name}
                s={s}
                selected={selected === s.name}
                onClick={() => setSelected(s.name)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Right: preview */}
      <div className="flex-1 overflow-hidden">
        {selectedSkill ? (
          <Preview
            key={selectedSkill.name}
            skill={selectedSkill}
            onMutated={() => {
              void reload();
            }}
            onDeleted={() => {
              const removed = selectedSkill.name;
              void reload().then((list) => {
                if (!list.some((s) => s.name === removed)) {
                  setSelected(null);
                }
              });
            }}
          />
        ) : (
          <div
            className="flex h-full items-center justify-center text-[13px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Select a skill to preview its SKILL.md
          </div>
        )}
      </div>

      {showNewModal && (
        <NewSkillModal
          onClose={() => setShowNewModal(false)}
          onCreated={(name) => {
            setShowNewModal(false);
            void reload().then(() => setSelected(name));
          }}
        />
      )}
    </div>
  );
}
