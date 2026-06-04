---
name: react-specialist
description: React 18+ specialist covering advanced patterns, performance optimization, state management, and production architectures. Activate when building React applications, optimizing component performance, implementing state management, or working with concurrent React features.
kind: skill
tier: L1
category: web
last_verified: 2026-05-03
tags: [react, specialist]
token_est: 1212
layer: L1-skills
---

# React Specialist Skill

Senior React specialist for advanced React 18+ applications with emphasis on performance and scalability.

## Core Focus

Advanced patterns, performance optimization, state management, and production architectures.

## React 18+ Patterns

```tsx
// Concurrent features
import { Suspense, lazy, useTransition, useDeferredValue } from 'react'

const HeavyComponent = lazy(() => import('./HeavyComponent'))

function App() {
  const [isPending, startTransition] = useTransition()
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)  // Non-urgent update

  return (
    <Suspense fallback={<Skeleton />}>
      <HeavyComponent query={deferredQuery} />
      {isPending && <Spinner />}
    </Suspense>
  )
}

// Transition for non-urgent UI updates
function SearchBar() {
  const [isPending, startTransition] = useTransition()
  const handleChange = (e) => {
    startTransition(() => setSearchResults(search(e.target.value)))
  }
}
```

## State Management

```typescript
// Zustand (simple, performant)
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

interface CartStore {
  items: CartItem[]
  addItem: (item: CartItem) => void
  removeItem: (id: string) => void
}

const useCartStore = create<CartStore>()(
  immer((set) => ({
    items: [],
    addItem: (item) => set((state) => { state.items.push(item) }),
    removeItem: (id) => set((state) => {
      state.items = state.items.filter(i => i.id !== id)
    }),
  }))
)

// Jotai (atomic, minimal)
import { atom, useAtom } from 'jotai'
const userAtom = atom<User | null>(null)
const isLoggedInAtom = atom((get) => get(userAtom) !== null)
```

## Advanced Patterns

```tsx
// Compound components
const Select = ({ children, value, onChange }: SelectProps) => {
  const ctx = useMemo(() => ({ value, onChange }), [value, onChange])
  return <SelectContext.Provider value={ctx}>{children}</SelectContext.Provider>
}
Select.Option = function Option({ value, children }: OptionProps) {
  const { value: selected, onChange } = useSelectContext()
  return (
    <li
      role="option"
      aria-selected={value === selected}
      onClick={() => onChange(value)}
    >
      {children}
    </li>
  )
}

// Render props for logic sharing
function MouseTracker({ render }: { render: (pos: Position) => ReactNode }) {
  const [position, setPosition] = useState({ x: 0, y: 0 })
  return <div onMouseMove={(e) => setPosition({ x: e.clientX, y: e.clientY })}>
    {render(position)}
  </div>
}
```

## Performance Optimization

```tsx
// React.memo with custom comparison
const ExpensiveList = React.memo(
  ({ items }: { items: Item[] }) => <ul>{items.map(renderItem)}</ul>,
  (prev, next) => prev.items === next.items  // Reference equality
)

// Virtual scrolling
import { useVirtualizer } from '@tanstack/react-virtual'
function VirtualList({ items }: { items: Item[] }) {
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 50,
  })

  return (
    <div ref={parentRef} style={{ height: '400px', overflow: 'auto' }}>
      <div style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map(item => (
          <div key={item.key} style={{ transform: `translateY(${item.start}px)` }}>
            <Row data={items[item.index]} />
          </div>
        ))}
      </div>
    </div>
  )
}
```

## Testing

```typescript
// React Testing Library — test behavior, not implementation
import { render, screen, userEvent } from '@testing-library/react'

test('submits form with valid data', async () => {
  const user = userEvent.setup()
  const onSubmit = jest.fn()
  render(<LoginForm onSubmit={onSubmit} />)

  await user.type(screen.getByLabelText(/email/i), 'test@example.com')
  await user.type(screen.getByLabelText(/password/i), 'password123')
  await user.click(screen.getByRole('button', { name: /sign in/i }))

  expect(onSubmit).toHaveBeenCalledWith({ email: 'test@example.com', password: 'password123' })
})
```

## Quality Standards

- TypeScript strict mode
- Performance scores > 95 (Lighthouse)
- Test coverage > 90%
- Component reusability > 80%
- Full accessibility compliance (WCAG 2.1 AA)

## Source

Adapted from [VoltAgent/awesome-claude-code-subagents react-specialist](https://github.com/VoltAgent/awesome-claude-code-subagents) (MIT).
