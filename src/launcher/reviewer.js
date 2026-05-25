// Review launcher — takes a completed ContextStore, formats it into a review
// prompt, and opens a new PTY session (claude or codex) pre-loaded with the
// full context from the prior session.
//
// INTERFACE CONTRACT (do not change exports):
//   launchReviewer(store, agent, workdir, reviewerOutput?) → EventEmitter
//     store: ContextStore instance (completed session)
//     agent: 'claude' | 'codex'
//     workdir: path the reviewer should operate in
//     reviewerOutput: optional — prior reviewer's output for cross-check mode
//     Returns the same EventEmitter interface as createSession()
//
//   captureOutput(emitter) → Promise<string>
//     Collects all output from an emitter until exit, returns clean text.

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

function launchReviewer(store, agent, workdir, reviewerOutput = null) {
  const { loadConfig } = require('../config/agent-config')
  const agentConfig = loadConfig()
  const agentEnv = (agentConfig[agent] && agentConfig[agent].env) || process.env

  // Build the review prompt — pass reviewerOutput for cross-check mode
  const prompt = store.buildReviewPrompt(reviewerOutput)

  const resolvedBin = (agentConfig[agent] && agentConfig[agent].bin) || agent
  // Spawn through the login shell so PATH includes wherever claude/codex are installed.
  // Mirrors the same pattern used in pty-session.js for primary sessions.
  const loginShell = process.env.SHELL || '/bin/bash'
  const proc = pty.spawn(loginShell, ['-lc', resolvedBin], {
    name: 'xterm-color',
    cols: 120,
    rows: 40,
    cwd: workdir,
    env: agentEnv,
  })

  const emitter = new EventEmitter()

  // Capture raw output for cross-check use
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
