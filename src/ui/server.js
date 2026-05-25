// Express + WebSocket server — serves the xterm.js frontend and bridges
// WebSocket messages between the browser and PTY sessions.
//
// INTERFACE CONTRACT (do not change exports):
//   startServer({ store, createSession, launchReviewer, port? })
//     Starts on port 3000 by default.
//     WebSocket message protocol:
//       browser → server: { type: 'input', sessionId, data }
//                         { type: 'start', agent, workdir }
//                         { type: 'review', sessionId, reviewerAgent }
//                         { type: 'flag', sessionId, note }
//       server → browser: { type: 'output', sessionId, data }
//                         { type: 'diff',   sessionId, file, patch }
//                         { type: 'ready',  sessionId }
//                         { type: 'exit',   sessionId, code }

// TODO: implement in feature/web-ui

function startServer({ store, createSession, launchReviewer, port = 3000 }) {
  throw new Error('Not implemented — see feature/web-ui')
}

module.exports = { startServer }
