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
const fs = require('fs')
const path = require('path')
const os = require('os')
const pty = require('node-pty')
const chokidar = require('chokidar')
const simpleGit = require('simple-git')

function createSession(command, workdir, sessionId) {
  // Validate workdir exists and is accessible
  try {
    fs.accessSync(workdir, fs.constants.R_OK)
  } catch (err) {
    throw new Error(`Workdir not accessible: ${workdir} — ${err.message}`)
  }

  // Resolve absolute workdir path
  const absWorkdir = path.resolve(workdir)

  // Spawn through the user's login shell so PATH includes wherever claude/codex
  // are installed (especially on macOS where GUI apps get a limited PATH).
  const loginShell = process.env.SHELL || '/bin/bash'

  // Validate the login shell exists before trying to spawn
  try {
    fs.accessSync(loginShell, fs.constants.X_OK)
  } catch (err) {
    throw new Error(`Login shell not executable: ${loginShell} — ${err.message}`)
  }

  const session = new EventEmitter()
  session.sessionId = sessionId
  session.workdir = absWorkdir

  let shell
  try {
    shell = pty.spawn(loginShell, ['-lc', command], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: absWorkdir,
      env: process.env,
    })
  } catch (err) {
    throw new Error(`Failed to spawn PTY (${loginShell} -lc ${command}): ${err.message}`)
  }

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
    try { shell.kill(signal) } catch (_) {}
  }

  const git = simpleGit(absWorkdir)
  const pending = new Map()

  const watcher = chokidar.watch(absWorkdir, {
    ignored: [
      /(^|[\/\\])\../,
      /node_modules/,
    ],
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  })

  const handleChange = (filePath) => {
    const rel = path.relative(absWorkdir, filePath)
    if (!rel || rel.startsWith('..')) return

    if (pending.has(rel)) clearTimeout(pending.get(rel))
    pending.set(rel, setTimeout(() => {
      pending.delete(rel)
      git.diff(['--', rel])
        .then(patch => patch || git.diff(['--cached', '--', rel]))
        .then(patch => {
          if (!patch) {
            return git.raw(['diff', '--no-index', '--', '/dev/null', filePath]).catch(() => '')
          }
          return patch
        })
        .then(patch => {
          if (patch) session.emit('diff', { ts: Date.now(), file: rel, patch })
        })
        .catch(err => {
          session.emit('diff', { ts: Date.now(), file: rel, patch: `# diff error: ${err.message}${os.EOL}` })
        })
    }, 150))
  }

  watcher.on('add', handleChange)
  watcher.on('change', handleChange)
  watcher.on('unlink', handleChange)
  watcher.on('error', () => {}) // prevent unhandled watcher errors from crashing

  return session
}

module.exports = { createSession }
