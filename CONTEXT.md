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

---

## Open Questions
- Should the context store persist to disk in real time or only on session end? (Current lean: real time, to survive crashes)
- Should the reviewer session see the raw terminal output or a cleaned version? (Current lean: strip ANSI escape codes but keep all content)

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
