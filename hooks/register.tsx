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

const rain = new Rain()
let view: { columns: number; rows: number } | undefined
let isBlitting = false
let isBlank = true

// Lo que alimenta la lluvia nunca debe romper la herramienta ni el turno.
function safely(fn: () => void): void {
  try {
    fn()
  } catch {
    // Se pierde una línea de lluvia, nada más.
  }
}

function frame($: EngineInterface): void {
  if (view === undefined || isBlitting) return
  if (rain.isIdle && isBlank) return
  rain.step()
  isBlank = rain.isIdle
  isBlitting = true
  $.ui
    .blit({ requestId: PANE, key: RASTER, cells: rain.cells(), columns: rain.columns, rows: rain.rows })
    .then(blitted => {
      if (blitted.deny !== undefined) view = undefined
    })
    .catch(() => {
      view = undefined
    })
    .finally(() => {
      isBlitting = false
    })
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
    $.clock.every(FRAME_MS, () => frame($))
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
      safely(() => rain.feed(EDIT, mask(addedLines(e.old_string, e.new_string))))
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && !touchesSecrets(e.file_path)) {
      safely(() => rain.feed(EDIT, mask(e.content)))
    }

    return ran
  }).catch(($, e, next) => next(e))

  // Tests: el comando mientras corre; al terminar, su salida, con los fallos
  // en rojo. Cualquier otro comando cuenta como lectura.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const isTest = isTestCommand(e.command)
    safely(() => rain.feed(isTest ? TEST : READ, mask(e.command)))
    const ran = await next(e)
    if (ran.deny !== undefined || touchesSecrets(e.command)) return ran
    safely(() => {
      const out = outputOf(ran.result, ran.text)
      if (!isTest) {
        rain.feed(READ, mask(lastLines(out, 200)))
        return
      }
      rain.feed(TEST, mask(lastLines(out, 300)), testTint)
      if (ran.isError === true) rain.feed(TEST, mask(e.command), 'red')
    })

    return ran
  }).catch(($, e, next) => next(e))

  // Lecturas, locales y de internet.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && !touchesSecrets(e.file_path)) {
      safely(() => {
        if (ran.result.type === 'text') rain.feed(READ, mask(ran.result.file.content))
      })
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'WebFetch' }, async ($, e, next) => {
    safely(() => rain.feed(READ, e.url))
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      safely(() => rain.feed(READ, mask(ran.result.result)))
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'WebSearch' }, async ($, e, next) => {
    safely(() => rain.feed(READ, e.query))
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      safely(() => {
        for (const block of ran.result.results) {
          if (typeof block === 'string') rain.feed(READ, mask(block))
          else for (const hit of block.content) rain.feed(READ, `${hit.title}\n${hit.url}\n${hit.snippet ?? ''}`)
        }
      })
    }

    return ran
  }).catch(($, e, next) => next(e))

  // El pensamiento y la respuesta del modelo, mientras llegan.
  on('turn.step', async function* ($, e, next) {
    const lines = new LineSplitter(line => rain.feed(THOUGHT, mask(line)))
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
    safely(() => rain.feed(THOUGHT, mask(e.text)))

    return next(e)
  }).catch(($, e, next) => next(e))
}
