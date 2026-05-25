// Express + WebSocket server — serves the xterm.js frontend and bridges
// WebSocket messages between the browser and PTY sessions.
//
// INTERFACE CONTRACT (do not change exports):
//   startServer({ store, createSession, launchReviewer, port? })
//     Starts on port 3000 by default.
//     WebSocket message protocol:
//       browser → server: { type: 'input', sessionId, data }
//                         { type: 'start', agent, workdir }
//                         { type: 'review', sessionId, reviewerAgent }
//                         { type: 'flag', sessionId, note }
//       server → browser: { type: 'output', sessionId, data }
//                         { type: 'diff',   sessionId, file, patch }
//                         { type: 'ready',  sessionId }
//                         { type: 'exit',   sessionId, code }

const path = require('path')
const http = require('http')
const crypto = require('crypto')
const express = require('express')
const { WebSocketServer } = require('ws')

function startServer({ store, createSession, launchReviewer, port = 3000 }) {
  const app = express()
  app.use(express.static(path.join(__dirname, 'public')))

  app.get('/api/sessions/:id/export', (req, res) => {
    const entry = sessions.get(req.params.id)
    const target = entry && entry.store ? entry.store : store
    try {
      res.json(target.export())
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  const server = http.createServer(app)
  const wss = new WebSocketServer({ server })

  const sessions = new Map()

  const safeSend = (ws, msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }

  const wireSession = (ws, sessionId, session, sessionStore) => {
    session.on('data', (evt) => {
      const raw = evt && evt.raw !== undefined ? evt.raw : evt
      if (sessionStore && typeof sessionStore.append === 'function') {
        try { sessionStore.append('output', { ts: Date.now(), raw }) } catch (_) {}
      }
      safeSend(ws, { type: 'output', sessionId, data: raw })
    })
    session.on('diff', (evt) => {
      const file = evt && evt.file
      const patch = evt && evt.patch
      if (sessionStore && typeof sessionStore.append === 'function') {
        try { sessionStore.append('diff', { ts: Date.now(), file, patch }) } catch (_) {}
      }
      safeSend(ws, { type: 'diff', sessionId, file, patch })
    })
    session.on('exit', (evt) => {
      const code = evt && evt.code !== undefined ? evt.code : evt
      safeSend(ws, { type: 'exit', sessionId, code })
      sessions.delete(sessionId)
    })
  }

  wss.on('connection', (ws) => {
    const ownedSessions = new Set()

    ws.on('message', (buf) => {
      let msg
      try { msg = JSON.parse(buf.toString()) } catch (_) { return }
      if (!msg || typeof msg !== 'object') return

      if (msg.type === 'start') {
        const sessionId = crypto.randomUUID()
        const agent = msg.agent || 'claude'
        const workdir = msg.workdir || process.cwd()
        let session, sessionStore
        try {
          sessionStore = typeof store === 'function' ? store(sessionId, workdir) : store
          session = createSession(agent, workdir, sessionId)
        } catch (err) {
          safeSend(ws, { type: 'exit', sessionId, code: -1 })
          safeSend(ws, { type: 'output', sessionId, data: `\r\n[error] ${err.message}\r\n` })
          return
        }
        sessions.set(sessionId, { session, store: sessionStore, agent, workdir })
        ownedSessions.add(sessionId)
        wireSession(ws, sessionId, session, sessionStore)
        safeSend(ws, { type: 'ready', sessionId, agent, workdir, role: 'primary' })
        return
      }

      if (msg.type === 'input') {
        const entry = sessions.get(msg.sessionId)
        if (entry && entry.session && typeof entry.session.write === 'function') {
          entry.session.write(msg.data)
        }
        if (entry && entry.store && typeof entry.store.append === 'function') {
          try { entry.store.append('input', { ts: Date.now(), raw: msg.data }) } catch (_) {}
        }
        return
      }

      if (msg.type === 'flag') {
        const entry = sessions.get(msg.sessionId)
        const target = entry && entry.store ? entry.store : store
        try { target.flag(msg.note) } catch (err) {
          safeSend(ws, { type: 'output', sessionId: msg.sessionId, data: `\r\n[flag error] ${err.message}\r\n` })
        }
        return
      }

      if (msg.type === 'review') {
        const sourceEntry = sessions.get(msg.sessionId)
        const sourceStore = sourceEntry && sourceEntry.store ? sourceEntry.store : store
        const reviewerAgent = msg.reviewerAgent || 'codex'
        const workdir = (sourceEntry && sourceEntry.workdir) || process.cwd()
        const reviewerId = crypto.randomUUID()
        let reviewer
        try {
          reviewer = launchReviewer(sourceStore, reviewerAgent, workdir)
        } catch (err) {
          safeSend(ws, { type: 'exit', sessionId: reviewerId, code: -1 })
          safeSend(ws, { type: 'output', sessionId: reviewerId, data: `\r\n[error] ${err.message}\r\n` })
          return
        }
        sessions.set(reviewerId, { session: reviewer, store: sourceStore, agent: reviewerAgent, workdir })
        ownedSessions.add(reviewerId)
        wireSession(ws, reviewerId, reviewer, sourceStore)
        safeSend(ws, { type: 'ready', sessionId: reviewerId, agent: reviewerAgent, workdir, role: 'reviewer', sourceSessionId: msg.sessionId })
        return
      }
    })

    ws.on('close', () => {
      for (const id of ownedSessions) {
        const entry = sessions.get(id)
        if (entry && entry.session && typeof entry.session.kill === 'function') {
          try { entry.session.kill() } catch (_) {}
        }
        sessions.delete(id)
      }
    })
  })

  server.listen(port, () => {
    console.log(`ContextBridge UI listening on http://localhost:${port}`)
  })

  return server
}

module.exports = { startServer }
