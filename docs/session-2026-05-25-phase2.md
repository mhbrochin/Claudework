# ContextBridge Phase 2 — Session Notes (2026-05-25)

This document captures the full context of the Phase 2 build session for future reference,
bug fixes, and onboarding. Everything described here is committed and in git.

---

## What Was Built

Three major features were implemented and all 59 tests pass:

### 1. Full Context Sharing
The reviewer AI now receives complete, structured context every time:
- **Task** — the original prompt the user typed when starting the session (`type: 'task'` event)
- **Session Commands** — what the primary AI typed (deduplicated, max 4000 chars)
- **File Listing** — `fs.readdirSync(workdir)` at prompt-build time, max 2000 chars
- **Focus Hint** — optional free-text focus direction (e.g. "security", "performance")
- **Agent names** — read from session metadata, never hardcoded
- **Diffs** — git diffs of changed files (already existed)
- **Full Output** — primary agent's session output, max 40,000 chars with ANSI stripped

### 2. Auto-Volley
Claude and Codex debate each other automatically across N rounds:
- Round 0: fresh reviewer session gets full context prompt → waits for VERDICT
- Round 1: reviewer output pasted into live Panel A agent → waits for VERDICT
- Rounds 2+: same pattern, but reviewer gets FULL debate history (all prior rounds)
- Final: dedicated synthesis session reads all rounds and writes structured verdict
- Real-time VERDICT detection (`/VERDICT:\s*(CONVERGED|DIVERGED)/i`) ends rounds immediately
- 5-minute silence fallback if no VERDICT appears
- Convergence: both agents CONVERGED in the same pair → synthesis runs, `reason: 'converged'`
- Round limit: synthesis runs in "where-things-left-off" mode, Continue modal appears
- `volley-continue` resumes from SQLite state with full debate history intact

### 3. Symmetry
Works identically whether Claude or Codex is in Panel A:
```js
const liveAgent     = sourceEntry.agent || 'claude'   // whoever is in Panel A
const reviewerAgent = liveAgent === 'claude' ? 'codex' : 'claude'
```

### 4. Live volley-log.md
After every round, `volley-log.md` is written to the workdir — human-readable, shows
the full debate as it unfolds. In `.gitignore` and chokidar ignore list so it never
triggers diffs or gets accidentally committed.

---

## Files Changed / Created

| File | Change |
|------|--------|
| `src/volley/volley-manager.js` | **NEW** — VolleyManager class |
| `src/context/store.js` | Full rewrite — task/commands/listing/focusHint/buildSynthesisPrompt |
| `src/launcher/reviewer.js` | Added `overridePrompt` + `options` params |
| `src/ui/server.js` | Task capture, volley-start/stop/continue handlers, MemoryStore updates |
| `src/ui/public/index.html` | Task field, Volley modal, Continue modal, buttons, message handlers |
| `src/capture/pty-session.js` | Added `volley-log.md` to chokidar ignore list |
| `.gitignore` | Added `volley-log.md` |
| `tests/volley-manager.test.js` | **NEW** — 14 unit tests |
| `tests/volley-integration.test.js` | **NEW** — 8 integration tests |
| `tests/context-store.test.js` | Rewritten for all new store functionality |

---

## Architecture Decisions

### Why full debate history (not just last round)?
Each fresh reviewer session is stateless — it has no memory of prior rounds.
If you only pass the last round's output, Round 4's reviewer doesn't know what was said
in Rounds 1–3 and can't build on it or contradict it. Passing all rounds means the
debate actually progresses. Size budget: 4000 chars × 20 rounds = 80K chars max,
well within any model's context window.

### Why `mockImplementationOnce(() => mockSession())` in tests?
`mockReturnValueOnce(mockSession())` creates the mock session at test-setup time.
`mockSession()` starts a `setTimeout` to auto-emit data+exit after 20ms. By the time
`vm.run()` actually calls `launchReviewer` (~500ms later), the session has already
emitted and exited. The `_runRound` listener registered after the fact never fires,
and the 5-minute idle timer takes over — test timeout.
`mockImplementationOnce(() => mockSession())` creates the session lazily, at the exact
moment `launchReviewer` is called inside `vm.run()`, so the timers start fresh.

### Why maxRounds: 1 for integration test 7?
The mock PTY auto-emits VERDICT at T=50ms after spawn. A 3-round volley means the
live Panel A turn happens at T≈600ms (after round 0 reviewer completes). The primary
PTY has already emitted and gone quiet — `_runLiveRound` waits for its 5-minute
timeout. Using `maxRounds: 1` means only the reviewer turn runs (no live Panel A turn),
so all timing works correctly with the mock.

### Why `overridePrompt` in reviewer.js?
Synthesis uses a completely different prompt structure from review prompts.
Rather than make `buildSynthesisPrompt` conform to `buildReviewPrompt`'s interface,
the synthesis prompt is built separately and passed as `overridePrompt`, bypassing
`buildReviewPrompt` entirely. The injection mechanism (setTimeout 2000ms) is unchanged.

### Why taskPrompt hoisted to top of run()?
The volley-log.md write happens inside the round loop, after every round.
If taskPrompt were computed only in the synthesis section (bottom of run()), the log
writes inside the loop would reference an undefined variable. Hoisting it to the top
of run() makes it available everywhere.

---

## Key Code Patterns

### Debate history construction (volley-manager.js)
```js
const debateHistory = completedRounds.length > 0
  ? completedRounds.map((r, i) => {
      const cap  = 4000
      const body = r.output && r.output.length > cap
        ? '[...truncated...]\n' + r.output.slice(-cap)
        : (r.output || '')
      return `=== Round ${i + 1} — ${String(r.agent || 'unknown').toUpperCase()} ===\n${body}`
    }).join('\n\n')
  : null
```

### Debate history vs. single review detection (store.js)
```js
const isDebateHistory = reviewerOutput && reviewerOutput.includes('=== Round ')
lines.push(isDebateHistory ? '## Debate History So Far' : '## Prior Reviewer Analysis')
```

### Symmetric agent assignment (server.js)
```js
const liveAgent     = sourceEntry.agent || 'claude'
const reviewerAgent = liveAgent === 'claude' ? 'codex' : 'claude'
```

### End-of-round detection (volley-manager.js _runRound)
```js
session.on('data', evt => {
  const chunk = evt.raw ?? evt
  accum.push(chunk)
  if (VERDICT_RE.test(chunk)) {
    // Kill after 500ms so session has time to flush remaining output
    setTimeout(() => { try { session.kill() } catch (_) {} }, 500)
  }
  resetTimer()  // reset 5-min idle fallback on every data event
})
session.once('exit', settle)  // settlement always happens on exit, never directly on VERDICT
```

### Synthesis session tracked for clean teardown
```js
this._currentSession = synthSession   // set before awaiting synthesis
const synthOutput = await this._runRound(synthSession)
this._currentSession = null           // cleared after
// stop() checks this._currentSession so closing the browser kills synthesis too
```

---

## WebSocket Message Protocol (new messages)

| Message (client → server) | Fields | Purpose |
|---------------------------|--------|---------|
| `volley-start` | `sessionId`, `maxRounds`, `focusHint` | Start a new volley |
| `volley-stop` | — | Stop current volley cleanly |
| `volley-continue` | `sessionId`, `extraRounds`, `focusHint` | Resume after round-limit |

| Message (server → client) | Fields | Purpose |
|---------------------------|--------|---------|
| `volley-round-start` | `round`, `agent`, `maxRounds` | Round N beginning |
| `volley-round-complete` | `round`, `agent`, `output` (first 500 chars) | Round N done |
| `volley-convergence` | `message` | Both agents agreed, running synthesis |
| `volley-synthesis-start` | `mode` (`full` or `where-things-left-off`) | Synthesis starting |
| `volley-done` | `rounds`, `reason`, `canContinue`, `synthOutput` | Volley complete |
| `volley-error` | `error`, `round` | Something went wrong |

`reason` values: `'converged'` | `'round-limit'` | `'stopped'` | `'synthesis-error'`

---

## SQLite Schema (events table)

New event types added this session:

| `type` | `payload` fields | When written |
|--------|-----------------|--------------|
| `task` | `prompt`, `ts` | On session start if user filled the Task field |
| `volley-round` | `ts`, `round`, `agent`, `output`, `role?` | After every round completes |

`role: 'synthesis'` is set on the final synthesis round so `volley-continue` can
exclude it when reconstructing `completedRounds`.

---

## Test Coverage

```
tests/context-store.test.js       27 tests  — ContextStore constructor, append, export,
                                              buildReviewPrompt (all options), buildSynthesisPrompt
tests/volley-manager.test.js      14 tests  — VolleyManager run(), stop(), resume,
                                              VERDICT detection, convergence, round-limit,
                                              error handling, debate history
tests/volley-integration.test.js   8 tests  — Full end-to-end with real WebSocket server,
                                              mock PTY, all volley message flows
tests/pty-session.test.js          6 tests  — PTY session lifecycle (unchanged)
tests/server.test.js               4 tests  — HTTP endpoints (unchanged)

Total: 59 tests, all passing
```

---

## Known Limitations / Future Work

- **No auth** — the server runs as your local user with no authentication. Fine for local
  personal use; add auth before any public deployment.
- **Live Panel A timing** — `_runLiveRound` uses the same 5-minute idle timer as reviewer
  sessions. If the live agent is slow to respond after a paste, the 5-min fallback fires.
  A smarter heuristic (e.g. detect when the prompt reappears) would be more reliable.
- **volley-log.md not in synthesis** — the synthesis round output is intentionally excluded
  from volley-log.md (it's a separate artifact). If you want synthesis included, add a
  `fs.writeFileSync` call after `synthOutput` is captured.
- **Large history truncation** — each round is capped at 4000 chars in the debate history
  passed to reviewers. Very verbose AI output gets tail-truncated. The most recent content
  is preserved (`.slice(-cap)`) which is usually more relevant.

---

## How to Run

```bash
cd /Users/mhbrochin/Claude/Claudework
npm start
# Open http://localhost:3000
# Diagnostics: http://localhost:3000/api/health
```

```bash
# Run tests
./node_modules/.bin/jest --forceExit
# or (if node is in PATH):
npx jest --forceExit
```

Note: Node.js is managed via nvm. If `node` is not found:
```bash
export PATH="/Users/mhbrochin/.nvm/versions/node/v24.16.0/bin:$PATH"
```
Add that line to your `~/.zshrc` to make it permanent.
