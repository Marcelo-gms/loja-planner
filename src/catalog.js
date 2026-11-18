/**
 * Lê o pacote gerado por `planner/src/generate.js --bundle` (manifest.json + PDFs + capas).
 */
const fs = require('fs');
const path = require('path');

function loadCatalog(productDir) {
  const manifestPath = path.join(productDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Produto não encontrado: ${manifestPath}. Copie a pasta gerada pelo --bundle para PRODUCT_DIR.`);
  }
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const missing = [];
  for (const p of m.palettes) {
    for (const f of Object.values(p.files)) {
      f.path = path.join(productDir, p.dir, f.file);
      if (!fs.existsSync(f.path)) missing.push(f.path);
    }
  }
  if (missing.length) throw new Error(`Arquivos do produto faltando:\n${missing.join('\n')}`);

  const readmePath = path.join(productDir, 'LEIA-ME.txt');
  return {
    ...m,
    dir: productDir,
    readme: fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : '',
    palette: (key) => m.palettes.find((p) => p.key === key) || null,
    file: (key, orientation) => m.palettes.find((p) => p.key === key)?.files[orientation] || null,
    /** imagem da capa do PDF (para a prévia do nome) */
    previewPath(key, orientation = 'vertical') {
      const p = m.palettes.find((x) => x.key === key);
      const f = p && p.files[orientation];
      return f && f.preview ? path.join(productDir, p.dir, f.preview) : null;
    },
    /** caminho seguro de uma capa extra (só nomes que estão no manifest) */
    coverPath(key, name) {
      const p = m.palettes.find((x) => x.key === key);
      if (!p || !Object.values(p.covers || {}).some((list) => list.includes(name))) return null;
      return path.join(productDir, p.dir, 'capas', name);
    },
  };
}

module.exports = { loadCatalog };
