//! Operaciones interactivas contrastadas con generate-ts de la CLI instalada.
use super::*;

impl ClienteCodexApp {
    pub(crate) fn revisar(&self, plazo: Duration) -> Result<Value, RpcError> {
        let r = self.rpc.request(
            "review/start",
            json!({"threadId":self.hilo()?,
            "target":{"type":"uncommittedChanges"},"delivery":"inline"}),
            plazo,
        )?;
        self.estado.lock().map_err(error_bloqueo)?.turno =
            r["turn"]["id"].as_str().map(str::to_string);
        Ok(r)
    }

    /// El esquema actual llama thread/revert al antiguo thread/rollback.
    pub(crate) fn rebobinar(&self, n: usize, plazo: Duration) -> Result<Value, RpcError> {
        let hilo = self.hilo()?;
        let turno = self.turno_anterior(&hilo, n, plazo)?;
        self.rpc.request(
            "thread/revert",
            json!({"threadId":hilo,"beforeTurnId":turno}),
            plazo,
        )
    }

    fn turno_anterior(
        &self,
        hilo: &str,
        mut n: usize,
        plazo: Duration,
    ) -> Result<String, RpcError> {
        let fin = std::time::Instant::now() + plazo;
        let mut cursor = Value::Null;
        loop {
            let r = self.rpc.request(
                "thread/turns/list",
                json!({"threadId":hilo,"limit":n.min(100),"sortDirection":"desc","cursor":cursor}),
                fin.saturating_duration_since(std::time::Instant::now()),
            )?;
            let turnos = r["data"]
                .as_array()
                .ok_or_else(|| error_local("Codex no devolvió turnos"))?;
            if let Some(id) = turnos
                .get(n.saturating_sub(1))
                .and_then(|t| t["id"].as_str())
            {
                return Ok(id.into());
            }
            let siguiente = &r["nextCursor"];
            if turnos.is_empty() || siguiente.is_null() || siguiente == &cursor {
                return Err(error_local("rewind supera los turnos del hilo"));
            }
            n -= turnos.len();
            cursor = siguiente.clone();
        }
    }
}

impl ClienteCodexApp {
    pub fn steer(
        &self,
        texto: &str,
        imagenes: &[ImagenCodex],
        plazo: Duration,
    ) -> Result<Value, RpcError> {
        let (hilo, turno) = self.turno_activo()?;
        self.rpc.request(
            "turn/steer",
            json!({"threadId":hilo,"expectedTurnId":turno,"input":entrada(texto,imagenes)}),
            plazo,
        )
    }

    pub fn interrumpir(&self, plazo: Duration) -> Result<Value, RpcError> {
        let (hilo, turno) = self.turno_activo()?;
        self.rpc.request(
            "turn/interrupt",
            json!({"threadId":hilo,"turnId":turno}),
            plazo,
        )
    }

    pub fn compactar(&self, plazo: Duration) -> Result<Value, RpcError> {
        self.rpc.request(
            "thread/compact/start",
            json!({"threadId":self.hilo()?}),
            plazo,
        )
    }

    /// La bifurcación pasa a ser el hilo seleccionado por este cliente.
    #[allow(dead_code, reason = "operación interactiva reservada")]
    pub fn bifurcar(&self, plazo: Duration) -> Result<Value, RpcError> {
        self.abrir("thread/fork", json!({"threadId":self.hilo()?}), plazo)
    }

    #[allow(dead_code, reason = "catálogo interactivo de modelos")]
    pub fn modelos(&self, plazo: Duration) -> Result<Value, RpcError> {
        self.rpc.request("model/list", json!({}), plazo)
    }

    pub fn skills(&self, plazo: Duration) -> Result<Value, RpcError> {
        self.rpc.request("skills/list", json!({}), plazo)
    }
}
