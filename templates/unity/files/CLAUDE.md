# CLAUDE.md — {{name}}

## Qué es

Proyecto de Unity ({{unity_version}}). Completar aquí el concepto del juego o de la práctica.

## Stack

- Unity {{unity_version}} (Unity Hub); C#; paquetes en `Packages/manifest.json`.
- Sin `.csproj` ni `.sln` versionados: los regenera el editor.

## Cómo compilar / ejecutar

Abrir la carpeta desde Unity Hub. Para compilar sin interfaz:

```powershell
& "C:/Program Files/Unity/Hub/Editor/{{unity_version}}/Editor/Unity.exe" -batchmode -quit -projectPath . -logFile -
```

## Tests

Pendiente: añadir `com.unity.test-framework` desde el Package Manager y crear tests en
`Assets/Tests/` (Edit Mode para lógica pura, Play Mode para escenas). Regla: la lógica que
mueve números va en clases C# puras, sin `MonoBehaviour`, para poder probarla sin escena.
