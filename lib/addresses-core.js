/* ============================================================================
   Подбор адресов — логика (порт script.py: Nominatim + 2ГИС по сетке секторов).
   Зависит от OmniLib.
   ========================================================================== */
(function (root) {
'use strict';

const L = root.OmniLib;

const DEFAULTS = {
  API_KEY: '',     // подставляется сборкой только в вариант без прокси
  GRID: 6,
  SEARCH_SPAN: 0.3,
  SECTOR_RADIUS: 6000,
  PAGE_SIZE: 10,   // максимум на бесплатном тарифе
  MAX_PAGES: 5     // максимум на бесплатном тарифе
};

/* Куда ходить за данными. Сборка подменяет это на один из двух вариантов:
     • proxy  — через функции Netlify: ключ 2ГИС лежит на сервере,
                в странице и в репозитории его нет;
     • direct — прямо в 2ГИС/Nominatim, ключ вводится в интерфейсе
                (нужен, когда панель открывают файлом без доступа к сайту).
   Значения по умолчанию — прокси относительными путями. */
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

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

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

/* Адрес объекта 2ГИС — пробуем разные поля (как extract_address). */
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

/* Сетка секторов вокруг центра города. */
function buildSectors(centerLat, centerLon, grid, span) {
  const step = span / grid;
  const half = span / 2;
  const startLat = centerLat - half + step / 2;
  const startLon = centerLon - half + step / 2;
  const sectors = [];
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      sectors.push({ lat: startLat + i * step, lon: startLon + j * step });
    }
  }
  return sectors;
}

/* Поиск в одном секторе с пагинацией. */
async function searchSector(cfg, sector, signal, onWarn) {
  const out = [];
  for (let page = 1; page <= cfg.MAX_PAGES; page++) {
    if (signal && signal.aborted) break;
    // Ключ уходит в запрос только в прямом режиме; через прокси его добавляет сервер.
    const url = endpoint(ENDPOINTS.gis) +
      '?q=' + encodeURIComponent(cfg.QUERY) +
      (usesProxy() ? '' : '&key=' + encodeURIComponent(cfg.API_KEY)) +
      '&point=' + sector.lon + ',' + sector.lat +
      '&radius=' + cfg.SECTOR_RADIUS +
      '&page=' + page +
      '&page_size=' + cfg.PAGE_SIZE +
      '&fields=items.address,items.address_name,items.full_address_name,items.point';
    let data;
    try {
      const r = await fetch(url, { signal: signal });
      data = await r.json();
    } catch (e) {
      if (e && e.name === 'AbortError') break;
      throw e;
    }
    const meta = data.meta || {};
    // Ошибку настройки прокси надо показать, а не молча вернуть ноль объектов
    if (meta.code >= 500 && meta.error && onWarn) onWarn(meta.error.message || 'ошибка сервера');
    if (meta.code === 403 && meta.error && onWarn) onWarn(meta.error.message || 'доступ запрещён');
    if (meta.code !== 200) break;          // 404/400 на последней странице — норма
    const items = (data.result || {}).items || [];
    if (!items.length) break;
    for (const it of items) {
      const p = it.point || {};
      if (p.lat === undefined || p.lon === undefined || p.lat === null || p.lon === null) continue;
      out.push({ address: extractAddress(it), lat: p.lat, lon: p.lon });
    }
    if (items.length < cfg.PAGE_SIZE) break;
    await sleep(200);
  }
  return out;
}

/* Полный проход: сетка × страницы, дедуп по округлённым координатам. */
async function run(cfg, hooks) {
  const onLog = (hooks && hooks.onLog) || function () {};
  const onProgress = (hooks && hooks.onProgress) || function () {};
  const signal = hooks && hooks.signal;

  onLog('Ищу координаты города: ' + cfg.CITY);
  const city = await getCityCoordinates(cfg.CITY);
  if (!city) throw new Error('Не удалось определить координаты города «' + cfg.CITY + '»');
  onLog('Найден: ' + city.displayName, 'ok');
  onLog('Координаты центра: ' + city.lat.toFixed(6) + ', ' + city.lon.toFixed(6));

  const sectors = buildSectors(city.lat, city.lon, cfg.GRID, cfg.SEARCH_SPAN);
  onLog('Сетка ' + cfg.GRID + '×' + cfg.GRID + ' = ' + sectors.length +
        ' секторов, радиус сектора ' + cfg.SECTOR_RADIUS + ' м');

  const all = [];
  const warned = new Set();
  const onWarn = function (msg) {
    if (warned.has(msg)) return;
    warned.add(msg);
    onLog(msg, 'err');
  };
  for (let i = 0; i < sectors.length; i++) {
    if (signal && signal.aborted) { onLog('Остановлено пользователем', 'warn'); break; }
    const res = await searchSector(cfg, sectors[i], signal, onWarn);
    all.push.apply(all, res);
    onProgress(i + 1, sectors.length, all.length);
    onLog('Сектор ' + (i + 1) + '/' + sectors.length + ' (' +
          sectors[i].lat.toFixed(4) + ', ' + sectors[i].lon.toFixed(4) + '): ' +
          res.length + ' объектов');
  }

  const seen = new Set();
  const unique = [];
  for (const r of all) {
    const key = r.lat.toFixed(6) + ',' + r.lon.toFixed(6);
    if (!seen.has(key)) { seen.add(key); unique.push(r); }
  }

  const withAddr = unique.filter(function (r) { return r.address; }).length;
  return {
    city: city,
    sectors: sectors.length,
    rawCount: all.length,
    results: unique,
    withAddress: withAddr,
    withoutAddress: unique.length - withAddr
  };
}

/* Лист xlsx «Результаты» — как в script.py. */
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
  ENDPOINTS: ENDPOINTS,
  usesProxy: usesProxy,
  getCityCoordinates: getCityCoordinates,
  extractAddress: extractAddress,
  buildSectors: buildSectors,
  searchSector: searchSector,
  run: run,
  buildReport: buildReport
};

})(typeof globalThis !== 'undefined' ? globalThis : this);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.AddressesCore;
