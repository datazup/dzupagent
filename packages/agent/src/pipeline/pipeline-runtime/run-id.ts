let runCounter = 0

export function generateRunId(): string {
  runCounter++
  return `run_${Date.now()}_${runCounter}`
}
