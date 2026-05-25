let _sentry = null

function initSentry() {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return
  try {
    const Sentry = require('@sentry/node')
    Sentry.init({ dsn })
    _sentry = Sentry
  } catch (_) {}
}

function captureException(err, context) {
  if (_sentry) {
    _sentry.captureException(err, { extra: context })
  }
}

module.exports = { initSentry, captureException }
