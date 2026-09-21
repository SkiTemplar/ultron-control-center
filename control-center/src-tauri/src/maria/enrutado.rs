// mar.ia — enrutado rapido: decidir sin preguntar, y no insistir a quien no puede.
//
// Dos problemas medidos el 2026-09-21 en `relay.rs`:
//
//   1. CADA mensaje pasaba antes por el modelo local para decidir el destino.
//      Con la VRAM libre entre turnos eso es una carga de modelo (3 s en
//      caliente, hasta 36 s en frio) antes de empezar a contestar — tambien
//      cuando la respuesta iba a darla Claude y el local no pintaba nada.
//   2. Un proveedor que acababa de decir "sin cuota" se volvia a intentar en el
//      mensaje siguiente, y en el otro: varios segundos perdidos por turno en
//      lanzar una CLI para que repita que no.
//
// Aqui vive la parte PURA de la solucion (se testea sin red ni ficheros):
//
//   * `clasificar` — senales lexicas baratas (microsegundos). Si la peticion es
//     clara, se decide aqui y el modelo local ni se carga. Si es ambigua,
//     devuelve None y decide el local como antes.
//   * `regla_para` — casa la clase con las reglas EDITABLES del criterio, por
//     las palabras que el usuario escribio en ellas. La pantalla Router sigue
//     mandando: esto no trae un mapa propio de proveedores.
//   * enfriamiento — tras un "sin cuota", el proveedor pasa al final de la cola
//     hasta que venza el plazo (el que diga su mensaje, o uno creciente).

use chrono::{DateTime, Duration, Utc};

use super::criterio::{Criterio, Regla};

/// Tipo de trabajo que se reconoce sin ayuda de un modelo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Clase {
    Trivial,
    BuscarOVer,
    Script,
    Proyecto,
    Fondo,
}

const HUELLAS_SCRIPT: &[&str] = &[
    "script",
    "powershell",
    "bash",
    ".ps1",
    ".bat",
    ".sh",
    "regex",
    "expresion regular",
    "automatiza",
    "automatizar",
    "comando para",
    "one-liner",
    "cron",
    "tarea programada",
];

const HUELLAS_PROYECTO: &[&str] = &[
    "```",
    "repositorio",
    "repo ",
    "refactor",
    "stack trace",
    "traceback",
    "compila",
    "compilar",
    "bug",
    "test unitario",
    "tests",
    "pull request",
    "commit",
    ".rs",
    ".ts",
    ".tsx",
    ".py",
    ".cpp",
    ".cs",
    ".java",
    ".go",
    "funcion ",
    "clase ",
    "metodo ",
    "endpoint",
    "blueprint",
];

const HUELLAS_FONDO: &[&str] = &[
    "arquitectura",
    "disena",
    "diseno de",
    "estrategia",
    "plan de",
    "compara a fondo",
    "informe",
    "ensayo",
    "articulo",
    "capitulo",
    "libro",
    "documentacion completa",
    "tfg",
    "analiza a fondo",
    "pros y contras",
    "decision dificil",
];

const HUELLAS_BUSCAR: &[&str] = &[
    "busca en internet",
    "busca en la web",
    "noticias",
    "ultima version",
    "precio de",
    "hoy en",
    "http://",
    "https://",
    "esta imagen",
    "esta foto",
    "esta captura",
    "mira la imagen",
    "que pone en",
    "resumeme este pdf",
    "este documento",
];

/// Verbos que descartan "trivial" aunque la frase sea corta.
const NO_TRIVIAL: &[&str] = &[
    "implementa",
    "escribe",
    "redacta",
    "disena",
    "analiza",
    "refactor",
    "programa",
    "crea un",
    "genera",
    "explica a fondo",
    "compara",
    "resume",
    "traduce este",
    "corrige",
];

/// Minusculas y sin tildes, para comparar con las huellas.
#[must_use]
pub fn normaliza(texto: &str) -> String {
    texto
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'á' | 'à' | 'ä' => 'a',
            'é' | 'è' | 'ë' => 'e',
            'í' | 'ì' | 'ï' => 'i',
            'ó' | 'ò' | 'ö' => 'o',
            'ú' | 'ù' | 'ü' => 'u',
            otro => otro,
        })
        .collect()
}

fn cuenta(texto: &str, huellas: &[&str]) -> usize {
    huellas.iter().filter(|h| texto.contains(*h)).count()
}

/// Clase de la peticion, o None si no esta claro (entonces decide el local).
///
/// Regla de prudencia: solo se devuelve una clase cuando UNA gana sin empate.
/// Equivocarse aqui manda un trabajo serio al modelo flojo, asi que ante la
/// duda se calla.
#[must_use]
pub fn clasificar(prompt: &str, con_imagenes: bool) -> Option<Clase> {
    let t = normaliza(prompt);
    if con_imagenes {
        return Some(Clase::BuscarOVer);
    }
    let puntos = [
        (Clase::BuscarOVer, cuenta(&t, HUELLAS_BUSCAR)),
        (Clase::Script, cuenta(&t, HUELLAS_SCRIPT)),
        (Clase::Proyecto, cuenta(&t, HUELLAS_PROYECTO)),
        (
            Clase::Fondo,
            cuenta(&t, HUELLAS_FONDO) + usize::from(t.chars().count() > 900),
        ),
    ];
    let max = puntos.iter().map(|(_, n)| *n).max().unwrap_or(0);
    if max > 0 {
        let ganadores: Vec<Clase> = puntos
            .iter()
            .filter(|(_, n)| *n == max)
            .map(|(c, _)| *c)
            .collect();
        return (ganadores.len() == 1).then(|| ganadores[0]);
    }
    let palabras = t.split_whitespace().count();
    let corto = palabras <= 14 && t.chars().count() <= 110 && !t.contains('\n');
    (corto && cuenta(&t, NO_TRIVIAL) == 0).then_some(Clase::Trivial)
}

/// Palabras con las que se reconoce, en el texto de una regla, de que clase habla.
fn pistas_de(clase: Clase) -> &'static [&'static str] {
    match clase {
        Clase::Trivial => &["trivial", "saludo", "corta", "cotidian", "rapida"],
        Clase::BuscarOVer => &["buscar", "internet", "imagen", "web", "documentos largos"],
        Clase::Script => &["script", "automatiza", "comando"],
        Clase::Proyecto => &["proyecto", "repositorio", "codigo", "programar"],
        Clase::Fondo => &[
            "arquitectura",
            "largo",
            "diseno",
            "dificil",
            "escribir mucho",
        ],
    }
}

/// La regla del criterio que corresponde a esta clase, si el usuario tiene una.
#[must_use]
pub fn regla_para(clase: Clase, criterio: &Criterio) -> Option<&Regla> {
    let pistas = pistas_de(clase);
    criterio.reglas.iter().find(|r| {
        let texto = normaliza(&format!("{} {}", r.tarea, r.cuando));
        pistas.iter().any(|p| texto.contains(p))
    })
}

// ---------------------------------------------------------------------------
// Enfriamiento por cuota
// ---------------------------------------------------------------------------

/// Plazo base tras el primer "sin cuota" cuando el mensaje no dice cuando vuelve.
const ENFRIAMIENTO_BASE_MIN: i64 = 15;
/// Tope del plazo creciente.
const ENFRIAMIENTO_MAX_MIN: i64 = 120;

/// Minutos que el propio mensaje de error dice que hay que esperar, si lo dice.
///
/// Reconoce "try again in 23 minutes", "in 2 hours", "en 40 minutos", "2h".
#[must_use]
pub fn minutos_en_mensaje(detalle: &str) -> Option<i64> {
    let t = normaliza(detalle);
    let palabras: Vec<&str> = t
        .split(|c: char| c.is_whitespace() || c == ',' || c == '.')
        .filter(|p| !p.is_empty())
        .collect();
    for (i, p) in palabras.iter().enumerate() {
        // "23m" / "2h" pegado
        if let Some(n) = p.strip_suffix('h').and_then(|n| n.parse::<i64>().ok()) {
            return Some(n * 60);
        }
        if let Some(n) = p.strip_suffix('m').and_then(|n| n.parse::<i64>().ok()) {
            return Some(n);
        }
        let Ok(n) = p.parse::<i64>() else { continue };
        match palabras.get(i + 1).copied().unwrap_or("") {
            u if u.starts_with("hour") || u.starts_with("hora") => return Some(n * 60),
            u if u.starts_with("min") => return Some(n),
            _ => {}
        }
    }
    None
}

/// Hasta cuando se deja en paz a un proveedor que acaba de quedarse sin cuota.
#[must_use]
pub fn enfriar_hasta(detalle: &str, avisos_seguidos: u32, ahora: DateTime<Utc>) -> DateTime<Utc> {
    let minutos = minutos_en_mensaje(detalle)
        .filter(|m| (1..=24 * 60).contains(m))
        .unwrap_or_else(|| {
            let factor = 1_i64 << avisos_seguidos.min(4);
            (ENFRIAMIENTO_BASE_MIN * factor).min(ENFRIAMIENTO_MAX_MIN)
        });
    ahora + Duration::minutes(minutos)
}

/// ¿Sigue enfriando? `hasta` es RFC 3339; vacio o ilegible = no.
#[must_use]
pub fn enfriando(hasta: &str, ahora: DateTime<Utc>) -> bool {
    DateTime::parse_from_rfc3339(hasta)
        .map(|t| t.with_timezone(&Utc) > ahora)
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// Avisos de cuota que llegan de fuera de la aplicacion
// ---------------------------------------------------------------------------
//
// El enfriamiento de arriba solo se entera de que un proveedor esta sin cuota
// cuando la PROPIA aplicacion lo intenta y falla. Las sesiones de Claude Code
// que corren por su cuenta chocan con la misma cuota y el relevo no se enteraba:
// el turno siguiente del chat volvia a gastar varios segundos en que la CLI
// repitiera que no.
//
// El hook `stopfailure-relay` (evento StopFailure) deja una linea por incidente
// en `<raiz>/cockpit/maria/relay-cuota.jsonl`. Esto es el lado que la lee. El
// formato exacto es el contrato documentado en la cabecera de ese script.

/// Una linea del JSONL de avisos. Campos de mas se ignoran a proposito: es un
/// fichero append-only que escribe un hook y puede crecer en versiones nuevas.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct SenalCuota {
    /// ISO-8601 UTC del incidente.
    pub ts: String,
    pub proveedor: String,
    /// Valor del enum `error` del evento ("rate_limit", "billing_error"…).
    pub error: String,
    /// "cuota" (espera y vuelve) | "cuenta" (esta cuenta no va).
    pub clase: String,
    #[serde(default)]
    pub detalle: String,
}

/// Lo que se saca de una lectura del JSONL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoteSenales {
    /// Marca del ultimo aviso LEIDO, se aplique o no. Guardarla es lo que hace
    /// que cada aviso se consuma una sola vez.
    pub hasta: String,
    /// Los avisos que valen: uno por proveedor, el mas reciente.
    pub aplicables: Vec<SenalCuota>,
}

/// Cuanto vale un aviso. Un "sin cuota" de hace horas no dice nada de ahora, y
/// enfriar por el dejaria al usuario en el modelo local sin motivo.
pub const FRESCURA_SENAL_MIN: i64 = 60;

/// Avisos posteriores a `ultimo` y todavia frescos, uno por proveedor. Pura.
///
/// Las lineas que no parsean se saltan (el fichero lo escribe un hook que falla
/// abierto) pero SI cuentan para la marca: si una linea rota bloqueara el
/// avance, el mismo tramo se releeria para siempre.
#[must_use]
pub fn senales_nuevas(jsonl: &str, ultimo: &str, ahora: DateTime<Utc>) -> LoteSenales {
    let momento = |s: &str| {
        DateTime::parse_from_rfc3339(s.trim())
            .ok()
            .map(|d| d.with_timezone(&Utc))
    };
    let corte = momento(ultimo);
    let mut hasta = ultimo.trim().to_string();
    let mut tope = corte;
    // Por proveedor, el aviso mas reciente: aplicar varios seguidos alargaria
    // el plazo de espera una vez por linea, que no es lo que dicen los avisos.
    let mut por_proveedor: Vec<SenalCuota> = Vec::new();
    for linea in jsonl.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(s) = serde_json::from_str::<SenalCuota>(linea) else {
            continue;
        };
        let Some(t) = momento(&s.ts) else { continue };
        if corte.is_some_and(|c| t <= c) {
            continue;
        }
        if tope.is_none_or(|m| t > m) {
            tope = Some(t);
            hasta = s.ts.trim().to_string();
        }
        if s.proveedor.trim().is_empty()
            || (s.clase != "cuota" && s.clase != "cuenta")
            || (ahora - t) > Duration::minutes(FRESCURA_SENAL_MIN)
        {
            continue;
        }
        match por_proveedor
            .iter_mut()
            .find(|x| x.proveedor == s.proveedor)
        {
            Some(previo) if momento(&previo.ts).is_none_or(|p| t > p) => *previo = s,
            Some(_) => {}
            None => por_proveedor.push(s),
        }
    }
    LoteSenales {
        hasta,
        aplicables: por_proveedor,
    }
}

/// Reordena: los que estan enfriando pasan al final, en el mismo orden relativo.
///
/// No se QUITAN: si todos los demas fallan, mejor un ultimo intento a un
/// proveedor que quiza ya se haya recuperado que dejar al usuario sin respuesta.
#[must_use]
pub fn ordenar_por_disponibilidad(orden: &[String], frios: &[String]) -> Vec<String> {
    let (mut listos, mut al_final): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
    for p in orden {
        if frios.contains(p) {
            al_final.push(p.clone());
        } else {
            listos.push(p.clone());
        }
    }
    listos.extend(al_final);
    listos
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lo_corto_y_sin_verbos_de_trabajo_es_trivial() {
        assert_eq!(clasificar("hola, que tal", false), Some(Clase::Trivial));
        assert_eq!(
            clasificar("cuantos km son 12 millas", false),
            Some(Clase::Trivial)
        );
    }

    #[test]
    fn corto_pero_con_encargo_no_es_trivial() {
        assert_eq!(clasificar("redacta un correo al casero", false), None);
        assert_eq!(clasificar("implementa el login", false), None);
    }

    #[test]
    fn el_codigo_y_los_scripts_se_distinguen() {
        assert_eq!(
            clasificar("hay un bug en auth.rs, el test unitario falla", false),
            Some(Clase::Proyecto)
        );
        assert_eq!(
            clasificar("hazme un script de powershell que borre temporales", false),
            Some(Clase::Script)
        );
    }

    #[test]
    fn un_empate_no_se_decide_aqui() {
        // "script" y "repositorio": una huella de cada clase -> que decida el local.
        assert_eq!(clasificar("un script para el repositorio", false), None);
    }

    #[test]
    fn una_imagen_adjunta_nunca_va_al_modelo_que_no_ve() {
        assert_eq!(clasificar("que es esto", true), Some(Clase::BuscarOVer));
    }

    #[test]
    fn la_regla_se_encuentra_por_lo_que_escribio_el_usuario() {
        let c = Criterio::default();
        assert_eq!(
            regla_para(Clase::Trivial, &c).map(|r| r.provider.as_str()),
            Some("local")
        );
        assert_eq!(
            regla_para(Clase::Proyecto, &c).map(|r| r.provider.as_str()),
            Some("claude")
        );
        let vacio = Criterio {
            reglas: Vec::new(),
            ..Criterio::default()
        };
        assert!(regla_para(Clase::Script, &vacio).is_none());
    }

    #[test]
    fn el_plazo_sale_del_mensaje_si_lo_trae() {
        assert_eq!(
            minutos_en_mensaje("limit reached, try again in 23 minutes"),
            Some(23)
        );
        assert_eq!(minutos_en_mensaje("resets in 2 hours"), Some(120));
        assert_eq!(minutos_en_mensaje("vuelve en 40 minutos"), Some(40));
        assert_eq!(minutos_en_mensaje("usage limit reached"), None);
    }

    #[test]
    fn sin_pista_el_plazo_crece_y_tiene_tope() {
        let t0 = Utc::now();
        let m = |n| (enfriar_hasta("usage limit", n, t0) - t0).num_minutes();
        assert_eq!(m(0), 15);
        assert_eq!(m(1), 30);
        assert_eq!(m(9), 120);
    }

    #[test]
    fn enfriando_caduca_y_tolera_basura() {
        let ahora = Utc::now();
        assert!(enfriando(
            &(ahora + Duration::minutes(5)).to_rfc3339(),
            ahora
        ));
        assert!(!enfriando(
            &(ahora - Duration::minutes(5)).to_rfc3339(),
            ahora
        ));
        assert!(!enfriando("", ahora));
        assert!(!enfriando("ayer", ahora));
    }

    /// Una linea del JSONL como la escribe `hooks/scripts/stopfailure-relay.js`.
    fn linea(ts: &str, error: &str, clase: &str) -> String {
        format!(
            r#"{{"ts":"{ts}","proveedor":"claude","error":"{error}","clase":"{clase}","detalle":"","sesion":null,"fuente":"stopfailure-relay"}}"#
        )
    }

    #[test]
    fn los_avisos_del_hook_se_leen_una_sola_vez() {
        let ahora = Utc::now();
        let t1 = (ahora - Duration::minutes(10)).to_rfc3339();
        let t2 = (ahora - Duration::minutes(2)).to_rfc3339();
        let jsonl = format!(
            "{}\nesto no es json\n{}\n",
            linea(&t1, "rate_limit", "cuota"),
            linea(&t2, "billing_error", "cuenta")
        );
        let lote = senales_nuevas(&jsonl, "", ahora);
        // Dos avisos del mismo proveedor: se aplica SOLO el ultimo, para no
        // duplicar los "strikes" que alargan el plazo de espera.
        assert_eq!(lote.aplicables.len(), 1);
        assert_eq!(lote.aplicables[0].error, "billing_error");
        assert_eq!(lote.hasta, t2);
        // Caso negativo: releer con la marca devuelta no vuelve a dar nada.
        let otra = senales_nuevas(&jsonl, &lote.hasta, ahora);
        assert!(otra.aplicables.is_empty());
        assert_eq!(otra.hasta, lote.hasta);
    }

    #[test]
    fn un_aviso_viejo_no_enfria_a_nadie_pero_se_da_por_leido() {
        // Si mar.ia estuvo cerrada un rato, el "sin cuota" de hace tres horas
        // no dice nada de ahora: aplicarlo mandaria al usuario al modelo local
        // sin motivo. Pero la marca tiene que avanzar igual, o se relee eterno.
        let ahora = Utc::now();
        let viejo = (ahora - Duration::minutes(FRESCURA_SENAL_MIN + 60)).to_rfc3339();
        let lote = senales_nuevas(&linea(&viejo, "rate_limit", "cuota"), "", ahora);
        assert!(lote.aplicables.is_empty());
        assert_eq!(lote.hasta, viejo);
    }

    #[test]
    fn una_linea_que_no_es_un_aviso_de_disponibilidad_se_ignora() {
        // Caso negativo del lado de Rust, gemelo del que tiene el selftest del
        // hook: si alguien afloja el matcher, un `invalid_request` no puede
        // degradar a nadie. La clase la escribe el hook y solo puede ser
        // "cuota" o "cuenta".
        let ahora = Utc::now();
        let ts = ahora.to_rfc3339();
        let jsonl = format!(
            "{}\n{}\n",
            linea(&ts, "invalid_request", "peticion"),
            format!(r#"{{"ts":"{ts}","proveedor":"","error":"rate_limit","clase":"cuota"}}"#)
        );
        let lote = senales_nuevas(&jsonl, "", ahora);
        assert!(lote.aplicables.is_empty());
        // Se han leido igual: la marca avanza.
        assert_eq!(lote.hasta, ts);
    }

    #[test]
    fn los_frios_van_al_final_pero_no_desaparecen() {
        let orden: Vec<String> = ["claude", "codex", "local"]
            .iter()
            .map(|s| (*s).into())
            .collect();
        let r = ordenar_por_disponibilidad(&orden, &["claude".to_string()]);
        assert_eq!(r, vec!["codex", "local", "claude"]);
    }
}
