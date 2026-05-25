'use strict'

// Mock the SQLite persistence layer so tests run without a native binary
jest.mock('../src/db/sessions-repo', () => ({
  createSession: jest.fn(),
  appendEvent:   jest.fn(),
  getSession:    jest.fn(() => ({})),
  getEvents:     jest.fn(() => []),
}))

const { createSession, appendEvent, getSession, getEvents } = require('../src/db/sessions-repo')
const { ContextStore } = require('../src/context/store')

beforeEach(() => {
  jest.clearAllMocks()
})

// ── Constructor ────────────────────────────────────────────────────────────────

describe('ContextStore constructor', () => {
  test('stores sessionId and workdir', () => {
    const store = new ContextStore('s1', '/my/workdir')
    expect(store.sessionId).toBe('s1')
    expect(store.workdir).toBe('/my/workdir')
  })

  test('calls createSession on construction', () => {
    new ContextStore('s2', '/wd')
    expect(createSession).toHaveBeenCalledWith('s2', '/wd', null, expect.any(String))
  })

  test('defaults workdir to process.cwd() when omitted', () => {
    const store = new ContextStore('s3')
    expect(store.workdir).toBe(process.cwd())
  })
})

// ── append / flag ──────────────────────────────────────────────────────────────

describe('ContextStore.append()', () => {
  test('delegates to appendEvent with correct args', () => {
    const store = new ContextStore('s4', '/wd')
    store.append('output', { raw: 'hello' })
    expect(appendEvent).toHaveBeenCalledWith('s4', 'output', expect.any(String), { raw: 'hello' })
  })

  test('accumulates multiple events', () => {
    const store = new ContextStore('s5', '/wd')
    store.append('input', { raw: 'cmd1' })
    store.append('output', { raw: 'out1' })
    expect(appendEvent).toHaveBeenCalledTimes(2)
  })
})

describe('ContextStore.flag()', () => {
  test('calls append with type decision and note', () => {
    const store = new ContextStore('s6', '/wd')
    store.flag('chose approach A')
    expect(appendEvent).toHaveBeenCalledWith('s6', 'decision', expect.any(String), { note: 'chose approach A' })
  })
})

// ── export ─────────────────────────────────────────────────────────────────────

describe('ContextStore.export()', () => {
  test('returns sessionId and events', () => {
    getEvents.mockReturnValue([{ type: 'output', raw: 'hi' }])
    const store   = new ContextStore('s7', '/wd')
    const exported = store.export()
    expect(exported.sessionId).toBe('s7')
    expect(Array.isArray(exported.events)).toBe(true)
    expect(exported.events[0].type).toBe('output')
  })
})

// ── buildReviewPrompt ──────────────────────────────────────────────────────────

describe('ContextStore.buildReviewPrompt()', () => {
  test('returns a non-empty string', () => {
    const store  = new ContextStore('s8', '/wd')
    const prompt = store.buildReviewPrompt()
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(0)
  })

  test('includes flagged decision notes', () => {
    getEvents.mockReturnValue([{ type: 'decision', note: 'important decision' }])
    const store  = new ContextStore('s9', '/wd')
    const prompt = store.buildReviewPrompt()
    expect(prompt).toContain('important decision')
  })

  test('includes task prompt when task event exists', () => {
    getEvents.mockReturnValue([{ type: 'task', prompt: 'Review this app for security' }])
    const store  = new ContextStore('s10', '/wd')
    const prompt = store.buildReviewPrompt()
    expect(prompt).toContain('Review this app for security')
    expect(prompt).toContain('## Task')
  })

  test('uses primaryAgent name from options in section headers', () => {
    const store  = new ContextStore('s11', '/wd')
    const prompt = store.buildReviewPrompt(null, { primaryAgent: 'codex' })
    expect(prompt).toContain("codex's Full Session Output")
    expect(prompt).toContain("follow codex's reasoning")
  })

  test('defaults to "the primary agent" when no primaryAgent option given', () => {
    const store  = new ContextStore('s12', '/wd')
    const prompt = store.buildReviewPrompt()
    expect(prompt).toContain('the primary agent')
  })

  test('includes focusHint when provided in options', () => {
    const store  = new ContextStore('s13', '/wd')
    const prompt = store.buildReviewPrompt(null, { focusHint: 'security vulnerabilities' })
    expect(prompt).toContain('security vulnerabilities')
  })

  test('includes session commands when input events exist', () => {
    getEvents.mockReturnValue([
      { type: 'input', raw: 'npm test\r' },
      { type: 'input', raw: 'git diff\r' },
    ])
    const store  = new ContextStore('s14', '/wd')
    const prompt = store.buildReviewPrompt()
    expect(prompt).toContain('## Session Commands')
    expect(prompt).toContain('npm test')
    expect(prompt).toContain('git diff')
  })

  test('deduplicates consecutive identical commands', () => {
    getEvents.mockReturnValue([
      { type: 'input', raw: 'ls\r' },
      { type: 'input', raw: 'ls\r' },
      { type: 'input', raw: 'ls\r' },
    ])
    const store  = new ContextStore('s15', '/wd')
    const prompt = store.buildReviewPrompt()
    // Should appear only once
    const count = (prompt.match(/^ls$/mg) || []).length
    expect(count).toBe(1)
  })

  test('labels single prior reviewer output as "Prior Reviewer Analysis"', () => {
    const store  = new ContextStore('s16', '/wd')
    const prompt = store.buildReviewPrompt('Some reviewer thoughts here')
    expect(prompt).toContain('## Prior Reviewer Analysis')
    expect(prompt).not.toContain('## Debate History So Far')
  })

  test('labels volley debate history as "Debate History So Far"', () => {
    const store       = new ContextStore('s17', '/wd')
    const debateHistory = '=== Round 1 — CODEX ===\nCodex analysis here\n\n=== Round 2 — CLAUDE ===\nClaude rebuttal here'
    const prompt = store.buildReviewPrompt(debateHistory)
    expect(prompt).toContain('## Debate History So Far')
    expect(prompt).not.toContain('## Prior Reviewer Analysis')
  })

  test('includes VERDICT instruction in review instructions', () => {
    const store  = new ContextStore('s18', '/wd')
    const prompt = store.buildReviewPrompt()
    expect(prompt).toContain('VERDICT: CONVERGED or VERDICT: DIVERGED')
  })

  test('includes diffs in prompt', () => {
    getEvents.mockReturnValue([{ type: 'diff', file: 'src/server.js', patch: '+added line' }])
    const store  = new ContextStore('s19', '/wd')
    const prompt = store.buildReviewPrompt()
    expect(prompt).toContain('src/server.js')
    expect(prompt).toContain('+added line')
  })

  test('strips ANSI from output events', () => {
    getEvents.mockReturnValue([{ type: 'output', raw: '\x1b[32mGreen text\x1b[0m' }])
    const store  = new ContextStore('s20', '/wd')
    const prompt = store.buildReviewPrompt()
    expect(prompt).toContain('Green text')
    expect(prompt).not.toContain('\x1b[32m')
  })

  test('truncates very long output to MAX_OUTPUT_CHARS', () => {
    const longOutput = 'x'.repeat(50000)
    getEvents.mockReturnValue([{ type: 'output', raw: longOutput }])
    const store  = new ContextStore('s21', '/wd')
    const prompt = store.buildReviewPrompt()
    expect(prompt).toContain('[...earlier output truncated...]')
  })
})

// ── buildSynthesisPrompt ───────────────────────────────────────────────────────

describe('ContextStore.buildSynthesisPrompt()', () => {
  test('returns a non-empty string', () => {
    const store  = new ContextStore('s22', '/wd')
    const prompt = store.buildSynthesisPrompt([], '')
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(0)
  })

  test('includes task prompt when provided', () => {
    const store  = new ContextStore('s23', '/wd')
    const prompt = store.buildSynthesisPrompt([], 'Build a trading bot')
    expect(prompt).toContain('Build a trading bot')
  })

  test('includes each round with its agent name', () => {
    const store  = new ContextStore('s24', '/wd')
    const rounds = [
      { agent: 'codex', output: 'Codex review output' },
      { agent: 'claude', output: 'Claude rebuttal output' },
    ]
    const prompt = store.buildSynthesisPrompt(rounds, '')
    expect(prompt).toContain('## Round 1 — CODEX')
    expect(prompt).toContain('## Round 2 — CLAUDE')
    expect(prompt).toContain('Codex review output')
    expect(prompt).toContain('Claude rebuttal output')
  })

  test('truncates long round outputs to 8000 chars', () => {
    const store  = new ContextStore('s25', '/wd')
    const rounds = [{ agent: 'codex', output: 'y'.repeat(10000) }]
    const prompt = store.buildSynthesisPrompt(rounds, '')
    expect(prompt).toContain('[...truncated...]')
  })

  test('includes synthesis instructions', () => {
    const store  = new ContextStore('s26', '/wd')
    const prompt = store.buildSynthesisPrompt([], '')
    expect(prompt).toContain('## Synthesis Instructions')
    expect(prompt).toContain('Top 3 action items')
  })

  test('correctly counts rounds in header', () => {
    const store  = new ContextStore('s27', '/wd')
    const rounds = Array(5).fill({ agent: 'codex', output: 'output' })
    const prompt = store.buildSynthesisPrompt(rounds, '')
    expect(prompt).toContain('5-round exchange')
  })
})
