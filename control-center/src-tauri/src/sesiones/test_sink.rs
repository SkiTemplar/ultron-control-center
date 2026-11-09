// sesiones/test_sink.rs — Sink de pruebas: registra los eventos y simula si
// la ventana está abierta.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde_json::Value;

use super::registro::Sink;

#[derive(Default)]
pub struct MockSink {
    pub open: AtomicBool,
    pub events: Mutex<Vec<(String, Value)>>,
    pub avisos: Mutex<Vec<String>>,
}

impl MockSink {
    pub fn opened() -> Self {
        let s = Self::default();
        s.open.store(true, Ordering::SeqCst);
        s
    }
}

impl Sink for MockSink {
    fn emit(&self, event: &str, payload: Value) {
        if let Ok(mut e) = self.events.lock() {
            e.push((event.to_string(), payload));
        }
    }
    fn window_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }
    fn avisar(&self, texto: &str) {
        if let Ok(mut a) = self.avisos.lock() {
            a.push(texto.to_string());
        }
    }
}

impl MockSink {
    /// Payloads emitidos con el nombre `event`.
    pub fn payloads(&self, event: &str) -> Vec<Value> {
        self.events
            .lock()
            .map(|e| {
                e.iter()
                    .filter(|(n, _)| n == event)
                    .map(|(_, p)| p.clone())
                    .collect()
            })
            .unwrap_or_default()
    }
}
