// Settings/api-keys/CustomProviderForm.tsx — formulario «Añadir proveedor
// personalizado»: nombre, id, base_url, formato, modelo opcional y key. La
// variable ULTRON_KEY_<SLUG> se deriva del id y se enseña en vivo.

import { useState, type ReactNode } from "react";
import { EyeIcon } from "./EyeIcon";
import {
  CUSTOM_API_FORMATS,
  slugToKeyEnv,
  suggestSlug,
  type CustomProviderDraft,
  type CustomProviderErrors,
} from "./validation";
import type { SubmitOutcome } from "./useCustomProviders";

interface CustomProviderFormProps {
  busy: boolean;
  onSubmit: (draft: CustomProviderDraft, defaultModel: string) => Promise<SubmitOutcome>;
}

const EMPTY: CustomProviderDraft = { name: "", id: "", baseUrl: "", apiFormat: "openai_compat", apiKey: "" };

const FORMAT_LABELS: Record<(typeof CUSTOM_API_FORMATS)[number], string> = {
  openai_compat: "OpenAI-compatible (/chat/completions)",
  anthropic: "Anthropic (/v1/messages)",
  gemini: "Gemini (generateContent)",
};

const INPUT_CLASS = "w-full rounded px-2.5 py-1.5 text-[12px] outline-none";
const INPUT_STYLE = {
  background: "var(--color-surface-1)",
  border: "1px solid var(--color-border-strong)",
  color: "var(--color-text)",
  fontFamily: "var(--font-mono)",
} as const;

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[11.5px] font-medium" style={{ color: "var(--color-text-secondary)" }}>
      {label}
      {children}
      {error && (
        <span className="text-[11px] font-normal" style={{ color: "var(--color-danger)" }}>
          {error}
        </span>
      )}
    </label>
  );
}

export function CustomProviderForm({ busy, onSubmit }: CustomProviderFormProps) {
  const [draft, setDraft] = useState<CustomProviderDraft>(EMPTY);
  const [defaultModel, setDefaultModel] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [errors, setErrors] = useState<CustomProviderErrors>({});

  const update = (patch: Partial<CustomProviderDraft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setErrors({});
  };

  const handleSubmit = async () => {
    const result = await onSubmit(draft, defaultModel);
    setErrors(result.errors);
    if (result.ok) {
      setDraft(EMPTY);
      setDefaultModel("");
      setIdTouched(false);
    }
  };

  const envVar = draft.id.trim() ? slugToKeyEnv(draft.id) : "ULTRON_KEY_<ID>";

  return (
    <div className="mt-4 rounded p-3" style={{ border: "1px dashed var(--color-border-strong)" }}>
      <p className="mb-3 text-[12.5px] font-semibold" style={{ color: "var(--color-text)" }}>
        Añadir proveedor personalizado
      </p>
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <Field label="Nombre" error={errors.name}>
          <input
            className={INPUT_CLASS}
            style={INPUT_STYLE}
            value={draft.name}
            placeholder="Mi proxy"
            onChange={(e) =>
              update(idTouched ? { name: e.target.value } : { name: e.target.value, id: suggestSlug(e.target.value) })
            }
          />
        </Field>
        <Field label="Id (slug)" error={errors.id}>
          <input
            className={INPUT_CLASS}
            style={INPUT_STYLE}
            value={draft.id}
            placeholder="mi-proxy"
            spellCheck={false}
            onChange={(e) => {
              setIdTouched(true);
              update({ id: e.target.value });
            }}
          />
        </Field>
        <Field label="base_url" error={errors.baseUrl}>
          <input
            className={INPUT_CLASS}
            style={INPUT_STYLE}
            value={draft.baseUrl}
            placeholder="https://api.ejemplo.com/v1"
            spellCheck={false}
            onChange={(e) => update({ baseUrl: e.target.value })}
          />
        </Field>
        <Field label="Formato" error={errors.apiFormat}>
          <select
            className={INPUT_CLASS}
            style={INPUT_STYLE}
            value={draft.apiFormat}
            onChange={(e) => update({ apiFormat: e.target.value })}
          >
            {CUSTOM_API_FORMATS.map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABELS[f]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Modelo por defecto (opcional)">
          <input
            className={INPUT_CLASS}
            style={INPUT_STYLE}
            value={defaultModel}
            placeholder="vacío: lo rellena «Probar»"
            spellCheck={false}
            onChange={(e) => setDefaultModel(e.target.value)}
          />
        </Field>
        <Field label={`Key (se guarda en ${envVar})`} error={errors.apiKey}>
          <div className="flex items-center gap-1.5">
            <input
              className={INPUT_CLASS}
              style={INPUT_STYLE}
              type={showKey ? "text" : "password"}
              autoComplete="off"
              value={draft.apiKey}
              placeholder="opcional si ya existe la variable; en localhost, sin key = sin auth"
              onChange={(e) => update({ apiKey: e.target.value })}
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              title={showKey ? "Ocultar" : "Mostrar"}
              className="shrink-0 rounded p-1.5"
              style={{ border: "1px solid var(--color-border-strong)", color: "var(--color-text-secondary)" }}
            >
              <EyeIcon crossed={showKey} />
            </button>
          </div>
        </Field>
      </div>
      <button
        type="button"
        onClick={() => void handleSubmit()}
        disabled={busy}
        className="mt-3 rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
        style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
      >
        {busy ? "Guardando…" : "Añadir o actualizar"}
      </button>
    </div>
  );
}
