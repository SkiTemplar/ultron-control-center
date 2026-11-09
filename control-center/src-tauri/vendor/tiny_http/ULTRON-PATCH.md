# tiny_http 0.12.0 parcheado

Copia de `tiny_http` 0.12.0 (crates.io, la última publicada) con un único cambio en
`src/util/task_pool.rs`, función `TaskPool::spawn`.

**Fallo:** el pool que atiende cada conexión decide si crear un hilo mirando `waiting_tasks == 0`.
Un hilo al que se ha despertado sigue contando como «en espera» hasta que vuelve a tomar el lock y
saca su tarea. Si llegan dos conexiones seguidas con un solo hilo en espera, las dos se encolan
para ese hilo; la segunda queda en la cola hasta que termine otra conexión. En el puente de
Sessions las conexiones de sondeo largo y las retenidas duran mucho, así que una petición podía
quedarse colgada. Lo destapó `la_peticion_33_de_control_es_503_y_events_sigue_respondiendo` en
windows-latest (2026-11-02): 31 de 32 peticiones retenidas dentro y ninguna terminada a los 60 s.

**Arreglo:** se crea un hilo nuevo salvo que los hilos en espera superen a las tareas ya
encoladas (`waiting_tasks <= queue.len()`).

Se elimina este directorio y su línea de `[patch.crates-io]` en `Cargo.toml` si una versión
publicada de `tiny_http` corrige `TaskPool::spawn`.
