'use strict'

const request = require('supertest')
const http = require('http')
const { EventEmitter } = require('events')
const { startServer } = require('../src/ui/server')

// Build a fresh mock session (EventEmitter with PTY-like methods).
function mockSession() {
  const e = new EventEmitter()
  e.write = jest.fn()
  e.kill = jest.fn()
  e.pid = 9999
  return e
}

// Build a fresh mock store object.
function mockStore() {
  return {
    append: jest.fn(),
    flag: jest.fn(),
    export: jest.fn(() => ({ sessionId: 'test', events: [] })),
    buildReviewPrompt: jest.fn(() => ''),
  }
}

// Allocate a unique high-numbered port for each test by letting the OS pick
// one (listen on 0), then close that server and reuse the port immediately.
// This avoids conflicts between parallel test files.
async function getFreePort() {
  return new Promise((resolve, reject) => {
    const tmp = http.createServer()
    tmp.listen(0, () => {
      const { port } = tmp.address()
      tmp.close(() => resolve(port))
    })
    tmp.on('error', reject)
  })
}

let server
let port
let store
let createSession
let launchReviewer

beforeEach(async () => {
  port = await getFreePort()
  store = mockStore()
  createSession = jest.fn(() => mockSession())
  launchReviewer = jest.fn(() => mockSession())
  server = startServer({ store, createSession, launchReviewer, port })
  // Wait for the server to be fully listening.
  await new Promise((resolve) => {
    if (server.listening) return resolve()
    server.once('listening', resolve)
  })
})

afterEach((done) => {
  server.close(done)
})

describe('GET /api/debug', () => {
  test('returns 200 with node, platform, shell, and agents fields', async () => {
    const res = await request(server).get('/api/debug')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('node')
    expect(res.body).toHaveProperty('platform')
    expect(res.body).toHaveProperty('shell')
    expect(res.body).toHaveProperty('agents')
  })

  test('node field matches the running Node.js version', async () => {
    const res = await request(server).get('/api/debug')
    expect(res.body.node).toBe(process.version)
  })
})

describe('GET /api/sessions/:id/export', () => {
  test('calls store.export() for an unknown session id and returns JSON', async () => {
    const res = await request(server).get('/api/sessions/nonexistent/export')
    // The server falls through to the top-level store when the session is
    // not found in its internal map.
    expect(res.status).toBe(200)
    expect(store.export).toHaveBeenCalled()
    expect(res.body).toMatchObject({ sessionId: 'test', events: [] })
  })

  test('returns JSON content-type', async () => {
    const res = await request(server).get('/api/sessions/nonexistent/export')
    expect(res.headers['content-type']).toMatch(/application\/json/)
  })
})
