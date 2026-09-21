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
