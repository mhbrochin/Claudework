// PTY capture layer — wraps a CLI process (claude, codex) via node-pty,
// intercepts all stdin/stdout, and emits structured events for the context store.
//
// INTERFACE CONTRACT (do not change exports):
//   createSession(command, workdir, sessionId) → EventEmitter
//     emits: 'data'  { ts, raw }          — output from the process
//            'input' { ts, raw }          — keystrokes sent to the process
//            'diff'  { ts, file, patch }  — git diff after a file write is detected
//            'exit'  { code }             — process exited

const { EventEmitter } = require('events')
const path = require('path')
const os = require('os')
const pty = require('node-pty')
const chokidar = require('chokidar')
const simpleGit = require('simple-git')

function createSession(command, workdir, sessionId) {
  const session = new EventEmitter()
  session.sessionId = sessionId
  session.workdir = workdir

  // Spawn through the user's login shell so PATH includes wherever claude/codex
  // are installed (especially on macOS where GUI apps get a limited PATH).
  const loginShell = process.env.SHELL || '/bin/bash'

  const shell = pty.spawn(loginShell, ['-lc', command], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: workdir,
    env: process.env,
  })

  session.pid = shell.pid

  shell.onData((raw) => {
    session.emit('data', { ts: Date.now(), raw })
  })

  shell.onExit(({ exitCode }) => {
    try { watcher.close() } catch (_) {}
    session.emit('exit', { code: exitCode })
  })

  session.write = (raw) => {
    session.emit('input', { ts: Date.now(), raw })
    shell.write(raw)
  }

  session.resize = (cols, rows) => {
    shell.resize(cols, rows)
  }

  session.kill = (signal) => {
    shell.kill(signal)
  }

  const git = simpleGit(workdir)
  const pending = new Map()

  const watcher = chokidar.watch(workdir, {
    ignored: [
      /(^|[\/\\])\../,
      /node_modules/,
    ],
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  })

  const handleChange = async (filePath) => {
    const rel = path.relative(workdir, filePath)
    if (!rel || rel.startsWith('..')) return

    if (pending.has(rel)) clearTimeout(pending.get(rel))
    pending.set(rel, setTimeout(async () => {
      pending.delete(rel)
      try {
        let patch = await git.diff(['--', rel])
        if (!patch) {
          patch = await git.diff(['--cached', '--', rel])
        }
        if (!patch) {
          patch = await git.raw(['diff', '--no-index', '--', '/dev/null', filePath]).catch(() => '')
        }
        if (patch) {
          session.emit('diff', { ts: Date.now(), file: rel, patch })
        }
      } catch (err) {
        session.emit('diff', { ts: Date.now(), file: rel, patch: `# diff error: ${err.message}${os.EOL}` })
      }
    }, 150))
  }

  watcher.on('add', handleChange)
  watcher.on('change', handleChange)
  watcher.on('unlink', handleChange)

  return session
}

module.exports = { createSession }
