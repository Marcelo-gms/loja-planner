/**
 * E-mails transacionais. Os modelos ficam em views/emails/*.ejs.
 * Sem SMTP_HOST, o e-mail não é enviado: o conteúdo vai para o log (útil em testes locais).
 */
const path = require('path');
const ejs = require('ejs');
const nodemailer = require('nodemailer');

const VIEWS = path.join(__dirname, '..', 'views', 'emails');

function createMailer(smtp, { log = console } = {}) {
  const transport = smtp.host
    ? nodemailer.createTransport({
      host: smtp.host, port: smtp.port, secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    })
    : null;

  return {
    async send({ to, subject, text, html }) {
      if (!transport) {
        log.info(`[mail] (SMTP não configurado) para ${to}: ${subject}\n${text}`);
        return;
      }
      await transport.sendMail({ from: smtp.from, to, subject, text, html });
    },
  };
}

/** Renderiza views/emails/<name>.ejs → { subject, text, html } */
async function renderEmail(name, data) {
  const html = await ejs.renderFile(path.join(VIEWS, `${name}.ejs`), data);
  const subject = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  const text = html
    .replace(/<title>[\s\S]*?<\/title>|<style>[\s\S]*?<\/style>/g, '')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g, '$2: $1')
    .replace(/<br\s*\/?>|<\/(p|h1|h2|li|tr)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&#34;|&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim();
  return { subject: subject.replace(/&amp;/g, '&'), text, html };
}

module.exports = { createMailer, renderEmail };
