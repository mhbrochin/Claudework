// PTY capture layer — wraps a CLI process (claude, codex) via node-pty,
// intercepts all stdin/stdout, and emits structured events for the context store.
//
// INTERFACE CONTRACT (do not change exports):
//   createSession(command, workdir, sessionId) → EventEmitter
//     emits: 'data'  { ts, raw }          — output from the process
//            'input' { ts, raw }          — keystrokes sent to the process
//            'diff'  { ts, file, patch }  — git diff after a file write is detected
//            'exit'  { code }             — process exited

// TODO: implement in feature/pty-capture

function createSession(command, workdir, sessionId) {
  throw new Error('Not implemented — see feature/pty-capture')
}

module.exports = { createSession }
