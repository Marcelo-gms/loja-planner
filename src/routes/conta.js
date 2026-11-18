/**
 * Login da área de membros: entrar, sair, esqueci a senha, criar/redefinir senha.
 */
const express = require('express');
const { rateLimit } = require('../security');
const { checkPassword, hashPassword, validEmail } = require('../util');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Troca o id da sessão no login (evita fixação de sessão) e preserva o destino */
function login(req, customerId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.customerId = customerId;
      return req.session.save((e) => (e ? reject(e) : resolve()));
    });
  });
}

module.exports = function contaRoutes({ db, shop }) {
  const r = express.Router();
  const safeNext = (n) => (typeof n === 'string' && /^\/area(\/|$|\?)/.test(n) ? n : '/area');

  r.get('/entrar', (req, res) => {
    if (req.session.customerId) return res.redirect(303, '/area');
    const notice = req.query.ja ? 'Você já comprou com esse e-mail. Entre para acessar o seu planner ✿'
      : req.query.pago ? 'Pagamento confirmado! Entre com sua senha.'
        : req.query.senha ? 'Senha criada! Agora é só entrar.' : '';
    return res.render('conta/entrar', { title: 'Entrar', email: req.query.email || '', next: safeNext(req.query.next), notice, error: '' });
  });

  r.post('/entrar', rateLimit(10, 15 * 60000), wrap(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const customer = validEmail(email) ? await db.customerByEmail(email) : null;
    const ok = customer && customer.password_hash && await checkPassword(req.body.password || '', customer.password_hash);
    if (!ok) {
      const error = customer && !customer.password_hash
        ? 'Você ainda não criou sua senha. Use "Esqueci minha senha" para receber o link.'
        : 'E-mail ou senha incorretos.';
      return res.status(401).render('conta/entrar', { title: 'Entrar', email, next: safeNext(req.body.next), notice: '', error });
    }
    await login(req, customer.id);
    return res.redirect(303, safeNext(req.body.next));
  }));

  r.post('/sair', (req, res, next) => req.session.destroy((err) => (err ? next(err) : res.redirect(303, '/entrar'))));

  r.get('/esqueci-senha', (req, res) => res.render('conta/esqueci', { title: 'Esqueci minha senha', sent: false, email: req.query.email || '' }));

  r.post('/esqueci-senha', rateLimit(5, 15 * 60000), wrap(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const customer = validEmail(email) ? await db.customerByEmail(email) : null;
    if (customer && await db.hasAccess(customer.id)) await shop.sendResetEmail(customer);
    // mesma resposta sempre: não revela quem é cliente
    res.render('conta/esqueci', { title: 'Esqueci minha senha', sent: true, email });
  }));

  r.get('/criar-senha/:token', wrap(async (req, res) => {
    const t = await db.validPasswordToken(req.params.token);
    if (!t) {
      return res.status(410).render('mensagem', {
        title: 'Link expirado', text: 'Este link já foi usado ou expirou. Peça um novo em "Esqueci minha senha".', back: '/esqueci-senha',
      });
    }
    const customer = await db.customerById(t.customer_id);
    return res.render('conta/criar-senha', {
      title: customer.password_hash ? 'Nova senha' : 'Crie sua senha', customer, token: req.params.token, welcome: !!req.query['boas-vindas'], error: '',
    });
  }));

  r.post('/criar-senha/:token', rateLimit(10, 15 * 60000), wrap(async (req, res) => {
    const t = await db.validPasswordToken(req.params.token);
    if (!t) return res.redirect(303, `/criar-senha/${encodeURIComponent(req.params.token)}`);
    const customer = await db.customerById(t.customer_id);
    const pass = String(req.body.password || '');
    let error = '';
    if (pass.length < 8) error = 'A senha precisa ter pelo menos 8 caracteres.';
    else if (pass !== String(req.body.confirm || '')) error = 'As duas senhas não são iguais.';
    if (error) {
      return res.status(422).render('conta/criar-senha', { title: 'Crie sua senha', customer, token: req.params.token, welcome: false, error });
    }
    await db.setPassword(customer.id, await hashPassword(pass));
    await db.useToken(t.id);
    await login(req, customer.id);
    return res.redirect(303, '/area?bem-vinda=1');
  }));

  return r;
};
