require('dotenv').config()

const { execSync } = require('child_process')
const os = require('os')
const fs = require('fs')
const path = require('path')

// Common install locations on macOS for npm-global CLI tools
const CLAUDE_FALLBACKS = [
  process.env.CLAUDE_BIN,
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
  path.join(os.homedir(), '.nvm', 'versions', 'node', _nvmCurrentVersion(), 'bin', 'claude'),
  _npmGlobalBin('claude'),
].filter(Boolean)

const CODEX_FALLBACKS = [
  process.env.CODEX_BIN,
  '/usr/local/bin/codex',
  '/opt/homebrew/bin/codex',
  path.join(os.homedir(), '.nvm', 'versions', 'node', _nvmCurrentVersion(), 'bin', 'codex'),
  _npmGlobalBin('codex'),
].filter(Boolean)

function _nvmCurrentVersion() {
  try {
    const alias = fs.readFileSync(path.join(os.homedir(), '.nvm', 'alias', 'default'), 'utf8').trim()
    // resolve symlink aliases (e.g. "lts/*" → "v20.11.0")
    const resolved = execSync(`bash -lc "nvm version ${alias}" 2>/dev/null`, { timeout: 3000 }).toString().trim()
    return resolved || alias
  } catch (_) { return 'current' }
}

function _npmGlobalBin(name) {
  try {
    const prefix = execSync('npm config get prefix', { timeout: 3000 }).toString().trim()
    return path.join(prefix, 'bin', name)
  } catch (_) { return null }
}

function resolveBin(cliName, fallbacks) {
  // 1. Try login shell which
  try {
    const loginShell = process.env.SHELL || '/bin/bash'
    const result = execSync(`${loginShell} -lc "which ${cliName}"`, { timeout: 5000 }).toString().trim()
    if (result && fs.existsSync(result)) return result
  } catch (_) {}
  // 2. Try known paths
  for (const p of fallbacks) {
    try { if (p && fs.existsSync(p)) return p } catch (_) {}
  }
  return null
}

function loadConfig() {
  const claudeBin = resolveBin('claude', CLAUDE_FALLBACKS)
  const codexBin = resolveBin('codex', CODEX_FALLBACKS)

  return {
    claude: {
      bin: claudeBin,
      env: { ...process.env, HOME: process.env.HOME || os.homedir() },
    },
    codex: {
      bin: codexBin,
      env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY },
    },
  }
}

function isConfigured(agent) {
  if (agent === 'claude') {
    const bin = resolveBin('claude', CLAUDE_FALLBACKS)
    return !!bin
  }
  if (agent === 'codex') return !!process.env.OPENAI_API_KEY
  return false
}

function getAgentStatus() {
  const claudeBin = resolveBin('claude', CLAUDE_FALLBACKS)
  return {
    claude: {
      found: !!claudeBin,
      path: claudeBin || 'not found — install with: npm install -g @anthropic-ai/claude-code',
    },
    codex: {
      found: !!resolveBin('codex', CODEX_FALLBACKS),
      apiKey: !!process.env.OPENAI_API_KEY,
      path: resolveBin('codex', CODEX_FALLBACKS) || 'not found — install with: npm install -g @openai/codex',
    },
  }
}

module.exports = { loadConfig, isConfigured, getAgentStatus }
