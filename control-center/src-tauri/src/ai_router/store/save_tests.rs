// Tests de la validación de `save_zone`, de la retirada de ollama y de la
// carga de un zones.json antiguo. Los que tocan disco van con
// `TestRootGuard`: no leen ni reescriben la configuración real del usuario.

mod ollama_retirement_tests {
    use super::super::retire_seed_ollama_fallback;
    use crate::ai_router::seed::seed_zones;
    use crate::ai_router::types::{Zone, ZoneAssignment};

    fn asg(provider: &str, model: &str) -> ZoneAssignment {
        ZoneAssignment {
            provider_id: provider.into(),
            model: model.into(),
            max_tokens: 1024,
        }
    }

    fn light(fallbacks: Vec<ZoneAssignment>) -> Zone {
        Zone {
            id: "light".into(),
            label: "light".into(),
            category: "chat".into(),
            primary: asg("groq", "openai/gpt-oss-20b"),
            fallbacks,
            system_prompt: None,
        }
    }

    /// El zones.json escrito con el seed anterior pierde el relevo de ollama.
    #[test]
    fn drops_the_old_seed_ollama_fallback_from_light() {
        let mut zones = vec![light(vec![
            asg("groq", "openai/gpt-oss-120b"),
            asg("gemini", "gemini-2.5-flash"),
            asg("ollama", "qwen2.5-coder:32b"),
        ])];
        assert!(retire_seed_ollama_fallback(&mut zones));
        assert!(!zones[0].fallbacks.iter().any(|f| f.provider_id == "ollama"));
        assert!(!retire_seed_ollama_fallback(&mut zones), "idempotente");
    }

    /// Caso negativo: otra zona u otro modelo de ollama no son la entrada del
    /// seed y no se tocan.
    #[test]
    fn leaves_other_zones_and_models_alone() {
        let mut zones = vec![light(vec![asg("ollama", "qwen2.5-coder:7b")])];
        let mut otra = light(vec![asg("ollama", "qwen2.5-coder:32b")]);
        otra.id = "zona-del-operador".into();
        zones.push(otra);
        assert!(!retire_seed_ollama_fallback(&mut zones));
        assert_eq!(zones[0].fallbacks.len(), 1);
        assert_eq!(zones[1].fallbacks.len(), 1);
    }

    /// Ninguna zona del seed lleva ollama (decisión 2026-10-19).
    #[test]
    fn no_seed_zone_routes_to_ollama() {
        for z in seed_zones() {
            let mut chain = std::iter::once(&z.primary).chain(z.fallbacks.iter());
            assert!(
                !chain.any(|a| a.provider_id == "ollama"),
                "la zona '{}' lleva ollama",
                z.id
            );
        }
    }
}

mod save_zone_tests {
    use super::super::{load_zones, save_zone, validate_zone_edit};
    use crate::ai_router::seed::{seed_providers, seed_zones};
    use crate::ai_router::types::{TestRootGuard, Zone, ZoneAssignment};

    fn catalog() -> Vec<String> {
        seed_providers().into_iter().map(|p| p.id).collect()
    }

    fn seed_zone(id: &str) -> Zone {
        seed_zones()
            .into_iter()
            .find(|z| z.id == id)
            .expect("zona del seed")
    }

    /// Una edición que sobrevive a la carga se acepta.
    #[test]
    fn accepts_an_edit_the_load_keeps() {
        let mut z = seed_zone("utility");
        z.primary.max_tokens = 256;
        z.fallbacks.push(ZoneAssignment {
            provider_id: "deepseek".into(),
            model: "deepseek-chat".into(),
            max_tokens: 256,
        });
        assert_eq!(validate_zone_edit(&z, &catalog()), Ok(()));
    }

    /// router-3: gemini-cli lo ofrece el editor, pero la carga lo cambia por
    /// gemini. Antes se guardaba y la UI decía «Guardado».
    #[test]
    fn rejects_gemini_cli_with_the_reason() {
        let mut z = seed_zone("summarize");
        z.fallbacks[0].provider_id = "gemini-cli".into();
        let err = validate_zone_edit(&z, &catalog()).expect_err("debe rechazarse");
        assert!(err.contains("gemini-cli está retirado"), "{err}");
        assert!(err.contains("gemini:gemini-2.5-flash"), "{err}");
    }

    /// router-3: quitar un fallback del seed lo revertía la carga siguiente.
    #[test]
    fn rejects_removing_a_seed_fallback() {
        let mut z = seed_zone("chat");
        z.fallbacks.retain(|f| f.model != "openai/gpt-oss-20b");
        let err = validate_zone_edit(&z, &catalog()).expect_err("debe rechazarse");
        assert!(err.contains("fallbacks del seed"), "{err}");
    }

    /// Un proveedor fuera del catálogo tampoco sobrevive a la carga.
    #[test]
    fn rejects_a_provider_outside_the_catalog() {
        let mut z = seed_zone("light");
        z.primary.provider_id = "fantasma".into();
        let err = validate_zone_edit(&z, &catalog()).expect_err("debe rechazarse");
        assert!(err.contains("catálogo"), "{err}");
    }

    /// De punta a punta y hermético: lo que `save_zone` acepta es lo que
    /// devuelve la carga siguiente, y lo que rechaza no llega al disco.
    #[test]
    fn saved_zone_survives_the_next_load() {
        let dir = tempfile::tempdir().expect("tempdir");
        let _root = TestRootGuard::new(dir.path());
        let mut z = seed_zone("utility");
        z.primary.max_tokens = 300;
        let saved = save_zone(z.clone()).expect("guardar");
        assert_eq!(saved, z);
        let reloaded = load_zones().expect("cargar");
        assert_eq!(reloaded.iter().find(|r| r.id == "utility"), Some(&z));

        let mut bad = z.clone();
        bad.primary.provider_id = "gemini-cli".into();
        assert!(save_zone(bad).is_err());
        let after = load_zones().expect("cargar");
        assert_eq!(after.iter().find(|r| r.id == "utility"), Some(&z));
    }

    /// Un zones.json antiguo (zona de código y ollama en light) sale podado
    /// de la carga.
    #[test]
    fn load_prunes_a_legacy_zones_json() {
        let dir = tempfile::tempdir().expect("tempdir");
        let _root = TestRootGuard::new(dir.path());
        let router = dir.path().join("cockpit").join("ai-router");
        std::fs::create_dir_all(&router).expect("dir");
        let mut legacy = seed_zones();
        let mut code = seed_zone("chat");
        code.id = "code-edit".into();
        code.category = "code".into();
        legacy.push(code);
        let light = legacy.iter_mut().find(|z| z.id == "light").expect("light");
        light.fallbacks.push(ZoneAssignment {
            provider_id: "ollama".into(),
            model: "qwen2.5-coder:32b".into(),
            max_tokens: 1024,
        });
        let body = serde_json::to_vec_pretty(&legacy).expect("json");
        std::fs::write(router.join("zones.json"), body).expect("write");

        assert_eq!(load_zones().expect("cargar"), seed_zones());
    }
}
