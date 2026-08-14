// Library → Tones — Personalities v1 (diseño del usuario, 2026-08-12/13).
//
// Editor de los tonos de ~/.ultron/personality.json (visibles/editables) +
// playground de detección estilo Routing: escribes un prompt y ves QUÉ tono
// detectaría el orchestrate del sidecar y POR QUÉ (señales matcheadas por
// tono). Backend: personalities_load / personalities_save / personalities_detect.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sparkle, Search, Loader } from "./icons";

type ToneDef = {
  id: string;
  name: string;
  lang: string;
  description: string;
  style_guide: string;
  signals: string[];
  strong_signals: string[];
  explicit_triggers: string[];
  lexicon: string[];
  profanity: string;
};

type PersonalityFile = {
  version: number;
  default_tone: string;
  tones: ToneDef[];
};

type ToneChoice = {
  id: string;
  name: string;
  lang: string;
  style_guide: string;
  profanity: string;
  matched_signals: string[];
  reason: string;
  explicit: boolean;
};

type ToneScore = {
  id: string;
  name: string;
  hits: string[];
  explicit_hit: string | null;
};

type ToneDetection = {
  chosen: ToneChoice | null;
  scores: ToneScore[];
  default_tone: string;
};

const PROFANITY_LEVELS = ["none", "mild", "full"];

type SpinnerVerbsConfig = {
  mode: string;
  verbs: string[];
};

type ToneStatusMap = Record<string, string | string[]>;

function listToText(list: string[]): string {
  return list.join(", ");
}

function textToList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

type ListFieldProps = {
  value: string[];
  onChange: (next: string[]) => void;
  rows?: number;
  placeholder?: string;
};

/**
 * Campo de lista separada por comas.
 *
 * Mientras se edita se muestra el texto CRUDO, no el array re-serializado: si
 * se serializara en cada tecla, `split(",").filter(Boolean)` borraría la coma
 * recién escrita (y su espacio) antes de poder teclear la palabra siguiente —
 * era imposible escribir comas en los campos de señales (bug 2026-08-14).
 * El array sí se actualiza en cada tecla, así que "Guardar" sigue viendo el
 * estado más reciente; el borrador se suelta al salir del campo.
 */
function ListField({ value, onChange, rows, placeholder }: ListFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const shared = {
    value: draft ?? listToText(value),
    onChange: (e: { target: { value: string } }) => {
      setDraft(e.target.value);
      onChange(textToList(e.target.value));
    },
    onBlur: () => setDraft(null),
    placeholder,
    className: "w-full rounded px-2 py-1 text-[11.5px]",
    style: {
      background: "var(--color-surface-1)",
      color: "var(--color-text)",
      border: "1px solid var(--color-border)",
    },
  };
  return rows ? <textarea rows={rows} {...shared} /> : <input type="text" {...shared} />;
}

export function Tones() {
  const [file, setFile] = useState<PersonalityFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Playground
  const [probe, setProbe] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [detection, setDetection] = useState<ToneDetection | null>(null);

  // Custom words (2026-08-13): spinner global + status por tono.
  const [spinner, setSpinner] = useState<SpinnerVerbsConfig | null>(null);
  const [toneStatus, setToneStatus] = useState<ToneStatusMap>({});
  const [savingWords, setSavingWords] = useState(false);

  async function load() {
    setError(null);
    try {
      const res = (await invoke("personalities_load")) as PersonalityFile;
      setFile(res);
    } catch (e) {
      setError(String(e));
    }
    try {
      setSpinner((await invoke("spinner_verbs_load")) as SpinnerVerbsConfig);
    } catch {
      // sin settings legible: sección de spinner oculta, el resto funciona
    }
    try {
      setToneStatus((await invoke("tone_status_load")) as ToneStatusMap);
    } catch {
      // sin tone-status.json: campos de status vacíos
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function statusWordsFor(id: string): string[] {
    const v = toneStatus[id];
    if (Array.isArray(v)) return v;
    return typeof v === "string" ? textToList(v) : [];
  }

  async function saveWords() {
    setSavingWords(true);
    setError(null);
    setInfo(null);
    try {
      if (spinner) await invoke("spinner_verbs_save", { cfg: spinner });
      await invoke("tone_status_save", { map: toneStatus });
      setInfo(
        "Palabras guardadas. Los status rotan ya; el spinner carga en la próxima sesión de Claude Code."
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingWords(false);
    }
  }

  async function saveAll(next: PersonalityFile) {
    setSaving(true);
    setError(null);
    setInfo(null);
    try {
      await invoke("personalities_save", { file: next });
      setFile(next);
      setInfo("Guardado en ~/.ultron/personality.json");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  function patchTone(id: string, patch: Partial<ToneDef>) {
    if (!file) return;
    setFile({
      ...file,
      tones: file.tones.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    });
  }

  async function runDetect() {
    const q = probe.trim();
    if (!q || detecting) return;
    setDetecting(true);
    setError(null);
    try {
      const res = (await invoke("personalities_detect", { prompt: q })) as ToneDetection;
      setDetection(res);
    } catch (e) {
      setError(String(e));
      setDetection(null);
    } finally {
      setDetecting(false);
    }
  }

  if (!file) {
    return (
      <div className="px-6 py-4 text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
        {error ? `Error: ${error}` : "Cargando tonos…"}
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto px-6 py-4">
      {/* Playground */}
      <div
        className="mb-4 rounded p-3"
        style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
      >
        <div className="text-[12.5px] font-medium">Playground de detección</div>
        <p className="mt-0.5 mb-2 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Escribe como escribirías en el chat y mira qué tono detectaría el
          orchestrate y por qué — misma detección determinista que corre en cada
          prompt (señales léxicas + petición explícita).
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void runDetect();
          }}
          className="flex items-center gap-2"
        >
          <div
            className="flex flex-1 items-center gap-2 rounded px-3 py-2"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            <Search size={14} className="shrink-0" />
            <input
              value={probe}
              onChange={(e) => setProbe(e.target.value)}
              placeholder="p.ej. «illo shurmano q pasa con el build»"
              className="w-full bg-transparent text-[12.5px] outline-none"
              style={{ color: "var(--color-text)" }}
            />
          </div>
          <button
            type="submit"
            disabled={detecting || !probe.trim()}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          >
            {detecting ? <Loader size={13} /> : "Detectar"}
          </button>
        </form>

        {detection && (
          <div className="mt-3 space-y-1.5">
            <div
              className="rounded p-2.5 text-[12px]"
              style={
                detection.chosen
                  ? {
                      background: "rgba(63, 185, 80, 0.06)",
                      border: "1px solid rgba(63, 185, 80, 0.22)",
                      color: "var(--color-success)",
                    }
                  : {
                      background: "var(--color-surface-1)",
                      border: "1px solid var(--color-border)",
                      color: "var(--color-text-secondary)",
                    }
              }
            >
              {detection.chosen ? (
                <>
                  <span className="font-semibold">{detection.chosen.name}</span>
                  {" — "}
                  {detection.chosen.reason}
                  {detection.chosen.explicit ? " (petición explícita)" : ""}
                </>
              ) : (
                <>
                  Ningún tono cruza el umbral — se queda el default (
                  {detection.default_tone}). Floor: 2 señales, o 1 fuerte.
                </>
              )}
            </div>
            {detection.scores
              .filter((s) => s.hits.length > 0 || s.explicit_hit)
              .map((s) => (
                <div
                  key={s.id}
                  className="flex items-baseline gap-2 rounded px-2.5 py-1.5 text-[11.5px]"
                  style={{
                    background: "var(--color-surface-1)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  <span className="font-medium">{s.name}</span>
                  <span style={{ color: "var(--color-text-tertiary)" }}>
                    {s.explicit_hit
                      ? `trigger explícito: "${s.explicit_hit}"`
                      : `señales: ${s.hits.join(", ")}`}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>

      {error && (
        <div
          className="mb-3 rounded p-3 text-[12.5px]"
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
          className="mb-3 rounded p-2 text-[12px]"
          style={{
            background: "rgba(63, 185, 80, 0.08)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {info}
        </div>
      )}

      {/* Custom words: spinner global de Claude Code (2026-08-13) */}
      {spinner && (
        <div
          className="mb-4 rounded p-3"
          style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[12.5px] font-medium">Spinner de Claude Code</div>
              <p className="mt-0.5 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                Verbos que salen mientras Claude trabaja ("Cookin…"). Sin espacios y de
                largo parecido para evitar glitches del redraw. Cargan al abrir sesión nueva.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={spinner.mode}
                onChange={(e) => setSpinner({ ...spinner, mode: e.target.value })}
                className="rounded px-2 py-1 text-[11.5px]"
                style={{
                  background: "var(--color-surface-1)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border)",
                }}
                title="replace = solo tus verbos · append = los tuyos además de los de serie"
              >
                <option value="replace">replace</option>
                <option value="append">append</option>
              </select>
              <button
                type="button"
                onClick={() => void saveWords()}
                disabled={savingWords}
                className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
                style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
              >
                {savingWords ? "Guardando…" : "Guardar palabras"}
              </button>
            </div>
          </div>
          <div className="mt-2">
            <ListField
              value={spinner.verbs}
              onChange={(verbs) => setSpinner({ ...spinner, verbs })}
              rows={2}
              placeholder="Maquinando, Cookin, Currelando, …"
            />
          </div>
        </div>
      )}

      {/* Header lista + default */}
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[12.5px] font-medium">
          Tonos ({file.tones.length}) · default:{" "}
          <select
            value={file.default_tone}
            onChange={(e) => setFile({ ...file, default_tone: e.target.value })}
            className="rounded px-1.5 py-0.5 text-[12px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          >
            {file.tones.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={() => void saveAll(file)}
          disabled={saving}
          className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
        >
          {saving ? "Guardando…" : "Guardar cambios"}
        </button>
      </div>

      {/* Cards de tonos */}
      <div className="space-y-1.5">
        {file.tones.map((t) => {
          const isOpen = expanded === t.id;
          return (
            <div
              key={t.id}
              className="rounded p-3"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
              }}
            >
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : t.id)}
                className="flex w-full items-baseline gap-2 text-left"
              >
                <Sparkle size={13} className="shrink-0 self-center" />
                <span className="text-[12.5px] font-medium">{t.name}</span>
                <span
                  className="text-[10px] uppercase tracking-wide"
                  style={{ color: "var(--color-text-faint)" }}
                >
                  {t.id} · {t.lang} · insultos: {t.profanity}
                  {t.id === file.default_tone ? " · DEFAULT" : ""}
                </span>
                <span
                  className="ml-auto truncate text-[11.5px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {t.description}
                </span>
              </button>

              {isOpen && (
                <div className="mt-3 space-y-2">
                  <label className="block text-[11.5px]">
                    <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
                      Guía de estilo (lo que se inyecta al modelo cuando el tono se activa)
                    </div>
                    <textarea
                      value={t.style_guide}
                      onChange={(e) => patchTone(t.id, { style_guide: e.target.value })}
                      rows={3}
                      className="w-full rounded px-2 py-1 text-[11.5px]"
                      style={{
                        background: "var(--color-surface-1)",
                        color: "var(--color-text)",
                        border: "1px solid var(--color-border)",
                      }}
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block text-[11.5px]">
                      <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
                        Señales de detección (separadas por coma)
                      </div>
                      <ListField
                        value={t.signals}
                        onChange={(signals) => patchTone(t.id, { signals })}
                        rows={2}
                      />
                    </label>
                    <label className="block text-[11.5px]">
                      <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
                        Señales FUERTES (1 basta para activar)
                      </div>
                      <ListField
                        value={t.strong_signals}
                        onChange={(strong_signals) => patchTone(t.id, { strong_signals })}
                        rows={2}
                      />
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block text-[11.5px]">
                      <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
                        Triggers explícitos ("modo cani", …)
                      </div>
                      <ListField
                        value={t.explicit_triggers}
                        onChange={(explicit_triggers) => patchTone(t.id, { explicit_triggers })}
                        rows={2}
                      />
                    </label>
                    <label className="block text-[11.5px]">
                      <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
                        Léxico de apoyo (para el escritor, no detecta)
                      </div>
                      <ListField
                        value={t.lexicon}
                        onChange={(lexicon) => patchTone(t.id, { lexicon })}
                        rows={2}
                      />
                    </label>
                  </div>
                  <label className="block text-[11.5px]">
                    <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
                      Status de la statusline (separados por coma — rotan cada 20s)
                    </div>
                    <ListField
                      value={statusWordsFor(t.id)}
                      onChange={(words) => setToneStatus({ ...toneStatus, [t.id]: words })}
                      placeholder="Cookin, Grindin, Slidin, …"
                    />
                  </label>
                  <label className="block text-[11.5px]">
                    <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
                      Nivel de insultos
                    </div>
                    <select
                      value={t.profanity}
                      onChange={(e) => patchTone(t.id, { profanity: e.target.value })}
                      className="rounded px-2 py-1 text-[11.5px]"
                      style={{
                        background: "var(--color-surface-1)",
                        color: "var(--color-text)",
                        border: "1px solid var(--color-border)",
                      }}
                    >
                      {PROFANITY_LEVELS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-3 text-[11px]" style={{ color: "var(--color-text-faint)" }}>
        Archivo: ~/.ultron/personality.json (local, fuera del repo público). La
        detección corre dentro del orchestrate del sidecar en cada prompt — sin
        hooks nuevos ni latencia extra.
      </p>
    </div>
  );
}
