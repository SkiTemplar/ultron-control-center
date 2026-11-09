import type { Elements } from 'claude-code'

import type { AgentRow, WorkflowRun } from '../types'
import { type ActivityMap, activityOf, fmtElapsed, isActive, lastTool, ordered, shortModel, trunc } from './agents'
import { groupByPhase, runSummary } from './workflows'

export type Ui = Elements['terminal'] | Elements['desktop'] | Elements['vscode']

export type Actions = {
  clear: () => void
  select: (id: string) => void
}

export type ViewModel = {
  agents: readonly AgentRow[]
  runs: readonly WorkflowRun[]
  activity: ActivityMap
  notice: string
  now: number
  width: number
}

export const STATUS_MARK: Record<string, { mark: string; color: string; word: string }> = {
  running: { mark: '●', color: 'claude', word: 'en curso' },
  pending: { mark: '○', color: 'warning', word: 'en cola' },
  completed: { mark: '✓', color: 'success', word: 'terminado' },
  failed: { mark: '✗', color: 'error', word: 'fallido' },
  killed: { mark: '■', color: 'inactive', word: 'detenido' },
  stale: { mark: '◌', color: 'warning', word: 'sin señales (¿run abortado?)' },
}

export const markOf = (status: string) => STATUS_MARK[status] ?? { mark: '·', color: 'inactive', word: status }

type RowCtx = { ui: Ui; vm: ViewModel; act: Actions; hotkeys: ReadonlyMap<string, string> }

function agentRow(ctx: RowCtx, row: AgentRow, depth: number) {
  const { Box, Button, Text } = ctx.ui
  const { vm } = ctx
  const mark = markOf(row.status)
  const isLive = isActive(row)
  const elapsed = fmtElapsed((row.endedAt ?? vm.now) - row.startedAt)
  const tools = activityOf(vm.activity, row.id).tools
  const indent = depth > 0 ? `${'  '.repeat(depth - 1)}└ ` : ''
  const room = Math.max(10, vm.width - indent.length - 4)
  const model = row.model === '' ? '' : `${shortModel(row.model)} · `
  const label = `${indent}${mark.mark} ${row.type}  ${model}${elapsed} · ${tools} herr.`
  const current = lastTool(vm.activity, row.id)
  const hotkey = ctx.hotkeys.get(row.id)
  return (
    <Box key={`fila-${row.id}`} flexDirection="column" marginBottom={isLive ? 1 : 0}>
      <Button
        key={`agente-${row.id}`}
        plain
        label={label}
        dimColor={!isLive}
        {...(hotkey === undefined ? {} : { hotkey })}
        onPress={() => ctx.act.select(row.id)}
      />
      <Text dimColor={!isLive} wrap="truncate-end">
        {`${indent}  ${trunc(row.description, room)}`}
      </Text>
      {isLive && current !== '' && (
        <Text color="permission" wrap="truncate-end">{`${indent}  → ${trunc(current, room - 2)}`}</Text>
      )}
    </Box>
  )
}

function runHeader(ui: Ui, run: WorkflowRun, vm: ViewModel) {
  const { Box, Text } = ui
  const summary = runSummary(vm.agents, run.runId)
  const isLive = run.endedAt === null
  const elapsed = fmtElapsed((run.endedAt ?? vm.now) - run.startedAt)
  const phase = summary.phase === '' ? '' : ` · fase ${summary.phase}`
  return (
    <Box key={`cabecera-${run.runId}`} flexDirection="column">
      <Text bold color={isLive ? 'claude' : undefined} dimColor={!isLive} wrap="truncate-end">
        {`⧉ ${run.name}${phase}`}
      </Text>
      <Text dimColor>{`  ${summary.active} activos · ${summary.finished} terminados · ${elapsed}${isLive ? '' : ' · run cerrado'}`}</Text>
      {run.badLines > 0 && <Text color="warning">{`  ${run.badLines} líneas ilegibles en el journal`}</Text>}
      {run.error !== null && <Text color="error" wrap="wrap">{`  ${run.error}`}</Text>}
    </Box>
  )
}

function runBlock(ctx: RowCtx, run: WorkflowRun) {
  const { Box, Text } = ctx.ui
  const rows = ctx.vm.agents.filter((r) => r.runId === run.runId)
  return (
    <Box key={`run-${run.runId}`} flexDirection="column" marginTop={1}>
      {runHeader(ctx.ui, run, ctx.vm)}
      {groupByPhase(rows).map((group) => (
        <Box key={`fase-${run.runId}-${group.phase}`} flexDirection="column">
          <Text dimColor>{`  ${group.phase}`}</Text>
          {group.rows.map((row) => agentRow(ctx, row, 2))}
        </Box>
      ))}
    </Box>
  )
}

/** Atajos 1-9 para las primeras filas, en el orden en que se pintan. */
function hotkeysFor(subagents: ReadonlyArray<{ row: AgentRow }>, runs: readonly WorkflowRun[], agents: readonly AgentRow[]) {
  const runIds = runs.flatMap((run) => groupByPhase(agents.filter((r) => r.runId === run.runId)).flatMap((g) => g.rows.map((r) => r.id)))
  const ids = [...subagents.map(({ row }) => row.id), ...runIds].slice(0, 9)
  return new Map(ids.map((id, i) => [id, String(i + 1)]))
}

export function agentsView(ui: Ui, vm: ViewModel, act: Actions) {
  const { Box, Button, Text } = ui
  const active = vm.agents.filter(isActive).length
  const finished = vm.agents.length - active
  const subagents = ordered(vm.agents.filter((r) => r.source === 'subagent'))
  const ctx: RowCtx = { ui, vm, act, hotkeys: hotkeysFor(subagents, vm.runs, vm.agents) }
  const isEmpty = vm.agents.length === 0 && vm.runs.length === 0
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Text bold color={active > 0 ? 'claude' : undefined}>
          {active === 0 ? 'nadie trabajando' : `${active} trabajando`}
        </Text>
        {finished > 0 && <Text dimColor>· {finished} terminados</Text>}
        {finished > 0 && <Button key="limpiar" label="limpiar terminados" hotkey="c" onPress={act.clear} />}
      </Box>
      {vm.notice !== '' && <Text color="warning" wrap="wrap">{vm.notice}</Text>}
      {isEmpty && (
        <Text dimColor wrap="wrap">
          Aquí salen los subagentes y los agentes de los workflows en cuanto se lance uno: tipo, modelo, tiempo y la herramienta que está usando. Pulsa una fila para ver su detalle.
        </Text>
      )}
      {subagents.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {subagents.map(({ row, depth }) => agentRow(ctx, row, depth))}
        </Box>
      )}
      {vm.runs.map((run) => runBlock(ctx, run))}
    </Box>
  )
}
