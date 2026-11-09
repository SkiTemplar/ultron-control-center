import { expect, test } from 'claude-code/testing'

import { minutesLeft, parseMinutes, pausaContent, pausaLine, pausaPath, reanudarContent } from '../hooks/pausa'

const NOW = Date.parse('2026-10-17T22:00:00Z')

test('ruta de la pausa: la variable manda; sin home ni variable no hay ruta', () => {
  expect(pausaPath('C:\\Users\\demo', undefined)).toBe('C:\\Users\\demo/.ultron/run/deny-secrets-pausa.json')
  expect(pausaPath('C:/Users/demo/', undefined)).toBe('C:/Users/demo/.ultron/run/deny-secrets-pausa.json')
  expect(pausaPath('C:/Users/demo', ' D:/x/pausa.json ')).toBe('D:/x/pausa.json')
  expect(pausaPath('', undefined)).toBeNull()
  expect(pausaPath('', '  ')).toBeNull()
})

test('minutos: enteros de 1 a 720; el resto se rechaza', () => {
  expect(parseMinutes('60')).toBe(60)
  expect(parseMinutes(' 720 ')).toBe(720)
  for (const bad of ['', '0', '721', '-5', '1.5', 'una hora', '99999']) expect(parseMinutes(bad)).toBeNull()
})

test('pausar y reanudar escriben lo que el hook entiende', () => {
  expect(minutesLeft(pausaContent(NOW, 90), NOW)).toBe(90)
  expect(minutesLeft(pausaContent(NOW, 90), NOW + 89 * 60_000 + 1)).toBe(1)
  expect(minutesLeft(pausaContent(NOW, 90), NOW + 90 * 60_000)).toBeNull()
  expect(minutesLeft(reanudarContent(NOW), NOW)).toBeNull()
})

test('una pausa ilegible, ausente o a más de 12 h vista no cuenta', () => {
  expect(minutesLeft(null, NOW)).toBeNull()
  expect(minutesLeft('{roto', NOW)).toBeNull()
  expect(minutesLeft('{"hasta": 5}', NOW)).toBeNull()
  expect(minutesLeft(JSON.stringify({ hasta: '2099-01-01T00:00:00Z' }), NOW)).toBeNull()
  expect(minutesLeft(`\uFEFF${pausaContent(NOW, 30)}`, NOW)).toBe(30)
})

test('línea de estado del listado', () => {
  expect(pausaLine(null)).toContain('inactiva')
  expect(pausaLine(42)).toContain('quedan 42 min')
})
