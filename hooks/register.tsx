import type { EngineInterface, Register } from 'claude-code'

import { EDIT, QUESTION, Rain, READ, TEST, THOUGHT } from './rain.ts'
import type { Tint } from './rain.ts'
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
const COVERED = new Set(['Edit', 'Write', 'Bash', 'Read', 'WebFetch', 'WebSearch', 'AskUserQuestion'])
const REDRAW_MS = 1000
const STALL_MS = 1000
// Una compactación puede dejar más de una fila de resumen: un solo déjà vu.
const DEJA_VU_MS = 5000
const GIT_MILESTONE = /\bgit\s+(commit|push)\b/

const rain = new Rain()
let view: { columns: number; rows: number } | undefined
let isBlitting = false
let isBlank = true
let timer: { cancel: () => void } | undefined
let lastTickAt = 0
let redrawAskedAt = 0
let dejaVuAt = 0

// Lo que espera a la persona: preguntas abiertas y permisos pedidos, por id
// de la llamada. Mientras haya alguno, el cursor parpadea.
const questions = new Set<string>()
const permits = new Set<string>()

function syncWaiting(): void {
  rain.isWaiting = questions.size > 0 || permits.size > 0
}

// Lo que alimenta la lluvia nunca debe romper la herramienta ni el turno.
function safely(fn: () => void): void {
  try {
    fn()
  } catch {
    // Se pierde una línea de lluvia, nada más.
  }
}

// Compactación: la lluvia se congela, destella y lo último vuelve a caer.
function dejaVu($: EngineInterface): void {
  if (Date.now() - dejaVuAt < DEJA_VU_MS) return
  dejaVuAt = Date.now()
  safely(() => {
    rain.dejaVu()
    keepTicking($)
  })
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

// Lo que hace un subagente cae en un verde más tenue.
function tintOf(agentId: string | undefined): Tint {
  return agentId === undefined ? 'green' : 'dim'
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

function firstLines(text: string, count: number): string {
  return text.split('\n').slice(0, count).join('\n')
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
      safely(() => feed($, EDIT, mask(addedLines(e.old_string, e.new_string)), tintOf(e.agentId)))
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && !touchesSecrets(e.file_path)) {
      safely(() => feed($, EDIT, mask(e.content), tintOf(e.agentId)))
    }

    return ran
  }).catch(($, e, next) => next(e))

  // Tests: el comando mientras corre; al terminar, su salida, con los fallos
  // en rojo. Un commit o un push brilla. Cualquier otro comando cuenta como
  // lectura, en rojo si falló.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const isTest = isTestCommand(e.command)
    const tint: Tint = GIT_MILESTONE.test(e.command) ? 'bright' : tintOf(e.agentId)
    safely(() => feed($, isTest ? TEST : READ, mask(e.command), tint))
    const ran = await next(e)
    if (ran.deny !== undefined || touchesSecrets(e.command)) return ran
    safely(() => {
      const out = outputOf(ran.result, ran.text)
      if (!isTest) {
        feed($, READ, mask(lastLines(out, 200)), ran.isError === true ? 'red' : tint)
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
        if (ran.result.type === 'text') feed($, READ, mask(ran.result.file.content), tintOf(e.agentId))
      })
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'WebFetch' }, async ($, e, next) => {
    safely(() => feed($, READ, e.url, tintOf(e.agentId)))
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      safely(() => feed($, READ, mask(ran.result.result), tintOf(e.agentId)))
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'WebSearch' }, async ($, e, next) => {
    const tint = tintOf(e.agentId)
    safely(() => feed($, READ, e.query, tint))
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      safely(() => {
        for (const block of ran.result.results) {
          if (typeof block === 'string') feed($, READ, mask(block), tint)
          else for (const hit of block.content) feed($, READ, `${hit.title}\n${hit.url}\n${hit.snippet ?? ''}`, tint)
        }
      })
    }

    return ran
  }).catch(($, e, next) => next(e))

  // Una pregunta a la persona: caen la pregunta y sus opciones, y un cursor
  // parpadea abajo hasta que responde; entonces cae la respuesta.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const id = e.tool_use_id
    safely(() => {
      for (const q of e.questions) {
        const options = q.options.flatMap(option => [option.label, option.description ?? ''])
        feed($, QUESTION, mask([q.header, q.question, ...options].join('\n')))
      }
    })
    questions.add(id)
    syncWaiting()
    let ran
    try {
      ran = await next(e)
    } finally {
      questions.delete(id)
      syncWaiting()
    }
    if (ran.deny === undefined && ran.isError !== true) {
      const { answers, response } = ran.result
      safely(() => feed($, QUESTION, mask(strings([Object.values(answers), response]).join('\n'))))
    }

    return ran
  }).catch(($, e, next) => {
    questions.delete(e.tool_use_id)
    syncWaiting()

    return next(e)
  })

  // Un permiso pedido: cae la herramienta con lo que quiere hacer y el cursor
  // espera, hasta que la llamada arranca o se rechaza.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const id = e.tool_use_id
    if (verdict.decision === 'ask' && id !== undefined && e.tool !== 'AskUserQuestion') {
      safely(() => feed($, QUESTION, mask([`permiso: ${e.tool}`, ...strings(e.input)].join('\n')), 'bright'))
      permits.add(id)
      syncWaiting()
    }

    return verdict
  }).catch(($, e, next) => next(e))

  // Cualquier otra herramienta (MCP, Skill, Agent, ToolSearch...): lo que
  // recibe al llamarla y lo que responde. Y, para todas, los errores en rojo.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const id = e.tool_use_id
    const isCovered = COVERED.has(tool)
    if (!isCovered) {
      safely(() => {
        const input = Object.entries(e).filter(([key]) => !ENVELOPE.has(key))
        feed($, READ, mask([tool, ...strings(input.map(([, value]) => value))].join('\n')), tintOf(e.agentId))
      })
    }
    permits.delete(id)
    syncWaiting()
    let ran
    try {
      ran = await next(e)
    } finally {
      permits.delete(id)
      syncWaiting()
    }
    const hasFailed = ran.deny !== undefined || ran.isError === true
    if (hasFailed && tool !== 'Bash') {
      safely(() => feed($, TEST, mask(lastLines([tool, ...strings([ran.deny, ran.result, ran.text])].join('\n'), 40)), 'red'))
    } else if (!hasFailed && !isCovered) {
      safely(() => feed($, READ, mask(lastLines(strings([ran.result, ran.text]).join('\n'), 120)), tintOf(e.agentId)))
    }

    return ran
  }).catch(($, e, next) => next(e))

  // Un subagente que arranca: su tarea, en verde tenue.
  on('agent.spawn', ($, e, next) => {
    safely(() => feed($, THOUGHT, mask(`${e.subagentType}: ${e.description}\n${firstLines(e.prompt, 40)}`), 'dim'))

    return next(e)
  }).catch(($, e, next) => next(e))

  // El pensamiento y la respuesta del modelo, mientras llegan.
  on('turn.step', async function* ($, e, next) {
    const tint = tintOf(e.agentId)
    const lines = new LineSplitter(line => feed($, THOUGHT, mask(line), tint))
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

  // Fin del turno: los tokens que costó caen como último suspiro; si la
  // persona lo interrumpió, la lluvia se congela y se desploma.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    safely(() => {
      questions.clear()
      permits.clear()
      syncWaiting()
      if (e.reason === 'aborted') {
        rain.collapse()
        keepTicking($)
      } else if (done.usage !== undefined) {
        const u = done.usage
        const read = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        feed($, THOUGHT, `tokens in ${read} out ${u.output_tokens}`, 'dim')
      }
    })

    return done
  }).catch(($, e, next) => next(e))

  // Compactación del contexto: un déjà vu. Un plugin anterior puede quedarse
  // con `session.compact` y con la fila del resumen sin pasarlas, así que
  // `/compact` se escucha también como comando, al terminar. La fila del
  // resumen queda para las compactaciones automáticas que sí llegan.
  on('command.run', { command: 'compact' }, async ($, e, next) => {
    const done = await next(e)
    dejaVu($)
    return done
  }).catch(($, e, next) => next(e))

  on('session.append', { door: 'compaction' }, ($, e, next) => {
    if (e.agentId === undefined) dejaVu($)

    return next(e)
  }).catch(($, e, next) => next(e))

  // Lo que la persona escribe, tecla a tecla.
  on('prompt.edit', ($, e, next) => {
    if (e.inputText !== '') {
      safely(() => {
        rain.type(mask(e.inputText))
        keepTicking($)
      })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Comandos de barra, skills y mensajes de otras sesiones o tareas.
  on('command.run', ($, e, next) => {
    safely(() => feed($, THOUGHT, mask(`/${e.command} ${e.args}`)))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('skill.prompt', ($, e, next) => {
    safely(() => feed($, READ, mask(`skill ${e.skill}\n${firstLines(e.text, 30)}`), 'dim'))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.receive', ($, e, next) => {
    safely(() => feed($, THOUGHT, mask(e.text), tintOf(e.agentId)))

    return next(e)
  }).catch(($, e, next) => next(e))
}
