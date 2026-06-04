---
name: db-migration-safety
description: >
  Seguridad en migraciones de base de datos: zero-downtime, rollback, operaciones peligrosas.
  Activar cuando: database migration · Alembic · Prisma migrate · schema change · ALTER TABLE ·
  zero-downtime deploy · migration rollback · expand-contract · column rename · backfill ·
  NOT NULL sin default · índice en tabla grande · DROP COLUMN.
kind: skill
tier: L1
category: database
last_verified: 2026-05-03
tags: [migration, safety]
token_est: 1592
layer: L1-skills
---

# DB Migration Safety

## OPERACIONES POR RIESGO

### ALTO RIESGO — pueden lockear tablas completas en producción
```sql
-- ❌ NOT NULL sin DEFAULT en tabla grande → full table rewrite (lock prolongado)
ALTER TABLE users ADD COLUMN verified BOOLEAN NOT NULL;

-- ❌ Cambiar tipo de columna → full table rewrite
ALTER TABLE orders ALTER COLUMN amount TYPE NUMERIC(12,4);

-- ❌ DROP COLUMN — irreversible, datos perdidos
ALTER TABLE users DROP COLUMN legacy_field;

-- ❌ Añadir índice sin CONCURRENTLY (PostgreSQL) → ACCESS EXCLUSIVE lock
CREATE INDEX idx_users_email ON users(email);
```

### BAJO RIESGO — seguros en producción
```sql
-- ✅ Añadir columna nullable
ALTER TABLE users ADD COLUMN avatar_url TEXT;

-- ✅ Añadir índice con CONCURRENTLY (PostgreSQL) — sin lock
CREATE INDEX CONCURRENTLY idx_users_email ON users(email);

-- ✅ Añadir tabla nueva
CREATE TABLE user_preferences (...);

-- ✅ Ampliar VARCHAR (no reducir)
ALTER TABLE users ALTER COLUMN name TYPE VARCHAR(500);
```

## PATRÓN EXPAND-CONTRACT (zero-downtime)

Para renombrar columna, cambiar tipo, o eliminar columna en producción:

### Fase 1 — EXPAND (migración segura)
```sql
-- Añadir columna nueva con nombre correcto
ALTER TABLE users ADD COLUMN full_name TEXT;

-- Copiar datos (puede ser background job en tablas grandes)
UPDATE users SET full_name = name WHERE full_name IS NULL;

-- Añadir trigger para mantener sync mientras coexisten
CREATE OR REPLACE FUNCTION sync_name() RETURNS trigger AS $$
BEGIN
  NEW.full_name := NEW.name;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER sync_name_trigger BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION sync_name();
```

### Fase 2 — DEPLOY APP (leer de columna nueva)
```
Deploy versión de la app que lee `full_name` (y escribe en ambas)
Verificar que no hay reads de `name` en producción
```

### Fase 3 — CONTRACT (limpiar)
```sql
-- Solo cuando CERO instancias de la app leen `name`
DROP TRIGGER sync_name_trigger ON users;
DROP FUNCTION sync_name();
ALTER TABLE users DROP COLUMN name;
```

## BACKFILL EN TABLAS GRANDES

```sql
-- ❌ MAL: UPDATE que lockea toda la tabla
UPDATE orders SET status = 'pending' WHERE status IS NULL;

-- ✅ BIEN: backfill en batches
DO $$
DECLARE
  batch_size INT := 1000;
  last_id BIGINT := 0;
BEGIN
  LOOP
    UPDATE orders
    SET status = 'pending'
    WHERE id IN (
      SELECT id FROM orders
      WHERE status IS NULL AND id > last_id
      ORDER BY id LIMIT batch_size
    )
    RETURNING MAX(id) INTO last_id;

    EXIT WHEN NOT FOUND;
    PERFORM pg_sleep(0.1);  -- throttle
  END LOOP;
END $$;
```

## PRISMA — COMANDOS Y PELIGROS

```bash
# Desarrollo
npx prisma migrate dev              # crea migration + aplica + genera client
npx prisma migrate dev --name add_user_avatar

# Producción — NUNCA usar migrate dev en prod
npx prisma migrate deploy           # solo aplica migrations pendientes, sin crear

# ⚠️ PELIGRO: db push en producción puede destruir datos
npx prisma db push                  # solo para prototipos — NO en prod con datos

# Shadow database (usada por migrate dev internamente)
# Si el error es "Shadow DB failed" → verificar DATABASE_URL vs SHADOW_DATABASE_URL

# Inspeccionar estado actual
npx prisma migrate status           # migrations pendientes vs aplicadas
npx prisma db pull                  # inferir schema desde DB existente
```

### Prisma: migraciones peligrosas que Prisma detecta
```
⚠ We need to reset the PostgreSQL database "mydb" at "localhost:5432"
```
Esto significa que Prisma quiere hacer `DROP DATABASE` + recrear. **Nunca aceptar en producción.** Si aparece:
1. Hacer backup inmediato
2. Revisar qué cambio en `schema.prisma` lo causó
3. Escribir la migration manualmente en lugar de usar `migrate dev`

## ALEMBIC — COMANDOS Y ESTRATEGIAS

```bash
# Generar migration automática (revisar SIEMPRE antes de aplicar)
alembic revision --autogenerate -m "add user avatar"

# Aplicar migrations
alembic upgrade head        # aplicar todas las pendientes
alembic upgrade +1          # aplicar solo la siguiente

# Rollback
alembic downgrade -1        # revertir la última
alembic downgrade base      # revertir TODO (destructivo)

# Ver estado
alembic current             # migration actual en la DB
alembic history             # historial completo
alembic show <revision>     # ver SQL de una migration específica

# Verificar el SQL que se ejecutará (sin aplicar)
alembic upgrade head --sql  # muestra SQL, no ejecuta
```

### Alembic: operaciones peligrosas que autogenerate omite
```python
# autogenerate NO detecta:
# - Renames de columnas (ve un drop + add)
# - Cambios en datos (no hay DDL para esto)
# - Índices condicionales / parciales en algunos dialectos

# Siempre revisar el archivo generado antes de aplicar:
# alembic/versions/xxx_add_user_avatar.py → ver upgrade() y downgrade()
```

## CHECKLIST PRE-DEPLOY

```
✅ La migration tiene un downgrade() implementado (o documentado como forward-only)
✅ Operaciones DDL peligrosas usan técnica zero-downtime (expand-contract o CONCURRENTLY)
✅ Backfills en tablas >100k rows usan batches
✅ La migration fue probada en una copia de la DB de producción (mismo volumen)
✅ El equipo puede revertir sin la migration (app compatible con schema viejo)
✅ Existe backup verificado antes del deploy
❌ NOT NULL sin DEFAULT en tabla con datos
❌ DROP TABLE / DROP COLUMN sin verificar que la app no la usa
❌ migrate dev / db push ejecutado en producción
```

## MATRIZ DE ROLLBACK

| Operación | Reversible | Estrategia |
|---|---|---|
| ADD COLUMN nullable | ✅ | DROP COLUMN |
| ADD COLUMN NOT NULL + DEFAULT | ✅ | DROP COLUMN |
| ADD INDEX CONCURRENTLY | ✅ | DROP INDEX CONCURRENTLY |
| CREATE TABLE | ✅ | DROP TABLE |
| DROP COLUMN | ❌ | Restaurar desde backup |
| DROP TABLE | ❌ | Restaurar desde backup |
| UPDATE masivo sin backup | ❌ | Solo backup previo |
| Cambio de tipo destructivo | ❌ | Restaurar desde backup |
