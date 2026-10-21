// De dónde sale el texto que cae y qué nunca debe caer.

import type { Tint } from './rain.ts'

// Archivos cuyo contenido no se muestra nunca, ni siquiera enmascarado.
const SECRET_FILE =
  /(^|[\/\s'"])(\.env[^\/\s'"]*|\.bashrc|\.zshrc|\.profile|\.netrc|\.npmrc|\.pypirc|\.pgpass|credentials[^\/\s'"]*|[^\/\s'"]*\.(pem|key|p12|pfx|jks|keystore)|id_(rsa|ed25519|ecdsa|dsa)[^\/\s'"]*)(?=$|[\s'";|&)])/i

// `API_KEY=...`, `password: ...`, `Authorization: Bearer ...`
const SECRET_ASSIGN =
  /\b([A-Za-z0-9_.-]*(api[_-]?key|access[_-]?key|private[_-]?key|token|secret|passw(or)?d|pwd|credential|authorization)[A-Za-z0-9_.-]*)(["']?\s*[=:]\s*)(bearer\s+|basic\s+)?("[^"]*"|'[^']*'|\S+)/gi

// Cadenas opacas largas con letras y dígitos: tokens, hashes, firmas, JWT.
const OPAQUE = /[A-Za-z0-9+\/_\-.=]{24,}/g

export function touchesSecrets(text: string): boolean {
  return SECRET_FILE.test(text)
}

export function mask(text: string): string {
  return text
    .replace(SECRET_ASSIGN, (_all, name: string, _word, _or, sep: string, scheme = '') =>
      `${name}${sep}${scheme}****`,
    )
    .replace(OPAQUE, token =>
      /\d/.test(token) && /[A-Za-z]/.test(token) && !/^[\w.\/-]+\.[a-z]{1,5}$/i.test(token)
        ? '****'
        : token,
    )
}

// Lo que el modelo agregó en un Edit: las líneas nuevas que no estaban antes.
export function addedLines(before: string, after: string): string {
  const old = new Set(before.split('\n').map(line => line.trim()))
  return after
    .split('\n')
    .filter(line => !old.has(line.trim()))
    .join('\n')
}

const TEST_COMMAND = new RegExp(
  [
    String.raw`\b(\.\/)?(mvnw?|gradlew?)\b[^|;&]*\b(test|verify|check)\b`,
    String.raw`\b(flutter|dart|deno|bun)\s+test\b`,
    String.raw`\b(npm|pnpm|yarn)\s+(run\s+)?test`,
    String.raw`\b(jest|vitest|pytest|mocha|karma|phpunit|rspec)\b`,
    String.raw`\bgo\s+test\b`,
    String.raw`\bcargo\s+(test|nextest)\b`,
    String.raw`\bclaude\s+plugin\s+test\b`,
  ].join('|'),
)

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command)
}

// Una línea de salida de un runner de tests que habla de un fallo. Cubre
// JUnit/Surefire, Gradle, flutter/dart test, Jest/Vitest, pytest, go y cargo.
const FAILED =
  /\b(FAIL(ED|URE|S)?|ERROR(S)?|panicked)\b|^\s*\(fail\)|\[E\]|✗|✕|✘|×|AssertionError|Assertion failed|Expected:|Received:|Tests? failed|Some tests failed|\b(Failures|Errors):\s*[1-9]|\b[1-9]\d* (fail|failed|failing)\b/

const PASSING_SUMMARY = /\b(Failures|Errors):\s*0\b.*\b(Failures|Errors):\s*0\b/

export function testTint(line: string): Tint {
  return FAILED.test(line) && !PASSING_SUMMARY.test(line) ? 'red' : 'green'
}

// Corta un flujo de texto en líneas a medida que llega.
export class LineSplitter {
  private pending = new Map<number, string>()

  constructor(
    private emit: (line: string) => void,
    private width = 60,
  ) {}

  push(index: number, text: string): void {
    let buffer = (this.pending.get(index) ?? '') + text
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) this.emit(line)
    while (buffer.length > this.width) {
      const cut = buffer.lastIndexOf(' ', this.width)
      const at = cut > this.width / 2 ? cut : this.width
      this.emit(buffer.slice(0, at))
      buffer = buffer.slice(at)
    }
    this.pending.set(index, buffer)
  }

  flush(): void {
    for (const rest of this.pending.values()) this.emit(rest)
    this.pending.clear()
  }
}
