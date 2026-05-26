'use strict'
// Volley manager — orchestrates automated AI-vs-AI debates.
//
// INTERFACE CONTRACT (do not change exports):
//   new VolleyManager({ maxRounds, liveAgent, reviewerAgent, focusHint })
//     .run(store, workdir, primarySession, ws, safeSend, startFromRound?, prevOutput?, priorRounds?)
//       → Promise<void>  — resolves when debate + synthesis complete or user stops
//     .stop()            — gracefully stop the current volley
//
// Round flow:
//   Even rounds (0, 2, 4…) → fresh reviewer session (reviewerAgent)
//   Odd rounds  (1, 3, 5…) → paste into live Panel A session (liveAgent)
//   After all rounds       → fresh synthesis session (liveAgent)
//
// End-of-round detection:
//   Tier 1 (primary): real-time VERDICT scan — ends round immediately
//   Tier 2 (fallback): 5-minute silence timeout

const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const { launchReviewer } = require('../launcher/reviewer')
const logger = require('../observability/logger')

const IDLE_TIMEOUT_MS = 5 * 60 * 1000   // 5 minutes — fallback only
const HARD_MAX_ROUNDS = 20
// VERDICT_RE: require start-of-line so inline examples in the review prompt
// ("...end with: VERDICT: CONVERGED or: VERDICT: DIVERGED") do NOT match,
// but the AI's actual standalone verdict line ("VERDICT: CONVERGED\n") does.
const VERDICT_RE      = /(?:^|\n)\s*VERDICT:\s*(CONVERGED|DIVERGED)/i

class VolleyManager extends EventEmitter {
  constructor({ maxRounds = 3, liveAgent = 'claude', reviewerAgent = 'codex', focusHint = '',
                cols, rows, registerSession,
                verdictCooldownMs = 3500, liveCooldownMs = 1500 } = {}) {
    super()
    this.maxRounds     = Math.min(Math.max(1, maxRounds), HARD_MAX_ROUNDS)
    this.liveAgent     = liveAgent       // the agent in Panel A (participates live)
    this.reviewerAgent = reviewerAgent   // the fresh-session reviewer
    this.focusHint     = focusHint
    // Terminal dimensions — passed to launchReviewer so reviewer PTYs spawn at the right size.
    // When provided (from browser), initial output renders correctly without waiting for resize.
    this.cols          = cols
    this.rows          = rows
    // registerSession(id, session, agent) — called after each round/synthesis session is launched.
    // server.js uses this to insert the session into the sessions Map so resize messages work
    // and the 60-second grace-kill applies to volley sessions too.
    this.registerSession = typeof registerSession === 'function' ? registerSession : () => {}
    // verdictCooldownMs: how long to suppress VERDICT scanning after a reviewer session starts.
    // Prevents false positives from the PTY echo of the injected prompt (which itself contains
    // the VERDICT instruction examples). reviewer.js injects the prompt after 2s, so 3.5s gives
    // the echo 1.5s extra to clear. Set to 0 in unit tests where there is no prompt echo.
    this.verdictCooldownMs = verdictCooldownMs
    // liveCooldownMs: same concept for Panel A paste echo in _runLiveRound.
    this.liveCooldownMs    = liveCooldownMs
    this.stopped       = false
    this._currentSession = null
  }

  // priorRounds: pass when resuming after volley-continue, so debate history is intact
  //
  // NOTE on `ws` and `safeSend`:
  // `ws` is passed through to safeSend for backward-compat, but server.js wraps safeSend into
  // a closure (safeSendVolley) that dynamically resolves the current WebSocket from the sessions
  // Map at send-time.  This means output still flows after a browser disconnect+reconnect.
  async run(store, workdir, primarySession, ws, safeSend, startFromRound = 0, prevOutput = null, priorRounds = []) {
    const completedRounds = [...priorRounds]  // seed with prior rounds if resuming

    // Hoist taskPrompt so it's available for volley-log.md writes inside the loop
    // and for the synthesis section below
    let taskPrompt = ''
    try {
      const taskEvents = (store.export ? store.export().events || [] : []).filter(e => e.type === 'task')
      taskPrompt = taskEvents.length ? taskEvents[0].prompt : ''
    } catch (_) {}

    for (let round = startFromRound; round < this.maxRounds && !this.stopped; round++) {
      const isReviewerTurn = round % 2 === 0   // reviewer always goes first

      if (isReviewerTurn) {
        // ── Fresh reviewer session ────────────────────────────────────────
        const roundSessionId = crypto.randomUUID()
        safeSend(ws, {
          type: 'ready', sessionId: roundSessionId, agent: this.reviewerAgent,
          workdir, role: 'volley-round', round, maxRounds: this.maxRounds,
        })
        safeSend(ws, {
          type: 'volley-round-start', round, agent: this.reviewerAgent, maxRounds: this.maxRounds,
        })

        // Build FULL debate history so every reviewer sees all prior rounds
        const debateHistory = completedRounds.length > 0
          ? completedRounds.map((r, i) => {
              const cap  = 4000
              const body = r.output && r.output.length > cap
                ? '[...truncated...]\n' + r.output.slice(-cap)
                : (r.output || '')
              return `=== Round ${i + 1} — ${String(r.agent || 'unknown').toUpperCase()} ===\n${body}`
            }).join('\n\n')
          : null

        let session
        try {
          session = launchReviewer(
            store, this.reviewerAgent, workdir, debateHistory, null,
            { focusHint: this.focusHint, primaryAgent: this.liveAgent,
              cols: this.cols, rows: this.rows }
          )
        } catch (err) {
          safeSend(ws, { type: 'volley-error', error: err.message, round })
          break
        }
        // Register this session in server.js's sessions Map so:
        //   1. resize messages from the browser reach this PTY (fixes garbled output)
        //   2. the 60-second grace-kill applies when the browser disconnects
        this.registerSession(roundSessionId, session, this.reviewerAgent)
        this._currentSession = session
        session.on('data', evt => safeSend(ws, {
          type: 'output', sessionId: roundSessionId, data: evt.raw != null ? evt.raw : evt,
        }))
        // Delayed confirmation — fires after the 2-second prompt-injection window so the browser
        // can show "Prompt delivered — Codex is analyzing…" without a false positive.
        const _round = round
        setTimeout(() => safeSend(ws, {
          type: 'volley-prompt-sent', round: _round, agent: this.reviewerAgent,
        }), 2500)

        prevOutput = await this._runRound(session)
        this._currentSession = null

      } else {
        // ── Live Panel A agent ────────────────────────────────────────────
        safeSend(ws, {
          type: 'volley-round-start', round, agent: this.liveAgent, maxRounds: this.maxRounds,
        })

        const MAX_PASTE = 20000
        const body = (prevOutput || '').length > MAX_PASTE
          ? '[...truncated...]\n\n' + prevOutput.slice(-MAX_PASTE)
          : (prevOutput || '')
        primarySession.write(
          `\r\n\r\n=== REVIEW FROM ${this.reviewerAgent.toUpperCase()} — Round ${round + 1} of ${this.maxRounds} ===\r\n` +
          body +
          `\r\n=== END REVIEW ===\r\n` +
          `Please respond to this review. Address specific disagreements.\r\n` +
          `End your response with a verdict line — either: VERDICT: CONVERGED (you agree) or: VERDICT: DIVERGED (you disagree)\r\n\r`
        )
        prevOutput = await this._runLiveRound(primarySession)
      }

      completedRounds.push({
        round,
        agent: isReviewerTurn ? this.reviewerAgent : this.liveAgent,
        output: prevOutput,
      })

      // Persist round to store
      try {
        store.append('volley-round', {
          ts: Date.now(), round,
          agent: isReviewerTurn ? this.reviewerAgent : this.liveAgent,
          output: prevOutput,
        })
      } catch (_) {}

      safeSend(ws, {
        type: 'volley-round-complete',
        round,
        agent: isReviewerTurn ? this.reviewerAgent : this.liveAgent,
        output: (prevOutput || '').slice(0, 500),
      })

      // Write human-readable live log to workdir after every round
      try {
        const logLines = ['# Volley Log', `Task: ${taskPrompt || '(no task set)'}`, '']
        completedRounds.forEach((r, i) => {
          logLines.push(`## Round ${i + 1} — ${String(r.agent || 'unknown').toUpperCase()}`)
          logLines.push(r.output || '')
          logLines.push('')
        })
        fs.writeFileSync(path.join(workdir, 'volley-log.md'), logLines.join('\n'), 'utf8')
      } catch (_) {}   // non-fatal — never crash the volley over a log write

      // Convergence check after each complete reviewer+live pair
      if (round % 2 === 1 && completedRounds.length >= 2) {
        const last2       = completedRounds.slice(-2)
        const bothConverged = last2.every(r => {
          const m = VERDICT_RE.exec(r.output || '')
          return m && m[1].toUpperCase() === 'CONVERGED'
        })
        if (bothConverged) {
          safeSend(ws, { type: 'volley-convergence', message: 'Both agents agree — running final synthesis' })
          break
        }
      }
    }

    if (this.stopped) {
      safeSend(ws, { type: 'volley-done', rounds: completedRounds.length, reason: 'stopped' })
      this.emit('done', { reason: 'stopped', completedRounds, finalOutput: prevOutput })
      return
    }

    // Determine reason and synthesis mode
    const hitLimit  = completedRounds.length >= this.maxRounds
    const synthMode = hitLimit ? 'where-things-left-off' : 'full'

    // ── Final synthesis (always runs unless user stopped) ─────────────────
    safeSend(ws, { type: 'volley-synthesis-start', mode: synthMode })

    const synthSessionId = crypto.randomUUID()
    // Use liveAgent for synthesis — it has the most familiarity with the codebase
    const synthAgent = this.liveAgent
    safeSend(ws, {
      type: 'ready', sessionId: synthSessionId, agent: synthAgent,
      workdir, role: 'volley-synthesis',
    })

    let synthPrompt = store.buildSynthesisPrompt(completedRounds, taskPrompt)
    if (hitLimit) {
      synthPrompt =
        '> NOTE: The round limit was reached without full convergence.\n' +
        '> Summarize the current state of disagreement and the strongest argument from each side ' +
        'before giving your synthesis.\n\n' +
        synthPrompt
    }

    let synthSession
    try {
      synthSession = launchReviewer(store, synthAgent, workdir, null, synthPrompt,
        { cols: this.cols, rows: this.rows })
    } catch (err) {
      logger.error({ err }, 'volley: synthesis launch failed')
      safeSend(ws, { type: 'volley-done', rounds: completedRounds.length, reason: 'synthesis-error' })
      this.emit('done', { reason: 'synthesis-error', completedRounds, finalOutput: prevOutput })
      return
    }

    // Register synthesis session so resize + grace-kill apply (same as round sessions)
    this.registerSession(synthSessionId, synthSession, synthAgent)
    // Track synthesis session so stop() / browser-close kills it cleanly
    this._currentSession = synthSession
    synthSession.on('data', evt => safeSend(ws, {
      type: 'output', sessionId: synthSessionId, data: evt.raw != null ? evt.raw : evt,
    }))
    const synthOutput = await this._runRound(synthSession)
    this._currentSession = null

    // Persist synthesis round
    try {
      store.append('volley-round', {
        ts: Date.now(), round: completedRounds.length,
        agent: 'synthesis', role: 'synthesis', output: synthOutput,
      })
    } catch (_) {}

    const reason = hitLimit ? 'round-limit' : 'converged'
    safeSend(ws, {
      type: 'volley-done',
      rounds: completedRounds.length,
      reason,
      canContinue: hitLimit,      // tells browser to show Continue button
      synthOutput: (synthOutput || '').slice(0, 1000),
    })
    this.emit('done', { reason, completedRounds, finalOutput: synthOutput })
  }

  // Used for both fresh reviewer sessions AND the synthesis session.
  // Resolves with the clean text output of the session.
  _runRound(session) {
    return new Promise(resolve => {
      let timer          = null
      let settled        = false
      let verdictEnabled = false  // suppressed until after prompt-echo window (see below)
      const accum        = []

      const settle = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(session.capturedOutput || stripAnsi(accum.join('')))
      }

      const resetTimer = () => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          logger.warn({ pid: session.pid }, 'volley: 5-min idle timeout — ending round')
          try { session.kill() } catch (_) {}
        }, IDLE_TIMEOUT_MS)
      }

      // IMPORTANT: reviewer.js injects the prompt after a 2-second delay.  The PTY echoes
      // the pasted prompt text back as terminal output.  The review prompt itself contains
      // the literal text "VERDICT: CONVERGED" in the instructions, so without a cooldown the
      // VERDICT regex would fire on the *echo* of the injected prompt (before the model has
      // produced any output) — ending the round in ~2.5 seconds with empty output.
      // Fix: enable VERDICT scanning only after verdictCooldownMs (default 3.5s = 2s injection + 1.5s buffer).
      // Unit tests pass verdictCooldownMs=0 since they have no PTY echo.
      setTimeout(() => { verdictEnabled = true }, this.verdictCooldownMs)

      // Rolling tail of STRIPPED output for VERDICT scanning.
      // Testing raw chunks fails when the AI CLI wraps VERDICT in cursor-positioning
      // sequences (e.g. \x1b[1G\x1b[K before the text) — \s* in VERDICT_RE won't
      // skip those bytes.  A 500-char stripped tail also catches VERDICT split across
      // PTY chunk boundaries.
      let tailBuf      = ''
      let verdictFired = false

      session.on('data', evt => {
        const chunk = evt.raw != null ? evt.raw : String(evt)
        accum.push(chunk)
        tailBuf = (tailBuf + stripAnsi(chunk)).slice(-500)
        // Real-time VERDICT scan — end round immediately when found.
        // verdictEnabled guard ensures we only react to the model's own output, not the
        // echoed prompt text that was typed into the PTY during the injection window.
        if (verdictEnabled && !verdictFired && VERDICT_RE.test(tailBuf)) {
          verdictFired = true
          logger.debug('volley: VERDICT detected in reviewer stream — ending round')
          // Grace period so the model can finish the line it's on, then settle directly
          // rather than waiting for session exit — the AI CLI may take several seconds
          // to clean up after SIGTERM, which would stall the volley loop.
          setTimeout(() => {
            try { session.kill() } catch (_) {}
            settle()   // resolve now; session.once('exit', settle) is a belt-and-suspenders
          }, 500)
        }
        resetTimer()
      })

      session.once('exit', settle)
      resetTimer()
    })
  }

  // Used for live Panel A turns.
  // Listens on primarySession for output after the paste, resolves when VERDICT found or idle.
  _runLiveRound(primarySession) {
    return new Promise(resolve => {
      const buf          = []
      let timer          = null
      let settled        = false
      let verdictEnabled = false  // suppressed during paste-echo window (see below)

      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        primarySession.removeListener('data', dataListener)
        const raw = buf.join('')
        resolve(stripAnsi(raw))
      }

      // IMPORTANT: the paste written to primarySession ends with the literal text
      // "VERDICT: CONVERGED or VERDICT: DIVERGED".  The PTY echoes this back immediately.
      // Without a cooldown, VERDICT detection fires on the echo rather than Claude's response.
      // liveCooldownMs (default 1.5s) is enough for the paste echo to clear.
      // Unit tests pass liveCooldownMs=0 since they have no PTY echo.
      setTimeout(() => { verdictEnabled = true }, this.liveCooldownMs)

      // Same rolling-tail approach as _runRound — ANSI sequences and chunk boundaries
      // can prevent a raw-chunk VERDICT_RE match.
      let tailBuf      = ''
      let verdictFired = false

      const dataListener = evt => {
        const chunk = evt.raw != null ? evt.raw : String(evt)
        buf.push(chunk)
        tailBuf = (tailBuf + stripAnsi(chunk)).slice(-500)
        if (verdictEnabled && !verdictFired && VERDICT_RE.test(tailBuf)) {
          verdictFired = true
          logger.debug('volley: VERDICT detected in live Panel A stream — ending round')
          setTimeout(finish, 500)  // grace period for the model to finish the line
          return
        }
        clearTimeout(timer)
        timer = setTimeout(finish, IDLE_TIMEOUT_MS)
      }

      primarySession.on('data', dataListener)
      timer = setTimeout(finish, IDLE_TIMEOUT_MS)
    })
  }

  stop() {
    this.stopped = true
    try { if (this._currentSession) this._currentSession.kill() } catch (_) {}
  }
}

// Inline stripAnsi for captured output — avoids a cross-module dependency
const _ANSI_RE = new RegExp(
  '\\x1b(?:' +
  '\\[[0-9;?]*[A-Za-z~]' +
  '|\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)' +
  '|P[^\\x1b]*(?:\\x1b\\\\|$)' +
  '|[^[\\]P]' +
  ')',
  'g'
)

function stripAnsi(str) {
  return String(str)
    .replace(_ANSI_RE, '')
    .replace(/[^\x20-\x7E\n\r\t]/g, '')
    .replace(/\r\n|\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

module.exports = { VolleyManager }
