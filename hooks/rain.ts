// La simulación de la lluvia: columnas de texto real que caen y se apagan.
// No sabe nada del engine: recibe líneas, avanza un fotograma y empaqueta
// las celdas en el formato de un Raster.

export type Tint = 'green' | 'red'

// Prioridad de las fuentes: la lluvia siempre toma primero de la más alta.
export const EDIT = 0
export const TEST = 1
export const READ = 2
export const THOUGHT = 3
export type Source = typeof EDIT | typeof TEST | typeof READ | typeof THOUGHT

const QUEUE_CAP = [400, 400, 300, 120]

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
}

// Fondo negro propio, como en la película, no el de la terminal.
const BG = 0x000000

// Rampas de color de la estela: del recién escrito (0) al apagado (1).
const GREEN_HEAD = 0xf0fff2
const GREEN_TRAIL: Array<[number, number]> = [
  [0.0, 0xb4ffc2],
  [0.06, 0x5cff82],
  [0.16, 0x14f24a],
  [0.35, 0x00c832],
  [0.6, 0x008c1e],
  [0.82, 0x00480e],
  [1.0, 0x001805],
]
const RED_HEAD = 0xfff0f0
const RED_TRAIL: Array<[number, number]> = [
  [0.0, 0xffb8b8],
  [0.06, 0xff6a6a],
  [0.16, 0xff2a2a],
  [0.35, 0xd81818],
  [0.6, 0x9a0e0e],
  [0.82, 0x500606],
  [1.0, 0x1a0202],
]

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

const TRAILS = { green: ramp(GREEN_TRAIL), red: ramp(RED_TRAIL) }
const HEADS = { green: GREEN_HEAD, red: RED_HEAD }

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

function clean(raw: string): string {
  let out = ''
  for (const ch of raw.replace(/\s+/g, ' ').trim()) {
    const cp = ch.codePointAt(0)!
    if (cp === 0x20 || isNarrow(cp)) out += ch
  }
  return out
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
  private red = new Uint8Array(0)
  private head = new Uint8Array(0)
  private words = new Uint32Array(0)
  private drops: Drop[] = []
  private busy = new Uint8Array(0)
  private queues: Line[][] = [[], [], [], []]
  private lit = 0

  constructor(private random: () => number = Math.random) {}

  resize(columns: number, rows: number): void {
    if (columns === this.columns && rows === this.rows) return
    this.columns = columns
    this.rows = rows
    const n = columns * rows
    this.glyph = new Uint32Array(n)
    this.age = new Uint16Array(n)
    this.fade = new Uint16Array(n)
    this.red = new Uint8Array(n)
    this.head = new Uint8Array(n)
    this.words = new Uint32Array(n * 3)
    this.busy = new Uint8Array(columns)
    this.drops = []
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

  // Sin columnas cayendo, sin estela y sin nada en cola: la pantalla está negra.
  get isIdle(): boolean {
    return this.drops.length === 0 && this.lit === 0 && this.queues.every(q => q.length === 0)
  }

  step(): void {
    if (this.columns === 0 || this.rows === 0) return
    this.ageCells()
    this.spawn()
    this.advance()
  }

  // Las celdas del fotograma actual, en el formato de `RasterProps.cells`.
  cells(): string {
    const { glyph, age, fade, red, head, words } = this
    for (let i = 0, w = 0; i < glyph.length; i++, w += 3) {
      const cp = glyph[i]!
      words[w] = cp === 0 ? 0x20 : cp
      words[w + 2] = BG
      if (cp === 0) {
        words[w + 1] = BG
      } else if (head[i]) {
        words[w + 1] = red[i] ? HEADS.red : HEADS.green
      } else {
        const t = Math.min(STEPS, Math.round((age[i]! / fade[i]!) * STEPS))
        words[w + 1] = (red[i] ? TRAILS.red : TRAILS.green)[t]!
      }
    }
    return toBase64(new Uint8Array(words.buffer))
  }

  private ageCells(): void {
    const { glyph, age, fade } = this
    let lit = 0
    for (let i = 0; i < glyph.length; i++) {
      if (glyph[i] === 0) continue
      if (++age[i]! > fade[i]!) glyph[i] = 0
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
        fade: Math.min(400, Math.round(trail / speed)),
      })
    }
  }

  private advance(): void {
    const { columns, rows, glyph, age, fade, red, head } = this
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
        red[i] = d.tint === 'red' ? 1 : 0
        if (cp !== 0x20) this.lit++
      }
      const isDone = d.next >= d.text.length || d.row >= rows - 1
      if (isDone) {
        this.busy[d.col] = 0
        continue
      }
      if (d.row >= 0) head[d.row * columns + d.col] = 1
      alive.push(d)
    }
    this.drops = alive
  }
}
