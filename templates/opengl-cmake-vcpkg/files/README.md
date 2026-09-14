# {{name}}

Proyecto OpenGL creado con `project-create.mjs` (plantilla `opengl-cmake-vcpkg`).

## Build

1. Abre la carpeta en tu IDE (CLion / VS Code con CMake Tools).
2. Configura con el preset `Debug-OpenGL` (`CMakePresets.json`).
3. Build: `cmake --build --preset Debug-OpenGL` o el atajo de tu IDE.

`CMAKE_EXPORT_COMPILE_COMMANDS` esta activado: `compile_commands.json` queda
en el directorio de build para que clangd funcione sin configuracion extra.

## Dependencias (manifest de vcpkg)

- **GLFW3** — ventana + input + contexto
- **GLAD**  — cargador de funciones de OpenGL
- **GLM**   — matematicas (vectores, matrices)

Toolchain de vcpkg esperado en `C:/vcpkg/scripts/buildsystems/vcpkg.cmake`.
