// Express + WebSocket server — serves the xterm.js frontend and bridges
// WebSocket messages between the browser and PTY sessions.
//
// INTERFACE CONTRACT (do not change exports):
//   startServer({ store, createSession, launchReviewer, port? })
//     Starts on port 3000 by default.
//     WebSocket message protocol:
//       browser → server: { type: 'input',          sessionId, data }
//                         { type: 'start',           agent, workdir, task? }
//                         { type: 'review',          sessionId, reviewerAgent }
//                         { type: 'flag',            sessionId, note }
//                         { type: 'cross-check',     sourceSessionId, reviewerSessionId, agent? }
//                         { type: 'send-to-primary', primarySessionId, reviewerSessionId }
//                         { type: 'volley-start',    sessionId, maxRounds?, focusHint? }
//                         { type: 'volley-stop' }
//                         { type: 'volley-continue', sessionId, extraRounds?, focusHint? }
//       server → browser: { type: 'output',               sessionId, data }
//                         { type: 'diff',                 sessionId, file, patch }
//                         { type: 'ready',                sessionId, role }
//                         { type: 'exit',                 sessionId, code }
//                         { type: 'reviewer-done',        reviewerSessionId, sourceSessionId }
//                         { type: 'volley-round-start',   round, agent, maxRounds }
//                         { type: 'volley-round-complete',round, agent, output }
//                         { type: 'volley-convergence',   message }
//                         { type: 'volley-synthesis-start',mode }
//                         { type: 'volley-done',          rounds, reason, canContinue?, synthOutput? }
//                         { type: 'volley-error',         error, round? }

const path     = require('path')
const http     = require('http')
const crypto   = require('crypto')
const { execSync } = require('child_process')
const express  = require('express')
const { WebSocketServer } = require('ws')
const { loadConfig, isConfigured, getAgentStatus } = require('../config/agent-config')
const logger   = require('../observability/logger')
const { captureException } = require('../observability/errors')

// SQLite is optional — if better-sqlite3 fails (missing native binary, Xcode tools, etc.)
// the app still works; sessions just aren't persisted across restarts.
let listSessions = () => []
let ContextStoreSafe
try {
  listSessions = require('../db/sessions-repo').listSessions
} catch (err) {
  logger.warn({ err: err.message }, 'SQLite unavailable — sessions will not be persisted')
}
try {
  ContextStoreSafe = require('../context/store').ContextStore
} catch (err) {
  logger.warn({ err: err.message }, 'ContextStore unavailable — using memory store')
}

// VolleyManager is loaded lazily inside the handler so a missing module doesn't
// crash the whole server — it degrades gracefully with a volley-error response.
let VolleyManagerSafe
try {
  VolleyManagerSafe = require('../volley/volley-manager').VolleyManager
} catch (err) {
  logger.warn({ err: err.message }, 'VolleyManager unavailable — volley feature disabled')
}

class MemoryStore {
  constructor(sessionId, workdir) {
    this.sessionId = sessionId
    this.workdir   = workdir || process.cwd()
    this.events    = []
  }
  append(type, data) { this.events.push({ type, ts: new Date().toISOString(), ...data }) }
  flag(note)          { this.append('decision', { note }) }
  export()            { return { sessionId: this.sessionId, workdir: this.workdir, events: this.events } }
  buildReviewPrompt(reviewerOutput = null, options = {}) {
    return `# Session: ${this.sessionId}\n(no events persisted)`
  }
  buildSynthesisPrompt(rounds = [], taskPrompt = '') {
    return `# Final Synthesis\nTask: ${taskPrompt || '(none)'}\n(no events persisted — ${rounds.length} round(s) recorded)`
  }
}

function startServer({ store, createSession, launchReviewer, port = 3000 }) {
  const app = express()
  app.use(express.static(path.join(__dirname, 'public')))

  app.use((req, res, next) => {
    const start = Date.now()
    res.on('finish', () => {
      logger.info({ method: req.method, url: req.url, status: res.statusCode, ms: Date.now() - start }, 'request')
    })
    next()
  })

  app.get('/api/sessions/:id/export', (req, res) => {
    const entry  = sessions.get(req.params.id)
    const target = entry && entry.store ? entry.store : store
    try {
      res.json(target.export())
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  app.get('/api/sessions', (req, res) => {
    try {
      res.json(listSessions())
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  app.get('/api/health', (req, res) => {
    const agentStatus = getAgentStatus()
    let sqliteOk = false
    let sqliteError = null
    try {
      require('../db/database').getDb()
      sqliteOk = true
    } catch (err) {
      sqliteError = err.message
    }
    const health = {
      status: (agentStatus.claude.found && sqliteOk) ? 'ok' : 'degraded',
      sqlite: sqliteOk ? 'ok' : `unavailable — ${sqliteError}`,
      agents: agentStatus,
      node:   process.version,
      platform: process.platform,
      instructions: {
        installClaude: 'npm install -g @anthropic-ai/claude-code',
        installCodex:  'npm install -g @openai/codex',
        addOpenAiKey:  'echo "OPENAI_API_KEY=sk-..." >> .env  (then restart the server)',
        fixSqlite:     'xcode-select --install  (macOS — installs native build tools)',
      },
    }
    res.json(health)
  })

  // Debug endpoint — visit /api/debug to see environment info
  app.get('/api/debug', (req, res) => {
    const shell = process.env.SHELL || '/bin/bash'
    const info  = {
      node: process.version,
      platform: process.platform,
      shell,
      cwd:  process.cwd(),
      path: process.env.PATH || '(not set)',
      agents: {},
      shellPath: {},
    }

    for (const agent of ['claude', 'codex']) {
      try {
        const which = execSync(`${shell} -lc "which ${agent}"`, { timeout: 5000 }).toString().trim()
        info.agents[agent] = which || 'not found'
      } catch (_) {
        try {
          const which2 = execSync(`which ${agent}`, { timeout: 3000 }).toString().trim()
          info.agents[agent] = which2 || 'not found'
        } catch (_2) {
          info.agents[agent] = 'not found'
        }
      }
    }

    try {
      info.shellPath.loginPath = execSync(`${shell} -lc "echo $PATH"`, { timeout: 5000 }).toString().trim()
    } catch (_) {
      info.shellPath.loginPath = '(could not resolve)'
    }

    const agentStatus = getAgentStatus()
    info.auth = {
      claude:     agentStatus.claude.found ? 'found' : 'not_found — run: npm install -g @anthropic-ai/claude-code',
      claudePath: agentStatus.claude.path,
      codex:      agentStatus.codex.found ? (agentStatus.codex.apiKey ? 'ready' : 'found_no_key') : 'not_found',
      codexPath:  agentStatus.codex.path,
    }

    res.json(info)
  })

  const server = http.createServer(app)
  const wss    = new WebSocketServer({ server })

  // sessions Map: sessionId → { session, store, agent, workdir }
  const sessions = new Map()

  const safeSend = (ws, msg) => {
    try {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
    } catch (_) {}
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
      const file  = evt && evt.file
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
    // Persists reviewer output after the session entry is deleted from the Map.
    // wireSession's exit handler deletes the session; this Map survives that deletion
    // so cross-check and send-to-primary can still read the captured output.
    const capturedOutputs = new Map()
    // At most one active volley per WebSocket connection
    let activeVolley = null

    ws.on('message', (buf) => {
      let msg
      try { msg = JSON.parse(buf.toString()) } catch (_) { return }
      if (!msg || typeof msg !== 'object') return

      // ── start ────────────────────────────────────────────────────────────
      if (msg.type === 'start') {
        const sessionId  = crypto.randomUUID()
        const agent      = msg.agent || 'claude'
        // Resolve '.' or empty workdir to absolute path so PTY cwd is unambiguous
        const rawWorkdir = msg.workdir && msg.workdir.trim() ? msg.workdir.trim() : process.cwd()
        const workdir    = require('path').resolve(rawWorkdir)

        if (!isConfigured(agent)) {
          const status      = getAgentStatus()
          const agentStatus = status[agent]
          let hint = `\r\n[error] "${agent}" is not ready.\r\n`
          if (agent === 'claude' && !agentStatus.found) {
            hint += `  Claude CLI not found. Install it:\r\n  npm install -g @anthropic-ai/claude-code\r\n`
          } else if (agent === 'codex' && !agentStatus.apiKey) {
            hint += `  OPENAI_API_KEY is not set. Add it to your .env file:\r\n  echo "OPENAI_API_KEY=sk-..." >> .env\r\n`
          } else if (agent === 'codex' && !agentStatus.found) {
            hint += `  Codex CLI not found. Install it:\r\n  npm install -g @openai/codex\r\n`
          }
          hint += `\r\n  Check full status: http://localhost:3000/api/health\r\n`
          safeSend(ws, { type: 'ready', sessionId, agent, workdir, role: 'primary' })
          safeSend(ws, { type: 'output', sessionId, data: hint })
          safeSend(ws, { type: 'exit', sessionId, code: -1 })
          return
        }

        // Create store — fall back to memory store if SQLite/ContextStore unavailable
        let sessionStore
        try {
          if (ContextStoreSafe) {
            sessionStore = typeof store === 'function' ? store(sessionId, workdir) : store
          }
        } catch (err) {
          logger.warn({ err: err.message }, 'ContextStore failed, using memory store')
        }
        if (!sessionStore) sessionStore = new MemoryStore(sessionId, workdir)

        // Persist the user's task description if provided
        if (msg.task && typeof msg.task === 'string' && msg.task.trim()) {
          try { sessionStore.append('task', { prompt: msg.task.trim(), ts: Date.now() }) } catch (_) {}
        }

        let session
        try {
          session = createSession(agent, workdir, sessionId)
        } catch (err) {
          safeSend(ws, { type: 'ready', sessionId, agent, workdir, role: 'primary' })
          safeSend(ws, { type: 'output', sessionId, data: `\r\n[error] ${err.message}\r\n\r\nRun: http://localhost:3000/api/health for a full diagnosis\r\n` })
          safeSend(ws, { type: 'exit', sessionId, code: -1 })
          return
        }
        sessions.set(sessionId, { session, store: sessionStore, agent, workdir })
        ownedSessions.add(sessionId)
        wireSession(ws, sessionId, session, sessionStore)
        safeSend(ws, { type: 'ready', sessionId, agent, workdir, role: 'primary' })
        return
      }

      // ── input ────────────────────────────────────────────────────────────
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

      // ── flag ─────────────────────────────────────────────────────────────
      if (msg.type === 'flag') {
        const entry  = sessions.get(msg.sessionId)
        const target = entry && entry.store ? entry.store : store
        try { target.flag(msg.note) } catch (err) {
          safeSend(ws, { type: 'output', sessionId: msg.sessionId, data: `\r\n[flag error] ${err.message}\r\n` })
        }
        return
      }

      // ── review ───────────────────────────────────────────────────────────
      if (msg.type === 'review') {
        const sourceEntry   = sessions.get(msg.sessionId)
        const sourceStore   = sourceEntry && sourceEntry.store ? sourceEntry.store : store
        const reviewerAgent = msg.reviewerAgent || 'codex'
        const workdir       = (sourceEntry && sourceEntry.workdir) || process.cwd()
        const primaryAgent  = (sourceEntry && sourceEntry.agent) || 'the primary agent'
        const reviewerId    = crypto.randomUUID()
        let reviewer
        try {
          reviewer = launchReviewer(sourceStore, reviewerAgent, workdir, null, null, { primaryAgent })
        } catch (err) {
          safeSend(ws, { type: 'ready', sessionId: reviewerId, agent: reviewerAgent, workdir, role: 'reviewer' })
          safeSend(ws, { type: 'output', sessionId: reviewerId, data: `\r\n[error] ${err.message}\r\n` })
          safeSend(ws, { type: 'exit', sessionId: reviewerId, code: -1 })
          return
        }
        sessions.set(reviewerId, { session: reviewer, store: sourceStore, agent: reviewerAgent, workdir })
        ownedSessions.add(reviewerId)
        // Register BEFORE wireSession so this fires first on exit (EventEmitter fires in
        // registration order). wireSession's exit handler deletes the session from the Map,
        // so we must save capturedOutput to capturedOutputs before that happens.
        reviewer.once('exit', () => {
          capturedOutputs.set(reviewerId, reviewer.capturedOutput || null)
          safeSend(ws, { type: 'reviewer-done', reviewerSessionId: reviewerId, sourceSessionId: msg.sessionId })
        })
        wireSession(ws, reviewerId, reviewer, sourceStore)
        safeSend(ws, { type: 'ready', sessionId: reviewerId, agent: reviewerAgent, workdir, role: 'reviewer', sourceSessionId: msg.sessionId })
        return
      }

      // ── cross-check ──────────────────────────────────────────────────────
      if (msg.type === 'cross-check') {
        const reviewerEntry  = sessions.get(msg.reviewerSessionId)
        const sourceEntry    = sessions.get(msg.sourceSessionId)
        const sourceStore    = sourceEntry && sourceEntry.store ? sourceEntry.store : (reviewerEntry && reviewerEntry.store)
        const reviewerOutput = capturedOutputs.get(msg.reviewerSessionId) || '(reviewer output not captured)'
        const crossAgent     = msg.agent || 'claude'
        const workdir        = (sourceEntry && sourceEntry.workdir) || (reviewerEntry && reviewerEntry.workdir) || process.cwd()
        const primaryAgent   = (sourceEntry && sourceEntry.agent) || 'the primary agent'
        const crossId        = crypto.randomUUID()
        let crossSession
        try {
          crossSession = launchReviewer(sourceStore, crossAgent, workdir, reviewerOutput, null, { primaryAgent })
        } catch (err) {
          safeSend(ws, { type: 'ready', sessionId: crossId, agent: crossAgent, workdir, role: 'cross-check' })
          safeSend(ws, { type: 'output', sessionId: crossId, data: `\r\n[error] ${err.message}\r\n` })
          safeSend(ws, { type: 'exit', sessionId: crossId, code: -1 })
          return
        }
        sessions.set(crossId, { session: crossSession, store: sourceStore, agent: crossAgent, workdir })
        ownedSessions.add(crossId)
        wireSession(ws, crossId, crossSession, sourceStore)
        safeSend(ws, { type: 'ready', sessionId: crossId, agent: crossAgent, workdir, role: 'cross-check', sourceSessionId: msg.sourceSessionId })
        return
      }

      // ── send-to-primary ───────────────────────────────────────────────────
      if (msg.type === 'send-to-primary') {
        const output       = capturedOutputs.get(msg.reviewerSessionId)
        const primaryEntry = sessions.get(msg.primarySessionId)
        if (!output) {
          if (primaryEntry) {
            safeSend(ws, { type: 'output', sessionId: msg.primarySessionId, data: '\r\n[info] No reviewer output available — did the reviewer finish?\r\n' })
          }
          return
        }
        if (!primaryEntry || !primaryEntry.session || typeof primaryEntry.session.write !== 'function') {
          safeSend(ws, { type: 'output', sessionId: msg.primarySessionId, data: '\r\n[info] Primary session not available.\r\n' })
          return
        }
        // Frame and cap the reviewer output before pasting into the live session
        const MAX_PASTE_CHARS = 20000
        const body = output.length > MAX_PASTE_CHARS
          ? '[...truncated...]\n\n' + output.slice(-MAX_PASTE_CHARS)
          : output
        primaryEntry.session.write(`\r\n\r\n=== REVIEWER ANALYSIS ===\r\n${body}\r\n=== END REVIEWER ANALYSIS ===\r\n`)
        return
      }

      // ── volley-start ─────────────────────────────────────────────────────
      if (msg.type === 'volley-start') {
        if (!VolleyManagerSafe) {
          safeSend(ws, { type: 'volley-error', error: 'VolleyManager not available — check server logs' })
          return
        }
        if (activeVolley) {
          safeSend(ws, { type: 'volley-error', error: 'A volley is already running' })
          return
        }
        const sourceEntry = sessions.get(msg.sessionId)
        if (!sourceEntry) {
          safeSend(ws, { type: 'volley-error', error: 'Session not found' })
          return
        }

        // Symmetric role assignment — whoever is in Panel A is the live agent
        const liveAgent     = sourceEntry.agent || 'claude'
        const reviewerAgent = liveAgent === 'claude' ? 'codex' : 'claude'
        const maxRounds     = Number.isInteger(msg.maxRounds) && msg.maxRounds >= 1
          ? Math.min(msg.maxRounds, 20) : 3

        activeVolley = new VolleyManagerSafe({
          liveAgent, reviewerAgent, maxRounds, focusHint: msg.focusHint || '',
        })
        activeVolley.once('done', ({ finalOutput }) => {
          if (finalOutput) capturedOutputs.set('volley-final', finalOutput)
          activeVolley = null
        })
        activeVolley.run(
          sourceEntry.store, sourceEntry.workdir || process.cwd(),
          sourceEntry.session, ws, safeSend
        ).catch(err => {
          logger.error({ err }, 'volley: run() threw unexpectedly')
          safeSend(ws, { type: 'volley-error', error: err.message })
          activeVolley = null
        })
        return
      }

      // ── volley-stop ──────────────────────────────────────────────────────
      if (msg.type === 'volley-stop') {
        if (activeVolley) activeVolley.stop()
        return
      }

      // ── volley-continue ──────────────────────────────────────────────────
      if (msg.type === 'volley-continue') {
        if (!VolleyManagerSafe) {
          safeSend(ws, { type: 'volley-error', error: 'VolleyManager not available' })
          return
        }
        if (activeVolley) {
          safeSend(ws, { type: 'volley-error', error: 'A volley is already running' })
          return
        }
        const sourceEntry = sessions.get(msg.sessionId)
        if (!sourceEntry) {
          safeSend(ws, { type: 'volley-error', error: 'Session not found' })
          return
        }

        // Reconstruct full completedRounds from SQLite so debate history is intact on resume
        let completedRounds = []
        try {
          const allEvents = sourceEntry.store.export().events
          completedRounds = allEvents
            .filter(e => e.type === 'volley-round' && e.role !== 'synthesis')
            .map(e => ({ round: e.round, agent: e.agent, output: e.output || '' }))
        } catch (_) {}

        const prevOutput      = completedRounds.length ? completedRounds[completedRounds.length - 1].output : null
        const startFromRound  = completedRounds.length
        const extraRounds     = Number.isInteger(msg.extraRounds) && msg.extraRounds >= 1
          ? Math.min(msg.extraRounds, 20) : 3

        const liveAgent     = sourceEntry.agent || 'claude'
        const reviewerAgent = liveAgent === 'claude' ? 'codex' : 'claude'

        activeVolley = new VolleyManagerSafe({
          liveAgent, reviewerAgent,
          maxRounds:  startFromRound + extraRounds,
          focusHint:  msg.focusHint || '',
        })
        activeVolley.once('done', ({ finalOutput }) => {
          if (finalOutput) capturedOutputs.set('volley-final', finalOutput)
          activeVolley = null
        })
        activeVolley.run(
          sourceEntry.store, sourceEntry.workdir || process.cwd(),
          sourceEntry.session, ws, safeSend,
          startFromRound, prevOutput, completedRounds
        ).catch(err => {
          logger.error({ err }, 'volley: continue() threw unexpectedly')
          safeSend(ws, { type: 'volley-error', error: err.message })
          activeVolley = null
        })
        return
      }
    })

    ws.on('close', () => {
      // Stop any running volley
      if (activeVolley) { activeVolley.stop(); activeVolley = null }
      // Kill all sessions owned by this connection
      for (const id of ownedSessions) {
        const entry = sessions.get(id)
        if (entry && entry.session && typeof entry.session.kill === 'function') {
          try { entry.session.kill() } catch (_) {}
        }
        sessions.delete(id)
      }
      capturedOutputs.clear()
    })
  })

  app.use((err, req, res, next) => {
    logger.error({ err }, 'unhandled express error')
    captureException(err)
    res.status(500).json({ error: 'Internal server error' })
  })

  server.listen(port, () => {
    logger.info(`ContextBridge listening on http://localhost:${port}`)
    logger.info(`Debug info: http://localhost:${port}/api/debug`)
  })

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${port} is already in use. Kill the existing process or use a different port.`)
      process.exit(1)
    } else {
      logger.error({ err }, 'Server error')
    }
  })

  return server
}

module.exports = { startServer }
