'use strict'

// Regression tests for two volley bugs the existing suite misses because it
// uses verdictCooldownMs=0 and emits VERDICT in one atomic chunk.
//
// Production failure modes these reproduce:
//
//   BUG A — "Rounds end too fast / empty output"
//     The verdict-cooldown flag (verdictEnabled) gates whether we RUN the regex,
//     but it does NOT reset the rolling tailBuf. The PTY echoes the injected
//     prompt at ~t=2s as one or more large chunks with internal \n preserved.
//     Those chunks land in tailBuf during the cooldown window. The moment a
//     real model byte arrives after cooldown — even a single "thinking..." pulse
//     — the regex fires against the echo-contaminated buffer and ends the round.
//     Production symptom: round 0 completes in ~3.6s with no real analysis.
//
//   BUG B — "Round doesn't advance after AI produces real VERDICT"
//     stripAnsi() in volley-manager ends with .trim() — correct for the final
//     output event, fatal for the per-chunk tailBuf update. Per-chunk .trim()
//     strips the trailing \n of every chunk, so a real verdict that arrives as
//     "Analysis.\n" + "VERDICT: CONVERGED\n" becomes "...Analysis.VERDICT: CONVERGED"
//     in the tail buffer. The "(?:^|\n)\s*VERDICT:" regex never matches. With
//     real CLIs (which don't exit after a verdict), the only escape is the
//     5-minute idle timeout.
//
// Both tests use REAL default cooldown values, spread chunks across time so a
// false-positive cuts off real content, and (for BUG B) omit the exit event so
// the bug cannot mask itself via the exit path.

const { EventEmitter } = require('events')

jest.mock('../src/launcher/reviewer', () => ({ launchReviewer: jest.fn() }))
jest.mock('../src/observability/logger', () => ({
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}))
jest.mock('fs', () => ({ ...jest.requireActual('fs'), writeFileSync: jest.fn() }))

const { launchReviewer } = require('../src/launcher/reviewer')
const { VolleyManager }  = require('../src/volley/volley-manager')

// resetAllMocks — NOT clearAllMocks — so mockImplementationOnce queues don't bleed.
beforeEach(() => jest.resetAllMocks())

function makeSafeSend() {
  const calls = []
  const fn = (_ws, msg) => calls.push(msg)
  fn.calls  = calls
  fn.ofType = (type) => calls.filter(m => m.type === type)
  fn.lastOf = (type) => { const a = calls.filter(m => m.type === type); return a[a.length - 1] }
  return fn
}

function mockStore() {
  return {
    export: jest.fn(() => ({ events: [{ type: 'task', prompt: 'Test task' }] })),
    append: jest.fn(),
    buildReviewPrompt: jest.fn(() => '# Review Prompt'),
    buildSynthesisPrompt: jest.fn(() => '# Synthesis Prompt'),
  }
}

const WS_MOCK = {}
const ECHO_BLOB =
  '# Session Review\n' +
  '## Review Instructions\n' +
  '1. Read the workdir code\n' +
  '7. End with: VERDICT: CONVERGED (you agree) or VERDICT: DIVERGED (you disagree)\n' +
  'VERDICT: CONVERGED\n' +
  'VERDICT: DIVERGED\n'

// ── BUG A reproducer ──────────────────────────────────────────────────────────
// Reviewer session that:
//   t=200ms  emits the echo blob (with internal \nVERDICT lines) — during cooldown
//   t=4000ms emits a tiny innocuous "thinking..." pulse — AFTER 3500ms cooldown
//   t=8000ms emits the REAL analysis + real verdict
//   t=8500ms emits exit
// If the bug is present, the t=4000ms pulse trips the regex against the echo-
// contaminated tailBuf → setTimeout(finish, 500) settles at ~4500ms with NO real
// content captured.
function bugAReviewer({ realVerdict = 'DIVERGED' } = {}) {
  const e = new EventEmitter()
  e.kill = jest.fn(() => setImmediate(() => e.emit('exit', { code: 0 })))
  e.write = jest.fn(); e.pid = Math.floor(Math.random() * 9000) + 1000
  e.capturedOutput = ''
  setTimeout(() => e.emit('data', { raw: ECHO_BLOB }), 200)
  setTimeout(() => e.emit('data', { raw: '.' }), 4000)                       // benign pulse post-cooldown
  setTimeout(() => {
    e.emit('data', { raw: 'Analyzing the codebase now.\n' })
    e.emit('data', { raw: 'The architecture is thoughtful and modular.\n' })
    e.emit('data', { raw: `VERDICT: ${realVerdict}\n` })
  }, 8000)
  setTimeout(() => e.emit('exit', { code: 0 }), 8500)
  return e
}

// Trivial synthesis session — settles quickly via capturedOutput + exit.
function trivialSynth() {
  const e = new EventEmitter()
  e.kill = jest.fn(() => setImmediate(() => e.emit('exit', { code: 0 })))
  e.write = jest.fn(); e.pid = 999
  e.capturedOutput = 'Synth complete.\nVERDICT: CONVERGED'
  setTimeout(() => {
    e.emit('data', { raw: e.capturedOutput })
    setTimeout(() => e.emit('exit', { code: 0 }), 50)
  }, 100)
  return e
}

// ── BUG B reproducer ──────────────────────────────────────────────────────────
// Reviewer that emits a real VERDICT split across two chunks at the line break:
//   t=4000ms  "Analysis complete.\n"
//   t=4100ms  "VERDICT: CONVERGED\n"
//   NEVER emits exit (mirrors a CLI that idles after answering — the only escape
//   is verdict-detection, not session exit).
// Per-chunk .trim() drops the \n at end of chunk 1, so tailBuf becomes
// "...complete.VERDICT: CONVERGED" — no \n before VERDICT — and the regex misses.
// Without the fix, the only resolution is the 5-min idle timeout → test fails.
function bugBReviewer({ realVerdict = 'CONVERGED' } = {}) {
  const e = new EventEmitter()
  e.kill = jest.fn()   // intentionally does NOT emit exit
  e.write = jest.fn(); e.pid = 5555
  e.capturedOutput = ''
  setTimeout(() => e.emit('data', { raw: 'Analysis complete.\n' }), 4000)
  setTimeout(() => e.emit('data', { raw: `VERDICT: ${realVerdict}\n` }), 4100)
  return e
}

// Same shape but with VERDICT split MID-WORD, which exercises the rolling-tail
// concatenation across chunk boundaries.
function bugBSplitWordReviewer() {
  const e = new EventEmitter()
  e.kill = jest.fn()
  e.write = jest.fn(); e.pid = 6666
  e.capturedOutput = ''
  setTimeout(() => e.emit('data', { raw: 'Analysis done.\nVERD' }), 4000)
  setTimeout(() => e.emit('data', { raw: 'ICT: DIVERGED\n' }), 4100)
  return e
}

// Live (Panel A) session for the BUG B live-round path: paste echo immediately
// after write(), then real verdict split across chunks, NEVER emits exit.
function bugBLivePrimary({ realVerdict = 'CONVERGED' } = {}) {
  const e = new EventEmitter()
  e.pid = 1000
  e.kill = jest.fn()
  e.write = jest.fn(() => {
    setTimeout(() => e.emit('data', { raw:
      '=== REVIEW FROM CODEX ===\n' +
      'feedback...\n' +
      '=== END REVIEW ===\n' +
      'End with: VERDICT: CONVERGED or: VERDICT: DIVERGED\n',
    }), 50)
    setTimeout(() => e.emit('data', { raw: 'I agree with the points raised.\n' }), 2500)
    setTimeout(() => e.emit('data', { raw: `VERDICT: ${realVerdict}\n` }),         2600)
    // No exit — primary stays alive.
  })
  return e
}

// ─── BUG A — false positive on cooldown buffer must not chop the round ───────
test('A: echo VERDICT during cooldown does not cause early round end on next byte',
async () => {
  launchReviewer
    .mockImplementationOnce(() => bugAReviewer({ realVerdict: 'DIVERGED' })) // round 0
    .mockImplementationOnce(() => trivialSynth())                            // synthesis

  // We just need round 0 to complete — pass a primary that won't get called
  // (maxRounds=1 means no live round before synthesis).
  const noopPrimary = new EventEmitter()
  noopPrimary.write = jest.fn(); noopPrimary.kill = jest.fn(); noopPrimary.pid = 1

  const safeSend = makeSafeSend()
  const vm = new VolleyManager({ maxRounds: 1, liveAgent: 'claude', reviewerAgent: 'codex' })

  await vm.run(mockStore(), '/workdir', noopPrimary, WS_MOCK, safeSend)

  const round0 = safeSend.ofType('volley-round-complete')[0]
  expect(round0).toBeTruthy()
  // STRICT: the round must have captured the LATE real content. If the cooldown
  // bug is present, settle fires at ~4500ms (cooldown 3500 + grace 500 + pulse
  // at t=4000), well before the t=8000 real chunks arrive.
  expect(round0.output).toMatch(/architecture is thoughtful|Analyzing the codebase/)
}, 30000)

// ─── BUG B — multi-chunk VERDICT must be detected without exit ───────────────
test('B: real VERDICT split at line break is detected when CLI does not exit',
async () => {
  launchReviewer
    .mockImplementationOnce(() => bugBReviewer({ realVerdict: 'CONVERGED' }))
    .mockImplementationOnce(() => trivialSynth())

  const noopPrimary = new EventEmitter()
  noopPrimary.write = jest.fn(); noopPrimary.kill = jest.fn(); noopPrimary.pid = 1

  const safeSend = makeSafeSend()
  const vm = new VolleyManager({ maxRounds: 1, liveAgent: 'claude', reviewerAgent: 'codex' })

  const start = Date.now()
  await vm.run(mockStore(), '/workdir', noopPrimary, WS_MOCK, safeSend)
  const elapsed = Date.now() - start

  // Must NOT hit the 5-min idle timeout. Round 0 should resolve within a few
  // seconds of the verdict arriving (~4100ms + 500ms grace + synthesis ~150ms).
  expect(elapsed).toBeLessThan(15000)
  expect(safeSend.lastOf('volley-done')).toBeTruthy()
}, 30000)

// ─── BUG B-2 — VERDICT split mid-token across chunk boundary ─────────────────
test('B-2: VERDICT split mid-word across chunks is detected without exit',
async () => {
  launchReviewer
    .mockImplementationOnce(() => bugBSplitWordReviewer())
    .mockImplementationOnce(() => trivialSynth())

  const noopPrimary = new EventEmitter()
  noopPrimary.write = jest.fn(); noopPrimary.kill = jest.fn(); noopPrimary.pid = 1

  const safeSend = makeSafeSend()
  const vm = new VolleyManager({ maxRounds: 1, liveAgent: 'claude', reviewerAgent: 'codex' })

  const start = Date.now()
  await vm.run(mockStore(), '/workdir', noopPrimary, WS_MOCK, safeSend)
  expect(Date.now() - start).toBeLessThan(15000)
  expect(safeSend.lastOf('volley-done')).toBeTruthy()
}, 30000)

// ─── BUG B (live path) — Panel A VERDICT split across chunks must advance ─────
test('B-live: Panel A VERDICT split across chunks advances to synthesis',
async () => {
  launchReviewer
    .mockImplementationOnce(() => bugAReviewer({ realVerdict: 'DIVERGED' }))  // round 0
    .mockImplementationOnce(() => trivialSynth())                              // synthesis

  const primarySession = bugBLivePrimary({ realVerdict: 'CONVERGED' })
  const safeSend = makeSafeSend()
  const vm = new VolleyManager({ maxRounds: 2, liveAgent: 'claude', reviewerAgent: 'codex' })

  const start = Date.now()
  await vm.run(mockStore(), '/workdir', primarySession, WS_MOCK, safeSend)
  const elapsed = Date.now() - start

  // Total: round0 (~8.5s) + round1 live (~3s) + synth (~150ms) ≈ 12s. With the
  // BUG B live-round bug present, round1 cannot end except via the 5-min idle
  // timeout — the test would exceed its 30s budget.
  expect(elapsed).toBeLessThan(30000)
  expect(safeSend.ofType('volley-synthesis-start').length).toBe(1)
}, 45000)
