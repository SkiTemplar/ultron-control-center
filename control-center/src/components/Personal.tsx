import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Personal tab — split view.
//
// Left side: read-only "what ULTRON knows about you" composed by a Claude
// session that scans transcripts, recent commits and MEMORY.md. Stored as
// JSON at ~/.ultron/personal/known.json (the user does not edit it
// directly; pressing the button spawns Claude to (re)compose it).
//
// Right side: free-form profile note at ~/.ultron/personal/profile.md that
// the user maintains by hand. Saves are backed up to a sibling
// profile.backups/ folder (rotating last 30) so editing here is reversible.

type PersonalProfile = {
  path: string;
  content: string;
  last_modified: string | null;
  size_bytes: number;
  // True when the backend returned the default template instead of the
  // user's real content (file missing or below the "unedited" threshold).
  seeded: boolean;
};

type WritingStyle = {
  tone: string;
  primary_language: string;
  code_switching: string;
  characteristic_phrases: string[];
  typo_patterns: string[];
  formatting_habits: string;
  average_message_length_chars: number;
  punctuation_quirks: string;
};

type PersonalKnown = {
  style_fingerprint: string;
  writing_style: WritingStyle;
  recent_topics: string[];
  routines: string[];
  last_updated: string | null;
  source: string;
};

function isWritingStyleEmpty(w: WritingStyle | undefined | null): boolean {
  if (!w) return true;
  return (
    !w.tone.trim() &&
    !w.primary_language.trim() &&
    !w.code_switching.trim() &&
    w.characteristic_phrases.length === 0 &&
    w.typo_patterns.length === 0 &&
    !w.formatting_habits.trim() &&
    w.average_message_length_chars === 0 &&
    !w.punctuation_quirks.trim()
  );
}

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

function isKnownEmpty(k: PersonalKnown | null): boolean {
  if (!k) return true;
  return (
    !k.style_fingerprint.trim() &&
    k.recent_topics.length === 0 &&
    k.routines.length === 0 &&
    !k.last_updated
  );
}

export function Personal() {
  const [profile, setProfile] = useState<PersonalProfile | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [known, setKnown] = useState<PersonalKnown | null>(null);
  const [knownLoading, setKnownLoading] = useState(true);
  const [knownError, setKnownError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisMsg, setAnalysisMsg] = useState<string | null>(null);

  async function loadProfile() {
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

  async function loadKnown() {
    setKnownLoading(true);
    try {
      const r = (await invoke("read_personal_known")) as PersonalKnown;
      setKnown(r);
      setKnownError(null);
    } catch (e) {
      setKnownError(String(e));
    } finally {
      setKnownLoading(false);
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

  async function generateAnalysis() {
    const confirmed = window.confirm(
      "Esto abrirá una sesión externa de Claude Code (terminal aparte) con permisos completos para leer ~/.claude/projects, MEMORY.md y git history. La sesión escribirá un análisis en ~/.ultron/personal/known.json.\n\n¿Continuar?"
    );
    if (!confirmed) return;
    setAnalyzing(true);
    setAnalysisMsg(null);
    setKnownError(null);
    try {
      const msg = (await invoke("request_personal_analysis")) as string;
      setAnalysisMsg(
        `${msg} — vuelve cuando termine el análisis y pulsa Refresh.`
      );
    } catch (e) {
      setKnownError(String(e));
    } finally {
      setAnalyzing(false);
    }
  }

  useEffect(() => {
    loadProfile();
    loadKnown();
  }, []);

  const dirty = profile != null && draft !== profile.content;
  const empty = isKnownEmpty(known);

  return (
    <div className="flex h-full flex-col overflow-hidden px-8 py-6">
      <header className="mb-3 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">Personal</h1>
          <p className="mt-1 text-[12.5px]" style={{ color: "var(--color-text-secondary)" }}>
            A la izquierda, lo que ULTRON ha aprendido de ti analizando
            transcripts, commits y memoria. A la derecha, texto libre que tú
            mantienes y que los skills cargan desde
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
            onClick={() => {
              loadProfile();
              loadKnown();
            }}
            disabled={loading || saving || knownLoading}
            className="rounded px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-50"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            Refresh
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

      <div className="flex flex-1 gap-4 overflow-hidden">
        {/* Left: what ULTRON knows */}
        <section
          className="flex w-1/2 flex-col gap-3 overflow-hidden rounded p-4"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[14px] font-semibold leading-tight">
              Lo que ULTRON sabe de ti
            </h2>
            <span
              className="text-[10.5px]"
              style={{ color: "var(--color-text-faint)" }}
            >
              {known?.last_updated
                ? `actualizado ${formatRel(known.last_updated)}`
                : "sin análisis"}
            </span>
          </div>

          {knownError && (
            <div
              className="rounded p-2 text-[11.5px]"
              style={{
                background: "rgba(248, 81, 73, 0.06)",
                border: "1px solid rgba(248, 81, 73, 0.22)",
                color: "var(--color-danger)",
              }}
            >
              {knownError}
            </div>
          )}

          {analysisMsg && (
            <div
              className="rounded p-2 text-[11.5px]"
              style={{
                background: "rgba(56, 139, 253, 0.08)",
                border: "1px solid rgba(56, 139, 253, 0.22)",
                color: "var(--color-text-secondary)",
              }}
            >
              {analysisMsg}
            </div>
          )}

          <div className="flex-1 overflow-y-auto pr-1">
            {knownLoading ? (
              <p
                className="text-[12px]"
                style={{ color: "var(--color-text-faint)" }}
              >
                Cargando...
              </p>
            ) : empty ? (
              <p
                className="text-[12.5px] leading-relaxed"
                style={{ color: "var(--color-text-secondary)" }}
              >
                Aún no se ha generado un análisis. Pulsa el botón debajo para
                que Claude lo genere.
              </p>
            ) : (
              <div className="flex flex-col gap-4">
                {known!.style_fingerprint.trim() && (
                  <div>
                    <div
                      className="mb-1 text-[10.5px] uppercase tracking-wide"
                      style={{ color: "var(--color-text-faint)" }}
                    >
                      Estilo de escritura
                    </div>
                    <p
                      className="text-[12.5px] leading-relaxed"
                      style={{ color: "var(--color-text)" }}
                    >
                      {known!.style_fingerprint}
                    </p>
                  </div>
                )}

                {!isWritingStyleEmpty(known!.writing_style) && (
                  <div>
                    <div
                      className="mb-1.5 text-[10.5px] uppercase tracking-wide"
                      style={{ color: "var(--color-text-faint)" }}
                    >
                      Cómo escribes
                    </div>
                    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[12px] leading-relaxed">
                      {known!.writing_style.tone.trim() && (
                        <>
                          <dt style={{ color: "var(--color-text-faint)" }}>Tono</dt>
                          <dd style={{ color: "var(--color-text)" }}>
                            {known!.writing_style.tone}
                          </dd>
                        </>
                      )}
                      {known!.writing_style.primary_language.trim() && (
                        <>
                          <dt style={{ color: "var(--color-text-faint)" }}>
                            Idioma principal
                          </dt>
                          <dd style={{ color: "var(--color-text)" }}>
                            {known!.writing_style.primary_language}
                          </dd>
                        </>
                      )}
                      {known!.writing_style.code_switching.trim() && (
                        <>
                          <dt style={{ color: "var(--color-text-faint)" }}>
                            Code-switching
                          </dt>
                          <dd style={{ color: "var(--color-text)" }}>
                            {known!.writing_style.code_switching}
                          </dd>
                        </>
                      )}
                      {known!.writing_style.characteristic_phrases.length > 0 && (
                        <>
                          <dt style={{ color: "var(--color-text-faint)" }}>
                            Frases típicas
                          </dt>
                          <dd>
                            <div className="flex flex-wrap gap-1">
                              {known!.writing_style.characteristic_phrases.map(
                                (p, i) => (
                                  <span
                                    key={`${p}-${i}`}
                                    className="rounded px-1.5 py-0.5 text-[11px]"
                                    style={{
                                      background: "var(--color-surface-2)",
                                      color: "var(--color-text)",
                                      border: "1px solid var(--color-border)",
                                      fontFamily: "var(--font-mono)",
                                    }}
                                  >
                                    {p}
                                  </span>
                                ),
                              )}
                            </div>
                          </dd>
                        </>
                      )}
                      {known!.writing_style.typo_patterns.length > 0 && (
                        <>
                          <dt style={{ color: "var(--color-text-faint)" }}>
                            Typos típicos
                          </dt>
                          <dd>
                            <div className="flex flex-wrap gap-1">
                              {known!.writing_style.typo_patterns.map((p, i) => (
                                <span
                                  key={`${p}-${i}`}
                                  className="rounded px-1.5 py-0.5 text-[11px]"
                                  style={{
                                    background: "var(--color-surface-2)",
                                    color: "var(--color-text-secondary)",
                                    border: "1px solid var(--color-border)",
                                    fontFamily: "var(--font-mono)",
                                  }}
                                >
                                  {p}
                                </span>
                              ))}
                            </div>
                          </dd>
                        </>
                      )}
                      {known!.writing_style.formatting_habits.trim() && (
                        <>
                          <dt style={{ color: "var(--color-text-faint)" }}>
                            Formato
                          </dt>
                          <dd style={{ color: "var(--color-text)" }}>
                            {known!.writing_style.formatting_habits}
                          </dd>
                        </>
                      )}
                      {known!.writing_style.average_message_length_chars > 0 && (
                        <>
                          <dt style={{ color: "var(--color-text-faint)" }}>
                            Longitud media
                          </dt>
                          <dd style={{ color: "var(--color-text)" }}>
                            {known!.writing_style.average_message_length_chars.toLocaleString()}{" "}
                            chars
                          </dd>
                        </>
                      )}
                      {known!.writing_style.punctuation_quirks.trim() && (
                        <>
                          <dt style={{ color: "var(--color-text-faint)" }}>
                            Puntuación
                          </dt>
                          <dd style={{ color: "var(--color-text)" }}>
                            {known!.writing_style.punctuation_quirks}
                          </dd>
                        </>
                      )}
                    </dl>
                  </div>
                )}

                {known!.recent_topics.length > 0 && (
                  <div>
                    <div
                      className="mb-1.5 text-[10.5px] uppercase tracking-wide"
                      style={{ color: "var(--color-text-faint)" }}
                    >
                      Temas recientes
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {known!.recent_topics.map((t, i) => (
                        <span
                          key={`${t}-${i}`}
                          className="rounded-full px-2 py-0.5 text-[11px]"
                          style={{
                            background: "var(--color-surface-2)",
                            color: "var(--color-text-secondary)",
                            border: "1px solid var(--color-border)",
                          }}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {known!.routines.length > 0 && (
                  <div>
                    <div
                      className="mb-1 text-[10.5px] uppercase tracking-wide"
                      style={{ color: "var(--color-text-faint)" }}
                    >
                      Rutinas
                    </div>
                    <ul className="flex flex-col gap-1">
                      {known!.routines.map((r, i) => (
                        <li
                          key={`${i}-${r.slice(0, 20)}`}
                          className="text-[12.5px] leading-relaxed"
                          style={{ color: "var(--color-text)" }}
                        >
                          <span style={{ color: "var(--color-text-faint)" }}>
                            ·{" "}
                          </span>
                          {r}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {known!.source.trim() && (
                  <div
                    className="text-[10.5px]"
                    style={{ color: "var(--color-text-faint)" }}
                  >
                    Fuente: {known!.source}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 border-t pt-2"
            style={{ borderColor: "var(--color-border)" }}>
            <span
              className="text-[10.5px]"
              style={{ color: "var(--color-text-faint)", fontFamily: "var(--font-mono)" }}
            >
              ~/.ultron/personal/known.json
            </span>
            <button
              type="button"
              onClick={generateAnalysis}
              disabled={analyzing}
              className="rounded px-3 py-1.5 text-[11.5px] font-medium transition-colors disabled:opacity-50"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              {analyzing ? "Abriendo sesión..." : "Generate analysis with Claude"}
            </button>
          </div>
        </section>

        {/* Right: editable profile */}
        <section className="flex w-1/2 flex-col gap-2 overflow-hidden">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-[14px] font-semibold leading-tight">
              Profile (editable)
            </h2>
            <span
              className="text-[10.5px]"
              style={{ color: "var(--color-text-faint)" }}
            >
              Estilo, rutinas, preferencias, patrones de prompts
            </span>
          </div>

          {profile?.seeded && (
            <div
              className="rounded p-2 text-[11.5px] leading-relaxed"
              style={{
                background: "rgba(210, 153, 34, 0.08)",
                border: "1px solid rgba(210, 153, 34, 0.30)",
                color: "var(--color-warn)",
              }}
            >
              Esta es una plantilla. Edita y pulsa <strong>Save</strong> para
              guardar tu perfil real.
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
              resize: "none",
            }}
          />
          <div
            className="flex items-baseline justify-between text-[10.5px]"
            style={{ color: "var(--color-text-faint)" }}
          >
            <span>
              {draft.length.toLocaleString()} chars · {draft.split("\n").length} líneas
            </span>
            <span>
              Backups (últimos 30) en
              <span style={{ fontFamily: "var(--font-mono)" }}> ~/.ultron/personal/profile.backups/</span>
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}
