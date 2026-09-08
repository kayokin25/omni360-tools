/* ============================================================================
   Сбор технических требований — логика (порт tt.py, версия 4.4).
   Зависит от OmniLib и TTData.
   ========================================================================== */
(function (root) {
'use strict';

const L = root.OmniLib;
const D = root.TTData;

const norm = L.normName;

/* Предрассчитанные нормализованные индексы (как в tt.py) */
const ALIAS_NORM = {};
for (const k in D.OPERATOR_ALIASES) ALIAS_NORM[norm(k)] = D.OPERATOR_ALIASES[k];

const RUSS_OPERATORS = new Set(D.RUSS_OPERATORS);
const RUSS_10SEC_FORMATS = new Set(D.RUSS_10SEC_FORMATS);
const MAER_OUTDOOR_OPERATORS = new Set(D.MAER_OUTDOOR_OPERATORS);
const FLAT_DURATIONS = D.FLAT_DURATIONS;

/* Ключ Map — «оператор + формат». Склеиваем через NUL: такого символа нет
   ни в названиях операторов, ни в кодах форматов, поэтому разные пары
   не могут дать одинаковый ключ (в tt.py ключом служил кортеж). */
const KEY_SEP = '\u0000';

const DURATIONS_NORM = new Map();
for (const [op, fmt, d] of D.INVENTORY_DURATIONS) DURATIONS_NORM.set(norm(op) + KEY_SEP + fmt, d);

/* Формат из АП → код таблицы: верхний регистр, пробелы/дефисы → '_'. */
function normFormat(fmt) {
  let f = String(fmt === null || fmt === undefined ? '' : fmt).trim().toUpperCase().replace(/\s+/g, '_');
  f = f.replace(/-/g, '_');
  return f.replace(/_+/g, '_');
}

/* Длительность (сек) или null. Приоритет: Русс → MAER (Outdoor) → фикс. → словарь. */
function lookupDuration(operator, screenFormat) {
  const op = norm(operator);
  const fmt = normFormat(screenFormat);

  if (RUSS_OPERATORS.has(op)) return RUSS_10SEC_FORMATS.has(fmt) ? 10 : 5;
  if (MAER_OUTDOOR_OPERATORS.has(op)) return fmt === 'MEDIAFACADE' ? 10 : 5;
  if (Object.prototype.hasOwnProperty.call(FLAT_DURATIONS, op)) return FLAT_DURATIONS[op];

  const v = DURATIONS_NORM.get(op + KEY_SEP + fmt);
  return v === undefined ? null : v;
}

/* Колонки с длительностью в самой АП: «Длительность», «Длительность, с»,
   «Длительность ролика» — что найдётся. АП главнее справочника: там цифра
   от оператора на эту закупку, а справочник — наша память о том, что он
   обычно даёт. */
function durationCols(table) {
  const cols = [];
  for (const name in table.colOf) if (/длительн/i.test(name)) cols.push(table.colOf[name]);
  return cols;
}

/* «5», «5 с», «5, 10», «10/15» → [5, 10] (по возрастанию, без повторов).
   Запятая тут всегда разделитель, а не дробная часть: секунды целые. */
function parseDurations(v) {
  const out = [];
  const found = String(v === null || v === undefined ? '' : v).match(/\d+(?:\.\d+)?/g) || [];
  for (const s of found) {
    const n = Number(s);
    if (n > 0 && out.indexOf(n) < 0) out.push(n);
  }
  return out.sort(function (a, b) { return a - b; });
}

/* Одна длительность остаётся числом (в xlsx — числом), несколько — «5, 10». */
function joinDurations(list) {
  return list.length === 1 ? list[0] : list.join(', ');
}

/* Имя оператора из АП → нормализованный токен имени файла на Диске. */
function operatorToken(apOperator) {
  const n = norm(apOperator);
  const token = Object.prototype.hasOwnProperty.call(ALIAS_NORM, n) ? ALIAS_NORM[n] : apOperator;
  return norm(token);
}

/* Имя файла → [оператор_норм, разрешение, соотношение, признак_общего]. */
function parseFilename(name) {
  const base = String(name).replace(/\.[^.]*$/, '').trim();

  const resM = /\d+\s*[xхXХ×]\s*\d+/.exec(base);
  const aspM = /\d+\s*:\s*\d+/.exec(base);
  const obshM = /общее/i.exec(base);

  const cands = [resM, aspM, obshM].filter(Boolean);
  let operator;
  if (cands.length) {
    const cut = Math.min.apply(null, cands.map(function (m) { return m.index; }));
    operator = base.slice(0, cut).trim();
  } else {
    operator = base;   // напр. «Инсайт», «Санлайт» — общий файл без суффикса
  }

  return [
    norm(operator),
    resM ? L.normRes(resM[0]) : null,
    aspM ? L.normAspect(aspM[0]) : null,
    !!obshM || cands.length === 0
  ];
}

/* ─────────────── индекс ссылок публичной папки Яндекс.Диска ─────────────── */

const YA_API = 'https://cloud-api.yandex.net/v1/disk/public/resources';

class YandexDiskLinker {
  constructor(publicKey) {
    this.publicKey = publicKey;
    this.index = new Map();     // 'res|op|1920x1080' → ссылка
    this.files = [];
    this.unpublished = [];
    this.dirsSeen = 0;
    this.apiCalls = 0;
    this.ok = false;
  }

  async fetchAll(onProgress) {
    this.apiCalls = 0;
    this.dirsSeen = 0;
    const files = await this._walk('/', 0, 12, 400, onProgress);
    this.files = files;

    for (const it of files) {
      const link = it.public_url || '';
      const [op, res, asp, isObsh] = parseFilename(it.name || '');
      if (!link) { this.unpublished.push(it.name || ''); continue; }
      if (res) this.index.set('res|' + op + '|' + res, link);
      if (asp) this.index.set('asp|' + op + '|' + asp, link);
      if (isObsh) this.index.set('obsh|' + op, link);
    }
    this.ok = true;
    return this;
  }

  async _walk(path, depth, maxDepth, maxCalls, onProgress) {
    const collected = [];
    let offset = 0;
    const limit = 200;
    for (;;) {
      if (this.apiCalls >= maxCalls) break;
      const url = YA_API + '?public_key=' + encodeURIComponent(this.publicKey) +
        '&limit=' + limit + '&offset=' + offset +
        (path && path !== '/' ? '&path=' + encodeURIComponent(path) : '');
      const r = await fetch(url);
      this.apiCalls++;
      if (!r.ok) throw new Error('Яндекс.Диск ответил ' + r.status + ' ' + r.statusText);
      const j = await r.json();
      const emb = j._embedded || {};
      const items = emb.items || [];
      const total = emb.total === undefined ? items.length : emb.total;
      collected.push.apply(collected, items);
      if (onProgress) onProgress(collected.length, total, path);
      offset += limit;
      if (offset >= total || !items.length) break;
    }

    const files = collected.filter(function (it) { return it.type === 'file'; });
    const dirs = collected.filter(function (it) { return it.type === 'dir'; });
    if (depth < maxDepth) {
      for (const d of dirs) {
        this.dirsSeen++;
        if (d.path) {
          const sub = await this._walk(d.path, depth + 1, maxDepth, maxCalls, onProgress);
          files.push.apply(files, sub);
        }
      }
    }
    return files;
  }

  /* Подбор ссылки: разрешение → соотношение → общее. */
  findLink(apOperator, resolution, aspect) {
    const op = operatorToken(apOperator);
    const res = L.normRes(resolution);
    const asp = L.normAspect(aspect);
    if (res && this.index.has('res|' + op + '|' + res)) return this.index.get('res|' + op + '|' + res);
    if (asp && this.index.has('asp|' + op + '|' + asp)) return this.index.get('asp|' + op + '|' + asp);
    if (this.index.has('obsh|' + op)) return this.index.get('obsh|' + op);
    return '';
  }
}

/* ─────────────────────── чтение адресной программы ─────────────────────── */

const AP_SIGNALS = new Set(['Оператор', 'Формат экрана', 'Разрешение', 'Вид. разрешение',
  'Соотношение сторон', 'GID']);

/* Ищет строку-шапку: где есть «Оператор» и больше всего знакомых колонок. */
function findHeader(rows, maxScan) {
  let bestIdx = null, bestScore = 0;
  const n = Math.min(rows.length, maxScan || 60);
  for (let i = 0; i < n; i++) {
    const cells = new Set();
    for (const v of (rows[i] || [])) {
      const s = L.cellStr(v);
      if (s) cells.add(s);
    }
    if (!cells.has('Оператор')) continue;
    let score = 0;
    for (const c of cells) if (AP_SIGNALS.has(c)) score++;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestScore >= 2 ? { idx: bestIdx, score: bestScore } : { idx: null, score: 0 };
}

/* Находит таблицу АП на любом листе и в любой строке (как read_ap_data в tt.py). */
function findApTable(workbook) {
  let best = null;
  for (const sheet of workbook.sheets) {
    if (!sheet.rows.length) continue;
    const h = findHeader(sheet.rows);
    if (h.idx === null) continue;
    const nRows = sheet.rows.length - h.idx - 1;
    if (!best || h.score > best.score || (h.score === best.score && nRows > best.nRows)) {
      best = { score: h.score, nRows: nRows, sheet: sheet, headerIdx: h.idx };
    }
  }
  if (!best) return null;

  const header = (best.sheet.rows[best.headerIdx] || []).map(L.cellStr);
  const colOf = {};
  header.forEach(function (name, i) {
    if (name && !(name in colOf)) colOf[name] = i;   // первое вхождение, как в pandas
  });

  const data = [];
  for (let i = best.headerIdx + 1; i < best.sheet.rows.length; i++) {
    const row = best.sheet.rows[i] || [];
    let allEmpty = true;
    for (const v of row) if (v !== null && v !== undefined && v !== '') { allEmpty = false; break; }
    if (allEmpty) continue;                          // dropna(how='all')
    data.push(row);
  }

  return {
    sheetName: best.sheet.name,
    headerRow: best.headerIdx + 1,
    colOf: colOf,
    rows: data
  };
}

/* Значение по первому подходящему имени столбца (аналог get_field). */
function getField(table, row, names) {
  for (const n of names) {
    if (n in table.colOf) {
      const v = row[table.colOf[n]];
      if (v !== null && v !== undefined && v !== '') return v;
    }
  }
  return '';
}

/* Обработка всех строк АП → { results, durationMisses } */
function processAp(table, linker) {
  const results = [];
  const durationMisses = new Set();
  const durCols = durationCols(table);

  for (const row of table.rows) {
    const operator = getField(table, row, ['Оператор']);
    const screenFormat = getField(table, row, ['Формат экрана']);
    const resolution = getField(table, row, ['Разрешение', 'Вид. разрешение']);
    const aspect = getField(table, row, ['Соотношение сторон']);

    const apDurs = [];
    for (const c of durCols) {
      for (const n of parseDurations(row[c])) if (apDurs.indexOf(n) < 0) apDurs.push(n);
    }
    apDurs.sort(function (a, b) { return a - b; });

    let dur;
    if (apDurs.length) {
      dur = joinDurations(apDurs);
    } else {
      dur = lookupDuration(operator, screenFormat);
      if (dur === null) {
        durationMisses.add(L.cellStr(operator) + ' | ' + L.cellStr(screenFormat));
        dur = '';
      }
    }

    results.push({
      'Оператор': L.cellStr(operator),
      'Формат экрана': L.cellStr(screenFormat),
      'Разрешение': L.cellStr(resolution),
      'Соотношение сторон': L.cellStr(aspect),
      'Длительность (сек)': dur,
      'Ссылка на ТТ': linker ? linker.findLink(operator, resolution, aspect) : '',
      _apDur: apDurs.length > 0
    });
  }

  return { results: results, durationMisses: durationMisses };
}

/* Дедупликация по (оператор, разрешение, длительность) — как в tt.py.
   Длительности из АП — исключение: на одну связку их может быть несколько
   (и 5, и 10 секунд у того же оператора), и нужны все — склеиваем через запятую. */
function deduplicate(results) {
  const byKey = new Map();
  for (const r of results) {
    const key = String(r['Оператор']).trim() + KEY_SEP +
                String(r['Разрешение']).trim() + KEY_SEP +
                (r._apDur ? '' : String(r['Длительность (сек)']).trim());
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, Object.assign({}, r)); continue; }
    if (r._apDur) {
      prev['Длительность (сек)'] = joinDurations(parseDurations(
        String(prev['Длительность (сек)']) + ',' +
        String(r['Длительность (сек)'])));
    }
  }
  return Array.from(byKey.values());
}

const COLUMNS = ['Оператор', 'Формат экрана', 'Разрешение', 'Соотношение сторон',
                 'Длительность (сек)', 'Ссылка на ТТ'];

/* Готовит xlsx-лист «Результаты» с кликабельными ссылками. */
function buildReport(results) {
  const rows = [COLUMNS.slice()];
  for (const r of results) {
    const row = [];
    for (const c of COLUMNS) {
      if (c === 'Ссылка на ТТ') {
        const url = r[c];
        row.push(url
          ? { v: D.LINK_DISPLAY_TEXT || url, s: L.S.LINK, link: url }
          : { v: '', s: L.S.BODY });
      } else {
        row.push(r[c]);
      }
    }
    rows.push(row);
  }
  return [{
    name: 'Результаты',
    cols: [26, 16, 14, 18, 17, 16],
    rows: rows
  }];
}

root.TTCore = {
  normFormat: normFormat,
  lookupDuration: lookupDuration,
  parseDurations: parseDurations,
  joinDurations: joinDurations,
  operatorToken: operatorToken,
  parseFilename: parseFilename,
  YandexDiskLinker: YandexDiskLinker,
  findHeader: findHeader,
  findApTable: findApTable,
  processAp: processAp,
  deduplicate: deduplicate,
  buildReport: buildReport,
  COLUMNS: COLUMNS,
  DATA: D
};

})(typeof globalThis !== 'undefined' ? globalThis : this);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.TTCore;
