// Settings/api-keys/key-catalog.ts — datos puros: catalogo de claves de
// provider, claves de investigacion (buscador de papers) y sus tutoriales.
// Sin estado, sin JSX, sin llamadas invoke.

import type { KeyTutorial, ProviderKeyDef, ResearchKeyDef } from "./types";

// ------------------------------------------------------------------
// Provider catalog (mirrors ai_router seed_providers)
// ------------------------------------------------------------------

export const PROVIDER_KEYS: ProviderKeyDef[] = [
  {
    envVar: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    docsUrl: "https://console.anthropic.com/settings/keys",
    placeholder: "sk-ant-…",
    tutorial: {
      steps: [
        "Entra en console.anthropic.com/settings/keys (crea cuenta o inicia sesión).",
        "Pulsa \"Create Key\", ponle un nombre y cópiala — solo se muestra una vez.",
        "Pégala aquí y pulsa \"Save all\".",
      ],
      usedFor:
        "Zonas code-edit y code-review del AI Router (ai_router/seed.rs) — la API de mensajes de Anthropic por HTTP, distinta del CLI de esta sesión.",
      ifMissing:
        "Esas dos zonas caen a su primer fallback (codex-cli / gemini). Nada se rompe.",
      sourceUrl: "https://console.anthropic.com/settings/keys",
      sourceLabel: "console.anthropic.com",
    },
  },
  {
    envVar: "OPENAI_API_KEY",
    label: "OpenAI",
    docsUrl: "https://platform.openai.com/api-keys",
    placeholder: "sk-…",
    tutorial: {
      steps: [
        "Entra en platform.openai.com/api-keys (cuenta con crédito o método de pago).",
        "Pulsa \"Create new secret key\" y cópiala — no se vuelve a mostrar.",
        "Pégala aquí.",
      ],
      usedFor:
        "Provider codex (API HTTP de OpenAI, ai_router/seed.rs) — hoy es solo el último fallback de la zona code-edit.",
      ifMissing:
        "Sin efecto funcional hoy: ese fallback queda inactivo y code-edit sigue con Claude / codex-cli / DeepSeek.",
      sourceUrl: "https://platform.openai.com/api-keys",
      sourceLabel: "platform.openai.com",
    },
  },
  {
    envVar: "GEMINI_API_KEY",
    label: "Google Gemini",
    docsUrl: "https://aistudio.google.com/app/apikey",
    placeholder: "AIza…",
    tutorial: {
      steps: [
        "Entra en aistudio.google.com/app/apikey con tu cuenta de Google.",
        "Pulsa \"Create API key\" (puedes vincularla a un proyecto de Google Cloud existente o dejar que cree uno).",
        "Copia la key generada y pégala aquí.",
      ],
      usedFor:
        "Primaria de la zona research-web (grounding) y relevo de chat, code-review, summarize, routing-decision, utility y light (cockpit/ai-router/zones.json).",
      ifMissing:
        "research-web cae a Groq sin grounding real; el resto de zonas pierde su red de seguridad si Groq falla.",
      sourceUrl: "https://aistudio.google.com/app/apikey",
      sourceLabel: "aistudio.google.com",
    },
  },
  {
    envVar: "GROQ_API_KEY",
    label: "Groq",
    docsUrl: "https://console.groq.com/keys",
    placeholder: "gsk_…",
    tutorial: {
      steps: [
        "Entra en console.groq.com/keys con tu cuenta.",
        "Pulsa \"Create API Key\", nómbrala y cópiala — solo se muestra una vez.",
        "Pégala aquí.",
      ],
      usedFor:
        "Motor primario de chat, summarize, routing-decision, utility y light — el titular del AI Router hoy (cockpit/ai-router/zones.json).",
      ifMissing: "Esas cinco zonas caen a Gemini (o a Ollama local en light).",
      sourceUrl: "https://console.groq.com/keys",
      sourceLabel: "console.groq.com",
    },
  },
  {
    envVar: "DEEPSEEK_API_KEY",
    label: "DeepSeek",
    docsUrl: "https://platform.deepseek.com/api_keys",
    placeholder: "sk-…",
    tutorial: {
      steps: [
        "Entra en platform.deepseek.com/api_keys.",
        "Pulsa \"Create new API key\" y cópiala.",
        "Pégala aquí.",
      ],
      usedFor: "Último fallback de la zona code-edit (cockpit/ai-router/zones.json).",
      ifMissing:
        "Sin efecto: esa zona ya tiene Claude como primario y codex-cli/codex como fallbacks anteriores.",
      sourceUrl: "https://platform.deepseek.com/api_keys",
      sourceLabel: "platform.deepseek.com",
    },
  },
  {
    envVar: "NVIDIA_NIM_API_KEY",
    label: "NVIDIA NIM (free-tier proxy)",
    docsUrl: "https://build.nvidia.com",
    placeholder: "nvapi-…",
    tutorial: {
      steps: [
        "Entra en build.nvidia.com con tu cuenta.",
        "Abre cualquier modelo NIM y pulsa \"Get API Key\".",
        "Pégala aquí.",
      ],
      usedFor:
        "Backend del proxy free-tier (AI Router → pestaña Proxy, ver comentario en env_keys.rs) — no interviene en las zonas de zones.json.",
      ifMissing: "El proxy free-tier no puede usar NVIDIA NIM como backend; sigue funcionando con los demás que tenga.",
      sourceUrl: "https://build.nvidia.com",
      sourceLabel: "build.nvidia.com",
    },
  },
  {
    envVar: "OPENROUTER_API_KEY",
    label: "OpenRouter (free-tier proxy)",
    docsUrl: "https://openrouter.ai/keys",
    placeholder: "sk-or-…",
    tutorial: {
      steps: [
        "Entra en openrouter.ai/keys con tu cuenta.",
        "Pulsa \"Create Key\" y cópiala.",
        "Pégala aquí.",
      ],
      usedFor: "Mismo uso que NVIDIA NIM: backend del proxy free-tier.",
      ifMissing: "El proxy pierde ese backend concreto; sigue con los demás.",
      sourceUrl: "https://openrouter.ai/keys",
      sourceLabel: "openrouter.ai",
    },
  },
];

// ------------------------------------------------------------------
// Research providers — paper search (TFG). Two secrets + two contact
// emails (never masked — see EnvKeyStatus.is_secret).
// ------------------------------------------------------------------

export const RESEARCH_KEYS: ResearchKeyDef[] = [
  {
    envVar: "SEMANTIC_SCHOLAR_API_KEY",
    label: "Semantic Scholar",
    docsUrl: "https://www.semanticscholar.org/product/api",
    placeholder: "clave recibida por email…",
    isEmail: false,
    tutorial: {
      steps: [
        "Rellena el formulario gratuito en semanticscholar.org/product/api.",
        "Espera el email con tu clave privada (no publican un plazo exacto).",
        "Pégala aquí.",
      ],
      usedFor:
        "hooks/scripts/lib/research/semantic-scholar.js — sube el ritmo de petición de 1 cada 3s (pool compartido) a 1 petición/s garantizado.",
      ifMissing:
        "El buscador sigue funcionando contra el pool compartido (sin clave: hasta 1000 req/s repartidas entre todos los usuarios, según la documentación oficial); en la prueba en vivo del 2026-09-14 ese pool devolvió HTTP 429 en ráfagas cortas.",
      sourceUrl: "https://www.semanticscholar.org/product/api",
      sourceLabel: "semanticscholar.org/product/api",
    },
  },
  {
    envVar: "OPENALEX_API_KEY",
    label: "OpenAlex",
    docsUrl: "https://openalex.org/settings/api",
    placeholder: "clave de tu cuenta OpenAlex…",
    isEmail: false,
    tutorial: {
      steps: [
        "Crea una cuenta gratuita en openalex.org (unos 30 segundos).",
        "Copia tu key en openalex.org/settings/api.",
        "Pégala aquí.",
      ],
      usedFor: "hooks/scripts/lib/research/openalex.js — sube el presupuesto diario de peticiones.",
      ifMissing:
        "OpenAlex anunció claves obligatorias desde el 13-feb-2026 (grupo oficial de usuarios, groups.google.com/g/openalex-users); la documentación pública sigue describiendo acceso sin clave con cuota reducida. Estado cambiante: confirma el requisito vigente en la fuente antes de asumir bloqueo total.",
      sourceUrl: "https://help.openalex.org/api/authentication/",
      sourceLabel: "help.openalex.org/api/authentication",
    },
  },
  {
    envVar: "OPENALEX_MAILTO",
    label: "OpenAlex — email de contacto",
    docsUrl: "https://help.openalex.org/api/authentication/",
    placeholder: "tu-email@dominio.com",
    isEmail: true,
    tutorial: {
      steps: ["No hay registro: escribe aquí un email de contacto real tuyo."],
      usedFor:
        "openalex.js y, de rebote, crossref.js — metía las peticiones en el \"polite pool\" de OpenAlex (prioridad y contacto si algo falla).",
      ifMissing:
        "OpenAlex ha ido sustituyendo el polite pool por la API key obligatoria; con OPENALEX_API_KEY puesta, este email pasa a ser secundario. Sin ninguna de las dos, las peticiones van al pool general.",
      sourceUrl: "https://help.openalex.org/api/authentication/",
      sourceLabel: "help.openalex.org/api/authentication",
    },
  },
  {
    envVar: "UNPAYWALL_EMAIL",
    label: "Unpaywall — email de contacto",
    docsUrl: "https://unpaywall.org/products/api",
    placeholder: "tu-email@dominio.com",
    isEmail: true,
    tutorial: {
      steps: [
        "No hay registro ni clave: escribe aquí un email de contacto real tuyo.",
      ],
      usedFor:
        "hooks/scripts/lib/research/unpaywall.js — mejor localización de acceso abierto por DOI; es opt-in.",
      ifMissing:
        "unpaywall.js lanza \"UNPAYWALL_EMAIL no configurado\" y access.js sigue funcionando solo con OpenAlex y Semantic Scholar.",
      sourceUrl: "https://unpaywall.org/products/api",
      sourceLabel: "unpaywall.org/products/api",
    },
  },
];

/** envVar names from RESEARCH_KEYS that hold a contact email, not a secret. */
export const EMAIL_ENV_VARS = new Set(
  RESEARCH_KEYS.filter((k) => k.isEmail).map((k) => k.envVar),
);

// ------------------------------------------------------------------
// GitHub token tutorial
// ------------------------------------------------------------------

export const GITHUB_TOKEN_TUTORIAL: KeyTutorial = {
  steps: [
    "Entra en github.com/settings/tokens.",
    "Genera un fine-grained token (o uno clásico) con los scopes que necesites — repo, workflow…",
    "Cópialo (empieza por ghp_ / github_pat_ / gho_ / ghs_ / ghu_) y pégalo aquí.",
  ],
  usedFor: "AI Router y los workflows que acceden a la API de GitHub.",
  ifMissing: "Esas llamadas a la API de GitHub fallan con 401/403; el resto de ULTRON sigue funcionando.",
  sourceUrl: "https://github.com/settings/tokens",
  sourceLabel: "github.com/settings/tokens",
};
