const { createSession } = require('./capture/pty-session')
const { ContextStore } = require('./context/store')
const { startServer } = require('./ui/server')
const { launchReviewer } = require('./launcher/reviewer')

async function main() {
  const store = new ContextStore()
  startServer({ store, createSession, launchReviewer })
}

main().catch(console.error)
