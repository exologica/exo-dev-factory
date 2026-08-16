#!/usr/bin/env node
// Smoke test: boots the built server and asserts the core trace API contract
// (201/200/404/400) over real HTTP. Requires `pnpm build` to have run first.
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const port = 8799
const baseUrl = `http://127.0.0.1:${port}`
const serverEntry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist/server/server/index.js'
)

const child = spawn(process.execPath, [serverEntry], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe']
})

let stderr = ''
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString()
})

const results = []
let failed = false

function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed = true
}

async function waitForServer() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${baseUrl}/api/traces`)
      if (res.status === 200) return true
    } catch {
      // not up yet
    }
    await delay(100)
  }
  return false
}

async function main() {
  try {
    if (!(await waitForServer())) {
      check('server started', false, 'did not become ready')
      return
    }
    check('server started', true)

    const post = await fetch(`${baseUrl}/api/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'smoke',
        startTime: '2026-08-16T10:00:00.000Z',
        endTime: '2026-08-16T10:00:01.000Z',
        spans: [
          {
            id: 'span-1',
            name: 'parse',
            startTime: '2026-08-16T10:00:00.000Z',
            endTime: '2026-08-16T10:00:00.500Z',
            status: 'ok'
          }
        ]
      })
    })
    const created = await post.json()
    check('POST /api/traces returns 201', post.status === 201, `got ${post.status}`)
    check('POST /api/traces returns id', typeof created.id === 'string', JSON.stringify(created))

    const list = await fetch(`${baseUrl}/api/traces`)
    check('GET /api/traces returns 200', list.status === 200, `got ${list.status}`)

    const byId = await fetch(`${baseUrl}/api/traces/${created.id}`)
    check('GET /api/traces/:id returns 200', byId.status === 200, `got ${byId.status}`)

    const missing = await fetch(`${baseUrl}/api/traces/no-such-id`)
    check('GET /api/traces/:id returns 404 for unknown', missing.status === 404, `got ${missing.status}`)

    const badJson = await fetch(`${baseUrl}/api/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops'
    })
    check('POST invalid JSON returns 400', badJson.status === 400, `got ${badJson.status}`)
  } finally {
    child.kill('SIGTERM')
    await delay(50)
  }
  if (failed) {
    console.error(`SMOKE FAILED\n${results.join('\n')}\n--- server stderr ---\n${stderr}`)
    process.exitCode = 1
  } else {
    console.log(`SMOKE PASSED\n${results.join('\n')}`)
  }
}

main()
