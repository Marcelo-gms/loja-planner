const path = require('path');
const express = require('express');
const session = require('express-session');
const { MysqlStore } = require('./session-store');
const security = require('./security');
const { money } = require('./util');

function createApp({ config, db, shop, catalog, personalizer, log = console }) {
  const app = express();
  app.set('trust proxy', true); // atrás do proxy da hospedagem (HTTPS e IP real)
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.disable('x-powered-by');
  app.use(security.headers);

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.production ? '7d' : 0 }));

  // webhook antes de sessão/CSRF (vem do Asaas, não do navegador)
  app.use(require('./routes/webhooks')({ config, db, shop, log }));

  app.use(express.urlencoded({ extended: false, limit: '50kb' }));
  app.use(session({
    name: 'loja.sid',
    secret: config.sessionSecret || 'dev-inseguro-defina-SESSION_SECRET',
    store: new MysqlStore(db),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.production, maxAge: 30 * 86400000 },
  }));
  app.use((req, res, next) => {
    Object.assign(res.locals, {
      product: shop.product,
      productName: catalog.name,
      year: catalog.year,
      supportEmail: config.supportEmail,
      money,
      loggedIn: !!req.session.customerId,
      path: req.path,
    });
    next();
  });
  app.use(security.csrf);


  app.use(require('./routes/site')({ config, db, shop, catalog }));
  app.use(require('./routes/conta')({ db, shop }));
  app.use(require('./routes/area')({ config, db, catalog, personalizer, log }));
  app.use(require('./routes/admin')({ config, db, shop }));

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.use((req, res) => res.status(404).render('mensagem', { title: 'Página não encontrada', text: 'O endereço pode ter mudado.', back: '/' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log.error(err.stack || err);
    res.status(500).render('mensagem', { title: 'Ops, algo deu errado', text: 'Tente de novo em instantes. Se continuar, fale com a gente.', back: '/' });
  });

  return app;
}

module.exports = { createApp };
