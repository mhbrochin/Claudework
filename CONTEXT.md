# ContextBridge — Decisions Log

This file is the shared brain between agent sessions. Every session appends decisions here.

---

## Project Goal
A local web app that wraps Claude Code and Codex CLI sessions, captures all I/O and file diffs in real time, and lets you inject that full context into a second agent for cross-model code review — no copy-pasting, no lost reasoning.

## Architecture Decisions

### 2026-05-25 — Scaffold setup

**Node.js chosen over Python**
Reason: node-pty is the most mature PTY library available, and xterm.js (the terminal renderer) is JavaScript-native. Keeping the whole stack in JS avoids a cross-language bridge.

**Module boundaries are hard**
Each of the 4 modules (capture, context, ui, launcher) exports a single interface defined in the stub file. Sessions must not change these exports — only implement the bodies. The integration session on main wires them together.

**Context store is session-scoped, not global**
Each session gets its own ContextStore instance. The UI manages multiple stores (one per open session panel). This keeps the data model simple and prevents sessions from polluting each other's logs.

**WebSocket protocol is the integration seam**
The server.js WebSocket message format is the contract between the UI (browser) and the backend (PTY sessions). Both the web-ui session and the pty-capture session must conform to this protocol without changing it.

**sessions/ directory for runtime files**
JSON context logs are written to sessions/{sessionId}.json at runtime. This directory is gitignored for logs but tracked for structure.

### 2026-05-25 — PTY capture (feature/pty-capture)

**Returned object is an EventEmitter with extra methods**
`createSession` returns an EventEmitter augmented with `write(raw)`, `resize(cols, rows)`, `kill(signal)`, plus `pid`, `sessionId`, `workdir`. The web-ui session calls `session.write()` to forward browser keystrokes; that path is where 'input' events are emitted, so anything bypassing `write()` (writing to the pty handle directly) will not be logged.

**Command parsing is whitespace-split, not shell-evaluated**
`createSession('claude --foo bar', ...)` spawns `claude` with `['--foo','bar']` via node-pty. No shell interpolation, no quoted-arg handling. If callers need a shell, they should pass `bash -lc '...'`.

**Diff strategy: simple-git against the workdir, debounced per file**
chokidar watches `workdir` with `ignoreInitial: true` and ignores dotfiles + `node_modules`. On add/change/unlink we debounce ~150ms per relative path, then run `git diff -- <path>`. If the working-tree diff is empty we fall back to `--cached`, then to a `--no-index` diff against `/dev/null` so brand-new untracked files still produce a patch. Files outside the workdir are dropped.

**awaitWriteFinish on the watcher**
chokidar's `awaitWriteFinish` (100ms stability) prevents firing on partial writes from editors that do open→write→close in multiple syscalls.

**Watcher lifecycle tied to the PTY**
The chokidar watcher is closed inside `onExit` so the session is fully releasable; callers do not need to clean it up.

---

## Open Questions
- Should the context store persist to disk in real time or only on session end? (Current lean: real time, to survive crashes)
- Should the reviewer session see the raw terminal output or a cleaned version? (Current lean: strip ANSI escape codes but keep all content)

---

### 2026-05-25 — ContextStore implementation (feature/context-store)

**Real-time persistence via synchronous writes**
Every `append()` and `flag()` rewrites `sessions/{sessionId}.json` synchronously. Chose `writeFileSync` over async/streamed appends so a crash mid-event cannot leave a half-written JSON file. The whole-file rewrite is fine at expected event volumes (a session is hundreds, not millions, of events); revisit if that assumption breaks.

**Storage location resolved against `process.cwd()`, not `workdir`**
`workdir` is the *captured* session's working directory (the project being reviewed). Logs belong to the orchestrator app, so they live under `cwd/sessions/`. The directory is created with `mkdirSync({ recursive: true })` in the constructor so callers don't have to pre-create it.

**`flag(note)` is sugar over `append('decision', { note })`**
Keeps a single code path for persistence and a single event shape, so `export()` and `buildReviewPrompt()` don't need to special-case decisions.

**Review prompt structure**
Markdown with four sections: metadata, flagged decisions, diffs (fenced as ```diff), and an ANSI-stripped I/O log (inputs prefixed `>>>`, outputs `<<<`). Ends with a numbered review instruction asking the reviewer to evaluate each decision, flag contradictions, list gaps, and give a 1-10 rating with justification — matching the format the reviewer agent will be evaluated against.

**ANSI stripper covers CSI, OSC, and bare-ESC sequences**
A single regex handles `ESC[…`, `ESC]…BEL`, and `ESC@`-style escapes. Good enough for terminal output from Claude Code / Codex without pulling in a dependency.

**Diff event shape is permissive**
`buildReviewPrompt()` accepts `{ file, patch }`, `{ path, diff }`, or a raw string — so the capture module can pick whichever shape is most natural without coupling to the store.

---

### 2026-05-25 — Web UI (feature/web-ui)

**Single WebSocket per browser tab, sessions multiplexed by sessionId**
The browser opens one WS to the Express server; every frame carries a `sessionId` so the server can route input to the right PTY and the browser can route output to the right xterm panel. Avoids per-session sockets and keeps the protocol flat.

**Server owns sessionId allocation (crypto.randomUUID)**
The browser never invents ids. On `start` and `review` the server generates the id and echoes it back in `ready`. This guarantees uniqueness and gives the integration layer a single source of truth.

**`role` field added to `ready` (non-breaking)**
`ready` carries an extra `role: 'primary' | 'reviewer'` so the UI knows which xterm panel to bind. The four documented message types are unchanged; `role` is additive metadata the UI relies on but other clients can ignore. The reviewer `ready` also includes `sourceSessionId` so the UI can show the link.

**Reviewer reuses the source session's store**
On `review`, the server passes the source session's ContextStore to `launchReviewer` (per the launcher contract) and tags the reviewer's events with the new sessionId. The reviewer's terminal output is **not** appended back into the source store — only its own diffs/output are forwarded to the browser. This keeps the source context immutable once review starts.

**Defensive event-shape handling**
The PTY-capture contract emits `{ ts, raw }`, `{ ts, file, patch }`, `{ code }`. The server tolerates both the documented shape and a bare value (e.g. `session.emit('exit', 0)`) so the web-ui doesn't break if the capture session ships a slightly different envelope.

**Frontend: panel B hidden until first reviewer launch**
Top-right panel uses `display:none` and `grid-template-columns: 1fr` on `#terminals` until a `ready` with `role:'reviewer'` arrives, then switches to `1fr 1fr` and fits both terminals. Avoids an empty pane on first load.

**Export uses HTTP, not WebSocket**
`Export Context` hits `GET /api/sessions/:id/export` and downloads the JSON blob via an anchor click. Streaming large JSON over WS would force base64 or chunking; a normal HTTP download is simpler and lets the browser handle the file save.

---

### 2026-05-25 — Review launcher (src/launcher/reviewer.js)

**Returned object mirrors createSession() shape, plus a `write` method**
The pty-capture contract says the session emits `data` / `input` / `exit`.
The launcher's emitter does the same so the UI can attach the same handlers
to a reviewer session as to a primary session. Added `write(raw)` (also
emits `input` so keystrokes are captured if the caller wants to log the
reviewer session too), plus `resize`, `kill`, and `pid` passthroughs — these
aren't in the documented contract but are needed for any real PTY consumer
and don't conflict with the emitter interface.

**Prompt injection happens on `process.nextTick` after spawn**
Writing synchronously right after `pty.spawn` can race the child before its
stdin is wired through the PTY master. A nextTick defer is enough to land
the write after the spawn settles without introducing a real delay. The
write is also emitted as an `input` event so the prompt appears in any
downstream log of the reviewer session.

**ANSI stripping applied to the prompt only, not to live PTY output**
The contract says "strip ANSI escape codes from the prompt before
injecting" — that's a one-shot scrub of the buildReviewPrompt() string.
Live data from the reviewer's own PTY is forwarded raw via the `data`
event so the UI's terminal renderer (xterm.js) gets the formatting it
expects. The ANSI regex is built via `new RegExp` with explicit ``
/ `` escapes so the source file stays free of literal control bytes.

**Agent spawned with no extra args**
`pty.spawn(agent, [], …)` — the contract says agent is `'claude'` or
`'codex'` and the prompt is delivered over stdin, so no CLI flags are
needed. If a future caller wants flags (e.g. `--model`), that's an
interface change and belongs in a follow-up, not here.
