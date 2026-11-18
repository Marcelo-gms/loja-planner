const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { randomId, sha256 } = require('./util');

function createDb(cfg) {
  const pool = mysql.createPool({ ...cfg, waitForConnections: true, connectionLimit: 8, charset: 'utf8mb4', timezone: 'Z' });
  const q = async (sql, params) => (await pool.query(sql, params))[0];
  const one = async (sql, params) => (await q(sql, params))[0] || null;

  return {
    pool,
    q,
    one,

    async migrate() {
      const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8').replace(/--.*$/gm, '');
      for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) await pool.query(stmt);
    },

    // ------------------------------------------------------------ clientes
    customerById: (id) => one('SELECT * FROM customers WHERE id = ?', [id]),
    customerByEmail: (email) => one('SELECT * FROM customers WHERE email = ?', [String(email).toLowerCase()]),

    /** Cria ou atualiza pelo e-mail; devolve a linha */
    async upsertCustomer({ name, email, cpf = null, phone = null }) {
      await q(
        `INSERT INTO customers (name, email, cpf, phone) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), cpf = COALESCE(VALUES(cpf), cpf), phone = COALESCE(VALUES(phone), phone)`,
        [name, String(email).toLowerCase(), cpf, phone],
      );
      return this.customerByEmail(email);
    },

    setAsaasCustomer: (id, asaasId) => q('UPDATE customers SET asaas_customer_id = ? WHERE id = ?', [asaasId, id]),
    setPassword: (id, hash) => q('UPDATE customers SET password_hash = ? WHERE id = ?', [hash, id]),
    setOwner: (id, owner) => q('UPDATE customers SET owner_name = ? WHERE id = ?', [owner || null, id]),
    resetDownloads: (id) => q('UPDATE customers SET downloads = 0 WHERE id = ?', [id]),

    async hasAccess(customerId) {
      return !!(await one("SELECT id FROM orders WHERE customer_id = ? AND status = 'paid' LIMIT 1", [customerId]));
    },

    async logDownload(customerId, file, ip) {
      await q('INSERT INTO downloads (customer_id, file, ip) VALUES (?, ?, ?)', [customerId, file, ip || null]);
      await q('UPDATE customers SET downloads = downloads + 1 WHERE id = ?', [customerId]);
    },

    // ------------------------------------------------------------ tokens de senha (guardamos só o hash)
    async createPasswordToken(customerId, hours = 72) {
      const token = randomId(24);
      await q('INSERT INTO password_tokens (customer_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? HOUR))',
        [customerId, sha256(token), hours]);
      return token;
    },
    validPasswordToken: (token) => one(
      'SELECT * FROM password_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()', [sha256(token)],
    ),
    useToken: (id) => q('UPDATE password_tokens SET used_at = UTC_TIMESTAMP() WHERE id = ?', [id]),

    // ------------------------------------------------------------ pedidos
    async createOrder({ customerId, amountCents, method, installments = 1, status = 'pending' }) {
      const publicId = randomId(16);
      await q('INSERT INTO orders (public_id, customer_id, amount_cents, method, installments, status, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [publicId, customerId, amountCents, method, installments, status, status === 'paid' ? new Date() : null]);
      return this.orderByPublicId(publicId);
    },
    orderById: (id) => one('SELECT * FROM orders WHERE id = ?', [id]),
    orderByPublicId: (pid) => one('SELECT * FROM orders WHERE public_id = ?', [pid]),

    /** Acha o pedido de um pagamento do Asaas: id do pagamento, nossa referência ou o parcelamento */
    async orderForPayment(p) {
      return (p.id && await one('SELECT * FROM orders WHERE asaas_payment_id = ?', [p.id]))
        || (p.externalReference && await one('SELECT * FROM orders WHERE public_id = ?', [p.externalReference]))
        || (p.installment && await one('SELECT * FROM orders WHERE asaas_installment_id = ?', [p.installment]))
        || null;
    },

    attachPayment: (id, f) => q(
      `UPDATE orders SET asaas_payment_id = ?, asaas_installment_id = ?, invoice_url = ?, pix_payload = ?, pix_image = ?,
       pix_expires_at = ?, gateway_status = ? WHERE id = ?`,
      [f.paymentId, f.installmentId || null, f.invoiceUrl || null, f.pixPayload || null, f.pixImage || null, f.pixExpiresAt || null, f.gatewayStatus || null, id],
    ),

    /** true só na primeira vez que o pedido vira pago (evita e-mail duplicado) */
    async markPaid(id) {
      const r = await q("UPDATE orders SET status = 'paid', paid_at = COALESCE(paid_at, UTC_TIMESTAMP()) WHERE id = ? AND status <> 'paid'", [id]);
      return r.affectedRows === 1;
    },
    setOrderStatus: (id, status, onlyIf = null) => q(
      `UPDATE orders SET status = ? WHERE id = ?${onlyIf ? ' AND status = ?' : ''}`, onlyIf ? [status, id, onlyIf] : [status, id],
    ),
    setGatewayStatus: (id, s) => q('UPDATE orders SET gateway_status = ? WHERE id = ?', [s, id]),
    ordersOfCustomer: (cid) => q('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC', [cid]),

    // ------------------------------------------------------------ webhooks
    async recordEvent(eventId, event, paymentId, payload) {
      const r = await q('INSERT IGNORE INTO webhook_events (event_id, event, payment_id, payload) VALUES (?, ?, ?, ?)',
        [eventId, event, paymentId || null, payload]);
      return r.affectedRows === 1;
    },
    setEventResult: (eventId, result) => q('UPDATE webhook_events SET result = ? WHERE event_id = ?', [result, eventId]),
    forgetEvent: (eventId) => q('DELETE FROM webhook_events WHERE event_id = ?', [eventId]),
    recentEvents: (limit = 30) => q('SELECT * FROM webhook_events ORDER BY id DESC LIMIT ?', [limit]),

    // ------------------------------------------------------------ admin
    async stats() {
      return one(`SELECT
        SUM(status = 'paid') AS paid, SUM(CASE WHEN status = 'paid' THEN amount_cents ELSE 0 END) AS revenue,
        SUM(status = 'pending') AS pending, SUM(status IN ('refunded','chargeback')) AS refunded,
        SUM(status = 'paid' AND paid_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)) AS paid24h
        FROM orders WHERE method <> 'MANUAL'`);
    },
    async listOrders({ search = '', status = '', limit = 100 } = {}) {
      const like = `%${search}%`;
      return q(
        `SELECT o.*, c.name, c.email, c.owner_name, c.downloads, c.password_hash IS NOT NULL AS has_password
         FROM orders o JOIN customers c ON c.id = o.customer_id
         WHERE (? = '' OR c.email LIKE ? OR c.name LIKE ? OR o.public_id LIKE ? OR o.asaas_payment_id LIKE ?)
           AND (? = '' OR o.status = ?)
         ORDER BY o.id DESC LIMIT ?`,
        [search, like, like, like, like, status, status, limit],
      );
    },

    end: () => pool.end(),
  };
}

module.exports = { createDb };
