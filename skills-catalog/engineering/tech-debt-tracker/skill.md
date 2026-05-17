---
name: tech-debt-tracker
description: >
  Identificación, priorización y gestión de deuda técnica en proyectos activos.
  Activar cuando: "refactor planificado" · "antes de que esto explote" · code review revela deuda sistémica
  · sprint planning con tech debt · decisión de pagar deuda vs feature nueva.
kind: skill
tier: L1
category: engineering
last_verified: 2026-05-03
tags: [tech, debt, tracker]
token_est: 827
layer: L1-skills
---

# Tech Debt Tracker

## TAXONOMÍA DE DEUDA

| Tipo | Descripción | Urgencia típica |
|---|---|---|
| **Code debt** | Duplicación, funciones largas, nombres confusos | Media |
| **Architecture debt** | Módulos mal acoplados, violaciones de capas | Alta |
| **Test debt** | Cobertura insuficiente, tests frágiles o vacíos | Alta |
| **Documentation debt** | APIs sin doc, onboarding imposible | Media |
| **Dependency debt** | Paquetes outdated, vulnerabilidades conocidas | Alta si CVE |
| **Performance debt** | Código que funciona pero no escala | Baja (hasta que explota) |

---

## FASE 1 — SCAN

Señales de deuda en el código:

```
🔴 CRÍTICO (bloquea features o causa bugs en prod)
- TODO/FIXME antiguo (>30 días) en path crítico
- Catch vacío o silencioso: catch(e) {}
- any en TypeScript en interfaces de dominio
- Función >200 líneas sin tests
- Módulo con >5 responsabilidades

🟡 MODERADO (frena velocidad pero no bloquea)
- Duplicación >20 líneas en 3+ lugares
- Magic numbers sin constante nombrada
- Dependencia deprecada sin alternativa
- Sin validación en boundary externo (API input)

🟢 BAJO (polish cuando haya slack)
- Nombres genéricos (data, info, temp, result)
- Comentarios que describen qué, no por qué
- Imports sin usar
```

---

## FASE 2 — PRIORIZAR (Cost of Delay)

Para cada ítem de deuda, estimar:

```
IMPACTO EN VELOCIDAD: cuántos sprints/semanas ralentiza al mes (0–5)
RIESGO DE BUG: probabilidad de causar incidente (0–5)
ESFUERZO DE PAGO: horas para resolverlo (S/M/L/XL)
SCORE = (impacto + riesgo) / esfuerzo_normalizado
```

Priorizar los de mayor score. Ignorar los de score <1 hasta que cambien las circunstancias.

---

## FASE 3 — PLAN DE PAGO

### Reglas de integración en sprint

- Máx 20% del sprint a deuda técnica (para no parar features)
- "Boy Scout Rule": dejar el código mejor de como lo encontraste
- Refactor = siempre con tests antes de cambiar
- No mezclar deuda + feature en el mismo PR

### Template de ítem de deuda

```markdown
## [ID] Título corto

**Tipo:** Code / Architecture / Test / Dependency
**Severidad:** 🔴 Crítico / 🟡 Moderado / 🟢 Bajo
**Score:** X.X
**Ubicación:** `src/module/file.ts:L42`
**Descripción:** qué es el problema
**Impacto actual:** qué ralentiza o qué riesgo tiene
**Plan de pago:** cómo se resuelve
**Esfuerzo:** S (1-2h) / M (4-8h) / L (1-3d) / XL (>3d)
**Bloqueado por:** [otro ítem si aplica]
```

---

## PITFALLS A EVITAR

- **Analysis paralysis**: time-box el scan a 2h máximo
- **Perfectionism**: acceptable debt existe — no todo se paga
- **Ignorar business context**: deuda en feature muerta = no pagarla
- **Over-engineering el tracker**: una lista en PROJECT.md es suficiente para proyectos personales

---

## OUTPUT ESPERADO

Al final del tracker, producir:
1. Lista priorizada con scores
2. Top 3 ítems para el próximo sprint
3. Estimación de velocidad recuperable tras pagar top 3
4. Guardar en `projects/<nombre>/tech-debt.md`
