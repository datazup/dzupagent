/**
 * Simple terminal output utilities.
 *
 * Avoids ESM-only dependencies (chalk, ora) that cause issues
 * with Yarn v1 workspaces. Uses ANSI escape codes directly.
 */

const isColorSupported =
  process.env['NO_COLOR'] === undefined &&
  process.env['FORCE_COLOR'] !== '0' &&
  (process.stdout.isTTY ?? false)

function colorize(code: string, text: string): string {
  return isColorSupported ? `\x1b[${code}m${text}\x1b[0m` : text
}

export const colors = {
  bold: (text: string): string => colorize('1', text),
  dim: (text: string): string => colorize('2', text),
  red: (text: string): string => colorize('31', text),
  green: (text: string): string => colorize('32', text),
  yellow: (text: string): string => colorize('33', text),
  cyan: (text: string): string => colorize('36', text),
} as const

/**
 * Simple spinner for terminal progress indication.
 */
export class Spinner {
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  private interval: ReturnType<typeof setInterval> | null = null
  private frameIndex = 0
  private currentText = ''

  start(text: string): void {
    this.currentText = text
    this.frameIndex = 0

    if (!isColorSupported || !process.stdout.isTTY) {
      process.stdout.write(`  ${text}\n`)
      return
    }

    this.interval = setInterval(() => {
      const frame = this.frames[this.frameIndex % this.frames.length]
      process.stdout.write(`\r  ${colors.cyan(frame ?? '')} ${this.currentText}`)
      this.frameIndex++
    }, 80)
  }

  succeed(text?: string): void {
    this.stop()
    const msg = text ?? this.currentText
    process.stdout.write(`\r  ${colors.green('✓')} ${msg}\n`)
  }

  fail(text?: string): void {
    this.stop()
    const msg = text ?? this.currentText
    process.stdout.write(`\r  ${colors.red('✗')} ${msg}\n`)
  }

  private stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
    if (isColorSupported && process.stdout.isTTY) {
      process.stdout.write('\r\x1b[K') // clear line
    }
  }
}
