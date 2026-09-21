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
            id: "claude-haiku".into(),
            name: "Anthropic Claude Haiku".into(),
            cost_per_mtok: 1.25,
            supports: vec![
                ProviderClass::Trivial,
                ProviderClass::Light,
                ProviderClass::Medium,
            ],
            api_key_status: ApiKeyStatus::Missing,
            health_endpoint: Some("https://api.anthropic.com/v1/models".into()),
            kind: ProviderKind::Cloud,
            key_env_var: "ANTHROPIC_API_KEY".into(),
            base_url: "https://api.anthropic.com".into(),
            default_model: "claude-haiku-4-5-20251001".into(),
            models: vec!["claude-haiku-4-5-20251001".into()],
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
            id: "groq".into(),
            name: "Groq".into(),
            cost_per_mtok: 0.59,
            supports: vec![ProviderClass::Trivial, ProviderClass::Light],
            api_key_status: ApiKeyStatus::Missing,
            health_endpoint: Some("https://api.groq.com/openai/v1/models".into()),
            kind: ProviderKind::Cloud,
            key_env_var: "GROQ_API_KEY".into(),
            base_url: "https://api.groq.com/openai".into(),
            // Groq retiró la familia llama-3.x: `llama-3.3-70b-versatile` y
            // `llama-3.1-8b-instant` ya no existen en su catálogo (verificado
            // contra /v1/models el 2026-08-23) y cualquier ruta a este proveedor
            // moría con model_not_found. `gpt-oss-20b` es el que responde sin
            // rate limit (~300 ms); el 120b ya los devuelve en esta cuenta.
            default_model: "openai/gpt-oss-20b".into(),
            models: vec!["openai/gpt-oss-20b".into(), "openai/gpt-oss-120b".into()],
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
            // 127.0.0.1 y no localhost (2026-09-21): Ollama escucha solo en
            // IPv4 (TCP 127.0.0.1:11434), pero `localhost` resuelve antes a
            // ::1, asi que cada peticion paga el rechazo de IPv6 antes de que
            // happy-eyeballs reintente por IPv4. Medido: 207 ms contra 2,5 ms,
            // y se paga DOS VECES por invocacion porque call_ollama sondea
            // /api/tags antes de /api/generate. Misma convencion que
            // ollama/commands.rs y ollama/toggle.rs ya usaban.
            health_endpoint: Some("http://127.0.0.1:11434/api/tags".into()),
            kind: ProviderKind::Local,
            key_env_var: String::new(),
            base_url: "http://127.0.0.1:11434".into(),
            default_model: "qwen2.5-coder:32b".into(),
            models: vec![
                "qwen2.5-coder:7b".into(),
                "qwen2.5-coder:32b".into(),
                "deepseek-coder-v2:16b".into(),
            ],
            cli_command: None,
        },
        Provider {
            id: "deepseek".into(),
            name: "DeepSeek".into(),
            cost_per_mtok: 0.14,
            supports: vec![ProviderClass::Light, ProviderClass::Medium],
            api_key_status: ApiKeyStatus::Missing,
            health_endpoint: Some("https://api.deepseek.com/models".into()),
            kind: ProviderKind::Cloud,
            key_env_var: "DEEPSEEK_API_KEY".into(),
            base_url: "https://api.deepseek.com".into(),
            default_model: "deepseek-coder".into(),
            models: vec!["deepseek-coder".into(), "deepseek-chat".into()],
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
    // FAST/general zones (chat, summarize, utility, light) go groq-first.
    // gemini-cli was RETIRED from every chain on 2026-06-19: Google dropped
    // free-tier OAuth for individuals (runtime: IneligibleTierError —
    // "migrate to the Antigravity suite"), so the CLI no longer authenticates.
    // The cloud 'gemini' provider (gemini-2.5-flash via GEMINI_API_KEY;
    // vuelta desde gemini-3.8-flash el 2026-09-16 — 3.8-flash medido en vivo
    // en 55.497 ms, 2.5-flash en 624 ms) replaces it as the general fallback.
    // gemini-cli stays DEFINED in seed_providers in case the tier is restored.
    //
    // Cada zona de esta lista tiene un consumidor REAL en el código, verificado
    // el 2026-09-21 (una zona sin llamante es configuración que miente sobre lo
    // que el sistema hace):
    //   chat       — memory::capture (CAPTURE_ZONE) y el juez de contradicciones
    //                (memory::ai_tasks::ZONE_JUDGE).
    //   code-edit  — library::ai_install, zona preferida de pick_analysis_zone.
    //   code-review— library::ai_install, fallback de pick_analysis_zone.
    //   summarize  — resumen de sesión, cost_watchdog y sessions_tags.
    //   utility    — extracción de hechos (ai_tasks::ZONE_EXTRACT) y el naming
    //                de hooks (hooks_admin::naming).
    //   light      — reescritura de query (ai_tasks::ZONE_REWRITE), apps y
    //                plugins_info::bulk_update.
    //
    // Podadas el 2026-09-21 por no tener NINGÚN llamante: `research-web`,
    // `routing-decision` y `code-fast-local` (esta última dejaba además a
    // Ollama con 0 rutas en metrics.json; el wrapper local sigue vivo como
    // fallback de `light`). `retire_unused_zones` las borra también del
    // zones.json ya escrito.
    vec![
        Zone {
            id: "chat".into(),
            label: "General chat".into(),
            category: "chat".into(),

            primary: ZoneAssignment {
                provider_id: "groq".into(),
                model: "openai/gpt-oss-120b".into(),
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
                    provider_id: "groq".into(),
                    model: "openai/gpt-oss-20b".into(),
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

            // Decision 2026-09-21 (revisa la del 2026-06-24, que ponia 'claude'
            // de primary): las zonas de codigo arrancan por CLI, que es lo que
            // la documentacion venia diciendo desde el 2026-06-08 y lo que de
            // facto pasaba. El 'claude' del seed nunca llegaba a
            // providers.json -- load_providers no fusionaba proveedores nuevos
            // del seed -- asi que el primary no existia en el catalogo y TODA
            // llamada a esta zona fallaba al primary y caia a codex-cli,
            // contando el salto como fallback real en las metricas. Ademas,
            // 'claude' por la Messages API es pago por token, mientras que
            // codex-cli va por la suscripcion de ChatGPT.
            primary: ZoneAssignment {
                // (2026-09-11) code-edit = tareas basicas de codigo -> terra.
                provider_id: "codex-cli".into(),
                model: "gpt-5.6-terra".into(),
                max_tokens: 4096,
            },
            fallbacks: vec![
                ZoneAssignment {
                    // El 'codex' cloud (OPENAI_API_KEY) conserva su id de API
                    // real (gpt-5); terra/sol/astra son alias de suscripción
                    // ChatGPT, exclusivos de 'codex-cli' (ver ese provider).
                    provider_id: "codex".into(),
                    model: "gpt-5".into(),
                    max_tokens: 4096,
                },
                ZoneAssignment {
                    provider_id: "deepseek".into(),
                    model: "deepseek-coder".into(),
                    max_tokens: 4096,
                },
            ],
            system_prompt: None,
        },
        Zone {
            id: "code-review".into(),
            label: "Code review".into(),
            category: "code".into(),

            // Decision 2026-09-21: CLI-first, igual que code-edit y por el
            // mismo motivo (ver el comentario de esa zona). gemini cloud queda
            // de fallback. gemini-cli retirado 2026-06-19
            // (IneligibleTierError); sigue definido en seed_providers por si se
            // restaura, pero fuera de toda cadena.
            primary: ZoneAssignment {
                // (2026-09-11) code-review = trabajo serio -> sol (~Opus).
                provider_id: "codex-cli".into(),
                model: "gpt-5.6-sol".into(),
                max_tokens: 2048,
            },
            fallbacks: vec![ZoneAssignment {
                provider_id: "gemini".into(),
                model: "gemini-2.5-flash".into(),
                max_tokens: 2048,
            }],
            system_prompt: None,
        },
        Zone {
            id: "summarize".into(),
            label: "Summarize document".into(),
            category: "chat".into(),

            // 2026-08-23: las zonas INTERNAS (summarize/utility/light) usan
            // gpt-oss-20b y 'chat' el 120b, tras la
            // retirada de la familia llama-3.x en Groq (ver el comentario del
            // provider). Se mantiene el modelo pequeño en las internas por el
            // mismo motivo de 2026-07-01: bucket de cuota separado del grande,
            // para que la automatización no agote la cuota de la zona cara al
            // usuario y dispare 429 -> fallback.
            primary: ZoneAssignment {
                provider_id: "groq".into(),
                model: "openai/gpt-oss-20b".into(),
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
            id: "utility".into(),
            label: "Utility (internal automation tasks)".into(),
            category: "system".into(),

            primary: ZoneAssignment {
                provider_id: "groq".into(),
                model: "openai/gpt-oss-20b".into(),
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
                provider_id: "groq".into(),
                model: "openai/gpt-oss-20b".into(),
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
                    model: "qwen2.5-coder:32b".into(),
                    max_tokens: 1024,
                },
            ],
            system_prompt: None,
        },
    ]
}
