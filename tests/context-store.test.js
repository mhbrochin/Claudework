'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

// ContextStore writes sessions/{sessionId}.json relative to process.cwd().
// We redirect cwd() inside each test so the files land in a temp directory
// and never pollute the repo.
let originalCwd
let tempDir

// The module caches require, but ContextStore reads process.cwd() at
// construction time, so we can manipulate it between tests without
// re-requiring the module.
const { ContextStore } = require('../src/context/store')

beforeEach(() => {
  originalCwd = process.cwd()
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-store-test-'))
  // Redirect process.cwd() so the sessions/ dir lands in our temp dir.
  jest.spyOn(process, 'cwd').mockReturnValue(tempDir)
})

afterEach(() => {
  process.cwd.mockRestore()
  // Remove the temp directory and everything inside it.
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('ContextStore constructor', () => {
  test('creates a JSON file at sessions/{sessionId}.json', () => {
    const store = new ContextStore('sess-001', '/some/workdir')
    const filePath = path.join(tempDir, 'sessions', 'sess-001.json')
    expect(fs.existsSync(filePath)).toBe(true)
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.sessionId).toBe('sess-001')
    expect(Array.isArray(parsed.events)).toBe(true)
  })

  test('stores sessionId and workdir on the instance', () => {
    const store = new ContextStore('sess-002', '/my/workdir')
    expect(store.sessionId).toBe('sess-002')
    expect(store.workdir).toBe('/my/workdir')
  })
})

describe('ContextStore.append()', () => {
  test('adds an event that appears in export()', () => {
    const store = new ContextStore('sess-003', '/wd')
    store.append('output', 'hello from the process')
    const exported = store.export()
    expect(exported.events).toHaveLength(1)
    expect(exported.events[0].type).toBe('output')
    expect(exported.events[0].data).toBe('hello from the process')
  })

  test('returns the appended event object', () => {
    const store = new ContextStore('sess-004', '/wd')
    const event = store.append('input', 'ls -la')
    expect(event).toMatchObject({ type: 'input', data: 'ls -la' })
    expect(typeof event.timestamp).toBe('string')
  })

  test('accumulates multiple events in order', () => {
    const store = new ContextStore('sess-005', '/wd')
    store.append('input', 'cmd1')
    store.append('output', 'result1')
    store.append('diff', { file: 'foo.js', patch: '+line' })
    const { events } = store.export()
    expect(events).toHaveLength(3)
    expect(events.map(e => e.type)).toEqual(['input', 'output', 'diff'])
  })
})

describe('ContextStore.flag()', () => {
  test('adds a decision event with the provided note', () => {
    const store = new ContextStore('sess-006', '/wd')
    store.flag('chose approach A because B')
    const { events } = store.export()
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('decision')
    expect(events[0].data).toEqual({ note: 'chose approach A because B' })
  })
})

describe('ContextStore.export()', () => {
  test('returns an object with sessionId and events array', () => {
    const store = new ContextStore('sess-007', '/workdir')
    const exported = store.export()
    expect(exported).toHaveProperty('sessionId', 'sess-007')
    expect(Array.isArray(exported.events)).toBe(true)
  })

  test('returns a copy of the events array (not the internal reference)', () => {
    const store = new ContextStore('sess-008', '/wd')
    store.append('input', 'x')
    const exp1 = store.export()
    exp1.events.push({ type: 'fake' })
    const exp2 = store.export()
    // The internal array must not have been mutated by the caller.
    expect(exp2.events).toHaveLength(1)
  })
})

describe('ContextStore.buildReviewPrompt()', () => {
  test('returns a string containing the session ID', () => {
    const store = new ContextStore('sess-009', '/wd')
    const prompt = store.buildReviewPrompt()
    expect(typeof prompt).toBe('string')
    expect(prompt).toContain('sess-009')
  })

  test('includes flagged decision notes in the prompt', () => {
    const store = new ContextStore('sess-010', '/wd')
    store.flag('important architectural decision')
    const prompt = store.buildReviewPrompt()
    expect(prompt).toContain('important architectural decision')
  })

  test('mentions "No decisions flagged" when no flags exist', () => {
    const store = new ContextStore('sess-011', '/wd')
    const prompt = store.buildReviewPrompt()
    expect(prompt).toContain('No decisions flagged')
  })
})
