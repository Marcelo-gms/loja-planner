const { randomId, safeEqual } = require('./util');

/**
 * CSRF: o token só é criado quando uma página com formulário usa `csrf` (a página de vendas não cria sessão).
 * Todo POST (menos webhooks) precisa mandar `_csrf`.
 */
function csrf(req, res, next) {
  res.locals.csrfToken = () => {
    if (!req.session.csrf) req.session.csrf = randomId(16);
    return req.session.csrf;
  };
  if (req.method !== 'POST' || req.path.startsWith('/webhooks/')) return next();
  const sent = req.body?._csrf;
  if (sent && req.session.csrf && safeEqual(sent, req.session.csrf)) return next();
  return res.status(403).render('mensagem', {
    title: 'Página expirada', text: 'Volte, recarregue a página e tente de novo.', back: req.get('referer') || '/',
  });
}

/** Limite simples por IP (em memória) */
function rateLimit(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const list = (hits.get(req.ip) || []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(req.ip, list);
    if (hits.size > 5000) hits.clear();
    if (list.length > max) {
      return res.status(429).render('mensagem', { title: 'Calma aí ✿', text: 'Muitas tentativas seguidas. Espere alguns minutos e tente de novo.' });
    }
    return next();
  };
}

/** Cabeçalhos de segurança básicos */
function headers(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
  });
  next();
}

module.exports = { csrf, rateLimit, headers };
