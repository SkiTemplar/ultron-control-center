import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { KnownSection } from "./personal/KnownSection";
import { ProfileSection } from "./personal/ProfileSection";
import { StyleSection } from "./personal/StyleSection";
import type {
  PersonalKnown,
  PersonalProfile,
  PersonalSample,
} from "./personal/types";

// Personal tab — slim orchestrator.
//
// Layout: two columns inside a fixed-height tab. Left column shows what
// ULTRON has learned about you (read-only mirror at known.json). Right
// column stacks the user-maintained profile.md (rendered as markdown +
// modal editor) on top of the style training + sample preview.
//
// All Tauri commands and React state live here so the three sub-components
// (KnownSection, ProfileSection, StyleSection) stay presentational and
// easy to test/refactor in isolation.

export function Personal() {
  // profile.md
  const [profile, setProfile] = useState<PersonalProfile | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // known.json
  const [known, setKnown] = useState<PersonalKnown | null>(null);
  const [knownLoading, setKnownLoading] = useState(true);
  const [knownError, setKnownError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisMsg, setAnalysisMsg] = useState<string | null>(null);

  // style training + sample
  const [trainText, setTrainText] = useState<string>("");
  const [training, setTraining] = useState(false);
  const [trainMsg, setTrainMsg] = useState<string | null>(null);
  const [sample, setSample] = useState<PersonalSample | null>(null);
  const [sampleLoading, setSampleLoading] = useState(true);
  const [generatingSample, setGeneratingSample] = useState(false);
  const [sampleMsg, setSampleMsg] = useState<string | null>(null);

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

  async function loadSample() {
    setSampleLoading(true);
    try {
      const r = (await invoke("read_personal_sample")) as PersonalSample;
      setSample(r);
    } catch {
      setSample(null);
    } finally {
      setSampleLoading(false);
    }
  }

  async function save() {
    if (!profile) return;
    setSaving(true);
    setError(null);
    try {
      const r = (await invoke("save_personal_profile", {
        content: draft,
      })) as PersonalProfile;
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
      "Esto abrirá una sesión externa de Claude Code (terminal aparte) con permisos completos para leer ~/.claude/projects, MEMORY.md y git history. La sesión escribirá un análisis en ~/.ultron/personal/known.json.\n\n¿Continuar?",
    );
    if (!confirmed) return;
    setAnalyzing(true);
    setAnalysisMsg(null);
    setKnownError(null);
    try {
      const msg = (await invoke("request_personal_analysis")) as string;
      setAnalysisMsg(
        `${msg} — vuelve cuando termine el análisis y pulsa Refresh.`,
      );
    } catch (e) {
      setKnownError(String(e));
    } finally {
      setAnalyzing(false);
    }
  }

  async function trainStyle() {
    if (!trainText.trim()) return;
    setTraining(true);
    setTrainMsg(null);
    try {
      const msg = (await invoke("train_personal_style", {
        sampleText: trainText,
      })) as string;
      setTrainMsg(
        `${msg} — al terminar, pulsa Refresh para recargar known.json`,
      );
    } catch (e) {
      setTrainMsg(`Error: ${e}`);
    } finally {
      setTraining(false);
    }
  }

  async function regenerateSample() {
    setGeneratingSample(true);
    setSampleMsg(null);
    try {
      const msg = (await invoke("generate_style_sample")) as string;
      setSampleMsg(`${msg} — pulsa Refresh al terminar para ver el sample.`);
    } catch (e) {
      setSampleMsg(`Error: ${e}`);
    } finally {
      setGeneratingSample(false);
    }
  }

  useEffect(() => {
    loadProfile();
    loadKnown();
    loadSample();
  }, []);

  const dirty = profile != null && draft !== profile.content;

  return (
    <div className="flex h-full flex-col overflow-hidden px-8 py-6">
      <header className="mb-3 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">Personal</h1>
          <p
            className="mt-1 text-[12.5px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            A la izquierda, lo que ULTRON ha aprendido de ti analizando
            transcripts, commits y memoria. A la derecha, tu perfil libre y la
            herramienta para entrenar tu estilo.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            loadProfile();
            loadKnown();
            loadSample();
          }}
          disabled={loading || saving || knownLoading || sampleLoading}
          className="rounded px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-50"
          style={{
            background: "transparent",
            color: "var(--color-text-tertiary)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          Refresh
        </button>
      </header>

      {/*
        v15.4.7 — Personal layout reorganizado a 2x2 según user request:
        antes era Known (izq, 1 cosa) + columna derecha apilada (2 cosas)
        que dejaba la izquierda vacía y la derecha aplastada. Ahora:
          fila superior: Known (TL) | Profile (TR)  -> 50 / 50
          fila inferior: Style spans both cols      -> ancho completo
        Style internamente ya tiene train (texto) + sample (preview), así
        que perceptualmente queda "2 y 2": 4 áreas equilibradas en grid.
      */}
      <div className="flex flex-1 flex-col gap-4 overflow-hidden">
        <div className="flex min-h-0 flex-1 gap-4 overflow-hidden">
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <KnownSection
              known={known}
              loading={knownLoading}
              error={knownError}
              analyzing={analyzing}
              analysisMsg={analysisMsg}
              onGenerate={generateAnalysis}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <ProfileSection
              profile={profile}
              draft={draft}
              setDraft={setDraft}
              loading={loading}
              saving={saving}
              dirty={dirty}
              error={error}
              info={info}
              onSave={save}
            />
          </div>
        </div>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <StyleSection
            trainText={trainText}
            setTrainText={setTrainText}
            training={training}
            trainMsg={trainMsg}
            onTrain={trainStyle}
            sample={sample}
            sampleLoading={sampleLoading}
            generatingSample={generatingSample}
            sampleMsg={sampleMsg}
            onRegenerateSample={regenerateSample}
          />
        </div>
      </div>
    </div>
  );
}
