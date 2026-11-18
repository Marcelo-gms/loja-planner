const test = require('node:test');
const assert = require('node:assert');
const { validCpf, money, installmentOptions, hashPassword, checkPassword } = require('../src/util');
const { loadConfig } = require('../src/config');
const { createAsaas } = require('../src/asaas');

test('CPF', () => {
  assert.ok(validCpf('529.982.247-25'));
  assert.ok(!validCpf('529.982.247-24'));
  assert.ok(!validCpf('111.111.111-11'));
  assert.ok(!validCpf('123'));
});

test('dinheiro e parcelas', () => {
  assert.strictEqual(money(4700), '47');
  assert.strictEqual(money(4790), '47,90');
  assert.strictEqual(money(4700, { always: true }), '47,00');
  assert.deepStrictEqual(installmentOptions(4700, 3), [{ n: 1, cents: 4700 }, { n: 2, cents: 2350 }, { n: 3, cents: 1566 }]);
  // parcela mínima de R$ 5: R$ 47 vai até 9x
  assert.strictEqual(loadConfig({ PRODUCT_PRICE: '47', MAX_INSTALLMENTS: '12' }).offer.maxInstallments, 9);
  assert.strictEqual(loadConfig({ PRODUCT_PRICE: '97,00' }).offer.priceCents, 9700);
  assert.strictEqual(loadConfig({}).port, 3000);
  assert.strictEqual(loadConfig({ PORT: '8123' }).port, 8123);
});

test('senha com scrypt', async () => {
  const h = await hashPassword('segredo123');
  assert.ok(await checkPassword('segredo123', h));
  assert.ok(!(await checkPassword('outra', h)));
  assert.ok(!(await checkPassword('x', 'lixo')));
});

test('cliente Asaas: URL, header access_token e erros', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes('/customers?')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (url.endsWith('/customers')) return new Response(JSON.stringify({ id: 'cus_1' }), { status: 200 });
    return new Response(JSON.stringify({ errors: [{ code: 'invalid_value', description: 'Valor inválido.' }] }), { status: 400 });
  };
  const a = createAsaas({ apiKey: 'k', env: 'sandbox', fetchImpl });
  const c = await a.findOrCreateCustomer({ name: 'Ana', cpf: '52998224725', email: 'a@x.com' });
  assert.strictEqual(c.id, 'cus_1');
  assert.ok(calls[0].url.startsWith('https://api-sandbox.asaas.com/v3/customers?cpfCnpj=52998224725'));
  assert.strictEqual(calls[0].opts.headers.access_token, 'k');
  await assert.rejects(a.createPayment({}), /Valor inválido/);
  assert.ok(createAsaas({ apiKey: 'k', env: 'production', fetchImpl }));
});
