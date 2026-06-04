---
name: supabase-postgres
description: PostgreSQL performance optimization guidelines specifically for Supabase projects. Activate when optimizing Supabase database queries, designing schemas for Supabase, implementing RLS-aware indexing, or reviewing PostgreSQL performance in a Supabase context.
kind: skill
tier: L1
category: database
last_verified: 2026-05-03
tags: [supabase, postgres]
token_est: 925
layer: L1-skills
---

# Supabase Postgres Best Practices Skill

Postgres performance optimization guide maintained by Supabase (v1.1.1, MIT licensed).

## Priority-Ordered Rule Categories

### Critical Priority

**Query Performance (`query-*`)**
- Always EXPLAIN ANALYZE before optimizing
- Index foreign keys and frequently filtered columns
- Use partial indexes for common filter patterns
- Avoid `SELECT *` — select only needed columns
- Use covering indexes to avoid table heap access

**Connection Management (`conn-*`)**
- Use connection pooling (Supabase provides PgBouncer via Transaction mode)
- Set `pool_mode = transaction` for most web apps
- Monitor with `pg_stat_activity`
- Set `statement_timeout` per role to prevent runaway queries

**Security & RLS (`security-*`)**
- Always enable RLS on public schema tables
- Use `auth.uid()` (not JWT claims) for user identification in policies
- Views bypass RLS by default — add `security_invoker = true`
- Separate policies for SELECT, INSERT, UPDATE, DELETE
- Never rely on `raw_user_meta_data` for authorization

### High Priority

**Schema Design**
```sql
-- Use appropriate types (smaller = faster)
-- UUID vs BIGSERIAL: prefer BIGSERIAL for high-insert tables
-- TIMESTAMPTZ (not TIMESTAMP) for timezone awareness
-- JSONB (not JSON) for queryable JSON
-- TEXT (not VARCHAR) — no performance difference in Postgres

-- Always add created_at/updated_at
created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
```

**Concurrency & Locking**
```sql
-- Avoid long-running transactions
-- Use SELECT ... FOR UPDATE SKIP LOCKED for queue patterns
-- Advisory locks for application-level locking
SELECT pg_advisory_lock(12345);
-- ... do work ...
SELECT pg_advisory_unlock(12345);
```

### Medium Priority

**Data Access Patterns**
```sql
-- Pagination: keyset > OFFSET for large datasets
-- Bad (slow with large offset):
SELECT * FROM posts ORDER BY created_at DESC LIMIT 20 OFFSET 10000;

-- Good (keyset pagination):
SELECT * FROM posts
WHERE created_at < $1  -- last item's created_at
ORDER BY created_at DESC
LIMIT 20;
```

**Monitoring & Diagnostics**
```sql
-- Find slow queries (requires pg_stat_statements)
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;

-- Find missing indexes (sequential scans on filtered queries)
SELECT schemaname, tablename, attname, n_distinct, correlation
FROM pg_stats
WHERE tablename = 'your_table';

-- Table/index bloat
SELECT tablename, pg_size_pretty(pg_total_relation_size(tablename::regclass))
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(tablename::regclass) DESC;
```

## Supabase-Specific Patterns

```sql
-- Expose new table via REST API
GRANT SELECT ON new_table TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON new_table TO authenticated;

-- Full-text search with Supabase
ALTER TABLE articles ADD COLUMN fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body)) STORED;
CREATE INDEX idx_articles_fts ON articles USING GIN (fts);

-- Query:
SELECT * FROM articles WHERE fts @@ plainto_tsquery('english', $1);
```

## Source

Based on [supabase/agent-skills supabase-postgres-best-practices](https://github.com/supabase/agent-skills) (MIT) — Official Supabase Postgres optimization guide.
