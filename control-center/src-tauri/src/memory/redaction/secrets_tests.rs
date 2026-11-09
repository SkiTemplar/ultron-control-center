//! Formas de secreto sin espacios que el detector no veía hasta la auditoría
//! 2026-11-01. Las claves se montan en tiempo de ejecución para que el fuente no
//! contenga una credencial literal: son valores inventados, no tokens reales.

use super::*;

const TAIL: &str = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";

fn fake(prefix: &str) -> String {
    format!("{prefix}{TAIL}")
}

fn assert_redacted(text: &str, value: &str) {
    let out = redact(text);
    assert!(!out.contains(value), "valor en claro: {out}");
    assert!(out.contains("[REDACTED:"), "sin marcador: {out}");
}

#[test]
fn nombre_compuesto_con_prefijo_conocido() {
    // La forma exacta del caso real: nombre con guion bajo, `=` y PAT de GitHub.
    let pat = fake(&["github", "_pat_"].concat());
    let text = format!("export GITHUB_TOKEN={pat} && git push");
    assert_redacted(&text, &pat);
    assert_eq!(detect_secrets(&text)[0].kind, SecretKind::GithubToken);
    assert!(redact(&text).ends_with(" && git push"));

    let key = fake("sk-ant-api03-");
    assert_redacted(&format!("ANTHROPIC_API_KEY={key}"), &key);
}

#[test]
fn nombre_compuesto_con_valor_sin_prefijo() {
    for name in [
        "MI_TOKEN",
        "DB_PASSWORD",
        "AWS_SECRET_ACCESS_KEY",
        "GH_PAT",
        "CUSTOM_API_KEY",
        "mi-client-secret",
    ] {
        let text = format!("{name}=Valor1234567890");
        assert_redacted(&text, "Valor1234567890");
        assert!(redact(&text).starts_with(&format!("{name}=")), "{text}");
    }
}

#[test]
fn json_compacto() {
    let pat = fake("ghp_");
    assert_redacted(&format!("{{\"k\":\"{pat}\"}}"), &pat);

    let text = r#"{"id":1,"token":"Valor1234567890","x":"visible"}"#;
    let out = redact(text);
    assert!(!out.contains("Valor1234567890"), "{out}");
    assert_eq!(out, r#"{"id":1,"token":"[REDACTED:secret]","x":"visible"}"#);

    // Dos secretos en la misma palabra, sin espacios.
    let two = r#"{"api_key":"Primero123456","refresh_token":"Segundo123456"}"#;
    let out = redact(two);
    assert!(!out.contains("Primero123456") && !out.contains("Segundo123456"));
    assert_eq!(detect_secrets(two).len(), 2);
}

/// `memory_events.after_json` guarda el candidato serializado: el texto que venía
/// como JSON llega con las comillas escapadas.
#[test]
fn json_con_comillas_escapadas() {
    let text = r#"{\"access_token\":\"Valor1234567890\"}"#;
    assert_redacted(text, "Valor1234567890");
}

#[test]
fn json_con_cabecera_bearer_pegada() {
    let text = r#"{"authorization":"Bearer Valor1234567890"}"#;
    assert_redacted(text, "Valor1234567890");
}

#[test]
fn cadena_de_consulta_y_url_con_credencial() {
    assert_redacted(
        "https://api.example.com/v1?a=1&api_key=Valor1234567890&b=2",
        "Valor1234567890",
    );
    let out = redact("https://api.example.com/v1?api_key=Valor1234567890&b=2");
    assert!(out.ends_with("&b=2"), "{out}");

    assert_redacted(
        "git clone https://usuario:Valor1234567890@github.com/a/b.git",
        "Valor1234567890",
    );
    let pat = fake("ghp_");
    let text = format!("https://x-access-token:{pat}@github.com/a/b");
    assert_redacted(&text, &pat);
    assert!(redact(&text).ends_with("@github.com/a/b"));
}

#[test]
fn el_valor_se_redacta_entero() {
    // JWT y base64: la cola no se queda en claro.
    assert_eq!(
        redact("AUTH_TOKEN=eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJl fin"),
        "AUTH_TOKEN=[REDACTED:secret] fin"
    );
    assert_eq!(
        redact("MI_SECRET=AbCd1234+/xyz== fin"),
        "MI_SECRET=[REDACTED:secret] fin"
    );
}

#[test]
fn conector_simbolico_suelto_en_prosa() {
    assert_redacted("la clave = Patata2024", "Patata2024");
    assert_redacted("GITHUB_TOKEN : Valor1234567890", "Valor1234567890");
    assert_redacted(r#""api_key": "Valor1234567890""#, "Valor1234567890");
}

// --- Casos negativos: lo que NO es un secreto no se toca ---

#[test]
fn nombres_que_no_llevan_secreto() {
    for text in [
        "MAX_TOKENS=120000000",
        "TOKEN_BUDGET=120000000",
        "SORT_KEY=abcdefghij",
        "PRIMARY_KEY=abcdefghij",
        r#"{"id":"abcdefghij1234","title":"visible"}"#,
        "ULTRON_DENSE=0",
        "C:/repo/src/token.rs:120",
    ] {
        assert!(!contains_secret(text), "falso positivo: {text}");
    }
}

#[test]
fn referencias_y_codigo_no_son_valores() {
    for text in [
        "GITHUB_TOKEN=$GITHUB_TOKEN",
        "API_KEY=%API_KEY%",
        "GITHUB_TOKEN=${{secrets.GH}}",
        "API_KEY=ANTHROPIC_API_KEY",
        "MI_TOKEN=<tu-token>",
        "MI_TOKEN=[REDACTED:secret]",
        "token=getTokenValue()",
        "password=settings.password",
        "secret_key:Optional[str]",
        "Token::from_string(abc)",
        "token==expected_value",
        "password!=other_password",
        "MI_TOKEN=your_token_here",
        r#"{"token":null,"password":"","secret":{"a":1}}"#,
    ] {
        assert!(!contains_secret(text), "falso positivo: {text}");
    }
}

#[test]
fn nombres_de_paquete_a_mitad_de_palabra_no_son_tokens() {
    for text in [
        "node_modules/sk-learn-something-more/index.js",
        "https://github.com/a/hf_hub_download_example_x",
        "https://usuario@github.com/a/b.git",
        "https://localhost:8080/ruta",
    ] {
        assert!(!contains_secret(text), "falso positivo: {text}");
    }
}

#[test]
fn redactar_es_idempotente() {
    let pat = fake("ghp_");
    let once = redact(&format!(
        r#"GITHUB_TOKEN={pat} {{"token":"Valor1234567890"}}"#
    ));
    assert_eq!(redact(&once), once);
    assert!(!contains_secret(&once), "{once}");
}

#[test]
fn texto_no_ascii_no_rompe_los_limites_de_caracter() {
    let text = "password=Valor1234567890ñ año:ñandú token=ñññññññññ €=€ {\"token\":\"€\"}";
    let out = redact(text);
    assert!(!out.contains("Valor1234567890"), "{out}");
    assert!(out.contains("año:ñandú"), "{out}");
}

/// Revisión final 2026-11-02, H4: una contraseña escrita a mano no tiene la racha de
/// 8 caracteres de un token, y lo que sigue al primer símbolo se quedaba en claro.
#[test]
fn contrasena_con_simbolos_se_redacta_entera() {
    for (text, value) in [
        ("DB_PASSWORD=p@ssw0rd!2026", "p@ssw0rd!2026"),
        ("{\"password\":\"p@ss!word123\"}", "p@ss!word123"),
        ("password=contraseñaSegura1", "contraseñaSegura1"),
        ("password=Tr0ub4dor&3xyz", "Tr0ub4dor&3xyz"),
        ("password=añoNuevo2026", "añoNuevo2026"),
        ("password=!Abc123xyz", "!Abc123xyz"),
        ("contraseña=hunter2Abc", "hunter2Abc"),
        ("la contraseña es p@ssw0rd!2026", "p@ssw0rd!2026"),
        ("password: p@ss!word123 y sigue", "p@ss!word123"),
        ("DB_PASSWORD = p@ssw0rd!2026", "p@ssw0rd!2026"),
    ] {
        let out = redact(text);
        assert!(out.contains("[REDACTED:"), "sin marcador: {out}");
        for tail in [value, &value[value.len() - 4..]] {
            assert!(!out.contains(tail), "queda {tail:?} en claro: {out}");
        }
    }
    // Lo que rodea al valor no se pierde.
    assert_eq!(
        redact("DB_PASSWORD=p@ssw0rd!2026 y sigue"),
        "DB_PASSWORD=[REDACTED:secret] y sigue"
    );
    assert_eq!(
        redact("{\"password\":\"p@ss!word123\",\"a\":1}"),
        "{\"password\":\"[REDACTED:secret]\",\"a\":1}"
    );
}

#[test]
fn el_ampersand_de_una_cadena_de_consulta_sigue_cortando_el_valor() {
    assert_eq!(
        redact("?api_key=abcd1234efgh&b=1"),
        "?api_key=[REDACTED:secret]&b=1"
    );
    assert_eq!(
        redact("password=abcd1234efgh&&cargo"),
        "password=[REDACTED:secret]&&cargo"
    );
    assert_eq!(
        redact("\\\"password\\\":\\\"abcd1234efgh\\\""),
        "\\\"password\\\":\\\"[REDACTED:secret]\\\""
    );
}

/// Caso negativo: formas con símbolos que no son contraseñas.
#[test]
fn simbolos_en_codigo_y_direcciones_no_son_contrasenas() {
    for t in [
        "password=user1@example.com",
        "token:Option<String1!>",
        "token=foo1?.bar",
        "secret:std::string1!",
        "api_key=sk1*****",
        "password=C:\\temp\\a1!b",
        "pwd=/c/users/a1!b",
        "token=@types/node1",
        "secret=zod@3.22.4",
        "password=your_password!1",
        "password=!short1",
        "password=Sin!Cifras",
        "la contraseña es válida",
        "la contraseña es válida1",
        "el token es 100%",
    ] {
        assert!(!contains_secret(t), "{t}: {}", redact(t));
    }
}

#[test]
fn familia_de_keys_de_la_app() {
    assert_redacted("ULTRON_KEY_FOO=abcd1234efgh", "abcd1234efgh");
    assert!(!contains_secret("ULTRON_KEY_FOO=$(cat x)"));
}

/// Revisión final 2026-11-02, H5: solo se miraba el primer bloque del texto.
#[test]
fn clave_privada_tras_otro_bloque_pem() {
    let cert = "-----BEGIN CERTIFICATE-----\nQ0VSVElGSUNBRE8=\n-----END CERTIFICATE-----";
    let key = "-----BEGIN PRIVATE KEY-----\nQ0xBVkVQUklWQURB\n-----END PRIVATE KEY-----";
    let rsa = "-----BEGIN RSA PRIVATE KEY-----\nU0VHVU5EQUNMQVZF\n-----END RSA PRIVATE KEY-----";

    let chain = format!("{cert}\n{key}\nfin");
    assert_eq!(
        redact(&chain),
        format!("{cert}\n[REDACTED:private_key]\nfin")
    );

    let two = format!("{key}\n{rsa}\n");
    let out = redact(&two);
    assert!(!out.contains("Q0xBVkVQUklWQURB"), "{out}");
    assert!(!out.contains("U0VHVU5EQUNMQVZF"), "{out}");
    assert_eq!(detect_secrets(&two).len(), 2);

    let middle = format!("{key}\n{cert}\n{rsa}");
    assert_eq!(
        redact(&middle),
        format!("[REDACTED:private_key]\n{cert}\n[REDACTED:private_key]")
    );

    // Un `BEGIN` ajeno sin `END` no se traga la clave que viene detrás.
    let open = format!("-----BEGIN CERTIFICATE-----\nresto\n{key}");
    assert!(!redact(&open).contains("Q0xBVkVQUklWQURB"));
    // Clave sin cierre: hasta el final, como siempre.
    assert_eq!(
        redact("-----BEGIN PRIVATE KEY-----\nQ0xBVkU="),
        "[REDACTED:private_key]"
    );
}

/// Caso negativo: un certificado solo es público.
#[test]
fn un_certificado_solo_no_es_un_secreto() {
    let cert = "-----BEGIN CERTIFICATE-----\nQ0VSVElGSUNBRE8=\n-----END CERTIFICATE-----";
    assert!(!contains_secret(cert));
    assert!(!contains_secret(
        "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----"
    ));
}
