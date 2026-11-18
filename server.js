#!/usr/bin/env node
/**
 * Loja do planner: página de vendas + pagamento (Asaas) + área de membros.
 * A porta vem de process.env.PORT (exigido no deploy da Integrator).
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { loadConfig } = require('./src/config');
const { createDb } = require('./src/db');
const { loadCatalog } = require('./src/catalog');
const { createMailer } = require('./src/mailer');
const { createPersonalizer } = require('./src/personalize');
const { createAsaas } = require('./src/asaas');
const { createShop } = require('./src/shop');
const { createApp } = require('./src/app');

const PORT = process.env.PORT || 3000;

(async () => {
  const config = loadConfig();
  if (!config.sessionSecret) console.warn('⚠ SESSION_SECRET vazio: defina um valor aleatório no .env');
  if (!config.asaas.apiKey) console.warn('⚠ ASAAS_API_KEY vazio: o checkout não vai funcionar');
  if (!config.asaas.webhookToken) console.warn('⚠ ASAAS_WEBHOOK_TOKEN vazio: todos os webhooks serão recusados');

  const catalog = loadCatalog(config.productDir);
  const db = createDb(config.db);
  await db.migrate();

  const personalizer = createPersonalizer({ cacheDir: config.cacheDir, cacheDays: config.cacheDays, ink: catalog.ink });
  personalizer.cleanup();
  setInterval(() => personalizer.cleanup(), 12 * 3600 * 1000).unref();

  const asaas = createAsaas({ apiKey: config.asaas.apiKey, env: config.asaas.env });
  const shop = createShop({ config, db, asaas, mailer: createMailer(config.smtp), catalog });
  const app = createApp({ config, db, shop, catalog, personalizer });

  app.listen(PORT, () => {
    console.log(`Loja "${catalog.name} ${catalog.year}" no ar na porta ${PORT} — ${config.appUrl}`);
    console.log(`Asaas: ${config.asaas.env} · webhook: ${config.appUrl}/webhooks/asaas`);
  });
})().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
