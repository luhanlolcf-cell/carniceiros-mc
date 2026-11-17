const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const wwwDir = path.resolve(__dirname, '..', 'www');
const srcHtml = path.join(repoRoot, 'index.html');
const dstHtml = path.join(wwwDir, 'index.html');

if (!fs.existsSync(srcHtml)) {
  console.error('Erro: index.html não encontrado na raiz do repositório:', srcHtml);
  process.exit(1);
}

fs.mkdirSync(wwwDir, { recursive: true });

let html = fs.readFileSync(srcHtml, 'utf8');

// Usa Tailwind offline embutido no APK (sem depender da CDN externa quando estiver na estrada/galpão)
html = html.replace(
  '<script src="https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js"></script>',
  '<script src="./tailwindcss.min.js"></script>'
);

// Garante viewport mobile adequado para Android (safe areas + sem zoom acidental ao tocar inputs)
html = html.replace(
  '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
  '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />\n  <meta name="theme-color" content="#020203" />'
);

fs.writeFileSync(dstHtml, html, 'utf8');
console.log('www/index.html preparado com sucesso (' + Buffer.byteLength(html, 'utf8') + ' bytes)');
