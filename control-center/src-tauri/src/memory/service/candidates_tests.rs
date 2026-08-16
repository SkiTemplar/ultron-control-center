#[cfg(test)]
mod approve_gate_tests {
    use super::super::super::super::model::{MemoryItem, MemoryType, Scope, Source, Status};
    use super::super::find_near_dup_active;

    fn active_item(title: &str, summary: &str) -> MemoryItem {
        let mut it = MemoryItem::new(
            MemoryType::Fact,
            Scope::Global,
            Source::AssistantInferred,
            Status::Active,
        );
        it.title = Some(title.to_string());
        it.summary = Some(summary.to_string());
        it
    }

    #[test]
    fn gate_confirms_reformulated_fact_as_duplicate() {
        // El caso del audit 08-09: el mismo hecho reformulado entraba por
        // approve-all y creaba una fila duplicada (105 en el corpus).
        let existing = active_item(
            "Qdrant nativo",
            "el sistema usa qdrant nativo para el recall denso con e5 large",
        );
        let want = existing.id.clone();
        let got = find_near_dup_active(
            "sistema usa qdrant nativo para recall denso (e5 large)",
            &[existing],
        );
        assert_eq!(
            got,
            Some(want),
            "near-dup reformulado debe bloquear approve"
        );
    }

    #[test]
    fn gate_lets_distinct_facts_through() {
        // Caso negativo: compartir palabras sueltas NO bloquea el approve
        // (el bug FTS de 2026-07-02 marcaba dup por vocabulario común).
        let existing = active_item(
            "Reranker",
            "el cross-encoder BGE reordena el top fusionado del recall",
        );
        let got = find_near_dup_active(
            "la pestaña Finance se compila con la feature flag en el build local",
            &[existing],
        );
        assert_eq!(got, None, "hechos distintos no deben bloquearse");
    }

    #[test]
    fn gate_ignores_empty_candidate_list() {
        assert_eq!(find_near_dup_active("cualquier texto", &[]), None);
    }
}

#[cfg(test)]
mod near_dup_tests {
    use super::super::{jaccard_overlap, NEAR_DUP_JACCARD};

    #[test]
    fn reformulated_same_fact_is_near_dup() {
        let a = "el sistema usa qdrant nativo para el recall denso con e5 large";
        let b = "sistema usa qdrant nativo para recall denso (e5 large)";
        assert!(
            jaccard_overlap(a, b) >= NEAR_DUP_JACCARD,
            "el mismo hecho reformulado debe confirmar near-dup"
        );
    }

    #[test]
    fn shared_words_alone_are_not_near_dup() {
        // El caso REAL del bug 2026-07-02: un summary cualquiera quedaba marcado
        // duplicado de los items con mas vocabulario del corpus (otros proyectos)
        // solo por compartir palabras sueltas via la query FTS term-OR.
        let cand = "Prueba unica de la banda A del auto-approve tras la curacion";
        let broker = "Broker-Mediated Service Architecture Three-tier system: Broker \
                      (port 1066) mediates service discovery and load balancing";
        assert!(
            jaccard_overlap(cand, broker) < NEAR_DUP_JACCARD,
            "compartir palabras sueltas NO es un near-dup"
        );
    }

    #[test]
    fn trivial_texts_never_flag() {
        // Caso negativo: sin masa de tokens no hay señal de duplicado.
        assert_eq!(jaccard_overlap("hola mundo", "hola mundo"), 0.0);
        assert_eq!(jaccard_overlap("", "lo que sea con tres tokens"), 0.0);
    }
}
