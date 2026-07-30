/* ============================================================================
   Объединение таблиц (порт merge.py, но без привязки к трём колонкам адресов).

   merge.py умел ровно одно: склеить файлы вида «Название / Широта / Долгота»,
   взяв шапку из первого и дальше копируя строки по позициям. Здесь то же, но
   столбцы по умолчанию сопоставляются ПО НАЗВАНИЮ — тогда файл с другим
   порядком колонок не превратится в кашу.

   Зависит от OmniLib.
   ========================================================================== */
(function (root) {
'use strict';

const L = root.OmniLib;

/* Колонки с координатами показываем с шестью знаками — как в merge.py. */
const COORD_RE = /(широт|долгот|\blat\b|\blon\b|\blng\b|latitude|longitude)/i;

/* Ключ для сравнения строк. NUL как разделитель: в данных его быть не может,
   поэтому «а|б» и «а», «б» не дадут один и тот же ключ. */
const KEY_SEP = String.fromCharCode(0);

const DEFAULTS = {
  matchBy: 'name',          // 'name' | 'position'
  addSource: false,         // добавить столбец с именем файла
  dedupe: false,            // убрать полные дубли строк
  emptyPlaceholder: true,   // пустое первое поле → 'empty' (поведение merge.py)
  sheetName: 'Объединено'
};

function cellStr(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function rowIsEmpty(row) {
  for (const v of row) if (v !== null && v !== undefined && String(v).trim() !== '') return false;
  return true;
}

/* Шапка — первая непустая строка листа; дальше данные. */
function splitHeader(rows) {
  let i = 0;
  while (i < rows.length && rowIsEmpty(rows[i] || [])) i++;
  if (i >= rows.length) return { header: [], data: [] };
  const header = (rows[i] || []).map(cellStr);
  // отрезаем хвост пустых заголовков
  while (header.length && header[header.length - 1] === '') header.pop();
  const data = [];
  for (let j = i + 1; j < rows.length; j++) {
    const row = rows[j] || [];
    if (rowIsEmpty(row)) continue;
    data.push(row);
  }
  return { header: header, data: data };
}

/* Читает файлы → [{name, header, data, sheetName, error}]. Берём первый лист,
   как это делал wb.active в merge.py. */
async function readTables(files, onProgress) {
  const out = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (onProgress) onProgress(i, files.length, f.name);
    try {
      const wb = await L.readXlsx(L.blobSource(f));
      if (!wb.sheets.length) throw new Error('в файле нет листов');
      const sheet = wb.sheets[0];
      const split = splitHeader(sheet.rows);
      out.push({
        name: f.name,
        sheetName: sheet.name,
        sheetCount: wb.sheets.length,
        header: split.header,
        data: split.data
      });
    } catch (e) {
      out.push({ name: f.name, error: e.message, header: [], data: [] });
    }
  }
  if (onProgress) onProgress(files.length, files.length, '');
  return out;
}

/* Склейка. tables — из readTables (или собранные вручную: {name, header, data}). */
function mergeTables(tables, options) {
  const opt = Object.assign({}, DEFAULTS, options || {});
  const good = tables.filter(function (t) { return !t.error; });
  const warnings = [];

  for (const t of tables) {
    if (t.error) warnings.push('«' + t.name + '»: не прочитался — ' + t.error);
    else if (t.sheetCount > 1) {
      warnings.push('«' + t.name + '»: листов ' + t.sheetCount +
                    ', взят первый («' + t.sheetName + '»)');
    }
  }
  if (!good.length) {
    return { header: [], rows: [], perFile: [], warnings: warnings,
             duplicateRows: 0, removed: 0, columnsAdded: [] };
  }

  // ── итоговый набор столбцов ──
  let header;
  const columnsAdded = [];
  if (opt.matchBy === 'name') {
    header = good[0].header.slice();
    const seen = new Set(header.map(function (h) { return h.toLowerCase(); }));
    for (const t of good.slice(1)) {
      for (const h of t.header) {
        if (!h) continue;
        const k = h.toLowerCase();
        if (!seen.has(k)) {
          seen.add(k);
          header.push(h);
          columnsAdded.push(h + ' (из «' + t.name + '»)');
        }
      }
    }
  } else {
    let width = 0;
    for (const t of good) {
      width = Math.max(width, t.header.length);
      for (const r of t.data) width = Math.max(width, r.length);
    }
    header = good[0].header.slice();
    while (header.length < width) header.push('');
  }

  const indexByName = new Map();
  header.forEach(function (h, i) { if (h) indexByName.set(h.toLowerCase(), i); });

  // ── строки ──
  const rows = [];
  const perFile = [];
  // Дубли считаем ВСЕГДА, даже когда не убираем: именно так видно, что на вход
  // случайно попал прошлый результат склейки (в исходном merge.py такой файл
  // молча удваивал таблицу).
  const seenRows = new Set();
  let duplicateRows = 0;
  let removed = 0;

  for (const t of good) {
    // как столбцы файла ложатся в итоговые
    let map;
    if (opt.matchBy === 'name') {
      map = t.header.map(function (h) {
        const i = h ? indexByName.get(h.toLowerCase()) : undefined;
        return i === undefined ? -1 : i;
      });
    } else {
      map = header.map(function (_, i) { return i; });
    }

    let added = 0;
    for (const src of t.data) {
      const row = new Array(header.length).fill('');
      if (opt.matchBy === 'name') {
        for (let c = 0; c < src.length; c++) {
          const to = c < map.length ? map[c] : -1;
          if (to >= 0) row[to] = src[c] === undefined ? '' : src[c];
        }
      } else {
        for (let c = 0; c < src.length && c < row.length; c++) {
          row[c] = src[c] === undefined ? '' : src[c];
        }
      }

      // поведение merge.py: первое поле пустое, а остальные нет → 'empty'
      if (opt.emptyPlaceholder && cellStr(row[0]) === '') {
        let hasRest = false;
        for (let c = 1; c < row.length; c++) if (cellStr(row[c]) !== '') { hasRest = true; break; }
        if (hasRest) row[0] = 'empty';
      }

      const key = row.map(cellStr).join(KEY_SEP);
      const isDupe = seenRows.has(key);
      if (isDupe) duplicateRows++;
      else seenRows.add(key);
      if (isDupe && opt.dedupe) { removed++; continue; }

      rows.push({ values: row, source: t.name });
      added++;
    }
    perFile.push({ name: t.name, rows: added, columns: t.header.length });
  }

  return {
    header: header,
    rows: rows,
    perFile: perFile,
    warnings: warnings,
    duplicateRows: duplicateRows,
    removed: removed,
    columnsAdded: columnsAdded,
    options: opt
  };
}

/* Готовит лист для writeXlsx. */
function buildReport(merged, options) {
  const opt = Object.assign({}, DEFAULTS, merged.options || {}, options || {});
  const header = merged.header.slice();
  if (opt.addSource) header.push('Файл-источник');

  const coordCols = new Set();
  header.forEach(function (h, i) { if (COORD_RE.test(h)) coordCols.add(i); });

  const rows = [header];
  for (const r of merged.rows) {
    const values = r.values.slice();
    if (opt.addSource) values.push(r.source);
    rows.push(values.map(function (v, i) {
      if (coordCols.has(i) && typeof v === 'number') return { v: v, s: L.S.NUM6 };
      return v;
    }));
  }

  const cols = header.map(function (h, i) {
    if (coordCols.has(i)) return 14;
    return i === 0 ? 70 : 22;
  });

  return [{ name: String(opt.sheetName || 'Объединено').slice(0, 31), cols: cols, rows: rows }];
}

root.MergeCore = {
  DEFAULTS: DEFAULTS,
  readTables: readTables,
  mergeTables: mergeTables,
  buildReport: buildReport,
  splitHeader: splitHeader
};

})(typeof globalThis !== 'undefined' ? globalThis : this);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.MergeCore;
