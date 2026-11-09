// Mascota — patrones del freno del chat de Pupus (chat_gate.rs): comandos
// destructivos, ejecución de scripts o programas y rutas de arranque o de
// configuración. Solo leen texto; la decisión vive en chat_gate.rs.

use once_cell::sync::Lazy;
use regex::Regex;

use super::secrets::{touches_secret, SECRET};

/// Inicio de palabra de comando: principio, separadores de shell o comillas.
const CMD: &str = r#"(?:^|[\s;&|("'`])"#;
/// Posición de comando: principio o tras un separador, con `&` o `.` de
/// PowerShell y comillas opcionales delante.
const CMD_POS: &str = r#"(?:^|[;&|(\n`{])\s*(?:[&.]\s+)?["']?"#;
const SCRIPT_EXT: &str =
    "ps1|psm1|bat|cmd|vbs|vbe|js|mjs|cjs|jse|wsf|wsh|hta|py|pyw|sh|exe|msi|com|scr|lnk|reg";

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("patrón del freno válido")
}

/// Los mismos patrones que `RISKY_COMMANDS` del MCP de escritorio; la paridad
/// la comprueba el corpus compartido (`corpus_compartido_con_el_mcp`).
static RISKY: Lazy<Vec<(Regex, &'static str)>> = Lazy::new(|| {
    vec![
        (
            re(&format!(
                r"(?i){CMD}(?:rm|rmdir|rd|del|erase|unlink|shred|ri)(?:\s|$)"
            )),
            "borrar ficheros",
        ),
        (
            re(r"(?i)\b(?:Remove-Item|Clear-Content|Clear-RecycleBin)\b"),
            "borrar ficheros",
        ),
        (
            re(
                r"(?i)\b(?:rmSync|rmdirSync|unlinkSync|rimraf|rmtree|os\.remove|os\.unlink|os\.rmdir)\b|(?:\.|::)Delete\(",
            ),
            "borrar ficheros",
        ),
        (re(r"(?i)\bgit\b[^\n;&|]*\spush\b"), "git push"),
        (
            re(
                r"(?i)\bgit\b[^\n;&|]*\s(?:reset\s+--hard|clean\b|branch\s+-D|checkout\s+--\s|restore\b|stash\s+(?:drop|clear))",
            ),
            "descartar cambios de git",
        ),
        (
            re(&format!(
                r"(?i){CMD}reg(?:\.exe)?\s+(?:add|delete|import|load|unload|restore|copy)\b"
            )),
            "tocar el registro",
        ),
        (
            re(r"(?i)\b(?:Set|New|Remove|Rename)-ItemProperty\b|\bHK(?:LM|CU|CR|U|CC):"),
            "tocar el registro",
        ),
        (
            re(&format!(
                r"(?i)\b(?:taskkill|tskill|pkill|killall)\b|\bStop-Process\b|{CMD}kill(?:\s|$)"
            )),
            "matar procesos",
        ),
        (
            re(
                r"(?i)\b(?:shutdown|Restart-Computer|Stop-Computer|diskpart|bcdedit)\b|\bformat(?:\.com)?\s+[a-z]:|\bcipher\s+/w",
            ),
            "apagar o tocar el disco",
        ),
        (
            re(r"(?i)\brobocopy\b[^\n]*\s/(?:mir|purge|move|mov)\b|\bMove-Item\b[^\n]*\$null"),
            "borrar ficheros",
        ),
        (
            re(
                r"(?i)\s-(?:e|en|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}|\b(?:iex|Invoke-Expression|Invoke-Command|FromBase64String)\b|\bbase64\s+(?:-d|--decode)\b|\beval\b",
            ),
            "comando ofuscado",
        ),
    ]
});

/// Ejecutar un script o un programa: intérpretes y lanzadores en posición de
/// comando, o un fichero ejecutable invocado directamente.
static SCRIPT_RUN: Lazy<Vec<Regex>> = Lazy::new(|| {
    vec![
        re(&format!(
            r#"(?i){CMD_POS}(?:[^\s;&|"']*[\\/])?(?:node|nodejs|python[0-9.]*|pythonw|py|uv|uvx|npx|npm|pnpm|yarn|bun|bunx|deno|ruby|perl|php|java|dotnet|cargo|pip[0-9.]*|wscript|cscript|mshta|rundll32|regsvr32|msiexec|installutil|powershell|pwsh|cmd|bash|sh|zsh|wsl|start|start-process|saps|invoke-item|ii|schtasks|register-scheduledtask|new-scheduledtask[a-z]*|new-service|sc)(?:\.exe|\.cmd|\.bat)?(?:\s|$|["'])"#
        )),
        re(&format!(
            r#"(?i){CMD_POS}(?:\.{{1,2}}[\\/]|[^\s;&|"']*\.(?:{SCRIPT_EXT})(?:\s|$|["']))"#
        )),
        // Ruta entre comillas con espacios ("C:\Program Files\x\y.exe").
        re(&format!(
            r#"(?i){CMD_POS}[a-z]:[\\/][^"'\n]*\.(?:{SCRIPT_EXT})["']"#
        )),
    ]
});

/// Rutas de arranque o de configuración (minúsculas y con `/`).
pub(super) const SENSITIVE_PATHS: &[&str] = &[
    "/start menu/programs/startup",
    "/microsoft/windows/start menu/",
    "shell:startup",
    "shell:common startup",
    "currentversion/run",
    "/system32/tasks",
    "/windows/tasks/",
    "/windowspowershell/",
    "/documents/powershell/",
    "profile.ps1",
    "$profile",
    "/.bashrc",
    "/.bash_profile",
    "/.bash_login",
    "/.profile",
    "/.zshrc",
    "/.zprofile",
    "/.config/fish/",
    "/.claude/",
    "/.claude.json",
    "/.codex/",
    "/.gemini/",
    "/.ultron/hooks/",
    "/.ultron/mods/",
    "/.ultron/scripts/",
    "/.ultron/bin/",
    "/.ssh/",
    "/.gitconfig",
    "/.git/hooks/",
    "/.git/config",
];

pub(super) const BRIDGE: &str = "contactar con el puente local o leer su token";
const OVERWRITE: &str = "sobrescribir o mover ficheros";
const NET_SEND_REASON: &str = "enviar datos a la red";

/// Sobrescribir o mover por shell (lo que `>>`, `Add-Content` u `Out-File
/// -Append` no hacen: esos añaden).
static OVERWRITES: Lazy<Vec<Regex>> = Lazy::new(|| {
    vec![
        re(r"(?i)\bSet-Content\b"),
        re(&format!(
            r"(?i){CMD_POS}(?:mv|move|move-item)(?:\.exe)?(?:\s|$)"
        )),
        re(&format!(
            r"(?i){CMD_POS}(?:cp|copy|copy-item|cpi|xcopy)(?:\.exe)?(?:\s[^\n;&|]*)?\s(?:-[a-z]*f[a-z]*(?:\s|$)|--force\b|/y\b)"
        )),
        re(r"(?i)\bNew-Item\b[^\n;&|]*\s-Force\b"),
        re(r"(?i)\bdd\b[^\n;&|]*\bof=|\btruncate\s"),
    ]
});

/// `Out-File` y `Tee-Object` sobrescriben salvo con `-Append`.
static OUT_FILE: Lazy<Regex> = Lazy::new(|| re(r"(?i)\b(?:Out-File|Tee-Object)\b"));
static APPEND: Lazy<Regex> = Lazy::new(|| re(r"(?i)\s-a(?:ppend)?\b"));

/// Comandos que traen contenido de la red (marcan el turno como la web).
static NET_FETCH: Lazy<Regex> = Lazy::new(|| {
    re(
        r"(?i)(?:^|[^a-z0-9_.-])(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|start-bitstransfer|bitsadmin)(?:\.exe)?(?:[^a-z0-9_-]|$)|net\.webclient|downloadstring|downloadfile|system\.net\.http|httpclient|msxml2\.|winhttp|certutil[^\n]*urlcache",
    )
});

/// Comandos que SACAN datos a la red: subir un fichero o mandar un cuerpo. Se
/// prueban sin pasar a minúsculas: `-F` y `-T` de curl no son `-f` y `-t`.
static NET_SEND: Lazy<Vec<Regex>> = Lazy::new(|| {
    vec![
        re(
            r"(?:^|[^a-zA-Z0-9_.-])[cC][uU][rR][lL](?:\.exe)?(?:\s[^\n;|]*)?\s(?:-[a-zA-Z]*[dFT]\S*|--(?:data|data-[a-z]+|form|form-string|upload-file|json|url-query)(?:[\s=]|$)|-X\s*(?i:POST|PUT|PATCH))",
        ),
        re(
            r"(?i)(?:^|[^a-z0-9_.-])(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)(?:\.exe)?\s[^\n;|]*\$(?:\(|\{|env:)",
        ),
        re(r"(?i)\bwget\b[^\n;|]*\s--(?:post-data|post-file|body-data|body-file|method)\b"),
        re(
            r"(?i)\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n;|]*\s-(?:body|infile|form|method\s+(?:post|put|patch|delete))\b",
        ),
        re(
            r"(?i)\bupload(?:file|string|data|values)(?:async)?\b|\.(?:post|put)async\b|start-bitstransfer[^\n;|]*\s-transfertype\s+upload\b|bitsadmin[^\n;|]*\s/upload\b|\bsend-mailmessage\b",
        ),
        re(r"(?i)(?:^|[;&|(\n]\s*)(?:scp|sftp|rsync|ftp|nc|ncat|netcat|socat)(?:\.exe)?\s"),
    ]
});

/// Comandos que traen al turno el contenido de un fichero: lo que digan puede
/// llevar instrucciones inyectadas, igual que una web.
static READS_FILE: Lazy<Regex> = Lazy::new(|| {
    re(&format!(
        r#"(?i){CMD_POS}(?:[^\s;&|"']*[\\/])?(?:cat|type|gc|get-content|less|more|head|tail|tac|nl|bat|sed|awk|xxd|od|strings|base64|grep|egrep|fgrep|rg|findstr|select-string|sls)(?:\.exe)?\s"#
    ))
});

/// El puente de la mascota (cualquier dirección de loopback, su API o su
/// cabecera), los ficheros que guardan su token, comodines que los alcanzan
/// y las carpetas que los contienen nombradas enteras (un `grep -r` sobre
/// `~/.ultron`, `cockpit` o la carpeta temporal). Un recorrido recursivo
/// desde la carpeta de usuario no se ve: es un freno, no un sandbox.
static BRIDGE_RE: Lazy<Regex> = Lazy::new(|| {
    re(
        r#"(?i)(?:^|[^0-9a-z.])(?:127(?:\.\d{1,3}){1,3}|0\.0\.0\.0|0x7f[0-9a-f.]*|2130706433)(?:[^0-9a-z]|$)|\blocalhost\b|\[(?:0{0,4}:){1,7}:?0{0,3}1\]|::ffff:7f|/v1/(?:action|pretool|approve)\b|x-ultron-token|mascot-bridge|ultron-pupus|chat-settings|cockpit/[^\s]*[*?\[]|mascot[^\s/]*[*?]|ultron-[^\s/]*[*?]|\.ultron(?:/cockpit)?/?(?:["'\s]|$)|(?:%temp%|\$env:te?mp|\$tmpdir|/appdata/local/temp)/?(?:["'\s]|$)"#,
    )
});

/// Lo que el shell junta al ejecutar: sin comillas, acentos graves ni `^`
/// (`c"ur"l`, `I`nvoke-RestMethod`, `^c^u^r^l`), en minúsculas. `strip_bs`
/// quita también `\` (`c\url` en bash); si no, pasa a `/` (rutas de Windows).
pub(super) fn shell_joined(text: &str, strip_bs: bool) -> String {
    text.chars()
        .filter(|c| !matches!(c, '"' | '\'' | '`' | '^'))
        .filter_map(|c| match c {
            '\\' if strip_bs => None,
            '\\' => Some('/'),
            c => Some(c),
        })
        .collect::<String>()
        .to_lowercase()
}

fn any_form(text: &str, re: &Regex) -> bool {
    re.is_match(text)
        || re.is_match(&shell_joined(text, false))
        || re.is_match(&shell_joined(text, true))
}

/// Contacta con el puente local o lee los ficheros de su token.
pub(super) fn touches_bridge(text: &str) -> bool {
    any_form(text, &BRIDGE_RE)
}

/// Trae contenido de la red (curl, wget, iwr, irm, Invoke-WebRequest…).
pub(super) fn fetches_network(text: &str) -> bool {
    any_form(text, &NET_FETCH)
}

/// Lee un fichero y trae su contenido al turno (cat, Get-Content, grep…).
pub(super) fn reads_file(text: &str) -> bool {
    READS_FILE.is_match(text)
}

/// Saca datos a la red (curl -d, Invoke-RestMethod -Body, scp, nc…).
pub(super) fn sends_network(text: &str) -> bool {
    let unquoted: String = text
        .chars()
        .filter(|c| !matches!(c, '"' | '\'' | '`' | '^'))
        .collect();
    NET_SEND
        .iter()
        .any(|r| r.is_match(text) || r.is_match(&unquoted))
}

/// Objetivo de una redirección `>` que sobrescribe (no `>>`, `>&1`, `$null`).
fn redirect_target(rest: &str) -> Option<String> {
    let target: String = rest
        .trim_start()
        .chars()
        .take_while(|c| !c.is_whitespace() && !matches!(c, ';' | '|' | '&' | ')'))
        .filter(|c| !matches!(c, '"' | '\''))
        .collect();
    let sink = matches!(
        target.to_lowercase().as_str(),
        "" | "$null" | "nul" | "nul:" | "/dev/null" | "\\\\.\\nul"
    );
    (!sink).then_some(target)
}

/// Hay una redirección `>` fuera de comillas que sobrescribe un fichero.
fn redirects_over_file(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let mut quote: Option<char> = None;
    for (i, &c) in chars.iter().enumerate() {
        match (quote, c) {
            (Some(q), _) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(c),
            (None, '>') => {
                let prev = i.checked_sub(1).map(|j| chars[j]);
                let next = chars.get(i + 1).copied();
                if matches!(prev, Some('>' | '-' | '=' | '^'))
                    || matches!(next, Some('>' | '&' | '='))
                {
                    continue;
                }
                let rest: String = chars[i + 1..].iter().collect();
                if redirect_target(&rest).is_some() {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

fn overwrites(text: &str) -> bool {
    if OVERWRITES.iter().any(|r| r.is_match(text)) || redirects_over_file(text) {
        return true;
    }
    text.split(['\n', ';', '|', '&'])
        .any(|seg| OUT_FILE.is_match(seg) && !APPEND.is_match(seg))
}

fn risky_reason(text: &str) -> Option<&'static str> {
    let found = RISKY
        .iter()
        .find(|(r, _)| r.is_match(text) || r.is_match(&shell_joined(text, true)))
        .map(|(_, why)| *why);
    found
        .or_else(|| touches_bridge(text).then_some(BRIDGE))
        .or_else(|| touches_secret(text).then_some(SECRET))
        .or_else(|| sends_network(text).then_some(NET_SEND_REASON))
        .or_else(|| overwrites(text).then_some(OVERWRITE))
}

fn runs_script(text: &str) -> bool {
    SCRIPT_RUN.iter().any(|r| r.is_match(text))
}

pub(super) fn touches_sensitive_path(text: &str) -> bool {
    let norm = format!("/{}", text.replace('\\', "/").to_lowercase());
    SENSITIVE_PATHS.iter().any(|p| norm.contains(p))
}

/// Escribir aquí también pregunta. `projects.json` se puede leer sin preguntar,
/// pero da hooks y permisos por proyecto, y el guardarraíl lo vigila.
pub(super) fn sensitive_write(path: &str) -> bool {
    touches_sensitive_path(path)
        || path
            .replace('\\', "/")
            .to_lowercase()
            .ends_with("/.ultron/cockpit/projects.json")
}

/// Motivo para pedir confirmación ante un texto que se ejecuta (comando o
/// lo tecleado antes de un Enter).
pub(super) fn command_reason(text: &str) -> Option<&'static str> {
    if let Some(why) = risky_reason(text) {
        return Some(why);
    }
    if runs_script(text) {
        return Some("ejecutar un script o un programa");
    }
    if touches_sensitive_path(text) {
        return Some("tocar el arranque o la configuración");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Corpus compartido con `riskyReason` de tools/ultron-desktop-mcp/server.mjs
    /// (lo comprueba también server.test.mjs): la paridad que el comentario de
    /// `RISKY` promete deja de ser solo una afirmación.
    const CORPUS: &str =
        include_str!("../../../../../tools/ultron-desktop-mcp/risky-commands.fixture.json");

    #[test]
    fn el_corpus_de_herramientas_coincide_con_el_mcp() {
        let v: serde_json::Value = serde_json::from_str(CORPUS).expect("JSON del corpus");
        let cases = v["tool_cases"].as_array().expect("tool_cases");
        assert!(cases.len() >= 10, "corpus de herramientas demasiado corto");
        let wrong: Vec<String> = cases
            .iter()
            .filter_map(|c| {
                let tool = c["tool"].as_str().unwrap_or_default();
                let want = c["reason"].as_str().unwrap_or_default();
                let step = super::super::decide(tool, &c["input"], false, "");
                let got = match step.gate {
                    super::super::Gate::Ask { reason, .. } => reason,
                    super::super::Gate::Pass => "",
                };
                (got != want)
                    .then(|| format!("{tool} {}: esperado {want:?}, sale {got:?}", c["input"]))
            })
            .collect();
        assert!(wrong.is_empty(), "{wrong:#?}");
    }

    #[test]
    fn corpus_compartido_con_el_mcp() {
        let v: serde_json::Value = serde_json::from_str(CORPUS).expect("JSON del corpus");
        let cases = v["cases"].as_array().expect("cases");
        assert!(cases.len() >= 30, "corpus demasiado corto");
        let wrong: Vec<String> = cases
            .iter()
            .filter_map(|c| {
                let command = c["command"].as_str().unwrap_or_default();
                let want = c["reason"].as_str().unwrap_or_default();
                let got = risky_reason(command).unwrap_or("");
                (got != want).then(|| format!("{command:?}: esperado {want:?}, sale {got:?}"))
            })
            .collect();
        assert!(wrong.is_empty(), "{wrong:#?}");
    }
}
