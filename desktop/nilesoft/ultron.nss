// Entradas propias del menú contextual (tema Noche).

// Visual Studio registra su propia entrada; se sustituye por VS Code.
modify(find='Abrir con Visual Studio' vis=vis.remove)

// Entradas que sobran (2026-10-27): para editar se usa VS Code, y el resto no se usa.
modify(find='Edit with CLion|Edit with IntelliJ IDEA|Edit with PyCharm|Edit with WebStorm' vis=vis.remove)
modify(find='Open Folder as IntelliJ IDEA Project|Open Folder as PyCharm Project|Open Folder as WebStorm Project' vis=vis.remove)
modify(find='Editar en el Bloc de notas|Agregar a Favoritos|Examinar con Microsoft Defender' vis=vis.remove)
modify(find='Open Git GUI here' vis=vis.remove)

// Más entradas que sobran (2026-10-28). Escritorio: ubicación de red. Carpetas: ChatGPT, CEWE, Google Drive
// (DriveFS) y Git Bash; los anclajes solo en carpetas y unidades, para conservar «Anclar a Inicio» en archivos.
modify(find='Agregar una ubicación de red' vis=vis.remove)
modify(find='Open project in ChatGPT|Programa de creación CEWE|Open Git Bash here' vis=vis.remove)
modify(find='Crear copia de seguridad de esta carpeta' vis=vis.remove)
modify(type='dir|drive' find='Anclar a Inicio|Anclar a Acceso rápido' vis=vis.remove)

// VS Code en la carpeta actual, la carpeta o el archivo seleccionado.
item(title='Abrir con VS Code' type='back.dir|dir|drive|file' image=[\uE272, #22A7F2] cmd='code' args='"@sel.path"' window=hidden)

// Sesión nueva de Claude en ULTRON Sessions con esta carpeta como directorio (control-center.exe --sesiones-cwd).
item(title='ULTRON Sessions aquí' type='back.dir|dir|drive' image='@user.dir\AppData\Local\Lienzo\icons\sessions-disco.ico' cmd='@user.dir\.ultron\control-center\src-tauri\target\release\control-center.exe' args='--sesiones-cwd "@sel.path"')
