---
name: RDR2 Mods — Memory
type: memory
updated: 2026-04-28
---

# RDR2 Mods — memory.md

> Fuente original: `~/.claude/projects/C--Program-Files--x86--Steam-steamapps-common-Red-Dead-Redemption-2/memory/`
> Traspasado a Ultron CORE el 2026-04-28.

---

## 🎯 PDO Combat Feel — Filosofía de balance

USER prefiere en PedDamageOverhaul:
- **Torso/pecho** (rifle, sniper, escopeta cercana) → entrar a dying state (DS2/DS3) y agonizar, NO muerte instantánea.
- **Extremidades** (brazos, piernas) → dejar al NPC herido pero vivo, sin matar.
- **Headshot** → letal casi siempre (vanilla enhanced headshots está bien).
- NPCs deben **sufrir** (dying states largos, sonidos, bleed out) antes de morir en free-roam.
- Un disparo al torso NO debe permitir que se levanten (salvo arterial raro).
- **Daño de armas alineado con realismo histórico**, no balance arcade.

**Why:** Le rompe la inmersión que mueran "muy rápido", que un escopetazo a la pierna mate instant, que un sniper al pecho los deje solo dolidos, o que un Lancaster (.44-40 cañón largo) pegue menos que un Cattleman.

---

## ⏱️ DS Times — verificado 2026-04-26

**Free-roam (sufrimiento — mantener largos):**
```ini
DS1_TimeMin/Max = 65000-165000
DS2_TimeMin/Max = 60000-140000
DS3_TimeMin/Max = 110000-250000
```

**Mission (apretar para no romper scripts — Javier Escuella se quedaba parado con 10-30s):**
```ini
DS1_MissionTimeMin/Max = 4000-12000
DS2_MissionTimeMin/Max = 4000-10000
DS3_MissionTimeMin/Max = 3000-8000
```

**Otros parámetros:**
- HP NPC > 100
- TorsoDamageModifier ~115
- Leg/Arm < 20
- ArterialBleedIgnoreDSChance bajo (~5)
- DyingStateEntryInstantDeathChance ≤ 1

---

## 🔫 Realism Pass §21 — verificado 2026-04-26

**Revolvers** (bajados para que Lancaster pegue más por bala que Cattleman, históricamente correcto):
- `CATTLEMAN` (todas variantes) = **72** (era 82, .45 LC realista)
- `DOUBLEACTION` (todas) = **62** (era 70, .38 cal cañón corto)
- `SCHOFIELD` (todas) = **80** (era 88, .45 Schofield premium)
- `LEMAT` = **92** (sin tocar, justifica por cañón secundario shotgun)
- `NAVY` (ambas) = **70** (era 90, corrección histórica .36 cap-and-ball)

**Pistols** (subidas — munición moderna era más letal de lo que PDO asumía):
- `M1899` = **58** (era 50)
- `MAUSER` + `MAUSER_DRUNK` = **65** (era 50, 7.63 Mauser de alta velocidad)
- `SEMIAUTO` = **62** (era 56)
- `VOLCANIC` = **55** (sin tocar, históricamente débil)

**Repeaters** (subidos para superar a revólveres en daño absoluto):
- `CARBINE` = **90** (era 85, .44-40 cañón largo)
- `EVANS` = **85** (sin tocar)
- `HENRY` = **88** (era 90, .44 rimfire débil)
- `WINCHESTER` (Lancaster) = **108** (era 102, premium repeater)

**Resultado efectivo** (vanilla base ~30 revólveres, ~22 repeaters):
LeMat 27.6 > Lancaster 23.76 > Schofield 24 > Lowry 22.5 > Cattleman 21.6 > Navy 21 > Carbine 19.8 > Henry 19.4 > Evans 18.7 > DoubleAction 18.6.
**Lancaster ya pega más por bala que el Cattleman ✓**

---

## 🚧 §23 Munitions Custom — NO tocado

Solo aplica si tiene Munitions o usa esos hashes vía Online Content Unlocker.
Si USER añade Walker, Webley, Luger, M1903, M1906, etc., considerar:
- `WEAPON_REVOLVER_WALKER` = 85 → 95 (Colt Walker .44 black powder, biggest ever)
- `WEAPON_PISTOL_LUGER` = 65 → 72 (9×19 Parabellum)

---

## 📁 Rutas y estructura del mod

**Instalación RDR2:** `C:\Program Files (x86)\Steam\steamapps\common\Red Dead Redemption 2\`

**PedDamageOverhaul Reloaded (PDOR):**
- Config editable: `PedDamageOverhaul.ini` (1409 líneas, 26 secciones)
- ASI: `PedDamageOverhaul.asi`
- Meta data: `lml\PDO Reloaded\common\data\ai\peddamageinfo.meta`

**Estructura del INI útil:**
- §2 Health/Damage base NPC
- §4 Body part modifiers (Leg/Arm/Torso/Head/Neck)
- §5 Dying State thresholds + tiempos DS1/DS2/DS3
- §7 Arterial bleeding fix
- §9 Enhanced headshots por arma
- §10 Fire logic
- §12 Surrender personalities (coward/neutral/toughguy)
- §13 Fear reactions (panic cuando caen aliados)
- §21 Damage por arma individual

---

## ⚠️ Notas técnicas críticas

- `DyingStateProgressionTime_LongerMultiplier = 20` → significa **2.0x**, NO 20x (se divide entre 10).
- "Longer Bleedout" en menú in-game multiplica TANTO free-roam COMO mission times — con mission cortos, x2 sigue manejable (DS3 hasta 16s).
- Multiplicadores §21 se aplican SOBRE el daño base vanilla. Por eso revólveres a 82 podían pegar más que repeaters a 102 (vanilla base 30 vs 22).
- `AmmoGroupDamageModifier` todos a 0 = usa valores individuales del §21.
- §9 (Enhanced Headshots) no tocado: Revolver 80% instant + 20% DS3, Pistol 75/25, Repeater 85/15. Headshot siempre crítico.
- Si una misión se atasca tras matar NPCs, sospechoso #1 son DS Mission times altos (ya bajados).
