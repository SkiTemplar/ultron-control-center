// Mascota — credenciales para el freno del chat de Pupus (chat_gate.rs).
//
// `hooks/scripts/deny-secrets.js` responde `ask` para `.env`, `~/.claude.json`,
// los registros de paquetes y los volcados de entorno, y `deny` para claves y
// tokens de CLI. En `claude -p` no hay terminal a quien preguntar: ese `ask`
// solo puede acabar en la puerta `approve_tool_use` del MCP de escritorio, que
// aprobaría `Read` como cualquier lectura. Por eso el freno reconoce estas
// rutas por su cuenta, también si `deny-secrets` no estuviera registrado.
//
// Misma clasificación, simplificada, que `classifySegments` de deny-secrets.js
// y que `isSecret` de tools/ultron-desktop-mcp/server.mjs; la paridad la
// comprueban el corpus compartido y server.test.mjs contra el hook real.
// ALCANCE REAL: lee el texto de la acción. `src\.env` dentro de un script no
// se ve; es un freno, no un sandbox.

use once_cell::sync::Lazy;
use regex::Regex;

use super::patterns::{reads_file, shell_joined};

pub(super) const SECRET: &str = "leer o tocar un secreto o una credencial";

const KEY_EXTS: [&str; 6] = ["pem", "pfx", "p12", "key", "keystore", "jks"];
const SSH_KEY_PREFIXES: [&str; 4] = ["id_rsa", "id_ed25519", "id_dsa", "id_ecdsa"];
const SECRET_NAMES: [&str; 9] = [
    "secrets.json",
    "credentials.json",
    ".secrets.json",
    ".credentials.json",
    ".git-credentials",
    ".netrc",
    "_netrc",
    ".npmrc",
    ".pypirc",
];
const SAFE_ENV_WORDS: [&str; 4] = ["example", "sample", "template", "dist"];
/// Lo que un comodín con punto delante (`.e*`, `.*`) puede seleccionar.
const GLOB_TARGETS: [&str; 5] = [
    ".env",
    ".claude.json",
    ".git-credentials",
    ".netrc",
    ".npmrc",
];

/// Volcados de variables de entorno, que llevan las keys en claro.
static ENV_DUMP: Lazy<Vec<Regex>> = Lazy::new(|| {
    const SECRET_VAR: &str = r"[a-z0-9_]*(?:key|token|secret|password|passwd|credential)[a-z0-9_]*";
    let re = |p: String| Regex::new(&p).expect("patrón de volcado válido");
    vec![
        re(format!(
            r"(?i)(?:^|[;&|(\n]\s*)(?:\S*[\\/])?printenv(?:\s+-\S+)*\s*(?:$|[;&|\n)])|printenv\s+{SECRET_VAR}"
        )),
        // Sin argumentos vuelcan el entorno; con una asignación (`export FOO=1`) no.
        re(
            r"(?i)(?:^|[;&|({\n]\s*)(?:(?:then|do|else|if|sudo|command|builtin)\s+)*(?:env|set|(?:export|declare|typeset)(?:\s+-[px]+)?)\s*(?:$|[;&|\n)>])"
                .to_string(),
        ),
        re(format!(
            r"(?i)(?:^|[;&|({{\n]\s*)set\s+{SECRET_VAR}\s*(?:$|[;&|\n)>])|\b(?:declare|typeset)\s+-[a-z]*p[a-z]*\s+{SECRET_VAR}"
        )),
        re(r"(?i)\b(?:gci|dir|ls|get-childitem|get-item)\s+(?:-path\s+)?env:".to_string()),
        re(
            r"(?i)/proc/[^/\s]+/environ\b|getenvironmentvariables\b|\bwin32_environment\b|\bwmic(?:\.exe)?\s+environment\b"
                .to_string(),
        ),
        // Con la barra doblada de Git Bash (`HKCU\\Environment`), y también `export`/`save` de `reg`.
        re(
            r"(?i)\bhk(?:cu|lm|ey_current_user|ey_local_machine):?[\\/]+(?:system[\\/]+currentcontrolset[\\/]+control[\\/]+session manager[\\/]+)?environment\b"
                .to_string(),
        ),
        re(
            r"(?i)\breg(?:\.exe)?\s+(?:query|export|save)\s+hk(?:cu|ey_current_user)[\\/]*(?:\s|$)"
                .to_string(),
        ),
        re(format!(r"(?i)\$(?:env:)?\{{?{SECRET_VAR}|%{SECRET_VAR}%")),
        re(
            r"(?i)(?:node|python\S*)\b[^\n;&|]*\s-[ecp]\w*\s[^\n]*(?:process\.env|os\.environ)"
                .to_string(),
        ),
    ]
});

/// `.env.example`, `.env-sample`, `example.env`: plantillas sin secreto.
fn is_safe_env(base: &str) -> bool {
    let stem = [".env", "-env", "_env"]
        .iter()
        .find_map(|s| base.strip_suffix(s))
        .unwrap_or(base);
    let last = stem.rsplit(['.', '-', '_']).next().unwrap_or(stem);
    SAFE_ENV_WORDS.contains(&last)
}

/// `loose`: palabra suelta de un comando sin verbo que lea ficheros; ahí
/// `process.env` es código, no un fichero.
fn is_dotenv(base: &str, loose: bool) -> bool {
    let named = base == ".env"
        || base == ".envrc"
        || [".env.", ".env-", ".env_", ".env*", ".env?"]
            .iter()
            .any(|p| base.starts_with(p))
        || (base.starts_with('*') && base.trim_start_matches('*') == ".env");
    let code = matches!(base, "process.env" | "import.meta.env");
    let suffixed = !loose && !code && base.ends_with(".env");
    (named || suffixed) && !is_safe_env(base)
}

/// Comodín simple (`*` y `?`), en minúsculas por quien llama.
fn wild(pattern: &[u8], name: &[u8]) -> bool {
    match (pattern.first(), name.first()) {
        (None, None) => true,
        (Some(b'*'), _) => {
            wild(&pattern[1..], name) || (!name.is_empty() && wild(pattern, &name[1..]))
        }
        (Some(b'?'), Some(_)) => wild(&pattern[1..], &name[1..]),
        (Some(a), Some(b)) if a == b => wild(&pattern[1..], &name[1..]),
        _ => false,
    }
}

fn glob_reaches_secret(base: &str) -> bool {
    base.starts_with('.')
        && base.contains(['*', '?'])
        && GLOB_TARGETS
            .iter()
            .any(|t| wild(base.as_bytes(), t.as_bytes()))
}

fn is_cli_token(parent: &str, base: &str) -> bool {
    matches!(
        (parent, base),
        (".codex", "auth.json")
            | (".gemini", "oauth_creds.json")
            | (".aws", "credentials")
            | ("gh", "hosts.yml")
            | ("github cli", "hosts.yml")
    )
}

fn secret_segments(segs: &[&str], loose: bool) -> bool {
    let Some((last, dirs)) = segs.split_last() else {
        return false;
    };
    // `.env::$DATA` lee lo mismo que `.env` (flujo NTFS).
    let base = last.split(':').next().unwrap_or(last);
    let parent = dirs.last().copied().unwrap_or("");
    let ext = base.rsplit_once('.').map_or("", |(_, e)| e);
    is_dotenv(base, loose)
        || (!loose && KEY_EXTS.contains(&ext))
        || SSH_KEY_PREFIXES.iter().any(|p| base.starts_with(p))
        || base == ".ssh"
        || dirs.contains(&".ssh")
        || SECRET_NAMES.contains(&base)
        || (base.starts_with("service-account") && base.ends_with(".json"))
        || is_cli_token(parent, base)
        || base == ".claude.json"
        || base.starts_with(".claude.json.")
        || glob_reaches_secret(base)
}

fn split_path(path: &str) -> Vec<String> {
    path.replace('\\', "/")
        .to_lowercase()
        .split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// Segmentos sin `.` y con cada `..` resuelto: `.codex/./auth.json` es `.codex/auth.json`.
fn resolve_dots<'a>(segs: &[&'a str]) -> Vec<&'a str> {
    let mut out: Vec<&'a str> = Vec::with_capacity(segs.len());
    for &s in segs {
        match s {
            "." => {}
            ".." if out.last().is_some_and(|l| *l != "..") => {
                out.pop();
            }
            _ => out.push(s),
        }
    }
    out
}

/// La forma literal y la resuelta: `.ssh/../x` nombra el directorio aunque no se
/// quede en él.
fn secret_in_any_form(segs: &[String], loose: bool) -> bool {
    let refs: Vec<&str> = segs.iter().map(String::as_str).collect();
    secret_segments(&refs, loose) || secret_segments(&resolve_dots(&refs), loose)
}

/// Un campo que nombra una ruta entera (`file_path`, `path`, `glob`…).
pub(super) fn secret_path(path: &str) -> bool {
    secret_in_any_form(&split_path(path), false)
}

fn secret_word(word: &str, reader: bool) -> bool {
    if word.contains("://") {
        return false;
    }
    let segs = split_path(word);
    secret_in_any_form(&segs, segs.len() < 2 && !reader)
}

/// `cd ~/.codex && cat auth.json`, también tras lo que abre un bloque
/// (`(cd d && …)`, `{ cd d; … }`, `if cd d; then …`) o con `&`. Solo se resuelve
/// contra directorios con secretos, como `lib/secret-cwd.js` del hook.
static CD_SEGMENT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"^(?:[\s({!]|(?:\w+=)?\$|(?:if|then|elif|else|do|while|until|time|command|builtin)\s)*(?:cd|chdir|pushd|set-location|sl|push-location)(?:\s+(?:-\w+|/d))*(?:\s+(.+))?$",
    )
    .expect("patrón de cd válido")
});
static CD_REDIRECT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\s*\d*[<>].*$").expect("patrón de redirección válido"));
const SENSITIVE_DIRS: [&str; 6] = [".ssh", ".aws", ".codex", ".gemini", "gh", "github cli"];
const MAX_DIR_CHARS: usize = 1024;

/// Directorio tras un `cd`, con el `..` resuelto. Vacío si no se puede saber (`cd -`).
fn next_dir(dir: &str, args: &str) -> String {
    let no_redirect = CD_REDIRECT.replace(args, "");
    let to = no_redirect.trim_end_matches([')', '}', ' ', '\t']).trim();
    if to.is_empty() {
        return "~".to_string();
    }
    if to == "-" {
        return String::new();
    }
    let absolute = to.starts_with(['/', '~', '$', '%']) || to.as_bytes().get(1) == Some(&b':');
    let joined = if absolute || dir.is_empty() {
        to.to_string()
    } else {
        format!("{dir}/{to}")
    };
    let segs = split_path(&joined);
    let refs: Vec<&str> = segs.iter().map(String::as_str).collect();
    let next = resolve_dots(&refs).join("/");
    if next.len() > MAX_DIR_CHARS {
        String::new()
    } else {
        next
    }
}

/// `joined` es la línea de `shell_joined`: sin comillas, en minúsculas y con `/`.
fn reads_secret_after_cd(joined: &str) -> bool {
    let mut dir = String::new();
    for raw in joined.split(['\n', ';', '&', '|']) {
        let seg = raw.trim();
        if let Some(cd) = CD_SEGMENT.captures(seg) {
            dir = next_dir(&dir, cd.get(1).map_or("", |m| m.as_str()));
            continue;
        }
        if !dir.split('/').any(|s| SENSITIVE_DIRS.contains(&s)) {
            continue;
        }
        // `< f cat`: la primera palabra es el fichero redirigido, no el verbo.
        let skip = usize::from(!seg.starts_with('<'));
        let mut words = seg
            .split(|c: char| c.is_whitespace() || "<>=,(){}".contains(c))
            .filter(|w| !w.is_empty())
            .skip(skip);
        if words.any(|w| !w.starts_with('-') && secret_path(&format!("{dir}/{w}"))) {
            return true;
        }
    }
    false
}

/// Un comando o lo tecleado que nombra una credencial o vuelca el entorno.
pub(super) fn touches_secret(command: &str) -> bool {
    let joined = shell_joined(command, false);
    if ENV_DUMP
        .iter()
        .any(|r| r.is_match(command) || r.is_match(&joined))
    {
        return true;
    }
    if reads_secret_after_cd(&joined) {
        return true;
    }
    let reader = reads_file(command) || reads_file(&joined);
    joined
        .split(|c: char| c.is_whitespace() || ";|&<>=,(){}".contains(c))
        .any(|w| secret_word(w, reader))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn las_rutas_de_credenciales_se_reconocen() {
        for p in [
            ".env",
            "C:\\Users\\u\\.ultron\\.env",
            "~/.ultron/.env.local",
            ".envrc",
            "prod.env",
            "**/.env*",
            "*.env",
            ".e*",
            "~/.claude.json",
            "~/.claude.json.backup",
            "~/.ssh/config",
            "~/.ssh",
            "id_ed25519",
            "server.key",
            "**/*.pem",
            "~/.aws/credentials",
            "secrets.json",
            "service-account-prod.json",
            "~/.git-credentials",
            "~/.npmrc",
            "~/.codex/auth.json",
            "C:\\Users\\u\\.gemini\\oauth_creds.json",
            "~/.config/gh/hosts.yml",
            ".env::$DATA",
            // Rutas sin normalizar (revisión final 2026-11-02, H1).
            "C:/Users/u/.codex/./auth.json",
            "~/.config/gh/./hosts.yml",
            ".gemini\\x\\..\\oauth_creds.json",
            ".codex/auth.json/.",
        ] {
            assert!(secret_path(p), "{p}");
        }
        // Caso negativo: plantillas y ficheros corrientes.
        for p in [
            ".env.example",
            ".env-sample",
            "example.env",
            ".env.template",
            "notas.md",
            "environment.ts",
            "src/keyboard.rs",
            "auth.json",
            "hosts.yml",
            "credentials",
            "*.json",
            "**/*.rs",
            "a/./b.txt",
            ".codex/../notas.md",
            "src/../auth.json",
            "./auth.json",
        ] {
            assert!(!secret_path(p), "{p}");
        }
    }

    #[test]
    fn los_comandos_que_leen_secretos_o_vuelcan_el_entorno_se_reconocen() {
        for c in [
            "cat .env",
            "cat .e\"\"nv",
            "Get-Content ~/.ultron/.env",
            "type C:\\Users\\u\\.ultron\\.env",
            "cat prod.env",
            "cat<.env",
            "docker run --env-file=.env x",
            "cat ~/.claude.json",
            "printenv",
            "printenv GROQ_API_KEY",
            "git status; env",
            "set",
            "Get-ChildItem env:",
            "gci env:",
            "echo $GROQ_API_KEY",
            "echo $env:OPENAI_API_KEY",
            "echo %GROQ_API_KEY%",
            "cat /proc/self/environ",
            "reg query HKCU\\Environment",
            "[Environment]::GetEnvironmentVariables()",
            "node -p \"JSON.stringify(process.env)\"",
            "python -c \"import os; print(os.environ)\"",
            // `cd` tras un abridor de bloque (H1).
            "cat ~/.codex/./auth.json",
            "cd ~/.codex && cat ./auth.json",
            "(cd ~/.codex && cat auth.json)",
            "{ cd ~/.codex; cat auth.json; }",
            "if cd ~/.codex; then cat auth.json; fi",
            "cd ~/.codex & cat auth.json",
            "cd ~/.codex >/dev/null && cat auth.json",
            "cd ~/.codex && < auth.json cat",
            "x=$(cd ~/.codex && cat auth.json)",
            // Volcados (H2).
            "echo $ULTRON_KEY_ANTHROPIC_CREDITS",
            "printenv ULTRON_KEY_ANTHROPIC_CREDITS",
            "reg query HKCU\\\\Environment",
            "reg query \"HKCU\\Environment\"",
            "reg export HKCU\\Environment x.txt",
            "reg save HKCU\\Environment x.hiv",
            "reg query HKCU /s",
            "export",
            "export -p",
            "export | grep KEY",
            "export > e.txt",
            "declare",
            "declare -x",
            "declare -p GROQ_API_KEY",
            "typeset -x",
            "SET",
            "set GROQ_API_KEY",
            "(export)",
            "{ export; }",
            "git status && export",
            "Get-CimInstance Win32_Environment",
        ] {
            assert!(touches_secret(c), "{c}");
        }
        // Caso negativo: código que nombra `process.env`, plantillas y
        // comandos corrientes no son una credencial.
        for c in [
            "grep -rn process.env src",
            "cat .env.example",
            "echo $PATH",
            "echo $HOME",
            "git status",
            "env FOO=1 cargo test",
            "set -e",
            "ls -la",
            "curl https://example.com/.env",
            "cat notas.env.md",
            // Asignar o consultar sin valores no es volcar.
            "export FOO=1",
            "export FOO",
            "export PATH=\"$PATH:/x\" && cargo test",
            "declare -x FOO=1",
            "declare -f foo",
            "typeset -x FOO=1",
            "set -euo pipefail",
            "reg query HKCU\\Software\\X",
            // Un `cd` corriente no vuelve sensible lo que venga detrás.
            "(cd src && cat auth.json)",
            "cd .codex/.. && cat auth.json",
            "cd src-tauri && cargo test 2>&1 | tail -5",
            "if cd build; then cat notas.md; fi",
            "cd ~/.codex && ls -la",
        ] {
            assert!(!touches_secret(c), "{c}");
        }
    }
}
