const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

/** 4700 -> "47"; 4790 -> "47,90" */
function money(cents, { always = false } = {}) {
  const v = cents / 100;
  return v.toLocaleString('pt-BR', { minimumFractionDigits: always || cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
}

/** Parcelas sem juros: [{ n, cents }] (a última parcela absorve o arredondamento no Asaas) */
function installmentOptions(priceCents, max) {
  return Array.from({ length: max }, (_, i) => ({ n: i + 1, cents: Math.floor(priceCents / (i + 1)) }));
}

const onlyDigits = (v) => String(v || '').replace(/\D/g, '');

function validCpf(value) {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const len of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const digit = ((sum * 10) % 11) % 10;
    if (digit !== Number(cpf[len])) return false;
  }
  return true;
}

const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || ''));

/** Data de hoje (+dias) no fuso de Brasília, formato YYYY-MM-DD */
function dateBR(addDays = 0) {
  const d = new Date(Date.now() + addDays * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function checkPassword(password, stored) {
  const [alg, saltHex, keyHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = await scrypt(String(password), Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}

/** Comparação em tempo constante de dois textos */
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y) && String(a).length === String(b).length;
}

module.exports = {
  money, installmentOptions, onlyDigits, validCpf, validEmail, dateBR, randomId, sha256, hashPassword, checkPassword, safeEqual,
};
