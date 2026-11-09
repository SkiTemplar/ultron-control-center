// sesiones/tests_catalogo.rs — Tests de la paleta de comandos con fixtures
// de mods, skills y comandos en un directorio temporal.

use super::*;

fn write(p: &Path, body: &str) {
    std::fs::create_dir_all(p.parent().expect("padre")).expect("dir");
    std::fs::write(p, body).expect("fichero");
}

struct Fx {
    _dir: tempfile::TempDir,
    home: PathBuf,
    cwd: PathBuf,
    plugins: Vec<PathBuf>,
}

fn fixture() -> Fx {
    let dir = tempfile::tempdir().expect("tempdir");
    let home = dir.path().join("home");
    let cwd = dir.path().join("proyecto");
    let skills = home.join(".claude/skills");
    write(
        &skills.join("pdf/SKILL.md"),
        "---\nname: pdf\ndescription: Trabaja con PDF\n---\n# PDF\n",
    );
    write(
        &skills.join("_disabled/oculta/SKILL.md"),
        "---\nname: oculta\ndescription: no carga\n---\n",
    );
    write(&skills.join("sin-skill/README.md"), "nada");
    write(
        &home.join(".claude/commands/revisar.md"),
        "---\ndescription: \"Revisa el diff\"\nargument-hint: <rama>\n---\ncuerpo",
    );
    write(
        &cwd.join(".claude/commands/ci/probar.md"),
        "sin frontmatter",
    );
    let m = home.join(".ultron/mods/ultron-mejorar");
    write(
        &m.join("hooks/register.tsx"),
        "await $.command.register({ name: 'mejorar', description: 'Mejora el prompt' })\n\
         on('command.run', { command: 'mejorar' }, async () => ({}))",
    );
    Fx {
        _dir: dir,
        home,
        cwd,
        plugins: vec![m],
    }
}

fn find<'a>(v: &'a [CommandDef], name: &str) -> Option<&'a CommandDef> {
    v.iter().find(|c| c.name == name)
}

#[test]
fn reune_integrados_mods_skills_y_comandos() {
    let f = fixture();
    let c = catalog_in(&f.home, &f.cwd, &f.plugins);
    assert_eq!(
        find(&c, "compact").map(|d| d.source.as_str()),
        Some("builtin")
    );
    let m = find(&c, "mejorar").expect("comando del mod");
    assert_eq!(
        (m.source.as_str(), m.origin.as_deref()),
        ("mod", Some("ultron-mejorar"))
    );
    assert_eq!(m.description, "Mejora el prompt");
    let s = find(&c, "pdf").expect("skill");
    assert_eq!(
        (s.source.as_str(), s.description.as_str()),
        ("skill", "Trabaja con PDF")
    );
    let u = find(&c, "revisar").expect("comando de usuario");
    assert_eq!(u.source, "user");
    assert_eq!(u.description, "Revisa el diff");
    assert_eq!(u.arg_hint.as_deref(), Some("<rama>"));
    assert_eq!(
        find(&c, "ci:probar").map(|d| d.source.as_str()),
        Some("project")
    );
}

#[test]
fn excluye_skills_desactivadas_y_mods_inactivos() {
    let f = fixture();
    let c = catalog_in(&f.home, &f.cwd, &[]);
    assert!(find(&c, "oculta").is_none(), "las de _disabled no cargan");
    assert!(find(&c, "sin-skill").is_none(), "sin SKILL.md no es skill");
    assert!(find(&c, "mejorar").is_none(), "mod no activo");
}

#[test]
fn el_sello_cambia_al_anadir_un_comando() {
    let f = fixture();
    let a = stamp(&source_files(&f.home, &f.cwd, &f.plugins));
    write(&f.cwd.join(".claude/commands/nuevo.md"), "x");
    let b = stamp(&source_files(&f.home, &f.cwd, &f.plugins));
    assert_ne!(a, b);
}

#[test]
fn frontmatter_simple() {
    let fm = frontmatter("---\nname: x\ndescription: >\n  muy\n  largo\nkind: 'skill'\n---\n");
    assert_eq!(fm.get("name").map(String::as_str), Some("x"));
    assert_eq!(fm.get("kind").map(String::as_str), Some("skill"));
    assert_eq!(fm.get("description").map(String::as_str), Some("muy largo"));
    assert!(frontmatter("sin frontmatter").is_empty());
}

#[test]
fn frontmatter_con_bom_y_crlf() {
    // Un SKILL.md guardado por PowerShell 5.1 o el Bloc de notas lleva BOM.
    let fm = frontmatter("\u{feff}---\r\nname: con-bom\r\ndescription: Desc\r\n---\r\n");
    assert_eq!(fm.get("name").map(String::as_str), Some("con-bom"));
    assert_eq!(fm.get("description").map(String::as_str), Some("Desc"));
}

#[test]
fn un_cwd_inexistente_es_error() {
    assert!(commands("").is_err());
    let d = tempfile::tempdir().expect("tempdir");
    assert!(commands(&d.path().join("nada").to_string_lossy()).is_err());
}

// -- Contrato de estabilidad (§2.3, §8.4) --

use crate::sesiones::types::CommandInfoLive;

const FIXTURE: &str = include_str!("fixtures/commands-2.1.293.json");

fn fixture_viva() -> Vec<CommandInfoLive> {
    let v: serde_json::Value = serde_json::from_str(FIXTURE).expect("fixture");
    serde_json::from_value(v["items"].clone()).expect("items")
}

#[test]
fn cada_integrado_de_la_lista_viva_tiene_metadatos() {
    let sin_meta: Vec<String> = fixture_viva()
        .into_iter()
        .filter(|i| i.source == "builtin")
        .filter(|i| meta::builtin(&i.name).is_none())
        .map(|i| i.name)
        .collect();
    assert!(
        sin_meta.is_empty(),
        "integrados sin clasificar: {sin_meta:?}"
    );
}

#[test]
fn cada_comando_de_mod_de_ultron_tiene_meta_con_su_immediate() {
    for i in fixture_viva().iter().filter(|i| {
        i.plugin
            .as_deref()
            .is_some_and(|p| p.starts_with("ultron-"))
    }) {
        let m = meta::de_mod(&i.name).unwrap_or_else(|| panic!("/{} sin MOD_META", i.name));
        assert_eq!(m.immediate, i.immediate.unwrap_or(false), "/{}", i.name);
        assert_eq!(m.plugin, i.plugin.as_deref(), "/{}", i.name);
    }
}

/// Comandos registrados por los mods (`$.command.register`), con
/// `ultron-atajos` leído de `ACTIONS` en `hooks/stack.ts`.
fn barrer_registros(mods: &Path) -> Vec<(String, String, bool)> {
    let re = regex::Regex::new(r"command\.register\(\s*\{([^}]*)\}").expect("regex");
    let acciones = regex::Regex::new(r"ACTIONS[^=]*=\s*\[([^\]]*)\]").expect("regex");
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(mods) else {
        return out;
    };
    for dir in rd.filter_map(Result::ok).map(|e| e.path()) {
        let plugin = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if !plugin.starts_with("ultron-") {
            continue;
        }
        for f in ["register.ts", "register.tsx"].map(|n| dir.join("hooks").join(n)) {
            let Ok(src) = std::fs::read_to_string(&f) else {
                continue;
            };
            for c in re.captures_iter(&src) {
                let bloque = c.get(1).map_or("", |m| m.as_str());
                let inm = bloque.contains("immediate: true");
                let nombres = match crate::sesiones::mods::string_field(bloque, "name") {
                    Some(n) => vec![n],
                    None => {
                        let stack = std::fs::read_to_string(dir.join("hooks").join("stack.ts"))
                            .unwrap_or_default();
                        acciones
                            .captures(&stack)
                            .and_then(|c| c.get(1))
                            .map(|m| {
                                m.as_str()
                                    .split(',')
                                    .map(|s| s.trim().trim_matches('\'').to_string())
                                    .filter(|s| !s.is_empty())
                                    .collect()
                            })
                            .unwrap_or_default()
                    }
                };
                out.extend(nombres.into_iter().map(|n| (plugin.clone(), n, inm)));
            }
        }
    }
    out
}

fn sin_clasificar(registros: &[(String, String, bool)]) -> Vec<String> {
    registros
        .iter()
        .filter(|(p, n, inm)| {
            meta::de_mod(n).is_none_or(|m| m.immediate != *inm || m.plugin != Some(p.as_str()))
        })
        .map(|(p, n, _)| format!("{p}:{n}"))
        .collect()
}

#[test]
fn barrido_estatico_de_los_register_de_los_mods() {
    let mods = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../mods");
    let r = barrer_registros(&mods);
    assert!(
        r.iter().any(|(_, n, _)| n == "compilar"),
        "ACTIONS de ultron-atajos"
    );
    assert!(r.len() >= 17, "registros leídos: {r:?}");
    assert!(
        sin_clasificar(&r).is_empty(),
        "sin MOD_META: {:?}",
        sin_clasificar(&r)
    );
}

#[test]
fn un_register_nuevo_sin_entrada_hace_fallar_el_barrido() {
    let d = tempfile::tempdir().expect("tempdir");
    write(
        &d.path().join("ultron-prueba/hooks/register.tsx"),
        "await $.command.register({ name: 'nuevo', description: 'x', immediate: true })",
    );
    let r = barrer_registros(d.path());
    assert_eq!(sin_clasificar(&r), vec!["ultron-prueba:nuevo".to_string()]);
}

#[test]
fn lista_viva_plugins_como_prompt_e_integrados_con_su_clase() {
    let defs = fusionar_viva(&fixture_viva());
    let rescue = find(&defs, "codex:rescue").expect("plugin del marketplace");
    assert_eq!(
        (rescue.kind, rescue.source.as_str()),
        (CommandKind::Prompt, "plugin")
    );
    for n in ["skills", "tasks", "config", "import"] {
        assert_eq!(
            find(&defs, n).map(|d| d.kind),
            Some(CommandKind::Menu),
            "/{n}"
        );
    }
    assert_eq!(find(&defs, "exit").map(|d| d.kind), Some(CommandKind::Exit));
    let git = find(&defs, "git").expect("mod");
    assert_eq!((git.source.as_str(), git.immediate), ("mod", true));
    let tui = find(&defs, "tui").expect("tui");
    assert!(tui.note.is_some(), "unsupported siempre con nota");
}

#[test]
fn resolver_con_y_sin_lista_viva() {
    let defs = fusionar_viva(&fixture_viva());
    let r = resolver("import", "--dry-run", &defs, true).expect("import");
    assert_eq!(r.kind, CommandKind::Local);
    assert_eq!(
        resolver("import", "", &defs, true).map(|r| r.kind),
        Ok(CommandKind::Menu)
    );
    assert_eq!(
        resolver("/settings", "", &defs, true).map(|r| r.nombre),
        Ok("config".into())
    );
    assert!(resolver("nada", "", &defs, true).is_err());
    let r = resolver("codex:rescue", "", &[], false).expect("sin lista viva");
    assert_eq!(
        (r.kind, r.note.as_deref()),
        (CommandKind::Prompt, Some(NOTA_NO_CATALOGADO))
    );
    assert_eq!(kind_por_nombre("cost"), CommandKind::Menu);
    assert_eq!(kind_por_nombre("skill-desconocida"), CommandKind::Prompt);
}

#[test]
fn el_catalogo_estatico_trae_los_comandos_en_bucle_de_atajos() {
    let f = fixture();
    let atajos = f.home.join(".ultron/mods/ultron-atajos");
    write(
        &atajos.join("hooks/register.ts"),
        "// registro en bucle desde ACTIONS",
    );
    let c = catalog_in(&f.home, &f.cwd, &[atajos]);
    let compilar = find(&c, "compilar").expect("de MOD_META");
    assert_eq!(
        (compilar.kind, compilar.immediate),
        (CommandKind::Local, true)
    );
    assert_eq!(find(&c, "clear").map(|d| d.aliases.len()), Some(2));
}
