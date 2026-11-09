// Mascota — reconocer un comando de build o de tests y resumir su fallo
// (funciones puras, con tests). Lo usa transcripts.rs sobre los comandos
// Bash/PowerShell que lanza Claude Code.
//
// Heurística por tokens: el comando se parte por &&, ||, ;, | y saltos de
// línea, y en cada trozo la PRIMERA palabra (sin ruta ni .exe) tiene que
// ser la herramienta. Así «echo cargo build» o «grep tsc x» no cuentan.
// Pueden escaparse scripts propios (make.ps1, build.sh); la lista se amplía
// aquí y en los tests.

/// Longitud máxima del resumen de un fallo.
pub const SUMMARY_MAX: usize = 90;

/// Nombre de la herramienta sin ruta, comillas ni extensión, en minúsculas.
fn tool_name(token: &str) -> String {
    let t = token.trim_matches(|c| c == '"' || c == '\'');
    let base = t.rsplit(['\\', '/']).next().unwrap_or(t).to_lowercase();
    for ext in [".exe", ".cmd", ".bat", ".ps1"] {
        if let Some(stem) = base.strip_suffix(ext) {
            return stem.to_string();
        }
    }
    base
}

/// Palabras de un trozo, saltando asignaciones `VAR=valor` y el operador
/// de llamada de PowerShell.
fn words(segment: &str) -> Vec<String> {
    segment
        .split_whitespace()
        .map(|w| w.trim_matches(|c| c == '"' || c == '\''))
        .skip_while(|w| w.contains('=') && !w.starts_with('-'))
        .filter(|w| !w.is_empty() && !w.starts_with('+'))
        .map(str::to_string)
        .collect()
}

fn script_kind(args: &[&str]) -> Option<&'static str> {
    let (first, rest) = args.split_first()?;
    let script = if *first == "run" {
        rest.first().copied()?
    } else {
        first
    };
    if script.starts_with("build") {
        Some("npm run build")
    } else if script.starts_with("test") {
        Some("npm test")
    } else if script == "typecheck" || script == "tsc" {
        Some("tsc")
    } else {
        None
    }
}

fn segment_kind(segment: &str) -> Option<&'static str> {
    let w = words(segment);
    let tool = tool_name(w.first()?);
    let args: Vec<&str> = w[1..].iter().map(String::as_str).collect();
    let sub = args.first().copied().unwrap_or("");
    match tool.as_str() {
        "cargo" => match sub {
            "build" | "b" => Some("cargo build"),
            "check" | "c" => Some("cargo check"),
            "test" | "t" | "nextest" => Some("cargo test"),
            "clippy" => Some("cargo clippy"),
            _ => None,
        },
        "npm" | "pnpm" | "yarn" | "bun" => script_kind(&args),
        "npx" | "pnpx" => match tool_name(sub).as_str() {
            "tsc" | "vue-tsc" => Some("tsc"),
            "vitest" | "jest" => Some("tests"),
            _ => None,
        },
        "tsc" | "vue-tsc" => Some("tsc"),
        "vitest" | "jest" | "pytest" => Some("tests"),
        "cmake" => Some("cmake"),
        "msbuild" => Some("msbuild"),
        "ninja" => Some("ninja"),
        "ctest" => Some("ctest"),
        "dotnet" if sub == "build" => Some("dotnet build"),
        "dotnet" if sub == "test" => Some("dotnet test"),
        "uv" if sub == "build" => Some("uv build"),
        "uv" if sub == "run" && args.get(1).is_some_and(|a| tool_name(a) == "pytest") => {
            Some("tests")
        }
        "go" if matches!(sub, "build" | "test" | "vet") => Some("go build"),
        "build" | "runuat" | "unrealbuildtool" => Some("UE build"),
        _ => None,
    }
}

/// Tipo de build o tests que lanza `cmd`, o None si no es ninguno.
pub fn build_kind(cmd: &str) -> Option<&'static str> {
    cmd.split(['&', '|', ';', '\n']).find_map(segment_kind)
}

/// Código de salida de un tool_result de Claude Code («Exit code N»).
pub fn exit_code(content: &str) -> Option<i32> {
    let line = content.trim_start().lines().next()?;
    line.strip_prefix("Exit code ")?.trim().parse().ok()
}

/// Quita las secuencias ANSI (colores) de una línea.
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            for n in chars.by_ref() {
                if n.is_ascii_alphabetic() {
                    break;
                }
            }
        }
    }
    out
}

/// Recorta a `SUMMARY_MAX` caracteres con «…».
pub fn truncate(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max {
        return t.to_string();
    }
    let cut: String = t.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

/// «src/a/b.tsx(12,5): error TS2322: …» → «b.tsx(12,5): error TS2322: …».
fn short_path(line: &str) -> String {
    let Some(paren) = line.find('(') else {
        return line.to_string();
    };
    let (path, rest) = line.split_at(paren);
    let base = path.rsplit(['\\', '/']).next().unwrap_or(path);
    format!("{base}{rest}")
}

/// Un test que ha fallado, si la línea lo dice.
fn failed_test(line: &str) -> Option<String> {
    if let Some(rest) = line.strip_prefix("test ") {
        if let Some(name) = rest.strip_suffix("... FAILED") {
            return Some(name.trim().to_string());
        }
    }
    for prefix in ["FAIL ", "× ", "FAILED "] {
        if let Some(rest) = line.strip_prefix(prefix) {
            return Some(rest.trim().to_string());
        }
    }
    None
}

/// Un error de compilación, si la línea lo dice.
fn compile_error(line: &str) -> Option<String> {
    let generic = [
        "error: could not compile",
        "error: aborting",
        "error: test failed",
    ];
    if generic.iter().any(|g| line.starts_with(g)) {
        return None;
    }
    if line.starts_with("error[E") || line.starts_with("error:") {
        return Some(line.to_string());
    }
    let markers = [
        ": error TS",
        ": error C",
        ": fatal error C",
        "error LNK",
        ": error MSB",
    ];
    if markers.iter().any(|m| line.contains(m)) {
        return Some(short_path(line));
    }
    None
}

/// Resumen breve de un fallo: el primer test caído o el primer error de
/// compilación; si nada encaja, «exit N».
pub fn summarize_failure(output: &str, code: i32) -> String {
    let lines: Vec<String> = output
        .lines()
        .map(|l| strip_ansi(l).trim().to_string())
        .collect();
    let found = lines
        .iter()
        .find_map(|l| failed_test(l))
        .or_else(|| lines.iter().find_map(|l| compile_error(l)));
    truncate(
        &found.unwrap_or_else(|| format!("exit {code}")),
        SUMMARY_MAX,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconoce_las_herramientas_de_build_y_tests() {
        let cases = [
            ("cargo build --release", "cargo build"),
            (
                "cd control-center/src-tauri && cargo check 2>&1 | tail -5",
                "cargo check",
            ),
            ("cargo +nightly test --lib mascot::", "cargo test"),
            ("cargo clippy -- -D warnings", "cargo clippy"),
            ("npm run build:local", "npm run build"),
            ("pnpm test", "npm test"),
            ("npx tsc --noEmit -p .", "tsc"),
            ("npx vitest run --silent src/x", "tests"),
            ("cmake --build build --config Release", "cmake"),
            ("\"C:\\VS\\MSBuild.exe\" app.sln", "msbuild"),
            ("ninja -C out", "ninja"),
            ("dotnet test", "dotnet test"),
            ("uv run pytest -q", "tests"),
            ("uv build", "uv build"),
            ("go test ./...", "go build"),
            (
                "& \"D:\\UE\\Engine\\Build\\BatchFiles\\Build.bat\" Game Win64",
                "UE build",
            ),
            ("RUST_LOG=debug cargo test", "cargo test"),
        ];
        for (cmd, kind) in cases {
            assert_eq!(build_kind(cmd), Some(kind), "{cmd}");
        }
    }

    #[test]
    fn no_confunde_comandos_que_solo_mencionan_la_herramienta() {
        for cmd in [
            "git status",
            "echo cargo build",
            "cat Cargo.toml",
            "grep tsc x",
            "cargo fmt",
            "npm install",
            "uv run python script.py",
            "",
        ] {
            assert_eq!(build_kind(cmd), None, "{cmd}");
        }
    }

    #[test]
    fn lee_el_codigo_de_salida() {
        assert_eq!(exit_code("Exit code 101\nerror"), Some(101));
        assert_eq!(exit_code("todo bien"), None);
    }

    #[test]
    fn resume_cada_formato_de_fallo() {
        let cargo = "   Compiling x\nerror[E0308]: mismatched types\n --> src/a.rs:3:5\nerror: could not compile `x`";
        assert_eq!(
            summarize_failure(cargo, 101),
            "error[E0308]: mismatched types"
        );
        let test = "running 3 tests\ntest cola::drena ... FAILED\nerror: test failed";
        assert_eq!(summarize_failure(test, 101), "cola::drena");
        let vitest = "\u{1b}[31m FAIL \u{1b}[39m src/a.test.ts > grupo > caso\n";
        assert_eq!(summarize_failure(vitest, 1), "src/a.test.ts > grupo > caso");
        let tsc = "src/components/x/App.tsx(12,5): error TS2322: Type 'a' is not assignable";
        assert_eq!(
            summarize_failure(tsc, 2),
            "App.tsx(12,5): error TS2322: Type 'a' is not assignable"
        );
        let msvc = "C:\\p\\main.cpp(4): error C2065: 'x': undeclared identifier";
        assert_eq!(
            summarize_failure(msvc, 1),
            "main.cpp(4): error C2065: 'x': undeclared identifier"
        );
        assert_eq!(summarize_failure("nada reconocible", 3), "exit 3");
    }

    #[test]
    fn el_resumen_se_trunca() {
        let long = format!("error: {}", "á".repeat(200));
        let s = summarize_failure(&long, 1);
        assert_eq!(s.chars().count(), SUMMARY_MAX);
        assert!(s.ends_with('…'));
    }
}
