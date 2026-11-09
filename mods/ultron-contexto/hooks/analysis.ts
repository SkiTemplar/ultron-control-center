import type { SessionMessage, SessionUsage, ToolUseSummary } from 'claude-code'

import type { CtxConversation, CtxItem, CtxSnapshot } from '../types'

const TOP = 8
const DESCRIBE_KEYS = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'skill', 'description', 'prompt']

const byTokens = (a: CtxItem, b: CtxItem) => b.tokens - a.tokens

export const firstLine = (text: string, max = 80): string => {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? ''
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

export function shortPath(path: string, home: string): string {
  const clean = path.replace(/\\/g, '/')
  const base = home.replace(/\\/g, '/')
  return base !== '' && clean.toLowerCase().startsWith(base.toLowerCase())
    ? `~${clean.slice(base.length)}`
    : clean
}

type ServerTotals = { tokens: number; tools: number; loaded: number }

export function toSnapshot(
  usage: SessionUsage,
  detail: 'summary' | 'full',
  takenAt: number,
  home: string,
): CtxSnapshot | null {
  const breakdown = usage.context.breakdown
  if (!breakdown) return null

  const servers = new Map<string, ServerTotals>()
  for (const tool of breakdown.mcpTools) {
    const prev = servers.get(tool.serverName) ?? { tokens: 0, tools: 0, loaded: 0 }
    servers.set(tool.serverName, {
      tokens: prev.tokens + (tool.isLoaded ? tool.tokens : 0),
      tools: prev.tools + 1,
      loaded: prev.loaded + (tool.isLoaded ? 1 : 0),
    })
  }

  const agentItems = breakdown.agents
    .map((a) => ({ label: a.agentType, detail: a.source, tokens: a.tokens, count: 1 }))
    .sort(byTokens)

  return {
    takenAt,
    detail,
    model: breakdown.model,
    totalTokens: breakdown.totalTokens,
    maxTokens: breakdown.rawMaxTokens,
    percentage: breakdown.percentage,
    autoCompactThreshold: breakdown.isAutoCompactEnabled ? (breakdown.autoCompactThreshold ?? null) : null,
    categories: breakdown.categories.map((c) => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind })),
    memory: breakdown.memoryFiles
      .map((f) => ({ label: shortPath(f.path, home), detail: f.type, tokens: f.tokens, count: 1 }))
      .sort(byTokens)
      .slice(0, TOP),
    mcpServers: [...servers.entries()]
      .map(([name, t]) => ({ label: name, detail: `${t.loaded}/${t.tools} cargadas`, tokens: t.tokens, count: t.tools }))
      .sort(byTokens),
    skills: breakdown.skills
      ? {
          total: breakdown.skills.totalSkills,
          included: breakdown.skills.includedSkills,
          tokens: breakdown.skills.tokens,
          top: breakdown.skills.skillFrontmatter
            .map((s) => ({ label: s.name, detail: s.pluginName ?? s.source, tokens: s.tokens, count: 1 }))
            .sort(byTokens)
            .slice(0, TOP),
        }
      : null,
    agents: { tokens: agentItems.reduce((sum, a) => sum + a.tokens, 0), top: agentItems.slice(0, TOP) },
    slashCommands: breakdown.slashCommands
      ? {
          total: breakdown.slashCommands.totalCommands,
          included: breakdown.slashCommands.includedCommands,
          tokens: breakdown.slashCommands.tokens,
        }
      : null,
    costUsd: usage.cost?.usd ?? null,
    rateLimits: usage.rateLimits.map((r) => ({
      kind: r.kind,
      percentUsed: r.percentUsed,
      resetsAt: r.resetsAt ?? null,
    })),
  }
}

/** Tokens de la categoría de mensajes: la que reparte el análisis de la conversación. */
export function messageTokensOf(snapshot: CtxSnapshot): number {
  const row = snapshot.categories.find((c) => /message|mensaje/i.test(c.name))
  return row?.tokens ?? 0
}

type Piece = { kind: string; label: string; detail: string; chars: number; rereadKey: string | null }

function describe(input: Record<string, unknown>): string {
  for (const key of DESCRIBE_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') return firstLine(value, 70)
  }
  return ''
}

function kindOf(tool: string): string {
  if (!tool.startsWith('mcp__')) return tool
  const server = tool.split('__')[1] ?? 'mcp'
  return `MCP ${server}`
}

function toolPiece(use: ToolUseSummary): Piece {
  const resultChars = use.text?.length ?? 0
  const filePath = use.tool === 'Read' && typeof use.input.file_path === 'string' ? use.input.file_path : null
  return {
    kind: kindOf(use.tool),
    label: use.tool,
    detail: describe(use.input),
    chars: JSON.stringify(use.input).length + resultChars,
    rereadKey: filePath ? filePath.replace(/\\/g, '/').toLowerCase() : null,
  }
}

function piecesOf(messages: readonly SessionMessage[]): Piece[] {
  const pieces: Piece[] = []
  for (const message of messages) {
    if (message.text !== '') {
      pieces.push({
        kind: message.role === 'user' ? 'Tus mensajes y avisos' : 'Texto de Claude',
        label: message.role === 'user' ? 'Tú' : 'Claude',
        detail: firstLine(message.text, 70),
        chars: message.text.length,
        rereadKey: null,
      })
    }
    for (const use of message.toolUses) pieces.push(toolPiece(use))
  }
  return pieces
}

function groupBy(pieces: readonly Piece[], keyOf: (p: Piece) => string | null, scale: number): CtxItem[] {
  const groups = new Map<string, { chars: number; count: number; detail: string }>()
  for (const piece of pieces) {
    const key = keyOf(piece)
    if (key === null) continue
    const prev = groups.get(key) ?? { chars: 0, count: 0, detail: piece.detail }
    groups.set(key, { chars: prev.chars + piece.chars, count: prev.count + 1, detail: prev.detail })
  }
  return [...groups.entries()]
    .map(([label, g]) => ({ label, detail: g.detail, tokens: Math.round(g.chars * scale), count: g.count }))
    .sort(byTokens)
}

/**
 * Reparte los tokens de la categoría de mensajes según el peso en caracteres de
 * cada pieza. Es una estimación: el desglose del motor solo da el total.
 */
export function toConversation(messages: readonly SessionMessage[], messageTokens: number): CtxConversation {
  const pieces = piecesOf(messages)
  const totalChars = pieces.reduce((sum, p) => sum + p.chars, 0)
  const scale = totalChars > 0 && messageTokens > 0 ? messageTokens / totalChars : 0.25

  const heaviest = [...pieces]
    .sort((a, b) => b.chars - a.chars)
    .slice(0, TOP)
    .map((p) => ({ label: p.label, detail: p.detail, tokens: Math.round(p.chars * scale), count: 1 }))

  const rereads = groupBy(pieces, (p) => p.rereadKey, scale)
    .filter((item) => item.count > 1)
    .slice(0, TOP)

  return {
    messageTokens,
    byKind: groupBy(pieces, (p) => p.kind, scale).slice(0, TOP + 2),
    heaviest,
    rereads,
  }
}
