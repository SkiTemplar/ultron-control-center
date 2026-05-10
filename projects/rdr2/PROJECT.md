---
name: RDR2 Mods
type: project
updated: 2026-04-28
---

# RDR2 Mods — PROJECT.md

## Objetivo
Tuning del modding de Red Dead Redemption 2 — principalmente PedDamageOverhaul Reloaded (PDOR) para conseguir un combat feel realista (sufrimiento gradual, daños históricamente alineados, dying states largos en free-roam y cortos en misión).

## Stack
- **Engine:** RDR2 (RAGE) — modding via ASI loader
- **Lenguaje:** INI configs · meta files
- **Mod principal:** PedDamageOverhaul Reloaded (PDOR)
- **Skill principal:** ULTRON directo (no hay persona dedicada al modding RDR2)

## Rutas
```
Instalación:  C:\Program Files (x86)\Steam\steamapps\common\Red Dead Redemption 2\
Config PDO:   PedDamageOverhaul.ini  (1409 líneas, 26 secciones)
ASI:          PedDamageOverhaul.asi
Meta data:    lml\PDO Reloaded\common\data\ai\peddamageinfo.meta
```

## Estado actual
Tuning de PDO verificado el 2026-04-26. Free-roam con DS largos (sufrimiento), mission con DS cortos (no romper scripts tipo Javier Escuella). Realism Pass §21 ajustado: Lancaster ya pega más por bala que el Cattleman, alineado con realismo histórico.

## Secciones tocadas en PedDamageOverhaul.ini
- §2 Health/Damage base NPC
- §4 Body part modifiers (Leg/Arm/Torso/Head/Neck)
- §5 Dying State thresholds + tiempos DS1/DS2/DS3 (free-roam y mission)
- §7 Arterial bleeding fix
- §9 Enhanced headshots por arma (NO tocado — vanilla está bien)
- §21 Damage por arma individual

## Pendientes
- [ ] Probar §23 Munitions Custom si añade Online Content Unlocker (Walker, Webley, Luger, M1903...)
- [ ] Validar comportamiento §12/§13 (surrender + fear reactions) en free-roam con civilians

## Decisiones clave
- **DS Mission cortos (3-12s)** porque DS largos rompen scripts de misión (Javier Escuella se quedaba parado).
- **Revolvers bajados, repeaters subidos** para que Lancaster (.44-40 cañón largo) supere al Cattleman (.45 LC) en daño por bala — alineación histórica, no balance arcade.
- **`DyingStateProgressionTime_LongerMultiplier = 20`** = 2.0x (se divide entre 10), NO 20x.
- **AmmoGroupDamageModifier = 0** → usa valores individuales del §21.

## Notas
- Si una misión se atasca tras matar NPCs, sospechoso #1 son DS Mission times altos.
- "Longer Bleedout" in-game multiplica TANTO free-roam COMO mission — con mission cortos, x2 sigue manejable.
- Multiplicadores §21 se aplican SOBRE el daño base vanilla (revólveres ~30, repeaters ~22).
