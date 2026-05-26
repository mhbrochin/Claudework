// Review launcher — takes a completed ContextStore, formats it into a review
// prompt, and opens a new PTY session (claude or codex) pre-loaded with the
// full context from the prior session.
//
// INTERFACE CONTRACT (do not change exports):
//   launchReviewer(store, agent, workdir, reviewerOutput?, overridePrompt?, options?) → EventEmitter
//     store: ContextStore instance (completed session)
//     agent: 'claude' | 'codex'
//     workdir: path the reviewer should operate in
//     reviewerOutput: optional — prior reviewer's output for cross-check / debate-history mode
//     overridePrompt: optional — if provided, bypasses buildReviewPrompt entirely (used by synthesis)
//     options: optional — { focusHint?, primaryAgent?, cols?, rows? } forwarded as needed
//       cols/rows — PTY spawn dimensions; defaults to 220×50 so initial output renders correctly
//       before the browser's resize message arrives. Pass actual xterm dimensions when known.
//     Returns the same EventEmitter interface as createSession()

const { EventEmitter } = require('events')
const pty = require('node-pty')

// Same ANSI stripper as store.js — must be kept in sync
const ANSI_RE = new RegExp(
  '\\x1b(?:' +
  '\\[[0-9;?]*[A-Za-z~]' +                       // CSI: letter or ~ (incl. bracketed paste)
  '|\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)' +      // OSC: BEL or ST terminator
  '|P[^\\x1b]*(?:\\x1b\\\\|$)' +                 // DCS: device control strings
  '|[^[\\]P]' +                                   // other two-char escapes
  ')',
  'g'
)

function stripAnsi(str) {
  return String(str)
    .replace(ANSI_RE, '')
    .replace(/[^\x20-\x7E\n\r\t]/g, '')
    .replace(/\r\n|\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function launchReviewer(store, agent, workdir, reviewerOutput = null, overridePrompt = null, options = {}) {
  const { loadConfig } = require('../config/agent-config')
  const agentConfig = loadConfig()
  const agentEnv = (agentConfig[agent] && agentConfig[agent].env) || process.env

  // Build the review prompt — overridePrompt short-circuits buildReviewPrompt (used by synthesis)
  const prompt = overridePrompt || store.buildReviewPrompt(reviewerOutput, options)

  // Use caller-supplied terminal dimensions when known (browser sends actual xterm cols/rows
  // in the review/volley-start message). Default to 220×50 — larger than most screens so that
  // ANSI cursor sequences in shell startup output land within xterm's viewport and render
  // correctly in the first ~50ms before the browser's resize message arrives.
  const spawnCols = (options.cols && Number.isInteger(options.cols) && options.cols > 0)
    ? options.cols : 220
  const spawnRows = (options.rows && Number.isInteger(options.rows) && options.rows > 0)
    ? options.rows : 50

  const resolvedBin = (agentConfig[agent] && agentConfig[agent].bin) || agent
  // Spawn through the login shell so PATH includes wherever claude/codex are installed.
  // Mirrors the same pattern used in pty-session.js for primary sessions.
  const loginShell = process.env.SHELL || '/bin/bash'
  const proc = pty.spawn(loginShell, ['-lc', resolvedBin], {
    name: 'xterm-color',
    cols: spawnCols,
    rows: spawnRows,
    cwd: workdir,
    env: agentEnv,
  })

  const emitter = new EventEmitter()

  // Capture raw output for cross-check / debate-history use
  const outputChunks = []

  proc.onData((raw) => {
    outputChunks.push(raw)
    emitter.emit('data', { ts: Date.now(), raw })
  })

  proc.onExit(({ exitCode }) => {
    emitter.capturedOutput = stripAnsi(outputChunks.join(''))
    emitter.emit('exit', { code: exitCode })
  })

  emitter.write = (raw) => {
    emitter.emit('input', { ts: Date.now(), raw })
    proc.write(raw)
  }

  emitter.resize = (cols, rows) => proc.resize(cols, rows)
  emitter.kill = (signal) => { try { proc.kill(signal) } catch (_) {} }
  emitter.pid = proc.pid

  // Wait for the CLI to render its welcome screen before injecting the prompt
  // (avoids the prompt being swallowed during startup)
  let promptSent = false
  const sendPrompt = () => {
    if (promptSent) return
    promptSent = true
    // \r is the PTY Enter key — submits the prompt in interactive CLIs
    proc.write(prompt + '\r')
  }

  // Send after a short delay to let the CLI initialise
  setTimeout(sendPrompt, 2000)

  return emitter
}

module.exports = { launchReviewer }
