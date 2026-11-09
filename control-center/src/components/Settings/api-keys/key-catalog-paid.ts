// Settings/api-keys/key-catalog-paid.ts — claves de proveedores de pago
// (crédito o método de pago por delante). Datos puros, sin JSX ni invoke.

import { optInTutorial } from "./key-catalog-shared";
import type { ProviderKeyDef } from "./types";

export const PAID_PROVIDER_KEYS: ProviderKeyDef[] = [
  {
    envVar: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    docsUrl: "https://console.anthropic.com/settings/keys",
    placeholder: "sk-ant-…",
    group: "paid",
    tutorial: {
      steps: [
        "Entra en console.anthropic.com/settings/keys (crea cuenta o inicia sesión).",
        "Pulsa \"Create Key\", ponle un nombre y cópiala — solo se muestra una vez.",
        "Pégala aquí y pulsa \"Guardar todas\".",
      ],
      usedFor:
        "Provider claude del AI Router (API de mensajes de Anthropic por HTTP, distinta del CLI de esta sesión). Ninguna zona del seed lo usa desde que se podaron code-edit y code-review (2026-10-23); solo cuenta en zonas que configures tú.",
      ifMissing: "Sin efecto con las zonas del seed. Nada se rompe.",
      sourceUrl: "https://console.anthropic.com/settings/keys",
      sourceLabel: "console.anthropic.com",
    },
  },
  {
    envVar: "OPENAI_API_KEY",
    label: "OpenAI",
    docsUrl: "https://platform.openai.com/api-keys",
    placeholder: "sk-…",
    group: "paid",
    tutorial: {
      steps: [
        "Entra en platform.openai.com/api-keys (cuenta con crédito o método de pago).",
        "Pulsa \"Create new secret key\" y cópiala — no se vuelve a mostrar.",
        "Pégala aquí.",
      ],
      usedFor:
        "Provider codex del AI Router (API HTTP de OpenAI). Ninguna zona del seed lo usa desde que se podó code-edit (2026-10-23); solo cuenta en zonas que configures tú. El motor codex de la delegación usa el CLI con tu suscripción, no esta key.",
      ifMissing: "Sin efecto con las zonas del seed ni con la delegación.",
      sourceUrl: "https://platform.openai.com/api-keys",
      sourceLabel: "platform.openai.com",
    },
  },
  {
    envVar: "DEEPSEEK_API_KEY",
    label: "DeepSeek",
    docsUrl: "https://platform.deepseek.com/api_keys",
    placeholder: "sk-…",
    group: "paid",
    tutorial: {
      steps: [
        "Entra en platform.deepseek.com/api_keys.",
        "Pulsa \"Create new API key\" y cópiala.",
        "Recarga saldo en platform.deepseek.com/top_up: con saldo 0 el motor no está disponible.",
        "Pégala aquí.",
      ],
      usedFor:
        "Motor deepseek de la cadena de delegación, ejecutado con OpenCode: deepseek/deepseek-flash en los niveles estándar y trivial, deepseek/deepseek-v4-pro en el nivel complejo. También el provider deepseek del AI Router, que ninguna zona del seed usa.",
      ifMissing:
        "El delegador salta el motor deepseek con motivo missing-key y pasa al siguiente de la cadena.",
      sourceUrl: "https://api-docs.deepseek.com/",
      sourceLabel: "api-docs.deepseek.com",
    },
  },
  {
    envVar: "XAI_API_KEY",
    label: "xAI (Grok)",
    docsUrl: "https://console.x.ai",
    placeholder: "xai-…",
    group: "paid",
    tutorial: optInTutorial({
      steps: [
        "Entra en console.x.ai con tu cuenta.",
        "Abre \"API Keys\" y pulsa \"Create API Key\".",
        "Cópiala y pégala aquí.",
      ],
      sourceUrl: "https://docs.x.ai/docs/overview",
      sourceLabel: "docs.x.ai",
    }),
  },
  {
    envVar: "MOONSHOT_API_KEY",
    label: "Moonshot AI (Kimi)",
    docsUrl: "https://platform.moonshot.ai/console/api-keys",
    placeholder: "sk-…",
    group: "paid",
    tutorial: optInTutorial({
      steps: [
        "Entra en platform.moonshot.ai/console/api-keys.",
        "Pulsa \"Create API Key\" y cópiala.",
        "Pégala aquí.",
      ],
      sourceUrl: "https://platform.moonshot.ai/docs",
      sourceLabel: "platform.moonshot.ai/docs",
    }),
  },
  {
    envVar: "DASHSCOPE_API_KEY",
    label: "Alibaba Model Studio (Qwen)",
    docsUrl: "https://www.alibabacloud.com/help/en/model-studio/get-api-key",
    placeholder: "sk-…",
    group: "paid",
    tutorial: optInTutorial({
      steps: [
        "Entra en la consola de Model Studio de Alibaba Cloud y activa el servicio.",
        "Abre \"API Key\" y crea una nueva.",
        "Cópiala y pégala aquí.",
      ],
      sourceUrl: "https://www.alibabacloud.com/help/en/model-studio/get-api-key",
      sourceLabel: "alibabacloud.com/help/en/model-studio",
    }),
  },
  {
    envVar: "ZAI_API_KEY",
    label: "Z.ai (GLM)",
    docsUrl: "https://z.ai/manage-apikey/apikey-list",
    placeholder: "clave de Z.ai…",
    group: "paid",
    tutorial: optInTutorial({
      steps: [
        "Entra en z.ai/manage-apikey/apikey-list con tu cuenta.",
        "Pulsa \"Create a new API key\" y cópiala.",
        "Pégala aquí.",
      ],
      sourceUrl: "https://docs.z.ai/",
      sourceLabel: "docs.z.ai",
    }),
  },
  {
    envVar: "TOGETHER_API_KEY",
    label: "Together AI",
    docsUrl: "https://api.together.ai/settings/api-keys",
    placeholder: "clave de Together…",
    group: "paid",
    tutorial: optInTutorial({
      steps: [
        "Entra en api.together.ai/settings/api-keys.",
        "Copia la key de tu cuenta (o crea una nueva).",
        "Pégala aquí.",
      ],
      sourceUrl: "https://docs.together.ai/docs/quickstart",
      sourceLabel: "docs.together.ai",
    }),
  },
  {
    envVar: "FIREWORKS_API_KEY",
    label: "Fireworks AI",
    docsUrl: "https://fireworks.ai/account/api-keys",
    placeholder: "fw_…",
    group: "paid",
    tutorial: optInTutorial({
      steps: [
        "Entra en fireworks.ai/account/api-keys.",
        "Pulsa \"Create API Key\" y cópiala.",
        "Pégala aquí.",
      ],
      sourceUrl: "https://docs.fireworks.ai/getting-started/quickstart",
      sourceLabel: "docs.fireworks.ai",
    }),
  },
];
