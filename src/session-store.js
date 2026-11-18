/**
 * Sessões de login guardadas no MySQL (tabela `sessions`): sobrevivem a reinícios e deploys.
 */
const session = require('express-session');

class MysqlStore extends session.Store {
  constructor(db, { ttlMs = 30 * 86400000 } = {}) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;
    this.timer = setInterval(() => this.db.q('DELETE FROM sessions WHERE expires < ?', [Date.now()]).catch(() => {}), 3600000);
    this.timer.unref();
  }

  expiry(sess) {
    const exp = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : 0;
    return exp || Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    this.db.one('SELECT data, expires FROM sessions WHERE sid = ?', [sid])
      .then((row) => cb(null, row && row.expires > Date.now() ? JSON.parse(row.data) : null))
      .catch(cb);
  }

  set(sid, sess, cb = () => {}) {
    this.db.q('REPLACE INTO sessions (sid, data, expires) VALUES (?, ?, ?)', [sid, JSON.stringify(sess), this.expiry(sess)])
      .then(() => cb(null)).catch(cb);
  }

  touch(sid, sess, cb = () => {}) {
    this.db.q('UPDATE sessions SET expires = ? WHERE sid = ?', [this.expiry(sess), sid]).then(() => cb(null)).catch(cb);
  }

  destroy(sid, cb = () => {}) {
    this.db.q('DELETE FROM sessions WHERE sid = ?', [sid]).then(() => cb(null)).catch(cb);
  }
}

module.exports = { MysqlStore };
