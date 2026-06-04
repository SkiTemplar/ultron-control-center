---
name: postgres-pro
description: PostgreSQL expert covering query optimization, indexing, replication, partitioning, and advanced features. Activate when optimizing slow queries, designing database schemas, configuring replication, implementing partitioning, or tuning PostgreSQL performance.
kind: skill
tier: L1
category: database
last_verified: 2026-05-03
tags: [postgres, pro]
token_est: 1129
layer: L1-skills
---

# PostgreSQL Pro Skill

Enterprise PostgreSQL expertise covering query optimization, configuration tuning, replication, and advanced features.

## Excellence Targets

- Query performance < 50ms (p99)
- Replication lag < 500ms
- Backup RPO < 5 minutes
- Recovery RTO < 1 hour
- Uptime > 99.95%

## Query Optimization

```sql
-- Always EXPLAIN ANALYZE before optimizing
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM orders WHERE user_id = $1 AND status = 'pending';

-- Check for sequential scans on large tables
-- Look for: "Seq Scan" on tables > 10K rows with filters

-- Index for common query patterns
CREATE INDEX CONCURRENTLY idx_orders_user_status
  ON orders(user_id, status)
  WHERE status = 'pending';  -- Partial index for common filter

-- Covering index (includes all SELECT columns)
CREATE INDEX CONCURRENTLY idx_orders_covering
  ON orders(user_id, created_at DESC)
  INCLUDE (total, status);
```

## Index Strategies

```sql
-- GIN for JSONB/array/full-text
CREATE INDEX idx_metadata ON products USING GIN (metadata);
CREATE INDEX idx_search ON articles USING GIN (to_tsvector('english', content));

-- BRIN for time-series (very small, good for append-only)
CREATE INDEX idx_logs_time ON logs USING BRIN (created_at);

-- Trigram for LIKE/ILIKE queries
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_name_trgm ON users USING GIN (name gin_trgm_ops);

-- Never over-index — each index slows writes
-- Review with: SELECT * FROM pg_stat_user_indexes WHERE idx_scan = 0;
```

## Connection Management

```sql
-- PgBouncer config (transaction pooling)
-- pool_mode = transaction
-- max_client_conn = 1000
-- default_pool_size = 20

-- Monitor connections
SELECT count(*), state, wait_event_type, wait_event
FROM pg_stat_activity
GROUP BY state, wait_event_type, wait_event;

-- Set statement timeout to prevent runaway queries
SET statement_timeout = '30s';
-- Or per-role: ALTER ROLE app_user SET statement_timeout = '30s';
```

## Partitioning

```sql
-- Range partitioning for time-series
CREATE TABLE metrics (
    id          BIGSERIAL,
    recorded_at TIMESTAMPTZ NOT NULL,
    value       DOUBLE PRECISION
) PARTITION BY RANGE (recorded_at);

CREATE TABLE metrics_2026_01 PARTITION OF metrics
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

-- Automatic partition creation (pg_partman extension)
SELECT partman.create_parent('public.metrics', 'recorded_at', 'native', 'monthly');
```

## Replication

```sql
-- Check replication lag
SELECT
    application_name,
    pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn) AS send_lag_bytes,
    pg_wal_lsn_diff(sent_lsn, replay_lsn) AS replay_lag_bytes
FROM pg_stat_replication;

-- Promote standby (emergency failover)
-- pg_ctl promote -D /var/lib/postgresql/data
```

## Memory & Configuration

```ini
# postgresql.conf tuning (for dedicated 16GB server)
shared_buffers = 4GB              # 25% of RAM
effective_cache_size = 12GB       # 75% of RAM
work_mem = 64MB                   # Per sort/hash operation
maintenance_work_mem = 512MB      # For VACUUM, CREATE INDEX
max_connections = 100             # Use PgBouncer for more

# WAL settings for performance
wal_compression = on
checkpoint_completion_target = 0.9
max_wal_size = 4GB
```

## Backup & Recovery

```bash
# Point-in-time recovery (PITR) with WAL archiving
# postgresql.conf:
# archive_mode = on
# archive_command = 'wal-g wal-push %p'

# Base backup
wal-g backup-push $PGDATA

# Restore to specific point in time
wal-g backup-fetch $PGDATA LATEST
# recovery.conf:
# recovery_target_time = '2026-05-01 14:30:00+00'
```

## Useful Extensions

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;   -- Query performance tracking
CREATE EXTENSION IF NOT EXISTS pglogical;             -- Logical replication
CREATE EXTENSION IF NOT EXISTS timescaledb;           -- Time-series optimization
CREATE EXTENSION IF NOT EXISTS pg_trgm;               -- Trigram similarity
CREATE EXTENSION IF NOT EXISTS btree_gin;             -- GIN for btree types
```

## Source

Adapted from [VoltAgent/awesome-claude-code-subagents postgres-pro](https://github.com/VoltAgent/awesome-claude-code-subagents) (MIT).
