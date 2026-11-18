const express = require('express');
const { safeEqual } = require('../util');

/**
 * Webhook do Asaas: POST /webhooks/asaas
 * Autenticação: header `asaas-access-token` = token cadastrado no Asaas (ASAAS_WEBHOOK_TOKEN).
 * Cada evento tem `id` único: reenvios são ignorados. Responde 200 rápido; se o processamento falhar,
 * responde 500 e o Asaas tenta de novo.
 */
module.exports = function webhookRoutes({ config, db, shop, log = console }) {
  const r = express.Router();

  r.post('/webhooks/asaas', express.json({ limit: '1mb' }), async (req, res) => {
    const token = req.get('asaas-access-token') || '';
    if (!config.asaas.webhookToken || !safeEqual(token, config.asaas.webhookToken)) {
      log.warn(`[webhook] token inválido (${req.ip})`);
      return res.status(401).json({ error: 'unauthorized' });
    }
    const body = req.body || {};
    const eventId = String(body.id || `${body.event}:${body.payment?.id}`);
    try {
      if (!(await db.recordEvent(eventId, String(body.event || '?'), body.payment?.id, JSON.stringify(body)))) {
        return res.json({ received: true, duplicate: true });
      }
      try {
        const result = await shop.handleWebhook(body);
        await db.setEventResult(eventId, result);
        return res.json({ received: true, result });
      } catch (e) {
        await db.forgetEvent(eventId); // o Asaas vai reenviar
        throw e;
      }
    } catch (e) {
      log.error(`[webhook] ${eventId}: ${e.stack || e.message}`);
      return res.status(500).json({ error: 'retry' });
    }
  });

  return r;
};
