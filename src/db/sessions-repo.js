const { getDb } = require('./database')

function createSession(id, workdir, agent, createdAt) {
  getDb().prepare('INSERT INTO sessions (id, workdir, agent, created_at) VALUES (?, ?, ?, ?)').run(id, workdir, agent || null, createdAt)
}

function appendEvent(sessionId, type, timestamp, data) {
  getDb().prepare('INSERT INTO events (session_id, type, timestamp, data) VALUES (?, ?, ?, ?)').run(sessionId, type, timestamp, JSON.stringify(data))
}

function getSession(id) {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id)
}

function getEvents(sessionId) {
  return getDb().prepare('SELECT * FROM events WHERE session_id = ? ORDER BY id ASC').all(sessionId).map(row => ({
    ...JSON.parse(row.data),
    type: row.type,
    ts: row.timestamp,
  }))
}

function listSessions() {
  return getDb().prepare('SELECT * FROM sessions ORDER BY created_at DESC').all()
}

function endSession(id, endedAt) {
  getDb().prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(endedAt, id)
}

module.exports = { createSession, appendEvent, getSession, getEvents, listSessions, endSession }
