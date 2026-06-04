---
name: supabase
description: Comprehensive Supabase development covering Auth, RLS, Storage, Realtime, Edge Functions, and CLI/MCP tooling. Activate when working with Supabase projects, writing RLS policies, configuring auth, running migrations, or troubleshooting Supabase-specific issues.
kind: skill
tier: L1
category: database
last_verified: 2026-05-03
tags: [supabase]
token_est: 840
layer: L1-skills
---

# Supabase Skill

Comprehensive Supabase development skill covering all Supabase products and integrations.

## Core Principles

1. **Verify against current docs** — Supabase features change frequently; check changelog for breaking changes before implementing.
2. **Test your work** — A fix without verification is incomplete. Always run test queries to confirm changes work.
3. **Recover strategically** — After 2-3 failed attempts, reconsider approach rather than retrying the same method.
4. **Data API table access** — Newly created tables may not auto-expose via REST API; explicitly grant access to `anon` and `authenticated` roles when needed.
5. **Row-Level Security (RLS)** — Enable RLS on tables in exposed schemas and create policies matching your actual access model.

## Security Checklist

Critical security traps to avoid:
- NEVER use user-editable `raw_user_meta_data` for authorization decisions
- NEVER expose `service_role` keys in public clients
- Views bypass RLS by default — use `security_invoker = true` in Postgres 15+
- UPDATE operations require SELECT policies to work
- Storage upserts need INSERT + SELECT + UPDATE permissions
- Always use `auth.uid()` not `auth.jwt() ->> 'sub'` for user ID in policies

## RLS Pattern

```sql
-- Enable RLS
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;

-- Users can only see their own posts
CREATE POLICY "own_posts_select" ON public.posts
  FOR SELECT USING (auth.uid() = user_id);

-- Users can insert their own posts
CREATE POLICY "own_posts_insert" ON public.posts
  FOR INSERT WITH CHECK (auth.uid() = user_id);
```

## CLI & MCP Workflow

```bash
# Prefer --help over guessing commands
supabase db --help

# Schema iteration workflow
supabase db query "ALTER TABLE ..."    # iterate freely
supabase db pull                        # generate clean migration when ready
supabase migration new <name>           # create named migration
supabase db push                        # apply to remote
```

## MCP Server Setup

```json
{
  "mcpServers": {
    "supabase": {
      "command": "npx",
      "args": ["-y", "@supabase/mcp-server-supabase@latest", "--project-ref", "<ref>"],
      "env": { "SUPABASE_ACCESS_TOKEN": "<token>" }
    }
  }
}
```

## Auth Patterns

```typescript
// Server-side auth (Next.js App Router)
import { createServerClient } from '@supabase/ssr'

// Always use SSR client on server, never anon client
const supabase = createServerClient(url, anonKey, { cookies })

// Check auth
const { data: { user } } = await supabase.auth.getUser()
if (!user) redirect('/login')
```

## Edge Functions

```typescript
// Deno-based edge function
import { createClient } from 'jsr:@supabase/supabase-js@2'

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )
  // ... handle request
})
```

## Source

Based on [supabase/agent-skills](https://github.com/supabase/agent-skills) — Official Supabase agent skill (MIT).
