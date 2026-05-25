require('dotenv').config()

const { execSync } = require('child_process')

function resolveBin(cliName, envVar, fallback) {
  try {
    const result = execSync(`bash -lc "which ${cliName}"`, { timeout: 5000 }).toString().trim()
    if (result) return result
  } catch (_) {}
  return process.env[envVar] || fallback
}

function loadConfig() {
  const claudeBin = resolveBin('claude', 'CLAUDE_BIN', '/usr/local/bin/claude')
  const codexBin = resolveBin('codex', 'CODEX_BIN', '/usr/local/bin/codex')

  return {
    claude: {
      bin: claudeBin,
      env: { ...process.env, HOME: process.env.HOME || require('os').homedir() },
    },
    codex: {
      bin: codexBin,
      env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY },
    },
  }
}

function isConfigured(agent) {
  if (agent === 'claude') return true
  if (agent === 'codex') return !!process.env.OPENAI_API_KEY
  return false
}

module.exports = { loadConfig, isConfigured }
