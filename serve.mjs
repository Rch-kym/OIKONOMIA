// Servidor estático mínimo para testar localmente: node serve.mjs [porta]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.pdf': 'application/pdf', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ofx': 'text/plain', '.csv': 'text/csv' };
const port = Number(process.argv[2]) || 8080;
createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const full = normalize(join(root, p));
    if (!full.startsWith(root)) { res.writeHead(403); return res.end(); }
    const data = await readFile(full);
    res.writeHead(200, { 'Content-Type': types[extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch { res.writeHead(404); res.end('não encontrado'); }
}).listen(port, () => console.log(`http://localhost:${port}`));
