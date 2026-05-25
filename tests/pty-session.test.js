'use strict'

const { EventEmitter } = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')

// --- module-level mocks (hoisted before any require of the module under test) ---

jest.mock('node-pty', () => ({
  spawn: jest.fn(() => ({
    onData: jest.fn(),
    onExit: jest.fn(),
    write: jest.fn(),
    resize: jest.fn(),
    kill: jest.fn(),
    pid: 1234,
  })),
}))

jest.mock('chokidar', () => ({
  watch: jest.fn(() => ({
    on: jest.fn().mockReturnThis(),
    close: jest.fn(),
  })),
}))

// simple-git is used for diff capturing; mock it to avoid real git calls.
jest.mock('simple-git', () =>
  jest.fn(() => ({
    diff: jest.fn(() => Promise.resolve('')),
    raw: jest.fn(() => Promise.resolve('')),
  }))
)

const pty = require('node-pty')
const { createSession } = require('../src/capture/pty-session')

// Helper: create a real temp directory that passes fs.accessSync checks.
let tempDir
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-test-'))
  // Reset the spawn mock so each test gets a fresh mock PTY.
  pty.spawn.mockClear()
  pty.spawn.mockImplementation(() => ({
    onData: jest.fn(),
    onExit: jest.fn(),
    write: jest.fn(),
    resize: jest.fn(),
    kill: jest.fn(),
    pid: 1234,
  }))
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('createSession()', () => {
  test('throws if workdir does not exist', () => {
    expect(() =>
      createSession('claude', '/nonexistent/path/xyz', 'sid-bad')
    ).toThrow(/Workdir not accessible/)
  })

  test('returns an EventEmitter', () => {
    const session = createSession('claude', tempDir, 'sid-001')
    expect(session).toBeInstanceOf(EventEmitter)
  })

  test('returned session has write, resize, and kill methods', () => {
    const session = createSession('claude', tempDir, 'sid-002')
    expect(typeof session.write).toBe('function')
    expect(typeof session.resize).toBe('function')
    expect(typeof session.kill).toBe('function')
  })

  test('emits "data" event when pty onData fires', (done) => {
    let capturedOnData
    pty.spawn.mockImplementationOnce(() => ({
      onData: jest.fn((cb) => { capturedOnData = cb }),
      onExit: jest.fn(),
      write: jest.fn(),
      resize: jest.fn(),
      kill: jest.fn(),
      pid: 1234,
    }))

    const session = createSession('claude', tempDir, 'sid-003')

    session.on('data', (evt) => {
      expect(evt).toMatchObject({ raw: 'hello output' })
      done()
    })

    // Simulate the pty producing output.
    capturedOnData('hello output')
  })

  test('emits "exit" event when pty onExit fires', (done) => {
    let capturedOnExit
    pty.spawn.mockImplementationOnce(() => ({
      onData: jest.fn(),
      onExit: jest.fn((cb) => { capturedOnExit = cb }),
      write: jest.fn(),
      resize: jest.fn(),
      kill: jest.fn(),
      pid: 1234,
    }))

    const session = createSession('claude', tempDir, 'sid-004')

    session.on('exit', (evt) => {
      expect(evt).toEqual({ code: 0 })
      done()
    })

    // Simulate the pty exiting.
    capturedOnExit({ exitCode: 0 })
  })

  test('exposes the pty pid on the session', () => {
    pty.spawn.mockImplementationOnce(() => ({
      onData: jest.fn(),
      onExit: jest.fn(),
      write: jest.fn(),
      resize: jest.fn(),
      kill: jest.fn(),
      pid: 5678,
    }))
    const session = createSession('claude', tempDir, 'sid-005')
    expect(session.pid).toBe(5678)
  })
})
