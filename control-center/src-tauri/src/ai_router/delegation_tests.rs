use super::*;
use crate::ai_router::types::TestRootGuard;

fn default_cfg() -> DelegationConfig {
    default_delegation().expect("el delegation.json incrustado debe parsear")
}

/// El `cockpit/ai-router/delegation.default.json` del repo (el incrustado)
/// pasa la misma validación que una edición desde la UI: si `delegate.mjs`
/// lo deja con un runner, un tier o un `envMap` que la app rechazaría, este
/// test lo detecta.
#[test]
fn el_default_incrustado_es_valido() {
    let cfg = default_cfg();
    validate_delegation(&cfg).expect("el default debe ser válido");
    for start in ["codex", "agy"] {
        assert!(
            cfg.chain.iter().any(|c| c == start),
            "falta '{start}' en chain"
        );
    }
}

/// Sin `delegation.json` del usuario, la lectura devuelve el default
/// incrustado y no escribe nada (caso negativo: antes lo copiaba al fichero
/// del usuario, que así nacía igual que el versionado).
#[test]
fn la_lectura_sin_fichero_devuelve_el_default_sin_escribir() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _g = TestRootGuard::new(dir.path());
    let cfg = load_delegation().expect("load");
    assert_eq!(cfg, default_cfg());
    assert!(!dir
        .path()
        .join("cockpit/ai-router/delegation.json")
        .exists());
}

/// Guardar escribe el `delegation.json` del usuario (ignorado por git) y
/// la lectura siguiente lo prefiere al default.
#[test]
fn guardar_escribe_el_fichero_del_usuario() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _g = TestRootGuard::new(dir.path());
    let mut cfg = default_cfg();
    cfg.relay_on_check_fail = !cfg.relay_on_check_fail;
    save_delegation(&cfg).expect("save");
    let user = dir.path().join("cockpit/ai-router/delegation.json");
    assert!(user.exists());
    assert!(!dir
        .path()
        .join("cockpit/ai-router/delegation.default.json")
        .exists());
    assert_eq!(load_delegation().expect("load"), cfg);
}

fn errors_of(cfg: &DelegationConfig) -> String {
    validate_delegation(cfg).expect_err("debía fallar")
}

fn engine_mut<'a>(cfg: &'a mut DelegationConfig, id: &str) -> &'a mut DelegationEngine {
    cfg.engines.get_mut(id).expect("motor del default")
}

#[test]
fn acepta_los_cuatro_runners() {
    let mut cfg = default_cfg();
    for runner in RUNNERS {
        engine_mut(&mut cfg, "agy").runner = (*runner).to_string();
        engine_mut(&mut cfg, "agy").max_budget_usd = None;
        validate_delegation(&cfg).unwrap_or_else(|e| panic!("{runner}: {e}"));
    }
}

#[test]
fn rechaza_un_runner_desconocido() {
    let mut cfg = default_cfg();
    engine_mut(&mut cfg, "agy").runner = "aider".into();
    assert!(errors_of(&cfg).contains("runner 'aider'"));
}

#[test]
fn rechaza_un_tier_que_empieza_en_un_motor_inexistente() {
    let mut cfg = default_cfg();
    cfg.tiers.get_mut("trivial").expect("trivial").start = "fantasma".into();
    assert!(errors_of(&cfg).contains("tiers.trivial.start = 'fantasma'"));
}

/// Caso negativo: un nivel que entra por un motor definido pero fuera de la
/// cadena se rechaza (delegate.mjs empezaría en silencio por chain[0]).
#[test]
fn rechaza_un_tier_que_empieza_fuera_de_la_cadena() {
    let mut cfg = default_cfg();
    let fuera = cfg.chain.pop().expect("chain no vacía");
    for t in cfg.tiers.values_mut() {
        t.start = cfg.chain[0].clone();
    }
    validate_delegation(&cfg).expect("todos los niveles en la cadena");
    cfg.tiers.get_mut("trivial").expect("trivial").start = fuera.clone();
    let err = errors_of(&cfg);
    assert!(
        err.contains(&format!("tiers.trivial.start = '{fuera}' no está en chain")),
        "{err}"
    );
}

/// Caso negativo (inyección por la línea de shell de delegate.mjs): el modelo
/// solo admite la lista blanca, también en tierModels.
#[test]
fn rechaza_modelos_con_metacaracteres_de_shell() {
    for bad in [
        "x\" & echo INJECTED & \"",
        "m%USERNAME%m",
        "$(id)",
        "a`b`",
        "con espacio",
    ] {
        let mut cfg = default_cfg();
        engine_mut(&mut cfg, "agy").model = bad.into();
        let err = errors_of(&cfg);
        assert!(err.contains("model '"), "{bad}");
        assert!(!err.contains("  "), "literal partido con espacios: {err}");
        let mut cfg = default_cfg();
        let mut tm = BTreeMap::new();
        tm.insert("trivial".to_string(), bad.to_string());
        engine_mut(&mut cfg, "agy").tier_models = Some(tm);
        assert!(errors_of(&cfg).contains("tierModels.trivial '"), "{bad}");
    }
    for ok in [
        "deepseek/deepseek-flash",
        "openrouter/x:free",
        "gpt-5.6-terra",
        "a@b+c_d",
    ] {
        let mut cfg = default_cfg();
        engine_mut(&mut cfg, "agy").model = ok.into();
        validate_delegation(&cfg).unwrap_or_else(|e| panic!("{ok}: {e}"));
    }
}

#[test]
fn rechaza_una_cadena_con_duplicados_o_ids_sin_motor() {
    let mut cfg = default_cfg();
    cfg.chain.push("codex".into());
    cfg.chain.push("nadie".into());
    let err = errors_of(&cfg);
    assert!(err.contains("chain repite 'codex'"), "{err}");
    assert!(err.contains("chain incluye 'nadie'"), "{err}");
}

#[test]
fn el_presupuesto_solo_vale_en_claude_y_debe_ser_positivo() {
    let mut cfg = default_cfg();
    engine_mut(&mut cfg, "codex").max_budget_usd = Some(1.0);
    assert!(errors_of(&cfg).contains("solo se aplica al runner claude"));

    let mut cfg = default_cfg();
    let e = engine_mut(&mut cfg, "agy");
    e.runner = "claude".into();
    e.max_budget_usd = Some(0.0);
    assert!(errors_of(&cfg).contains("mayor que 0"));
    engine_mut(&mut cfg, "agy").max_budget_usd = Some(2.5);
    validate_delegation(&cfg).expect("2,5 USD en runner claude es válido");
}

#[test]
fn rechaza_un_nivel_ausente_y_un_key_env_raro() {
    let mut cfg = default_cfg();
    cfg.tiers.remove("standard");
    engine_mut(&mut cfg, "codex").key_env = Some("rm -rf".into());
    let err = errors_of(&cfg);
    assert!(err.contains("falta el nivel 'standard'"), "{err}");
    assert!(err.contains("keyEnv 'rm -rf'"), "{err}");
}

/// `envMap` acepta destinos permitidos y rechaza cualquier otra variable
/// (caso negativo: no se puede usar para leer `PATH` o un secreto ajeno).
#[test]
fn env_map_solo_admite_variables_permitidas() {
    let mut cfg = default_cfg();
    let mut map = BTreeMap::new();
    map.insert("OPENAI_API_KEY".to_string(), "CEREBRAS_API_KEY".to_string());
    map.insert(
        "NVIDIA_API_KEY".to_string(),
        "ULTRON_KEY_MI_PROXY".to_string(),
    );
    engine_mut(&mut cfg, "agy").env_map = Some(map);
    validate_delegation(&cfg).expect("destinos permitidos");
    let v = serde_json::to_value(&cfg).expect("ser");
    assert_eq!(
        v["engines"]["agy"]["envMap"]["OPENAI_API_KEY"],
        "CEREBRAS_API_KEY"
    );

    let mut map = BTreeMap::new();
    map.insert("OPENAI_API_KEY".to_string(), "PATH".to_string());
    map.insert("bad name".to_string(), "GROQ_API_KEY".to_string());
    engine_mut(&mut cfg, "agy").env_map = Some(map);
    let err = errors_of(&cfg);
    assert!(err.contains("envMap.OPENAI_API_KEY = 'PATH'"), "{err}");
    assert!(err.contains("'bad name'"), "{err}");
}

/// Caso negativo: la clave de `envMap` (la variable que recibe el runner)
/// solo admite nombres de key de la lista blanca; `NODE_OPTIONS` o `PATH`
/// cambiarían cómo arranca el CLI aunque el origen sea una key permitida.
#[test]
fn env_map_rechaza_variables_de_runner_fuera_de_la_lista() {
    for runner_var in ["NODE_OPTIONS", "PATH", "OPENAI_BASE_URL"] {
        let mut cfg = default_cfg();
        let mut map = BTreeMap::new();
        map.insert(runner_var.to_string(), "GROQ_API_KEY".to_string());
        engine_mut(&mut cfg, "agy").env_map = Some(map);
        let err = errors_of(&cfg);
        assert!(
            err.contains(&format!("no permitida '{runner_var}'")),
            "{err}"
        );
        assert!(!err.contains("  "), "literal partido con espacios: {err}");
    }
}

/// Caso negativo: un modelo que empieza por '-' lo leería el CLI como una
/// opción (`--share` publica la sesión en OpenCode).
#[test]
fn rechaza_modelos_que_parecen_opciones() {
    for bad in ["--share", "-m", ".oculto", "/abs"] {
        let mut cfg = default_cfg();
        engine_mut(&mut cfg, "agy").model = bad.into();
        assert!(errors_of(&cfg).contains(&format!("model '{bad}'")), "{bad}");
    }
    assert!(is_safe_model(&"a".repeat(200)));
    assert!(!is_safe_model(&"a".repeat(201)));
}

/// Un campo que esta versión no conoce se conserva al guardar.
#[test]
fn conserva_los_campos_desconocidos() {
    let mut v = serde_json::to_value(default_cfg()).expect("ser");
    v["futuro"] = serde_json::json!(7);
    v["engines"]["agy"]["timeoutS"] = serde_json::json!(600);
    let cfg: DelegationConfig = serde_json::from_value(v.clone()).expect("parse");
    assert_eq!(serde_json::to_value(&cfg).expect("ser"), v);
}

/// Caso negativo: una configuración inválida no llega al disco.
#[test]
fn guardar_algo_invalido_no_toca_el_fichero() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _g = TestRootGuard::new(dir.path());
    let mut cfg = default_cfg();
    save_delegation(&cfg).expect("save");
    cfg.chain.clear();
    assert!(save_delegation(&cfg).is_err());
    assert_eq!(load_delegation().expect("load"), default_cfg());
}
