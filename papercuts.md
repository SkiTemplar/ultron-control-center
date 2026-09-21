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
