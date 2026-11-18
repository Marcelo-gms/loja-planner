/**
 * Área de membros: nome na capa (prévia ao vivo), downloads personalizados, capas extras e guia.
 */
const express = require('express');
const { cleanName } = require('../personalize');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = function areaRoutes({ config, db, catalog, personalizer, log = console }) {
  const r = express.Router();

  // precisa estar logada e ter um pedido pago
  r.use('/area', wrap(async (req, res, next) => {
    if (!req.session.customerId) return res.redirect(303, `/entrar?next=${encodeURIComponent(req.originalUrl)}`);
    const customer = await db.customerById(req.session.customerId);
    if (!customer) return req.session.destroy(() => res.redirect(303, '/entrar'));
    if (!(await db.hasAccess(customer.id))) {
      return res.status(403).render('mensagem', {
        title: 'Acesso encerrado',
        text: 'Não encontramos uma compra ativa nesta conta (pedido reembolsado ou cancelado). Se acha que é um engano, fale com a gente.',
        back: '/',
      });
    }
    req.customer = customer;
    res.locals.customer = customer;
    return next();
  }));

  r.get('/area', (req, res) => {
    const c = req.customer;
    const notice = req.query['bem-vinda'] ? { type: 'ok', text: 'Tudo pronto! Seu planner está aqui embaixo ✿' }
      : req.query.salvo ? { type: 'ok', text: 'Nome salvo! Ele já vai nos próximos downloads.' }
        : req.query.limite ? { type: 'err', text: 'Você chegou ao limite de downloads. Fale com a gente que liberamos mais.' } : null;
    res.set('Cache-Control', 'no-store').render('area/index', {
      title: 'Meu planner', catalog, notice, left: Math.max(0, config.maxDownloads - c.downloads), maxDownloads: config.maxDownloads,
    });
  });

  r.post('/area/nome', wrap(async (req, res) => {
    await db.setOwner(req.customer.id, cleanName(req.body.owner));
    res.redirect(303, '/area?salvo=1#downloads');
  }));

  r.get('/area/pdf/:palette/:orientation', wrap(async (req, res) => {
    const c = req.customer;
    const palette = catalog.palette(req.params.palette);
    const file = catalog.file(req.params.palette, req.params.orientation);
    if (!palette || !file) return res.status(404).render('mensagem', { title: 'Arquivo não encontrado', text: '', back: '/area' });
    if (c.downloads >= config.maxDownloads) return res.redirect(303, '/area?limite=1#downloads');
    const started = Date.now();
    const out = await personalizer.get({
      token: `cliente-${c.id}`,
      ownerName: c.owner_name,
      licensee: `${c.owner_name || c.name} · ${c.email}`,
      file,
      version: catalog.generatedAt,
    });
    await db.logDownload(c.id, file.file, req.ip);
    log.info(`[download] cliente ${c.id} ${file.file} (${Date.now() - started} ms)`);
    res.set('Cache-Control', 'private, no-store');
    return res.download(out, `${catalog.name} ${catalog.year} - ${palette.label} - ${req.params.orientation}.pdf`);
  }));

  r.get('/area/capa/:palette/:file', (req, res) => {
    const file = catalog.coverPath(req.params.palette, req.params.file);
    if (!file) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=86400');
    return req.query.dl ? res.download(file) : res.sendFile(file);
  });

  r.get('/area/previa/:palette', (req, res) => {
    const file = catalog.previewPath(req.params.palette);
    if (!file) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=86400');
    return res.sendFile(file);
  });

  return r;
};
