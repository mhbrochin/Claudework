const { createSession } = require('./capture/pty-session')
const { ContextStore } = require('./context/store')
const { startServer } = require('./ui/server')
const { launchReviewer } = require('./launcher/reviewer')
const { isConfigured } = require('./config/agent-config')
const logger = require('./observability/logger')
const { initSentry } = require('./observability/errors')

process.on('uncaughtException', (err) => {
  logger.error({ err }, '[uncaughtException]')
})

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, '[unhandledRejection]')
})

async function main() {
  initSentry()
  if (!isConfigured('codex')) {
    logger.warn('[config] OPENAI_API_KEY not set — codex sessions will fail. Add it to .env')
  }
  const storeFactory = (sessionId, workdir) => new ContextStore(sessionId, workdir)
  startServer({ store: storeFactory, createSession, launchReviewer })
}

main().catch((err) => {
  logger.error({ err }, '[startup error]')
  process.exit(1)
})
