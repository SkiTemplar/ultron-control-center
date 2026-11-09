use super::*;
use serde_json::json;

fn ask_reason(s: &Step) -> Option<&'static str> {
    match &s.gate {
        Gate::Ask { reason, .. } => Some(*reason),
        Gate::Pass => None,
    }
}

fn bash(cmd: &str, tainted: bool) -> Step {
    decide("Bash", &json!({"command": cmd}), tainted, "")
}

#[test]
fn los_comandos_destructivos_piden_confirmacion() {
    assert_eq!(
        ask_reason(&bash("rm -rf build", false)),
        Some("borrar ficheros")
    );
    assert_eq!(
        ask_reason(&bash("git -C repo push origin main", false)),
        Some("git push")
    );
    assert_eq!(
        ask_reason(&decide(
            "PowerShell",
            &json!({"command": "Stop-Process -Name x"}),
            false,
            ""
        )),
        Some("matar procesos")
    );
    // Troceado con comillas: el shell lo junta y el freno también.
    assert_eq!(
        ask_reason(&bash("r\"m\" -rf build", false)),
        Some("borrar ficheros")
    );
    // Caso negativo: leer, listar o añadir a un fichero no frena.
    assert_eq!(ask_reason(&bash("ls -la && git status", false)), None);
    assert_eq!(ask_reason(&bash("echo hola >> notas.txt", false)), None);
}

const OVERWRITE: &str = "sobrescribir o mover ficheros";

#[test]
fn sobrescribir_o_mover_por_shell_pide_confirmacion() {
    for cmd in [
        "Set-Content memoria.tex \"\"",
        "\"\" | Out-File memoria.tex",
        "echo hola > notas.txt",
        "git status 2> err.log",
        "mv a.txt b.txt",
        "cd x; Move-Item a.tex b.tex",
        "Copy-Item a b -Force",
        "cp -f a b",
        "copy /y a b",
        "New-Item x.tex -ItemType File -Force",
        "dd if=/dev/zero of=memoria.tex",
    ] {
        assert_eq!(ask_reason(&bash(cmd, false)), Some(OVERWRITE), "{cmd}");
    }
    // Caso negativo: añadir, descartar la salida o nombrarlo en un texto.
    for cmd in [
        "echo hola >> notas.txt",
        "git status 2>&1",
        "git status > $null",
        "git status 2>nul",
        "ls > /dev/null",
        "echo \"a > b\"",
        "Get-Content a | Out-File b -Append",
        "Add-Content notas.txt hola",
        "cp a b",
        "echo mover ficheros",
    ] {
        assert_eq!(ask_reason(&bash(cmd, false)), None, "{cmd}");
    }
}

#[test]
fn el_puente_local_y_los_ficheros_de_su_token_piden_confirmacion() {
    for cmd in [
        "curl -s -H \"X-Ultron-Token: T\" -d '{\"action\":\"type\"}' http://127.0.0.1:5000/v1/action",
        "iwr http://localhost:5000/v1/action",
        "curl http://[::1]:5000/x",
        "curl http://127.1:5000/x",
        "curl http://2130706433:5000/x",
        "c\"ur\"l http://127.0.0.\"1\":5000/v1/act\"ion\"",
        "CURL HTTP://LOCALHOST:5000",
        "cat ~/.ultron/cockpit/mascot-bridge.json",
        "cat ~/.ultron/cockpit/mascot-\"bri\"dge.json",
        "cat ~/.ultron/cockpit/*.json",
        "type %TEMP%\\ultron-pupus\\chat-settings.json",
    ] {
        assert_eq!(
            ask_reason(&bash(cmd, false)),
            Some(patterns::BRIDGE),
            "{cmd}"
        );
    }
    for cmd in [
        "Invoke-RestMethod -Uri http://127.0.0.1:5000/v1/action -Method Post",
        "Get-Content $env:USERPROFILE\\.ultron\\cockpit\\mascot-bridge.json",
        "Get-Content ~/.ultron/cockpit/mascot`-bridge.json",
        "gc ~\\.ultron\\cockpit\\mascot-b*.json",
    ] {
        let ps = decide("PowerShell", &json!({ "command": cmd }), false, "");
        assert_eq!(ask_reason(&ps), Some(patterns::BRIDGE), "{cmd}");
    }
    // Teclearlo en una terminal y pulsar Enter, igual.
    let enter = decide(
        "mcp__ultron-desktop__press_keys",
        &json!({"combo": "enter"}),
        false,
        "curl http://127.0.0.1:5000/v1/action",
    );
    assert_eq!(ask_reason(&enter), Some(patterns::BRIDGE));
    // Leerlos con Read o Grep, aunque estén preaprobadas.
    let read = decide(
        "Read",
        &json!({"file_path": "C:\\Users\\u\\.ultron\\cockpit\\mascot-bridge.json"}),
        false,
        "",
    );
    assert_eq!(ask_reason(&read), Some(patterns::BRIDGE));
    let grep = decide(
        "Grep",
        &json!({"pattern": "token", "path": "C:/Users/u/AppData/Local/Temp/ultron-pupus"}),
        false,
        "",
    );
    assert_eq!(ask_reason(&grep), Some(patterns::BRIDGE));
    // Buscar dentro de las carpetas que guardan el token, entero.
    let grep_dir = decide(
        "Grep",
        &json!({"pattern": "token", "path": "C:\\Users\\u\\.ultron\\cockpit"}),
        false,
        "",
    );
    assert_eq!(ask_reason(&grep_dir), Some(patterns::BRIDGE));
    for cmd in [
        "grep -r token ~/.ultron",
        "Select-String token -Path $env:TEMP -Recurse",
    ] {
        assert_eq!(
            ask_reason(&bash(cmd, false)),
            Some(patterns::BRIDGE),
            "{cmd}"
        );
    }
    // Caso negativo: la red de fuera y los ficheros normales no son el puente.
    assert_eq!(
        ask_reason(&bash("curl -s https://example.com", false)),
        None
    );
    assert_eq!(
        ask_reason(&bash("cat ~/.ultron/cockpit/projects.json", false)),
        None
    );
    assert_eq!(
        ask_reason(&bash("cd ~/.ultron/control-center && git status", false)),
        None
    );
    let normal = decide(
        "Read",
        &json!({"file_path": "C:/Users/u/notas.md"}),
        false,
        "",
    );
    assert_eq!(normal.gate, Gate::Pass);
}

#[test]
fn los_comandos_de_red_contaminan_el_turno_como_webfetch() {
    let net = [
        "curl -s https://example.com",
        "wget https://x.y/z",
        "iwr https://x.y",
        "irm https://x.y",
        "Invoke-WebRequest -Uri https://x.y",
        "Invoke-RestMethod https://x.y",
        "c\"ur\"l https://x.y",
        "CURL https://x.y",
        "I`nvoke-WebRequest https://x.y",
        "In\"voke-Rest\"Method https://x.y",
        "^c^u^r^l https://x.y",
        "c\\url https://x.y",
        "/usr/bin/curl https://x.y",
        "(New-Object Net.WebClient).DownloadString('https://x.y')",
    ];
    for cmd in net {
        assert!(bash(cmd, false).taints, "{cmd}");
        let ps = decide("PowerShell", &json!({ "command": cmd }), false, "");
        assert!(ps.taints, "PowerShell {cmd}");
    }
    let typed = decide(
        "mcp__ultron-desktop__press_keys",
        &json!({"combo": "enter"}),
        false,
        "iwr https://x.y",
    );
    assert!(typed.taints, "teclear iwr y Enter también trae la web");
    // Caso negativo: comandos sin red y palabras parecidas.
    for cmd in ["git status", "echo hola", "ls irmandade"] {
        assert!(!bash(cmd, false).taints, "{cmd}");
    }
    // No son red, aunque ahora marquen el turno por leer un fichero
    // (`los_comandos_que_leen_ficheros_marcan_el_turno`, tests_taint.rs).
    for cmd in ["cat curly.txt", "Get-Content notas.txt"] {
        assert!(!fetches_network(cmd), "{cmd}");
    }
    // Con el turno marcado, la escritura siguiente pregunta.
    let s = "sesion-red-gate";
    record(s, &bash("curl -s https://example.com", false), true);
    let (tainted, _) = snapshot(s);
    let w = decide("Write", &json!({"file_path": "C:/tmp/a.txt"}), tainted, "");
    assert_eq!(ask_reason(&w), Some(AFTER_WEB));
}

#[test]
fn ejecutar_scripts_pide_confirmacion_aunque_una_regla_allow_lo_permita() {
    for cmd in [
        "powershell -File x.ps1",
        "uv run script.py",
        "node build.js",
        "cd tmp && .\\instalar.bat",
        "& 'C:\\tmp\\x.ps1'",
        "\"C:\\Program Files\\App\\app.exe\" --x",
        "Start-Process notepad",
        "schtasks /create /tn x /tr y",
        "cmd /c \"python x.py\"",
    ] {
        assert_eq!(
            ask_reason(&bash(cmd, false)),
            Some("ejecutar un script o un programa"),
            "{cmd}"
        );
    }
    // Caso negativo: nombrar un script sin ejecutarlo no frena, ni una
    // palabra como «start» en medio de un texto.
    assert_eq!(ask_reason(&bash("cat build.py", false)), None);
    assert_eq!(ask_reason(&bash("echo vamos a start ahora", false)), None);
    assert_eq!(ask_reason(&bash("git log --oneline -5", false)), None);
}

#[test]
fn escribir_en_rutas_de_arranque_pide_confirmacion() {
    let startup =
        "C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.bat";
    let w = decide(
        "Write",
        &json!({"file_path": startup, "content": "x"}),
        false,
        "",
    );
    assert_eq!(
        ask_reason(&w),
        Some("escribir en una ruta de arranque o de configuración")
    );
    let profile = decide(
        "Edit",
        &json!({"file_path": "C:/Users/u/Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1"}),
        false,
        "",
    );
    assert!(ask_reason(&profile).is_some());
    assert!(ask_reason(&decide(
        "Write",
        &json!({"file_path": "~/.claude/settings.json"}),
        false,
        ""
    ))
    .is_some());
    // Por comando también.
    assert!(ask_reason(&bash("echo x >> ~/.bashrc", false)).is_some());
    // Caso negativo: un fichero normal pasa sin preguntar.
    let normal = decide(
        "Write",
        &json!({"file_path": "C:/Users/u/Desktop/notas.md"}),
        false,
        "",
    );
    assert_eq!(normal.gate, Gate::Pass);
}

#[test]
fn tras_leer_la_web_cualquier_accion_pregunta() {
    let fetch = decide("WebFetch", &json!({"url": "https://x"}), false, "");
    assert!(fetch.taints && fetch.gate == Gate::Pass);
    assert_eq!(ask_reason(&bash("echo hola", true)), Some(AFTER_WEB));
    let w = decide("Write", &json!({"file_path": "C:/tmp/a.txt"}), true, "");
    assert_eq!(ask_reason(&w), Some(AFTER_WEB));
    let click = decide(
        "mcp__ultron-desktop__click",
        &json!({"x": 1, "y": 2}),
        true,
        "",
    );
    assert_eq!(ask_reason(&click), Some(AFTER_WEB));
    // Mirar sigue libre; sin web, clicar también.
    assert_eq!(decide("Read", &json!({}), true, "").gate, Gate::Pass);
    assert_eq!(
        decide("mcp__ultron-desktop__screenshot", &json!({}), true, "").gate,
        Gate::Pass
    );
    assert_eq!(
        decide("mcp__ultron-desktop__click", &json!({"x": 1}), false, "").gate,
        Gate::Pass
    );
}

#[test]
fn el_teclado_del_mcp_pasa_por_los_patrones_aunque_se_trocee() {
    let t = decide(
        "mcp__ultron-desktop__type_text",
        &json!({"text": "rm -rf C:\\x"}),
        false,
        "",
    );
    assert_eq!(ask_reason(&t), Some("borrar ficheros"));
    // Troceado: «r» y luego «m -rf x»; el Enter lo ve entero.
    let a = decide(
        "mcp__ultron-desktop__type_text",
        &json!({"text": "r"}),
        false,
        "",
    );
    assert_eq!(a.gate, Gate::Pass);
    let typed = a.typed.unwrap();
    let b = decide(
        "mcp__ultron-desktop__type_text",
        &json!({"text": "m -rf x"}),
        false,
        &typed,
    );
    assert_eq!(ask_reason(&b), Some("borrar ficheros"));
    let enter = decide(
        "mcp__ultron-desktop__press_keys",
        &json!({"combo": "enter"}),
        false,
        "powershell -File x.ps1",
    );
    assert_eq!(ask_reason(&enter), Some("ejecutar un script o un programa"));
    assert_eq!(enter.typed.as_deref(), Some(""));
    // Caso negativo: teclar el nombre de una app y pulsar Enter no frena.
    let app = decide(
        "mcp__ultron-desktop__type_text",
        &json!({"text": "spotify"}),
        false,
        "",
    );
    assert_eq!(app.gate, Gate::Pass);
    let go = decide(
        "mcp__ultron-desktop__press_keys",
        &json!({"combo": "enter"}),
        false,
        "spotify",
    );
    assert_eq!(go.gate, Gate::Pass);
    assert_eq!(
        decide(
            "mcp__ultron-desktop__press_keys",
            &json!({"combo": "win"}),
            false,
            ""
        )
        .gate,
        Gate::Pass
    );
}

#[test]
fn herramientas_desconocidas_o_de_terceros_preguntan() {
    let gh = decide(
        "mcp__github__create_issue",
        &json!({"title": "x"}),
        false,
        "",
    );
    assert_eq!(ask_reason(&gh), Some("herramienta externa"));
    assert!(ask_reason(&decide("CronCreate", &json!({}), false, "")).is_some());
    // Caso negativo: las internas que no actúan pasan.
    for t in ["ToolSearch", "TodoWrite", "Glob", "Agent"] {
        assert_eq!(decide(t, &json!({}), false, "").gate, Gate::Pass, "{t}");
    }
}

#[test]
fn el_estado_del_turno_recuerda_la_web_y_lo_tecleado() {
    let s = "sesion-de-prueba-gate";
    record(s, &decide("WebSearch", &json!({}), false, ""), true);
    let typed = decide(
        "mcp__ultron-desktop__type_text",
        &json!({"text": "abc"}),
        false,
        "",
    );
    record(s, &typed, true);
    assert_eq!(snapshot(s), (true, "abc".to_string()));
    // Caso negativo: lo denegado no se acumula como tecleado.
    let denied = decide(
        "mcp__ultron-desktop__type_text",
        &json!({"text": "zzz"}),
        false,
        "abc",
    );
    record(s, &denied, false);
    assert_eq!(snapshot(s).1, "abc");
    assert_eq!(snapshot("otra-sesion"), (false, String::new()));
}
