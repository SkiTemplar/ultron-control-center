// Style training panel + sample preview.
//
// Top half: a textarea where the user pastes a fresh writing sample. On
// submit, the backend opens a Codex session (paste-only) that merges the
// sample into known.json (refines style_fingerprint, writing_style, etc).
//
// Bottom half: the most recent generated sample (~300 words in the user's
// voice) rendered as markdown via lib/markdown — gives a quick "does this
// sound like me?" sanity check.

import { Markdown } from "../../lib/markdown";

import { formatRel } from "./types";
import type { PersonalSample } from "./types";

type Props = {
  trainText: string;
  setTrainText: (v: string) => void;
  training: boolean;
  trainMsg: string | null;
  onTrain: () => void;

  sample: PersonalSample | null;
  sampleLoading: boolean;
  generatingSample: boolean;
  sampleMsg: string | null;
  onRegenerateSample: () => void;
};

export function StyleSection({
  trainText,
  setTrainText,
  training,
  trainMsg,
  onTrain,
  sample,
  sampleLoading,
  generatingSample,
  sampleMsg,
  onRegenerateSample,
}: Props) {
  return (
    // v15.4.7 — Train + Sample son ahora side-by-side (eran column-stack).
    // Combinado con el 2x2 de Personal.tsx, el resultado son 4 cuadrantes
    // reales (Known | Profile arriba, Training | Sample abajo).
    <div className="flex min-h-0 flex-1 flex-row gap-3 overflow-hidden">
      <TrainBlock
        trainText={trainText}
        setTrainText={setTrainText}
        training={training}
        trainMsg={trainMsg}
        onTrain={onTrain}
      />
      <SampleBlock
        sample={sample}
        loading={sampleLoading}
        generating={generatingSample}
        msg={sampleMsg}
        onRegenerate={onRegenerateSample}
      />
    </div>
  );
}

function TrainBlock({
  trainText,
  setTrainText,
  training,
  trainMsg,
  onTrain,
}: {
  trainText: string;
  setTrainText: (v: string) => void;
  training: boolean;
  trainMsg: string | null;
  onTrain: () => void;
}) {
  return (
    <div
      className="flex flex-1 flex-col gap-2 overflow-hidden rounded p-4"
      style={{
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border-strong)",
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[14px] font-semibold leading-tight">
          Train style
        </h2>
        <span
          className="text-[10.5px]"
          style={{ color: "var(--color-text-faint)" }}
        >
          Paste some of your text, Codex updates known.json
        </span>
      </div>
      <textarea
        value={trainText}
        onChange={(e) => setTrainText(e.target.value)}
        placeholder="Paste one or more paragraphs of your real writing here — a long message, an email, a technical note. Codex cross-references it with known.json and refines the fingerprint."
        spellCheck={false}
        className="flex-1 rounded p-3 text-[12px] leading-relaxed"
        style={{
          fontFamily: "var(--font-mono)",
          background: "var(--color-surface-2)",
          color: "var(--color-text)",
          border: "1px solid var(--color-border)",
          outline: "none",
          resize: "none",
          minHeight: 110,
        }}
      />
      {trainMsg && (
        <div
          className="rounded p-2 text-[11px]"
          style={{
            background: "rgba(56, 139, 253, 0.08)",
            border: "1px solid rgba(56, 139, 253, 0.22)",
            color: "var(--color-text-secondary)",
          }}
        >
          {trainMsg}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-[10.5px]"
          style={{ color: "var(--color-text-faint)" }}
        >
          {trainText.length.toLocaleString()} chars
        </span>
        <button
          type="button"
          onClick={onTrain}
          disabled={training || !trainText.trim()}
          className="rounded px-3 py-1.5 text-[11.5px] font-medium transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {training ? "Opening session..." : "Train style with Codex"}
        </button>
      </div>
    </div>
  );
}

function SampleBlock({
  sample,
  loading,
  generating,
  msg,
  onRegenerate,
}: {
  sample: PersonalSample | null;
  loading: boolean;
  generating: boolean;
  msg: string | null;
  onRegenerate: () => void;
}) {
  const hasSample = sample?.exists && sample.content.trim().length > 0;
  return (
    <div
      className="flex flex-1 flex-col gap-2 overflow-hidden rounded p-4"
      style={{
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border-strong)",
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[14px] font-semibold leading-tight">
          Sample in your style
        </h2>
        <span
          className="text-[10.5px]"
          style={{ color: "var(--color-text-faint)" }}
        >
          {sample?.last_modified
            ? `generated ${formatRel(sample.last_modified)}`
            : "no sample yet"}
        </span>
      </div>
      <div
        className="flex-1 overflow-y-auto rounded p-3"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        {loading ? (
          <p
            className="text-[12px]"
            style={{ color: "var(--color-text-faint)" }}
          >
            Loading...
          </p>
        ) : !hasSample ? (
          <SampleEmptyState />
        ) : (
          <Markdown source={sample!.content} />
        )}
      </div>
      {msg && (
        <div
          className="rounded p-2 text-[11px]"
          style={{
            background: "rgba(56, 139, 253, 0.08)",
            border: "1px solid rgba(56, 139, 253, 0.22)",
            color: "var(--color-text-secondary)",
          }}
        >
          {msg}
        </div>
      )}
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={onRegenerate}
          disabled={generating}
          className="rounded px-3 py-1.5 text-[11.5px] font-medium transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          {generating
            ? "Opening session..."
            : hasSample
              ? "Regenerate sample"
              : "Generate sample"}
        </button>
      </div>
    </div>
  );
}

function SampleEmptyState() {
  return (
    <div className="flex flex-col items-start gap-2 py-2">
      <div
        className="text-[12.5px] font-medium"
        style={{ color: "var(--color-text)" }}
      >
        No sample yet.
      </div>
      <p
        className="text-[12px] leading-relaxed"
        style={{ color: "var(--color-text-secondary)" }}
      >
        Press <span style={{ color: "var(--color-text)" }}>Generate sample</span>{" "}
        to have Claude write ~300 words in your voice using the current
        fingerprint. It helps you check whether <code
          style={{
            fontFamily: "var(--font-mono)",
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            padding: "1px 4px",
            borderRadius: 3,
          }}
        >known.json</code>{" "}
        really sounds like you.
      </p>
    </div>
  );
}
