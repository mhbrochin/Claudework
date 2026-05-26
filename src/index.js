// Ensure the NVM-managed node bin directory is in PATH so PTY sessions can
// find claude/codex even when the server is launched without a full NVM env
// (e.g. via a plain `node src/index.js` invocation).
;(function patchNvmPath() {
  const fs = require('fs'), path = require('path'), os = require('os')
  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm')
  // Use the "default" alias to find the active version
  let nvmBin = null
  try {
    const alias   = fs.readFileSync(path.join(nvmDir, 'alias', 'default'), 'utf8').trim()
    const vDir    = path.join(nvmDir, 'versions', 'node')
    // alias can be "lts/*", "v24", or a full "v24.16.0" — scan versions for a prefix match
    const versions = fs.readdirSync(vDir).sort().reverse()
    const normalized = alias.startsWith('v') ? alias : `v${alias}`
    const match = versions.find(v => v === normalized || v.startsWith(normalized.replace('*', '')))
    if (match) nvmBin = path.join(vDir, match, 'bin')
  } catch (_) {}
  if (nvmBin && fs.existsSync(nvmBin) && !(process.env.PATH || '').includes(nvmBin)) {
    process.env.PATH = `${nvmBin}${path.delimiter}${process.env.PATH || ''}`
  }
})()

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
  const storeFactory = (sessionId, workdir, agent) => new ContextStore(sessionId, workdir, agent)
  startServer({ store: storeFactory, createSession, launchReviewer })
}

main().catch((err) => {
  logger.error({ err }, '[startup error]')
  process.exit(1)
})
