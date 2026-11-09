import type { Elements } from 'claude-code'

import type { UsoSnapshot, UsoWindow } from '../types'
import { bar, fiveHourLines, isWeek, limitLine, tone, usageLine, windowLabel } from './format'

export type Ui = Elements['terminal'] | Elements['desktop'] | Elements['vscode']

export type ViewModel = { snapshot: UsoSnapshot | null; error: string | null }

/** Una ventana: nombre y barra, uso y tiempo, hora del límite y, en la semanal, su valor en 5 h. */
function windowBlock(ui: Ui, w: UsoWindow, weekInFiveHourPct: number | null) {
  const { Box, Text } = ui
  const extra = isWeek(w) ? fiveHourLines(w, weekInFiveHourPct) : []
  return (
    <Box key={w.kind} flexDirection="column" marginBottom={1}>
      <Box flexDirection="row" columnGap={1}>
        <Text bold>{windowLabel(w.kind).padEnd(7)}</Text>
        <Text color={tone(w)}>{bar(w.used)}</Text>
      </Box>
      <Text>{usageLine(w)}</Text>
      {w.runsOutLabel !== null ? <Text color="error">{limitLine(w)}</Text> : <Text>{limitLine(w)}</Text>}
      {extra.map((line) => <Box key={line}><Text dimColor>{line}</Text></Box>)}
    </Box>
  )
}

export function usoView(ui: Ui, vm: ViewModel, refresh: () => void) {
  const { Box, Button, Text } = ui
  const windows = vm.snapshot?.windows ?? []
  const ordered = [...windows.filter((w) => !isWeek(w)), ...windows.filter(isWeek)]
  return (
    <Box flexDirection="column">
      {vm.error !== null && <Text color="error">{vm.error}</Text>}
      {vm.error === null && windows.length === 0 && (
        <Text dimColor>Sin datos de límites todavía: llegan con la primera respuesta de la API.</Text>
      )}
      {ordered.map((w) => windowBlock(ui, w, vm.snapshot?.weekInFiveHourPct ?? null))}
      <Box flexDirection="row">
        <Button key="refresh" label="Actualizar" onPress={refresh} />
      </Box>
    </Box>
  )
}
