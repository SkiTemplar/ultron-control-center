// Left column of the Personal tab — read-only mirror of what ULTRON has
// learned about the user from transcripts, commits and MEMORY.md.
//
// Reads from ~/.ultron/personal/known.json (composed by `request_personal_analysis`,
// a spawn-Claude command). When the file is missing or empty we show an
// empty-state with a CTA button; when it has content we render the
// structured PersonalKnown as styled cards (no JSON dump).

import { isKnownEmpty, isWritingStyleEmpty, formatRel } from "./types";
import type { PersonalKnown } from "./types";

type Props = {
  known: PersonalKnown | null;
  loading: boolean;
  error: string | null;
  analyzing: boolean;
  analysisMsg: string | null;
  onGenerate: () => void;
};

export function KnownSection({
  known,
  loading,
  error,
  analyzing,
  analysisMsg,
  onGenerate,
}: Props) {
  const empty = isKnownEmpty(known);

  return (
    <section
      className="flex w-2/5 min-w-[320px] max-w-[460px] flex-col gap-3 overflow-hidden rounded p-4"
      style={{
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border-strong)",
      }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[14px] font-semibold leading-tight">
          Lo que ULTRON sabe de ti
        </h2>
        <span className="text-[10.5px]" style={{ color: "var(--color-text-faint)" }}>
          {known?.last_updated
            ? `actualizado ${formatRel(known.last_updated)}`
            : "sin análisis"}
        </span>
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
        {loading ? (
          <p className="text-[12px]" style={{ color: "var(--color-text-faint)" }}>
            Cargando...
          </p>
        ) : empty ? (
          <KnownEmptyState />
        ) : (
          <KnownContent known={known!} />
        )}
      </div>

      <div
        className="flex items-center justify-between gap-2 border-t pt-2"
        style={{ borderColor: "var(--color-border)" }}
      >
        <span
          className="text-[10.5px]"
          style={{
            color: "var(--color-text-faint)",
            fontFamily: "var(--font-mono)",
          }}
        >
          ~/.ultron/personal/known.json
        </span>
        <button
          type="button"
          onClick={onGenerate}
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
  );
}

function KnownEmptyState() {
  return (
    <div className="flex h-full flex-col items-start justify-center gap-2 py-6">
      <div
        className="text-[12.5px] font-medium"
        style={{ color: "var(--color-text)" }}
      >
        Aún no hay análisis.
      </div>
      <p
        className="text-[12px] leading-relaxed"
        style={{ color: "var(--color-text-secondary)" }}
      >
        Pulsa <span style={{ color: "var(--color-text)" }}>Generate analysis</span>{" "}
        para abrir una sesión de Claude que leerá tus transcripts y memoria, y
        compondrá un fingerprint con tono, idioma, frases típicas y rutinas.
      </p>
      <ul
        className="ml-4 mt-1 list-disc space-y-1 text-[11.5px] leading-relaxed"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        <li>Estilo de escritura (tono, idioma, code-switching)</li>
        <li>Frases y typos típicos</li>
        <li>Temas recientes y rutinas detectadas</li>
      </ul>
    </div>
  );
}

function KnownContent({ known }: { known: PersonalKnown }) {
  const ws = known.writing_style;
  return (
    <div className="flex flex-col gap-4">
      {known.style_fingerprint.trim() && (
        <div>
          <SectionLabel>Estilo de escritura</SectionLabel>
          <p
            className="text-[12.5px] leading-relaxed"
            style={{ color: "var(--color-text)" }}
          >
            {known.style_fingerprint}
          </p>
        </div>
      )}

      {!isWritingStyleEmpty(ws) && (
        <div>
          <SectionLabel>Cómo escribes</SectionLabel>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[12px] leading-relaxed">
            {ws.tone.trim() && (
              <Row k="Tono" v={ws.tone} />
            )}
            {ws.primary_language.trim() && (
              <Row k="Idioma principal" v={ws.primary_language} />
            )}
            {ws.code_switching.trim() && (
              <Row k="Code-switching" v={ws.code_switching} />
            )}
            {ws.characteristic_phrases.length > 0 && (
              <ChipRow
                k="Frases típicas"
                items={ws.characteristic_phrases}
                tone="text"
              />
            )}
            {ws.typo_patterns.length > 0 && (
              <ChipRow
                k="Typos típicos"
                items={ws.typo_patterns}
                tone="secondary"
              />
            )}
            {ws.formatting_habits.trim() && (
              <Row k="Formato" v={ws.formatting_habits} />
            )}
            {ws.average_message_length_chars > 0 && (
              <Row
                k="Longitud media"
                v={`${ws.average_message_length_chars.toLocaleString()} chars`}
              />
            )}
            {ws.punctuation_quirks.trim() && (
              <Row k="Puntuación" v={ws.punctuation_quirks} />
            )}
          </dl>
        </div>
      )}

      {known.recent_topics.length > 0 && (
        <div>
          <SectionLabel>Temas recientes</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {known.recent_topics.map((t, i) => (
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

      {known.routines.length > 0 && (
        <div>
          <SectionLabel>Rutinas</SectionLabel>
          <ul className="flex flex-col gap-1">
            {known.routines.map((r, i) => (
              <li
                key={`${i}-${r.slice(0, 20)}`}
                className="text-[12.5px] leading-relaxed"
                style={{ color: "var(--color-text)" }}
              >
                <span style={{ color: "var(--color-text-faint)" }}>· </span>
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}

      {known.source.trim() && (
        <div
          className="text-[10.5px]"
          style={{ color: "var(--color-text-faint)" }}
        >
          Fuente: {known.source}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mb-1.5 text-[10.5px] uppercase tracking-wide"
      style={{ color: "var(--color-text-faint)" }}
    >
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt style={{ color: "var(--color-text-faint)" }}>{k}</dt>
      <dd style={{ color: "var(--color-text)" }}>{v}</dd>
    </>
  );
}

function ChipRow({
  k,
  items,
  tone,
}: {
  k: string;
  items: string[];
  tone: "text" | "secondary";
}) {
  return (
    <>
      <dt style={{ color: "var(--color-text-faint)" }}>{k}</dt>
      <dd>
        <div className="flex flex-wrap gap-1">
          {items.map((p, i) => (
            <span
              key={`${p}-${i}`}
              className="rounded px-1.5 py-0.5 text-[11px]"
              style={{
                background: "var(--color-surface-2)",
                color:
                  tone === "text"
                    ? "var(--color-text)"
                    : "var(--color-text-secondary)",
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
  );
}
