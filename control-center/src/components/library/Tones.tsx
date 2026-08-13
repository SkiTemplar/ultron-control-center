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

function listToText(list: string[]): string {
  return list.join(", ");
}

function textToList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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

  async function load() {
    setError(null);
    try {
      const res = (await invoke("personalities_load")) as PersonalityFile;
      setFile(res);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void load();
  }, []);

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
                      <textarea
                        value={listToText(t.signals)}
                        onChange={(e) => patchTone(t.id, { signals: textToList(e.target.value) })}
                        rows={2}
                        className="w-full rounded px-2 py-1 text-[11.5px]"
                        style={{
                          background: "var(--color-surface-1)",
                          color: "var(--color-text)",
                          border: "1px solid var(--color-border)",
                        }}
                      />
                    </label>
                    <label className="block text-[11.5px]">
                      <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
                        Señales FUERTES (1 basta para activar)
                      </div>
                      <textarea
                        value={listToText(t.strong_signals)}
                        onChange={(e) =>
                          patchTone(t.id, { strong_signals: textToList(e.target.value) })
                        }
                        rows={2}
                        className="w-full rounded px-2 py-1 text-[11.5px]"
                        style={{
                          background: "var(--color-surface-1)",
                          color: "var(--color-text)",
                          border: "1px solid var(--color-border)",
                        }}
                      />
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block text-[11.5px]">
                      <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
                        Triggers explícitos ("modo cani", …)
                      </div>
                      <textarea
                        value={listToText(t.explicit_triggers)}
                        onChange={(e) =>
                          patchTone(t.id, { explicit_triggers: textToList(e.target.value) })
                        }
                        rows={2}
                        className="w-full rounded px-2 py-1 text-[11.5px]"
                        style={{
                          background: "var(--color-surface-1)",
                          color: "var(--color-text)",
                          border: "1px solid var(--color-border)",
                        }}
                      />
                    </label>
                    <label className="block text-[11.5px]">
                      <div className="mb-1" style={{ color: "var(--color-text-tertiary)" }}>
                        Léxico de apoyo (para el escritor, no detecta)
                      </div>
                      <textarea
                        value={listToText(t.lexicon)}
                        onChange={(e) => patchTone(t.id, { lexicon: textToList(e.target.value) })}
                        rows={2}
                        className="w-full rounded px-2 py-1 text-[11.5px]"
                        style={{
                          background: "var(--color-surface-1)",
                          color: "var(--color-text)",
                          border: "1px solid var(--color-border)",
                        }}
                      />
                    </label>
                  </div>
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
