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
