import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HudProject, HudTone, HudTurn } from '../types'
import { SOCRATIC_MODES, fmtDuration, nearestTurn, parseSocraticMode, pickVerb, turnSummary } from './format'

const MAX_TURNS = 40
const HINT_TURNS = 3
const HINT = '/agentes · /skills · /codex · /contexto · /adjuntar · /captura · /citar'

const projectAtom = atom({ plugin: 'ultron-hud', key: 'project' } as const, null)
const toneAtom = atom({ plugin: 'ultron-hud', key: 'tone' } as const, null)
const turnsAtom = atom({ plugin: 'ultron-hud', key: 'turns' } as const, [])

const set = <T,>(value: T) => () => value

/** Ejecuta bin/ultron.cjs (identidad de proyecto, detección de tono) y parsea su JSON. */
async function bridge<T>($: EngineInterface, args: string[], stdin?: string): Promise<T | null> {
  const script = `${$.plugin.root}/bin/ultron.cjs`
  const run = await $.process.run(['node', script, ...args], { stdin, timeoutMs: 15_000 })
  if (run.exitCode !== 0) {
    $.ui.log(`ultron-hud: ${args[0]} falló: ${run.stderr.trim().slice(0, 200)}`)
    return null
  }
  return JSON.parse(run.stdout) as T
}

async function loadProject($: EngineInterface): Promise<void> {
  const project = await bridge<HudProject>($, ['project', await $.session.cwd()])
  if (project) await update($, projectAtom, set<HudProject | null>(project))
}

async function detectTone($: EngineInterface, text: string): Promise<void> {
  const tone = await bridge<HudTone>($, ['tone'], text)
  if (tone) await update($, toneAtom, set<HudTone | null>(tone))
}

/** Cambia el modo socrático del proyecto con el script de ULTRON y refresca el pie. */
async function setSocratic($: EngineInterface, args: string): Promise<string> {
  const project = await read($, projectAtom)
  if (!project) return 'Este directorio no es un proyecto registrado en ULTRON: no hay modo socrático que cambiar.'
  const mode = parseSocraticMode(args)
  const options = SOCRATIC_MODES.join(', ')
  if (mode === '') return `socrático ${project.socratic} · opciones: ${options}`
  if (mode === null) return `Modo «${args.trim()}» no válido: ${options}.`
  if (mode === project.socratic) return `El proyecto ya está en socrático ${mode}.`
  const script = `${$.plugin.root}/../../scripts/project-socratic.mjs`
  const run = await $.process.run(['node', script, project.id, mode], { timeoutMs: 15_000 })
  if (run.exitCode !== 0) return `No se pudo cambiar el modo: ${(run.stderr || run.stdout).trim().slice(0, 300)}`
  await update($, projectAtom, set<HudProject | null>({ ...project, socratic: mode }))
  return `socrático ${project.socratic} → ${mode} en ${project.name}`
}

async function costNow($: EngineInterface): Promise<number | null> {
  return (await $.session.usage()).cost?.usd ?? null
}

export const register: Register = (on) => {
  // Contadores del turno en curso: si el módulo se recarga a mitad de turno,
  // ese turno se queda sin resumen y el siguiente ya cuenta bien.
  let toolsThisTurn = 0
  let costAtStart: number | null = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'socratico',
      description: 'Modo socrático del proyecto: /socratico [strict|light|off|uni]',
      immediate: true,
    })
    $.clock.after(0, () => void loadProject($))
    return next(e)
  })

  on('command.run', { command: 'socratico' }, async ($, e) => ({ text: await setSocratic($, e.args) }))

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' && !e.text.startsWith('/')) {
      const text = e.text
      $.clock.after(0, () => void detectTone($, text))
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    toolsThisTurn = 0
    costAtStart = await costNow($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) toolsThisTurn += 1
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const cost = await costNow($)
    const turn: HudTurn = {
      durationMs: e.durationMs,
      tools: toolsThisTurn,
      outputTokens: e.usage?.output_tokens ?? 0,
      costUsd: cost !== null && costAtStart !== null ? Math.max(0, cost - costAtStart) : null,
    }
    await update($, turnsAtom, (list) => [...list, turn].slice(-MAX_TURNS))
    return result
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const word = pickVerb(await read($, toneAtom), e.props.mode, await $.clock.now())
    return next({ ...e, props: { ...e.props, word } })
  })

  on('ui.render', { component: 'TurnDuration' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const turn = nearestTurn(await read($, turnsAtom), e.props.durationMs)
    const extra = turn ? turnSummary(turn) : ''
    return (
      <Box flexDirection="row" columnGap={1}>
        <Text color="success">✓</Text>
        <Text dimColor>{fmtDuration(e.props.durationMs)}</Text>
        {extra !== '' && <Text dimColor>· {extra}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const project = await read($, projectAtom)
    const tone = await read($, toneAtom)
    const extra = [
      project ? `socrático ${project.socratic}` : '',
      tone && !tone.isDefault && tone.id ? `tono ${tone.id}` : '',
    ].filter(Boolean)
    if (extra.length === 0) return next(e)
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, ...extra] } })
  })

  // Las primeras vueltas de cada sesión recuerdan qué comandos traen los mods.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.props.isDraft || e.props.isWorking || (await $.session.turns()) >= HINT_TURNS) return next(e)
    return next({ ...e, props: { ...e.props, tail: HINT } })
  })
}
