import type { AgentRow } from '../types'
import { activityOf, fmtElapsed, isActive, shortModel } from './agents'
import { type Ui, type ViewModel, markOf } from './view'

export type DetailActions = {
  back: () => void
  stop: (id: string) => void
}

function origin(row: AgentRow, vm: ViewModel): string {
  if (row.source === 'subagent') return row.parentId === null ? 'subagente' : `subagente de ${row.parentId}`
  const run = vm.runs.find((r) => r.runId === row.runId)
  return `workflow ${run?.name ?? row.runId ?? '?'} · fase ${row.phase}`
}

function resultText(row: AgentRow): string {
  if (isActive(row)) return 'todavía trabajando'
  return row.result ?? 'leyendo…'
}

function field(ui: Ui, label: string, value: string) {
  const { Box, Text } = ui
  return (
    <Box key={`campo-${label}`} flexDirection="row" columnGap={1}>
      <Text dimColor>{label}</Text>
      <Text wrap="truncate-end">{value}</Text>
    </Box>
  )
}

function header(ui: Ui, row: AgentRow, act: DetailActions) {
  const { Box, Button, Text } = ui
  const mark = markOf(row.status)
  const canStop = row.source === 'subagent' && isActive(row)
  return (
    <Box flexDirection="row" columnGap={1}>
      <Button key="volver" label="← volver" hotkey="v" onPress={act.back} />
      <Text color={mark.color}>{mark.mark}</Text>
      <Text bold>{row.type}</Text>
      {canStop && <Button key="detener" label="Detener" hotkey="d" onPress={() => act.stop(row.id)} />}
    </Box>
  )
}

export function detailView(ui: Ui, vm: ViewModel, id: string, act: DetailActions) {
  const { Box, Button, Text } = ui
  const row = vm.agents.find((r) => r.id === id)
  if (row === undefined) {
    return (
      <Box flexDirection="column">
        <Button key="volver" label="← volver" hotkey="v" onPress={act.back} />
        <Text dimColor wrap="wrap">{`El agente ${id} ya no está en la lista (se limpió o salió del historial).`}</Text>
      </Box>
    )
  }
  const activity = activityOf(vm.activity, row.id)
  const elapsed = fmtElapsed((row.endedAt ?? vm.now) - row.startedAt)
  return (
    <Box flexDirection="column">
      {header(ui, row, act)}
      {vm.notice !== '' && <Text color="warning" wrap="wrap">{vm.notice}</Text>}
      <Box flexDirection="column" marginTop={1}>
        {field(ui, 'modelo', row.model === '' ? '?' : shortModel(row.model))}
        {field(ui, 'estado', markOf(row.status).word)}
        {field(ui, 'tiempo', elapsed)}
        {field(ui, 'herramientas', String(activity.tools))}
        {field(ui, 'origen', origin(row, vm))}
        {field(ui, 'id', row.id)}
      </Box>
      <Text dimColor>descripción</Text>
      <Text wrap="wrap">{row.description === '' ? '(sin descripción)' : row.description}</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>{`últimas herramientas (${activity.history.length})`}</Text>
        {activity.history.length === 0 && <Text dimColor>ninguna vista todavía</Text>}
        {[...activity.history].reverse().map((label, i) => (
          <Box key={`herr-${i}`}>
            <Text color={i === 0 && isActive(row) ? 'permission' : undefined} wrap="truncate-end">{`→ ${label}`}</Text>
          </Box>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>resultado</Text>
        <Text wrap="wrap">{resultText(row)}</Text>
      </Box>
    </Box>
  )
}
