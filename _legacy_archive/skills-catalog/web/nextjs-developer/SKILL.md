---
name: nextjs-developer
description: Next.js 14+ full-stack development with App Router, Server Components, Server Actions, and performance optimization. Activate when building Next.js applications, working with App Router patterns, implementing caching strategies, optimizing Core Web Vitals, or deploying to Vercel.
kind: skill
tier: L1
category: web
last_verified: 2026-05-03
tags: [nextjs, developer]
token_est: 1126
layer: L1-skills
---

# Next.js Developer Skill

Senior Next.js developer specialized in Next.js 14+ applications with App Router architecture.

## Core Focus

Full-stack development with App Router, server components, and advanced performance optimization.

## Architecture Patterns

```typescript
// App Router structure
app/
├── layout.tsx          // Root layout (server component)
├── page.tsx            // Home page
├── loading.tsx         // Suspense boundary
├── error.tsx           // Error boundary
├── not-found.tsx       // 404 page
├── (marketing)/        // Route group (no URL segment)
│   ├── about/page.tsx
│   └── pricing/page.tsx
└── dashboard/
    ├── layout.tsx      // Nested layout
    └── @modal/         // Parallel route (modal)
        └── page.tsx
```

## Server vs Client Components

```typescript
// Server Component (default) — runs on server, no JS bundle
// app/users/page.tsx
async function UsersPage() {
  const users = await db.query('SELECT * FROM users')  // Direct DB access
  return <UserList users={users} />
}

// Client Component — interactive, needs 'use client'
'use client'
import { useState } from 'react'
export function Counter() {
  const [count, setCount] = useState(0)
  return <button onClick={() => setCount(c => c + 1)}>{count}</button>
}
```

## Server Actions

```typescript
// app/actions.ts
'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

export async function createPost(formData: FormData) {
  const title = formData.get('title') as string
  await db.post.create({ data: { title, userId: await getAuthUser() } })
  revalidatePath('/posts')
  redirect('/posts')
}

// In component
<form action={createPost}>
  <input name="title" />
  <button type="submit">Create</button>
</form>
```

## Caching Strategies

```typescript
// Static (default) — cached indefinitely
const data = await fetch('https://api.example.com/data')

// Dynamic — no cache
const data = await fetch('https://api.example.com/data', {
  cache: 'no-store'
})

// Revalidate periodically
const data = await fetch('https://api.example.com/data', {
  next: { revalidate: 3600 }  // 1 hour
})

// Tag-based revalidation
const data = await fetch('...', { next: { tags: ['posts'] } })
// Later: revalidateTag('posts')
```

## Metadata API (SEO)

```typescript
// Static metadata
export const metadata: Metadata = {
  title: 'My App',
  description: 'Description',
  openGraph: {
    title: 'My App',
    images: ['/og-image.png'],
  },
}

// Dynamic metadata
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const post = await getPost(params.slug)
  return {
    title: post.title,
    description: post.excerpt,
  }
}
```

## Performance Optimization

```typescript
// Image optimization
import Image from 'next/image'
<Image
  src="/hero.jpg"
  alt="Hero"
  width={1200}
  height={600}
  priority  // LCP image
  placeholder="blur"
  blurDataURL={blurDataUrl}
/>

// Dynamic imports with loading state
const HeavyComponent = dynamic(() => import('./HeavyComponent'), {
  loading: () => <Skeleton />,
  ssr: false,  // Skip SSR if not needed
})

// Font optimization
import { Inter } from 'next/font/google'
const inter = Inter({ subsets: ['latin'], display: 'swap' })
```

## Middleware

```typescript
// middleware.ts (at project root)
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  const token = request.cookies.get('token')
  if (!token && request.nextUrl.pathname.startsWith('/dashboard')) {
    return NextResponse.redirect(new URL('/login', request.url))
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/dashboard/:path*', '/api/:path*'],
}
```

## Quality Standards

- TypeScript strict mode (`"strict": true`)
- Core Web Vitals > 90 (LCP, CLS, INP)
- SEO score > 95 (Lighthouse)
- Unit + E2E + performance tests
- Error boundaries at route segments

## Source

Adapted from [VoltAgent/awesome-claude-code-subagents nextjs-developer](https://github.com/VoltAgent/awesome-claude-code-subagents) (MIT).
