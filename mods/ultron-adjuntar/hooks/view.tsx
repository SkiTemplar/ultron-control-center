import type { Elements } from 'claude-code'

import type { AttachSource } from '../types'
import { SOURCES, trunc } from './files'

export type Ui = Elements['terminal'] | Elements['desktop'] | Elements['vscode']

export type Hit = { path: string; display: string; meta: string; isImage: boolean }

export type Actions = {
  source: (source: AttachSource) => void
  query: (text: string) => void
  attach: (path: string) => void
  attachFirst: () => void
  done: () => void
}

export type ViewModel = {
  source: AttachSource
  query: string
  hits: Hit[]
  total: number
  attached: ReadonlySet<string>
  isLoading: boolean
  error: string | null
  width: number
}

const EMPTY: Record<AttachSource, string> = {
  proyecto: 'Ningún fichero coincide.',
  sesion: 'Claude aún no ha leído ni editado ficheros en esta sesión.',
  capturas: 'No hay capturas (Win+Shift+S las guarda en Imágenes/Capturas de pantalla).',
  descargas: 'La carpeta de descargas está vacía.',
  escritorio: 'El escritorio está vacío.',
}

function sourceBar(ui: Ui, vm: ViewModel, act: Actions) {
  const { Box, Button, Text } = ui
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      {SOURCES.map((s) => (
        <Button
          key={`src-${s.id}`}
          label={s.label}
          hotkey={s.hotkey}
          variant={vm.source === s.id ? 'primary' : 'secondary'}
          onPress={() => act.source(s.id)}
        />
      ))}
      {vm.isLoading && <Text color="warning">leyendo…</Text>}
    </Box>
  )
}

function hitRow(ui: Ui, vm: ViewModel, act: Actions, hit: Hit, index: number) {
  const { Box, Button, Text } = ui
  const isAttached = vm.attached.has(hit.path)
  const mark = isAttached ? '✓' : hit.isImage ? '▣' : '·'
  const room = Math.max(10, vm.width - hit.meta.length - 4)
  return (
    <Box key={`hit-${index}`} flexDirection="row" justifyContent="space-between">
      <Button
        key={`file-${index}`}
        plain
        dimColor={isAttached}
        label={`${mark} ${trunc(hit.display, room)}`}
        onPress={() => act.attach(hit.path)}
      />
      <Text dimColor>{hit.meta}</Text>
    </Box>
  )
}

export function attachView(ui: Ui, vm: ViewModel, act: Actions) {
  const { Box, Button, Input, Text } = ui
  const more = vm.total - vm.hits.length
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Text bold color="claude">ADJUNTAR</Text>
        <Text dimColor>
          {vm.attached.size > 0 ? `${vm.attached.size} en el prompt · ` : ''}Enter o clic añade @ruta
        </Text>
      </Box>
      {sourceBar(ui, vm, act)}
      <Input
        key="buscar"
        placeholder="Buscar (varias palabras: todas deben aparecer)…"
        value={vm.query}
        autoFocus
        submitLabel="adjuntar el primero"
        onInput={(text) => act.query(text)}
        onSubmit={() => act.attachFirst()}
      />
      {vm.error !== null && <Text color="error" wrap="wrap">{vm.error}</Text>}
      {vm.hits.length === 0 && !vm.isLoading && <Text dimColor>{EMPTY[vm.source]}</Text>}
      {vm.hits.map((hit, index) => hitRow(ui, vm, act, hit, index))}
      {more > 0 && <Text dimColor>+{more} más: afina la búsqueda</Text>}
      <Box flexDirection="row" justifyContent="flex-end">
        <Button key="listo" label="listo" hotkey="l" role="dismiss" onPress={act.done} />
      </Box>
    </Box>
  )
}
