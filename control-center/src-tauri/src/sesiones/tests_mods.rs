// sesiones/tests_mods.rs — Tests de la lista de mods.
// Todo en directorios temporales: nunca se toca el settings.json real.

use super::*;

const SEP_S: &str = if cfg!(windows) { ";" } else { ":" };

const REGISTER: &str = r#"
export default async function (on) {
  on('session.start', async ($) => {
    await $.command.register({
      name: 'git',
      description: 'Estado de git: rama, cambios y \'último\' commit',
      argumentHint: '[ruta]',
      immediate: true,
    })
  })
  on('command.run', { command: 'git' }, async ($) => ({ text: 'ok' }))
  on('command.run', { command: 'git-log' }, async ($) => ({ text: 'ok' }))
}
"#;

struct Fixture {
    _dir: tempfile::TempDir,
    home: PathBuf,
    mods: PathBuf,
    settings: PathBuf,
}

fn plugin(mods: &Path, name: &str, hooks: Option<&str>) {
    let d = mods.join(name);
    std::fs::create_dir_all(d.join(".claude-plugin")).expect("plugin dir");
    let manifest = format!(r#"{{"name":"{name}","version":"0.1.0","description":"Mod {name}"}}"#);
    std::fs::write(d.join(".claude-plugin/plugin.json"), manifest).expect("plugin.json");
    if let Some(src) = hooks {
        std::fs::create_dir_all(d.join("hooks")).expect("hooks");
        std::fs::write(d.join("hooks/register.tsx"), src).expect("register");
        std::fs::write(
            d.join("hooks/register.test.ts"),
            "on('command.run', { command: 'nope' })",
        )
        .expect("test");
    }
}

fn settings_text() -> String {
    format!(
        "{{\n  \"env\": {{\n    \"OTRA\": \"1\",\n    \"{PLUGIN_DIRS_KEY}\": \"~/.ultron/mods/ultron-puente{SEP_S}~/.ultron/mods/ultron-git\"\n  }},\n  \"zeta\": true,\n  \"alfa\": [1, 2]\n}}\n"
    )
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().expect("tempdir");
    let home = dir.path().to_path_buf();
    let mods = home.join(".ultron").join("mods");
    plugin(&mods, "ultron-puente", None);
    plugin(&mods, "ultron-git", Some(REGISTER));
    plugin(&mods, "ultron-uso", None);
    std::fs::create_dir_all(mods.join("sin-manifiesto")).expect("otro");
    let settings = home.join(".claude").join("settings.json");
    std::fs::create_dir_all(settings.parent().expect("padre")).expect("claude");
    std::fs::write(&settings, settings_text()).expect("settings");
    Fixture {
        _dir: dir,
        home,
        mods,
        settings,
    }
}

#[test]
fn los_plugins_activos_salen_del_settings_con_la_ruta_expandida() {
    let f = fixture();
    let settings = crate::sesiones::ajustes::read_json(&f.settings);
    let activos = enabled_plugin_dirs(&settings, &f.home);
    assert_eq!(activos.len(), 2);
    assert!(activos.contains(&f.mods.join("ultron-git")));
    assert!(activos.contains(&f.mods.join("ultron-puente")));
    assert!(
        !activos.contains(&f.mods.join("ultron-uso")),
        "no está en el settings"
    );
}

#[test]
fn los_comandos_toman_la_descripcion_del_registro() {
    let f = fixture();
    let c = mod_commands(&f.mods.join("ultron-git"));
    assert_eq!(c.len(), 2, "el .test.ts no cuenta");
    assert_eq!(
        c[0].description.as_deref(),
        Some("Estado de git: rama, cambios y 'último' commit")
    );
    assert_eq!(c[0].arg_hint.as_deref(), Some("[ruta]"));
    assert_eq!(c[1].description, None);
}
