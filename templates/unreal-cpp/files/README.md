# {{name}}

Proyecto de Unreal Engine 5.6 con C++ (módulo `{{identifier}}`).

## Compilar y probar

```powershell
powershell -File Tools/build.ps1                  # editor (Development)
powershell -File Tools/build.ps1 -Target Game     # juego
powershell -File Tools/test.ps1                   # Automation Tests sin interfaz
```

Con el editor abierto, la compilación por línea de comandos falla por Live Coding: cerrarlo antes.
La primera vez, clic derecho en `{{identifier}}.uproject` → *Generate Visual Studio project files*.
