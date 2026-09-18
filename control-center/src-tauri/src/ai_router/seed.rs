// Seed data — written on first run if the files don't exist.

use super::types::{ApiKeyStatus, Provider, ProviderClass, ProviderKind, Zone, ZoneAssignment};

pub(crate) fn seed_providers() -> Vec<Provider> {
    vec![
        // Anthropic Claude via the Messages HTTP API (x-api-key auth). The
        // 'claude' id is the CODE-zone primary (decision 2026-06-24: "primary
        // con Claude SDK"); 'claude-haiku' stays defined for cheap/light use.
        // Both dispatch to call_anthropic in try_assignment_call.
        Provider {
            id: "claude".into(),
            name: "Anthropic Claude (Sonnet)".into(),
            cost_per_mtok: 9.0,
            supports: vec![
                ProviderClass::Light,
                ProviderClass::Medium,
                ProviderClass::Heavy,
            ],
            api_key_status: ApiKeyStatus::Missing,
            health_endpoint: Some("https://api.anthropic.com/v1/models".into()),
            kind: ProviderKind::Cloud,
            key_env_var: "ANTHROPIC_API_KEY".into(),
            base_url: "https://api.anthropic.com".into(),
            // (2026-08-11) Familia Claude 5: sonnet-5 default equilibrado;
            // opus-5 y fable-5 (tier Mythos, por encima de Opus) disponibles.
            default_model: "claude-sonnet-5".into(),
            models: vec![
                "claude-sonnet-5".into(),
                "claude-opus-5".into(),
                "claude-fable-5".into(),
            ],
            cli_command: None,
        },
                Provider {
            id: "codex".into(),
            name: "OpenAI Codex (gpt-5)".into(),
            cost_per_mtok: 10.0,
            supports: vec![
                ProviderClass::Light,
                ProviderClass::Medium,
                ProviderClass::Heavy,
            ],
            api_key_status: ApiKeyStatus::Missing,
            health_endpoint: Some("https://api.openai.com/v1/models".into()),
            kind: ProviderKind::Cloud,
            key_env_var: "OPENAI_API_KEY".into(),
            base_url: "https://api.openai.com".into(),
            // (2026-09-11, corregido tras revisión) este provider es Cloud vía
            // OPENAI_API_KEY — la API HTTP real de OpenAI, DISTINTA de la
            // suscripción ChatGPT que usa 'codex-cli'. terra/sol/astra son alias
            // internos de la app ChatGPT, NO ids validos en la API publica de
            // OpenAI, así que NO se tocan aquí (una versión anterior de este
            // cambio los aplicó también a este provider por error; revertido).
            // Sigue en gpt-5 porque no hay evidencia de un id real de API
            // vigente para reemplazarlo, y hoy está deshabilitado por falta de
            // key (compute_key_status -> Missing) — sin efecto funcional.
            default_model: "gpt-5".into(),
            models: vec!["gpt-5".into(), "gpt-4o".into(), "gpt-4o-mini".into()],
            cli_command: None,
        },
        Provider {
            id: "gemini".into(),
            name: "Google Gemini".into(),
            cost_per_mtok: 0.35,
            supports: vec![
                ProviderClass::Trivial,
                ProviderClass::Light,
                ProviderClass::Medium,
                ProviderClass::Heavy,
            ],
            api_key_status: ApiKeyStatus::Missing,
            health_endpoint: Some("https://generativelanguage.googleapis.com/v1beta/models".into()),
            kind: ProviderKind::Cloud,
            key_env_var: "GEMINI_API_KEY".into(),
            base_url: "https://generativelanguage.googleapis.com".into(),
            // (2026-09-16) gemini-3.8-flash medido en vivo: 200 OK pero
            // 55.497 ms de latencia — inutilizable para las zonas que lo usan
            // como fallback rapido. gemini-2.5-flash medido el mismo dia:
            // 200 OK en 624 ms. Vuelta a 2.5-flash en todas las zonas;
            // gemini-2.5-pro se deja porque sigue listado en v1beta/models.
            default_model: "gemini-2.5-flash".into(),
            models: vec!["gemini-2.5-flash".into(), "gemini-2.5-pro".into()],
            cli_command: None,
        },
                Provider {
            id: "ollama".into(),
            name: "Ollama (local)".into(),
            cost_per_mtok: 0.0,
            supports: vec![
                ProviderClass::Trivial,
                ProviderClass::Light,
                ProviderClass::Medium,
            ],
            api_key_status: ApiKeyStatus::Configured,
            // 127.0.0.1, no 'localhost': mismo host que usa el modulo ollama
            // (toggle.rs OLLAMA_BASE_URL). Con 'localhost' la resolucion puede
            // irse a ::1 mientras ollama serve escucha en IPv4.
            health_endpoint: Some("http://127.0.0.1:11434/api/tags".into()),
            kind: ProviderKind::Local,
            key_env_var: String::new(),
            base_url: "http://127.0.0.1:11434".into(),
            // qwen2.5-coder:32b pedia ~20 GB de VRAM (2026-09-17: no cabe en
            // una 4080 Laptop de 12 GB y no estaba ni descargado, asi que la
            // zona code-fast-local fallaba siempre). qwen3.5:9b: 6,6 GB
            // medidos, 51 tok/s, tool calling correcto.
            default_model: "qwen3.5:9b".into(),
            models: vec![
                "qwen3.5:9b".into(),
                "qwen3.5:4b".into(),
                "qwen2.5-coder:7b".into(),
            ],
            cli_command: None,
        },
                // ----------------------------------------------------------------
        // CLI providers — authenticate via OAuth subscription, no API key.
        // Install: `npm install -g @openai/codex` / `npm install -g @google/gemini-cli`
        // ----------------------------------------------------------------
        Provider {
            id: "codex-cli".into(),
            name: "OpenAI Codex CLI (gpt-5.6-terra via OAuth)".into(),
            cost_per_mtok: 0.0,
            supports: vec![
                ProviderClass::Light,
                ProviderClass::Medium,
                ProviderClass::Heavy,
            ],
            api_key_status: ApiKeyStatus::Configured,
            health_endpoint: None,
            kind: ProviderKind::Cli,
            key_env_var: String::new(),
            base_url: String::new(),
            // (2026-09-11) Decisión del usuario: 3 modelos de suscripcion ChatGPT
            // verificados vivos hoy vía `codex exec -m <modelo> "Responde solo: OK"`:
            // terra (tareas basicas, default de ~/.codex/config.toml), sol
            // (equivalente a Opus, trabajo serio), astra (equivalente a Fable, lo
            // mas complejo, cuota limitada). cli_invocation_args() ahora SI pasa
            // `-m/--model` (bug de cableado corregido en exec.rs 2026-09-11: antes
            // el modelo de la ZoneAssignment nunca llegaba al CLI — ni siquiera
            // hasta call_cli, que ignoraba su parametro de llamada y siempre leía
            // provider.default_model — así que cada llamada usaba mudamente lo que
            // dijera config.toml). Sol y Astra se piden por invocacion explicita
            // (ZoneAssignment.model, p.ej. code-review usa sol).
            default_model: "gpt-5.6-terra".into(),
            models: vec![
                "gpt-5.6-terra".into(),
                "gpt-5.6-sol".into(),
                "gpt-6-astra".into(),
            ],
            cli_command: Some("codex".into()),
        },
        Provider {
            id: "gemini-cli".into(),
            name: "Google Gemini CLI (gemini-2.5-flash via OAuth)".into(),
            cost_per_mtok: 0.0,
            supports: vec![
                ProviderClass::Trivial,
                ProviderClass::Light,
                ProviderClass::Medium,
                ProviderClass::Heavy,
            ],
            api_key_status: ApiKeyStatus::Configured,
            health_endpoint: None,
            kind: ProviderKind::Cli,
            key_env_var: String::new(),
            base_url: String::new(),
            default_model: "gemini-2.5-flash".into(),
            models: vec!["gemini-2.5-flash".into()],
            cli_command: Some("gemini".into()),
        },
    ]
}

pub(crate) fn seed_zones() -> Vec<Zone> {
    // Provider policy (revised 2026-06-19): CODE zones go CLI-first
    // (codex-cli — ChatGPT OAuth, free at point of use, verified live 2026-06-19);
    // FAST/general zones (chat, summarize, routing-decision, utility, light) go
    // groq-first. gemini-cli was RETIRED from every chain on 2026-06-19: Google
    // dropped free-tier OAuth for individuals (runtime: IneligibleTierError —
    // "migrate to the Antigravity suite"), so the CLI no longer authenticates.
    // The cloud 'gemini' provider (gemini-2.5-flash via GEMINI_API_KEY;
    // vuelta desde gemini-3.8-flash el 2026-09-16 — 3.8-flash medido en vivo
    // en 55.497 ms, 2.5-flash en 624 ms) replaces it as the general fallback
    // and as research-web's primary (web grounding groq lacks). gemini-cli
    // stays DEFINED in seed_providers in case the tier is restored.
    // 'code-fast-local' stays on Ollama (offline by design).
    vec![
        Zone {
            id: "chat".into(),
            label: "General chat".into(),
            category: "chat".into(),

            primary: ZoneAssignment {
                provider_id: "ollama".into(),
                model: "qwen3.5:9b".into(),
                max_tokens: 1024,
            },
            // 2026-09-07: la cuota de Groq es POR MODELO. Medido: 266 llamadas
            // a `chat` en un dia (captura + juez de candidatos), el 120b en
            // cooldown por 429 y Gemini con sus 20/dia agotadas -> la captura
            // se quedaba sin proveedor. Otro modelo de Groq en medio, con su
            // bucket, antes de gastar la cuota diaria de Gemini.
            // 2026-09-16: qwen/qwen3.6-27b retirado (404 model_not_found).
            fallbacks: vec![
                ZoneAssignment {
                    provider_id: "ollama".into(),
                model: "qwen3.5:9b".into(),
                    max_tokens: 1024,
                },
                ZoneAssignment {
                    provider_id: "gemini".into(),
                    model: "gemini-2.5-flash".into(),
                    max_tokens: 1024,
                },
            ],
            system_prompt: None,
        },
        Zone {
            id: "code-edit".into(),
            label: "Code edit (multi-file)".into(),
            category: "code".into(),

            // Decision 2026-06-24: code zones go Claude-first (Sonnet via the
            // Anthropic Messages API). codex-cli (ChatGPT OAuth, free at point
            // of use) stays as the first fallback, then the previous chain.
            primary: ZoneAssignment {
                provider_id: "claude".into(),
                model: "claude-sonnet-5".into(),
                max_tokens: 4096,
            },
            fallbacks: vec![
                ZoneAssignment {
                    // (2026-09-11) code-edit = tareas basicas de codigo -> terra.
                    provider_id: "codex-cli".into(),
                    model: "gpt-5.6-terra".into(),
                    max_tokens: 4096,
                },
                ZoneAssignment {
                    // El 'codex' cloud (OPENAI_API_KEY) conserva su id de API
                    // real (gpt-5); terra/sol/astra son alias de suscripción
                    // ChatGPT, exclusivos de 'codex-cli' (ver ese provider).
                    provider_id: "codex".into(),
                    model: "gpt-5".into(),
                    max_tokens: 4096,
                },
                ZoneAssignment {
                    provider_id: "codex-cli".into(),
                model: "gpt-5.6-terra".into(),
                    max_tokens: 4096,
                },
            ],
            system_prompt: None,
        },
        Zone {
            id: "code-review".into(),
            label: "Code review".into(),
            category: "code".into(),

            // Decision 2026-06-24: Claude-first (Sonnet), codex-cli as the first
            // fallback, then gemini cloud. gemini-cli retirado 2026-06-19
            // (IneligibleTierError). Ambos providers retirados siguen definidos
            // en seed_providers por si se restauran.
            primary: ZoneAssignment {
                provider_id: "claude".into(),
                model: "claude-sonnet-5".into(),
                max_tokens: 2048,
            },
            fallbacks: vec![
                ZoneAssignment {
                    // (2026-09-11) code-review = trabajo serio -> sol (~Opus).
                    provider_id: "codex-cli".into(),
                    model: "gpt-5.6-sol".into(),
                    max_tokens: 2048,
                },
                ZoneAssignment {
                    provider_id: "gemini".into(),
                    model: "gemini-2.5-flash".into(),
                    max_tokens: 2048,
                },
            ],
            system_prompt: None,
        },
        Zone {
            id: "research-web".into(),
            label: "Web research with grounding".into(),
            category: "research".into(),

            // primary era gemini-cli (web grounding); muerto 2026-06-19, ahora gemini
            // cloud (mismo modelo, grounding via GEMINI_API_KEY), fallback groq.
            primary: ZoneAssignment {
                provider_id: "gemini".into(),
                model: "gemini-2.5-flash".into(),
                max_tokens: 4096,
            },
            fallbacks: vec![ZoneAssignment {
                provider_id: "ollama".into(),
                model: "qwen3.5:9b".into(),
                max_tokens: 4096,
            }],
            system_prompt: None,
        },
        Zone {
            id: "summarize".into(),
            label: "Summarize document".into(),
            category: "chat".into(),

            // 2026-08-23: las zonas INTERNAS (summarize/routing-decision/utility/
            // light) usan gpt-oss-20b y 'chat'/'research-web' el 120b, tras la
            // retirada de la familia llama-3.x en Groq (ver el comentario del
            // provider). Se mantiene el modelo pequeño en las internas por el
            // mismo motivo de 2026-07-01: bucket de cuota separado del grande,
            // para que la automatización no agote la cuota de la zona cara al
            // usuario y dispare 429 -> fallback.
            primary: ZoneAssignment {
                provider_id: "ollama".into(),
                model: "qwen3.5:9b".into(),
                max_tokens: 1024,
            },
            // gemini-cli retirado 2026-06-19 (muerto); queda gemini cloud.
            fallbacks: vec![ZoneAssignment {
                provider_id: "gemini".into(),
                model: "gemini-2.5-flash".into(),
                max_tokens: 1024,
            }],
            system_prompt: None,
        },
        Zone {
            id: "routing-decision".into(),
            label: "Router judge (decide which zone to use)".into(),
            category: "system".into(),

            primary: ZoneAssignment {
                provider_id: "ollama".into(),
                model: "qwen3.5:9b".into(),
                max_tokens: 256,
            },
            fallbacks: vec![ZoneAssignment {
                provider_id: "gemini".into(),
                model: "gemini-2.5-flash".into(),
                max_tokens: 256,
            }],
            system_prompt: Some(
                "You classify user prompts into one of the configured zones. \
                 Reply with the zone id only."
                    .into(),
            ),
        },
        Zone {
            id: "code-fast-local".into(),
            label: "Fast offline code completion".into(),
            category: "code".into(),

            primary: ZoneAssignment {
                provider_id: "ollama".into(),
                model: "qwen3.5:9b".into(),
                max_tokens: 2048,
            },
            fallbacks: vec![],
            system_prompt: None,
        },
        Zone {
            id: "utility".into(),
            label: "Utility (internal automation tasks)".into(),
            category: "system".into(),

            primary: ZoneAssignment {
                provider_id: "ollama".into(),
                model: "qwen3.5:9b".into(),
                max_tokens: 512,
            },
            fallbacks: vec![ZoneAssignment {
                provider_id: "gemini".into(),
                model: "gemini-2.5-flash".into(),
                max_tokens: 512,
            }],
            system_prompt: None,
        },
        Zone {
            id: "light".into(),
            label: "Light (fast single-turn completions)".into(),
            category: "chat".into(),

            primary: ZoneAssignment {
                provider_id: "ollama".into(),
                model: "qwen3.5:9b".into(),
                max_tokens: 1024,
            },
            // gemini-cli retirado 2026-06-19 (muerto); gemini cloud + ollama local.
            fallbacks: vec![
                ZoneAssignment {
                    provider_id: "gemini".into(),
                    model: "gemini-2.5-flash".into(),
                    max_tokens: 1024,
                },
                ZoneAssignment {
                    provider_id: "ollama".into(),
                    model: "qwen3.5:9b".into(),
                    max_tokens: 1024,
                },
            ],
            system_prompt: None,
        },
    ]
}
