// Settings/api-keys/key-catalog.ts — datos puros: claves de investigacion
// (buscador de papers) y sus tutoriales. Las claves de proveedores de IA se
// retiraron con el AI Router (2026-09-21): nada las consumia. mar.ia habla con
// los modelos por sus CLI de suscripcion y por Ollama, sin claves de API.
// Sin estado, sin JSX, sin llamadas invoke.

import type { KeyTutorial, ResearchKeyDef } from "./types";

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
  ifMissing: "Esas llamadas a la API de GitHub fallan con 401/403; el resto de mar.ia sigue funcionando.",
  sourceUrl: "https://github.com/settings/tokens",
  sourceLabel: "github.com/settings/tokens",
};
