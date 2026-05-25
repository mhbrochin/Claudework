// Context store — persists session events (I/O, diffs, flagged decisions) to SQLite.
//
// INTERFACE CONTRACT (do not change exports):
//   new ContextStore(sessionId, workdir)
//     .append(type, data)                        — add an event
//     .flag(note)                                — shorthand for append('decision', { note })
//     .export()                                  → raw JSON
//     .buildReviewPrompt(reviewerOutput?)        → formatted string prompt for the reviewer agent
//       reviewerOutput: optional string — if provided, builds a cross-check prompt instead

const { createSession, appendEvent, getSession, getEvents } = require('../db/sessions-repo')
const logger = require('../observability/logger')

// Strip ANSI/VT escape sequences from a concatenated terminal output string.
// Operates on the FULL string (not per-chunk) so sequences split across PTY chunks are caught.
const ANSI_RE = new RegExp(
  '\\x1b(?:' +
  '\\[[0-9;?]*[A-Za-z~]' +                       // CSI: ESC [ ... letter or ~ (incl. bracketed paste [200~,[201~)
  '|\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)' +      // OSC: terminated by BEL or ST (ESC \)
  '|P[^\\x1b]*(?:\\x1b\\\\|$)' +                 // DCS: ESC P ... ST (device control strings)
  '|[^[\\]P]' +                                   // other two-char escapes (ESC + single char)
  ')',
  'g'
)

function stripAnsi(str) {
  return str
    .replace(ANSI_RE, '')
    .replace(/[^\x20-\x7E\n\r\t]/g, '')   // remove remaining non-printable bytes
    .replace(/\r\n|\r/g, '\n')             // normalise line endings
    .replace(/\n{3,}/g, '\n\n')            // collapse excessive blank lines
    .trim()
}

const MAX_OUTPUT_CHARS = 40000   // ~10K tokens — enough for a full session analysis

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

  buildReviewPrompt(reviewerOutput = null) {
    const data = this.export()
    const decisions = data.events.filter(e => e.type === 'decision')
    const diffs     = data.events.filter(e => e.type === 'diff' && !String(e.file || '').includes('contextbridge.db'))

    // Concatenate ALL output chunks first so cross-chunk escape sequences are complete
    const rawOutput = data.events.filter(e => e.type === 'output').map(e => e.raw || '').join('')
    const cleanOutput = stripAnsi(rawOutput)
    const truncated = cleanOutput.length > MAX_OUTPUT_CHARS
      ? '[...earlier output truncated...]\n\n' + cleanOutput.slice(-MAX_OUTPUT_CHARS)
      : cleanOutput

    const lines = [
      '# Session Review',
      `Workdir: ${this.workdir}`,
      '',
      '## Context',
      `Claude Code session in: ${this.workdir}`,
      'Navigate to that directory and read the codebase. Then follow Claude\'s reasoning below and provide your independent assessment.',
      '',
    ]

    if (decisions.length) {
      lines.push('## Flagged Decisions')
      lines.push(decisions.map(d => `- ${d.note}`).join('\n'))
      lines.push('')
    }

    if (diffs.length) {
      lines.push('## File Changes During Session')
      lines.push(diffs.map(d => `### ${d.file}\n\`\`\`diff\n${d.patch || ''}\n\`\`\``).join('\n'))
      lines.push('')
    }

    lines.push("## Claude's Full Session Output")
    lines.push(truncated)
    lines.push('')

    if (reviewerOutput) {
      // Cap reviewer output to the same limit as primary output to keep total prompt bounded.
      const MAX_REVIEWER_CHARS = 20000
      const reviewerTruncated = reviewerOutput.length > MAX_REVIEWER_CHARS
        ? '[...reviewer output truncated...]\n\n' + reviewerOutput.slice(-MAX_REVIEWER_CHARS)
        : reviewerOutput
      lines.push('## Prior Reviewer Analysis')
      lines.push(reviewerTruncated)
      lines.push('')
      lines.push('## Cross-Check Instructions')
      lines.push(
        'You have Claude\'s session output above and a prior reviewer\'s analysis. ' +
        'State clearly where you agree and disagree with the reviewer. ' +
        'Call out any contradictions. Provide your own synthesis and final rating 1-10.'
      )
    } else {
      lines.push('## Review Instructions')
      lines.push(
        'Review this session:\n' +
        '1. Navigate to the workdir and read the same code Claude analyzed\n' +
        '2. Independently assess code quality, architecture, and business logic\n' +
        '3. Compare your findings to Claude\'s analysis above\n' +
        '4. For each flagged decision, say whether it makes sense and suggest alternatives\n' +
        '5. List what is missing or could be improved\n' +
        '6. Rate overall quality 1-10 with reasoning'
      )
    }

    return lines.join('\n')
  }
}

module.exports = { ContextStore }
