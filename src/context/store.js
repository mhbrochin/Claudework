// Context store — structured, persistent log for a single AI session.
// Captures I/O events, file diffs, and flagged decisions.
// The buildReviewPrompt() method is the key output: a formatted string
// ready to inject into a second agent as its opening context.
//
// INTERFACE CONTRACT (do not change exports):
//   new ContextStore(sessionId, workdir)
//     .append(type, data)       — type: 'input'|'output'|'diff'|'decision'
//     .flag(note)               — mark a decision worth explaining to a reviewer
//     .export()                 → raw JSON
//     .buildReviewPrompt()      → formatted string prompt for the reviewer agent

// TODO: implement in feature/context-store

class ContextStore {
  constructor(sessionId, workdir) {
    this.sessionId = sessionId
    this.workdir = workdir
    this.events = []
  }

  append(type, data) { throw new Error('Not implemented — see feature/context-store') }
  flag(note) { throw new Error('Not implemented — see feature/context-store') }
  export() { throw new Error('Not implemented — see feature/context-store') }
  buildReviewPrompt() { throw new Error('Not implemented — see feature/context-store') }
}

module.exports = { ContextStore }
