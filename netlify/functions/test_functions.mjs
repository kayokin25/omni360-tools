/* Проверка функций-прокси без деплоя: вызываем обработчики напрямую.
   Запуск:  GIS_API_KEY=<ключ> node netlify/functions/test_functions.mjs   */
import gis from './gis.mjs';
import geocode from './geocode.mjs';

const SITE = 'https://omni360-tools.netlify.app';
let fails = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) fails++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`);
};

const req = (url, headers = {}) => new Request(url, { headers });

console.log('=== geocode ===');
{
  const r = await geocode(req(`${SITE}/api/geocode?q=${encodeURIComponent('Казань')}`));
  const j = await r.json();
  ok(r.status === 200, 'статус 200', 'получен ' + r.status);
  ok(Array.isArray(j) && j.length === 1, 'один результат');
  ok(Math.abs(parseFloat(j[0]?.lat) - 55.79) < 0.5, 'широта Казани', j[0]?.lat);
  ok(r.headers.get('cache-control')?.includes('86400'), 'кэш на сутки');
}
{
  const r = await geocode(req(`${SITE}/api/geocode`));
  ok(r.status === 400, 'без q → 400', 'получен ' + r.status);
}
{
  const r = await geocode(req(`${SITE}/api/geocode?q=Казань`, { referer: 'https://evil.example/x' }));
  ok(r.status === 403, 'чужой referer → 403', 'получен ' + r.status);
}
{
  const r = await geocode(req(`${SITE}/api/geocode?q=Казань`, { referer: `${SITE}/index.html` }));
  ok(r.status === 200, 'свой referer → 200', 'получен ' + r.status);
}

console.log('=== 2gis ===');
{
  const url = `${SITE}/api/2gis?q=${encodeURIComponent('КанАвто')}` +
    '&point=49.1,55.79&radius=6000&page=1&page_size=10' +
    '&fields=items.address,items.address_name,items.full_address_name,items.point';
  const r = await gis(req(url));
  const body = await r.text();
  const j = JSON.parse(body);
  ok(r.status === 200, 'статус 200', 'получен ' + r.status);
  ok(j.meta?.code === 200, 'meta.code 200', JSON.stringify(j.meta));
  const items = j.result?.items || [];
  ok(items.length > 0, 'объекты найдены', items.length + ' шт.');
  ok(!!items[0]?.point, 'есть координаты');
  ok(!body.includes(process.env.GIS_API_KEY || '@@'), 'КЛЮЧ НЕ УТЁК В ОТВЕТ');
}
{
  // клиент пытается подсунуть свой ключ и лишние параметры — должны быть отброшены
  const r = await gis(req(`${SITE}/api/2gis?q=тест&point=49.1,55.79&key=ПОДДЕЛКА&sortby=hack&page_size=999`));
  ok(r.status === 200 || r.status === 404, 'левые параметры не ломают запрос', 'статус ' + r.status);
}
{
  const r = await gis(req(`${SITE}/api/2gis?point=49.1,55.79`));
  ok(r.status === 400, 'без q → 400', 'получен ' + r.status);
}
{
  const r = await gis(req(`${SITE}/api/2gis?q=тест`, { referer: 'https://evil.example/' }));
  ok(r.status === 403, 'чужой referer → 403', 'получен ' + r.status);
}
{
  const saved = process.env.GIS_API_KEY;
  delete process.env.GIS_API_KEY;
  const r = await gis(req(`${SITE}/api/2gis?q=тест`));
  const j = await r.json();
  ok(r.status === 500 && /GIS_API_KEY/.test(j.meta.error.message),
     'без переменной окружения — внятная ошибка');
  process.env.GIS_API_KEY = saved;
}
{
  const r = await gis(new Request(`${SITE}/api/2gis?q=тест`, { method: 'POST' }));
  ok(r.status === 405, 'POST → 405', 'получен ' + r.status);
}
{
  const r = await gis(new Request(`${SITE}/api/2gis`, { method: 'OPTIONS' }));
  ok(r.status === 204, 'OPTIONS → 204 (preflight)', 'получен ' + r.status);
}

console.log(fails ? `\n!!! ПРОВАЛЕНО: ${fails}` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
