import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { mask } from '../hooks/sources.ts'

const PANE = {
  plugin: 'matrix-rain',
  component: 'Pane',
  requestId: 'matrix-rain',
  props: {
    title: 'Matrix',
    isFocused: false,
    bodyColumns: 24,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 14 },
    view: {},
  },
} as const

type Cell = { char: string; fg: number }

function decode(cells: string): Cell[] {
  const bin = atob(cells)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const words = new Uint32Array(bytes.buffer)
  const out: Cell[] = []
  for (let i = 0; i < words.length; i += 3) {
    out.push({ char: String.fromCodePoint(words[i]!), fg: words[i + 1]! })
  }
  return out
}

const lit = (frame: Cell[]) => frame.filter(cell => cell.char !== ' ')
const rgb = (fg: number) => [(fg >> 16) & 0xff, (fg >> 8) & 0xff, fg & 0xff] as const
const isRed = (fg: number) => rgb(fg)[0] > rgb(fg)[1] && rgb(fg)[0] > rgb(fg)[2]
const isGreen = (fg: number) => rgb(fg)[1] > rgb(fg)[0] && rgb(fg)[1] > rgb(fg)[2]

function world(on: On) {
  const clock = mock.clock(on)
  mock.store(on)
  on('command.register', () => ({ value: { command: 'matrix' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const frames: Cell[][] = []
  on('ui.blit', (_, e) => {
    if ('cells' in e) frames.push(decode(e.cells))
    return { value: {} }
  })
  return { clock, frames }
}

test('lo que se agrega en un Edit cae en verde y luego todo se apaga', async ($, on) => {
  const { clock, frames } = world(on)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await $.tool.call({
    tool: 'Edit',
    file_path: '/repo/Matrix.java',
    old_string: 'int a = 1;',
    new_string: 'int a = 1;\nreturn neo;',
  })
  await clock.advance(1500)

  const seen = new Set(frames.flatMap(frame => lit(frame).map(cell => cell.char)))
  for (const ch of 'returnneo;') expect(seen.has(ch)).toBe(true)
  // La línea que ya estaba no cae: solo lo agregado.
  expect(seen.has('1')).toBe(false)
  expect(frames.flatMap(lit).every(cell => isGreen(cell.fg))).toBe(true)

  // En reposo la pantalla queda negra y deja de repintarse.
  await clock.advance(60_000)
  const count = frames.length
  expect(lit(frames[count - 1]!).length).toBe(0)
  await clock.advance(5_000)
  expect(frames.length).toBe(count)
  await ui.unmount()
})

test('la línea del test que falla cae en rojo', async ($, on) => {
  const { clock, frames } = world(on)
  on('tool.call', () => ({
    result: { stdout: 'PASS loginTest\nFAILED gradeTest', stderr: '', interrupted: false },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await $.tool.call({ tool: 'Bash', command: './gradlew test' })
  await clock.advance(3000)

  const cells = frames.flatMap(lit)
  expect(cells.some(cell => cell.char === 'F' && isRed(cell.fg))).toBe(true)
  expect(cells.some(cell => cell.char === 'P' && isGreen(cell.fg))).toBe(true)
  await ui.unmount()
})

test('un .env leído no cae nunca', async ($, on) => {
  const { clock, frames } = world(on)
  on('tool.call', () => ({
    result: {
      type: 'text',
      file: { filePath: '/repo/.env', content: 'DB_HOST=x\nQWERTY=zzz', numLines: 2, startLine: 1, totalLines: 2 },
    },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await $.tool.call({ tool: 'Read', file_path: '/repo/.env' })
  await clock.advance(2000)

  expect(frames.flatMap(lit).length).toBe(0)
  await ui.unmount()
})

test('las herramientas sin hook propio también caen, entrada y respuesta', async ($, on) => {
  const { clock, frames } = world(on)
  on('tool.call', () => ({ result: [{ type: 'text', text: 'trinity' }] }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await $.tool.call({ tool: 'mcp__demo__scan', folder: 'zion' })
  await clock.advance(3000)

  const text = frames.flatMap(lit).map(cell => cell.char).join('')
  for (const ch of 'zion' + 'trinity') expect(text.includes(ch)).toBe(true)
  await ui.unmount()
})

test('fuera de la terminal el panel lo dice en vez de dibujar', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /terminal/ }))?.text).toContain('terminal')
  await ui.unmount()
})

test('las claves y tokens se enmascaran', async () => {
  expect(mask('API_KEY=sk-ant-abc123def456ghi789')).toBe('API_KEY=****')
  expect(mask('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc123')).toBe('Authorization: Bearer ****')
  expect(mask('token 9f8e7d6c5b4a39281706f5e4d3c2b1a0')).toBe('token ****')
  expect(mask('src/main/java/StudentService2.java')).toBe('src/main/java/StudentService2.java')
  expect(mask('return neo;')).toBe('return neo;')
})
