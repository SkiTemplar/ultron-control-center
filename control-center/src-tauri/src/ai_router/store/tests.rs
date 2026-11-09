// Tests de ai_router::store (migraciones y poda de zones/providers), movidos
// tal cual desde store.rs. Cada submódulo importa las funciones privadas de
// store con `super::super::`.

mod retire_tests {
    use super::super::retire_gemini_cli;
    use crate::ai_router::types::{Zone, ZoneAssignment};

    fn asg(provider: &str, model: &str) -> ZoneAssignment {
        ZoneAssignment {
            provider_id: provider.into(),
            model: model.into(),
            max_tokens: 1024,
        }
    }

    #[test]
    fn keeps_several_models_of_the_same_provider_in_a_chain() {
        // Caso del 2026-09-07: la cuota de Groq es por modelo, así que una
        // cadena con varios modelos de Groq es legítima y no debe recortarse.
        // qwen/qwen3.6-27b se retiró del fixture (2026-09-16): devuelve 404
        // model_not_found en Groq, ya no es un modelo real de esta cuenta.
        let mut zones = vec![Zone {
            id: "chat".into(),
            label: "chat".into(),
            category: "chat".into(),
            primary: asg("groq", "openai/gpt-oss-120b"),
            fallbacks: vec![
                asg("groq", "openai/gpt-oss-20b"),
                asg("gemini", "gemini-2.5-flash"),
            ],
            system_prompt: None,
        }];
        assert!(
            !retire_gemini_cli(&mut zones),
            "nada que migrar ni recortar"
        );
        assert_eq!(zones[0].fallbacks.len(), 2);
    }

    #[test]
    fn drops_exact_duplicates_and_retires_gemini_cli() {
        // Caso negativo: el mismo (proveedor, modelo) repetido sí se recorta, y
        // gemini-cli se sustituye por gemini.
        let mut zones = vec![Zone {
            id: "x".into(),
            label: "x".into(),
            category: "chat".into(),
            primary: asg("groq", "openai/gpt-oss-120b"),
            fallbacks: vec![
                asg("groq", "openai/gpt-oss-120b"),
                asg("gemini-cli", "gemini-3.8-flash"),
            ],
            system_prompt: None,
        }];
        assert!(retire_gemini_cli(&mut zones));
        assert_eq!(zones[0].fallbacks.len(), 1);
        assert_eq!(zones[0].fallbacks[0].provider_id, "gemini");
    }
}

mod retire_unused_zones_tests {
    use super::super::retire_unused_zones;
    use crate::ai_router::types::{Zone, ZoneAssignment};

    fn zone(id: &str) -> Zone {
        Zone {
            id: id.into(),
            label: id.into(),
            category: "chat".into(),
            primary: ZoneAssignment {
                provider_id: "groq".into(),
                model: "openai/gpt-oss-20b".into(),
                max_tokens: 512,
            },
            fallbacks: vec![],
            system_prompt: None,
        }
    }

    #[test]
    fn drops_every_zone_without_a_caller() {
        let mut zones = vec![
            zone("chat"),
            zone("research-web"),
            zone("code-edit"),
            zone("summarize"),
            zone("routing-decision"),
            zone("code-review"),
            zone("code-fast-local"),
            zone("light"),
        ];
        assert!(retire_unused_zones(&mut zones));
        let ids: Vec<&str> = zones.iter().map(|z| z.id.as_str()).collect();
        assert_eq!(ids, vec!["chat", "summarize", "light"]);
    }

    #[test]
    fn keeps_every_zone_that_has_a_caller() {
        // Caso negativo: la migracion no debe tocar las zonas vivas ni
        // reescribir el fichero cuando no hay nada que podar.
        let mut zones = vec![
            zone("chat"),
            zone("summarize"),
            zone("utility"),
            zone("light"),
        ];
        assert!(
            !retire_unused_zones(&mut zones),
            "sin zonas retiradas no debe haber mutacion"
        );
        assert_eq!(zones.len(), 4);
    }
}

mod gemini_flash_migration_tests {
    use super::super::migrate_gemini_flash_model;
    use crate::ai_router::types::{Zone, ZoneAssignment};

    fn asg(provider: &str, model: &str) -> ZoneAssignment {
        ZoneAssignment {
            provider_id: provider.into(),
            model: model.into(),
            max_tokens: 1024,
        }
    }

    #[test]
    fn bumps_gemini_3_8_flash_back_to_2_5_flash_in_primary_and_fallbacks() {
        let mut zones = vec![Zone {
            id: "research-web".into(),
            label: "research-web".into(),
            category: "research".into(),
            primary: asg("gemini", "gemini-3.8-flash"),
            fallbacks: vec![
                asg("groq", "openai/gpt-oss-120b"),
                asg("gemini", "gemini-3.8-flash"),
            ],
            system_prompt: None,
        }];
        assert!(migrate_gemini_flash_model(&mut zones));
        assert_eq!(zones[0].primary.model, "gemini-2.5-flash");
        // La entrada duplicada tras el bump se recorta por (proveedor, modelo).
        assert_eq!(zones[0].fallbacks.len(), 1);
        assert_eq!(zones[0].fallbacks[0].provider_id, "groq");
    }

    #[test]
    fn is_idempotent_when_zones_json_already_on_2_5_flash() {
        // Caso del zones.json vivo tras el bump del 2026-09-16. La migracion
        // no debe reescribir nada ni duplicar la zona.
        let mut zones = vec![Zone {
            id: "chat".into(),
            label: "chat".into(),
            category: "chat".into(),
            primary: asg("groq", "openai/gpt-oss-120b"),
            fallbacks: vec![asg("gemini", "gemini-2.5-flash")],
            system_prompt: None,
        }];
        assert!(
            !migrate_gemini_flash_model(&mut zones),
            "zones.json ya en 2.5-flash: nada que migrar"
        );
        assert_eq!(zones[0].fallbacks.len(), 1);
        assert_eq!(zones[0].fallbacks[0].model, "gemini-2.5-flash");
    }

    #[test]
    fn leaves_other_providers_and_models_untouched() {
        let mut zones = vec![Zone {
            id: "code-fast-local".into(),
            label: "code-fast-local".into(),
            category: "code".into(),
            primary: asg("ollama", "qwen2.5-coder:32b"),
            fallbacks: vec![asg("gemini", "gemini-2.5-pro")],
            system_prompt: None,
        }];
        assert!(!migrate_gemini_flash_model(&mut zones));
        assert_eq!(zones[0].primary.model, "qwen2.5-coder:32b");
        assert_eq!(zones[0].fallbacks[0].model, "gemini-2.5-pro");
    }
}

mod provider_model_migration_tests {
    use super::super::migrate_stale_provider_models;
    use crate::ai_router::types::{ApiKeyStatus, Provider, ProviderClass, ProviderKind};

    fn provider(id: &str, default_model: &str, models: &[&str]) -> Provider {
        Provider {
            id: id.into(),
            name: id.into(),
            cost_per_mtok: 0.0,
            supports: vec![ProviderClass::Light],
            api_key_status: ApiKeyStatus::Missing,
            health_endpoint: None,
            kind: ProviderKind::Cloud,
            key_env_var: String::new(),
            base_url: String::new(),
            default_model: default_model.into(),
            models: models.iter().map(|m| m.to_string()).collect(),
            cli_command: None,
            api_format: crate::ai_router::types::ApiFormat::OpenaiCompat,
            custom: false,
        }
    }

    #[test]
    fn bumps_gemini_default_model_and_catalog() {
        let mut providers = vec![provider(
            "gemini",
            "gemini-3.8-flash",
            &["gemini-3.8-flash", "gemini-2.5-pro"],
        )];
        assert!(migrate_stale_provider_models(&mut providers));
        assert_eq!(providers[0].default_model, "gemini-2.5-flash");
        assert!(providers[0]
            .models
            .contains(&"gemini-2.5-flash".to_string()));
    }

    #[test]
    fn bumps_codex_cli_from_gpt5_and_from_gpt5_5() {
        let mut providers = vec![provider("codex-cli", "gpt-5", &["gpt-5"])];
        assert!(migrate_stale_provider_models(&mut providers));
        assert_eq!(providers[0].default_model, "gpt-5.6-terra");
        assert!(providers[0].models.contains(&"gpt-5.6-sol".to_string()));

        let mut providers2 = vec![provider("codex-cli", "gpt-5.5", &["gpt-5.5"])];
        assert!(migrate_stale_provider_models(&mut providers2));
        assert_eq!(providers2[0].default_model, "gpt-5.6-terra");
    }

    #[test]
    fn bumps_claude_providers_to_the_5_5_family() {
        let mut providers = vec![
            provider(
                "claude",
                "claude-sonnet-5",
                &["claude-sonnet-5", "claude-opus-5", "claude-fable-5"],
            ),
            provider(
                "claude-haiku",
                "claude-haiku-4-5-20251001",
                &["claude-haiku-4-5-20251001"],
            ),
        ];
        assert!(migrate_stale_provider_models(&mut providers));
        assert_eq!(providers[0].default_model, "claude-sonnet-5-5");
        assert!(!providers[0].models.iter().any(|m| m.contains("fable")));
        assert_eq!(providers[1].default_model, "claude-haiku-5-5");
        // Caso negativo: ya en 5.5, no se toca.
        assert!(!migrate_stale_provider_models(&mut providers));
    }

    #[test]
    fn leaves_cloud_codex_provider_untouched() {
        // Regresion guard: una version anterior de esta migracion tambien
        // bumpeaba el 'codex' cloud (OPENAI_API_KEY, API real de OpenAI) a
        // terra/sol/astra, alias de suscripcion invalidos en esa API.
        // Corregido: solo 'codex-cli' esta en TARGETS.
        let mut providers = vec![provider("codex", "gpt-5.5", &["gpt-5.5", "gpt-4o"])];
        assert!(!migrate_stale_provider_models(&mut providers));
        assert_eq!(providers[0].default_model, "gpt-5.5");
        assert_eq!(providers[0].models, vec!["gpt-5.5", "gpt-4o"]);
    }

    #[test]
    fn is_idempotent_when_already_on_seed_model() {
        let mut providers = vec![provider(
            "gemini",
            "gemini-2.5-flash",
            &["gemini-2.5-flash", "gemini-2.5-pro"],
        )];
        assert!(!migrate_stale_provider_models(&mut providers));
    }

    #[test]
    fn leaves_unknown_provider_and_non_stale_default_model_untouched() {
        let mut providers = vec![
            provider("groq", "openai/gpt-oss-20b", &["openai/gpt-oss-20b"]),
            // default_model elegido por el operador, fuera de la lista de
            // valores obsoletos: no se toca (no es una regresión a migrar).
            provider("gemini", "gemini-2.5-pro", &["gemini-2.5-pro"]),
        ];
        assert!(!migrate_stale_provider_models(&mut providers));
        assert_eq!(providers[0].default_model, "openai/gpt-oss-20b");
        assert_eq!(providers[1].default_model, "gemini-2.5-pro");
    }
}
