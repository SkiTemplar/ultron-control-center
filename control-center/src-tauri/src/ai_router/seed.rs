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
            default_model: "claude-sonnet-4-6".into(),
            models: vec!["claude-sonnet-4-6".into(), "claude-opus-4-8".into()],
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
            default_model: "llama-3.3-70b-versatile".into(),
            models: vec![
                "llama-3.3-70b-versatile".into(),
                "llama-3.1-8b-instant".into(),
            ],
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
            health_endpoint: Some("http://localhost:11434/api/tags".into()),
            kind: ProviderKind::Local,
            key_env_var: String::new(),
            base_url: "http://localhost:11434".into(),
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
            name: "OpenAI Codex CLI (gpt-5 via OAuth)".into(),
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
            default_model: "gpt-5".into(),
            models: vec!["gpt-5".into()],
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
    // The cloud 'gemini' provider (gemini-2.5-flash via GEMINI_API_KEY) replaces
    // it as the general fallback and as research-web's primary (web grounding
    // groq lacks). gemini-cli stays DEFINED in seed_providers in case the tier is
    // restored. 'code-fast-local' stays on Ollama (offline by design).
    vec![
        Zone {
            id: "chat".into(),
            label: "General chat".into(),
            category: "chat".into(),

            primary: ZoneAssignment {
                provider_id: "groq".into(),
                model: "llama-3.3-70b-versatile".into(),
                max_tokens: 1024,
            },
            fallbacks: vec![ZoneAssignment {
                provider_id: "gemini".into(),
                model: "gemini-2.5-flash".into(),
                max_tokens: 1024,
            }],
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
                model: "claude-sonnet-4-6".into(),
                max_tokens: 4096,
            },
            fallbacks: vec![
                ZoneAssignment {
                    provider_id: "codex-cli".into(),
                    model: "gpt-5".into(),
                    max_tokens: 4096,
                },
                ZoneAssignment {
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

            // Decision 2026-06-24: Claude-first (Sonnet), codex-cli as the first
            // fallback, then gemini cloud. gemini-cli retirado 2026-06-19
            // (IneligibleTierError). Ambos providers retirados siguen definidos
            // en seed_providers por si se restauran.
            primary: ZoneAssignment {
                provider_id: "claude".into(),
                model: "claude-sonnet-4-6".into(),
                max_tokens: 2048,
            },
            fallbacks: vec![
                ZoneAssignment {
                    provider_id: "codex-cli".into(),
                    model: "gpt-5".into(),
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
                provider_id: "groq".into(),
                model: "llama-3.3-70b-versatile".into(),
                max_tokens: 4096,
            }],
            system_prompt: None,
        },
        Zone {
            id: "summarize".into(),
            label: "Summarize document".into(),
            category: "chat".into(),

            // 2026-07-01: las zonas INTERNAS (summarize/routing-decision/utility/
            // light) usan llama-3.1-8b-instant — bucket TPD de groq SEPARADO del
            // 70b. Compartir bucket agotaba los 100k TPD del 70b con automatización
            // y disparaba 429→fallback (rolling 15%). 'chat' (cara al usuario)
            // conserva el 70b.
            primary: ZoneAssignment {
                provider_id: "groq".into(),
                model: "llama-3.1-8b-instant".into(),
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
                provider_id: "groq".into(),
                model: "llama-3.1-8b-instant".into(),
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
                model: "qwen2.5-coder:32b".into(),
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
                provider_id: "groq".into(),
                model: "llama-3.1-8b-instant".into(),
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
                model: "llama-3.1-8b-instant".into(),
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
