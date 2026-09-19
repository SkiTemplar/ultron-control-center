// mar.ia — que cuentas y que claves tengo conectadas, y a que correo.
//
// El usuario lo pidio con foco explicito el 2026-09-19: "saber que cuentas y
// apis tengo conectadas y el correo asociado a ellas, para no equivocarme con
// el de compañeros". El riesgo real no es tecnico: es firmar trabajo, gastar
// cuota o subir codigo con la cuenta equivocada.
//
// QUE SE LEE Y QUE NO (esto importa):
//   * Se abre el fichero de credenciales de cada CLI y se saca UNICAMENTE el
//     correo o el identificador de cuenta. El token NUNCA se copia, ni se
//     devuelve al frontend, ni se escribe en un log.
//   * De una clave de API solo salen los CUATRO ultimos caracteres y de donde
//     se leyo (entorno o fichero .env). Nunca la clave.
//   * Si la CLI no expone la cuenta en ningun sitio conocido, se dice
//     "la CLI no expone la cuenta" en vez de inventarse una.
//
// Tambien detecta el caso que mas confunde: tener ANTHROPIC_API_KEY puesta
// hace que Claude Code deje de usar la SUSCRIPCION y empiece a cobrar por API.
// Eso es exactamente "no saber si es suscripcion o api", y aqui se dice.

use serde::Serialize;

/// Como se esta accediendo a un proveedor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum TipoAcceso {
    /// Sesion iniciada con una cuenta (suscripcion). No gasta credito de API.
    Suscripcion,
    /// Clave de API: se factura por uso.
    ClaveApi,
    /// Corre en esta maquina; no hay cuenta ni factura.
    Local,
    /// Ni sesion ni clave.
    SinAcceso,
}

#[derive(Debug, Clone, Serialize)]
pub struct Cuenta {
    pub provider: String,
    pub label: String,
    pub tipo: TipoAcceso,
    /// Correo o identificador de la cuenta. Vacio si la CLI no lo expone.
    pub account: String,
    /// De donde ha salido ese dato, para poder comprobarlo a mano.
    pub source: String,
    /// Ultimos 4 caracteres de la clave, cuando el acceso es por API.
    pub key_tail: String,
    /// Avisos que el usuario deberia leer antes de trabajar.
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InformeCuentas {
    pub cuentas: Vec<Cuenta>,
    /// Correos distintos encontrados. Mas de uno = revisar antes de trabajar.
    pub correos: Vec<String>,
    /// Avisos que afectan a todo el sistema.
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Parte pura
// ---------------------------------------------------------------------------

/// Saca el correo de un JSON de credenciales buscando en las claves donde
/// suelen guardarlo las distintas CLIs.
///
/// Se buscan varias rutas a proposito: cada CLI lo llama de una forma y
/// cambian de version en version. Devuelve tambien DE DONDE salio, para que la
/// pantalla pueda decir por que cree lo que cree. Pura.
#[must_use]
pub fn correo_en(v: &serde_json::Value) -> Option<(String, String)> {
    const RUTAS: &[&[&str]] = &[
        &["email"],
        &["account", "email"],
        &["account", "email_address"],
        &["oauthAccount", "emailAddress"],
        &["claudeAiOauth", "emailAddress"],
        &["tokens", "account", "email"],
        &["user", "email"],
        &["active_account"],
        // Gemini guarda la cuenta activa en `google_accounts.json` como
        // `active`; sin esta ruta el panel decia "no expuesto" teniendo el
        // correo delante (comprobado en esta maquina el 2026-09-19).
        &["active"],
        &["accounts", "active"],
    ];
    for ruta in RUTAS {
        let mut actual = v;
        let mut ok = true;
        for paso in *ruta {
            match actual.get(paso) {
                Some(siguiente) => actual = siguiente,
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if ok {
            if let Some(s) = actual.as_str() {
                let s = s.trim();
                if !s.is_empty() {
                    return Some((s.to_string(), ruta.join(".")));
                }
            }
        }
    }
    None
}

/// Saca el `email` del payload de un JWT SIN verificar la firma.
///
/// Solo para ENSEÑARLO: no se usa para autorizar nada, asi que no hace falta
/// (ni tendria sentido aqui) comprobar la firma. Codex guarda un `id_token`
/// con el correo dentro y es la unica via de saber con que cuenta se entro.
/// Pura.
#[must_use]
pub fn correo_en_jwt(token: &str) -> Option<String> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim())
        .ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    correo_en(&v).map(|(c, _)| c)
}

/// Ultimos 4 caracteres de una clave. Nunca mas: con 8 ya se puede empezar a
/// buscar en un volcado. Pura.
#[must_use]
pub fn cola_de_clave(clave: &str) -> String {
    let limpia = clave.trim();
    let n = limpia.chars().count();
    if n == 0 {
        return String::new();
    }
    if n <= 4 {
        // Una clave asi de corta no es una clave: se tapa entera.
        return "•".repeat(n);
    }
    format!("…{}", limpia.chars().skip(n - 4).collect::<String>())
}

/// Correos distintos, en orden de aparicion y sin repetir. Pura.
#[must_use]
pub fn correos_distintos(cuentas: &[Cuenta]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in cuentas {
        let correo = c.account.trim();
        if correo.is_empty() || !correo.contains('@') {
            continue;
        }
        if !out.iter().any(|x| x.eq_ignore_ascii_case(correo)) {
            out.push(correo.to_string());
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Lectura del disco
// ---------------------------------------------------------------------------

fn json_de(path: &std::path::Path) -> Option<serde_json::Value> {
    let texto = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&texto).ok()
}

/// Valor de una variable, mirando el entorno y luego el `.env` de mar.ia.
/// Devuelve (valor, de donde). Nunca se registra el valor.
fn variable(nombre: &str) -> Option<(String, String)> {
    if let Ok(v) = std::env::var(nombre) {
        if !v.trim().is_empty() {
            return Some((v.trim().to_string(), "variable de entorno".into()));
        }
    }
    let env_file = crate::maria_paths::home().join(".env");
    let texto = std::fs::read_to_string(&env_file).ok()?;
    for linea in texto.lines() {
        let linea = linea.trim();
        if let Some(resto) = linea.strip_prefix(&format!("{nombre}=")) {
            let v = resto.trim().trim_matches('"').trim();
            if !v.is_empty() {
                return Some((v.to_string(), format!("{}", env_file.display())));
            }
        }
    }
    None
}

fn cuenta_claude(home: &std::path::Path) -> Cuenta {
    let cred = home.join(".claude").join(".credentials.json");
    let hay_sesion = cred.exists();
    let clave = variable("ANTHROPIC_API_KEY");

    let (mut account, mut source) = (String::new(), String::new());
    for candidato in [cred.clone(), home.join(".claude.json")] {
        if account.is_empty() {
            if let Some((c, ruta)) = json_de(&candidato).as_ref().and_then(correo_en) {
                account = c;
                source = format!("{} ({ruta})", candidato.display());
            }
        }
    }

    let mut warnings = Vec::new();
    // El caso que mas lia: con la clave puesta, Claude Code deja de usar la
    // suscripcion y empieza a facturar por API sin avisar.
    let tipo = match (hay_sesion, clave.is_some()) {
        (_, true) => {
            warnings.push(
                "ANTHROPIC_API_KEY está definida: Claude Code usará la API (se factura por uso) \
                 en vez de tu suscripción. Bórrala si quieres la suscripción."
                    .into(),
            );
            TipoAcceso::ClaveApi
        }
        (true, false) => TipoAcceso::Suscripcion,
        (false, false) => TipoAcceso::SinAcceso,
    };
    if hay_sesion && account.is_empty() {
        warnings.push("la CLI de Claude no expone el correo de la cuenta en su credencial".into());
    }

    Cuenta {
        provider: "claude".into(),
        label: "Claude".into(),
        tipo,
        account,
        source: if source.is_empty() {
            cred.display().to_string()
        } else {
            source
        },
        key_tail: clave.map(|(v, _)| cola_de_clave(&v)).unwrap_or_default(),
        warnings,
    }
}

fn cuenta_codex(home: &std::path::Path) -> Cuenta {
    let auth = home.join(".codex").join("auth.json");
    let datos = json_de(&auth);
    let hay_sesion = auth.exists();

    let (mut account, mut source) = (String::new(), String::new());
    if let Some(v) = datos.as_ref() {
        if let Some((c, ruta)) = correo_en(v) {
            account = c;
            source = format!("{} ({ruta})", auth.display());
        } else {
            // Codex guarda el correo dentro del id_token.
            for clave in ["id_token", "tokens"] {
                let nodo = v.get(clave);
                let token = nodo
                    .and_then(|n| n.as_str())
                    .or_else(|| nodo.and_then(|n| n.get("id_token")).and_then(|t| t.as_str()));
                if let Some(c) = token.and_then(correo_en_jwt) {
                    account = c;
                    source = format!("{} (id_token)", auth.display());
                    break;
                }
            }
        }
    }

    let clave = variable("OPENAI_API_KEY");
    let mut warnings = Vec::new();
    if hay_sesion && account.is_empty() {
        warnings.push("la CLI de Codex no expone el correo de la cuenta en su credencial".into());
    }
    // Sesion Y clave a la vez: no se puede saber desde fuera cual acaba
    // pagando la factura, y eso es justo lo que el usuario quiere no dudar.
    if hay_sesion && clave.is_some() {
        warnings.push(
            "hay sesión de ChatGPT Y una OPENAI_API_KEY definida. Codex usa la sesión, pero              cualquier otra cosa que lea esa variable facturará por API. Déjala solo si la              quieres."
                .into(),
        );
    }
    let tipo = if hay_sesion {
        TipoAcceso::Suscripcion
    } else if clave.is_some() {
        TipoAcceso::ClaveApi
    } else {
        TipoAcceso::SinAcceso
    };

    Cuenta {
        provider: "codex".into(),
        label: "Codex (ChatGPT)".into(),
        tipo,
        account,
        source: if source.is_empty() {
            auth.display().to_string()
        } else {
            source
        },
        key_tail: clave.map(|(v, _)| cola_de_clave(&v)).unwrap_or_default(),
        warnings,
    }
}

fn cuenta_gemini(home: &std::path::Path) -> Cuenta {
    let cuentas = home.join(".gemini").join("google_accounts.json");
    let (mut account, mut source) = (String::new(), String::new());
    if let Some(v) = json_de(&cuentas) {
        if let Some((c, ruta)) = correo_en(&v) {
            account = c;
            source = format!("{} ({ruta})", cuentas.display());
        }
    }

    let clave = variable("GEMINI_API_KEY").or_else(|| variable("GOOGLE_API_KEY"));
    let mut warnings = Vec::new();
    // Dato verificado: Google corto el OAuth de Gemini CLI para cuentas
    // individuales el 18/06/2026. Una sesion guardada de antes NO sirve.
    if !account.is_empty() && clave.is_none() {
        warnings.push(format!(
            "hay una sesión guardada de {account}, pero Google cerró el acceso de Gemini CLI \
             con cuenta individual el 18/06/2026: sin clave de API no sirve. Usa Antigravity \
             o una clave de AI Studio."
        ));
    }
    let tipo = if clave.is_some() {
        TipoAcceso::ClaveApi
    } else {
        TipoAcceso::SinAcceso
    };

    Cuenta {
        provider: "gemini".into(),
        label: "Gemini".into(),
        tipo,
        account,
        source: if source.is_empty() {
            cuentas.display().to_string()
        } else {
            source
        },
        key_tail: clave.map(|(v, _)| cola_de_clave(&v)).unwrap_or_default(),
        warnings,
    }
}

fn cuenta_local() -> Cuenta {
    let e = crate::maria_local::estado();
    Cuenta {
        provider: "local".into(),
        label: "Modelo local".into(),
        tipo: TipoAcceso::Local,
        account: String::new(),
        source: "corre en este ordenador".into(),
        key_tail: String::new(),
        warnings: if e.installed {
            Vec::new()
        } else {
            vec!["Ollama no está instalado: sin modelo local no hay red de seguridad".into()]
        },
    }
}

/// Informe completo de cuentas y claves.
#[must_use]
pub fn informe() -> InformeCuentas {
    let home = dirs::home_dir().unwrap_or_default();
    let cuentas = vec![
        cuenta_claude(&home),
        cuenta_codex(&home),
        cuenta_gemini(&home),
        cuenta_local(),
    ];
    let correos = correos_distintos(&cuentas);
    let mut warnings = Vec::new();
    if correos.len() > 1 {
        warnings.push(format!(
            "Hay {} correos distintos conectados ({}). Comprueba cuál usa cada proveedor antes \
             de trabajar.",
            correos.len(),
            correos.join(", ")
        ));
    }
    InformeCuentas {
        cuentas,
        correos,
        warnings,
    }
}

#[tauri::command]
pub async fn maria_cuentas_informe() -> Result<InformeCuentas, String> {
    tauri::async_runtime::spawn_blocking(informe)
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn encuentra_el_correo_donde_lo_ponga_cada_cli() {
        for (v, esperado) in [
            (json!({"email": "yo@ejemplo.com"}), "yo@ejemplo.com"),
            (json!({"account": {"email": "a@b.c"}}), "a@b.c"),
            (json!({"oauthAccount": {"emailAddress": "x@y.z"}}), "x@y.z"),
            (json!({"active_account": "cuenta@google.com"}), "cuenta@google.com"),
        ] {
            assert_eq!(correo_en(&v).map(|(c, _)| c).as_deref(), Some(esperado));
        }
    }

    #[test]
    fn encuentra_la_cuenta_activa_de_gemini() {
        // Forma real de ~/.gemini/google_accounts.json.
        let v = json!({"active": "yo@gmail.com", "old": ["otro@gmail.com"]});
        assert_eq!(correo_en(&v).map(|(c, _)| c).as_deref(), Some("yo@gmail.com"));
    }

    #[test]
    fn no_se_inventa_un_correo_cuando_no_lo_hay() {
        // Caso negativo: enseñar una cuenta equivocada es peor que decir que no
        // se sabe — el usuario quiere esto justo para no confundirse de cuenta.
        for v in [
            json!({}),
            json!({"email": ""}),
            json!({"email": "   "}),
            json!({"token": "sk-secreto"}),
            json!({"account": {"id": 42}}),
        ] {
            assert!(correo_en(&v).is_none(), "se invento algo con {v}");
        }
    }

    #[test]
    fn saca_el_correo_del_id_token() {
        // JWT de mentira: cabecera.payload.firma, payload con el correo.
        use base64::Engine;
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"email":"jose@ejemplo.com","sub":"123"}"#);
        let jwt = format!("cabecera.{payload}.firma");
        assert_eq!(correo_en_jwt(&jwt).as_deref(), Some("jose@ejemplo.com"));
    }

    #[test]
    fn un_token_roto_no_produce_correo() {
        // Caso negativo: basura, un token sin payload o un payload que no es
        // JSON no pueden acabar pintando una cuenta.
        for malo in ["", "solo-una-parte", "a.no-es-base64!.c", "a.YWJj.c"] {
            assert!(correo_en_jwt(malo).is_none(), "colo: {malo}");
        }
    }

    #[test]
    fn de_una_clave_solo_salen_cuatro_caracteres() {
        assert_eq!(cola_de_clave("sk-ant-api03-ABCDEFGH1234"), "…1234");
        assert_eq!(cola_de_clave(""), "");
    }

    #[test]
    fn una_clave_muy_corta_se_tapa_entera() {
        // Caso negativo: con "abc" un "…abc" seria la clave completa.
        assert_eq!(cola_de_clave("abc"), "•••");
        assert_eq!(cola_de_clave("ab"), "••");
    }

    fn cuenta(correo: &str) -> Cuenta {
        Cuenta {
            provider: "x".into(),
            label: "X".into(),
            tipo: TipoAcceso::Suscripcion,
            account: correo.into(),
            source: String::new(),
            key_tail: String::new(),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn detecta_que_hay_varios_correos() {
        let cs = vec![cuenta("yo@a.com"), cuenta("companero@b.com"), cuenta("YO@a.com")];
        // El mismo correo en distinta caja no cuenta dos veces.
        assert_eq!(correos_distintos(&cs), vec!["yo@a.com", "companero@b.com"]);
    }

    #[test]
    fn lo_que_no_es_un_correo_no_cuenta_como_cuenta() {
        // Caso negativo: un id o un texto suelto no puede disparar el aviso de
        // "tienes dos cuentas".
        let cs = vec![cuenta(""), cuenta("   "), cuenta("usuario-123")];
        assert!(correos_distintos(&cs).is_empty());
    }

    /// Comprobacion manual contra la maquina real. Se lanza a mano con
    /// `cargo test --lib -- --ignored --nocapture informe_real` porque su
    /// resultado depende de con que cuentas estes dentro ahora mismo.
    /// Enmascara el correo: sirve para ver que SE DETECTA, no para leerlo.
    #[test]
    #[ignore]
    fn informe_real() {
        let i = informe();
        for c in &i.cuentas {
            let correo = if c.account.contains('@') {
                let (u, d) = c.account.split_once('@').unwrap();
                format!("{}***@{d}", u.chars().take(2).collect::<String>())
            } else if c.account.is_empty() {
                "(no expuesto)".into()
            } else {
                "(id, no correo)".into()
            };
            println!(
                "{:<8} tipo={:?} cuenta={} clave={} avisos={}",
                c.provider,
                c.tipo,
                correo,
                if c.key_tail.is_empty() { "-" } else { &c.key_tail },
                c.warnings.len()
            );
            for w in &c.warnings {
                println!("         aviso: {w}");
            }
        }
        println!("correos distintos: {}", i.correos.len());
        for w in &i.warnings {
            println!("GLOBAL: {w}");
        }
    }

    #[test]
    fn el_informe_cubre_los_cuatro_proveedores_y_no_filtra_nada() {
        let i = informe();
        let ids: Vec<&str> = i.cuentas.iter().map(|c| c.provider.as_str()).collect();
        assert_eq!(ids, vec!["claude", "codex", "gemini", "local"]);
        for c in &i.cuentas {
            // Nada que se parezca a un token puede salir de aqui.
            assert!(c.key_tail.chars().count() <= 5, "cola larga: {}", c.key_tail);
            assert!(!c.account.contains("sk-"), "parece una clave: {}", c.account);
        }
    }
}
