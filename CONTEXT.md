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
