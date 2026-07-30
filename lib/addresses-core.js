/* ============================================================================
   Подбор адресов.

   Что выяснилось при проверке API (см. README, раздел «Как собираются адреса»):

   1. Ограничения, из-за которых в script.py появилась сетка, были ошибочными:
      page_size можно до 50 (а не 10), страницы не ограничены вовсе — выдача
      листается до конца, дальше приходит 404 itemNotFound. radius — до 40 000 м.
      В ответе есть result.total.

   2. Но сетку убрать нельзя. «point + radius» у 2ГИС — не геометрический фильтр:
      для одних запросов total растёт с радиусом (Пятёрочка/Уфа: 72→274), а для
      других скачет и падает (КанАвто/Казань: 7 при 3 км, 3 при 8 км), причём
      объекты из маленького радиуса в большой выдачу не попадают, хотя лежат
      внутри круга.

   3. Замер на четырёх запросах: ни одна стратегия не выигрывает.
        КанАвто/Казань     широкий 8   сетка 17   вместе 17
        Пятёрочка/Уфа      широкий 274 сетка 216  вместе 275
        Магнит/Казань      широкий 315 сетка 259  вместе 326
        Додо Пицца/Казань  широкий 16  сетка 75   вместе 77

   Поэтому делаем оба прохода и объединяем: широкий поиск от центра города плюс
   обход по сетке, в каждой точке — полная пагинация. Дубли снимаем по координатам.

   Зависит от OmniLib.
   ========================================================================== */
(function (root) {
'use strict';

const L = root.OmniLib;

const DEFAULTS = {
  API_KEY: '',         // подставляется сборкой только в вариант без прокси
  RADIUS: 40000,       // широкий проход: максимум, который принимает API
  GRID: 6,             // сетка n×n; 0 — только широкий проход
  SPAN: 0.3,           // сторона области обхода в градусах (≈33 км)
  SECTOR_RADIUS: 6000, // радиус в точке сетки; с шагом 0.05° круги перекрываются
  MAX_RESULTS: 2000,   // предохранитель: «магазин» по Москве даёт ~25 000
  PAGE_SIZE: 50        // максимум, который принимает API
};

const LIMITS = {
  RADIUS_MAX: 40000,
  GRID_MAX: 10,
  PAGE_SIZE_MAX: 50,
  MAX_RESULTS_MAX: 20000
};

/* Куда ходить за данными. Сборка подменяет это на один из двух вариантов:
     • proxy  — через функции Netlify: ключ 2ГИС лежит на сервере,
                в странице и в репозитории его нет;
     • direct — прямо в 2ГИС/Nominatim, ключ вводится в интерфейсе. */
const ENDPOINTS = Object.assign({
  mode: 'proxy',
  gis: '/api/2gis',
  geocode: '/api/geocode'
}, root.OMNI_ENDPOINTS || {});

const usesProxy = function () { return ENDPOINTS.mode === 'proxy'; };

/* Внутри панели инструмент открывается в blob:-документе, а относительный
   «/api/…» от blob-адреса не разрешается — нужен абсолютный URL.
   location.origin у blob-документа возвращает origin создателя, он и нужен. */
function endpoint(url) {
  if (url.charAt(0) !== '/') return url;
  let origin = '';
  try { origin = root.location && root.location.origin; } catch (e) { /* нет location */ }
  if (!origin || origin === 'null' || !/^https?:/.test(origin)) {
    throw new Error(
      'Панель открыта как локальный файл, а ключ 2ГИС хранится на сервере — ' +
      'откройте панель по адресу сайта.');
  }
  return origin + url;
}

/* Координаты центра города. */
async function getCityCoordinates(city) {
  const base = endpoint(ENDPOINTS.geocode);
  const url = usesProxy()
    ? base + '?q=' + encodeURIComponent(city)
    : base + '?q=' + encodeURIComponent(city) +
      '&format=json&limit=1&accept-language=ru';
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) {
    let msg = 'сервис геокодирования ответил ' + r.status;
    try {
      const j = await r.json();
      if (j && j.error) msg = j.error;
    } catch (e) { /* тело не JSON */ }
    throw new Error(msg);
  }
  const j = await r.json();
  if (!j || !j.length) return null;
  return {
    lat: parseFloat(j[0].lat),
    lon: parseFloat(j[0].lon),
    displayName: j[0].display_name || city
  };
}

/* Адрес объекта 2ГИС — пробуем разные поля. */
function extractAddress(item) {
  if (item.address_name) return item.address_name;
  const addr = item.address || {};
  if (addr.name) return addr.name;
  const comps = addr.components || [];
  if (comps.length) {
    const parts = [];
    for (const c of comps) {
      if (c.street && c.number) parts.push(c.street + ', ' + c.number);
      else if (c.street) parts.push(c.street);
    }
    if (parts.length) return parts.join('; ');
  }
  return item.full_address_name || '';
}

/* Одна страница выдачи → { items, total, done, error }. */
async function fetchPage(cfg, center, radius, page, signal) {
  const url = endpoint(ENDPOINTS.gis) +
    '?q=' + encodeURIComponent(cfg.QUERY) +
    (usesProxy() ? '' : '&key=' + encodeURIComponent(cfg.API_KEY)) +
    '&point=' + center.lon + ',' + center.lat +
    '&radius=' + radius +
    '&page=' + page +
    '&page_size=' + cfg.PAGE_SIZE +
    '&fields=items.address,items.address_name,items.full_address_name,items.point';

  let data;
  try {
    const r = await fetch(url, { signal: signal });
    data = await r.json();
  } catch (e) {
    if (e && e.name === 'AbortError') return { items: [], done: true };
    throw e;
  }

  const meta = data.meta || {};
  if (meta.code !== 200) {
    // 404 itemNotFound — выдача закончилась, это штатное завершение
    const type = (meta.error || {}).type || '';
    if (meta.code === 404 || type === 'itemNotFound') return { items: [], done: true };
    return {
      items: [], done: true,
      error: (meta.error || {}).message || ('справочник ответил ' + meta.code)
    };
  }

  const res = data.result || {};
  const raw = res.items || [];
  const items = [];
  for (const it of raw) {
    const p = it.point || {};
    if (p.lat === undefined || p.lon === undefined || p.lat === null || p.lon === null) continue;
    items.push({ address: extractAddress(it), lat: p.lat, lon: p.lon });
  }
  return {
    items: items,
    total: res.total,
    done: raw.length < cfg.PAGE_SIZE   // неполная страница — дальше ничего нет
  };
}

/* Точки сетки вокруг центра. */
function buildSectors(center, grid, span) {
  const step = span / grid;
  const half = span / 2;
  const out = [];
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      out.push({
        lat: center.lat - half + step / 2 + i * step,
        lon: center.lon - half + step / 2 + j * step
      });
    }
  }
  return out;
}

/* Вычерпывает одну точку: листает страницы, пока они не кончатся. */
async function sweepPoint(cfg, point, radius, state, signal) {
  let pages = 0;
  let total = null;
  for (let page = 1; ; page++) {
    if (signal && signal.aborted) return { pages: pages, total: total, stopped: true };
    const r = await fetchPage(cfg, point, radius, page, signal);
    pages = page;
    state.requests++;
    if (r.total !== undefined && r.total !== null) total = r.total;
    for (const it of r.items) state.push(it);
    if (r.error) return { pages: pages, total: total, error: r.error };
    if (r.done) break;
    if (state.count() >= cfg.MAX_RESULTS) return { pages: pages, total: total, capped: true };
  }
  return { pages: pages, total: total };
}

/* Полный сбор: широкий проход от центра + обход по сетке, всё объединяется.
   Почему оба — см. комментарий в начале файла. */
async function run(cfg, hooks) {
  const onLog = (hooks && hooks.onLog) || function () {};
  const onProgress = (hooks && hooks.onProgress) || function () {};
  const signal = hooks && hooks.signal;

  onLog('Ищу координаты города: ' + cfg.CITY);
  const center = await getCityCoordinates(cfg.CITY);
  if (!center) throw new Error('Не удалось определить координаты города «' + cfg.CITY + '»');
  onLog('Центр: ' + center.displayName, 'ok');
  onLog('Координаты: ' + center.lat.toFixed(6) + ', ' + center.lon.toFixed(6));

  // Общая копилка: дедуп по координатам сразу, чтобы не копить мусор.
  // Помним, какой проход нашёл объект первым — это показываем в результатах.
  const byCoord = new Map();
  let stage = 'wide';
  const state = {
    requests: 0,
    push: function (it) {
      const key = it.lat.toFixed(6) + ',' + it.lon.toFixed(6);
      if (byCoord.has(key)) return;
      byCoord.set(key, { address: it.address, lat: it.lat, lon: it.lon, foundBy: stage });
    },
    count: function () { return byCoord.size; }
  };

  const sectors = cfg.GRID > 0 ? buildSectors(center, cfg.GRID, cfg.SPAN) : [];
  const steps = 1 + sectors.length;
  let step = 0;
  let truncated = false;
  let error = null;

  // ── проход 1: широкий круг от центра ──
  onLog('Широкий поиск: радиус ' + (cfg.RADIUS / 1000).toFixed(0) + ' км');
  const wide = await sweepPoint(cfg, center, cfg.RADIUS, state, signal);
  step++;
  const wideTotal = wide.total;
  if (wideTotal !== null && wideTotal !== undefined) {
    onLog('Справочник сообщает всего по запросу: ' + wideTotal, 'ok');
  }
  onLog('Широкий поиск: страниц ' + wide.pages + ', уникальных ' + state.count());
  onProgress(state.count(), steps, step, 'широкий поиск');
  if (wide.error) { error = wide.error; onLog(wide.error, 'err'); }
  if (wide.capped) truncated = true;
  if (wide.stopped) truncated = true;

  const afterWide = state.count();

  // ── проход 2: сетка ──
  if (sectors.length && !error && !truncated) {
    stage = 'grid';
    onLog('Обход по сетке ' + cfg.GRID + '×' + cfg.GRID + ' (' + sectors.length +
          ' точек, радиус ' + (cfg.SECTOR_RADIUS / 1000).toFixed(0) + ' км)');
    for (let i = 0; i < sectors.length; i++) {
      if (signal && signal.aborted) { truncated = true; onLog('Остановлено', 'warn'); break; }
      const before = state.count();
      const r = await sweepPoint(cfg, sectors[i], cfg.SECTOR_RADIUS, state, signal);
      step++;
      const added = state.count() - before;
      onProgress(state.count(), steps, step, 'сектор ' + (i + 1) + ' из ' + sectors.length);
      if (added) {
        onLog('Сектор ' + (i + 1) + '/' + sectors.length + ': +' + added +
              ' новых (всего ' + state.count() + ')');
      }
      if (r.error) { error = r.error; onLog(r.error, 'err'); break; }
      if (r.stopped) { truncated = true; onLog('Остановлено', 'warn'); break; }
      if (r.capped) {
        truncated = true;
        onLog('Дошли до ограничения в ' + cfg.MAX_RESULTS + ' объектов', 'warn');
        break;
      }
    }
  }

  const unique = [...byCoord.values()];
  const fromWide = unique.filter(function (r) { return r.foundBy === 'wide'; }).length;
  const fromGrid = unique.length - fromWide;
  const withAddr = unique.filter(function (r) { return r.address; }).length;

  onLog('Итого уникальных: ' + unique.length +
        ' (широкий поиск ' + fromWide + ', сетка добавила ' + fromGrid + ')', 'ok');
  onLog('Запросов к справочнику: ' + state.requests);

  return {
    center: center,
    total: wideTotal === undefined ? null : wideTotal,
    results: unique,
    fromWide: fromWide,
    fromGrid: fromGrid,
    afterWide: afterWide,
    sectors: sectors.length,
    requests: state.requests,
    withAddress: withAddr,
    withoutAddress: unique.length - withAddr,
    truncated: truncated,
    error: error
  };
}

/* Лист xlsx «Результаты». */
function buildReport(results) {
  const rows = [['Название', 'Широта', 'Долгота']];
  for (const r of results) {
    rows.push([
      r.address,
      { v: r.lat, s: L.S.NUM6 },
      { v: r.lon, s: L.S.NUM6 }
    ]);
  }
  return [{ name: 'Результаты', cols: [70, 14, 14], rows: rows }];
}

root.AddressesCore = {
  DEFAULTS: DEFAULTS,
  LIMITS: LIMITS,
  ENDPOINTS: ENDPOINTS,
  usesProxy: usesProxy,
  getCityCoordinates: getCityCoordinates,
  extractAddress: extractAddress,
  fetchPage: fetchPage,
  buildSectors: buildSectors,
  sweepPoint: sweepPoint,
  run: run,
  buildReport: buildReport
};

})(typeof globalThis !== 'undefined' ? globalThis : this);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.AddressesCore;
