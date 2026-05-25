const { createSession } = require('./capture/pty-session')
const { ContextStore } = require('./context/store')
const { startServer } = require('./ui/server')
const { launchReviewer } = require('./launcher/reviewer')

async function main() {
  // Pass a factory so each session gets its own isolated store
  const storeFactory = (sessionId, workdir) => new ContextStore(sessionId, workdir)
  startServer({ store: storeFactory, createSession, launchReviewer })
}

main().catch(console.error)
