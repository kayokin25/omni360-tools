/* Прокси к справочнику 2ГИС.
   Ключ берётся из переменной окружения GIS_API_KEY на Netlify и наружу не уходит:
   в исходнике страницы и в репозитории его нет.

   Настроить: Netlify → Site configuration → Environment variables → GIS_API_KEY
*/

const UPSTREAM = 'https://catalog.api.2gis.com/3.0/items';

// Пропускаем только то, что нужно инструменту. Ключ клиент передать не может.
const ALLOWED = new Set(['q', 'point', 'radius', 'page', 'page_size', 'fields']);

// Проверено запросами к API: page_size максимум 50 (иначе paramIsOutsideSet),
// radius максимум 40 000 м, число страниц не ограничено — выдача листается
// до конца, дальше приходит 404 itemNotFound.
const LIMITS = {
  radius: 40000,
  page: 500,       // 500 × 50 = 25 000 объектов, глубже забирать незачем
  page_size: 50,
};

function deny(status, message) {
  return new Response(JSON.stringify({ meta: { code: status, error: { message } } }), {
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

  const key = process.env.GIS_API_KEY;
  if (!key) {
    return deny(500, 'На сервере не задана переменная GIS_API_KEY — ' +
      'добавьте её в настройках Netlify и сделайте redeploy');
  }

  // Отсекаем встраивание панели в чужие страницы. Прямой запрос (без Referer)
  // и открытие offline-файла (Origin: null) не блокируем — иначе панель
  // перестанет работать с диска.
  const referer = req.headers.get('referer');
  if (referer) {
    const allowedHost = new URL(req.url).host;
    let refHost = '';
    try { refHost = new URL(referer).host; } catch { /* мусор в заголовке */ }
    if (refHost && refHost !== allowedHost && !/^localhost(:\d+)?$/.test(refHost)) {
      return deny(403, 'Запросы разрешены только со страниц панели');
    }
  }

  const src = new URL(req.url).searchParams;
  const q = (src.get('q') || '').trim();
  if (!q) return deny(400, 'Не задан параметр q');

  const out = new URLSearchParams();
  for (const [k, v] of src) {
    if (!ALLOWED.has(k)) continue;
    let val = v;
    if (k in LIMITS) {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n < 1) continue;
      val = String(Math.min(n, LIMITS[k]));
    }
    out.set(k, val);
  }
  out.set('key', key);

  let upstream;
  try {
    upstream = await fetch(UPSTREAM + '?' + out.toString(), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    return deny(502, 'Справочник 2ГИС не ответил: ' + e.message);
  }

  const body = await upstream.text();
  return new Response(body, {
    // 2ГИС отдаёт 404 на последней странице выдачи — это норма, отдаём как есть
    status: upstream.status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
    },
  });
};
