const { createSession } = require('./capture/pty-session')
const { ContextStore } = require('./context/store')
const { startServer } = require('./ui/server')
const { launchReviewer } = require('./launcher/reviewer')

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err)
})

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
})

async function main() {
  const storeFactory = (sessionId, workdir) => new ContextStore(sessionId, workdir)
  startServer({ store: storeFactory, createSession, launchReviewer })
}

main().catch((err) => {
  console.error('[startup error]', err)
  process.exit(1)
})
