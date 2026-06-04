---
name: openapi-validator
description: >
  Validación de specs OpenAPI/Swagger 3.x: completitud, consistencia, breaking changes, seguridad.
  Activar cuando: escribiendo openapi.yaml/swagger.json · revisando antes de codegen · detectando
  drift entre spec y código real · validando que todos los endpoints están documentados ·
  validando breaking changes · comparando versiones de spec.
kind: skill
tier: L1
category: misc
last_verified: 2026-05-03
tags: [openapi, validator]
token_est: 1226
layer: L1-skills
---

# OpenAPI Validator

## CHECKLIST DE COMPLETITUD

```
✅ Cada endpoint tiene summary + description
✅ Todos los parámetros documentados con type + description
✅ Responses documentan 2xx Y errores (4xx, 5xx)
✅ Request bodies tienen schema completo
✅ Operaciones tienen operationId único (para codegen)
✅ Schemas usan $ref para reutilización (no duplicación)
✅ securitySchemes definidos en components y referenciados en endpoints
❌ Schemas inline en múltiples lugares (duplicación → drift)
❌ Paths sin response para error 500
❌ operationId: "getUser1", "getUser2" (no descriptivos)
```

## ANTI-PATRONES COMUNES

### Falta de discriminación en oneOf/anyOf
```yaml
# MAL — el cliente no sabe cómo distinguir los tipos
schema:
  oneOf:
    - $ref: '#/components/schemas/Dog'
    - $ref: '#/components/schemas/Cat'

# BIEN — discriminator explícito
schema:
  oneOf:
    - $ref: '#/components/schemas/Dog'
    - $ref: '#/components/schemas/Cat'
  discriminator:
    propertyName: type
```

### Nullable vs required
```yaml
# OpenAPI 3.0 — nullable: true
properties:
  deletedAt:
    type: string
    format: date-time
    nullable: true

# OpenAPI 3.1 — usar type array
properties:
  deletedAt:
    type: [string, 'null']
    format: date-time
```

### Paginación sin schema estándar
```yaml
# Definir una vez en components/schemas
PaginatedResponse:
  type: object
  required: [data, meta]
  properties:
    data:
      type: array
    meta:
      $ref: '#/components/schemas/PaginationMeta'

PaginationMeta:
  type: object
  required: [total, page, limit]
  properties:
    total: { type: integer }
    page: { type: integer }
    limit: { type: integer }
```

## BREAKING CHANGE DETECTION

Cambios que ROMPEN contratos de clientes:
```
❌ Eliminar endpoint (path o method)
❌ Eliminar campo de response schema
❌ Cambiar tipo de campo existente (string → integer)
❌ Añadir campo required al request body
❌ Cambiar status code de respuesta exitosa
❌ Eliminar valor de enum
```

Cambios seguros (backward compatible):
```
✅ Añadir campo opcional al request body
✅ Añadir campo al response (additive)
✅ Añadir endpoint nuevo
✅ Añadir valor a enum (si los clientes manejan unknown)
✅ Añadir operationId a endpoints que no lo tenían
```

## VALIDACIÓN DE SEGURIDAD

```yaml
# components/securitySchemes correcto
components:
  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
    ApiKey:
      type: apiKey
      in: header
      name: X-API-Key

# Aplicar globalmente (o por endpoint)
security:
  - BearerAuth: []
```

Verificar:
- Endpoints protegidos tienen `security` explícito (o heredan del global)
- Endpoints públicos tienen `security: []` explícito para evitar ambigüedad
- No exponer IDs internos (UUIDs en la spec, no auto-increment integers)

## HERRAMIENTAS CLI

```bash
# Lint spec con Spectral (reglas OAS + custom)
npx @stoplight/spectral-cli lint openapi.yaml

# Detectar breaking changes entre dos versiones
npx oasdiff breaking old.yaml new.yaml
npx oasdiff breaking old.yaml new.yaml --fail-on-incompatible   # exit code 1 si hay breaks

# Lint + validación completa con Redocly
npx @redocly/cli lint openapi.yaml
npx @redocly/cli stats openapi.yaml    # cobertura: endpoints, operationIds, ejemplos

# Generar cliente TypeScript desde spec (verificar que spec valida primero)
npx openapi-typescript openapi.yaml -o src/api/types.ts
```

## OAS 3.1 — CAMBIOS CRÍTICOS vs 3.0

| Feature | OAS 3.0 | OAS 3.1 |
|---|---|---|
| Nullable | `nullable: true` | `type: [string, 'null']` |
| exclusiveMinimum/Maximum | `exclusiveMinimum: true` (boolean) | `exclusiveMinimum: 5` (numeric) |
| Webhooks | No existía | `webhooks:` al nivel raíz |
| $schema | No soportado | Soportado a nivel de schema individual |
| Referencias | `$ref` opaco | `$ref` soporta sibling keywords |

```yaml
# OAS 3.1 — webhooks (notificaciones push al cliente)
webhooks:
  orderStatusChanged:
    post:
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/OrderStatusEvent'
      responses:
        '200':
          description: Webhook recibido correctamente
```

## SCORING (0–10)

| Dimensión | Peso |
|---|---|
| Completitud (todos los endpoints, params, responses) | 35% |
| Consistencia (naming, $ref reutilización, no duplicación) | 30% |
| Seguridad (auth definida y aplicada) | 20% |
| Usabilidad (operationIds, ejemplos, descriptions) | 15% |
