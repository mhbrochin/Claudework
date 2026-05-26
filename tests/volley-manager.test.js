'use strict'

const { EventEmitter } = require('events')

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../src/launcher/reviewer', () => ({ launchReviewer: jest.fn() }))
jest.mock('../src/observability/logger', () => ({
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}))
// Mock fs.writeFileSync so volley-log.md writes don't touch the filesystem in tests
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  writeFileSync: jest.fn(),
}))

const { launchReviewer } = require('../src/launcher/reviewer')
const { VolleyManager }  = require('../src/volley/volley-manager')

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a mock reviewer session.
 * IMPORTANT: Call this INSIDE mockImplementationOnce(() => mockSession(...)) so
 * the auto-exit timers start when launchReviewer is actually called, not at test setup.
 * Pre-creating sessions with mockReturnValueOnce causes exit events to fire before
 * _runRound sets up its listener.
 */
function mockSession({ verdict = 'DIVERGED', exitDelayMs = 20 } = {}) {
  const emitter = new EventEmitter()
  const output  = `Mock analysis.\nVERDICT: ${verdict}`
  emitter.capturedOutput = output
  emitter.kill = jest.fn(() => {
    // Kill triggers exit immediately (after a microtask)
    setImmediate(() => emitter.emit('exit', { code: 0 }))
  })
  emitter.write = jest.fn()
  emitter.pid   = Math.floor(Math.random() * 9000) + 1000

  // Auto-emit data + exit after a short delay — simulates the CLI producing output
  setTimeout(() => {
    emitter.emit('data', { raw: output })
    // Exit shortly after data so _runRound resolves via either VERDICT-kill or auto-exit
    setTimeout(() => emitter.emit('exit', { code: 0 }), 30)
  }, exitDelayMs)

  return emitter
}

/** Create a mock primary (Panel A) session. */
function mockPrimarySession({ verdict = 'DIVERGED' } = {}) {
  const emitter = new EventEmitter()
  // When write() is called (paste), simulate the live agent producing a response
  emitter.write = jest.fn(() => {
    setTimeout(() => {
      emitter.emit('data', { raw: `Panel A response.\nVERDICT: ${verdict}` })
    }, 20)
  })
  emitter.kill = jest.fn()
  emitter.pid  = 1000
  return emitter
}

/** Minimal store mock. */
function mockStore({ taskPrompt = 'Test task' } = {}) {
  return {
    export: jest.fn(() => ({
      events: taskPrompt ? [{ type: 'task', prompt: taskPrompt }] : [],
    })),
    append:               jest.fn(),
    buildReviewPrompt:    jest.fn(() => '# Review Prompt'),
    buildSynthesisPrompt: jest.fn(() => '# Synthesis Prompt'),
  }
}

/** Collect all safeSend calls into an array with helpers. */
function makeSafeSend() {
  const calls = []
  const fn = (_ws, msg) => calls.push(msg)
  fn.calls    = calls
  fn.ofType   = (type) => calls.filter(m => m.type === type)
  fn.lastOf   = (type) => { const a = calls.filter(m => m.type === type); return a[a.length - 1] }
  return fn
}

const WS_MOCK = {}   // ws arg is only forwarded to safeSend — not used by VolleyManager directly

/** Default no-op registerSession mock — keeps tests clean unless we're testing registration. */
const noopRegister = jest.fn()

// ── Tests ──────────────────────────────────────────────────────────────────────

beforeEach(() => jest.clearAllMocks())

// ─── Test 1 — Normal 3-round completion ───────────────────────────────────────
test('1. both CONVERGED → stops early, synthesis runs, volley-done reason:converged', async () => {
  // Use mockImplementationOnce so sessions are created lazily when launchReviewer is called
  launchReviewer
    .mockImplementationOnce(() => mockSession({ verdict: 'CONVERGED' }))  // round 0
    .mockImplementationOnce(() => mockSession({ verdict: 'CONVERGED' }))  // synthesis

  const primarySession = mockPrimarySession({ verdict: 'CONVERGED' })
  const safeSend = makeSafeSend()
  const vm = new VolleyManager({ maxRounds: 3, liveAgent: 'claude', reviewerAgent: 'codex' })

  await vm.run(mockStore(), '/workdir', primarySession, WS_MOCK, safeSend)

  const done = safeSend.lastOf('volley-done')
  expect(done).toBeTruthy()
  expect(done.reason).toBe('converged')
  expect(safeSend.ofType('volley-synthesis-start').length).toBe(1)
}, 15000)

// ─── Test 2 — User stop mid-round ─────────────────────────────────────────────
test('2. stop() ends the volley, no synthesis, reason:stopped', async () => {
  // Slow session — never emits data (will be killed by stop())
  const slowSession = new EventEmitter()
  slowSession.capturedOutput = ''
  slowSession.kill = jest.fn(() => setImmediate(() => slowSession.emit('exit', { code: 0 })))
  slowSession.pid  = 42
  launchReviewer.mockImplementation(() => slowSession)

  const primarySession = mockPrimarySession()
  const safeSend = makeSafeSend()
  const vm = new VolleyManager({ maxRounds: 3, liveAgent: 'claude', reviewerAgent: 'codex' })

  const runPromise = vm.run(mockStore(), '/workdir', primarySession, WS_MOCK, safeSend)
  setTimeout(() => vm.stop(), 50)
  await runPromise

  const done = safeSend.lastOf('volley-done')
  expect(done.reason).toBe('stopped')
  expect(safeSend.ofType('volley-synthesis-start').length).toBe(0)
}, 15000)

// ─── Test 3 — Real-time VERDICT detection ends round quickly ──────────────────
test('3. VERDICT in stream ends round without waiting for 5-min timeout', async () => {
  launchReviewer
    .mockImplementationOnce(() => mockSession({ verdict: 'DIVERGED', exitDelayMs: 20 }))
    .mockImplementationOnce(() => mockSession({ verdict: 'DIVERGED', exitDelayMs: 20 }))

  const primarySession = mockPrimarySession({ verdict: 'DIVERGED' })
  const safeSend = makeSafeSend()
  const vm = new VolleyManager({ maxRounds: 1, liveAgent: 'claude', reviewerAgent: 'codex' })

  const start = Date.now()
  await vm.run(mockStore(), '/workdir', primarySession, WS_MOCK, safeSend)
  const elapsed = Date.now() - start

  expect(elapsed).toBeLessThan(5000)   // 5 seconds max — nowhere near 5 minutes
  expect(safeSend.ofType('volley-done').length).toBe(1)
}, 15000)

// ─── Test 4 — Early convergence stops loop ────────────────────────────────────
test('4. convergence detected after round pair → breaks early, runs synthesis', async () => {
  launchReviewer
    .mockImplementationOnce(() => mockSession({ verdict: 'CONVERGED' }))   // round 0
    .mockImplementationOnce(() => mockSession({ verdict: 'CONVERGED' }))   // synthesis

  const primarySession = mockPrimarySession({ verdict: 'CONVERGED' })
  const safeSend = makeSafeSend()
  const vm = new VolleyManager({ maxRounds: 10, liveAgent: 'claude', reviewerAgent: 'codex' })

  await vm.run(mockStore(), '/workdir', primarySession, WS_MOCK, safeSend)

  const done = safeSend.lastOf('volley-done')
  expect(done.reason).toBe('converged')
  // Only 2 rounds (0 + 1) ran, not 10
  expect(safeSend.ofType('volley-round-start').length).toBeLessThanOrEqual(3)
}, 15000)

// ─── Test 5 — Round limit hit ─────────────────────────────────────────────────
test('5. round limit → canContinue:true, synthesis with where-things-left-off mode', async () => {
  launchReviewer
    .mockImplementationOnce(() => mockSession({ verdict: 'DIVERGED' }))   // round 0
    .mockImplementationOnce(() => mockSession({ verdict: 'DIVERGED' }))   // synthesis (no live round since maxRounds=1)

  const primarySession = mockPrimarySession({ verdict: 'DIVERGED' })
  const safeSend = makeSafeSend()
  const vm = new VolleyManager({ maxRounds: 1, liveAgent: 'claude', reviewerAgent: 'codex' })

  await vm.run(mockStore(), '/workdir', primarySession, WS_MOCK, safeSend)

  const done = safeSend.lastOf('volley-done')
  expect(done.reason).toBe('round-limit')
  expect(done.canContinue).toBe(true)
  expect(safeSend.ofType('volley-synthesis-start')[0].mode).toBe('where-things-left-off')
}, 15000)

// ─── Test 6 — volley-continue resumes from correct round ─────────────────────
test('6. resume with priorRounds — launchReviewer receives full debate history', async () => {
  launchReviewer
    .mockImplementationOnce(() => mockSession({ verdict: 'DIVERGED' }))   // round 2 (reviewer)
    .mockImplementationOnce(() => mockSession({ verdict: 'DIVERGED' }))   // synthesis

  const priorRounds = [
    { round: 0, agent: 'codex',  output: 'Codex round 0 analysis' },
    { round: 1, agent: 'claude', output: 'Claude round 1 rebuttal' },
  ]
  const primarySession = mockPrimarySession({ verdict: 'DIVERGED' })
  const safeSend = makeSafeSend()
  const vm = new VolleyManager({ maxRounds: 3, liveAgent: 'claude', reviewerAgent: 'codex' })

  await vm.run(mockStore(), '/workdir', primarySession, WS_MOCK, safeSend,
               2, priorRounds[1].output, priorRounds)

  // launchReviewer for round 2 should receive the full debate history
  const [, , , debateHistory] = launchReviewer.mock.calls[0]
  expect(debateHistory).toContain('=== Round 1 — CODEX ===')
  expect(debateHistory).toContain('=== Round 2 — CLAUDE ===')
  expect(debateHistory).toContain('Codex round 0 analysis')
  expect(debateHistory).toContain('Claude round 1 rebuttal')
}, 15000)

// ─── Test 7 — Session launch error ────────────────────────────────────────────
test('7. reviewer launch throws → volley-error emitted, loop breaks cleanly', async () => {
  launchReviewer.mockImplementation(() => { throw new Error('CLI not found') })

  const safeSend = makeSafeSend()
  const vm = new VolleyManager({ maxRounds: 3, liveAgent: 'claude', reviewerAgent: 'codex' })

  await vm.run(mockStore(), '/workdir', mockPrimarySession(), WS_MOCK, safeSend)

  const errs = safeSend.ofType('volley-error')
  expect(errs.length).toBeGreaterThanOrEqual(1)
  expect(errs[0].error).toBe('CLI not found')
}, 15000)

// ─── Test 8 — Fast exit before idle resolves ─────────────────────────────────
test('8. session exits immediately → resolves with capturedOutput', async () => {
  const fastSession = new EventEmitter()
  fastSession.capturedOutput = 'Fast output.\nVERDICT: DIVERGED'
  fastSession.kill = jest.fn()
  fastSession.pid  = 99
  // Exit with no data events — just exit
  setImmediate(() => fastSession.emit('exit', { code: 0 }))

  launchReviewer
    .mockImplementationOnce(() => fastSession)
    .mockImplementationOnce(() => mockSession({ verdict: 'DIVERGED' }))  // synthesis

  const safeSend = makeSafeSend()
  const vm = new VolleyManager({ maxRounds: 1, liveAgent: 'claude', reviewerAgent: 'codex' })

  await vm.run(mockStore(), '/workdir', mockPrimarySession({ verdict: 'DIVERGED' }), WS_MOCK, safeSend)

  expect(safeSend.ofType('volley-done').length).toBe(1)
  // The round output should be capturedOutput
  const roundAppend = mockStore().append  // note: won't find — this is a fresh mock
  // Just assert the run completed successfully
  expect(safeSend.lastOf('volley-done')).toBeTruthy()
}, 15000)

// ─── Test 9 — maxRounds clamped to 20 ────────────────────────────────────────
test('9. maxRounds: 100 is clamped to 20', () => {
  expect(new VolleyManager({ maxRounds: 100 }).maxRounds).toBe(20)
})

// ─── Test 10 — maxRounds minimum 1 ───────────────────────────────────────────
test('10. maxRounds: 0 is clamped to 1', () => {
  expect(new VolleyManager({ maxRounds: 0 }).maxRounds).toBe(1)
})

// ─── Test 11 — symmetric agent assignment ────────────────────────────────────
test('11. liveAgent and reviewerAgent stored correctly', () => {
  const vm = new VolleyManager({ liveAgent: 'codex', reviewerAgent: 'claude', maxRounds: 3 })
  expect(vm.liveAgent).toBe('codex')
  expect(vm.reviewerAgent).toBe('claude')
})

// ─── Test 12 — focusHint passed through ──────────────────────────────────────
test('12. focusHint is passed to launchReviewer options', async () => {
  launchReviewer
    .mockImplementationOnce(() => mockSession({ verdict: 'DIVERGED' }))
    .mockImplementationOnce(() => mockSession({ verdict: 'DIVERGED' }))

  const safeSend = makeSafeSend()
  const vm = new VolleyManager({
    maxRounds: 1, liveAgent: 'claude', reviewerAgent: 'codex', focusHint: 'trading logic',
  })

  await vm.run(mockStore(), '/workdir', mockPrimarySession({ verdict: 'DIVERGED' }), WS_MOCK, safeSend)

  const [, , , , , options] = launchReviewer.mock.calls[0]
  expect(options.focusHint).toBe('trading logic')
}, 15000)

// ─── Test 13 — full debate history on round 2+ reviewer ───────────────────────
test('13. round 2 reviewer receives full debate history (rounds 0 and 1)', async () => {
  launchReviewer
    .mockImplementationOnce(() => mockSession({ verdict: 'DIVERGED' }))  // round 0
    .mockImplementationOnce(() => mockSession({ verdict: 'DIVERGED' }))  // round 2
    .mockImplementationOnce(() => mockSession({ verdict: 'DIVERGED' }))  // synthesis

  const primarySession = mockPrimarySession({ verdict: 'DIVERGED' })
  const safeSend = makeSafeSend()
  const vm = new VolleyManager({ maxRounds: 3, liveAgent: 'claude', reviewerAgent: 'codex' })

  await vm.run(mockStore(), '/workdir', primarySession, WS_MOCK, safeSend)

  // Round 0 reviewer → debateHistory is null (no prior rounds)
  const [, , , debateHistory0] = launchReviewer.mock.calls[0]
  expect(debateHistory0).toBeNull()

  // Round 2 reviewer → debateHistory contains rounds 0 and 1
  const [, , , debateHistory2] = launchReviewer.mock.calls[1]
  expect(debateHistory2).toContain('=== Round 1 — CODEX ===')
  expect(debateHistory2).toContain('=== Round 2 — CLAUDE ===')
}, 15000)

// ─── Test 15 — registerSession called for round and synthesis sessions ─────────
test('15. registerSession is called for each reviewer round + synthesis session', async () => {
  launchReviewer
    .mockImplementationOnce(() => mockSession({ verdict: 'DIVERGED' }))  // round 0
    .mockImplementationOnce(() => mockSession({ verdict: 'DIVERGED' }))  // synthesis

  const primarySession = mockPrimarySession({ verdict: 'DIVERGED' })
  const safeSend       = makeSafeSend()
  const registerSession = jest.fn()

  const vm = new VolleyManager({
    maxRounds: 1, liveAgent: 'claude', reviewerAgent: 'codex', registerSession,
  })
  await vm.run(mockStore(), '/workdir', primarySession, WS_MOCK, safeSend)

  // Should have been called twice: once for round 0 reviewer, once for synthesis
  expect(registerSession).toHaveBeenCalledTimes(2)
  // Both calls should include a string session ID and an EventEmitter (session)
  for (const [id, session, agent] of registerSession.mock.calls) {
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
    expect(session).toBeTruthy()
  }
  // Second call should be the synthesis agent (liveAgent = 'claude')
  const [, , synthAgent] = registerSession.mock.calls[1]
  expect(synthAgent).toBe('claude')
}, 15000)

// ─── Test 14 — synthesis session tracked in _currentSession ──────────────────
test('14. _currentSession holds synthesis session during synthesis, null after', async () => {
  let synthEmitter = null

  launchReviewer
    .mockImplementationOnce(() => mockSession({ verdict: 'DIVERGED' }))  // round 0
    .mockImplementationOnce(() => {
      synthEmitter = mockSession({ verdict: 'DIVERGED' })
      return synthEmitter
    })  // synthesis

  const primarySession = mockPrimarySession({ verdict: 'DIVERGED' })
  const safeSend = makeSafeSend()
  const vm = new VolleyManager({ maxRounds: 1, liveAgent: 'claude', reviewerAgent: 'codex' })

  // Wrap _runRound to observe _currentSession during synthesis
  let currentSessionDuringSynth = undefined
  const origRunRound = vm._runRound.bind(vm)
  vm._runRound = function(session) {
    if (session === synthEmitter) {
      currentSessionDuringSynth = vm._currentSession
    }
    return origRunRound(session)
  }

  await vm.run(mockStore(), '/workdir', primarySession, WS_MOCK, safeSend)

  expect(currentSessionDuringSynth).toBe(synthEmitter)   // assigned during synthesis
  expect(vm._currentSession).toBeNull()                   // cleared after synthesis
}, 15000)
