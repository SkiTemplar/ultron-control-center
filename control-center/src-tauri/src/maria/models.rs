// mar.ia — catalogo de modelos y esfuerzo por proveedor.
//
// El usuario pidio (2026-09-18) saber SIEMPRE con que modelo le estan
// contestando —"si es una pregunta tonta, que tire con haiku, pero si es una
// gran cosa, que tire de opus"— y con cuanto esfuerzo, poder cambiarlo a mano
// y que, por defecto, lo decida el modelo local.
//
// El 2026-09-22 lo amplio: "debe saber la suscripcion que tengo de cada
// proveedor y ponerme los modelos que me permite acceder con esa suscripcion,
// y sus modelos, ya que podria querer un opus 5, o un 4.6". Eso no cabia en
// una constante: el catalogo pasa a ser el resultado de FUNDIR tres capas.
//
//   1. lo conocido de casa           — esta lista, con etiquetas en cristiano
//   2. lo que dice la suscripcion    — `maria/suscripcion.rs`, cacheado en disco
//   3. el ultimo veredicto REAL      — lo que contesto o rechazo el proveedor
//
// Manda el veredicto real, luego la suscripcion, y lo que no sabe nadie se
// queda en "desconocido" — que se ENSEÑA como desconocido, no como prohibido.
//
// LIMITE DECLARADO (mandamiento 13): el esfuerzo NO se controla igual en
// todas partes.
//   * claude — bandera real (`--effort low|medium|high`). Existe desde hace
//              versiones; el comentario que decia que no habia bandera y que
//              se pedia en el prompt estaba OBSOLETO (comprobado en esta
//              maquina con `claude --help`, 2026-09-22).
//   * codex  — bandera real (`-c model_reasoning_effort=...`).
//   * agy    — el nivel va DENTRO del id (`-low` / `-medium` / `-high`).
//   * local  — se traduce a `think` (razonar si/no) en la llamada a Ollama.
// La interfaz enseña exactamente esto, sin fingir un control que no existe.

use serde::{Deserialize, Serialize};

/// Nivel de esfuerzo pedido.
pub const ESFUERZOS: &[&str] = &["bajo", "medio", "alto"];

/// Un rechazo real CADUCA: pasado el plazo el modelo vuelve a "desconocido".
///
/// Sin esta caducidad estariamos clavando justo lo que se queria evitar: un
/// modelo que la cuenta gane mas adelante se quedaria muerto para siempre.
pub const CADUCA_RECHAZO_DIAS: i64 = 7;

/// Cuanto vale el catalogo fundido antes de volver a leer las caches.
const FRESCURA: std::time::Duration = std::time::Duration::from_secs(30);

/// Como se le comunica el esfuerzo a un proveedor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
pub enum ModoEsfuerzo {
    /// Bandera de la CLI (control real).
    Bandera,
    /// Se pide dentro del prompt. Hoy no lo usa nadie: se deja porque es el
    /// unico recurso si algun proveedor futuro no expone bandera.
    EnElPrompt,
    /// Se traduce a razonar si/no (Ollama `think`).
    Razonamiento,
    /// El proveedor no lo expone.
    #[default]
    SinControl,
}

/// Lo que se sabe de si la cuenta admite ese modelo.
///
/// `No` SOLO con evidencia: un rechazo real y sin caducar, un `entitled:false`
/// en la cache de Claude, o la ausencia del catalogo vivo que la CLI deja para
/// ESTA cuenta. Lo demas es `Desconocido` — que no es lo mismo que prohibido, y
/// la interfaz lo tiene que distinguir.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Permitido {
    Si,
    No,
    #[default]
    Desconocido,
}

/// De donde salio el id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Origen {
    /// Escrito en este fichero.
    #[default]
    Casa,
    /// Lo publica la suscripcion del usuario.
    Suscripcion,
}

/// Un modelo elegible.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ModeloInfo {
    /// Lo que se le pasa a la CLI.
    pub id: String,
    /// Como se enseña en la interfaz.
    pub label: String,
    /// Para que sirve, en una linea. Es lo que lee el modelo local al elegir.
    pub para: String,
    /// Si la cuenta lo admite, con lo que se sepa.
    #[serde(default)]
    pub permitido: Permitido,
    /// Una frase para el tooltip. JAMAS un token.
    #[serde(default)]
    pub motivo: String,
    /// RFC 3339 de cuando se supo. Vacio = nunca.
    #[serde(default)]
    pub visto: String,
    #[serde(default)]
    pub origen: Origen,
}

/// Catalogo de un proveedor.
#[derive(Debug, Clone, Default, Serialize)]
pub struct CatalogoProveedor {
    pub provider: String,
    pub models: Vec<ModeloInfo>,
    /// El que se usa si nadie elige.
    pub default_model: String,
    pub effort_mode: ModoEsfuerzo,
    /// Por que la lista es la que es. Se ensena junto al selector.
    ///
    /// Existe porque una lista corta parece un error y no lo es: el usuario
    /// reporto el 2026-09-21 "de codex solo sale el terra" pensando que
    /// faltaban modelos. Faltan, pero porque su cuenta no los admite, y eso
    /// hay que decirlo donde se ve la lista.
    #[serde(default)]
    pub nota: String,
    /// Plan detectado ("Claude Pro", "ChatGPT Free"). Vacio = no se sabe.
    #[serde(default)]
    pub plan: String,
    /// Fichero y campo (o comando) de donde salio el plan.
    #[serde(default)]
    pub plan_origen: String,
    /// RFC 3339 del ultimo sondeo. Vacio = solo hay catalogo de casa.
    #[serde(default)]
    pub refrescado: String,
}

/// Eleccion completa para un turno.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Eleccion {
    pub provider: String,
    /// Vacio = el que traiga la CLI por defecto.
    #[serde(default)]
    pub model: String,
    /// "bajo" | "medio" | "alto". Vacio = medio.
    #[serde(default)]
    pub effort: String,
}

fn m(id: &str, label: &str, para: &str) -> ModeloInfo {
    ModeloInfo {
        id: id.into(),
        label: label.into(),
        para: para.into(),
        ..ModeloInfo::default()
    }
}

/// Todo lo elegible de casa, por proveedor. PURA: no toca disco ni procesos.
///
/// Para Claude hay dos clases de entrada a proposito:
///   * los ALIAS (`opus`, `sonnet`, `haiku`, `fable`) — no caducan nunca y
///     siguen apuntando a la version vigente cuando sale la siguiente. Es la
///     eleccion sana y por eso van primero.
///   * los IDS COMPLETOS conocidos — porque el usuario pidio poder decir
///     exactamente "un Opus 5" o "un 4.6", y con un alias eso no se puede.
///     Estos SI caducan, y por eso no se les da estado: lo decide `fundir` con
///     lo que diga la cuenta o lo que contestara la ultima vez.
#[must_use]
pub fn catalogo() -> Vec<CatalogoProveedor> {
    vec![
        CatalogoProveedor {
            provider: "claude".into(),
            models: vec![
                m(
                    "opus",
                    "Opus (el Opus vigente)",
                    "arquitectura, problemas dificiles, textos largos",
                ),
                m(
                    "sonnet",
                    "Sonnet (el Sonnet vigente)",
                    "trabajo normal de codigo y texto",
                ),
                m(
                    "haiku",
                    "Haiku (el Haiku vigente)",
                    "preguntas cortas, resumenes, cosas triviales",
                ),
                m(
                    "fable",
                    "Fable (el Fable vigente)",
                    "lo mas capaz: tareas largas y dificiles; puede pedir creditos",
                ),
                // Lista de RESPALDO: solo se usa hasta que se lee la tabla de
                // modelos de la CLI instalada (`suscripcion::modelos_de_la_cli`,
                // al arrancar y con /modelos). Desde el 2026-09-23 la lista
                // buena sale de ahi y no de aqui.
                m(
                    "claude-opus-5-5",
                    "Opus 5.5",
                    "el Opus de hoy, clavado a esta version",
                ),
                m(
                    "claude-opus-5",
                    "Opus 5",
                    "el Opus anterior, clavado a esta version",
                ),
                m(
                    "claude-opus-4-6",
                    "Opus 4.6",
                    "el Opus anterior, por si prefieres su forma de responder",
                ),
                m("claude-sonnet-5", "Sonnet 5", "el Sonnet de hoy, clavado"),
                m("claude-sonnet-4-6", "Sonnet 4.6", "el Sonnet anterior"),
                m("claude-haiku-4-5", "Haiku 4.5", "el Haiku de hoy, clavado"),
                m(
                    "claude-fable-5-1",
                    "Fable 5.1",
                    "el Fable de hoy; con 1M de contexto sale aparte si tu cuenta lo ofrece",
                ),
            ],
            // Alias, no id con fecha: el por defecto es lo unico que se usa
            // cuando nadie elige, y no puede caducar.
            default_model: "sonnet".into(),
            effort_mode: ModoEsfuerzo::Bandera,
            nota: "Los cuatro primeros son alias: siempre apuntan a la versión vigente. Los de \
                   abajo son versiones concretas y sí pueden dejar de existir."
                .into(),
            ..CatalogoProveedor::default()
        },
        CatalogoProveedor {
            provider: "codex".into(),
            // OJO con clavar un modelo aqui: con una cuenta de ChatGPT (la
            // suscripcion, no la API) el servidor RECHAZA los ids que no
            // toquen. Medido el 2026-09-20:
            //
            //   -m gpt-5-codex -> 400 "not supported when using Codex with a
            //                     ChatGPT account"
            //   -m gpt-5       -> 400, lo mismo
            //   sin -m         -> contesta
            //
            // Eso es lo que tenia el relevo dando error en Codex. Por eso el
            // modelo por defecto es VACIO: sin `-m`, la CLI usa el que tenga
            // vigente y esto no vuelve a caducar solo.
            models: vec![m(
                "gpt-5.6-terra",
                "gpt-5.6 terra",
                "el que trae la CLI hoy; si algun dia da error 400, deja el automatico",
            )],
            default_model: String::new(),
            effort_mode: ModoEsfuerzo::Bandera,
            nota: "Con una cuenta de ChatGPT (suscripción) la CLI solo acepta los modelos que el \
                   servidor sirve a tu cuenta: el resto devuelve error 400. No falta nada: es el \
                   límite de la cuenta."
                .into(),
            ..CatalogoProveedor::default()
        },
        CatalogoProveedor {
            // Antigravity (`agy`) sustituye a Gemini desde el 2026-09-20:
            // misma familia de modelos de Google, pero por la suscripcion que
            // el usuario tiene viva.
            provider: "antigravity".into(),
            models: vec![
                m(
                    "gemini-3.8-flash-medium",
                    "Gemini 3.8 Flash",
                    "rapido y barato: busquedas, resumenes",
                ),
                m(
                    "gemini-3.1-pro-high",
                    "Gemini 3.1 Pro",
                    "documentos largos y analisis, mas lento",
                ),
            ],
            // Vacio = el que traiga la CLI. Mismo motivo que en Codex.
            default_model: String::new(),
            // El nivel de esfuerzo va DENTRO del id del modelo
            // (`-low` / `-medium` / `-high`), asi que no se manda bandera
            // aparte: se elige eligiendo modelo.
            effort_mode: ModoEsfuerzo::SinControl,
            // Los Claude que sirve Antigravity SE ENSEÑAN desde el 2026-09-22.
            // Antes se escondian "para no gastar la misma cuota por dos
            // caminos", y esa razon era FALSA: por aqui se gasta la cuota de
            // Google, no la de Anthropic. Ademas es el unico sitio de todo el
            // sistema donde hay un Opus 4.6 — Claude Code sirve Opus 5 y
            // Fable, no 4.6 — asi que esconderlos dejaba al usuario sin la
            // unica ruta a lo que pedia.
            nota: "La lista sale de `agy models`, ya filtrada por tu cuenta. Los Claude que \
                   aparecen aquí van por Google: gastan la cuota de Google, no la de Claude."
                .into(),
            ..CatalogoProveedor::default()
        },
        CatalogoProveedor {
            provider: "local".into(),
            // El modelo local es el que haya instalado: se resuelve en
            // caliente con `base_viva()`, no se clava aqui.
            models: Vec::new(),
            default_model: String::new(),
            effort_mode: ModoEsfuerzo::Razonamiento,
            ..CatalogoProveedor::default()
        },
    ]
}

/// ¿Tiene forma de id de modelo? Letras, digitos, `-`, `.`, `:`, `_`, con el
/// sufijo `[1m]` opcional; de 1 a 64 caracteres.
///
/// Existe porque estos ids ya NO los escribe un humano en este fichero: llegan
/// de un JSON de cache o de la salida de una CLI y acaban en `Command::args`
/// (cli.rs), a veces a traves de `cmd /C`. Sin esta guarda, una linea rara en
/// ese fichero seria un argumento de proceso. Pura.
#[must_use]
pub fn id_con_forma_de_modelo(id: &str) -> bool {
    let n = id.chars().count();
    if n == 0 || n > 64 {
        return false;
    }
    let base = if id.to_lowercase().ends_with("[1m]") {
        &id[..id.len() - 4]
    } else {
        id
    };
    // El primero tiene que ser letra o digito: un id que empiece por '-'
    // tiene forma de bandera, y es justo lo que esta guarda existe para no
    // dejar llegar a `Command::args` (revision del 2026-09-22: colaba
    // `--dangerously-skip-permissions`).
    base.chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
        && base
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | ':' | '_'))
}

/// Primera letra en mayuscula, con las siglas que se escriben enteras.
fn palabra(p: &str) -> String {
    match p {
        "gpt" => return "GPT".into(),
        "oss" => return "OSS".into(),
        "ai" => return "AI".into(),
        _ => {}
    }
    // "120b" -> "120B": un numero con letra pegada es un tamaño, y en
    // minuscula se lee fatal.
    if p.chars().next().is_some_and(|c| c.is_ascii_digit()) && p.chars().any(|c| c.is_alphabetic())
    {
        return p.to_uppercase();
    }
    let mut cs = p.chars();
    match cs.next() {
        Some(c) => c.to_uppercase().collect::<String>() + cs.as_str(),
        None => String::new(),
    }
}

/// Etiqueta legible para un id que llega sin etiqueta.
///
/// `claude-opus-4-6` -> "Claude Opus 4.6"; `gemini-3.1-pro-high` -> "Gemini 3.1
/// Pro (High)". Si no sabe interpretarlo devuelve el id tal cual: nunca vacio.
/// Pura.
#[must_use]
pub fn etiqueta_humana(id: &str) -> String {
    let bajo = id.trim().to_lowercase();
    let (base, un_millon) = match bajo.strip_suffix("[1m]") {
        Some(b) => (b.to_string(), true),
        None => (bajo.clone(), false),
    };
    let piezas: Vec<&str> = base.split(['-', '_']).filter(|p| !p.is_empty()).collect();
    if piezas.is_empty() {
        return id.to_string();
    }
    const MATICES: &[&str] = &["high", "medium", "low", "thinking"];
    let mut palabras: Vec<String> = Vec::new();
    let mut cola: Vec<String> = Vec::new();
    let mut i = 0;
    while i < piezas.len() {
        let p = piezas[i];
        // Solo al final: "medium" en medio de un id es parte del nombre.
        if i + 1 == piezas.len() && MATICES.contains(&p) {
            cola.push(palabra(p));
            i += 1;
            continue;
        }
        if p == "gpt" && piezas.get(i + 1) == Some(&"oss") {
            palabras.push("GPT-OSS".into());
            i += 2;
            continue;
        }
        if p.chars().all(|c| c.is_ascii_digit()) {
            // Una tirada de numeros sueltos es una version partida por guiones:
            // `4-6` es 4.6, no "4 6".
            let mut version = vec![p.to_string()];
            while i + 1 < piezas.len() && piezas[i + 1].chars().all(|c| c.is_ascii_digit()) {
                version.push(piezas[i + 1].to_string());
                i += 1;
            }
            palabras.push(version.join("."));
            i += 1;
            continue;
        }
        palabras.push(palabra(p));
        i += 1;
    }
    let mut out = palabras.join(" ");
    for c in cola {
        out.push_str(&format!(" ({c})"));
    }
    if un_millon {
        out.push_str(" (1M)");
    }
    if out.trim().is_empty() {
        id.to_string()
    } else {
        out
    }
}

/// El dia de una marca RFC 3339, en corto y en local ("22/09"). Vacio si no se
/// entiende: mejor callarse la fecha que inventarla.
fn dia_corto(rfc: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(rfc.trim())
        .map(|d| d.with_timezone(&chrono::Local).format("%d/%m").to_string())
        .unwrap_or_default()
}

/// Estado de un id concreto, con el orden de mando de la cabecera.
fn estado_de(
    id: &str,
    sub: Option<&crate::maria::suscripcion::Suscripcion>,
    veredictos: Option<&std::collections::BTreeMap<String, crate::maria::suscripcion::Veredicto>>,
    cerrado: bool,
    ahora: chrono::DateTime<chrono::Utc>,
) -> (Permitido, String, String) {
    // 0 — un veto explicito de la cuenta (entitled:false) manda sobre
    // cualquier «contesto de verdad» anterior: es la unica evidencia de veto
    // que Claude deja en disco y un OK viejo no la desmiente (revision del
    // 2026-09-22: antes un OK de hace meses ganaba al veto de hoy).
    if let Some(s) = sub {
        if s.vetados.iter().any(|x| x == id) {
            return (
                Permitido::No,
                "tu cuenta lo tiene vetado (entitled:false)".into(),
                s.at.clone(),
            );
        }
    }
    // Un sondeo de la suscripcion POSTERIOR a un rechazo lo deja sin efecto:
    // es lo que hacen /modelos y «actualizar modelos». Sin esto, un 404 de
    // hace una hora seguia mandando siete dias sobre la lista recien leida y
    // la interfaz mentia al decir que refrescar lo arreglaba.
    let sondeo = sub
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s.at.trim()).ok())
        .map(|d| d.with_timezone(&chrono::Utc));
    // 1 y 2 — lo que paso DE VERDAD con ese id manda sobre cualquier lista.
    if let Some(v) = veredictos.and_then(|m| m.get(id)) {
        let cuando = chrono::DateTime::parse_from_rfc3339(v.at.trim())
            .ok()
            .map(|d| d.with_timezone(&chrono::Utc));
        if v.estado == "rechazado" {
            // Un rechazo sin fecha entendible se trata como caducado: clavar
            // un modelo para siempre por una marca ilegible seria peor.
            let vigente = cuando.is_some_and(|c| {
                ahora.signed_duration_since(c) < chrono::Duration::days(CADUCA_RECHAZO_DIAS)
            });
            let superado = cuando.zip(sondeo).is_some_and(|(c, s)| s > c);
            if vigente && !superado {
                let dia = dia_corto(&v.at);
                let motivo = if v.detalle.trim().is_empty() {
                    format!("lo rechazó tu cuenta el {dia}")
                } else {
                    format!("rechazado por la cuenta el {dia}: {}", v.detalle.trim())
                };
                return (
                    Permitido::No,
                    crate::maria::relay::recorta(&motivo, 200),
                    v.at.clone(),
                );
            }
        } else if v.estado == "ok" {
            let dia = dia_corto(&v.at);
            return (
                Permitido::Si,
                format!("contestó de verdad el {dia}"),
                v.at.clone(),
            );
        }
    }
    // 3 — lo que diga la suscripcion (el veto ya se ha mirado arriba).
    if let Some(s) = sub {
        if s.permitidos.iter().any(|x| x == id) {
            let motivo = if s.plan.is_empty() {
                "tu cuenta lo sirve hoy".to_string()
            } else {
                format!("tu cuenta lo sirve hoy ({})", s.plan)
            };
            return (Permitido::Si, motivo, s.at.clone());
        }
        if cerrado {
            return (
                Permitido::No,
                "no está en el catálogo que tu cuenta sirve hoy".into(),
                s.at.clone(),
            );
        }
    }
    // 4 — nadie sabe nada. Y se dice asi.
    (Permitido::Desconocido, String::new(), String::new())
}

/// ¿Es un modelo de Anthropic servido por otro? Para avisar de que cuota gasta.
fn es_de_anthropic(id: &str) -> bool {
    let t = id.to_lowercase();
    t.contains("claude") || t.contains("opus") || t.contains("sonnet") || t.contains("haiku")
}

/// Funde lo conocido de casa con lo que dice la suscripcion y con lo ultimo
/// que contesto el proveedor de verdad.
///
/// Orden de mando, de mas fuerte a mas debil:
///   1. rechazo REAL y no caducado de ese id  -> Permitido::No
///   2. respuesta OK real de ese id           -> Permitido::Si
///   3. lo que diga la suscripcion            -> Si / No
///   4. nada de lo anterior                   -> Desconocido
///
/// Pura: recibe el ahora y las dos caches, asi que se prueba entera sin tocar
/// disco. Si las caches vienen vacias devuelve EXACTAMENTE el catalogo de casa,
/// que es la degradacion obligatoria.
#[must_use]
pub fn fundir(
    base: Vec<CatalogoProveedor>,
    subs: &std::collections::BTreeMap<String, crate::maria::suscripcion::Suscripcion>,
    veredictos: &crate::maria::suscripcion::Veredictos,
    ahora: chrono::DateTime<chrono::Utc>,
) -> Vec<CatalogoProveedor> {
    base.into_iter()
        .map(|mut c| {
            let proveedor = c.provider.clone();
            let sub = subs.get(&proveedor);
            if let Some(s) = sub {
                c.plan.clone_from(&s.plan);
                c.plan_origen.clone_from(&s.origen);
                c.refrescado.clone_from(&s.at);
                if !s.nota.is_empty() {
                    c.nota = if c.nota.is_empty() {
                        s.nota.clone()
                    } else {
                        format!("{} {}", s.nota, c.nota)
                    };
                }
                for id in &s.permitidos {
                    // La guarda de forma se aplica AQUI, que es por donde
                    // entra lo que no ha escrito un humano.
                    if !id_con_forma_de_modelo(id) || c.models.iter().any(|x| x.id == *id) {
                        continue;
                    }
                    let para = if proveedor == "antigravity" && es_de_anthropic(id) {
                        "vía Google: gasta la cuota de Google, no la de Claude".to_string()
                    } else {
                        String::new()
                    };
                    c.models.push(ModeloInfo {
                        id: id.clone(),
                        label: etiqueta_humana(id),
                        para,
                        origen: Origen::Suscripcion,
                        ..ModeloInfo::default()
                    });
                }
            }
            // En codex y agy la lista de la cuenta es CERRADA: lo que no esta,
            // el servidor lo rechaza. En claude NO: su cache solo trae los
            // modelos EXTRA que ofrece el servidor, asi que no estar ahi no
            // prueba nada — y tratar la ausencia como veto apagaria los alias.
            let cerrado = matches!(proveedor.as_str(), "codex" | "antigravity")
                && sub.is_some_and(|s| !s.permitidos.is_empty());
            let del_proveedor = veredictos.get(&proveedor);
            for modelo in &mut c.models {
                let (p, motivo, visto) = estado_de(&modelo.id, sub, del_proveedor, cerrado, ahora);
                modelo.permitido = p;
                modelo.motivo = motivo;
                modelo.visto = visto;
            }
            c
        })
        .collect()
}

/// Catalogo de casa con el modelo local real relleno.
/// Familias que NO se ofrecen desde la tabla de la CLI. Mythos va por
/// aprobacion de la organizacion (404 medido en esta cuenta el 2026-09-22):
/// si el servidor se lo ofrece a la cuenta, entra por
/// `additionalModelOptionsCache` como cualquier extra.
const FAMILIAS_OCULTAS: &[&str] = &["mythos"];
/// Orden de las familias en el selector; una familia nueva va detras.
const ORDEN_FAMILIAS: &[&str] = &["fable", "opus", "sonnet", "haiku"];

/// Numeros de version de un id, para ordenar: "claude-opus-5-5" -> [5, 5].
fn version(id: &str) -> Vec<u32> {
    id.split('-')
        .filter_map(|p| p.parse::<u32>().ok())
        .collect()
}

/// Los modelos de Claude que ofrece el selector, a partir de la tabla de la CLI
/// instalada: por familia y de mas nuevo a mas viejo, sin la generacion 3.x
/// (legado) ni las familias ocultas. Pura.
///
/// Es lo que hace que un modelo nuevo aparezca SOLO al actualizar Claude Code
/// (2026-09-23: Opus 5.5 no salia porque la lista estaba escrita a mano).
#[must_use]
pub fn modelos_desde_la_cli(cli: &[crate::maria::suscripcion::ModeloCli]) -> Vec<ModeloInfo> {
    let mut vistos: Vec<&crate::maria::suscripcion::ModeloCli> = cli
        .iter()
        .filter(|m| !FAMILIAS_OCULTAS.contains(&m.familia.as_str()))
        .filter(|m| !m.id.starts_with("claude-3"))
        .filter(|m| id_con_forma_de_modelo(&m.id))
        .collect();
    let rango = |f: &str| {
        ORDEN_FAMILIAS
            .iter()
            .position(|x| *x == f)
            .unwrap_or(ORDEN_FAMILIAS.len())
    };
    vistos.sort_by(|a, b| {
        rango(&a.familia)
            .cmp(&rango(&b.familia))
            .then_with(|| a.familia.cmp(&b.familia))
            .then_with(|| version(&b.id).cmp(&version(&a.id)))
    });
    let mut out = Vec::new();
    let mut familia_anterior = String::new();
    for m in vistos {
        let para = if m.familia == familia_anterior {
            "version anterior, clavada".to_string()
        } else {
            format!("lo mas nuevo de {} en tu Claude Code, clavado", m.familia)
        };
        familia_anterior.clone_from(&m.familia);
        out.push(ModeloInfo {
            id: m.id.clone(),
            label: m.etiqueta.clone(),
            para,
            origen: Origen::Casa,
            ..ModeloInfo::default()
        });
    }
    out
}

fn base_viva() -> Vec<CatalogoProveedor> {
    let local = crate::ollama::toggle::model_name();
    let de_la_cli = modelos_desde_la_cli(&crate::maria::suscripcion::modelos_cli_cacheados());
    catalogo()
        .into_iter()
        .map(|mut c| {
            if c.provider == "claude" && !de_la_cli.is_empty() {
                // Quedan los alias (no caducan) y el resto sale de la CLI.
                c.models.retain(|m| !m.id.starts_with("claude-"));
                c.models.extend(de_la_cli.iter().cloned());
            }
            if c.provider == "local" && !local.is_empty() {
                c.models = vec![m(&local, &local, "gratis y sin cuota; el mas flojo")];
                c.default_model.clone_from(&local);
                c.plan = "Ollama local".into();
                c.plan_origen = "ollama (el modelo instalado en esta máquina)".into();
            }
            c
        })
        .collect()
}

/// Lo de casa, la suscripcion y los veredictos, ya fundidos.
///
/// MEMOIZADO 30 s: esto se llama varias veces por turno (`modelo_valido`,
/// `modelo_por_defecto`, el selector) y cada llamada lee dos ficheros y
/// pregunta a Ollama por el modelo instalado. `invalidar()` lo tira cuando
/// algo cambia de verdad.
#[must_use]
pub fn catalogo_vivo() -> Vec<CatalogoProveedor> {
    if let Ok(g) = memoria().lock() {
        if let Some((cuando, v)) = g.as_ref() {
            if cuando.elapsed() < FRESCURA {
                return v.clone();
            }
        }
    }
    let fresco = fundir(
        base_viva(),
        &crate::maria::suscripcion::cache(),
        &crate::maria::suscripcion::veredictos(),
        chrono::Utc::now(),
    );
    if let Ok(mut g) = memoria().lock() {
        *g = Some((std::time::Instant::now(), fresco.clone()));
    }
    fresco
}

type Memoria = std::sync::Mutex<Option<(std::time::Instant, Vec<CatalogoProveedor>)>>;

/// El candado del catalogo memoizado. En una funcion —y no como `static`
/// dentro de `catalogo_vivo`— para que `invalidar()` vacie EL MISMO, que es
/// justo el fallo que tendria dos `static` con el mismo nombre en dos sitios.
fn memoria() -> &'static Memoria {
    static VIVO: Memoria = std::sync::Mutex::new(None);
    &VIVO
}

/// Tira el catalogo memoizado. La llaman `suscripcion::anotar` y `::refrescar`.
pub(crate) fn invalidar() {
    // Se vuelve a calcular en la primera lectura; no hace falta hacerlo aqui.
    if let Ok(mut g) = memoria().lock() {
        *g = None;
    }
}

/// ¿Ese modelo se le puede pedir a ese proveedor?
///
/// Sigue siendo LISTA BLANCA —el identificador acaba en la linea de comandos de
/// una CLI— pero la lista ya no es solo la de casa: es la de casa mas la que
/// publica la suscripcion. Lo marcado como rechazado NO pasa: repetirlo solo
/// gasta un turno para volver a oir que no.
#[must_use]
pub fn modelo_valido(provider: &str, model: &str) -> bool {
    if model.is_empty() {
        return true; // vacio = el de por defecto de la CLI
    }
    catalogo_vivo()
        .iter()
        .find(|c| c.provider == provider)
        .is_some_and(|c| {
            c.models
                .iter()
                .any(|mm| mm.id == model && mm.permitido != Permitido::No)
        })
}

/// Como esta ese id para ese proveedor, con el motivo.
///
/// Para poder decir "rechazado por la cuenta el 22/09" en vez de cambiar el
/// modelo por el de por defecto EN SILENCIO, que es lo que pasaba hasta hoy.
#[must_use]
pub fn estado_modelo(provider: &str, model: &str) -> (Permitido, String) {
    if model.trim().is_empty() {
        return (Permitido::Si, "el modelo que traiga la CLI".into());
    }
    catalogo_vivo()
        .iter()
        .find(|c| c.provider == provider)
        .and_then(|c| c.models.iter().find(|mm| mm.id == model).cloned())
        .map_or_else(
            || {
                (
                    Permitido::Desconocido,
                    format!("«{model}» no está en el catálogo de {provider} que conoce mar.ia"),
                )
            },
            |mm| (mm.permitido, mm.motivo),
        )
}

/// Normaliza el esfuerzo. Cualquier cosa rara cae a "medio": es el punto
/// medio, no el mas caro.
#[must_use]
pub fn normaliza_esfuerzo(raw: &str) -> String {
    let limpio = raw.trim().to_lowercase();
    match limpio.as_str() {
        "bajo" | "low" | "minimo" | "minimal" => "bajo".into(),
        "alto" | "high" | "max" | "maximo" => "alto".into(),
        _ => "medio".into(),
    }
}

/// El nivel tal y como lo escriben las CLI que tienen bandera.
fn nivel_ingles(effort: &str) -> &'static str {
    match normaliza_esfuerzo(effort).as_str() {
        "bajo" => "low",
        "alto" => "high",
        _ => "medium",
    }
}

/// Modo de esfuerzo de un proveedor.
#[must_use]
pub fn modo_esfuerzo(provider: &str) -> ModoEsfuerzo {
    catalogo()
        .iter()
        .find(|c| c.provider == provider)
        .map_or(ModoEsfuerzo::SinControl, |c| c.effort_mode)
}

/// Modelo por defecto de un proveedor.
#[must_use]
pub fn modelo_por_defecto(provider: &str) -> String {
    catalogo_vivo()
        .iter()
        .find(|c| c.provider == provider)
        .map(|c| c.default_model.clone())
        .unwrap_or_default()
}

/// Argumentos extra de la CLI para modelo y esfuerzo.
///
/// Pura: se testea sin lanzar nada. Devuelve solo lo que ese proveedor
/// entiende de verdad — nada de banderas inventadas que la CLI rechazaria.
#[must_use]
pub fn argumentos(provider: &str, model: &str, effort: &str) -> Vec<String> {
    let mut args = Vec::new();
    match provider {
        "claude" => {
            if !model.is_empty() {
                args.push("--model".into());
                args.push(model.to_string());
            }
            // Bandera real desde hace versiones (`--effort <level>`, visto en
            // `claude --help` el 2026-09-22). Hasta hoy se le pedia el
            // esfuerzo METIENDO UNA FRASE EN EL PROMPT, que era una peticion y
            // no un control: ensuciaba el mensaje y el modelo podia ignorarla.
            args.push("--effort".into());
            args.push(nivel_ingles(effort).into());
        }
        "codex" => {
            if !model.is_empty() {
                args.push("-m".into());
                args.push(model.to_string());
            }
            args.push("-c".into());
            args.push(format!(
                "model_reasoning_effort=\"{}\"",
                nivel_ingles(effort)
            ));
        }
        "antigravity" => {
            if !model.is_empty() {
                args.push("--model".into());
                args.push(model.to_string());
            }
        }
        _ => {}
    }
    args
}

/// Argumentos para una sesion INTERACTIVA (la terminal embebida).
///
/// Solo el modelo: el esfuerzo en una sesion interactiva lo gobierna el propio
/// usuario desde dentro de la CLI, y clavarlo al abrirla le quitaria el mando.
#[must_use]
pub fn argumentos_interactivos(provider: &str, model: &str) -> Vec<String> {
    if model.is_empty() {
        return Vec::new();
    }
    match provider {
        "claude" | "antigravity" => vec!["--model".into(), model.to_string()],
        "codex" => vec!["-m".into(), model.to_string()],
        _ => Vec::new(),
    }
}

/// Prefijo que se antepone al prompt para pedir mas o menos reflexion.
///
/// Solo lo usan los proveedores con `ModoEsfuerzo::EnElPrompt`. Desde el
/// 2026-09-22 no hay ninguno —Claude tiene `--effort` de verdad— asi que
/// devuelve vacio siempre. Se queda porque es el unico recurso si aparece una
/// CLI sin bandera, y porque quitarlo obligaria a tocar `cli::ejecutar`.
#[must_use]
pub fn prefijo_esfuerzo(provider: &str, effort: &str) -> String {
    if modo_esfuerzo(provider) != ModoEsfuerzo::EnElPrompt {
        return String::new();
    }
    match normaliza_esfuerzo(effort).as_str() {
        "bajo" => "Responde directo y breve, sin desarrollar el razonamiento.\n\n".into(),
        "alto" => "think hard: analiza el problema a fondo antes de responder.\n\n".into(),
        _ => String::new(),
    }
}

/// ¿Debe el modelo local razonar en este turno?
#[must_use]
pub fn razonar_en_local(effort: &str) -> bool {
    normaliza_esfuerzo(effort) == "alto"
}

/// Lo que la interfaz necesita para pintar los selectores.
#[derive(Debug, Clone, Serialize)]
pub struct Catalogo {
    pub providers: Vec<CatalogoProveedor>,
    /// Niveles de esfuerzo, en orden. Viajan desde aqui para que la interfaz
    /// no tenga su propia lista que se desincronice de la de Rust.
    pub efforts: Vec<String>,
}

fn catalogo_para_la_pantalla() -> Catalogo {
    Catalogo {
        providers: catalogo_vivo(),
        efforts: ESFUERZOS.iter().map(|e| (*e).to_string()).collect(),
    }
}

#[tauri::command]
pub async fn maria_models_catalog() -> Result<Catalogo, String> {
    Ok(catalogo_para_la_pantalla())
}

/// Vuelve a preguntarle a cada proveedor que permite la cuenta.
///
/// Bloqueante (lee ficheros y lanza dos procesos), asi que va en
/// `spawn_blocking`. Es el boton "refrescar" del selector: el camino de un
/// turno NUNCA pasa por aqui.
#[tauri::command]
pub async fn maria_models_refrescar() -> Result<Catalogo, String> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::maria::suscripcion::refrescar();
        invalidar();
        catalogo_para_la_pantalla()
    })
    .await
    .map_err(|e| format!("spawn_blocking: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::maria::suscripcion::{Suscripcion, Suscripciones, Veredicto, Veredictos};
    use std::collections::BTreeMap;

    fn ahora() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-09-22T12:00:00Z")
            .expect("fecha")
            .with_timezone(&chrono::Utc)
    }

    fn hace(dias: i64) -> String {
        (ahora() - chrono::Duration::days(dias)).to_rfc3339()
    }

    fn sub(provider: &str, plan: &str, permitidos: &[&str], vetados: &[&str]) -> Suscripciones {
        let mut m = BTreeMap::new();
        m.insert(
            provider.to_string(),
            Suscripcion {
                provider: provider.into(),
                plan: plan.into(),
                origen: "fixture".into(),
                permitidos: permitidos.iter().map(|s| (*s).to_string()).collect(),
                vetados: vetados.iter().map(|s| (*s).to_string()).collect(),
                nota: String::new(),
                at: hace(0),
            },
        );
        m
    }

    fn veredicto(provider: &str, model: &str, estado: &str, detalle: &str, at: &str) -> Veredictos {
        let mut por_modelo = BTreeMap::new();
        por_modelo.insert(
            model.to_string(),
            Veredicto {
                estado: estado.into(),
                detalle: detalle.into(),
                at: at.into(),
            },
        );
        let mut m = BTreeMap::new();
        m.insert(provider.to_string(), por_modelo);
        m
    }

    fn de(cat: &[CatalogoProveedor], provider: &str) -> CatalogoProveedor {
        cat.iter()
            .find(|c| c.provider == provider)
            .unwrap_or_else(|| panic!("falta {provider}"))
            .clone()
    }

    fn modelo<'a>(c: &'a CatalogoProveedor, id: &str) -> &'a ModeloInfo {
        c.models
            .iter()
            .find(|m| m.id == id)
            .unwrap_or_else(|| panic!("falta {id} en {}", c.provider))
    }

    #[test]
    fn el_catalogo_cubre_los_cuatro_proveedores() {
        let ids: Vec<String> = catalogo().into_iter().map(|c| c.provider).collect();
        assert_eq!(ids, vec!["claude", "codex", "antigravity", "local"]);
    }

    #[test]
    fn ni_codex_ni_antigravity_clavan_un_modelo_por_defecto() {
        // Un id de modelo clavado CADUCA y entonces el proveedor entero deja de
        // responder. Paso el 2026-09-20: `-m gpt-5-codex` empezo a devolver
        // 400 ("not supported when using Codex with a ChatGPT account") y el
        // relevo daba error en Codex para cualquier pregunta.
        //
        // Con el modelo por defecto vacio no se manda `-m` y la CLI usa el
        // suyo, que siempre es uno vigente.
        for p in ["codex", "antigravity"] {
            let c = de(&catalogo(), p);
            assert!(
                c.default_model.is_empty(),
                "{p} clava el modelo {:?}: volvera a caducar",
                c.default_model
            );
        }
        // Claude si tiene por defecto, pero es un ALIAS: no caduca.
        let claude = de(&catalogo(), "claude");
        assert_eq!(claude.default_model, "sonnet");
        assert!(
            !claude.default_model.contains('-'),
            "parece un id con fecha"
        );
    }

    #[test]
    fn claude_ofrece_los_alias_y_ademas_las_versiones_concretas() {
        // El usuario pidio el 2026-09-22 poder elegir "un opus 5, o un 4.6".
        // Con solo alias eso es imposible: `opus` apunta a lo que apunte hoy.
        let claude = de(&catalogo(), "claude");
        let ids: Vec<&str> = claude.models.iter().map(|m| m.id.as_str()).collect();
        for alias in ["opus", "sonnet", "haiku", "fable"] {
            assert!(ids.contains(&alias), "falta el alias {alias}");
        }
        for id in [
            "claude-opus-5",
            "claude-opus-4-6",
            "claude-sonnet-5",
            "claude-haiku-4-5",
            "claude-fable-5-1",
        ] {
            assert!(ids.contains(&id), "falta la version concreta {id}");
        }
        // Y todas con etiqueta en cristiano: un selector lleno de ids crudos
        // no se puede leer.
        for m in &claude.models {
            assert!(!m.label.trim().is_empty(), "{} sin etiqueta", m.id);
        }
    }

    #[test]
    fn sin_caches_el_catalogo_es_exactamente_el_de_casa() {
        // Degradacion obligatoria: con los dos JSON borrados, rotos o nunca
        // escritos, todo tiene que seguir como antes de este cambio.
        let fundido = fundir(catalogo(), &BTreeMap::new(), &Veredictos::new(), ahora());
        assert_eq!(fundido.len(), catalogo().len());
        for (a, b) in fundido.iter().zip(catalogo().iter()) {
            assert_eq!(a.provider, b.provider);
            let ids_a: Vec<&str> = a.models.iter().map(|m| m.id.as_str()).collect();
            let ids_b: Vec<&str> = b.models.iter().map(|m| m.id.as_str()).collect();
            assert_eq!(ids_a, ids_b, "{} ha cambiado de modelos", a.provider);
            assert!(a.plan.is_empty() && a.refrescado.is_empty());
            for m in &a.models {
                assert_eq!(m.permitido, Permitido::Desconocido, "{} miente", m.id);
                assert_eq!(m.origen, Origen::Casa);
            }
        }
    }

    #[test]
    fn la_suscripcion_trae_modelos_nuevos_con_su_plan() {
        // Esto es lo que el usuario pidio: que Fable 5.1 aparezca porque su
        // cuenta lo ofrece, sin que nadie lo escriba en este fichero.
        let subs = sub(
            "claude",
            "Claude Pro",
            &["claude-fable-5-1[1m]", "claude-opus-4-6"],
            &["claude-mythos-5"],
        );
        let c = de(
            &fundir(catalogo(), &subs, &Veredictos::new(), ahora()),
            "claude",
        );
        assert_eq!(c.plan, "Claude Pro");
        assert_eq!(c.plan_origen, "fixture");
        assert!(
            !c.refrescado.is_empty(),
            "sin fecha no se sabe si esta viejo"
        );
        let fable = modelo(&c, "claude-fable-5-1[1m]");
        assert_eq!(fable.permitido, Permitido::Si);
        assert_eq!(fable.origen, Origen::Suscripcion);
        assert_eq!(fable.label, "Claude Fable 5.1 (1M)");
        assert!(fable.motivo.contains("Claude Pro"), "{}", fable.motivo);
        // Un id de casa que la cuenta confirma tambien sube a "si".
        assert_eq!(modelo(&c, "claude-opus-4-6").permitido, Permitido::Si);
        // Y los alias, de los que la cache no dice nada, NO se apagan: en
        // claude la lista de la cuenta son los modelos EXTRA, no el total.
        assert_eq!(modelo(&c, "opus").permitido, Permitido::Desconocido);
    }

    #[test]
    fn en_codex_y_agy_lo_que_no_esta_en_la_lista_viva_se_marca_no() {
        // Aqui la lista SI es cerrada: lo que el servidor no sirve, lo rechaza.
        let subs = sub("codex", "ChatGPT Free", &["gpt-5.6-luna"], &[]);
        let c = de(
            &fundir(catalogo(), &subs, &Veredictos::new(), ahora()),
            "codex",
        );
        assert_eq!(modelo(&c, "gpt-5.6-luna").permitido, Permitido::Si);
        let terra = modelo(&c, "gpt-5.6-terra");
        assert_eq!(terra.permitido, Permitido::No);
        assert!(
            !terra.motivo.trim().is_empty(),
            "un 'no' sin motivo no vale"
        );
    }

    #[test]
    fn una_lista_viva_vacia_no_apaga_a_nadie() {
        // Caso negativo del anterior: `agy models` sin sesion devuelve vacio, y
        // eso NO puede convertir todo el catalogo en "no permitido".
        let subs = sub("antigravity", "", &[], &[]);
        let c = de(
            &fundir(catalogo(), &subs, &Veredictos::new(), ahora()),
            "antigravity",
        );
        for m in &c.models {
            assert_eq!(
                m.permitido,
                Permitido::Desconocido,
                "{} apagado sin pruebas",
                m.id
            );
        }
    }

    #[test]
    fn los_claude_de_agy_se_ven_y_dicen_de_que_cuota_gastan() {
        // Sustituye a `antigravity_no_ofrece_modelos_de_anthropic`
        // (2026-09-21), que los escondia. La razon de esconderlos —"gastarian
        // la misma cuota por dos caminos"— era FALSA: por Antigravity se gasta
        // la cuota de Google. Y ademas es el UNICO sitio del sistema con un
        // Opus 4.6, que es justo lo que el usuario pidio poder elegir.
        let subs = sub(
            "antigravity",
            "Google (cuenta personal)",
            &["claude-opus-4-6-thinking", "gemini-3.8-flash-high"],
            &[],
        );
        let c = de(
            &fundir(catalogo(), &subs, &Veredictos::new(), ahora()),
            "antigravity",
        );
        let opus = modelo(&c, "claude-opus-4-6-thinking");
        assert_eq!(opus.permitido, Permitido::Si);
        assert!(
            opus.para.contains("cuota de Google"),
            "no avisa: {}",
            opus.para
        );
        assert_eq!(opus.label, "Claude Opus 4.6 (Thinking)");
        // Y un modelo de Google del mismo sitio NO lleva ese aviso.
        assert!(modelo(&c, "gemini-3.8-flash-high").para.is_empty());
    }

    #[test]
    fn un_rechazo_real_manda_sobre_la_suscripcion_y_caduca_a_los_siete_dias() {
        // La lista se sondeo ANTES del rechazo: por eso el rechazo manda. Un
        // sondeo posterior lo levantaria (lo fija el test del veto y el
        // sondeo nuevo), que es lo que hace /modelos.
        let mut subs = sub("codex", "ChatGPT Free", &["gpt-5.6-terra"], &[]);
        subs.get_mut("codex").expect("codex").at = hace(3);
        let fresco = veredicto(
            "codex",
            "gpt-5.6-terra",
            "rechazado",
            "The 'gpt-5.6-terra' model is not supported when using Codex with a ChatGPT account.",
            &hace(2),
        );
        let c = de(&fundir(catalogo(), &subs, &fresco, ahora()), "codex");
        let t = modelo(&c, "gpt-5.6-terra");
        assert_eq!(
            t.permitido,
            Permitido::No,
            "la lista no manda sobre un 400 real"
        );
        assert!(t.motivo.contains("not supported"), "{}", t.motivo);
        assert!(t.motivo.chars().count() <= 200, "motivo sin recortar");

        // Caducado: vuelve a lo que diga la suscripcion, no se queda muerto.
        let viejo = veredicto("codex", "gpt-5.6-terra", "rechazado", "400", &hace(8));
        let c2 = de(&fundir(catalogo(), &subs, &viejo, ahora()), "codex");
        assert_eq!(modelo(&c2, "gpt-5.6-terra").permitido, Permitido::Si);

        // Y sin fecha entendible tampoco se clava para siempre.
        let sin_fecha = veredicto("codex", "gpt-5.6-terra", "rechazado", "400", "cuando sea");
        let c3 = de(&fundir(catalogo(), &subs, &sin_fecha, ahora()), "codex");
        assert_eq!(modelo(&c3, "gpt-5.6-terra").permitido, Permitido::Si);
    }

    #[test]
    fn una_respuesta_real_vale_mas_que_una_lista() {
        // La cuenta no lo lista, pero contesto de verdad: eso es evidencia.
        let subs = sub("claude", "Claude Pro", &[], &[]);
        let ok = veredicto("claude", "claude-opus-5", "ok", "", &hace(1));
        let c = de(&fundir(catalogo(), &subs, &ok, ahora()), "claude");
        let o = modelo(&c, "claude-opus-5");
        assert_eq!(o.permitido, Permitido::Si);
        assert!(o.motivo.contains("contestó"), "{}", o.motivo);
        assert!(!o.visto.is_empty(), "sin fecha no se puede caducar nada");
    }

    #[test]
    fn un_id_con_forma_rara_no_llega_a_la_linea_de_comandos() {
        // La guarda existe porque estos ids vienen de un fichero de cache y
        // acaban en `Command::args`, a veces por `cmd /C`.
        assert!(id_con_forma_de_modelo("claude-opus-4-6"));
        assert!(id_con_forma_de_modelo("claude-fable-5-1[1m]"));
        assert!(id_con_forma_de_modelo("gpt-5.6-terra"));
        assert!(id_con_forma_de_modelo("us.anthropic:claude_v2"));
        for malo in [
            "",
            " ",
            "rm -rf /",
            "modelo; whoami",
            "modelo\nsegunda linea",
            "modelo|otra",
            "modelo&cosa",
            "opus[2m]",
            "../../etc/passwd",
            "--dangerously-skip-permissions",
            "--model",
            "-m",
        ] {
            assert!(!id_con_forma_de_modelo(malo), "ha colado {malo:?}");
        }
        assert!(
            !id_con_forma_de_modelo(&"a".repeat(65)),
            "sin tope de largo"
        );
        // Y lo mismo por el camino real: `fundir` descarta lo que no pase.
        let subs = sub("codex", "", &["gpt-ok", "rm -rf /"], &[]);
        let c = de(
            &fundir(catalogo(), &subs, &Veredictos::new(), ahora()),
            "codex",
        );
        assert!(c.models.iter().any(|m| m.id == "gpt-ok"));
        assert!(
            !c.models.iter().any(|m| m.id.contains("rm ")),
            "un id con forma de orden ha entrado en el catalogo"
        );
    }

    #[test]
    fn las_etiquetas_se_leen_en_cristiano() {
        assert_eq!(etiqueta_humana("claude-opus-5"), "Claude Opus 5");
        assert_eq!(etiqueta_humana("claude-opus-4-6"), "Claude Opus 4.6");
        assert_eq!(etiqueta_humana("claude-haiku-4-5"), "Claude Haiku 4.5");
        assert_eq!(
            etiqueta_humana("gemini-3.1-pro-high"),
            "Gemini 3.1 Pro (High)"
        );
        assert_eq!(etiqueta_humana("gpt-5.6-terra"), "GPT 5.6 Terra");
        assert_eq!(
            etiqueta_humana("gpt-oss-120b-medium"),
            "GPT-OSS 120B (Medium)"
        );
        // Caso negativo: algo que no sabe interpretar se enseña tal cual, pero
        // NUNCA vacio (una fila sin texto parece un fallo de la aplicacion).
        assert_eq!(etiqueta_humana("xyz"), "Xyz");
        assert_eq!(etiqueta_humana("---"), "---");
    }

    #[test]
    fn el_estado_de_un_modelo_desconocido_no_es_un_no() {
        // Caso negativo importante: "no lo conozco" y "tu cuenta no lo tiene"
        // son cosas distintas. Confundirlas apagaria modelos buenos.
        let subs = sub("claude", "Claude Pro", &[], &[]);
        let c = de(
            &fundir(catalogo(), &subs, &Veredictos::new(), ahora()),
            "claude",
        );
        assert_eq!(modelo(&c, "fable").permitido, Permitido::Desconocido);
        assert!(modelo(&c, "fable").motivo.is_empty());
    }

    #[test]
    fn una_lista_corta_se_explica() {
        // Caso negativo del mandamiento 11 aplicado a la interfaz: si un
        // proveedor ofrece un solo modelo, tiene que decir POR QUE. Sin nota,
        // el usuario lo lee como que falta algo (y eso fue exactamente lo que
        // paso con codex).
        for c in catalogo() {
            if c.models.len() == 1 {
                assert!(
                    !c.nota.trim().is_empty(),
                    "{} ofrece un solo modelo y no explica por que",
                    c.provider
                );
            }
        }
    }

    #[test]
    fn el_esfuerzo_se_normaliza_a_tres_niveles() {
        assert_eq!(normaliza_esfuerzo("low"), "bajo");
        assert_eq!(normaliza_esfuerzo("  ALTO "), "alto");
        assert_eq!(normaliza_esfuerzo("high"), "alto");
        assert_eq!(normaliza_esfuerzo("medio"), "medio");
    }

    #[test]
    fn un_esfuerzo_inventado_no_sube_el_gasto() {
        // Caso negativo: si "turbo" cayera en "alto", una palabra suelta del
        // modelo local encareceria todas las respuestas.
        for raw in ["turbo", "", "999", "ultra"] {
            assert_eq!(normaliza_esfuerzo(raw), "medio", "fallo con {raw:?}");
        }
    }

    #[test]
    fn cada_cli_recibe_solo_lo_que_entiende() {
        // Claude gana `--effort` el 2026-09-22: la bandera existe de verdad
        // (`claude --help`), asi que deja de pedirse metiendo una frase en el
        // prompt, que era una peticion y no un control.
        assert_eq!(
            argumentos("claude", "claude-opus-5", "alto"),
            vec!["--model", "claude-opus-5", "--effort", "high"]
        );
        assert_eq!(
            argumentos("claude", "opus", "bajo"),
            vec!["--model", "opus", "--effort", "low"]
        );
        assert_eq!(
            argumentos("codex", "gpt-5.6-terra", "alto"),
            vec![
                "-m",
                "gpt-5.6-terra",
                "-c",
                "model_reasoning_effort=\"high\""
            ]
        );
        assert_eq!(
            argumentos("antigravity", "gemini-3.1-pro-high", "alto"),
            vec!["--model", "gemini-3.1-pro-high"]
        );
        // El local no va por CLI.
        assert!(argumentos("local", "qwen3.5:9b", "alto").is_empty());
    }

    #[test]
    fn sin_modelo_no_se_emite_la_bandera_del_modelo() {
        // Caso negativo: `--model ""` hace que la CLI falle en vez de usar su
        // modelo por defecto. El esfuerzo si se manda: no depende del modelo.
        assert_eq!(
            argumentos("claude", "", "medio"),
            vec!["--effort", "medium"]
        );
        assert_eq!(
            argumentos("codex", "", "medio"),
            vec!["-c", "model_reasoning_effort=\"medium\""]
        );
        assert!(argumentos("antigravity", "", "medio").is_empty());
    }

    #[test]
    fn ya_nadie_pide_el_esfuerzo_dentro_del_prompt() {
        // Antes claude llevaba "think hard:" pegado al mensaje. Con `--effort`
        // real eso sobra, y ademas ensuciaba el prompt del usuario.
        for p in ["claude", "codex", "antigravity", "local"] {
            for e in ["bajo", "medio", "alto"] {
                assert_eq!(prefijo_esfuerzo(p, e), "", "{p} sigue ensuciando el prompt");
            }
        }
    }

    #[test]
    fn la_terminal_solo_recibe_el_modelo() {
        assert_eq!(
            argumentos_interactivos("claude", "opus"),
            vec!["--model", "opus"]
        );
        assert_eq!(
            argumentos_interactivos("codex", "gpt-5.6-terra"),
            vec!["-m", "gpt-5.6-terra"]
        );
        // Caso negativo: sin modelo no se emite bandera, y powershell no
        // entiende ninguna.
        assert!(argumentos_interactivos("claude", "").is_empty());
        assert!(argumentos_interactivos("powershell", "opus").is_empty());
    }

    #[test]
    fn el_local_solo_razona_con_esfuerzo_alto() {
        assert!(razonar_en_local("alto"));
        assert!(!razonar_en_local("medio"));
        assert!(!razonar_en_local("bajo"));
    }

    #[test]
    fn rechaza_modelos_que_no_estan_en_el_catalogo() {
        // Caso negativo: el id acaba en una linea de comandos. Se prueba sobre
        // la parte pura (`fundir`), no por `modelo_valido`, que desde el
        // 2026-09-22 lee las caches de ~/.maria y haria el test depender de la
        // maquina en la que corre.
        let cat = fundir(
            catalogo(),
            &std::collections::BTreeMap::new(),
            &crate::maria::suscripcion::Veredictos::new(),
            ahora(),
        );
        let claude = de(&cat, "claude");
        assert!(!claude.models.iter().any(|m| m.id == "opus-4-turbo-ultra"));
        assert!(claude.models.iter().any(|m| m.id == "opus"));
        assert!(!cat.iter().any(|c| c.provider == "gemini"));
        assert!(modelo_valido("claude", ""), "vacio = el de la CLI");
    }

    #[test]
    fn un_veto_gana_a_un_ok_viejo_y_un_sondeo_nuevo_levanta_un_rechazo() {
        use crate::maria::suscripcion::{Suscripcion, Veredicto};
        let ahora = ahora();
        let hace = |h: i64| (ahora - chrono::Duration::hours(h)).to_rfc3339();
        // Un «contesto de verdad» de hace 200 dias no desmiente el veto de hoy.
        let mut vetos = Suscripcion {
            provider: "claude".into(),
            at: hace(1),
            ..Default::default()
        };
        vetos.vetados.push("claude-opus-5".into());
        let mut vs = std::collections::BTreeMap::new();
        vs.insert(
            "claude-opus-5".to_string(),
            Veredicto {
                estado: "ok".into(),
                detalle: String::new(),
                at: hace(24 * 200),
            },
        );
        let (p, motivo, _) = estado_de("claude-opus-5", Some(&vetos), Some(&vs), false, ahora);
        assert_eq!(p, Permitido::No, "{motivo}");
        // Un rechazo fresco manda... salvo que la suscripcion se haya vuelto a
        // sondear DESPUES: entonces decide la lista (aqui, lo sirve).
        let mut sirve = Suscripcion {
            provider: "claude".into(),
            at: hace(1),
            ..Default::default()
        };
        sirve.permitidos.push("claude-opus-5".into());
        vs.insert(
            "claude-opus-5".to_string(),
            Veredicto {
                estado: "rechazado".into(),
                detalle: "404".into(),
                at: hace(2),
            },
        );
        let (p, motivo, _) = estado_de("claude-opus-5", Some(&sirve), Some(&vs), false, ahora);
        assert_eq!(p, Permitido::Si, "{motivo}");
        // Caso negativo: con el sondeo ANTERIOR al rechazo, el rechazo sigue.
        sirve.at = hace(3);
        let (p, motivo, _) = estado_de("claude-opus-5", Some(&sirve), Some(&vs), false, ahora);
        assert_eq!(p, Permitido::No, "{motivo}");
    }

    #[test]
    fn un_modelo_nuevo_de_la_cli_sale_primero_en_su_familia() {
        use crate::maria::suscripcion::ModeloCli;
        let mc = |id: &str, f: &str, e: &str| ModeloCli {
            id: id.into(),
            familia: f.into(),
            etiqueta: e.into(),
        };
        let cli = vec![
            mc("claude-3-5-haiku", "haiku", "Haiku 3.5"),
            mc("claude-haiku-4-5", "haiku", "Haiku 4.5"),
            mc("claude-sonnet-5", "sonnet", "Sonnet 5"),
            mc("claude-opus-4-8", "opus", "Opus 4.8"),
            mc("claude-opus-5", "opus", "Opus 5"),
            mc("claude-opus-5-5", "opus", "Opus 5.5"),
            mc("claude-fable-5-1", "fable", "Fable 5.1"),
            mc("claude-mythos-5", "mythos", "Mythos 5"),
            mc("claude-poeta-1", "poeta", "Poeta 1"),
        ];
        let ids: Vec<String> = modelos_desde_la_cli(&cli)
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(
            ids,
            vec![
                "claude-fable-5-1",
                "claude-opus-5-5",
                "claude-opus-5",
                "claude-opus-4-8",
                "claude-sonnet-5",
                "claude-haiku-4-5",
                "claude-poeta-1",
            ],
            "familias en orden, lo mas nuevo arriba; fuera 3.x y mythos; lo desconocido detras"
        );
        // Caso negativo: sin tabla no se inventa nada (queda el respaldo de casa).
        assert!(modelos_desde_la_cli(&[]).is_empty());
    }
}
