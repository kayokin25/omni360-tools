/* Прокси к Nominatim (координаты центра города).

   Ключ здесь не нужен, но проксировать всё равно правильно: Nominatim требует
   осмысленный User-Agent и не любит поток запросов от множества анонимных
   браузеров. Через функцию мы представляемся один раз и кэшируем ответы,
   так что политику использования OSM не нарушаем.
*/

const UPSTREAM = 'https://nominatim.openstreetmap.org/search';
// Только ASCII: в значение HTTP-заголовка нельзя положить кириллицу —
// fetch падает на преобразовании в ByteString.
const UA = 'Omni360-Tools/1.0 (internal ad-ops panel; +https://github.com/kayokin25)';

function deny(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-max-age': '86400',
      },
    });
  }
  if (req.method !== 'GET') return deny(405, 'Только GET');

  const referer = req.headers.get('referer');
  if (referer) {
    const allowedHost = new URL(req.url).host;
    let refHost = '';
    try { refHost = new URL(referer).host; } catch { /* мусор в заголовке */ }
    if (refHost && refHost !== allowedHost && !/^localhost(:\d+)?$/.test(refHost)) {
      return deny(403, 'Запросы разрешены только со страниц панели');
    }
  }

  const q = (new URL(req.url).searchParams.get('q') || '').trim();
  if (!q) return deny(400, 'Не задан параметр q');
  if (q.length > 200) return deny(400, 'Слишком длинный запрос');

  const out = new URLSearchParams({
    q,
    format: 'json',
    limit: '1',
    'accept-language': 'ru',
  });

  let upstream;
  try {
    upstream = await fetch(UPSTREAM + '?' + out.toString(), {
      headers: { accept: 'application/json', 'user-agent': UA },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return deny(502, 'Nominatim не ответил: ' + e.message);
  }

  if (!upstream.ok) return deny(502, 'Nominatim ответил ' + upstream.status);

  const body = await upstream.text();
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      // города не переезжают — держим сутки
      'cache-control': 'public, max-age=86400',
    },
  });
};
