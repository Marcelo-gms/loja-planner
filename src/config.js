const path = require('path');

const ROOT = path.join(__dirname, '..');
const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
const MIN_INSTALLMENT_CENTS = 500; // parcela mínima de R$ 5,00

function loadConfig(env = process.env) {
  const priceCents = Math.round(Number(String(env.PRODUCT_PRICE || '47').replace(',', '.')) * 100);
  const maxInstallments = Math.max(1, Math.min(
    Number(env.MAX_INSTALLMENTS || 12), 12, Math.floor(priceCents / MIN_INSTALLMENT_CENTS) || 1,
  ));
  return {
    port: Number(env.PORT || 3000),
    appUrl: String(env.APP_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, ''),
    production: env.NODE_ENV === 'production',
    sessionSecret: env.SESSION_SECRET || '',
    db: {
      host: env.DB_HOST || 'localhost',
      port: Number(env.DB_PORT || 3306),
      user: env.DB_USERNAME || 'root',
      password: env.DB_PASSWORD || '',
      database: env.DB_DATABASE || 'loja',
    },
    asaas: {
      env: env.ASAAS_ENV === 'production' ? 'production' : 'sandbox',
      apiKey: env.ASAAS_API_KEY || '',
      webhookToken: env.ASAAS_WEBHOOK_TOKEN || '',
    },
    offer: {
      priceCents,
      maxInstallments,
      guaranteeDays: Number(env.GUARANTEE_DAYS || 7),
    },
    smtp: {
      host: env.SMTP_HOST || '',
      port: Number(env.SMTP_PORT || 465),
      secure: String(env.SMTP_SECURE || 'true') === 'true',
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASSWORD || '',
      from: env.MAIL_FROM || 'Meu Ano Leve <nao-responda@localhost>',
    },
    supportEmail: env.SUPPORT_EMAIL || '',
    admin: { email: String(env.ADMIN_EMAIL || '').toLowerCase(), password: env.ADMIN_PASSWORD || '' },
    productDir: abs(env.PRODUCT_DIR || 'produto'),
    cacheDir: abs(env.CACHE_DIR || 'storage/cache'),
    cacheDays: Number(env.CACHE_DAYS || 7),
    maxDownloads: Number(env.MAX_DOWNLOADS || 40),
  };
}

module.exports = { loadConfig, ROOT };
