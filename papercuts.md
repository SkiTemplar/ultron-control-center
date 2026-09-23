# Papercuts

Log compartido por todas las sesiones de Claude: cosas que hicieron perder
tiempo durante el desarrollo, con su arreglo. **Consultar este fichero primero
cuando el tooling falle de forma rara.**

Formato: una línea por papercut.

`YYYY-MM-DD · síntoma · arreglo · proyecto`

Sin narrativa: si hace falta el detalle, vive en el commit o en la memoria.
Cuando una entrada deja de ser cierta (herramienta actualizada, causa
eliminada), se borra — un log de fricciones obsoletas cuesta más de lo que
ahorra.

---

2026-09-21 · `node -e "..."` con comillas dobles destroza los backslashes de una ruta Windows; `C:\Users\x\dir` llega al script como `C:Usersxdir` · escribir el script a un fichero con Write y ejecutarlo · ultron
2026-09-21 · `cargo test` lanzado por el hook mientras otro `cargo test` corre sobre el mismo `target/` da exit 101 sin ningún test roto · reejecutar en serie antes de buscar el fallo · ultron
2026-09-21 · `where code` lista `bin\code` (script POSIX, no ejecutable en Windows) ANTES de `code.cmd`; pasar el nombre desnudo a `cmd /C` da exit 9009 y `%~dp0` resuelve contra el cwd del que llama · resolver siempre a la ruta absoluta del `.cmd`/`.bat`/`.exe` · ultron
2026-09-21 · robocopy (`/LOG+`, codepage OEM) y `Write-Log` (Tee-Object, UTF-16LE en PS 5.1) escribiendo al mismo fichero producen un log ilegible que esconde los errores reales · un fichero de log por cada productor · ultron
2026-09-21 · robocopy devuelve exit 9 en `Documents` por las junctions de compatibilidad XP (`Mis vídeos`, `Mis imágenes`, `Mi música`), que llevan una ACL de denegación · `/XJD` para saltar junctions de directorio · ultron
2026-09-21 · una tarea del Programador de Windows con `DisallowStartIfOnBatteries` falla con 0x800710E0 en portátil y, sin `StartWhenAvailable`, no reintenta · desmarcar las condiciones de energía y activar el reintento · ultron
2026-09-22 · `ultron-memory reindex --help` (o cualquier `<sub> --help`) NO imprime ayuda: ejecuta el subcomando (cargó E5 y empezó a reindexar 1.975 items). La ayuda solo sale sin argumentos · `bin/ultron-memory.exe` a secas lista los subcomandos · ultron
2026-09-22 · `DELETE /collections/<c>` en Qdrant con un segmento cuyo mmap ha entrado en pánico devuelve "Acceso denegado (os error 5)", borra la colección del catálogo pero deja el directorio con los LOCK de RocksDB retenidos; `PUT` de la misma colección falla con "Collection data already exists" · `Stop-ScheduledTask UltronQdrant` + 12 s + borrar el directorio + `Start-ScheduledTask` (memoria qdrant-hidden-launch-and-no-forcekill) · ultron
2026-09-22 · FTS5 `integrity-check` sin segundo argumento da OK sobre un índice de contenido externo con rowids huérfanos (10.205 filas frente a 4.390 items); solo `('integrity-check', 1)` lo detecta, y `SELECT rowid ... MATCH` tampoco falla: falla al leer una columna · `ultron-memory doctor` (check `fts`) + `ultron-memory fts-rebuild` · ultron
2026-09-22 · `INSERT OR REPLACE` sobre una tabla con índice FTS5 de contenido externo: el DELETE implícito de REPLACE no dispara el trigger AFTER DELETE (hace falta `PRAGMA recursive_triggers=ON`) y la fila nueva recibe otro rowid → una fila huérfana en el índice por cada actualización; en brain.db 10.205 frente a 4.390 · pragma en `apply_schema` + `ultron-memory fts-rebuild`; test `reinsertar_el_mismo_id_no_deja_filas_huerfanas_en_fts` · ultron
2026-09-22 · Git Bash convierte también variables de entorno con rutas '/Game/...' a 'C:/Program Files/Git/Game/...' · MSYS2_ENV_CONV_EXCL="NOMBRE_VAR" (además de MSYS2_ARG_CONV_EXCL para argumentos) · tortunabo
2026-09-23 · Qdrant caído a las 17:21 y el watchdog no lo relanza: la unidad D: desapareció (qdrant.exe y datos en D:\Ultron\qdrant\) · reconectar/montar D:; el recall cae a solo texto y los evals salen degradados (infra_down) · ultron
