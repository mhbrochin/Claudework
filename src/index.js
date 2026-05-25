const { createSession } = require('./capture/pty-session')
const { ContextStore } = require('./context/store')
const { startServer } = require('./ui/server')
const { launchReviewer } = require('./launcher/reviewer')
const { isConfigured } = require('./config/agent-config')

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err)
})

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
})

async function main() {
  if (!isConfigured('codex')) {
    console.warn('[config] OPENAI_API_KEY not set — codex sessions will fail. Add it to .env')
  }
  const storeFactory = (sessionId, workdir) => new ContextStore(sessionId, workdir)
  startServer({ store: storeFactory, createSession, launchReviewer })
}

main().catch((err) => {
  console.error('[startup error]', err)
  process.exit(1)
})
