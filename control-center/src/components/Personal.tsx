import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Personal tab — free-form profile note that ULTRON skills can pull as
// persistent context. Stored at ~/.ultron/personal/profile.md. Saves are
// backed up to a sibling backups/ folder (rotating last 30) so editing
// here is always reversible.

type PersonalProfile = {
  path: string;
  content: string;
  last_modified: string | null;
  size_bytes: number;
};

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  return `${(b / 1024).toFixed(1)} KB`;
}

function formatRel(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso;
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function Personal() {
  const [profile, setProfile] = useState<PersonalProfile | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = (await invoke("read_personal_profile")) as PersonalProfile;
      setProfile(r);
      setDraft(r.content);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!profile) return;
    setSaving(true);
    setError(null);
    try {
      const r = (await invoke("save_personal_profile", { content: draft })) as PersonalProfile;
      setProfile(r);
      setDraft(r.content);
      setInfo("Guardado.");
      window.setTimeout(() => setInfo(null), 2000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const dirty = profile != null && draft !== profile.content;

  return (
    <div className="flex h-full flex-col overflow-hidden px-8 py-6">
      <header className="mb-3 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">Personal</h1>
          <p className="mt-1 text-[12.5px]" style={{ color: "var(--color-text-secondary)" }}>
            Texto libre que ULTRON usa como contexto persistente. Estilo de
            escritura, rutinas, preferencias técnicas, patrones de prompts.
            Cualquier skill puede leerlo bajo
            <span style={{ fontFamily: "var(--font-mono)" }}> ~/.ultron/personal/profile.md</span>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {profile && (
            <span
              className="text-[10.5px]"
              style={{ color: "var(--color-text-faint)" }}
              title={profile.path}
            >
              {formatBytes(profile.size_bytes)} · {formatRel(profile.last_modified)}
            </span>
          )}
          <button
            type="button"
            onClick={load}
            disabled={loading || saving}
            className="rounded px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-50"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            Reload
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
            {saving ? "Saving..." : dirty ? "Save" : "Saved"}
          </button>
        </div>
      </header>

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

      {info && (
        <div
          className="mb-3 rounded p-2 text-[11.5px]"
          style={{
            background: "rgba(63, 185, 80, 0.08)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {info}
        </div>
      )}

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        placeholder={loading ? "Loading..." : ""}
        className="flex-1 rounded p-4 text-[12.5px] leading-relaxed"
        style={{
          fontFamily: "var(--font-mono)",
          background: "var(--color-surface-1)",
          color: "var(--color-text)",
          border: `1px solid ${dirty ? "var(--color-warn)" : "var(--color-border-strong)"}`,
          outline: "none",
          minHeight: 400,
          resize: "none",
        }}
      />
      <div
        className="mt-2 flex items-baseline justify-between text-[10.5px]"
        style={{ color: "var(--color-text-faint)" }}
      >
        <span>{draft.length.toLocaleString()} chars · {draft.split("\n").length} líneas</span>
        <span>
          Backups rotativos (últimos 30) en
          <span style={{ fontFamily: "var(--font-mono)" }}> ~/.ultron/personal/profile.backups/</span>
        </span>
      </div>
    </div>
  );
}
