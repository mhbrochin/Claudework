// Context store — persists session events (I/O, diffs, flagged decisions) to SQLite.
//
// INTERFACE CONTRACT (do not change exports):
//   new ContextStore(sessionId, workdir)
//     .append(type, data)         — add an event
//     .flag(note)                 — shorthand for append('decision', { note })
//     .export()                   → raw JSON
//     .buildReviewPrompt()        → formatted string prompt for the reviewer agent

const { createSession, appendEvent, getSession, getEvents } = require('../db/sessions-repo')
const logger = require('../observability/logger')

class ContextStore {
  constructor(sessionId, workdir) {
    this.sessionId = sessionId
    this.workdir = workdir || process.cwd()
    createSession(sessionId, this.workdir, null, new Date().toISOString())
    logger.debug({ sessionId: this.sessionId }, 'store initialized')
  }

  append(type, data) {
    appendEvent(this.sessionId, type, new Date().toISOString(), data)
  }

  flag(note) {
    this.append('decision', { note })
  }

  export() {
    const session = getSession(this.sessionId)
    const events = getEvents(this.sessionId)
    return { sessionId: this.sessionId, workdir: this.workdir, ...(session || {}), events }
  }

  buildReviewPrompt() {
    const data = this.export()
    const decisions = data.events.filter(e => e.type === 'decision')
    const diffs = data.events.filter(e => e.type === 'diff')
    const io = data.events.filter(e => e.type === 'output' || e.type === 'input')

    const lines = [
      `# Session Review: ${this.sessionId}`,
      `Workdir: ${this.workdir}`,
      '',
      '## Flagged Decisions',
      decisions.length ? decisions.map(d => `- ${d.note}`).join('\n') : '(none)',
      '',
      '## File Diffs',
      diffs.length ? diffs.map(d => `### ${d.file}\n\`\`\`diff\n${d.patch || ''}\n\`\`\``).join('\n') : '(none)',
      '',
      '## I/O Log (condensed)',
      io.slice(-100).map(e => `[${e.type}] ${String(e.raw || '').slice(0, 200)}`).join('\n'),
      '',
      '## Review Instructions',
      'Review this session. For each flagged decision, say whether it makes sense and suggest an alternative if not. Flag any code that contradicts the stated decisions. List what is missing. Rate overall quality 1-10 with reasoning.',
    ]
    return lines.join('\n')
  }
}

module.exports = { ContextStore }
