/**
 * Cliente mínimo da API v3 do Asaas (https://docs.asaas.com).
 * Autenticação: header `access_token`. Sandbox e produção têm chaves diferentes.
 */
const BASE = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  production: 'https://api.asaas.com/v3',
};

class AsaasError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function createAsaas({ apiKey, env = 'sandbox', fetchImpl = globalThis.fetch }) {
  const base = BASE[env] || BASE.sandbox;

  async function request(method, path, body) {
    if (!apiKey) throw new AsaasError('ASAAS_API_KEY não configurada', 0);
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        access_token: apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'loja-planner/1.0',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = data?.errors?.map((e) => e.description).join(' ') || `Asaas respondeu ${res.status}`;
      throw new AsaasError(msg, res.status, data);
    }
    return data;
  }

  return {
    env,
    /** Reaproveita o cliente pelo CPF (o Asaas permite duplicados, então procuramos antes) */
    async findOrCreateCustomer({ name, cpf, email, phone, externalReference }) {
      const found = await request('GET', `/customers?cpfCnpj=${encodeURIComponent(cpf)}&limit=1`);
      if (found?.data?.length) return found.data[0];
      return request('POST', '/customers', {
        name, cpfCnpj: cpf, email, mobilePhone: phone || undefined, externalReference, notificationDisabled: true,
      });
    },
    createPayment: (payload) => request('POST', '/payments', payload),
    getPayment: (id) => request('GET', `/payments/${encodeURIComponent(id)}`),
    pixQrCode: (id) => request('GET', `/payments/${encodeURIComponent(id)}/pixQrCode`),
  };
}

module.exports = { createAsaas, AsaasError };
