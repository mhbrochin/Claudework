// Review launcher — takes a completed ContextStore, formats it into a review
// prompt, and opens a new PTY session (claude or codex) pre-loaded with the
// full context from the prior session.
//
// INTERFACE CONTRACT (do not change exports):
//   launchReviewer(store, agent, workdir) → EventEmitter
//     store: ContextStore instance (completed session)
//     agent: 'claude' | 'codex'
//     workdir: path the reviewer should operate in
//     Returns the same EventEmitter interface as createSession()
//
// The review prompt injected into the agent must include:
//   1. What was built (summary from store)
//   2. Every flagged decision and its note
//   3. All file diffs in unified diff format
//   4. The full I/O log (condensed — strip raw terminal escape codes)
//   5. The review instruction:
//      "Review this session. For each flagged decision, say whether it makes sense
//       and suggest an alternative if not. Flag any code that contradicts the stated
//       decisions. List what is missing. Rate overall quality 1-10 with reasoning."

// TODO: implement in feature/review-launcher

function launchReviewer(store, agent, workdir) {
  throw new Error('Not implemented — see feature/review-launcher')
}

module.exports = { launchReviewer }
