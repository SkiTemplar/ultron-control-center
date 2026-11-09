// Mascota — asignaturas del curso (cockpit/curso.json) para el calendario.
//
// Cada asignatura aporta su código, su nombre, sus proyectos (el primero
// recibe las tarjetas de entrega, calendar_kanban.rs) y dos listas para
// asignar las tareas de Blackboard, que solo traen el título:
//   * `entregas`: UID exactos del calendario. Para títulos genéricos
//     («Actividad 2», «Práctica 1.5») es la única asignación fiable.
//   * `palabras`: términos del título que delatan la asignatura («UML»,
//     «plan de negocio»). Una palabra suelta casa como palabra entera; una
//     con espacios, como frase.
// Orden: UID exacto, después código o nombre y, al final, palabras clave.

use super::calendar::{has_word, normalize};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Subject {
    pub code: String,
    pub name: String,
    /// Ya normalizadas (minúsculas y sin tildes).
    pub keywords: Vec<String>,
    /// UID exactos de sus entregas en el calendario.
    pub uids: Vec<String>,
    /// Proyecto de ULTRON donde van sus tarjetas de entrega.
    pub project: Option<String>,
}

impl Subject {
    #[cfg(test)]
    pub fn new(code: &str, name: &str, keywords: &[&str]) -> Self {
        Self {
            code: code.into(),
            name: name.into(),
            keywords: keywords.iter().map(|k| normalize(k)).collect(),
            uids: Vec::new(),
            project: None,
        }
    }

    /// El texto (normalizado) nombra la asignatura: el código como palabra o
    /// el nombre entero (de 4 caracteres o más).
    pub fn named_in(&self, text: &str) -> bool {
        let name = normalize(&self.name);
        has_word(text, &normalize(&self.code))
            || (name.chars().count() >= 4 && text.contains(&name))
    }

    /// Alguna de sus palabras clave aparece en el texto (normalizado).
    pub fn keyword_in(&self, text: &str) -> bool {
        self.keywords.iter().any(|k| {
            if k.contains(' ') {
                text.contains(k.as_str())
            } else {
                has_word(text, k)
            }
        })
    }
}

/// Asignaturas de un curso.json. Las que no tienen código se ignoran. Pura.
pub fn parse(json: &str) -> Vec<Subject> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let strings = |a: &serde_json::Value, key: &str| -> Vec<String> {
        a.get(key)
            .and_then(|x| x.as_array())
            .map(|xs| {
                xs.iter()
                    .filter_map(|x| x.as_str())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    v.get("asignaturas")
        .and_then(|a| a.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|a| {
                    let code = a.get("codigo")?.as_str()?.trim().to_string();
                    if code.is_empty() {
                        return None;
                    }
                    Some(Subject {
                        code,
                        name: a
                            .get("nombre")
                            .and_then(|n| n.as_str())
                            .unwrap_or("")
                            .to_string(),
                        keywords: strings(a, "palabras")
                            .iter()
                            .map(|k| normalize(k.trim()))
                            .filter(|k| !k.is_empty())
                            .collect(),
                        uids: strings(a, "entregas")
                            .iter()
                            .map(|u| u.trim().to_string())
                            .filter(|u| !u.is_empty())
                            .collect(),
                        project: strings(a, "proyectos").into_iter().next(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Asignaturas de ~/.ultron/cockpit/curso.json (vacío si no hay curso).
pub fn load() -> Vec<Subject> {
    crate::ultron_root()
        .ok()
        .and_then(|r| std::fs::read_to_string(r.join("cockpit").join("curso.json")).ok())
        .map(|s| parse(&s))
        .unwrap_or_default()
}

/// Asignatura de una entrega: la que lista su UID y, si ninguna, la del
/// texto (`find`).
pub fn find_item<'a>(subjects: &'a [Subject], uid: &str, text: &str) -> Option<&'a Subject> {
    by_uid(subjects, uid).or_else(|| find(subjects, text))
}

/// Asignatura que lista este UID en `entregas`.
pub fn by_uid<'a>(subjects: &'a [Subject], uid: &str) -> Option<&'a Subject> {
    let uid = uid.trim();
    subjects
        .iter()
        .find(|s| !uid.is_empty() && s.uids.iter().any(|u| u == uid))
}

/// Asignatura del texto: primero la que se nombra (código o nombre) y, si
/// ninguna, la de la primera palabra clave que aparezca.
pub fn find<'a>(subjects: &'a [Subject], text: &str) -> Option<&'a Subject> {
    subjects
        .iter()
        .find(|s| s.named_in(text))
        .or_else(|| subjects.iter().find(|s| s.keyword_in(text)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CURSO: &str = r#"{"asignaturas": [
        {"codigo": "ISW", "nombre": "Ingeniería del Software", "proyectos": ["isw-x", "otro"],
         "palabras": ["UML", "stakeholders", "casos de uso"]},
        {"codigo": "CDE", "nombre": "Creación y Dirección de Empresas", "proyectos": [],
         "palabras": ["plan de negocio", "Pitch"], "entregas": [" bb-250894 "]},
        {"nombre": "sin código"}
    ]}"#;

    #[test]
    fn el_uid_exacto_manda_sobre_todo_lo_demas() {
        let s = parse(CURSO);
        assert_eq!(s[1].uids, vec!["bb-250894"]);
        // «Actividad 2» no delata nada por el título: solo su UID la asigna.
        let hit = find_item(&s, "bb-250894", &normalize("Actividad 2")).unwrap();
        assert_eq!(hit.code, "CDE");
        // Aunque el título nombre otra asignatura, el UID listado gana.
        assert_eq!(
            find_item(&s, "bb-250894", &normalize("ISW")).unwrap().code,
            "CDE"
        );
        // Casos negativos: otro UID o ninguno siguen por el texto.
        assert_eq!(find_item(&s, "bb-999", &normalize("Actividad 2")), None);
        assert_eq!(find_item(&s, "", &normalize("UML")).unwrap().code, "ISW");
    }

    #[test]
    fn lee_codigo_nombre_proyecto_y_palabras() {
        let s = parse(CURSO);
        assert_eq!(s.len(), 2, "la asignatura sin código se ignora");
        assert_eq!(s[0].project.as_deref(), Some("isw-x"));
        assert_eq!(s[0].keywords, vec!["uml", "stakeholders", "casos de uso"]);
        assert_eq!(s[1].project, None);
        assert!(parse("no es json").is_empty());
    }

    #[test]
    fn asigna_por_palabra_clave_entera_o_frase() {
        let s = parse(CURSO);
        let code = |t: &str| find(&s, &normalize(t)).map(|x| x.code.clone());
        assert_eq!(
            code("Entrega 2 - UML, Mapa de stakeholders, Visión"),
            Some("ISW".into())
        );
        assert_eq!(code("A1 - Pitch"), Some("CDE".into()));
        assert_eq!(code("Plan de Negocio"), Some("CDE".into()));
        // Casos negativos: una subcadena no es una palabra y nada inventa asignatura.
        assert_eq!(code("Pitchfork"), None);
        assert_eq!(code("Actividad 2"), None);
    }

    #[test]
    fn el_codigo_o_el_nombre_mandan_sobre_las_palabras() {
        let s = parse(CURSO);
        // «pitch» es de CDE, pero el título nombra ISW.
        let hit = find(&s, &normalize("ISW: pitch del proyecto")).unwrap();
        assert_eq!(hit.code, "ISW");
    }
}
