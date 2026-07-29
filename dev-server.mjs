/* Локальный сервер: раздаёт dist/ и повторяет маршруты /api/* из netlify.toml.
   Нужен, чтобы проверить панель целиком до деплоя, без Netlify CLI.

   Запуск (PowerShell):
     $env:GIS_API_KEY="<ключ>"; node dev-server.mjs
   Запуск (bash):
     GIS_API_KEY=<ключ> node dev-server.mjs

   Потом открыть http://localhost:8971
*/
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');
const PORT = Number(process.env.PORT) || 8971;

const ROUTES = {
  '/api/2gis': () => import('./netlify/functions/gis.mjs'),
  '/api/geocode': () => import('./netlify/functions/geocode.mjs'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── функции ──
  if (ROUTES[url.pathname]) {
    try {
      const mod = await ROUTES[url.pathname]();
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
      }
      const request = new Request(`http://localhost:${PORT}${req.url}`, {
        method: req.method,
        headers,
      });
      const out = await mod.default(request);
      res.statusCode = out.status;
      out.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(Buffer.from(await out.arrayBuffer()));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'функция упала: ' + e.message }));
      console.error(`  ! ${url.pathname}:`, e);
    }
    console.log(`  ${res.statusCode}  ${req.method} ${url.pathname}${url.search.slice(0, 60)}`);
    return;
  }

  // ── статика ──
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const full = path.join(DIST, rel);
  // не пускаем за пределы dist
  if (!full.startsWith(DIST)) {
    res.statusCode = 403;
    res.end('нельзя');
    return;
  }
  try {
    const body = await fs.readFile(full);
    res.setHeader('content-type', MIME[path.extname(full).toLowerCase()] || 'application/octet-stream');
    res.setHeader('cache-control', 'no-cache');
    res.end(body);
    console.log(`  200  ${rel}`);
  } catch {
    res.statusCode = 404;
    res.end('не найдено: ' + rel);
    console.log(`  404  ${rel}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`панель: http://localhost:${PORT}`);
  console.log(`инструменты: http://localhost:${PORT}/tools/addresses.html`);
  if (!process.env.GIS_API_KEY) {
    console.log('\n⚠  GIS_API_KEY не задан — «Подбор адресов» вернёт ошибку настройки.');
  }
});
