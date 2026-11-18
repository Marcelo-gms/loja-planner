/**
 * Regras da loja: criar a cobrança no Asaas, confirmar pagamento (webhook ou consulta), liberar acesso,
 * bloquear em reembolso/chargeback e mandar os e-mails de acesso.
 */
const { renderEmail } = require('./mailer');
const { dateBR, money } = require('./util');

const PAID = ['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH'];
const EVENTS = {
  PAYMENT_CONFIRMED: 'paid',
  PAYMENT_RECEIVED: 'paid',
  PAYMENT_REFUNDED: 'refunded',
  PAYMENT_CHARGEBACK_REQUESTED: 'chargeback',
  PAYMENT_CHARGEBACK_DISPUTE: 'chargeback',
  PAYMENT_AWAITING_CHARGEBACK_REVERSAL: 'chargeback',
  PAYMENT_DELETED: 'canceled',
  PAYMENT_OVERDUE: 'expired',
  PAYMENT_RESTORED: 'restored',
};

class CheckoutError extends Error {}

function createShop({ config, db, asaas, mailer, catalog, log = console }) {
  const product = `${catalog.name} ${catalog.year}`;
  const link = (p) => `${config.appUrl}${p}`;

  /** E-mail de acesso: sem senha ainda → link para criar; com senha → link para entrar */
  async function sendAccessEmail(customer) {
    const data = { product, name: customer.name.split(' ')[0], supportEmail: config.supportEmail };
    let mail;
    if (customer.password_hash) {
      mail = await renderEmail('pagamento-confirmado', { ...data, url: link('/entrar') });
    } else {
      const token = await db.createPasswordToken(customer.id, 72);
      mail = await renderEmail('boas-vindas', { ...data, url: link(`/criar-senha/${token}`) });
    }
    await mailer.send({ to: customer.email, ...mail });
  }

  async function sendResetEmail(customer) {
    const token = await db.createPasswordToken(customer.id, 2);
    const mail = await renderEmail('redefinir-senha', {
      product, name: customer.name.split(' ')[0], url: link(`/criar-senha/${token}`), supportEmail: config.supportEmail,
    });
    await mailer.send({ to: customer.email, ...mail });
  }

  /** Marca como pago (uma vez só) e manda o acesso */
  async function confirmPaid(order) {
    if (!(await db.markPaid(order.id))) return false;
    const customer = await db.customerById(order.customer_id);
    log.info(`[loja] pedido ${order.id} pago (${customer.email})`);
    await sendAccessEmail(customer).catch((e) => log.error(`[mail] acesso do pedido ${order.id}: ${e.message}`));
    return true;
  }

  /**
   * Cria cliente + pedido + cobrança no Asaas.
   * PIX: QR code na nossa página. Cartão: página segura do Asaas (os dados do cartão não passam por aqui).
   */
  async function checkout({ name, email, cpf, phone, method, installments }) {
    const customer = await db.upsertCustomer({ name, email, cpf, phone });
    if (await db.hasAccess(customer.id)) return { alreadyCustomer: true };

    const priceCents = config.offer.priceCents;
    const n = method === 'CREDIT_CARD' ? Math.min(Math.max(1, Number(installments) || 1), config.offer.maxInstallments) : 1;
    const order = await db.createOrder({ customerId: customer.id, amountCents: priceCents, method, installments: n });

    try {
      const ac = await asaas.findOrCreateCustomer({ name, cpf, email, phone, externalReference: `cliente-${customer.id}` });
      await db.setAsaasCustomer(customer.id, ac.id);
      const base = {
        customer: ac.id,
        description: `${product} — planner digital (pedido ${order.id})`,
        externalReference: order.public_id,
      };

      if (method === 'PIX') {
        const pay = await asaas.createPayment({ ...base, billingType: 'PIX', value: priceCents / 100, dueDate: dateBR(1) });
        const qr = await asaas.pixQrCode(pay.id);
        await db.attachPayment(order.id, {
          paymentId: pay.id, invoiceUrl: pay.invoiceUrl, pixPayload: qr.payload, pixImage: qr.encodedImage,
          pixExpiresAt: qr.expirationDate, gatewayStatus: pay.status,
        });
        return { order, redirect: `/pagamento/${order.public_id}` };
      }

      const pay = await asaas.createPayment({
        ...base,
        billingType: 'CREDIT_CARD',
        dueDate: dateBR(0),
        ...(n > 1 ? { installmentCount: n, totalValue: priceCents / 100 } : { value: priceCents / 100 }),
        callback: { successUrl: link(`/pagamento/${order.public_id}`), autoRedirect: true },
      });
      await db.attachPayment(order.id, {
        paymentId: pay.id, installmentId: pay.installment, invoiceUrl: pay.invoiceUrl, gatewayStatus: pay.status,
      });
      return { order, redirect: pay.invoiceUrl };
    } catch (e) {
      await db.setOrderStatus(order.id, 'canceled');
      log.error(`[asaas] checkout do pedido ${order.id}: ${e.message}`);
      throw new CheckoutError(e.status === 400 ? e.message : 'Não conseguimos gerar o pagamento agora. Tente de novo em instantes.');
    }
  }

  /** Webhook do Asaas (já autenticado). Devolve um texto curto com o que foi feito. */
  async function handleWebhook(payload) {
    const p = payload?.payment;
    const action = EVENTS[payload?.event];
    if (!p?.id) return 'sem pagamento';
    const order = await db.orderForPayment(p);
    if (!order) return 'pedido desconhecido';
    if (p.status) await db.setGatewayStatus(order.id, p.status);
    if (!action) return `ignorado (${payload.event})`;

    switch (action) {
      case 'paid': return (await confirmPaid(order)) ? 'acesso liberado' : 'já estava pago';
      case 'refunded':
      case 'chargeback':
        await db.setOrderStatus(order.id, action);
        log.info(`[loja] pedido ${order.id} bloqueado (${action})`);
        return `acesso bloqueado (${action})`;
      case 'canceled': await db.setOrderStatus(order.id, 'canceled', 'pending'); return 'cancelado';
      case 'expired': await db.setOrderStatus(order.id, 'expired', 'pending'); return 'vencido';
      case 'restored': await db.setOrderStatus(order.id, 'pending', 'canceled'); return 'restaurado';
      default: return 'ignorado';
    }
  }

  /** Consulta o Asaas (se o webhook atrasar). Limite de 1 consulta a cada 5 s por pedido. */
  const lastSync = new Map();
  async function sync(order) {
    if (order.status === 'paid' || !order.asaas_payment_id) return order;
    if (Date.now() - (lastSync.get(order.id) || 0) < 5000) return order;
    lastSync.set(order.id, Date.now());
    if (lastSync.size > 10000) lastSync.clear();
    try {
      const pay = await asaas.getPayment(order.asaas_payment_id);
      if (pay?.status) await db.setGatewayStatus(order.id, pay.status);
      if (PAID.includes(pay?.status)) await confirmPaid(order);
    } catch (e) {
      log.warn(`[asaas] consulta do pedido ${order.id}: ${e.message}`);
    }
    return db.orderById(order.id);
  }

  /** Acesso liberado pelo admin (brinde, parceria, compra por fora) */
  async function grantManual({ name, email }) {
    const customer = await db.upsertCustomer({ name, email });
    const order = await db.createOrder({ customerId: customer.id, amountCents: 0, method: 'MANUAL', status: 'paid' });
    await sendAccessEmail(customer);
    return order;
  }

  const offerView = () => {
    const { priceCents, maxInstallments, guaranteeDays } = config.offer;
    return {
      price: money(priceCents),
      priceCents,
      maxInstallments,
      guaranteeDays,
      installmentsLabel: maxInstallments > 1
        ? `ou ${maxInstallments}x de R$ ${money(Math.floor(priceCents / maxInstallments), { always: true })} sem juros no cartão`
        : 'no PIX ou cartão',
    };
  };

  return { checkout, handleWebhook, sync, confirmPaid, grantManual, sendAccessEmail, sendResetEmail, offerView, product };
}

module.exports = { createShop, CheckoutError };
