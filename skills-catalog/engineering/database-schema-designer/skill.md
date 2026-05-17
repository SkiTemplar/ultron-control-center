---
name: database-schema-designer
description: >
  Diseño de schemas de base de datos relacionales con generación de migraciones, tipos TypeScript,
  RLS policies y estrategia de índices. Especializado en Supabase/PostgreSQL.
  Activar cuando: diseñando tablas nuevas · añadiendo multi-tenancy · revisando schema existente
  · generando tipos desde schema · planificando migración con breaking changes.
kind: skill
tier: L1
category: engineering
last_verified: 2026-05-03
tags: [database, schema, designer]
token_est: 1091
layer: L1-skills
---

# Database Schema Designer

## PRINCIPIOS INAMOVIBLES

```
1. Timestamps en TODAS las tablas (created_at, updated_at — siempre)
2. Soft deletes via deleted_at (nunca DELETE físico en datos de negocio)
3. RLS sobre application-level filtering (Supabase: siempre)
4. Nunca primary key mutable (no usar email, username, slug como PK)
5. Version column en tablas con updates concurrentes críticos
```

---

## TEMPLATE DE TABLA ESTÁNDAR

```sql
CREATE TABLE public.items (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  -- campos de negocio aquí --
  user_id     uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  timestamptz DEFAULT now() NOT NULL,
  updated_at  timestamptz DEFAULT now() NOT NULL,
  deleted_at  timestamptz  -- soft delete; NULL = activo
);

-- Trigger para updated_at automático
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON public.items
  FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

-- Índice para soft deletes (siempre)
CREATE INDEX idx_items_active ON public.items (user_id) WHERE deleted_at IS NULL;
```

---

## RLS POLICIES (Supabase)

```sql
-- Habilitar RLS (obligatorio)
ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;

-- SELECT: solo los propios + soft delete
CREATE POLICY "users_select_own" ON public.items
  FOR SELECT USING (
    auth.uid() = user_id AND deleted_at IS NULL
  );

-- INSERT: solo con su propio user_id
CREATE POLICY "users_insert_own" ON public.items
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- UPDATE: solo los propios activos
CREATE POLICY "users_update_own" ON public.items
  FOR UPDATE USING (
    auth.uid() = user_id AND deleted_at IS NULL
  );

-- DELETE: no permitir DELETE físico, usar soft delete via UPDATE
-- (no crear policy DELETE para forzar el patrón)
```

---

## ESTRATEGIA DE ÍNDICES

```sql
-- Índice simple para filtro frecuente
CREATE INDEX idx_orders_status ON orders(status) WHERE deleted_at IS NULL;

-- Índice compuesto: columna de filtro + columna de orden
CREATE INDEX idx_orders_user_created ON orders(user_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Índice parcial para estado específico frecuente
CREATE INDEX idx_orders_pending ON orders(created_at)
  WHERE status = 'pending' AND deleted_at IS NULL;
```

**Cuándo NO crear índice:** columnas con poca cardinalidad (boolean, enum de 3 valores) en tablas pequeñas (<10k filas).

---

## GENERACIÓN DE TIPOS TYPESCRIPT

```typescript
// Patrón para cada tabla
export interface Item {
  id: string;
  user_id: string;
  // campos de negocio
  created_at: string;  // ISO 8601
  updated_at: string;
  deleted_at: string | null;
}

export type ItemInsert = Omit<Item, 'id' | 'created_at' | 'updated_at' | 'deleted_at'>;
export type ItemUpdate = Partial<ItemInsert>;
```

Con Supabase: usar `supabase gen types typescript --project-id <id>` para generar desde schema real.

---

## CHECKLIST DE REVISIÓN DE SCHEMA

```
[ ] Todas las tablas tienen created_at, updated_at, deleted_at
[ ] PKs son UUIDs (nunca serial/bigserial en datos expuestos)
[ ] FKs tienen ON DELETE apropiado (CASCADE / RESTRICT / SET NULL)
[ ] RLS habilitada en todas las tablas de datos de usuario
[ ] Índice en cada columna de filtro frecuente
[ ] Índice compuesto para soft-delete en queries de listado
[ ] No hay campos de array donde debería haber tabla relacionada
[ ] Nombre de columnas: snake_case · sin abreviaciones oscuras
[ ] Enum de PostgreSQL vs string: preferir string con CHECK constraint para flexibilidad
```

---

## PATRONES COMUNES

**Multi-tenancy:** añadir `organization_id uuid REFERENCES organizations(id)` + RLS con `auth.jwt() ->> 'org_id'`

**Auditoría:** tabla `_audit_log` con `table_name, record_id, action, old_data jsonb, new_data jsonb, changed_by, changed_at`

**Versioning optimista:** añadir `version integer DEFAULT 0`, incrementar en cada UPDATE, verificar en `WHERE id = ? AND version = ?`
