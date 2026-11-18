/**
 * Painel /admin: vendas, pedidos, ações (reenviar acesso, zerar downloads, bloquear/liberar, consultar Asaas),
 * acesso manual e log dos webhooks. Login com ADMIN_EMAIL + ADMIN_PASSWORD.
 */
const express = require('express');
const { rateLimit } = require('../security');
const { safeEqual, validEmail, money } = require('../util');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = function adminRoutes({ config, db, shop }) {
  const r = express.Router();
  const enabled = () => config.admin.email && config.admin.password.length >= 8;

  r.use('/admin', (req, res, next) => {
    if (!enabled()) return res.status(404).render('mensagem', { title: 'Painel desativado', text: 'Defina ADMIN_EMAIL e ADMIN_PASSWORD (8+ caracteres).' });
    res.locals.money = money;
    res.locals.admin = true;
    if (req.path === '/entrar' || req.session.admin) return next();
    return res.redirect(303, '/admin/entrar');
  });

  r.get('/admin/entrar', (req, res) => res.render('admin/entrar', { title: 'Admin', error: '' }));
  r.post('/admin/entrar', rateLimit(8, 15 * 60000), (req, res, next) => {
    const ok = safeEqual(String(req.body.email || '').toLowerCase(), config.admin.email)
      & safeEqual(String(req.body.password || ''), config.admin.password);
    if (!ok) return res.status(401).render('admin/entrar', { title: 'Admin', error: 'E-mail ou senha incorretos.' });
    return req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.admin = true;
      return req.session.save(() => res.redirect(303, '/admin'));
    });
  });
  r.post('/admin/sair', (req, res) => req.session.destroy(() => res.redirect(303, '/admin/entrar')));

  r.get('/admin', wrap(async (req, res) => {
    const search = String(req.query.q || '').trim();
    const status = String(req.query.status || '');
    res.set('Cache-Control', 'no-store').render('admin/index', {
      title: 'Admin', stats: await db.stats(), orders: await db.listOrders({ search, status }), search, status, flash: req.query.ok || '',
      maxDownloads: config.maxDownloads,
    });
  }));

  r.get('/admin/webhooks', wrap(async (req, res) => {
    res.render('admin/webhooks', { title: 'Webhooks', events: await db.recentEvents(50) });
  }));

  r.post('/admin/liberar', wrap(async (req, res) => {
    const name = String(req.body.name || '').trim() || 'Cliente';
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!validEmail(email)) return res.redirect(303, '/admin?ok=E-mail inválido');
    await shop.grantManual({ name, email });
    return res.redirect(303, `/admin?ok=${encodeURIComponent(`Acesso liberado e enviado para ${email}`)}`);
  }));

  r.post('/admin/pedidos/:id/:acao', wrap(async (req, res) => {
    const order = await db.orderById(Number(req.params.id));
    if (!order) return res.redirect(303, '/admin?ok=Pedido não encontrado');
    const customer = await db.customerById(order.customer_id);
    const actions = {
      reenviar: async () => { await shop.sendAccessEmail(customer); return 'E-mail de acesso reenviado'; },
      zerar: async () => { await db.resetDownloads(customer.id); return 'Downloads zerados'; },
      bloquear: async () => { await db.setOrderStatus(order.id, 'refunded'); return 'Acesso bloqueado'; },
      liberar: async () => { await shop.confirmPaid(order); await db.setOrderStatus(order.id, 'paid'); return 'Pedido marcado como pago'; },
      consultar: async () => { const o = await shop.sync({ ...order, status: order.status === 'paid' ? 'x' : order.status }); return `Asaas: ${o.gateway_status || '?'}`; },
    };
    const run = actions[req.params.acao];
    if (!run) return res.status(404).end();
    const msg = await run();
    return res.redirect(303, `/admin?ok=${encodeURIComponent(`${msg} (pedido #${order.id})`)}`);
  }));

  return r;
};
