const Database = require('better-sqlite3')
const path = require('path')

const DB_PATH = path.join(process.cwd(), 'contextbridge.db')

let _db

function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH)
    _db.pragma('journal_mode = WAL')
    _db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        workdir TEXT,
        agent TEXT,
        created_at TEXT,
        ended_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT REFERENCES sessions(id),
        type TEXT,
        timestamp TEXT,
        data TEXT
      );
    `)
    migrateJsonFiles()
  }
  return _db
}

function migrateJsonFiles() {
  const fs = require('fs')
  const sessionsDir = path.join(process.cwd(), 'sessions')
  if (!fs.existsSync(sessionsDir)) return
  const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'))
  const db = _db
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), 'utf8'))
      const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(data.sessionId)
      if (existing) continue
      db.prepare('INSERT INTO sessions (id, workdir, created_at) VALUES (?, ?, ?)').run(
        data.sessionId, data.workdir || null, data.createdAt || new Date().toISOString()
      )
      for (const event of (data.events || [])) {
        db.prepare('INSERT INTO events (session_id, type, timestamp, data) VALUES (?, ?, ?, ?)').run(
          data.sessionId, event.type, event.ts || new Date().toISOString(), JSON.stringify(event)
        )
      }
    } catch (_) {}
  }
}

module.exports = { getDb }
