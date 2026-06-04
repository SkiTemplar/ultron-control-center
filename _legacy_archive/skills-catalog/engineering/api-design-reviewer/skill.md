---
name: api-design-reviewer
description: >
  Revisión de diseño de APIs REST: convenciones, breaking changes, seguridad, versionado.
  Activar cuando: diseñando endpoints nuevos · revisando API antes de deploy · detectando
  breaking changes entre versiones · scorecard de calidad de API · Supabase RPC design.
kind: skill
tier: L1
category: engineering
last_verified: 2026-05-03
tags: [api, design, reviewer]
token_est: 899
layer: L1-skills
---

# API Design Reviewer

## CHECKLIST DE LINTING

### Naming de recursos

```
✅ kebab-case para URLs:       /api/v1/user-profiles
✅ Plural para colecciones:    /api/v1/orders (no /api/v1/order)
✅ Sustantivos, no verbos:     /api/v1/orders (no /api/v1/getOrders)
✅ IDs en path:                /api/v1/orders/{id}
✅ Acciones como subrecurso:   /api/v1/orders/{id}/cancel
❌ Verbos en recursos:         /api/v1/createOrder
❌ Mezcla de cases:            /api/v1/userProfiles
```

### HTTP Methods

| Operación | Método | Idempotente |
|---|---|---|
| Leer colección | GET | Sí |
| Leer recurso | GET /{id} | Sí |
| Crear | POST | No |
| Reemplazar completo | PUT /{id} | Sí |
| Actualizar parcial | PATCH /{id} | No (idealmente sí) |
| Eliminar | DELETE /{id} | Sí |

### Status Codes

```
200 OK          — GET exitoso, PUT/PATCH exitoso con body
201 Created     — POST que crea recurso (incluir Location header)
204 No Content  — DELETE exitoso, PUT sin body
400 Bad Request — Validación fallida (incluir qué campo falló)
401 Unauthorized — Sin autenticación
403 Forbidden   — Autenticado pero sin permiso
404 Not Found   — Recurso no existe
409 Conflict    — Estado incompatible (ej: duplicado)
422 Unprocessable — Lógica de negocio fallida (datos válidos pero no procesables)
429 Too Many Requests — Rate limit
500 Internal Server Error — Error no manejado (nunca debería llegar al cliente)
```

---

## BREAKING CHANGE DETECTION

Cambios que ROMPEN compatibilidad (requieren versión mayor):

```
❌ Eliminar endpoint existente
❌ Cambiar método HTTP de un endpoint
❌ Eliminar campo del response body
❌ Cambiar tipo de campo (string → number)
❌ Cambiar status code de respuesta exitosa
❌ Hacer campo opcional → requerido en request
```

Cambios seguros (no rompen):

```
✅ Añadir campo nuevo al response (clientes ignoran lo que no conocen)
✅ Hacer campo requerido → opcional en request
✅ Añadir endpoint nuevo
✅ Añadir valores a enum (si el cliente maneja unknown gracefully)
```

---

## FORMATO DE ERROR ESTÁNDAR

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "El campo email es inválido",
    "field": "email",
    "request_id": "req_abc123",
    "timestamp": "2026-04-22T10:00:00Z"
  }
}
```

Nunca exponer stack traces en producción.
Siempre incluir `request_id` para debugging.

---

## SCORING (0–10)

| Dimensión | Peso | Qué evaluar |
|---|---|---|
| Consistency | 30% | Naming uniforme, métodos correctos, status codes coherentes |
| Documentation | 20% | Descripción, params, responses, ejemplos en OpenAPI/Postman |
| Security | 20% | Auth en todos los endpoints protegidos, no exponer IDs internos |
| Usability | 15% | Paginación, filtros, ordenación, respuestas predecibles |
| Performance | 15% | Caching headers, paginación obligatoria, campos filtrables |

---

## PATRONES RECOMENDADOS

**Paginación:**
```
GET /api/v1/orders?page=1&limit=20
→ { data: [...], meta: { total, page, limit, pages } }
```

**Filtros:**
```
GET /api/v1/orders?status=pending&user_id=123&sort=-created_at
```

**Versionado:** URL-based es el más claro: `/api/v1/`, `/api/v2/`

**Supabase RPC:** usar solo para operaciones que no encajan en REST (transacciones complejas, cálculos server-side).
