# CLAUDE.md — {{name}}

## Qué es

Proyecto de Unreal Engine 5.6 con C++20 (módulo único `{{identifier}}`). Completar aquí el
concepto del juego o de la práctica.

## Stack

- Unreal Engine 5.6 (`C:/Program Files/Epic Games/UE_5.6`; variable `UE_ROOT` para cambiarlo).
- Módulo `{{identifier}}` en `Source/{{identifier}}/`; categoría de log `Log{{identifier}}`.

## Cómo compilar / ejecutar

```powershell
powershell -File Tools/build.ps1                  # editor (Development)
powershell -File Tools/build.ps1 -Target Game     # juego
```

Con el editor abierto, `Build.bat` falla por Live Coding: cerrarlo antes de compilar.

## Tests

```powershell
powershell -File Tools/test.ps1 [-Filter <prefijo>]
```

Automation Tests en `Source/{{identifier}}/Tests/*.cpp`; el script falla si algún test no pasa
o si no se ejecuta ninguno. Regla: la lógica que mueve números va en funciones puras con su
test, sin depender del mundo ni de actores.
