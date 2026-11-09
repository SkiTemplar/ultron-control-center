import type { Elements } from 'claude-code'

import type { CtxCategory, CtxConversation, CtxItem, CtxSnapshot, CtxTab } from '../types'

export type Ui = Elements['terminal'] | Elements['desktop'] | Elements['vscode']

export type Actions = {
  tab: (tab: CtxTab) => void
  refresh: () => void
  exact: () => void
  compact: () => void
}

export type ViewModel = {
  snapshot: CtxSnapshot | null
  conversation: CtxConversation | null
  tab: CtxTab
  isLoading: boolean
  error: string | null
  width: number
}

const MINI_BAR = 10

export function fmtTokens(n: number): string {
  if (n < 1_000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1).replace('.', ',')}k`
  return `${(n / 1_000_000).toFixed(2).replace('.', ',')}M`
}

export const fmtPct = (part: number, whole: number): string =>
  whole > 0 ? `${((part / whole) * 100).toFixed(1).replace('.', ',')} %` : '—'

const padEnd = (text: string, width: number): string =>
  text.length >= width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width)

const padStart = (text: string, width: number): string => text.padStart(width)

type Segment = { color: string; text: string }

/** Barra apilada de la ventana: una celda por fracción, cada categoría con su color. */
export function segments(categories: readonly CtxCategory[], width: number): Segment[] {
  const shown = categories.filter((c) => c.kind !== 'deferred' && c.tokens > 0)
  const total = shown.reduce((sum, c) => sum + c.tokens, 0)
  if (total === 0 || width <= 0) return []
  const cells = shown.map((c) => Math.max(c.kind === 'used' ? 1 : 0, Math.round((c.tokens / total) * width)))
  let overflow = cells.reduce((sum, n) => sum + n, 0) - width
  for (let i = cells.length - 1; overflow !== 0 && i >= 0; i--) {
    const adjust = overflow > 0 ? Math.min(overflow, Math.max(0, (cells[i] ?? 0) - 1)) : overflow
    cells[i] = (cells[i] ?? 0) - adjust
    overflow -= adjust
  }
  return shown.map((c, i) => ({
    color: c.color,
    text: (c.kind === 'free' ? '░' : c.kind === 'buffer' ? '▒' : '█').repeat(Math.max(0, cells[i] ?? 0)),
  }))
}

const miniBar = (part: number, whole: number): string => {
  const filled = whole > 0 ? Math.round((part / whole) * MINI_BAR) : 0
  return '▰'.repeat(Math.min(MINI_BAR, filled)) + '▱'.repeat(Math.max(0, MINI_BAR - filled))
}

function tabs(ui: Ui, vm: ViewModel, act: Actions) {
  const { Box, Button, Text } = ui
  const entries: Array<[CtxTab, string, string]> = [
    ['resumen', 'resumen', '1'],
    ['carga', 'carga fija', '2'],
    ['conversacion', 'conversación', '3'],
  ]
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      {entries.map(([id, label, hotkey]) => (
        <Button
          key={`tab-${id}`}
          label={label}
          hotkey={hotkey}
          variant={vm.tab === id ? 'primary' : 'secondary'}
          onPress={() => act.tab(id)}
        />
      ))}
      <Text dimColor>│</Text>
      <Button key="refrescar" label="refrescar" hotkey="r" onPress={act.refresh} />
      <Button key="exacto" label="conteo exacto" hotkey="e" onPress={act.exact} />
      <Button key="compactar" label="/compact" hotkey="c" onPress={act.compact} />
      {vm.isLoading && <Text color="warning">midiendo…</Text>}
    </Box>
  )
}

function itemRows(ui: Ui, items: readonly CtxItem[], whole: number, width: number, showCount: boolean) {
  const { Box, Text } = ui
  const nameWidth = Math.max(12, width - 30)
  return (
    <Box flexDirection="column">
      {items.map((item) => (
        <Box flexDirection="row">
          <Text>{padEnd(item.label, Math.min(nameWidth, 28))}</Text>
          <Text bold>{padStart(fmtTokens(item.tokens), 8)}</Text>
          <Text dimColor>{padStart(fmtPct(item.tokens, whole), 8)} </Text>
          <Text dimColor wrap="truncate-end">
            {[showCount && item.count > 1 ? `×${item.count}` : '', item.detail].filter(Boolean).join(' ')}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

function section(ui: Ui, title: string, total: string | null) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="row" columnGap={1} marginTop={1}>
      <Text bold color="claude">{title}</Text>
      {total !== null && <Text dimColor>{total}</Text>}
    </Box>
  )
}

function summary(ui: Ui, snap: CtxSnapshot, width: number) {
  const { Box, Text } = ui
  const left = snap.autoCompactThreshold !== null ? snap.autoCompactThreshold - snap.totalTokens : null
  const limits = snap.rateLimits
    .map((r) => `${r.kind.replace('_', ' ')} ${Math.round(r.percentUsed)} %`)
    .join(' · ')
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {segments(snap.categories, width).map((s) => (
          <Text color={s.color}>{s.text}</Text>
        ))}
      </Box>
      <Text dimColor wrap="truncate-end">
        {[
          left !== null ? `autocompact a ${fmtTokens(snap.autoCompactThreshold ?? 0)} (faltan ${fmtTokens(Math.max(0, left))})` : 'autocompact apagado',
          limits,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      {section(ui, 'Categorías', null)}
      {snap.categories
        .filter((c) => c.tokens > 0)
        .map((c) => (
          <Box flexDirection="row">
            <Text color={c.color}>{c.kind === 'free' ? '░ ' : c.kind === 'buffer' ? '▒ ' : '█ '}</Text>
            <Text dimColor={c.kind !== 'used'}>{padEnd(c.name, Math.max(12, Math.min(26, width - 34)))}</Text>
            <Text bold={c.kind === 'used'}>{padStart(fmtTokens(c.tokens), 8)}</Text>
            <Text dimColor>{padStart(fmtPct(c.tokens, snap.maxTokens), 8)} </Text>
            <Text color={c.color}>{c.kind === 'used' ? miniBar(c.tokens, snap.maxTokens) : ''}</Text>
            {c.kind === 'deferred' && <Text dimColor> (bajo demanda, no cuenta)</Text>}
          </Box>
        ))}
    </Box>
  )
}

function fixedLoad(ui: Ui, snap: CtxSnapshot, width: number) {
  const { Box, Text } = ui
  const memoryTotal = snap.memory.reduce((sum, m) => sum + m.tokens, 0)
  const mcpTotal = snap.mcpServers.reduce((sum, m) => sum + m.tokens, 0)
  const whole = snap.maxTokens
  return (
    <Box flexDirection="column">
      <Text dimColor wrap="wrap">
        Lo que se paga antes de escribir nada: memoria, herramientas MCP, skills, agentes y comandos.
      </Text>
      {section(ui, 'Memoria (CLAUDE.md y reglas)', fmtTokens(memoryTotal))}
      {itemRows(ui, snap.memory, whole, width, false)}
      {section(ui, 'MCP por servidor', fmtTokens(mcpTotal))}
      {itemRows(ui, snap.mcpServers.slice(0, 8), whole, width, false)}
      {snap.skills &&
        section(ui, 'Skills', `${fmtTokens(snap.skills.tokens)} · ${snap.skills.included} de ${snap.skills.total} listadas`)}
      {snap.skills && itemRows(ui, snap.skills.top, whole, width, false)}
      {section(ui, 'Agentes', `${fmtTokens(snap.agents.tokens)}`)}
      {itemRows(ui, snap.agents.top, whole, width, false)}
      {snap.slashCommands && (
        <Text dimColor>
          Comandos: {fmtTokens(snap.slashCommands.tokens)} · {snap.slashCommands.included} de {snap.slashCommands.total}
        </Text>
      )}
    </Box>
  )
}

function conversationView(ui: Ui, conv: CtxConversation, snap: CtxSnapshot, width: number) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column">
      <Text dimColor wrap="wrap">
        Reparto estimado de los {fmtTokens(conv.messageTokens)} de mensajes según el tamaño de cada pieza.
      </Text>
      {section(ui, 'Por tipo', null)}
      {itemRows(ui, conv.byKind, snap.maxTokens, width, true)}
      {section(ui, 'Lo más gordo', null)}
      {itemRows(ui, conv.heaviest, snap.maxTokens, width, false)}
      {conv.rereads.length > 0 && section(ui, 'Ficheros leídos varias veces', null)}
      {conv.rereads.length > 0 && itemRows(ui, conv.rereads, snap.maxTokens, width, true)}
    </Box>
  )
}

export function contextView(ui: Ui, vm: ViewModel, act: Actions) {
  const { Box, Text } = ui
  const snap = vm.snapshot
  const width = Math.max(20, vm.width)
  const head = snap
    ? `${fmtTokens(snap.totalTokens)} / ${fmtTokens(snap.maxTokens)} (${snap.percentage} %)`
    : ''
  const cost = snap?.costUsd != null ? `$${snap.costUsd.toFixed(2)}` : ''

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        <Text bold color="claude">CONTEXTO</Text>
        <Text bold>{head}</Text>
        <Text dimColor>{[snap?.model, cost, snap ? (snap.detail === 'full' ? 'exacto' : 'estimado') : ''].filter(Boolean).join(' · ')}</Text>
      </Box>
      {tabs(ui, vm, act)}
      {vm.error !== null && <Text color="error" wrap="wrap">{vm.error}</Text>}
      {!snap && !vm.isLoading && <Text dimColor>Sin medida todavía: pulsa r.</Text>}
      {snap && vm.tab === 'resumen' && summary(ui, snap, width)}
      {snap && vm.tab === 'carga' && fixedLoad(ui, snap, width)}
      {snap && vm.tab === 'conversacion' && vm.conversation && conversationView(ui, vm.conversation, snap, width)}
    </Box>
  )
}
