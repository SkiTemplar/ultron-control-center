---
name: prisma-expert
description: Prisma ORM expertise covering v6 patterns and v7 breaking changes (ESM-only, driver adapters, prisma.config.ts). Activate when working with Prisma schema, migrations, client instantiation, or upgrading from Prisma v6 to v7.
kind: skill
tier: L1
category: database
last_verified: 2026-05-03
tags: [prisma, expert]
token_est: 879
layer: L1-skills
---

# Prisma Expert Skill

Prisma ORM expertise for modern TypeScript/Node.js applications, covering v6 stable patterns and v7 migration.

## Prisma v7 Breaking Changes

**Environment & Runtime:**
- Node.js 20.19.0+ required (supports 22.x)
- TypeScript 5.4.0+ minimum
- Ships as ES modules — requires `"type": "module"` in package.json

**Schema & Generation:**
- Generator provider: `prisma-client-js` → `prisma-client`
- `output` field is now required in generator config
- Client no longer generated into node_modules by default
- Datasource config moves to `prisma.config.ts`

**Client Instantiation:**
- All databases now require driver adapters (`@prisma/adapter-pg` for PostgreSQL, etc.)
- Keep Accelerate URLs separate from driver adapters

**Automation Changes:**
- CLI no longer auto-loads `.env` files in v7
- Automatic seeding and code generation removed from migration commands
- Must explicitly run `prisma generate` and `prisma db seed`

**Removed Features:**
- Client middleware (`prisma.$use()`) — migrate to Prisma extensions
- Metrics preview feature
- Multiple Prisma-specific environment variables
- MongoDB support not available in v7 (stay on v6)

## v7 Migration Checklist

```bash
# 1. Update packages
npm install prisma@7 @prisma/client@7 @prisma/adapter-pg

# 2. Update schema
# Before: provider = "prisma-client-js"
# After:  provider = "prisma-client"
#         output   = "../generated/prisma"

# 3. Add prisma.config.ts
# 4. Add driver adapter
# 5. Update scripts to explicitly run generate
```

## v7 Client Setup

```typescript
// prisma.config.ts
import path from 'node:path'
import type { PrismaConfig } from 'prisma'

export default {
  earlyAccess: true,
  schema: path.join('prisma', 'schema.prisma'),
} satisfies PrismaConfig

// db.ts (with driver adapter)
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
export const prisma = new PrismaClient({ adapter })
```

## v6 Stable Patterns

```typescript
// Standard v6 setup (still valid for most projects)
import { PrismaClient } from '@prisma/client'
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
})

// Transactions
const [user, post] = await prisma.$transaction([
  prisma.user.create({ data: { email } }),
  prisma.post.create({ data: { title, authorId } }),
])

// Extensions (replaces middleware in v7)
const xprisma = prisma.$extends({
  query: {
    user: {
      async create({ args, query }) {
        args.data.password = await hash(args.data.password)
        return query(args)
      }
    }
  }
})
```

## Schema Best Practices

```prisma
// Always add @@index for foreign keys and filter columns
model Post {
  id        String   @id @default(cuid())
  createdAt DateTime @default(now())
  authorId  String
  author    User     @relation(fields: [authorId], references: [id])

  @@index([authorId])
  @@index([createdAt(sort: Desc)])
}
```

## Source

Adapted from [gocallum/nextjs16-agent-skills prisma-orm-v7-skills](https://github.com/gocallum/nextjs16-agent-skills) (MIT).
