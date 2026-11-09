import type { Elements } from 'claude-code'

import type { CodexJob, CodexResult } from '../types'
import { isActiveStatus, oneLine, promptOf, trunc } from './codex'

export type Ui = Elements['terminal'] | Elements['desktop'] | Elements['vscode']

export type Actions = {
  select: (id: string) => void
  back: () => void
  dismiss: () => void
  cancel: (id: string) => void
  send: () => void
  refresh: () => void
}

export type ViewModel = {
  jobs: readonly CodexJob[]
  prompts: Readonly<Record<string, string>>
  selectedId: string | null
  detail: CodexResult | null
  isLoading: boolean
  error: string | null
  actionError: string | null
  notice: string | null
  width: number
  rows: number
}

const STATUS_MARK: Record<string, { mark: string; color: string; label: string }> = {
  queued: { mark: '○', color: 'warning', label: 'en cola' },
  running: { mark: '●', color: 'claude', label: 'en curso' },
  completed: { mark: '✓', color: 'success', label: 'terminado' },
  failed: { mark: '✗', color: 'error', label: 'falló' },
  cancelled: { mark: '■', color: 'inactive', label: 'cancelado' },
}

const markOf = (status: string) => STATUS_MARK[status] ?? { mark: '·', color: 'inactive', label: status }

function messages(ui: Ui, vm: ViewModel, act: Actions) {
  const { Box, Button, Text } = ui
  return [
    vm.actionError !== null && (
      <Box key="error-accion" flexDirection="row" columnGap={1}>
        <Text color="error" wrap="wrap">
          {vm.actionError}
        </Text>
        <Button key="descartar" label="descartar" hotkey="d" onPress={act.dismiss} />
      </Box>
    ),
    vm.error !== null && (
      <Text color="error" wrap="wrap">
        {vm.error}
      </Text>
    ),
    vm.notice !== null && (
      <Text color="warning" wrap="wrap">
        {vm.notice}
      </Text>
    ),
  ]
}

function jobRow(ui: Ui, vm: ViewModel, job: CodexJob, act: Actions) {
  const width = vm.width
  const { Box, Button, Text } = ui
  const mark = markOf(job.status)
  const head = `${mark.mark} ${job.id} · ${job.kind}${job.isWrite ? ' (escritura)' : ''} · ${mark.label}${job.time ? ` · ${job.time}` : ''}`
  return (
    <Box key={`fila-${job.id}`} flexDirection="column">
      <Button key={`job-${job.id}`} plain label={trunc(head, Math.max(20, width - 2))} onPress={() => act.select(job.id)} />
      <Text dimColor wrap="truncate-end">{`  ${trunc(oneLine(promptOf(job, vm.prompts)), Math.max(10, width - 4))}`}</Text>
    </Box>
  )
}

function listView(ui: Ui, vm: ViewModel, act: Actions) {
  const { Box, Button, Text } = ui
  const active = vm.jobs.filter((job) => isActiveStatus(job.status)).length
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Text bold color="claude">CODEX</Text>
        <Text dimColor>{active > 0 ? `${active} en curso · ` : ''}{vm.jobs.length} trabajos</Text>
        {vm.isLoading && <Text color="warning">leyendo…</Text>}
        <Button key="refrescar" label="refrescar" hotkey="r" onPress={act.refresh} />
      </Box>
      {messages(ui, vm, act)}
      {vm.jobs.length === 0 && !vm.isLoading && (
        <Text dimColor wrap="wrap">
          Sin trabajos en esta sesión. /codex &lt;prompt&gt; lanza una tarea de solo lectura, /codex-write una que puede editar y /codex-review revisa el working tree.
        </Text>
      )}
      {vm.jobs.map((job) => jobRow(ui, vm, job, act))}
    </Box>
  )
}

function resultBlock(ui: Ui, vm: ViewModel, job: CodexJob) {
  const { Text } = ui
  if (isActiveStatus(job.status)) {
    return <Text dimColor wrap="wrap">{`Trabajando${job.phase ? ` (${job.phase})` : ''}… el resultado aparece aquí al terminar.`}</Text>
  }
  if (vm.detail === null || vm.detail.id !== job.id) {
    return <Text dimColor>{vm.isLoading ? 'leyendo el resultado…' : 'Sin resultado cargado.'}</Text>
  }
  const lines = vm.detail.text.split(/\r?\n/)
  const room = Math.max(4, vm.rows - 10)
  const shown = lines.slice(0, room).join('\n')
  const hidden = lines.length - room
  return [
    <Text wrap="wrap">{shown}</Text>,
    hidden > 0 && <Text dimColor>{`+${hidden} líneas más (completo al enviarlo a Claude)`}</Text>,
  ]
}

function detailView(ui: Ui, vm: ViewModel, act: Actions, job: CodexJob) {
  const { Box, Button, Text } = ui
  const mark = markOf(job.status)
  const isActive = isActiveStatus(job.status)
  const canSend = !isActive && vm.detail !== null && vm.detail.id === job.id
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Text color={mark.color}>{mark.mark}</Text>
        <Text bold>{job.id}</Text>
        <Text dimColor>{`${job.kind} · ${mark.label}${job.time ? ` · ${job.time}` : ''}`}</Text>
      </Box>
      {job.isWrite && <Text color="warning">Trabajo con escritura: puede haber modificado ficheros.</Text>}
      <Text dimColor wrap="wrap">{trunc(oneLine(promptOf(job, vm.prompts)), Math.max(20, vm.width * 2))}</Text>
      {messages(ui, vm, act)}
      <Box flexDirection="column" marginTop={1}>
        {resultBlock(ui, vm, job)}
      </Box>
      <Box flexDirection="row" columnGap={1} marginTop={1}>
        <Button key="volver" label="← volver" hotkey="v" onPress={act.back} />
        {isActive && <Button key="cancelar" label="Cancelar" hotkey="c" onPress={() => act.cancel(job.id)} />}
        {canSend && <Button key="enviar" label="Enviar a Claude" hotkey="e" variant="primary" onPress={act.send} />}
      </Box>
    </Box>
  )
}

export function codexView(ui: Ui, vm: ViewModel, act: Actions) {
  const job = vm.selectedId === null ? undefined : vm.jobs.find((one) => one.id === vm.selectedId)
  return job === undefined ? listView(ui, vm, act) : detailView(ui, vm, act, job)
}
