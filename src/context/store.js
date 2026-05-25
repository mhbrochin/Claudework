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

const fs = require('fs')
const path = require('path')

const ANSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[@-_]/g

function stripAnsi(s) {
  return String(s).replace(ANSI_REGEX, '')
}

class ContextStore {
  constructor(sessionId, workdir) {
    this.sessionId = sessionId
    this.workdir = workdir
    this.createdAt = new Date().toISOString()
    this.events = []

    this.sessionsDir = path.join(process.cwd(), 'sessions')
    this.filePath = path.join(this.sessionsDir, `${sessionId}.json`)

    fs.mkdirSync(this.sessionsDir, { recursive: true })
    this._persist()
  }

  append(type, data) {
    const event = {
      type,
      timestamp: new Date().toISOString(),
      data,
    }
    this.events.push(event)
    this._persist()
    return event
  }

  flag(note) {
    return this.append('decision', { note })
  }

  export() {
    return {
      sessionId: this.sessionId,
      workdir: this.workdir,
      createdAt: this.createdAt,
      events: this.events.slice(),
    }
  }

  buildReviewPrompt() {
    const decisions = this.events.filter(e => e.type === 'decision')
    const diffs = this.events.filter(e => e.type === 'diff')
    const io = this.events.filter(e => e.type === 'input' || e.type === 'output')

    const lines = []
    lines.push(`# Session Review: ${this.sessionId}`)
    lines.push('')
    lines.push('## Session Metadata')
    lines.push(`- Session ID: ${this.sessionId}`)
    lines.push(`- Working directory: ${this.workdir}`)
    lines.push(`- Created: ${this.createdAt}`)
    lines.push(`- Total events: ${this.events.length} (inputs/outputs: ${io.length}, diffs: ${diffs.length}, decisions: ${decisions.length})`)
    lines.push('')

    lines.push('## Flagged Decisions')
    if (decisions.length === 0) {
      lines.push('_No decisions flagged._')
    } else {
      decisions.forEach((d, i) => {
        const note = d.data && typeof d.data === 'object' ? (d.data.note ?? JSON.stringify(d.data)) : String(d.data)
        lines.push(`${i + 1}. [${d.timestamp}] ${note}`)
      })
    }
    lines.push('')

    lines.push('## File Diffs (unified)')
    if (diffs.length === 0) {
      lines.push('_No diffs recorded._')
    } else {
      diffs.forEach((d, i) => {
        const data = d.data || {}
        const file = data.file || data.path || `diff-${i + 1}`
        const patch = data.patch || data.diff || (typeof data === 'string' ? data : '')
        lines.push(`### ${file}  _(at ${d.timestamp})_`)
        lines.push('```diff')
        lines.push(patch || '(empty patch)')
        lines.push('```')
        lines.push('')
      })
    }

    lines.push('## I/O Log (ANSI stripped)')
    if (io.length === 0) {
      lines.push('_No I/O captured._')
    } else {
      lines.push('```')
      io.forEach(e => {
        const raw = typeof e.data === 'string' ? e.data : (e.data && (e.data.text ?? e.data.content)) ?? JSON.stringify(e.data)
        const clean = stripAnsi(raw).replace(/\r\n?/g, '\n').trim()
        if (!clean) return
        const tag = e.type === 'input' ? '>>>' : '<<<'
        lines.push(`${tag} ${clean.replace(/\n/g, `\n${tag === '>>>' ? '   ' : '   '}`)}`)
      })
      lines.push('```')
    }
    lines.push('')

    lines.push('## Review Instructions')
    lines.push('You are reviewing the session captured above. Please:')
    lines.push('1. Evaluate each flagged decision — was the reasoning sound, and was it carried out correctly?')
    lines.push('2. Flag contradictions between stated decisions, the diffs that were produced, and the I/O log.')
    lines.push('3. List gaps — missing tests, unhandled edge cases, unverified assumptions, or work that was started but not finished.')
    lines.push('4. Rate the overall quality of this session on a scale of 1-10, with a one-sentence justification.')
    lines.push('')
    lines.push('Respond with sections matching the four points above.')

    return lines.join('\n')
  }

  _persist() {
    const payload = JSON.stringify(this.export(), null, 2)
    fs.writeFileSync(this.filePath, payload)
  }
}

module.exports = { ContextStore }
