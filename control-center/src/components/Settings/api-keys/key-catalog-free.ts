// Settings/api-keys/key-catalog-free.ts — claves de proveedores gratuitos o
// con capa gratuita. Datos puros, sin JSX ni invoke.

import { optInTutorial } from "./key-catalog-shared";
import type { ProviderKeyDef } from "./types";

export const FREE_PROVIDER_KEYS: ProviderKeyDef[] = [
  {
    envVar: "GEMINI_API_KEY",
    label: "Google Gemini",
    docsUrl: "https://aistudio.google.com/app/apikey",
    placeholder: "AIza…",
    group: "free",
    tutorial: {
      steps: [
        "Entra en aistudio.google.com/app/apikey con tu cuenta de Google.",
        "Pulsa \"Create API key\" (puedes vincularla a un proyecto de Google Cloud existente o dejar que cree uno).",
        "Copia la key generada y pégala aquí.",
      ],
      usedFor:
        "Relevo de chat, summarize, utility y light (cockpit/ai-router/zones.json). El motor agy de la delegación usa el CLI de Antigravity, no esta key.",
      ifMissing:
        "Esas zonas se quedan sin respuesta si Groq falla (Ollama no es relevo: los modelos locales son solo para programar).",
      sourceUrl: "https://aistudio.google.com/app/apikey",
      sourceLabel: "aistudio.google.com",
    },
  },
  {
    envVar: "GROQ_API_KEY",
    label: "Groq",
    docsUrl: "https://console.groq.com/keys",
    placeholder: "gsk_…",
    group: "free",
    tutorial: {
      steps: [
        "Entra en console.groq.com/keys con tu cuenta.",
        "Pulsa \"Create API Key\", nómbrala y cópiala — solo se muestra una vez.",
        "Pégala aquí.",
      ],
      usedFor:
        "Motor primario de chat, summarize, utility y light — el titular del AI Router hoy (cockpit/ai-router/zones.json).",
      ifMissing: "Esas cuatro zonas caen a Gemini (20 peticiones diarias por modelo).",
      sourceUrl: "https://console.groq.com/keys",
      sourceLabel: "console.groq.com",
    },
  },
  {
    envVar: "CEREBRAS_API_KEY",
    label: "Cerebras",
    docsUrl: "https://cloud.cerebras.ai",
    placeholder: "csk-…",
    group: "free",
    tutorial: optInTutorial({
      steps: [
        "Entra en cloud.cerebras.ai con tu cuenta.",
        "Abre \"API Keys\" y genera una nueva.",
        "Cópiala y pégala aquí.",
      ],
      sourceUrl: "https://inference-docs.cerebras.ai/quickstart",
      sourceLabel: "inference-docs.cerebras.ai",
    }),
  },
  {
    envVar: "MISTRAL_API_KEY",
    label: "Mistral AI",
    docsUrl: "https://console.mistral.ai/api-keys",
    placeholder: "clave de Mistral…",
    group: "free",
    tutorial: optInTutorial({
      steps: [
        "Entra en console.mistral.ai y elige un plan (el plan Experiment es gratuito).",
        "Abre \"API Keys\" y pulsa \"Create new key\".",
        "Cópiala y pégala aquí.",
      ],
      sourceUrl: "https://docs.mistral.ai/getting-started/quickstart/",
      sourceLabel: "docs.mistral.ai",
    }),
  },
  {
    envVar: "NVIDIA_NIM_API_KEY",
    label: "NVIDIA NIM",
    docsUrl: "https://build.nvidia.com",
    placeholder: "nvapi-…",
    group: "free",
    tutorial: optInTutorial({
      steps: [
        "Entra en build.nvidia.com con tu cuenta.",
        "Abre cualquier modelo NIM y pulsa \"Get API Key\".",
        "Pégala aquí.",
      ],
      usedFor:
        "Backend del proxy free-tier (AI Router → Panel → Proxy). Además, disponible para el delegador como motor opencode con keyEnv igual a esta variable y para zonas que configures tú.",
      ifMissing:
        "El proxy free-tier pierde NVIDIA NIM como backend y sigue con los demás; la delegación por defecto no la usa.",
      sourceUrl: "https://build.nvidia.com",
      sourceLabel: "build.nvidia.com",
    }),
  },
  {
    envVar: "GITHUB_MODELS_TOKEN",
    label: "GitHub Models",
    docsUrl: "https://github.com/settings/personal-access-tokens/new",
    placeholder: "github_pat_…",
    group: "free",
    tutorial: optInTutorial({
      steps: [
        "Entra en github.com/settings/personal-access-tokens/new.",
        "Crea un fine-grained token con el permiso \"Models: read\" (nada más).",
        "Cópialo y pégalo aquí. Es distinto del token de GitHub de más abajo.",
      ],
      sourceUrl: "https://docs.github.com/en/github-models",
      sourceLabel: "docs.github.com/en/github-models",
    }),
  },
  {
    envVar: "SAMBANOVA_API_KEY",
    label: "SambaNova Cloud",
    docsUrl: "https://cloud.sambanova.ai/apis",
    placeholder: "clave de SambaNova…",
    group: "free",
    tutorial: optInTutorial({
      steps: [
        "Entra en cloud.sambanova.ai/apis con tu cuenta.",
        "Genera una API key nueva.",
        "Cópiala y pégala aquí.",
      ],
      sourceUrl: "https://docs.sambanova.ai/cloud/docs/get-started/overview",
      sourceLabel: "docs.sambanova.ai",
    }),
  },
  {
    envVar: "HF_TOKEN",
    label: "Hugging Face (Inference Providers)",
    docsUrl: "https://huggingface.co/settings/tokens",
    placeholder: "hf_…",
    group: "free",
    tutorial: optInTutorial({
      steps: [
        "Entra en huggingface.co/settings/tokens.",
        "Crea un token fine-grained con el permiso \"Make calls to Inference Providers\".",
        "Cópialo y pégalo aquí.",
      ],
      sourceUrl: "https://huggingface.co/docs/inference-providers/index",
      sourceLabel: "huggingface.co/docs/inference-providers",
    }),
  },
  {
    envVar: "COHERE_API_KEY",
    label: "Cohere",
    docsUrl: "https://dashboard.cohere.com/api-keys",
    placeholder: "clave de Cohere…",
    group: "free",
    tutorial: optInTutorial({
      steps: [
        "Entra en dashboard.cohere.com/api-keys.",
        "Copia la trial key que crea la cuenta (gratuita, con límites) o genera una de producción.",
        "Pégala aquí.",
      ],
      sourceUrl: "https://docs.cohere.com/docs/rate-limits",
      sourceLabel: "docs.cohere.com",
    }),
  },
  {
    envVar: "OPENROUTER_API_KEY",
    label: "OpenRouter",
    docsUrl: "https://openrouter.ai/keys",
    placeholder: "sk-or-…",
    group: "free",
    tutorial: optInTutorial({
      steps: [
        "Entra en openrouter.ai/keys con tu cuenta.",
        "Pulsa \"Create Key\" y cópiala.",
        "Pégala aquí.",
      ],
      usedFor:
        "Backend del proxy free-tier y motor openrouter-free de la cadena de delegación (OpenCode con modelos :free; desactivado por defecto).",
      ifMissing:
        "El proxy pierde ese backend y sigue con los demás; si activas openrouter-free, el delegador lo salta con motivo missing-key.",
      sourceUrl: "https://openrouter.ai/docs/quickstart",
      sourceLabel: "openrouter.ai/docs",
    }),
  },
];
