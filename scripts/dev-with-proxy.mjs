import { spawn } from 'node:child_process'

const node = process.execPath
const children = [
  spawn(node, ['proxy/index.mjs'], { stdio: 'inherit' }),
  spawn(node, ['node_modules/vite/bin/vite.js', '--host'], { stdio: 'inherit' }),
]

let stopping = false

function stop(exitCode = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (!child.killed) child.kill()
  }
  process.exitCode = exitCode
}

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (stopping) return
    const reason = signal ? `signal ${signal}` : `exit code ${code ?? 1}`
    console.error(`[dev] child process stopped (${reason})`)
    stop(code ?? 1)
  })
}

process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
