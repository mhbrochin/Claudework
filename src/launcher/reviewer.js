// Review launcher — takes a completed ContextStore, formats it into a review
// prompt, and opens a new PTY session (claude or codex) pre-loaded with the
// full context from the prior session.
//
// INTERFACE CONTRACT (do not change exports):
//   launchReviewer(store, agent, workdir) → EventEmitter
//     store: ContextStore instance (completed session)
//     agent: 'claude' | 'codex'
//     workdir: path the reviewer should operate in
//     Returns the same EventEmitter interface as createSession()
//
// The review prompt injected into the agent must include:
//   1. What was built (summary from store)
//   2. Every flagged decision and its note
//   3. All file diffs in unified diff format
//   4. The full I/O log (condensed — strip raw terminal escape codes)
//   5. The review instruction:
//      "Review this session. For each flagged decision, say whether it makes sense
//       and suggest an alternative if not. Flag any code that contradicts the stated
//       decisions. List what is missing. Rate overall quality 1-10 with reasoning."

const { EventEmitter } = require('events')
const pty = require('node-pty')

// Matches ANSI CSI/OSC escape sequences. Built via RegExp constructor so the
// ESC (0x1B) and CSI (0x9B) control bytes are explicit rather than embedded
// literally in the source.
const ANSI_PATTERN = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*' +
    '(?:(?:(?:[a-zA-Z0-9]*(?:;[a-zA-Z0-9]*)*)?\\u0007)' +
    '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[0-9A-PR-TZcf-nq-uy=><~]))',
  'g'
)

function stripAnsi(str) {
  return String(str).replace(ANSI_PATTERN, '')
}

function launchReviewer(store, agent, workdir) {
  const prompt = stripAnsi(store.buildReviewPrompt())

  const proc = pty.spawn(agent, [], {
    name: 'xterm-color',
    cols: 120,
    rows: 40,
    cwd: workdir,
    env: process.env,
  })

  const emitter = new EventEmitter()

  proc.onData((raw) => {
    emitter.emit('data', { ts: Date.now(), raw })
  })

  proc.onExit(({ exitCode }) => {
    emitter.emit('exit', { code: exitCode })
  })

  emitter.write = (raw) => {
    emitter.emit('input', { ts: Date.now(), raw })
    proc.write(raw)
  }

  emitter.resize = (cols, rows) => proc.resize(cols, rows)
  emitter.kill = (signal) => proc.kill(signal)
  emitter.pid = proc.pid

  process.nextTick(() => {
    emitter.emit('input', { ts: Date.now(), raw: prompt })
    proc.write(prompt)
  })

  return emitter
}

module.exports = { launchReviewer }
