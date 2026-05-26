// Context store — persists session events (I/O, diffs, flagged decisions) to SQLite.
//
// INTERFACE CONTRACT (do not change exports):
//   new ContextStore(sessionId, workdir)
//     .append(type, data)                        — add an event
//     .flag(note)                                — shorthand for append('decision', { note })
//     .export()                                  → raw JSON
//     .buildReviewPrompt(reviewerOutput?, opts?) → formatted string prompt for the reviewer agent
//       reviewerOutput: optional string — if provided, builds a cross-check / debate-history prompt
//       opts: { focusHint?, primaryAgent? }
//     .buildSynthesisPrompt(rounds, taskPrompt)  → formatted final-synthesis prompt

const fs   = require('fs')
const path = require('path')
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

const MAX_OUTPUT_CHARS  = 40000   // ~10K tokens — enough for a full session analysis
const MAX_CMDS_CHARS    = 4000    // session commands section cap
const MAX_LISTING_CHARS = 2000    // file listing cap

class ContextStore {
  constructor(sessionId, workdir, agent = null) {
    this.sessionId = sessionId
    this.workdir = workdir || process.cwd()
    createSession(sessionId, this.workdir, agent, new Date().toISOString())
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
    const events  = getEvents(this.sessionId)
    return { sessionId: this.sessionId, workdir: this.workdir, ...(session || {}), events }
  }

  buildReviewPrompt(reviewerOutput = null, options = {}) {
    const { focusHint = '', primaryAgent = 'the primary agent' } = options
    const data      = this.export()
    const decisions = data.events.filter(e => e.type === 'decision')
    const diffs     = data.events.filter(e => e.type === 'diff' && !String(e.file || '').includes('contextbridge.db'))

    // Concatenate ALL output chunks first so cross-chunk escape sequences are complete
    const rawOutput   = data.events.filter(e => e.type === 'output').map(e => e.raw || '').join('')
    const cleanOutput = stripAnsi(rawOutput)
    const truncated   = cleanOutput.length > MAX_OUTPUT_CHARS
      ? '[...earlier output truncated...]\n\n' + cleanOutput.slice(-MAX_OUTPUT_CHARS)
      : cleanOutput

    // Session commands — deduplicated, control-chars stripped, capped
    const inputEvents = data.events.filter(e => e.type === 'input')
    const rawCmds = inputEvents
      .map(e => String(e.raw || '').replace(/[^\x20-\x7E\n\t]/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    const cmds = []
    for (let i = 0; i < rawCmds.length && cmds.length < 200; i++) {
      if (i === 0 || rawCmds[i] !== rawCmds[i - 1]) cmds.push(rawCmds[i])
    }

    // File listing — read at prompt-build time (not stored as an event)
    let fileListing = ''
    try {
      const entries = fs.readdirSync(this.workdir, { withFileTypes: true })
        .filter(d => !d.name.startsWith('.') && d.name !== 'node_modules')
        .map(d => d.isDirectory() ? d.name + '/' : d.name)
      fileListing = entries.join('\n')
    } catch (_) {}

    // Task events
    const taskEvents = data.events.filter(e => e.type === 'task')

    const lines = ['# Session Review', `Workdir: ${this.workdir}`, '']

    // Task — what the user asked the AI to do
    if (taskEvents.length) {
      lines.push('## Task')
      lines.push(taskEvents[0].prompt)
      lines.push('')
    }

    // Focus hint
    if (focusHint) {
      lines.push(`> **Focus for this review:** ${focusHint}`)
      lines.push('')
    }

    // File listing
    if (fileListing) {
      lines.push('## Files in Project')
      lines.push('```')
      lines.push(fileListing.slice(0, MAX_LISTING_CHARS))
      lines.push('```')
      lines.push('')
    }

    lines.push('## Context')
    lines.push(`${primaryAgent} session in: ${this.workdir}`)
    lines.push(`Navigate to that directory and read the codebase. Then follow ${primaryAgent}'s reasoning below and provide your independent assessment.`)
    lines.push('')

    if (decisions.length) {
      lines.push('## Flagged Decisions')
      lines.push(decisions.map(d => `- ${d.note}`).join('\n'))
      lines.push('')
    }

    if (cmds.length) {
      lines.push('## Session Commands')
      lines.push('```')
      lines.push(cmds.join('\n').slice(0, MAX_CMDS_CHARS))
      lines.push('```')
      lines.push('')
    }

    if (diffs.length) {
      lines.push('## File Changes During Session')
      lines.push(diffs.map(d => `### ${d.file}\n\`\`\`diff\n${d.patch || ''}\n\`\`\``).join('\n'))
      lines.push('')
    }

    lines.push(`## ${primaryAgent}'s Full Session Output`)
    lines.push(truncated)
    lines.push('')

    if (reviewerOutput) {
      // Debate history from volley rounds is formatted as "=== Round N — AGENT ===" blocks.
      // A single cross-check response is a raw string without that marker.
      const isDebateHistory = reviewerOutput.includes('=== Round ')
      // Cap: debate history is already pre-capped per round (~4K each); this is a safety net
      const MAX_REVIEWER_CHARS = 80000
      const reviewerTruncated  = reviewerOutput.length > MAX_REVIEWER_CHARS
        ? '[...earlier history truncated...]\n\n' + reviewerOutput.slice(-MAX_REVIEWER_CHARS)
        : reviewerOutput
      lines.push(isDebateHistory ? '## Debate History So Far' : '## Prior Reviewer Analysis')
      lines.push(reviewerTruncated)
      lines.push('')
      lines.push('## Cross-Check Instructions')
      lines.push(
        isDebateHistory
          ? 'You have the full debate history above. Continue the debate where it left off. ' +
            'Address specific points from the most recent round. Build on prior analysis. ' +
            'End your response with: VERDICT: CONVERGED or VERDICT: DIVERGED'
          : `You have ${primaryAgent}'s session output above and a prior reviewer's analysis. ` +
            'State clearly where you agree and disagree with the reviewer. ' +
            'Call out any contradictions. Provide your own synthesis and final rating 1-10.'
      )
    } else {
      lines.push('## Review Instructions')
      lines.push(
        'Review this session:\n' +
        '1. Navigate to the workdir and read the same code the primary agent analyzed\n' +
        '2. Independently assess code quality, architecture, and business logic\n' +
        `3. Compare your findings to ${primaryAgent}'s analysis above\n` +
        '4. For each flagged decision, say whether it makes sense and suggest alternatives\n' +
        '5. List what is missing or could be improved\n' +
        '6. Rate overall quality 1-10 with reasoning\n' +
        '7. End your response with: VERDICT: CONVERGED or VERDICT: DIVERGED'
      )
    }

    return lines.join('\n')
  }

  buildSynthesisPrompt(rounds = [], taskPrompt = '') {
    const lines = ['# Final Synthesis']
    if (taskPrompt) {
      lines.push(`**Task:** ${taskPrompt}`)
      lines.push('')
    }
    lines.push(`This is the conclusion of a ${rounds.length}-round exchange.`)
    lines.push('')
    rounds.forEach((r, i) => {
      const cap  = 8000
      const body = r.output && r.output.length > cap
        ? '[...truncated...]\n' + r.output.slice(-cap)
        : (r.output || '(no output captured)')
      lines.push(`## Round ${i + 1} — ${String(r.agent || 'unknown').toUpperCase()}`)
      lines.push(body)
      lines.push('')
    })
    lines.push('## Synthesis Instructions')
    lines.push(
      '1. Key points both AIs AGREED on\n' +
      '2. Key points they DISAGREED on\n' +
      '3. Recommended path forward (specific, actionable)\n' +
      '4. Final quality rating 1-10 with one sentence of justification\n' +
      '5. Top 3 action items for the developer'
    )
    return lines.join('\n')
  }
}

module.exports = { ContextStore }
