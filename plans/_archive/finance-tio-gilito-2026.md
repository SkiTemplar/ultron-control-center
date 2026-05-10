# Plan — Tío Gilito Dashboard
> **Estado:** pendiente · **Inicio previsto:** semana 2026-05-12
> **Predecesor:** ULTRON Genesis v14.0.0 cerrado 2026-05-06

---

## Estado actual del proyecto (verificado 2026-05-06)

**DB:** `C:\Users\USER\CARRERA\PROYECTOS_PERSONALES\Bank\finanzas\finanzas.db`
- 52 movimientos · rango 2026-04-07 → 2026-05-05
- Tablas: `movimientos`, `fondos`, `sqlite_sequence`, `stats_mensuales`
- Columnas en `movimientos`: id · fecha · descripcion · importe · tipo · categoria · fondo_asociado · pct_ahorro_aplicado · notas · sincronizado_notion · **es_reembolso** (ya añadida)

**Fondos activos:**
- Emergencias: 39.20€ ahorrado
- Polonia: 0€ / 500€ objetivo
- Monitor: 0€ / 300€ objetivo
- Inversión: 0€ / 1000€ objetivo
- Viaje: 58.80€ ahorrado

**Dashboard:** `finanzas/dashboard.py` — Streamlit, Dark Midnight design system, existe y arranca

**Skill:** `~/.claude/skills/tio-gilito/` — persona completa con protocolos DB y scripts

---

## Lo que falta / se quiere mejorar

> Pendiente de confirmar con USER al inicio de la sesión. Esta lista es lo que se sabe hasta ahora.

### Confirmado como pendiente

- [ ] **Reembolsos en dashboard** — `es_reembolso` ya existe en DB pero hay que asegurarse de que el dashboard lo usa correctamente: KPI "Ingresos reales" excluye WHERE es_reembolso=1, columna "↩" en historial, checkbox toggle en data_editor
- [ ] **Sync KutxaBank** — `sync_kutxabank.py` existe pero no sé si está funcionando; verificar flujo completo importar → categorizar → guardar
- [ ] **Auto-categorización** — `db-protocols.md` define keywords (mercadona→🛒, netflix→📱, etc.) pero no está claro si hay código que lo aplica automáticamente en el sync

### Por decidir al arrancar

- Qué más quiere USER mejorar esta semana

---

## Criterio de DONE

> Definir con USER al empezar. Propuesta:
> - Dashboard refleja correctamente ingresos reales (excluye reembolsos)
> - USER puede importar un extracto de KutxaBank y los movimientos aparecen categorizados en el dashboard sin pasos manuales

---

## Rutas de referencia rápida

```
DB:        C:\Users\USER\CARRERA\PROYECTOS_PERSONALES\Bank\finanzas\finanzas.db
Config:    C:\Users\USER\CARRERA\PROYECTOS_PERSONALES\Bank\finanzas\config.json
Dashboard: C:\Users\USER\CARRERA\PROYECTOS_PERSONALES\Bank\finanzas\dashboard.py
Skill:     C:\Users\USER\.claude\skills\tio-gilito\SKILL.md
Protocolos DB: C:\Users\USER\.claude\skills\tio-gilito\references\db-protocols.md
```

---

## Para arrancar la sesión

```
1. Leer este archivo
2. Preguntar a USER: ¿qué quieres que funcione al final de la sesión?
3. Verificar que el dashboard arranca: cd finanzas && uv run streamlit run dashboard.py
4. Lanzar "Ultron /high" para la sesión
```
