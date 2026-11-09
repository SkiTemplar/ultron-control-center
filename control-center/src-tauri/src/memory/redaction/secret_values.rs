//! Forma del valor de una asignación secreta (`nombre=valor`): dónde empieza, dónde
//! acaba y si parece un secreto. Sale de `secrets.rs` (límite de 800 líneas).
//!
//! Hay dos formas de valor. La de token, una racha de `[A-Za-z0-9_-]` de al menos 8
//! caracteres al principio, cubre lo generado. La de contraseña escrita por una
//! persona (`p@ssw0rd!2026`, `añoNuevo2026`) no tiene esa racha: se reconoce por la
//! mezcla de letra, cifra y símbolo, sin marcas de código. El detector prefiere no
//! marcar lo ambiguo: `token:Option<String>`, `user1@example.com` o `foo?.bar1` no
//! son contraseñas.

use super::{is_token_char, token_run_len};

/// Símbolos con los que puede empezar un valor literal.
const LEADING_SYMBOLS: [char; 5] = ['!', '@', '#', '^', '+'];
/// Símbolos propios de una contraseña escrita a mano.
const PASSWORD_SYMBOLS: &str = "!@#^*+~?&%=";
/// Con cualquiera de estos el valor es una ruta, una llamada o una plantilla.
const CODE_CHARS: &str = "/\\(){}[]<>$";
const CODE_TOKENS: [&str; 6] = ["::", "->", "=>", "==", "?.", "**"];
const MIN_PASSWORD_CHARS: usize = 8;
const MAX_PASSWORD_CHARS: usize = 128;

fn is_placeholder(lower: &str) -> bool {
    matches!(
        lower,
        "changeme" | "placeholder" | "password" | "undefined" | "redacted"
    ) || ["your_", "your-", "example", "xxxx"]
        .iter()
        .any(|p| lower.starts_with(p))
}

/// Mezcla de cifras o de mayúsculas y minúsculas: la forma de un valor generado.
/// Separa un token real de un identificador (`settings`, `sk-learn-tools`).
pub(super) fn looks_generated(tok: &str) -> bool {
    let has_digit = tok.bytes().any(|b| b.is_ascii_digit());
    let has_upper = tok.bytes().any(|b| b.is_ascii_uppercase());
    let has_lower = tok.bytes().any(|b| b.is_ascii_lowercase());
    has_digit || (has_upper && has_lower)
}

/// Valor con forma de token: una racha larga que no es un marcador ni código.
fn token_shape_is_secret(value: &str) -> bool {
    let run = token_run_len(value);
    if run < 8 {
        return false;
    }
    let head = &value[..run];
    if is_placeholder(&head.to_ascii_lowercase()) {
        return false;
    }
    // Nombre de variable como valor (`API_KEY=ANTHROPIC_API_KEY`).
    let is_env_name = head
        .bytes()
        .all(|b| b.is_ascii_uppercase() || b == b'_' || b == b'-');
    if is_env_name {
        return false;
    }
    match value.as_bytes().get(run) {
        // Llamada o genérico: `token=getToken()`, `secret:Optional[str]`.
        Some(b'(' | b'[' | b'<') => false,
        // Atributo (`password=settings.password`); un JWT sí pasa por su forma.
        Some(b'.') => looks_generated(head),
        _ => true,
    }
}

/// `usuario1@dominio.com` o `paquete@1.2.3`: una arroba y un punto, sin más símbolos.
fn is_address_like(body: &str) -> bool {
    body.contains('@')
        && body.contains('.')
        && !body
            .chars()
            .any(|c| c != '@' && PASSWORD_SYMBOLS.contains(c))
}

/// Contraseña escrita a mano: letra, cifra y símbolo (o letra no ASCII), sin código.
pub(super) fn symbol_password(body: &str) -> bool {
    let chars = body.chars().count();
    if !(MIN_PASSWORD_CHARS..=MAX_PASSWORD_CHARS).contains(&chars) {
        return false;
    }
    let has_letter = body.chars().any(char::is_alphabetic);
    let has_digit = body.chars().any(|c| c.is_ascii_digit());
    let has_symbol = body
        .chars()
        .any(|c| PASSWORD_SYMBOLS.contains(c) || (!c.is_ascii() && c.is_alphabetic()));
    if !(has_letter && has_digit && has_symbol) {
        return false;
    }
    let is_code = body.chars().any(|c| CODE_CHARS.contains(c))
        || CODE_TOKENS.iter().any(|t| body.contains(t));
    !is_code && !is_address_like(body) && !is_placeholder(&body.to_lowercase())
}

/// A value looks like a real secret (not a placeholder/empty) if it has a
/// non-trivial token tail or the shape of a hand-written password.
pub(super) fn value_looks_secret(value: &str) -> bool {
    let core = if value.starts_with(LEADING_SYMBOLS) {
        value
            .find(|c: char| c.is_ascii_alphanumeric())
            .map_or("", |i| &value[i..])
    } else {
        value
    };
    token_shape_is_secret(core) || symbol_password(&value[..value_span_len(value)])
}

/// Inicio del valor tras el separador de una asignación: salta comillas (también
/// escapadas, `\"token\":\"valor\"`). `None` si lo que sigue es una referencia o
/// una estructura y no un literal: `$VAR`, `%VAR%`, `{...}`, `[REDACTED:x]`,
/// `::ruta`, `==` o `./fichero`. El símbolo inicial es parte del valor.
pub(super) fn value_offset(raw: &str) -> Option<usize> {
    let quotes = raw
        .bytes()
        .take_while(|b| matches!(b, b'"' | b'\'' | b'\\' | b'`'))
        .count();
    let rest = &raw[quotes..];
    let first = rest.chars().next()?;
    let is_literal = if first.is_ascii() {
        is_token_char(first as u8)
    } else {
        first.is_alphabetic()
    };
    if is_literal {
        return Some(quotes);
    }
    if LEADING_SYMBOLS.contains(&first) && rest.contains(|c: char| c.is_ascii_alphanumeric()) {
        return Some(quotes);
    }
    None
}

/// `&` dentro del valor (`Tr0ub4dor&3xyz`), salvo que empiece el campo siguiente de
/// una cadena de consulta (`a&b=1`), un operador (`a&&b`) o una entidad (`a&amp;b`).
fn ampersand_continues(rest: &str) -> bool {
    let run = token_run_len(rest);
    run > 0 && rest.as_bytes().get(run) != Some(&b'=') && !rest.starts_with("amp;")
}

/// `\` dentro del valor, salvo una comilla escapada o un salto en una cadena JSON.
fn backslash_continues(rest: &str) -> bool {
    !matches!(
        rest.chars().next(),
        None | Some('"' | '\'' | '`' | '\\' | 'n' | 'r' | 't')
    )
}

fn ends_value(value: &str, at: usize, c: char) -> bool {
    match c {
        '&' => !ampersand_continues(&value[at + 1..]),
        '\\' => !backslash_continues(&value[at + 1..]),
        '"' | '\'' | '`' | ',' | ';' | '}' | ']' | ')' | '<' | '>' | '|' => true,
        _ if c.is_whitespace() => true,
        _ => !c.is_ascii() && !c.is_alphanumeric(),
    }
}

/// Bytes del valor hasta su terminador. Cubre el valor entero (JWT con puntos,
/// base64 con `+/=`, letras no ASCII) para que la redacción no deje la cola en claro.
pub(super) fn value_span_len(value: &str) -> usize {
    let span = value
        .char_indices()
        .find(|&(i, c)| ends_value(value, i, c))
        .map_or(value.len(), |(i, _)| i);
    span - value[..span]
        .bytes()
        .rev()
        .take_while(|b| matches!(b, b'.' | b':'))
        .count()
}
