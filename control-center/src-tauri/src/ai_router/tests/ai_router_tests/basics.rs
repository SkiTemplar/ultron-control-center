// Basic smoke tests — CLI args, seed providers/zones, truncate, placeholder, clamp.

use crate::ai_router::exec::cli_invocation_args;
use crate::ai_router::primary_model_for_zone;
use crate::ai_router::providers::clamp_max_tokens;
use crate::ai_router::providers::truncate;
use crate::ai_router::seed::{seed_providers, seed_zones};
use crate::ai_router::store::looks_like_placeholder;

#[test]
fn codex_cli_uses_exec_subcommand_not_dash_p() {
    // The prompt itself does NOT travel via argv for codex anymore (KIRKARDO
    // HIGH fix, 2026-09-11) — it goes through stdin (call_cli pipes it), so
    // argv[1] is always the literal "-" placeholder regardless of `prompt`'s
    // content. See call_cli_codex_preserves_a_prompt_with_shell_metacharacters_via_stdin
    // in retry.rs for the stdin round-trip coverage.
    let codex = cli_invocation_args(true, "hello world", "gpt-5.6-terra");
    assert_eq!(codex[0], "exec", "codex must use the exec subcommand");
    assert_eq!(
        codex[1], "-",
        "codex reads the prompt from stdin via the '-' placeholder, not argv"
    );
    assert!(
        !codex.contains(&"-p"),
        "codex must NOT receive -p (it means --profile)"
    );
    assert!(
        !codex.contains(&"hello world"),
        "the prompt must never appear on argv for codex; got: {:?}",
        codex
    );
    // `--model` IS a valid `codex exec` flag (verified 2026-09-11 via
    // `codex exec --help`); before that fix the zone's model never reached
    // the CLI at all (KIRKARDO wiring bug — see cli_invocation_args doc).
    assert!(
        codex.contains(&"--model") && codex.contains(&"gpt-5.6-terra"),
        "codex must receive the ZoneAssignment model via --model; got: {:?}",
        codex
    );
    assert!(codex.contains(&"--sandbox") && codex.contains(&"read-only"));

    let gemini = cli_invocation_args(false, "hello world", "gemini-3.8-flash");
    assert_eq!(gemini[0], "-p", "gemini uses -p for the prompt");
    assert_eq!(gemini[1], "hello world");
    assert!(gemini.contains(&"--model") && gemini.contains(&"gemini-3.8-flash"));
    assert!(!gemini.contains(&"exec"), "gemini has no exec subcommand");
}

#[test]
fn codex_cli_omits_model_flag_when_model_is_empty() {
    // Guard: an empty model (e.g. a misconfigured ZoneAssignment) must not
    // produce `codex exec ... --model ""` — that would break the call.
    let codex = cli_invocation_args(true, "hello world", "");
    assert!(
        !codex.contains(&"--model"),
        "an empty model must not emit --model; got: {:?}",
        codex
    );
}

#[test]
fn seed_providers_includes_all_targets() {
    let ids: Vec<String> = seed_providers().into_iter().map(|p| p.id).collect();
    for expected in [
        "claude",
        "claude-haiku",
        "codex",
        "gemini",
        "groq",
        "ollama",
        "deepseek",
    ] {
        assert!(ids.iter().any(|id| id == expected), "missing {}", expected);
    }
}

// Herméticos: `load_zones` lee y, si migra algo, REESCRIBE zones.json y
// providers.json; con `TestRootGuard` lo hace en un directorio temporal y no
// en la configuración real del usuario.
#[test]
fn primary_model_for_known_zone_is_some() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _root = crate::ai_router::types::TestRootGuard::new(dir.path());
    assert_eq!(
        primary_model_for_zone("light").as_deref(),
        Some("openai/gpt-oss-20b")
    );
}

#[test]
fn primary_model_for_unknown_zone_is_none() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _root = crate::ai_router::types::TestRootGuard::new(dir.path());
    assert!(primary_model_for_zone("no-such-zone-xyz").is_none());
}

/// Zonas que el código fuente enruta de verdad: literales de
/// `ai_router::route("<zona>"` y constantes `const <..ZONE..>: &str = "<zona>"`
/// (los llamantes que pasan la zona por una constante), fuera de `ai_router/`.
fn zones_routed_by_the_source() -> std::collections::BTreeSet<String> {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let literal = regex::Regex::new(r#"ai_router::route\(\s*"([^"]+)""#).expect("regex");
    let constant =
        regex::Regex::new(r#"const\s+\w*ZONE\w*\s*:\s*&str\s*=\s*"([^"]+)""#).expect("regex");
    let mut zones = std::collections::BTreeSet::new();
    for entry in walkdir::WalkDir::new(&src)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        let in_router = path.components().any(|c| c.as_os_str() == "ai_router");
        if in_router || path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        for re in [&literal, &constant] {
            zones.extend(re.captures_iter(&text).map(|c| c[1].to_string()));
        }
    }
    zones
}

/// La semilla lista SOLO zonas que alguien invoca de verdad, comprobado
/// contra el código fuente y no contra una lista escrita a mano (la lista
/// anterior fijaba code-edit y code-review, sin llamante desde el
/// 2026-09-23). Falla si se añade al seed una zona sin llamante y también si
/// el código enruta a una zona que el seed no define.
#[test]
fn seed_zones_are_exactly_the_zones_with_a_caller() {
    let seeded: std::collections::BTreeSet<String> =
        seed_zones().into_iter().map(|z| z.id).collect();
    let routed = zones_routed_by_the_source();
    assert!(
        routed.len() >= 4,
        "el escaneo no encuentra los llamantes: {routed:?}"
    );
    assert_eq!(
        seeded, routed,
        "zonas del seed frente a zonas con llamante en src/"
    );
}

/// Caso negativo del escaneo: una zona retirada no tiene llamante, así que
/// reintroducirla en el seed rompería la igualdad de arriba.
#[test]
fn retired_zones_have_no_caller_in_the_source() {
    let routed = zones_routed_by_the_source();
    for retired in crate::ai_router::store::RETIRED_ZONE_IDS {
        assert!(
            !routed.contains(retired),
            "la zona retirada '{retired}' vuelve a tener llamante"
        );
    }
}

#[test]
fn seed_zones_ship_no_dead_gemini_cli() {
    // Source of truth must not ship the retired gemini-cli in any chain
    // (Google killed free-tier OAuth 2026-06-19 -> IneligibleTierError).
    for z in seed_zones() {
        assert_ne!(z.primary.provider_id, "gemini-cli", "zone {} primary", z.id);
        assert!(
            !z.fallbacks.iter().any(|f| f.provider_id == "gemini-cli"),
            "zone {} still lists gemini-cli as a fallback",
            z.id
        );
    }
}

#[test]
fn retire_gemini_cli_swaps_primary_and_dedups() {
    use crate::ai_router::store::retire_gemini_cli;
    use crate::ai_router::types::{Zone, ZoneAssignment};

    fn asg(p: &str) -> ZoneAssignment {
        ZoneAssignment {
            provider_id: p.into(),
            model: "gemini-2.5-flash".into(),
            max_tokens: 1024,
        }
    }
    fn zone(id: &str, primary: &str, fbs: &[&str]) -> Zone {
        Zone {
            id: id.into(),
            label: id.into(),
            category: "test".into(),
            primary: asg(primary),
            fallbacks: fbs.iter().map(|p| asg(p)).collect(),
            system_prompt: None,
        }
    }
    fn fb_ids(z: &Zone) -> Vec<&str> {
        z.fallbacks.iter().map(|f| f.provider_id.as_str()).collect()
    }

    let mut zones = vec![
        // gemini-cli primary + gemini fallback -> gemini primary, dup gemini dropped
        zone("research-web", "gemini-cli", &["gemini", "groq"]),
        // [gemini-cli, gemini] -> [gemini] (collapsed)
        zone("summarize", "groq", &["gemini-cli", "gemini"]),
        // [gemini-cli, ollama] -> [gemini, ollama]
        zone("light", "groq", &["gemini-cli", "ollama"]),
    ];
    assert!(
        retire_gemini_cli(&mut zones),
        "must mutate when gemini-cli present"
    );

    for z in &zones {
        assert_ne!(z.primary.provider_id, "gemini-cli");
        assert!(!z.fallbacks.iter().any(|f| f.provider_id == "gemini-cli"));
    }
    let rw = zones.iter().find(|z| z.id == "research-web").unwrap();
    assert_eq!(rw.primary.provider_id, "gemini");
    assert_eq!(
        fb_ids(rw),
        vec!["groq"],
        "research-web dup gemini must collapse"
    );
    let sm = zones.iter().find(|z| z.id == "summarize").unwrap();
    assert_eq!(
        fb_ids(sm),
        vec!["gemini"],
        "summarize must collapse to one gemini"
    );
    let lt = zones.iter().find(|z| z.id == "light").unwrap();
    assert_eq!(fb_ids(lt), vec!["gemini", "ollama"]);

    // Negative case: a chain with no gemini-cli must NOT be reported as mutated.
    let mut clean = vec![zone("chat", "groq", &["gemini", "ollama"])];
    assert!(
        !retire_gemini_cli(&mut clean),
        "no mutation expected when gemini-cli is absent"
    );
}

#[test]
fn truncate_respects_unicode() {
    let s = "abcdefghij";
    assert_eq!(truncate(s, 5), "abcde...");
    assert_eq!(truncate(s, 99), "abcdefghij");
}

#[test]
fn placeholder_detection_catches_common_patterns() {
    assert!(looks_like_placeholder("YOUR-KEY-HERE"));
    assert!(looks_like_placeholder("replace-me"));
    assert!(looks_like_placeholder("sk-..."));
    assert!(!looks_like_placeholder("sk-proj-abc123"));
}

#[test]
fn clamp_max_tokens_uses_default_on_zero() {
    assert_eq!(clamp_max_tokens(0, 1024), 1024);
    assert_eq!(clamp_max_tokens(2048, 1024), 2048);
    assert_eq!(clamp_max_tokens(99_999, 1024), 8192);
}

// ---------------------------------------------------------------------------
// Integridad catalogo <-> zonas (2026-09-21)
//
// Durante tres meses el primary de code-edit y code-review fue 'claude', un id
// que estaba en seed_providers pero que load_providers nunca copiaba a un
// providers.json ya escrito. Las dos zonas llamaban a un proveedor inexistente
// y caian al fallback en cada peticion, contando el salto como fallback real.
// Nada fallaba al arrancar: solo en tiempo de ejecucion, una llamada mas tarde.
// Estos tests convierten esa invariante en algo que el CI puede romper.
// ---------------------------------------------------------------------------

/// Ninguna zona del seed puede apuntar a un proveedor que el seed no define.
#[test]
fn toda_zona_del_seed_apunta_a_un_proveedor_del_seed() {
    let catalogo: std::collections::HashSet<String> =
        seed_providers().into_iter().map(|p| p.id).collect();
    for z in seed_zones() {
        assert!(
            catalogo.contains(&z.primary.provider_id),
            "la zona '{}' tiene de primary '{}', que no esta en seed_providers",
            z.id,
            z.primary.provider_id
        );
        for f in &z.fallbacks {
            assert!(
                catalogo.contains(&f.provider_id),
                "la zona '{}' tiene un fallback '{}' que no esta en seed_providers",
                z.id,
                f.provider_id
            );
        }
    }
}

/// Una cadena que repite la MISMA pareja (proveedor, modelo) la reintenta dos
/// veces seguidas sin ganar nada.
///
/// Repetir el proveedor con OTRO modelo si es util y esta en el seed a
/// proposito: la cuota de Groq es por modelo, asi que 'chat' encadena
/// gpt-oss-120b y gpt-oss-20b para que un 429 del primero no agote la cadena
/// (medido el 2026-09-07: 266 llamadas en un dia dejaban la captura sin
/// proveedor). Por eso la invariante es sobre la pareja, no sobre el id.
#[test]
fn ninguna_cadena_del_seed_repite_proveedor_y_modelo() {
    for z in seed_zones() {
        let mut vistos = std::collections::HashSet::new();
        vistos.insert((z.primary.provider_id.clone(), z.primary.model.clone()));
        for f in &z.fallbacks {
            assert!(
                vistos.insert((f.provider_id.clone(), f.model.clone())),
                "la zona '{}' repite '{}' con el modelo '{}' en su cadena",
                z.id,
                f.provider_id,
                f.model
            );
        }
    }
}

/// La dedup de `repair_zones_against_catalog` NO puede colapsar dos entradas
/// del mismo proveedor con modelos distintos: eso es la estrategia anti-429 de
/// Groq, no un duplicado. `maria-core` deduplica solo por provider_id y aqui
/// habria roto la cadena de 'chat'.
#[test]
fn reparar_zonas_conserva_el_mismo_proveedor_con_otro_modelo() {
    use crate::ai_router::store::repair_zones_against_catalog;
    use crate::ai_router::types::{Zone, ZoneAssignment};

    let asignacion = |p: &str, m: &str| ZoneAssignment {
        provider_id: p.into(),
        model: m.into(),
        max_tokens: 1024,
    };
    let mut zonas = vec![Zone {
        id: "chat".into(),
        label: "chat".into(),
        category: "chat".into(),
        primary: asignacion("groq", "openai/gpt-oss-120b"),
        fallbacks: vec![
            asignacion("groq", "openai/gpt-oss-20b"),
            asignacion("gemini", "gemini-2.5-flash"),
        ],
        system_prompt: None,
    }];
    let catalogo = vec!["groq".to_string(), "gemini".to_string()];

    let mutado = repair_zones_against_catalog(&mut zonas, &catalogo);
    assert!(!mutado, "una cadena sana no debe mutar");
    assert_eq!(
        zonas[0].fallbacks.len(),
        2,
        "el segundo groq debe sobrevivir"
    );
    assert_eq!(zonas[0].fallbacks[0].model, "openai/gpt-oss-20b");
}

/// Un primary fuera del catalogo asciende el primer fallback vigente.
#[test]
fn reparar_zonas_asciende_el_primer_fallback_cuando_el_primary_no_existe() {
    use crate::ai_router::store::repair_zones_against_catalog;
    use crate::ai_router::types::{Zone, ZoneAssignment};

    let asignacion = |p: &str, m: &str| ZoneAssignment {
        provider_id: p.into(),
        model: m.into(),
        max_tokens: 4096,
    };
    let mut zonas = vec![Zone {
        id: "code-edit".into(),
        label: "code".into(),
        category: "code".into(),
        // El caso real: 'claude' estaba en el seed pero no en providers.json.
        primary: asignacion("claude", "claude-sonnet-5"),
        fallbacks: vec![
            asignacion("codex-cli", "gpt-5.6-terra"),
            asignacion("deepseek", "deepseek-coder"),
        ],
        system_prompt: None,
    }];
    let catalogo = vec!["codex-cli".to_string(), "deepseek".to_string()];

    assert!(repair_zones_against_catalog(&mut zonas, &catalogo));
    assert_eq!(zonas[0].primary.provider_id, "codex-cli");
    assert_eq!(zonas[0].primary.model, "gpt-5.6-terra");
    assert_eq!(
        zonas[0].fallbacks.len(),
        1,
        "el ascendido sale de fallbacks"
    );
    assert_eq!(zonas[0].fallbacks[0].provider_id, "deepseek");
}

fn zona_fantasma(id: &str) -> crate::ai_router::types::Zone {
    use crate::ai_router::types::{Zone, ZoneAssignment};
    Zone {
        id: id.into(),
        label: "u".into(),
        category: "chat".into(),
        primary: ZoneAssignment {
            provider_id: "fantasma".into(),
            model: "x".into(),
            max_tokens: 512,
        },
        fallbacks: vec![ZoneAssignment {
            provider_id: "otro-fantasma".into(),
            model: "y".into(),
            max_tokens: 512,
        }],
        system_prompt: None,
    }
}

/// Sin ningun fallback vigente, una zona del seed recupera la cadena del seed
/// (filtrada por el catalogo). Ollama ya no es el destino de ultimo recurso:
/// desde el 2026-10-19 solo se usa para programar.
#[test]
fn reparar_zonas_recupera_la_cadena_del_seed_cuando_no_queda_nadie() {
    use crate::ai_router::store::repair_zones_against_catalog;

    let mut zonas = vec![zona_fantasma("utility")];
    let catalogo: Vec<String> = seed_providers().into_iter().map(|p| p.id).collect();

    assert!(repair_zones_against_catalog(&mut zonas, &catalogo));
    let seed = seed_zones()
        .into_iter()
        .find(|z| z.id == "utility")
        .expect("utility");
    assert_eq!(zonas[0].primary, seed.primary);
    assert_eq!(zonas[0].fallbacks, seed.fallbacks);
    assert_ne!(zonas[0].primary.provider_id, "ollama");
}

/// Caso negativo: una zona ajena al seed sin proveedor vigente NO se manda a
/// ollama; se queda como esta y route() fallara con un error explicito.
#[test]
fn reparar_zonas_no_manda_a_ollama_una_zona_ajena_al_seed() {
    use crate::ai_router::store::repair_zones_against_catalog;

    let mut zonas = vec![zona_fantasma("zona-del-operador")];
    let catalogo = vec!["ollama".to_string(), "groq".to_string()];

    repair_zones_against_catalog(&mut zonas, &catalogo);
    assert_eq!(zonas[0].primary.provider_id, "fantasma");
    assert!(zonas[0].fallbacks.is_empty(), "el fallback muerto se cae");
}

/// El merge del catalogo repara el caso medido: providers.json sin 'claude'.
#[test]
fn el_merge_anade_los_proveedores_del_seed_que_faltan() {
    use crate::ai_router::store::merge_missing_seed_providers;

    let mut catalogo: Vec<_> = seed_providers()
        .into_iter()
        .filter(|p| p.id != "claude")
        .collect();
    let antes = catalogo.len();

    assert!(merge_missing_seed_providers(&mut catalogo), "debe anadir");
    assert_eq!(catalogo.len(), antes + 1);
    assert!(catalogo.iter().any(|p| p.id == "claude"));
    // Idempotente: una segunda pasada no toca nada.
    assert!(!merge_missing_seed_providers(&mut catalogo));
}

/// El merge NO pisa lo que el operador haya editado a mano.
#[test]
fn el_merge_respeta_una_entrada_editada_por_el_operador() {
    use crate::ai_router::store::merge_missing_seed_providers;

    let mut catalogo = seed_providers();
    let i = catalogo.iter().position(|p| p.id == "groq").expect("groq");
    catalogo[i].default_model = "modelo-elegido-a-mano".to_string();

    assert!(
        !merge_missing_seed_providers(&mut catalogo),
        "nada que anadir"
    );
    assert_eq!(catalogo[i].default_model, "modelo-elegido-a-mano");
}

/// Verificacion en runtime contra los ficheros reales de esta maquina. Fuera
/// de la suite porque escribe en cockpit/ai-router/. Ejecutar a mano con:
/// `cargo test --features qdrant repara_el_router_real -- --ignored --nocapture`
#[test]
#[ignore]
fn repara_el_router_real_de_esta_maquina() {
    use crate::ai_router::store::{load_providers, load_zones};

    let catalogo: Vec<String> = load_providers()
        .expect("providers")
        .into_iter()
        .map(|p| p.id)
        .collect();
    println!("catalogo ({}): {}", catalogo.len(), catalogo.join(", "));

    let zonas = load_zones().expect("zones");
    for z in &zonas {
        let cadena: Vec<String> = std::iter::once(&z.primary)
            .chain(z.fallbacks.iter())
            .map(|a| format!("{}:{}", a.provider_id, a.model))
            .collect();
        println!("  {:12} -> {}", z.id, cadena.join(" | "));
    }

    for z in &zonas {
        assert!(
            catalogo.contains(&z.primary.provider_id),
            "zona '{}' con primary '{}' fuera del catalogo",
            z.id,
            z.primary.provider_id
        );
        for f in &z.fallbacks {
            assert!(
                catalogo.contains(&f.provider_id),
                "zona '{}' con fallback '{}' fuera del catalogo",
                z.id,
                f.provider_id
            );
        }
    }
}

/// El caso medido: 'chat' perdio su groq:20b y la migracion se lo devuelve
/// EN MEDIO, antes de gemini, que es donde la estrategia anti-429 lo pone.
#[test]
fn restaura_el_fallback_de_groq_que_se_perdio_en_chat() {
    use crate::ai_router::store::restore_missing_seed_fallbacks;
    use crate::ai_router::types::{Zone, ZoneAssignment};

    let asg = |p: &str, m: &str| ZoneAssignment {
        provider_id: p.into(),
        model: m.into(),
        max_tokens: 1024,
    };
    let mut zonas = vec![Zone {
        id: "chat".into(),
        label: "chat".into(),
        category: "chat".into(),
        primary: asg("groq", "openai/gpt-oss-120b"),
        // Cadena danada: falta el groq:20b de en medio.
        fallbacks: vec![asg("gemini", "gemini-2.5-flash")],
        system_prompt: None,
    }];

    assert!(restore_missing_seed_fallbacks(&mut zonas));
    let ids: Vec<String> = zonas[0]
        .fallbacks
        .iter()
        .map(|f| format!("{}:{}", f.provider_id, f.model))
        .collect();
    assert_eq!(
        ids,
        vec!["groq:openai/gpt-oss-20b", "gemini:gemini-2.5-flash"],
        "el 20b debe volver ANTES de gemini: agotar groq antes de gastar la cuota diaria"
    );
    // Idempotente.
    assert!(!restore_missing_seed_fallbacks(&mut zonas));
}

/// Lo que el operador anadio por su cuenta no se toca ni se reordena.
#[test]
fn restaurar_no_pisa_los_fallbacks_del_operador() {
    use crate::ai_router::store::restore_missing_seed_fallbacks;
    use crate::ai_router::types::{Zone, ZoneAssignment};

    let asg = |p: &str, m: &str| ZoneAssignment {
        provider_id: p.into(),
        model: m.into(),
        max_tokens: 1024,
    };
    let propio = asg("deepseek", "modelo-del-operador");
    let mut zonas = vec![Zone {
        id: "chat".into(),
        label: "chat".into(),
        category: "chat".into(),
        primary: asg("groq", "openai/gpt-oss-120b"),
        fallbacks: vec![asg("gemini", "gemini-2.5-flash"), propio.clone()],
        system_prompt: None,
    }];

    assert!(restore_missing_seed_fallbacks(&mut zonas));
    let suyo = zonas[0]
        .fallbacks
        .iter()
        .find(|f| f.provider_id == "deepseek")
        .expect("el fallback del operador sigue ahi");
    assert_eq!(suyo.model, "modelo-del-operador");
}

/// Una zona que no esta en el seed no se toca.
#[test]
fn restaurar_ignora_las_zonas_ajenas_al_seed() {
    use crate::ai_router::store::restore_missing_seed_fallbacks;
    use crate::ai_router::types::{Zone, ZoneAssignment};

    let mut zonas = vec![Zone {
        id: "zona-inventada".into(),
        label: "x".into(),
        category: "x".into(),
        primary: ZoneAssignment {
            provider_id: "groq".into(),
            model: "m".into(),
            max_tokens: 1,
        },
        fallbacks: vec![],
        system_prompt: None,
    }];
    assert!(!restore_missing_seed_fallbacks(&mut zonas));
    assert!(zonas[0].fallbacks.is_empty());
}

/// El localhost de ollama pasa a 127.0.0.1 en un providers.json ya escrito.
#[test]
fn migra_el_localhost_de_ollama_a_la_ip_de_loopback() {
    use crate::ai_router::store::migrate_ollama_loopback;

    let mut catalogo = seed_providers();
    let i = catalogo
        .iter()
        .position(|p| p.id == "ollama")
        .expect("ollama");
    catalogo[i].base_url = "http://localhost:11434".into();
    catalogo[i].health_endpoint = Some("http://localhost:11434/api/tags".into());

    assert!(migrate_ollama_loopback(&mut catalogo));
    assert_eq!(catalogo[i].base_url, "http://127.0.0.1:11434");
    assert_eq!(
        catalogo[i].health_endpoint.as_deref(),
        Some("http://127.0.0.1:11434/api/tags")
    );
    // Idempotente.
    assert!(!migrate_ollama_loopback(&mut catalogo));
}

/// Un ollama apuntado a OTRA maquina es una eleccion del operador, no deriva.
#[test]
fn migrar_loopback_no_toca_un_ollama_remoto() {
    use crate::ai_router::store::migrate_ollama_loopback;

    let mut catalogo = seed_providers();
    let i = catalogo
        .iter()
        .position(|p| p.id == "ollama")
        .expect("ollama");
    catalogo[i].base_url = "http://192.168.1.50:11434".into();
    catalogo[i].health_endpoint = Some("http://192.168.1.50:11434/api/tags".into());

    assert!(!migrate_ollama_loopback(&mut catalogo));
    assert_eq!(catalogo[i].base_url, "http://192.168.1.50:11434");
}

/// El seed no puede volver a llevar localhost: es lo que costaba 207 ms.
#[test]
fn el_seed_de_ollama_usa_la_ip_de_loopback() {
    let ollama = seed_providers()
        .into_iter()
        .find(|p| p.id == "ollama")
        .expect("ollama en el seed");
    assert!(
        !ollama.base_url.contains("localhost"),
        "base_url del seed con localhost: {}",
        ollama.base_url
    );
    assert!(
        !ollama
            .health_endpoint
            .as_deref()
            .unwrap_or_default()
            .contains("localhost"),
        "health_endpoint del seed con localhost"
    );
}
