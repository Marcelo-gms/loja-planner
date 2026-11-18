const express = require('express');
const { CheckoutError } = require('../shop');
const { rateLimit } = require('../security');
const { installmentOptions, onlyDigits, validCpf, validEmail, money } = require('../util');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = function siteRoutes({ config, db, shop, catalog }) {
  const r = express.Router();

  // ------------------------------------------------------------ página de vendas
  r.get('/', (req, res) => {
    res.render('vendas', { offer: shop.offerView(), catalog });
  });

  // ------------------------------------------------------------ checkout
  const checkoutView = (res, { values = {}, errors = {}, status = 200, notice = '' } = {}) => res.status(status).render('checkout', {
    title: 'Finalizar compra',
    offer: shop.offerView(),
    options: installmentOptions(config.offer.priceCents, config.offer.maxInstallments),
    values: { method: 'PIX', installments: '1', ...values },
    errors,
    notice,
  });

  r.get('/checkout', (req, res) => checkoutView(res));

  r.post('/checkout', rateLimit(10, 15 * 60000), wrap(async (req, res) => {
    const v = {
      name: String(req.body.name || '').trim().replace(/\s+/g, ' ').slice(0, 160),
      email: String(req.body.email || '').trim().toLowerCase().slice(0, 190),
      cpf: onlyDigits(req.body.cpf),
      phone: onlyDigits(req.body.phone).slice(0, 13),
      method: req.body.method === 'CREDIT_CARD' ? 'CREDIT_CARD' : 'PIX',
      installments: String(req.body.installments || '1'),
    };
    const errors = {};
    if (v.name.length < 3 || !v.name.includes(' ')) errors.name = 'Escreva seu nome completo.';
    if (!validEmail(v.email)) errors.email = 'Confira o e-mail: é para ele que o acesso vai.';
    if (!validCpf(v.cpf)) errors.cpf = 'CPF inválido.';
    if (v.phone && (v.phone.length < 10 || v.phone.length > 11)) errors.phone = 'Use DDD + número.';
    if (Object.keys(errors).length) return checkoutView(res, { values: req.body, errors, status: 422 });

    try {
      const result = await shop.checkout(v);
      if (result.alreadyCustomer) {
        return res.redirect(303, `/entrar?email=${encodeURIComponent(v.email)}&ja=1`);
      }
      return res.redirect(303, result.redirect);
    } catch (e) {
      if (e instanceof CheckoutError) return checkoutView(res, { values: req.body, notice: e.message, status: 502 });
      throw e;
    }
  }));

  // ------------------------------------------------------------ acompanhamento do pagamento
  async function loadOrder(req, res) {
    const order = /^[a-f0-9]{32}$/.test(req.params.pid) ? await db.orderByPublicId(req.params.pid) : null;
    if (!order) res.status(404).render('mensagem', { title: 'Pedido não encontrado', text: 'Confira o link ou faça um novo pedido.', back: '/checkout' });
    return order;
  }

  r.get('/pagamento/:pid', wrap(async (req, res) => {
    let order = await loadOrder(req, res);
    if (!order) return;
    order = await shop.sync(order);
    if (order.status === 'paid') return res.redirect(303, `/pagamento/${order.public_id}/acesso`);
    return res.render('pagamento', { title: 'Pagamento', order, amount: money(order.amount_cents, { always: true }) });
  }));

  r.get('/pagamento/:pid/status', wrap(async (req, res) => {
    let order = await loadOrder(req, res);
    if (!order) return;
    order = await shop.sync(order);
    res.set('Cache-Control', 'no-store').json({ status: order.status });
  }));

  /** Depois de pago: quem ainda não tem senha vai direto criar; quem tem, vai entrar */
  r.get('/pagamento/:pid/acesso', wrap(async (req, res) => {
    const order = await loadOrder(req, res);
    if (!order) return;
    if (order.status !== 'paid') return res.redirect(303, `/pagamento/${order.public_id}`);
    const customer = await db.customerById(order.customer_id);
    if (req.session.customerId === customer.id) return res.redirect(303, '/area');
    if (!customer.password_hash) {
      const token = await db.createPasswordToken(customer.id, 72);
      return res.redirect(303, `/criar-senha/${token}?boas-vindas=1`);
    }
    return res.redirect(303, `/entrar?email=${encodeURIComponent(customer.email)}&pago=1`);
  }));

  // ------------------------------------------------------------ páginas legais (revise os textos)
  for (const page of ['termos', 'privacidade', 'contato']) {
    r.get(`/${page}`, (req, res) => res.render(`legal-${page}`, { title: { termos: 'Termos de uso', privacidade: 'Privacidade', contato: 'Contato' }[page] }));
  }

  return r;
};
