// La simulación de la lluvia: columnas de texto real que caen y se apagan.
// No sabe nada del engine: recibe líneas, avanza un fotograma y empaqueta
// las celdas en el formato de un Raster.

// green: lo normal; red: fallos y errores; dim: lo que hace un subagente;
// bright: lo que la persona escribe en vivo, commits y pushes.
export type Tint = 'green' | 'red' | 'dim' | 'bright'
const TINTS: readonly Tint[] = ['green', 'red', 'dim', 'bright']

// Prioridad de las fuentes: la lluvia siempre toma primero de la más alta.
export const QUESTION = 0
export const EDIT = 1
export const TEST = 2
export const READ = 3
export const THOUGHT = 4
export type Source = typeof QUESTION | typeof EDIT | typeof TEST | typeof READ | typeof THOUGHT

const QUEUE_CAP = [200, 400, 400, 300, 120]

// El cursor que espera una respuesta: `> █` en la última fila, el bloque
// parpadeando como el de la terminal de "Wake up, Neo...".
const PROMPT_COLOR = 0x14f24a
const CURSOR_COLOR = 0x9dffb0
const BLINK_FRAMES = 10

// Lo que la persona escribe: una columna abierta que crece con cada tecla y
// se cierra tras este silencio.
const TYPING_IDLE_FRAMES = 30
const TYPING_FADE = 90

// Déjà vu: cuántas líneas recientes vuelven a caer.
const HISTORY = 10

type Line = { text: string; tint: Tint }

type Drop = {
  col: number
  text: string
  tint: Tint
  next: number
  row: number
  y: number
  speed: number
  fade: number
  isOpen: boolean
}

// Fondo negro propio, como en la película, no el de la terminal.
const BG = 0x000000

// Rampas de color de la estela: del recién escrito (0) al apagado (1).
const HEADS: Record<Tint, number> = {
  green: 0xf0fff2,
  red: 0xfff0f0,
  dim: 0xc4dcc8,
  bright: 0xffffff,
}
const TRAIL_STOPS: Record<Tint, Array<[number, number]>> = {
  green: [
    [0.0, 0xb4ffc2],
    [0.06, 0x5cff82],
    [0.16, 0x14f24a],
    [0.35, 0x00c832],
    [0.6, 0x008c1e],
    [0.82, 0x00480e],
    [1.0, 0x001805],
  ],
  red: [
    [0.0, 0xffb8b8],
    [0.06, 0xff6a6a],
    [0.16, 0xff2a2a],
    [0.35, 0xd81818],
    [0.6, 0x9a0e0e],
    [0.82, 0x500606],
    [1.0, 0x1a0202],
  ],
  dim: [
    [0.0, 0x7cc489],
    [0.1, 0x3f9c52],
    [0.35, 0x217a35],
    [0.6, 0x105422],
    [0.85, 0x062e10],
    [1.0, 0x020e05],
  ],
  bright: [
    [0.0, 0xeaffee],
    [0.15, 0xb4ffc2],
    [0.35, 0x5cff82],
    [0.6, 0x14f24a],
    [0.85, 0x00a028],
    [1.0, 0x002a08],
  ],
}
// Lo brillante tarda más en apagarse.
const FADE_SCALE: Record<Tint, number> = { green: 1, red: 1, dim: 1, bright: 1.5 }

const STEPS = 64

function ramp(stops: Array<[number, number]>): Uint32Array {
  const out = new Uint32Array(STEPS + 1)
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS
    let k = 0
    while (k < stops.length - 2 && t > stops[k + 1]![0]) k++
    const [t0, c0] = stops[k]!
    const [t1, c1] = stops[k + 1]!
    const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0)
    const mix = (shift: number) =>
      Math.round(((c0 >> shift) & 0xff) * (1 - f) + ((c1 >> shift) & 0xff) * f)
    out[i] = (mix(16) << 16) | (mix(8) << 8) | mix(0)
  }
  return out
}

const TRAILS = TINTS.map(tint => ramp(TRAIL_STOPS[tint]))
const HEAD_COLORS = TINTS.map(tint => HEADS[tint])

// Solo caracteres de una celda de ancho: ASCII, latín (tildes y ñ), griego,
// cirílico y katakana de ancho medio. Lo demás (emojis, CJK, tabs) se omite.
function isNarrow(cp: number): boolean {
  return (
    (cp >= 0x21 && cp <= 0x7e) ||
    (cp >= 0xa1 && cp <= 0x24f && cp !== 0xad) ||
    (cp >= 0x370 && cp <= 0x3ff) ||
    (cp >= 0x400 && cp <= 0x4ff) ||
    (cp >= 0xff61 && cp <= 0xff9f)
  )
}

function narrowOnly(raw: string): string {
  let out = ''
  for (const ch of raw) {
    const cp = ch.codePointAt(0)!
    if (cp === 0x20 || isNarrow(cp)) out += ch
  }
  return out
}

function clean(raw: string): string {
  return narrowOnly(raw.replace(/\s+/g, ' ').trim())
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function toBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  let chunk = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    chunk +=
      B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!
    if (chunk.length >= 8192) {
      parts.push(chunk)
      chunk = ''
    }
  }
  const rest = bytes.length - i
  if (rest > 0) {
    const n = (bytes[i]! << 16) | ((rest === 2 ? bytes[i + 1]! : 0) << 8)
    chunk += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    chunk += rest === 2 ? B64[(n >> 6) & 63]! + '=' : '=='
  }
  parts.push(chunk)
  return parts.join('')
}

export class Rain {
  columns = 0
  rows = 0
  private glyph = new Uint32Array(0)
  private age = new Uint16Array(0)
  private fade = new Uint16Array(0)
  private tint = new Uint8Array(0)
  private head = new Uint8Array(0)
  private words = new Uint32Array(0)
  private drops: Drop[] = []
  private busy = new Uint8Array(0)
  private queues: Line[][] = [[], [], [], [], []]
  private history: Line[] = []
  private lit = 0
  private frames = 0
  private typing: Drop | undefined
  private typedAt = 0
  private freezeFrames = 0
  private flashFrames = 0
  private rushFrames = 0
  // Mientras es true la lluvia no se apaga: hay una pregunta o un permiso
  // esperando respuesta.
  isWaiting = false

  constructor(private random: () => number = Math.random) {}

  resize(columns: number, rows: number): void {
    if (columns === this.columns && rows === this.rows) return
    this.columns = columns
    this.rows = rows
    const n = columns * rows
    this.glyph = new Uint32Array(n)
    this.age = new Uint16Array(n)
    this.fade = new Uint16Array(n)
    this.tint = new Uint8Array(n)
    this.head = new Uint8Array(n)
    this.words = new Uint32Array(n * 3)
    this.busy = new Uint8Array(columns)
    this.drops = []
    this.typing = undefined
    this.lit = 0
  }

  // Encola texto: cada línea con contenido será una columna que cae.
  feed(source: Source, text: string, tint: Tint | ((line: string) => Tint) = 'green'): void {
    const queue = this.queues[source]!
    for (const raw of text.split('\n')) {
      const line = clean(raw)
      if (line.replace(/ /g, '').length < 2) continue
      queue.push({ text: line, tint: typeof tint === 'function' ? tint(raw) : tint })
    }
    const cap = QUEUE_CAP[source]!
    if (queue.length > cap) queue.splice(0, queue.length - cap)
  }

  // Lo que la persona teclea cae al instante en una columna abierta, que
  // crece con cada tecla y se cierra cuando deja de escribir.
  type(text: string): void {
    const chars = narrowOnly(text.replace(/\s+/g, ' '))
    if (chars === '' || this.columns === 0 || this.rows === 0) return
    this.typedAt = this.frames
    const open = this.typing
    if (open !== undefined && open.isOpen && this.drops.includes(open)) {
      const room = this.rows - open.text.length
      open.text += chars.slice(0, room)
      if (chars.length < room) return
      open.isOpen = false
      this.type(chars.slice(room))
      return
    }
    const free: number[] = []
    for (let c = 0; c < this.columns; c++) if (!this.busy[c]) free.push(c)
    const col = free.length > 0
      ? free[Math.floor(this.random() * free.length)]!
      : Math.floor(this.random() * this.columns)
    const drop: Drop = {
      col,
      text: chars.slice(0, this.rows),
      tint: 'bright',
      next: 0,
      row: -1,
      y: -1,
      speed: 1,
      fade: TYPING_FADE,
      isOpen: chars.length < this.rows,
    }
    this.busy[col] = 1
    this.drops.push(drop)
    this.typing = drop
    if (chars.length > this.rows) this.type(chars.slice(this.rows))
  }

  // El gato negro: todo se congela un instante, destella, y las últimas
  // líneas vuelven a caer.
  dejaVu(): void {
    this.freezeFrames = 12
    this.flashFrames = 3
    this.queues[QUESTION]!.unshift(...this.history.map(line => ({ ...line })))
  }

  // Una interrupción: se congela, se descarta lo que esperaba y lo que
  // quedaba en pantalla se desploma.
  collapse(): void {
    this.freezeFrames = 6
    this.rushFrames = 30
    for (const queue of this.queues) queue.length = 0
    for (const drop of this.drops) {
      drop.speed *= 4
      drop.isOpen = false
    }
  }

  // Sin columnas cayendo, sin estela, sin nada en cola y sin pregunta abierta:
  // la pantalla está negra.
  get isIdle(): boolean {
    return (
      !this.isWaiting &&
      this.freezeFrames === 0 &&
      this.drops.length === 0 &&
      this.lit === 0 &&
      this.queues.every(q => q.length === 0)
    )
  }

  step(): void {
    if (this.columns === 0 || this.rows === 0) return
    this.frames++
    if (this.flashFrames > 0) this.flashFrames--
    if (this.freezeFrames > 0) {
      this.freezeFrames--
      return
    }
    if (this.typing?.isOpen && this.frames - this.typedAt > TYPING_IDLE_FRAMES) {
      this.typing.isOpen = false
    }
    const agingStep = this.rushFrames > 0 ? 3 : 1
    if (this.rushFrames > 0) this.rushFrames--
    this.ageCells(agingStep)
    this.spawn()
    this.advance()
  }

  // Las celdas del fotograma actual, en el formato de `RasterProps.cells`.
  cells(): string {
    const { glyph, age, fade, tint, head, words } = this
    const isFlash = this.flashFrames > 0
    for (let i = 0, w = 0; i < glyph.length; i++, w += 3) {
      const cp = glyph[i]!
      words[w] = cp === 0 ? 0x20 : cp
      words[w + 2] = BG
      if (cp === 0) {
        words[w + 1] = BG
      } else if (head[i] || isFlash) {
        words[w + 1] = HEAD_COLORS[tint[i]!]!
      } else {
        const t = Math.min(STEPS, Math.round((age[i]! / fade[i]!) * STEPS))
        words[w + 1] = TRAILS[tint[i]!]![t]!
      }
    }
    if (this.isWaiting) this.drawCursor()
    return toBase64(new Uint8Array(words.buffer))
  }

  private drawCursor(): void {
    if (this.columns < 3) return
    const isOn = Math.floor(this.frames / BLINK_FRAMES) % 2 === 0
    const at = (this.rows - 1) * this.columns * 3
    const put = (col: number, cp: number, fg: number) => {
      this.words[at + col * 3] = cp
      this.words[at + col * 3 + 1] = fg
      this.words[at + col * 3 + 2] = BG
    }
    put(0, 0x3e, PROMPT_COLOR)
    put(1, 0x20, BG)
    put(2, isOn ? 0x2588 : 0x20, isOn ? CURSOR_COLOR : BG)
  }

  private ageCells(by: number): void {
    const { glyph, age, fade } = this
    let lit = 0
    for (let i = 0; i < glyph.length; i++) {
      if (glyph[i] === 0) continue
      age[i] = Math.min(0xffff, age[i]! + by)
      if (age[i]! > fade[i]!) glyph[i] = 0
      else lit++
    }
    this.lit = lit
    this.head.fill(0)
  }

  private spawn(): void {
    const free: number[] = []
    for (let c = 0; c < this.columns; c++) if (!this.busy[c]) free.push(c)
    const room = Math.ceil(this.columns * 0.75) - this.drops.length
    let budget = Math.min(room, Math.max(1, Math.round(this.columns / 14)), free.length)

    while (budget-- > 0) {
      const queue = this.queues.find(q => q.length > 0)
      if (queue === undefined) return
      const line = queue.shift()!
      let text = line.text
      // Una línea más alta que el panel sigue en otra columna.
      if (text.length > this.rows) {
        queue.unshift({ text: text.slice(this.rows), tint: line.tint })
        text = text.slice(0, this.rows)
      }
      this.history.push({ text, tint: line.tint })
      if (this.history.length > HISTORY) this.history.shift()
      const pick = Math.floor(this.random() * free.length)
      const col = free.splice(pick, 1)[0]!
      const speed = 0.35 + this.random() * 0.55
      const trail = 8 + this.random() * 14
      this.busy[col] = 1
      this.drops.push({
        col,
        text,
        tint: line.tint,
        next: 0,
        row: -1,
        y: -1,
        speed,
        fade: Math.min(400, Math.round((trail / speed) * FADE_SCALE[line.tint])),
        isOpen: false,
      })
    }
  }

  private advance(): void {
    const { columns, rows, glyph, age, fade, tint, head } = this
    const alive: Drop[] = []
    for (const d of this.drops) {
      d.y += d.speed
      while (d.row < Math.floor(d.y) && d.next < d.text.length && d.row < rows - 1) {
        d.row++
        const i = d.row * columns + d.col
        const cp = d.text.codePointAt(d.next)!
        d.next += cp > 0xffff ? 2 : 1
        glyph[i] = cp === 0x20 ? 0 : cp
        age[i] = 0
        fade[i] = d.fade
        tint[i] = TINTS.indexOf(d.tint)
        if (cp !== 0x20) this.lit++
      }
      // Una columna abierta no avanza más allá de lo escrito: espera la próxima tecla.
      if (d.isOpen && d.y > d.row + 1) d.y = d.row + 1
      const isDone = (d.next >= d.text.length && !d.isOpen) || d.row >= rows - 1
      if (isDone) {
        this.busy[d.col] = 0
        if (d === this.typing) this.typing = undefined
        continue
      }
      if (d.row >= 0) head[d.row * columns + d.col] = 1
      alive.push(d)
    }
    this.drops = alive
  }
}
