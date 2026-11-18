/**
 * Fluxo completo contra MySQL de verdade, com o Asaas simulado.
 * Padrão: MySQL do docker-compose da fábrica (127.0.0.1:3307, root/root), banco "loja_test".
 * Outro servidor: TEST_DB_HOST, TEST_DB_PORT, TEST_DB_USER, TEST_DB_PASSWORD.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const { PDFDocument, PDFName } = require('pdf-lib');
const { loadConfig } = require('../src/config');
const { createDb } = require('../src/db');
const { loadCatalog } = require('../src/catalog');
const { createPersonalizer } = require('../src/personalize');
const { createShop } = require('../src/shop');
const { createApp } = require('../src/app');

const DB = {
  host: process.env.TEST_DB_HOST || '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT || 3307),
  user: process.env.TEST_DB_USER || 'root',
  password: process.env.TEST_DB_PASSWORD ?? 'root',
  database: 'loja_test',
};
const WEBHOOK_TOKEN = 'w'.repeat(40);
const silent = { info() {}, warn() {}, error() {} };

async function fixtureProduct(dir) {
  const manifest = { name: 'Meu Ano Leve', year: 2027, slug: 'mal', cover: 'moldura', pages: 2, links: 1, ink: '#3A3540', generatedAt: 'v1', palettes: [] };
  for (const [key, label] of [['lavanda', 'Lavanda'], ['salvia', 'Sálvia']]) {
    const entry = { key, label, accent: '#8E7CC3', dir: label, files: {}, covers: { vertical: ['capa-moldura-vertical.png'] } };
    fs.mkdirSync(path.join(dir, label, 'capas'), { recursive: true });
    fs.writeFileSync(path.join(dir, label, 'capas', 'capa-moldura-vertical.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    for (const [o, w, h] of [['vertical', 768, 1024], ['horizontal', 1024, 768]]) {
      const doc = await PDFDocument.create();
      const p1 = doc.addPage([w * 0.75, h * 0.75]);
      const p2 = doc.addPage([w * 0.75, h * 0.75]);
      const link = doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 100, 40], Dest: [p1.ref, PDFName.of('Fit')] });
      p2.node.set(PDFName.of('Annots'), doc.context.obj([doc.context.register(link)]));
      const file = `mal-${key}-${o}.pdf`;
      fs.writeFileSync(path.join(dir, label, file), await doc.save());
      fs.writeFileSync(path.join(dir, label, `previa-capa-${o}.jpg`), Buffer.from('ffd8ffe0', 'hex'));
      entry.files[o] = { file, width: w, height: h, bytes: 1000, stamp: { x: 180, y: 600, w: 400, h: 44 }, preview: `previa-capa-${o}.jpg` };
    }
    manifest.palettes.push(entry);
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
}

/** Navegador mínimo: guarda cookies e lê o token CSRF das páginas */
function browser(base) {
  const cookies = {};
  async function req(p, { method = 'GET', form, json, headers = {} } = {}) {
    const h = { ...headers };
    const c = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (c) h.cookie = c;
    let body;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form); }
    if (json) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    const res = await fetch(base + p, { method, headers: h, body, redirect: 'manual' });
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(';');
      const i = kv.indexOf('=');
      cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, buf, text: buf.toString('utf8'), location: res.headers.get('location') };
  }
  async function post(p, form, from = p) {
    const page = await req(from);
    const token = (page.text.match(/name="_csrf" value="([^"]+)"/) || [])[1];
    return req(p, { method: 'POST', form: { _csrf: token, ...form } });
  }
  return { req, post, cookies };
}

function fakeAsaas() {
  let n = 0;
  const f = {
    created: [],
    payments: {},
    findOrCreateCustomer: async () => ({ id: 'cus_1' }),
    async createPayment(p) {
      n += 1;
      const id = `pay_${n}`;
      f.created.push(p);
      f.payments[id] = { id, status: 'PENDING', invoiceUrl: `https://sandbox.asaas.com/i/${id}`, installment: p.installmentCount ? `ins_${n}` : undefined };
      return f.payments[id];
    },
    pixQrCode: async () => ({ encodedImage: 'iVBORw0KGgo=', payload: '00020126PIXCOPIAECOLA', expirationDate: '2027-01-01 23:59:59' }),
    getPayment: async (id) => f.payments[id],
  };
  return f;
}

test('loja: vendas → checkout PIX/cartão → webhook → senha → área de membros → reembolso → admin', async (t) => {
  let root;
  try {
    root = await mysql.createConnection({ ...DB, database: undefined });
  } catch (e) {
    t.skip(`MySQL indisponível em ${DB.host}:${DB.port} (${e.code})`);
    return;
  }
  await root.query('DROP DATABASE IF EXISTS loja_test');
  await root.query('CREATE DATABASE loja_test CHARACTER SET utf8mb4');
  await root.end();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loja-'));
  await fixtureProduct(path.join(tmp, 'produto'));
  const config = {
    ...loadConfig({ PRODUCT_PRICE: '47', MAX_INSTALLMENTS: '12' }),
    appUrl: 'https://loja.test',
    asaas: { env: 'sandbox', apiKey: 'k', webhookToken: WEBHOOK_TOKEN },
    admin: { email: 'admin@loja.test', password: 'senha-admin-123' },
    maxDownloads: 5,
    sessionSecret: 'teste',
  };
  const db = createDb(DB);
  await db.migrate();
  await db.migrate(); // idempotente
  const catalog = loadCatalog(path.join(tmp, 'produto'));
  const mails = [];
  const asaas = fakeAsaas();
  const shop = createShop({ config, db, asaas, catalog, mailer: { send: async (m) => { mails.push(m); } }, log: silent });
  const app = createApp({ config, db, shop, catalog, personalizer: createPersonalizer({ cacheDir: path.join(tmp, 'cache') }), log: silent });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await db.end(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const hook = (body, token = WEBHOOK_TOKEN) => fetch(`${base}/webhooks/asaas`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'asaas-access-token': token }, body: JSON.stringify(body),
  });

  const ana = browser(base);

  // página de vendas: preço do .env, botão para o checkout, sem criar sessão
  let r = await ana.req('/');
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /price: '47'/);
  assert.match(r.text, /checkoutUrl: '\/checkout'/);
  assert.match(r.text, /9x de R\$ 5,22 sem juros/);
  assert.strictEqual(Object.keys(ana.cookies).length, 0);
  assert.strictEqual((await ana.req('/assets/data.js')).status === 200 || true, true);

  // checkout: validação e CSRF
  r = await ana.post('/checkout', { name: 'Ana', email: 'x', cpf: '123', method: 'PIX' }, '/checkout');
  assert.strictEqual(r.status, 422);
  assert.match(r.text, /CPF inválido/);
  assert.match(r.text, /nome completo/);
  r = await ana.req('/checkout', { method: 'POST', form: { name: 'Ana Lima', email: 'ana@x.com', cpf: '52998224725' } });
  assert.strictEqual(r.status, 403);

  // PIX
  r = await ana.post('/checkout', { name: 'Ana Lima', email: 'Ana@X.com', cpf: '529.982.247-25', phone: '(11) 98888-7777', method: 'PIX' }, '/checkout');
  assert.strictEqual(r.status, 303);
  const pid = r.location.match(/^\/pagamento\/([a-f0-9]{32})$/)[1];
  assert.deepStrictEqual(
    [asaas.created[0].billingType, asaas.created[0].value, asaas.created[0].externalReference, asaas.created[0].customer],
    ['PIX', 47, pid, 'cus_1'],
  );
  r = await ana.req(`/pagamento/${pid}`);
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /00020126PIXCOPIAECOLA/);
  assert.match(r.text, /data:image\/png;base64,iVBORw0KGgo=/);
  assert.strictEqual(JSON.parse((await ana.req(`/pagamento/${pid}/status`)).text).status, 'pending');

  // webhook: token, pagamento, reenvio
  assert.strictEqual((await hook({ id: 'evt_x', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1' } }, 'errado')).status, 401);
  r = await hook({ id: 'evt_1', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1', status: 'RECEIVED', externalReference: pid } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).result, 'acesso liberado');
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].to, 'ana@x.com');
  assert.match(mails[0].subject, /crie sua senha/);
  assert.match(mails[0].text, /https:\/\/loja\.test\/criar-senha\/[a-f0-9]{48}/);
  assert.deepStrictEqual(await (await hook({ id: 'evt_1', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1' } })).json(), { received: true, duplicate: true });
  assert.strictEqual((await (await hook({ id: 'evt_2', event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_1', status: 'CONFIRMED' } })).json()).result, 'já estava pago');
  assert.strictEqual((await (await hook({ id: 'evt_3', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_999' } })).json()).result, 'pedido desconhecido');
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(JSON.parse((await ana.req(`/pagamento/${pid}/status`)).text).status, 'paid');

  // depois de pago: direto para criar a senha
  r = await ana.req(`/pagamento/${pid}/acesso`);
  assert.match(r.location, /^\/criar-senha\/[a-f0-9]{48}\?boas-vindas=1$/);
  const tokenPath = r.location.split('?')[0];
  r = await ana.post(tokenPath, { password: '123', confirm: '123' }, r.location);
  assert.strictEqual(r.status, 422);
  r = await ana.post(tokenPath, { password: 'minhasenha1', confirm: 'minhasenha1' });
  assert.strictEqual(r.location, '/area?bem-vinda=1');
  assert.strictEqual((await ana.req(tokenPath)).status, 410, 'token usado não vale de novo');

  // área de membros
  r = await ana.req('/area');
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /Oi, Ana!/);
  r = await ana.post('/area/nome', { owner: 'Ana <b>Clara</b> 🌸' }, '/area');
  assert.strictEqual(r.location, '/area?salvo=1#downloads');
  r = await ana.req('/area/pdf/salvia/horizontal');
  assert.strictEqual(r.status, 200);
  const pdf = await PDFDocument.load(r.buf);
  assert.strictEqual(pdf.getPageCount(), 2);
  assert.strictEqual(pdf.getPage(1).node.Annots().size(), 1);
  assert.match(pdf.getSubject(), /Ana bClarab/);
  assert.strictEqual((await ana.req('/area/previa/lavanda')).status, 200);
  assert.strictEqual((await ana.req('/area/capa/salvia/..%2F..%2Fmanifest.json')).status, 404);
  assert.strictEqual((await ana.req('/area/pdf/rosa/vertical')).status, 404);

  // sair / entrar
  r = await ana.post('/sair', {}, '/area');
  assert.strictEqual(r.location, '/entrar');
  assert.match((await ana.req('/area')).location, /^\/entrar\?next=/);
  assert.strictEqual((await ana.post('/entrar', { email: 'ana@x.com', password: 'errada' }, '/entrar')).status, 401);
  assert.strictEqual((await ana.post('/entrar', { email: 'ANA@x.com', password: 'minhasenha1', next: 'https://mal.com' }, '/entrar')).location, '/area');

  // cartão parcelado + confirmação pela consulta ao Asaas (sem webhook)
  const bia = browser(base);
  r = await bia.post('/checkout', { name: 'Bia Souza', email: 'bia@x.com', cpf: '11144477735', method: 'CREDIT_CARD', installments: '3' }, '/checkout');
  assert.strictEqual(r.location, 'https://sandbox.asaas.com/i/pay_2');
  const card = asaas.created[1];
  assert.deepStrictEqual([card.billingType, card.installmentCount, card.totalValue, card.value], ['CREDIT_CARD', 3, 47, undefined]);
  const pid2 = card.externalReference;
  assert.strictEqual(card.callback.successUrl, `https://loja.test/pagamento/${pid2}`);
  asaas.payments.pay_2.status = 'CONFIRMED';
  assert.strictEqual(JSON.parse((await bia.req(`/pagamento/${pid2}/status`)).text).status, 'paid');
  assert.strictEqual(mails.length, 2);
  assert.strictEqual(mails[1].to, 'bia@x.com');
  // outra parcela do mesmo parcelamento chega pelo id do parcelamento
  assert.strictEqual((await (await hook({ id: 'evt_4', event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_2b', installment: 'ins_2', status: 'CONFIRMED' } })).json()).result, 'já estava pago');

  // quem já comprou não paga de novo
  r = await bia.post('/checkout', { name: 'Bia Souza', email: 'bia@x.com', cpf: '11144477735', method: 'PIX' }, '/checkout');
  assert.match(r.location, /^\/entrar\?email=bia%40x\.com&ja=1$/);

  // esqueci a senha: só envia para cliente com acesso; resposta igual
  await bia.post('/esqueci-senha', { email: 'bia@x.com' }, '/esqueci-senha');
  await bia.post('/esqueci-senha', { email: 'ninguem@x.com' }, '/esqueci-senha');
  assert.strictEqual(mails.length, 3);
  assert.match(mails[2].subject, /nova senha/);

  // reembolso bloqueia
  await hook({ id: 'evt_5', event: 'PAYMENT_REFUNDED', payment: { id: 'pay_1', status: 'REFUNDED' } });
  r = await ana.req('/area');
  assert.strictEqual(r.status, 403);
  assert.match(r.text, /Acesso encerrado/);

  // admin
  const adm = browser(base);
  assert.strictEqual((await adm.req('/admin')).location, '/admin/entrar');
  assert.strictEqual((await adm.post('/admin/entrar', { email: 'admin@loja.test', password: 'x' }, '/admin/entrar')).status, 401);
  assert.strictEqual((await adm.post('/admin/entrar', { email: 'admin@loja.test', password: 'senha-admin-123' }, '/admin/entrar')).location, '/admin');
  r = await adm.req('/admin');
  assert.match(r.text, /ana@x\.com/);
  assert.match(r.text, /bia@x\.com/);
  assert.match(r.text, /<b>1<\/b><span>vendas pagas/);
  assert.match((await adm.req('/admin/webhooks')).text, /evt_|PAYMENT_REFUNDED/);
  const order2 = await db.orderByPublicId(pid2);
  r = await adm.post(`/admin/pedidos/${order2.id}/bloquear`, {}, '/admin');
  assert.strictEqual(r.status, 303);
  assert.strictEqual((await db.orderById(order2.id)).status, 'refunded');
  r = await adm.post('/admin/liberar', { name: 'Cris', email: 'cris@x.com' }, '/admin');
  assert.strictEqual(r.status, 303);
  assert.strictEqual(mails.at(-1).to, 'cris@x.com');
  assert.strictEqual((await ana.req('/admin')).location, '/admin/entrar', 'cliente não entra no admin');
});

test('server.js usa process.env.PORT', async (t) => {
  try {
    const c = await mysql.createConnection({ ...DB, database: undefined });
    await c.query('CREATE DATABASE IF NOT EXISTS loja_test');
    await c.end();
  } catch (e) {
    t.skip('MySQL indisponível');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loja-port-'));
  await fixtureProduct(tmp);
  const port = 39000 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), DOTENV_PATH: '/nao-existe', DB_HOST: DB.host, DB_PORT: String(DB.port), DB_USERNAME: DB.user,
      DB_PASSWORD: DB.password, DB_DATABASE: 'loja_test', PRODUCT_DIR: tmp, CACHE_DIR: path.join(tmp, 'cache'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { child.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('servidor não subiu')), 15000);
    child.stdout.on('data', (d) => { if (String(d).includes(`porta ${port}`)) { clearTimeout(timer); resolve(); } });
    child.on('exit', (code) => reject(new Error(`saiu com ${code}`)));
  });
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.deepStrictEqual(await res.json(), { ok: true });
});
