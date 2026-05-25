'use strict'

// Integration test — spins up a real startServer with mock PTY sessions and
// asserts the correct sequence of WebSocket messages from end to end.
// No real CLI processes are spawned.

const http         = require('http')
const { EventEmitter } = require('events')
const WebSocket    = require('ws')

// ── Mock PTY and SQLite layers ─────────────────────────────────────────────────

jest.mock('../src/db/sessions-repo', () => ({
  createSession: jest.fn(),
  appendEvent:   jest.fn(),
  getSession:    jest.fn(() => ({})),
  getEvents:     jest.fn(() => []),
  listSessions:  jest.fn(() => []),
}))

jest.mock('../src/db/database', () => ({
  getDb: jest.fn(() => ({})),
}))

jest.mock('../src/observability/logger', () => ({
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}))

jest.mock('../src/observability/errors', () => ({
  captureException: jest.fn(),
}))

jest.mock('../src/config/agent-config', () => ({
  loadConfig:    jest.fn(() => ({})),
  isConfigured:  jest.fn(() => true),
  getAgentStatus: jest.fn(() => ({
    claude: { found: true, path: '/usr/bin/claude' },
    codex:  { found: true, path: '/usr/bin/codex', apiKey: 'key' },
  })),
}))

// Mock node-pty so no real PTY is spawned.
// Use require() inside the factory (not an outer variable) to satisfy Jest's scope rules.
jest.mock('node-pty', () => ({
  spawn: jest.fn(() => {
    const { EventEmitter: MockEE } = require('events')
    const e = new MockEE()
    e.onData = (cb) => e.on('_data', cb)
    e.onExit = (cb) => e.on('_exit', cb)
    e.write  = jest.fn()
    e.kill   = jest.fn(() => {
      const { EventEmitter: _EE } = require('events')
      e.emit('_exit', { exitCode: 0 })
    })
    e.resize = jest.fn()
    e.pid    = 12345
    // Auto-emit a VERDICT so volley rounds end quickly
    setTimeout(() => {
      e.emit('_data', 'Mock reviewer output.\nVERDICT: CONVERGED')
      setTimeout(() => e.emit('_exit', { exitCode: 0 }), 20)
    }, 50)
    return e
  }),
}))

// ── Server setup ───────────────────────────────────────────────────────────────

const { startServer } = require('../src/ui/server')
const { ContextStore } = require('../src/context/store')
const { createSession: createPtySession } = require('../src/capture/pty-session')
const { launchReviewer } = require('../src/launcher/reviewer')

// Mock chokidar used inside pty-session.js
jest.mock('chokidar', () => ({
  watch: jest.fn(() => ({
    on: jest.fn().mockReturnThis(),
    close: jest.fn(),
  })),
}))

// Mock simple-git used inside pty-session.js
jest.mock('simple-git', () => jest.fn(() => ({
  diff: jest.fn(() => Promise.resolve('')),
  raw:  jest.fn(() => Promise.resolve('')),
})))

// Mock fs.accessSync to allow any workdir
jest.mock('fs', () => {
  const realFs = jest.requireActual('fs')
  return { ...realFs, accessSync: jest.fn() }
})

let server
let port

beforeAll((done) => {
  server = startServer({
    store: (sessionId, workdir) => new ContextStore(sessionId, workdir),
    createSession: createPtySession,
    launchReviewer,
    port: 0,   // OS assigns a free port
  })
  server.once('listening', () => {
    port = server.address().port
    done()
  })
})

afterAll((done) => {
  server.close(done)
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function connectWS() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.once('open',  () => resolve(ws))
    ws.once('error', reject)
  })
}

function recv(ws, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('recv timeout')), timeoutMs)
    const handler = (data) => {
      let msg
      try { msg = JSON.parse(data) } catch (_) { return }
      if (predicate(msg)) {
        clearTimeout(t)
        ws.removeListener('message', handler)
        resolve(msg)
      }
    }
    ws.on('message', handler)
  })
}

function collectMsgs(ws, untilPredicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const msgs = []
    const t = setTimeout(() => resolve(msgs), timeoutMs)  // resolve with what we have
    const handler = (data) => {
      let msg
      try { msg = JSON.parse(data) } catch (_) { return }
      msgs.push(msg)
      if (untilPredicate(msg)) {
        clearTimeout(t)
        ws.removeListener('message', handler)
        resolve(msgs)
      }
    }
    ws.on('message', handler)
  })
}

function send(ws, msg) {
  ws.send(JSON.stringify(msg))
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test('1. start → ready with role:primary + sessionId assigned by server', async () => {
  const ws = await connectWS()
  try {
    send(ws, { type: 'start', agent: 'claude', workdir: process.cwd() })
    const ready = await recv(ws, m => m.type === 'ready' && m.role === 'primary')
    expect(ready.sessionId).toBeTruthy()
    expect(ready.agent).toBe('claude')
    expect(typeof ready.sessionId).toBe('string')
  } finally {
    ws.close()
  }
}, 15000)

test('2. start with task → task stored (appendEvent called with type:task)', async () => {
  const { appendEvent } = require('../src/db/sessions-repo')
  appendEvent.mockClear()

  const ws = await connectWS()
  try {
    send(ws, { type: 'start', agent: 'claude', workdir: process.cwd(), task: 'Build a Kalshi bot' })
    await recv(ws, m => m.type === 'ready' && m.role === 'primary')
    const taskCall = appendEvent.mock.calls.find(c => c[1] === 'task')
    expect(taskCall).toBeTruthy()
    expect(taskCall[3].prompt).toBe('Build a Kalshi bot')
  } finally {
    ws.close()
  }
}, 15000)

test('3. review → ready with role:reviewer for Panel B', async () => {
  const ws = await connectWS()
  try {
    send(ws, { type: 'start', agent: 'claude', workdir: process.cwd() })
    const primary = await recv(ws, m => m.type === 'ready' && m.role === 'primary')
    send(ws, { type: 'review', sessionId: primary.sessionId, reviewerAgent: 'codex' })
    const reviewer = await recv(ws, m => m.type === 'ready' && m.role === 'reviewer')
    expect(reviewer.agent).toBe('codex')
    expect(reviewer.sourceSessionId).toBe(primary.sessionId)
  } finally {
    ws.close()
  }
}, 15000)

test('4. volley-start without an active session → volley-error', async () => {
  const ws = await connectWS()
  try {
    send(ws, { type: 'volley-start', sessionId: 'nonexistent-id', maxRounds: 1 })
    const err = await recv(ws, m => m.type === 'volley-error')
    expect(err.error).toBeTruthy()
  } finally {
    ws.close()
  }
}, 10000)

test('5. volley-start while one already running → volley-error', async () => {
  const ws = await connectWS()
  try {
    // Start a session first
    send(ws, { type: 'start', agent: 'claude', workdir: process.cwd() })
    const primary = await recv(ws, m => m.type === 'ready' && m.role === 'primary')

    // Start first volley
    send(ws, { type: 'volley-start', sessionId: primary.sessionId, maxRounds: 3 })
    await recv(ws, m => m.type === 'volley-round-start')

    // Try to start another — should get an error
    send(ws, { type: 'volley-start', sessionId: primary.sessionId, maxRounds: 1 })
    const err = await recv(ws, m => m.type === 'volley-error')
    expect(err.error).toMatch(/already running/i)

    // Stop the first volley so cleanup happens
    send(ws, { type: 'volley-stop' })
  } finally {
    ws.close()
  }
}, 15000)

test('6. volley-stop sends volley-done with reason:stopped', async () => {
  const ws = await connectWS()
  try {
    send(ws, { type: 'start', agent: 'claude', workdir: process.cwd() })
    const primary = await recv(ws, m => m.type === 'ready' && m.role === 'primary')

    send(ws, { type: 'volley-start', sessionId: primary.sessionId, maxRounds: 10 })
    // Wait for first round to start
    await recv(ws, m => m.type === 'volley-round-start')
    // Stop immediately
    send(ws, { type: 'volley-stop' })

    const done = await recv(ws, m => m.type === 'volley-done')
    expect(done.reason).toBe('stopped')
  } finally {
    ws.close()
  }
}, 15000)

test('7. 1-round volley produces round-start → synthesis-start → volley-done', async () => {
  // maxRounds: 1 → only reviewer round 0 (no live Panel A turn).
  // The mocked PTY auto-emits VERDICT after 50ms and exits at 70ms.
  // _runRound detects VERDICT, kills session (already dead), resolves via exit.
  // Synthesis PTY follows the same pattern.
  // Total expected: ~1.5s (two rounds × ~600ms each).
  const ws = await connectWS()
  try {
    send(ws, { type: 'start', agent: 'claude', workdir: process.cwd() })
    const primary = await recv(ws, m => m.type === 'ready' && m.role === 'primary')

    send(ws, { type: 'volley-start', sessionId: primary.sessionId, maxRounds: 1 })

    const msgs = await collectMsgs(ws, m => m.type === 'volley-done', 15000)
    const roundStarts  = msgs.filter(m => m.type === 'volley-round-start')
    const synthStart   = msgs.find(m => m.type === 'volley-synthesis-start')
    const done         = msgs.find(m => m.type === 'volley-done')

    expect(roundStarts.length).toBeGreaterThanOrEqual(1)
    expect(synthStart).toBeTruthy()
    expect(done).toBeTruthy()
    // maxRounds:1 with DIVERGED → round-limit; if somehow CONVERGED → converged
    expect(['converged', 'round-limit']).toContain(done.reason)
  } finally {
    ws.close()
  }
}, 20000)

test('8. /api/health returns ok or degraded', async () => {
  const res  = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${port}/api/health`, resolve)
  })
  let body = ''
  await new Promise(resolve => { res.on('data', d => { body += d }); res.on('end', resolve) })
  const json = JSON.parse(body)
  expect(['ok', 'degraded']).toContain(json.status)
  expect(json.agents).toHaveProperty('claude')
  expect(json.agents).toHaveProperty('codex')
})
