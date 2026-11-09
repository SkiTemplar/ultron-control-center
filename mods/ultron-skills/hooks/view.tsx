import type { Elements } from 'claude-code'

import type { SkillHit } from '../types'
import { MAIN_ORIGIN, UNKNOWN_LOOP_ORIGIN, fmtAgo, fmtTokens, totals } from './skills'

export type Ui = Elements['terminal'] | Elements['desktop'] | Elements['vscode']

export type Actions = {
  clear: () => void
}

export type ViewModel = {
  hits: readonly SkillHit[]
  error: string | null
  now: number
}

const ORIGIN_COLOR: Record<string, string> = {
  [MAIN_ORIGIN]: 'claude',
  [UNKNOWN_LOOP_ORIGIN]: 'warning',
}

function hitRow(ui: Ui, hit: SkillHit, now: number) {
  const { Box, Text } = ui
  const color = ORIGIN_COLOR[hit.origin] ?? 'suggestion'
  const tokens = hit.tokens === null ? '≈? tok' : `≈${fmtTokens(hit.tokens)} tok`
  return (
    <Box key={`skill-${hit.key}`} flexDirection="row" columnGap={1}>
      <Text bold wrap="truncate-end">{hit.name}</Text>
      <Text color={color}>{hit.origin}</Text>
      <Text dimColor>
        ×{hit.count} · {tokens} · {fmtAgo(now - hit.lastAt)}
      </Text>
    </Box>
  )
}

/** Aviso honesto: sin llamada a la tool Skill, el motor no dice en qué hilo se expandió. */
function unknownLoopNote(ui: Ui, hits: readonly SkillHit[]) {
  const { Text } = ui
  if (!hits.some((h) => h.origin === UNKNOWN_LOOP_ORIGIN)) return null
  return (
    <Text dimColor wrap="wrap">
      {`«${UNKNOWN_LOOP_ORIGIN}»: el motor no dice en qué hilo se expandió; puede ser /nombre en el principal o la precarga de un subagente.`}
    </Text>
  )
}

function footer(ui: Ui, hits: readonly SkillHit[]) {
  const { Text } = ui
  const t = totals(hits)
  return (
    <Text bold>
      {`Total: ${t.skills} skills · ${t.activations} activaciones · ≈${fmtTokens(t.tokens)} tokens`}
    </Text>
  )
}

export function skillsView(ui: Ui, vm: ViewModel, act: Actions) {
  const { Box, Button, Text } = ui
  return (
    <Box flexDirection="column">
      {vm.error !== null && <Text color="error" wrap="wrap">{`Error: ${vm.error}`}</Text>}
      {vm.hits.length === 0 && (
        <Text dimColor wrap="wrap">
          Ninguna skill activada todavía. Aquí sale cada una en cuanto el motor la expande (/nombre, tool Skill o precarga en un subagente).
        </Text>
      )}
      <Box flexDirection="column" marginTop={vm.hits.length > 0 ? 0 : 1}>
        {vm.hits.map((hit) => hitRow(ui, hit, vm.now))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {unknownLoopNote(ui, vm.hits)}
        {footer(ui, vm.hits)}
      </Box>
      {vm.hits.length > 0 && (
        <Box flexDirection="row" marginTop={1}>
          <Button key="limpiar" label="vaciar lista" hotkey="c" onPress={act.clear} />
        </Box>
      )}
    </Box>
  )
}
