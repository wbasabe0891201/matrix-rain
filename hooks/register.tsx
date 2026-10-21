import type { EngineInterface, Register } from 'claude-code'

import { EDIT, Rain, READ, TEST, THOUGHT } from './rain.ts'
import {
  addedLines,
  isTestCommand,
  LineSplitter,
  mask,
  testTint,
  touchesSecrets,
} from './sources.ts'

const PANE = 'matrix-rain'
const TITLE = 'Matrix'
const RASTER = 'rain'
const FRAME_MS = 50
const DOCK_COLUMNS = 44
const WANTED = 'paneWanted'

// Herramientas con un hook propio; las demás caen por el hook genérico.
const COVERED = new Set(['Edit', 'Write', 'Bash', 'Read', 'WebFetch', 'WebSearch'])
const REDRAW_MS = 1000
const STALL_MS = 1000

const rain = new Rain()
let view: { columns: number; rows: number } | undefined
let isBlitting = false
let isBlank = true
let timer: { cancel: () => void } | undefined
let lastTickAt = 0
let redrawAskedAt = 0

// Lo que alimenta la lluvia nunca debe romper la herramienta ni el turno.
function safely(fn: () => void): void {
  try {
    fn()
  } catch {
    // Se pierde una línea de lluvia, nada más.
  }
}

// Un período que el engine rechaza termina el intervalo para siempre: si el
// reloj dejó de latir, se arranca otro.
function keepTicking($: EngineInterface): void {
  if (Date.now() - lastTickAt < STALL_MS) return
  timer?.cancel()
  lastTickAt = Date.now()
  timer = $.clock.every(FRAME_MS, () => frame($))
}

// Tras un repintado rechazado (panel tapado, tamaño en transición) hace falta
// un render nuevo para volver a montar el Raster; se pide, como mucho uno por segundo.
function askRedraw($: EngineInterface): void {
  if (Date.now() - redrawAskedAt < REDRAW_MS) return
  redrawAskedAt = Date.now()
  safely(() => $.ui.invalidate('ui.render'))
}

function frame($: EngineInterface): void {
  lastTickAt = Date.now()
  if (view === undefined) {
    if (!rain.isIdle) askRedraw($)
    return
  }
  if (isBlitting) return
  if (rain.isIdle && isBlank) return
  rain.step()
  isBlank = rain.isIdle
  isBlitting = true
  $.ui
    .blit({ requestId: PANE, key: RASTER, cells: rain.cells(), columns: rain.columns, rows: rain.rows })
    .then(blitted => {
      if (blitted.deny === undefined) return
      view = undefined
      askRedraw($)
    })
    .catch(() => {
      view = undefined
    })
    .finally(() => {
      isBlitting = false
    })
}

// Todo lo que entra a la lluvia pasa por aquí, y de paso revive el reloj.
function feed($: EngineInterface, ...args: Parameters<Rain['feed']>): void {
  rain.feed(...args)
  keepTicking($)
}

// Los campos del sobre de una llamada, que no son lo que la herramienta recibe.
const ENVELOPE = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'origin'])

// Las cadenas de un valor cualquiera (entrada o resultado de una herramienta).
function strings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (out.length > 200 || depth > 6) return out
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) strings(item, out, depth + 1)
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) strings(item, out, depth + 1)
  }
  return out
}

function lastLines(text: string, count: number): string {
  return text.split('\n').slice(-count).join('\n')
}

function outputOf(result: unknown, fallback: unknown): string {
  if (typeof result === 'string') return result
  if (result !== null && typeof result === 'object') {
    const { stdout, stderr } = result as { stdout?: unknown; stderr?: unknown }
    const out = [stdout, stderr].filter(s => typeof s === 'string' && s !== '').join('\n')
    if (out !== '') return out
  }
  return typeof fallback === 'string' ? fallback : ''
}

async function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: TITLE, columns: DOCK_COLUMNS })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'matrix',
      description: 'Abre o cierra la lluvia de código Matrix',
    })
    lastTickAt = 0
    keepTicking($)
    if ((await $.store.get(WANTED)) === true) void openPane($)

    return next(e)
  })

  on('command.run', { command: 'matrix' }, async ($, e) => {
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isOpen) {
      await $.ui.close({ id: PANE })
      await $.store.set(WANTED, false)

      return { text: 'Lluvia Matrix cerrada.' }
    }
    await $.store.set(WANTED, true)
    await openPane($)

    return {
      text: e.presentation.isFullscreen
        ? 'Lluvia Matrix abierta.'
        : 'Lluvia Matrix abierta encima del prompt. En el modo de pantalla completa se acopla como panel a la derecha.',
    }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    view = undefined
    if (e.origin.kind === 'person') await $.store.set(WANTED, false)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => {
    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)
      view = undefined

      return <Text dimColor>La lluvia Matrix solo se dibuja en la terminal.</Text>
    }
    const { Raster } = $.ui.resolve(e)
    const columns = Math.max(1, Math.min(512, e.props.bodyColumns))
    const rows = Math.max(1, Math.min(256, e.props.scroll.bodyRows))
    rain.resize(columns, rows)
    view = { columns, rows }
    isBlank = false

    return <Raster key={RASTER} columns={columns} rows={rows} cells={rain.cells()} />
  })

  // Ediciones: solo lo que se agrega o cambia.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && !touchesSecrets(e.file_path)) {
      safely(() => feed($, EDIT, mask(addedLines(e.old_string, e.new_string))))
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && !touchesSecrets(e.file_path)) {
      safely(() => feed($, EDIT, mask(e.content)))
    }

    return ran
  }).catch(($, e, next) => next(e))

  // Tests: el comando mientras corre; al terminar, su salida, con los fallos
  // en rojo. Cualquier otro comando cuenta como lectura.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const isTest = isTestCommand(e.command)
    safely(() => feed($, isTest ? TEST : READ, mask(e.command)))
    const ran = await next(e)
    if (ran.deny !== undefined || touchesSecrets(e.command)) return ran
    safely(() => {
      const out = outputOf(ran.result, ran.text)
      if (!isTest) {
        feed($, READ, mask(lastLines(out, 200)))
        return
      }
      feed($, TEST, mask(lastLines(out, 300)), testTint)
      if (ran.isError === true) feed($, TEST, mask(e.command), 'red')
    })

    return ran
  }).catch(($, e, next) => next(e))

  // Lecturas, locales y de internet.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && !touchesSecrets(e.file_path)) {
      safely(() => {
        if (ran.result.type === 'text') feed($, READ, mask(ran.result.file.content))
      })
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'WebFetch' }, async ($, e, next) => {
    safely(() => feed($, READ, e.url))
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      safely(() => feed($, READ, mask(ran.result.result)))
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'WebSearch' }, async ($, e, next) => {
    safely(() => feed($, READ, e.query))
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      safely(() => {
        for (const block of ran.result.results) {
          if (typeof block === 'string') feed($, READ, mask(block))
          else for (const hit of block.content) feed($, READ, `${hit.title}\n${hit.url}\n${hit.snippet ?? ''}`)
        }
      })
    }

    return ran
  }).catch(($, e, next) => next(e))

  // Cualquier otra herramienta (MCP, AskUserQuestion, Skill, Agent, Grep...):
  // lo que recibe al llamarla y lo que responde.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (COVERED.has(tool)) return next(e)
    safely(() => {
      const input = Object.entries(e).filter(([key]) => !ENVELOPE.has(key))
      feed($, READ, mask([tool, ...strings(input.map(([, value]) => value))].join('\n')))
    })
    const ran = await next(e)
    if (ran.deny === undefined) {
      safely(() => feed($, READ, mask(lastLines(strings([ran.result, ran.text]).join('\n'), 120))))
    }

    return ran
  }).catch(($, e, next) => next(e))

  // El pensamiento y la respuesta del modelo, mientras llegan.
  on('turn.step', async function* ($, e, next) {
    const lines = new LineSplitter(line => feed($, THOUGHT, mask(line)))
    const stream = next(e)
    for await (const chunk of stream) {
      if (chunk.kind === 'thinking' || chunk.kind === 'text') {
        safely(() => lines.push(chunk.index, chunk.text))
      }
      yield chunk
    }
    safely(() => lines.flush())

    return await stream.result
  })

  // Lo que pide la persona.
  on('prompt.submit', ($, e, next) => {
    safely(() => feed($, THOUGHT, mask(e.text)))

    return next(e)
  }).catch(($, e, next) => next(e))
}
