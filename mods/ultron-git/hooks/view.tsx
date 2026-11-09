import type { Elements } from 'claude-code'

import type { GitDiff, GitFile, GitSnapshot, GitTab, GitView } from '../types'
import { lineTone, totals, turnChanges } from './git'

export type Ui = Elements['terminal'] | Elements['desktop'] | Elements['vscode']

export type ViewModel = {
  snapshot: GitSnapshot | null
  error: string | null
  turnFiles: readonly string[]
  view: GitView
  diff: GitDiff | null
  rows: number
}

export type Actions = {
  tab: (tab: GitTab) => void
  select: (path: string) => void
  back: () => void
  page: (delta: number) => void
  refresh: () => void
}

const fmtStat = (f: GitFile): string => (f.isBinary ? 'binario' : `+${f.added} −${f.deleted}`)

/** Resumen de una línea: `3 ficheros · +45 −12`. */
export function summaryLine(files: readonly GitFile[]): string {
  const t = totals(files)
  return `${files.length} fichero${files.length === 1 ? '' : 's'} · +${t.added} −${t.deleted}`
}

function header(ui: Ui, s: GitSnapshot) {
  const { Box, Text } = ui
  const sync = [s.ahead > 0 ? `↑${s.ahead}` : '', s.behind > 0 ? `↓${s.behind}` : ''].filter(Boolean).join(' ')
  return (
    <Box flexDirection="row" columnGap={1}>
      <Text bold>{s.branch}</Text>
      {sync !== '' && <Text color="warning">{sync}</Text>}
      <Text dimColor>{s.files.length === 0 ? 'árbol limpio' : `${summaryLine(s.files)} sin commitear`}</Text>
    </Box>
  )
}

function fileList(ui: Ui, files: readonly GitFile[], act: Actions, empty: string) {
  const { Box, Button, Text } = ui
  if (files.length === 0) return <Text dimColor>{empty}</Text>
  return (
    <Box flexDirection="column">
      {files.map((f) => (
        <Button key={`f:${f.path}`} label={`${f.code.padEnd(2)} ${f.path}  ${fmtStat(f)}`} onPress={() => act.select(f.path)} />
      ))}
    </Box>
  )
}

function diffView(ui: Ui, vm: ViewModel, diff: GitDiff, act: Actions) {
  const { Box, Button, Text } = ui
  const room = Math.max(5, vm.rows - 5)
  const shown = diff.lines.slice(vm.view.offset, vm.view.offset + room)
  const end = Math.min(diff.lines.length, vm.view.offset + room)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Button key="back" label="← volver" onPress={act.back} />
        <Text bold>{diff.path}</Text>
        <Text dimColor>{`${diff.lines.length === 0 ? 0 : vm.view.offset + 1}-${end} de ${diff.lines.length}`}</Text>
      </Box>
      {diff.lines.length === 0 && <Text dimColor>Sin diferencias frente a HEAD.</Text>}
      {shown.map((line, i) => (
        <Box key={`l${vm.view.offset + i}`}>
          <Text color={lineTone(line)}>{line === '' ? ' ' : line}</Text>
        </Box>
      ))}
      <Box flexDirection="row" columnGap={1}>
        {vm.view.offset > 0 && <Button key="up" label="↑ anterior" onPress={() => act.page(-room)} />}
        {end < diff.lines.length && <Button key="down" label="↓ siguiente" onPress={() => act.page(room)} />}
      </Box>
    </Box>
  )
}

export function gitView(ui: Ui, vm: ViewModel, act: Actions) {
  const { Box, Button, Text } = ui
  if (vm.error !== null) {
    return (
      <Box flexDirection="column">
        <Text color="error">{vm.error}</Text>
        <Button key="retry" label="Reintentar" onPress={act.refresh} />
      </Box>
    )
  }
  if (vm.snapshot === null) return <Text dimColor>Leyendo el repositorio…</Text>
  if (vm.view.selected !== null && vm.diff !== null) return diffView(ui, vm, vm.diff, act)
  const turn = turnChanges(vm.snapshot, vm.turnFiles)
  const isTurn = vm.view.tab === 'turno'
  return (
    <Box flexDirection="column">
      {header(ui, vm.snapshot)}
      <Box flexDirection="row" columnGap={1} marginBottom={1}>
        <Button key="t:turno" label={`${isTurn ? '▸ ' : ''}turno (${turn.length})`} onPress={() => act.tab('turno')} />
        <Button key="t:arbol" label={`${isTurn ? '' : '▸ '}árbol (${vm.snapshot.files.length})`} onPress={() => act.tab('arbol')} />
        <Button key="refresh" label="Actualizar" onPress={act.refresh} />
      </Box>
      {isTurn
        ? fileList(ui, turn, act, 'En el último turno no se ha tocado ningún fichero con cambios.')
        : fileList(ui, vm.snapshot.files, act, 'Árbol limpio: nada sin commitear.')}
    </Box>
  )
}
