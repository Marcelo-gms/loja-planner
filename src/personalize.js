/**
 * Carimba o nome da cliente na capa (na linha "Este planner pertence a") e uma linha discreta de
 * licença de uso pessoal na página "Comece aqui". Não usa Chromium: só pdf-lib (~3 s e ~300 MB por PDF),
 * por isso roda em hospedagem comum. Os links internos do PDF são preservados.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const FONT = fs.readFileSync(path.join(__dirname, '..', 'fonts', 'Fraunces-500.ttf'));

/** Mantém só letras, números e pontuação de nome; limita o tamanho. */
function cleanName(value) {
  return String(value || '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}0-9 .'’&-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

const hexColor = (hex) => {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

async function stampPdf(srcBytes, { ownerName, licensee, file, ink = '#3A3540' }) {
  const doc = await PDFDocument.load(srcBytes, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(FONT, { subset: true });
  const pages = doc.getPages();
  const cover = pages[0];
  const { width: pw, height: ph } = cover.getSize();
  const scale = pw / file.width; // px do layout -> pontos do PDF

  const name = cleanName(ownerName);
  if (name && file.stamp) {
    const s = file.stamp;
    let size = 30 * scale;
    while (size > 10 && font.widthOfTextAtSize(name, size) > s.w * scale * 0.94) size -= 0.5;
    const w = font.widthOfTextAtSize(name, size);
    cover.drawText(name, {
      x: (s.x + s.w / 2) * scale - w / 2,
      y: ph - (s.y + s.h - 9) * scale,
      size,
      font,
      color: hexColor(ink),
    });
  }

  if (licensee) {
    const target = pages[1] || cover;
    const text = `Licença de uso pessoal · ${licensee}`;
    const size = 6.5;
    const { width: tw } = target.getSize();
    target.drawText(text, {
      x: (tw - font.widthOfTextAtSize(text, size)) / 2, y: 6, size, font, color: rgb(0.62, 0.59, 0.66),
    });
  }

  doc.setSubject(name ? `Planner de ${name}` : 'Planner digital');
  return doc.save({ useObjectStreams: true });
}

/**
 * Gera (ou reaproveita do cache) o PDF personalizado. Um por vez para não estourar a memória da hospedagem.
 */
function createPersonalizer({ cacheDir, cacheDays = 7, ink }) {
  let queue = Promise.resolve();

  async function get({ token, ownerName, licensee, file, version = '' }) {
    const key = crypto.createHash('sha1')
      .update([cleanName(ownerName), licensee, file.file, version].join('|')).digest('hex').slice(0, 16);
    const dir = path.join(cacheDir, token);
    const out = path.join(dir, `${path.basename(file.file, '.pdf')}-${key}.pdf`);
    if (fs.existsSync(out)) return out;

    const job = queue.then(async () => {
      if (fs.existsSync(out)) return out;
      const bytes = await stampPdf(fs.readFileSync(file.path), { ownerName, licensee, file, ink });
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${out}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, out);
      return out;
    });
    queue = job.catch(() => {});
    return job;
  }

  /** Apaga PDFs do cache mais velhos que cacheDays */
  function cleanup() {
    if (!fs.existsSync(cacheDir)) return 0;
    const limit = Date.now() - cacheDays * 86400000;
    let removed = 0;
    for (const d of fs.readdirSync(cacheDir)) {
      const dir = path.join(cacheDir, d);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (fs.statSync(p).mtimeMs < limit) { fs.rmSync(p, { force: true }); removed++; }
      }
      if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
    }
    return removed;
  }

  return { get, cleanup };
}

module.exports = { stampPdf, createPersonalizer, cleanName };
