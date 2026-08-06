/* ============================================================================
   Добавление азимутов (порт add_azimuth.py) — хирургическая правка xlsx.

   В отличие от ТТ/креативов/объединения этот инструмент не строит новый файл
   с нуля: он берёт существующую «эфирку» (со своими стилями, объединёнными
   ячейками, шириной столбцов, гиперссылками на фото) и добавляет ОДИН
   столбец, не трогая остальное. Обычное readXlsx/writeXlsx из omnilib для
   этого не годится: readXlsx читает только значения (без стилей, merge,
   гиперссылок), а writeXlsx умеет писать лишь свой фиксированный набор
   стилей — весь остальной вид файла был бы потерян.

   Поэтому здесь редактируется НЕПОСРЕДСТВЕННО XML-текст одного листа внутри
   ZIP: правки — это точечные замены подстрок по абсолютным смещениям в
   исходной строке (без DOMParser — тем же приёмом, что и остальной omnilib,
   регулярками по образцу parseSheetXml). Все остальные части архива
   (styles.xml, гиперссылки, темы, другие листы) копируются в новый ZIP
   БАЙТ-В-БАЙТ, без разбора — так они гарантированно не меняются.

   Стиль новых ячеек не собирается заново (шрифт+заливка+рамка+выравнивание,
   как в add_azimuth.py) — переиспользуется ЦЕЛИКОМ индекс стиля (`s=`)
   соседней ячейки GID той же строки. Это не декомпозиция, а копия готовой
   записи из styles.xml, которую мы даже не трогаем: визуально то же самое,
   что и в Python-версии, без риска собрать стиль неточно.

   Зависит от OmniLib.
   ========================================================================== */
(function (root) {
'use strict';

const L = root.OmniLib;

const DEFAULTS = {
  gidColumn: 'GID',
  headerScanRows: 20,
  gidField: 'screen_id',
  azimuthField: 'azimuth',
  azimuthHeader: 'Азимут'
};

/* ─────────────────────── источник: {GID -> азимут} ─────────────────────── */
/* Источник (inventories_sync) не редактируется, только читается — тут вполне
   годится обычный readXlsx (десятки тысяч строк, но только значения). */
async function loadAzimuthMap(file, options) {
  const opt = Object.assign({}, DEFAULTS, options || {});
  const wb = await L.readXlsx(L.blobSource(file));
  if (!wb.sheets.length) throw new Error('в файле-источнике нет листов');
  const sheet = wb.sheets[0];
  const header = (sheet.rows[0] || []).map(function (v) { return L.cellStr(v).toLowerCase(); });
  const gidIdx = header.indexOf(opt.gidField.toLowerCase());
  const azIdx = header.indexOf(opt.azimuthField.toLowerCase());
  if (gidIdx < 0) {
    throw new Error('в источнике не найден столбец «' + opt.gidField + '». Доступные: ' +
      (sheet.rows[0] || []).map(L.cellStr).join(', '));
  }
  if (azIdx < 0) {
    throw new Error('в источнике не найден столбец «' + opt.azimuthField + '». Доступные: ' +
      (sheet.rows[0] || []).map(L.cellStr).join(', '));
  }

  const map = new Map();
  for (let i = 1; i < sheet.rows.length; i++) {
    const row = sheet.rows[i] || [];
    const gid = row[gidIdx];
    const az = row[azIdx];
    if (gid === null || gid === undefined || String(gid).trim() === '') continue;
    if (az === null || az === undefined || String(az).trim() === '') continue;
    map.set(String(gid).trim(), az);
  }
  return { map: map, total: map.size, rows: Math.max(0, sheet.rows.length - 1) };
}

/* ───────────────────── низкоуровневый разбор sheetN.xml ────────────────── */
/* Все смещения — абсолютные, относительно ИСХОДНОЙ строки xml. Правки
   применяются позже одним проходом, от конца строки к началу — тогда более
   ранние смещения не сдвигаются и пересчитывать их не нужно. */

/* Группа атрибутов — ЛЕНИВАЯ ([^>]*?). С жадной версией самозакрывающийся
   элемент (пустая <c t="inlineStr"/> — Excel так пишет стилизованную, но
   безо всякого значения ячейку) на некоторых файлах склеивался со СЛЕДУЮЩИМ
   элементом и сдвигал всю остальную строку на одну ячейку — без единой
   ошибки, только тихо неверные данные. Подробности и репро — в
   lib/omnilib.js рядом с тем же исправлением в parseSheetXml. */
const ROW_RE = /<row\b([^>]*?)(\/>|>([\s\S]*?)<\/row>)/g;
const CELL_RE = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;

function parseRows(xml) {
  const rows = [];
  const re = new RegExp(ROW_RE);
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1] || '';
    const selfClosing = m[2] === '/>';
    const inner = selfClosing ? '' : (m[3] || '');
    const rAttr = /\br="(\d+)"/.exec(attrs);
    const num = rAttr ? parseInt(rAttr[1], 10) : (rows.length + 1);
    const openTagEnd = m.index + 4 + attrs.length + (selfClosing ? 2 : 1);
    rows.push({
      num: num,
      start: m.index,
      end: m.index + m[0].length,
      attrs: attrs,
      selfClosing: selfClosing,
      inner: inner,
      innerStart: openTagEnd,               // абсолютное начало тела строки
      innerEnd: openTagEnd + inner.length,   // абсолютный конец тела (перед </row>)
      cells: parseCells(inner, openTagEnd)
    });
  }
  return rows;
}

function parseCells(inner, base) {
  const cells = [];
  const re = new RegExp(CELL_RE);
  let m, autoCol = 0;
  while ((m = re.exec(inner))) {
    const attrs = m[1] || '';
    const selfClosing = m[2] === '/>';
    const body = selfClosing ? '' : (m[3] || '');
    const refM = /\br="([A-Za-z]+\d+)"/.exec(attrs);
    const col = refM ? L.colToIndex(refM[1]) : autoCol;
    autoCol = col + 1;
    cells.push({
      col: col,
      start: base + m.index,
      end: base + m.index + m[0].length,
      attrs: attrs,
      selfClosing: selfClosing,
      body: body
    });
  }
  return cells;
}

/* Значение ячейки как строка/число — тот же порядок типов, что в
   OmniLib.parseSheetXml (inlineStr → shared → str/e/b → число). */
function cellValue(cell, shared) {
  if (!cell) return null;
  const tM = /\bt="([^"]+)"/.exec(cell.attrs);
  const type = tM ? tM[1] : 'n';
  if (type === 'inlineStr') {
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
    let t;
    while ((t = tRe.exec(cell.body))) text += L.unescapeXml(t[1] || '');
    return text;
  }
  const vM = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cell.body);
  const raw = vM ? L.unescapeXml(vM[1]) : null;
  if (raw === null || raw === '') return null;
  if (type === 's') return (shared && shared[parseInt(raw, 10)]) !== undefined ? shared[parseInt(raw, 10)] : null;
  if (type === 'str' || type === 'e') return raw;
  if (type === 'b') return raw === '1';
  const num = Number(raw);
  return isNaN(num) ? raw : num;
}

function cellInRow(row, col) {
  for (const c of row.cells) if (c.col === col) return c;
  return null;
}

function styleAttrOf(cell) {
  if (!cell) return '';
  const sM = /\bs="(\d+)"/.exec(cell.attrs);
  return sM ? sM[0] : '';   // 's="N"' целиком либо '' (стиль по умолчанию)
}

/* Ищет ячейку с текстом targetName (без учёта регистра) в первых maxRows
   строках — как find_header_cell в add_azimuth.py. */
function findHeaderCell(rows, targetName, maxRows, shared) {
  const target = targetName.trim().toLowerCase();
  for (const row of rows) {
    if (row.num > maxRows) continue;
    for (const cell of row.cells) {
      const v = cellValue(cell, shared);
      if (v !== null && String(v).trim().toLowerCase() === target) {
        return { row: row.num, col: cell.col };
      }
    }
  }
  return null;
}

/* Границы шапки для данного столбца по <mergeCells> — как
   get_header_row_span в add_azimuth.py. */
function mergeSpan(xml, headerRow, col) {
  const mcM = /<mergeCells\b[^>]*>([\s\S]*?)<\/mergeCells>/.exec(xml);
  if (mcM) {
    const re = /<mergeCell\b[^>]*ref="([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)"/g;
    let m;
    while ((m = re.exec(mcM[1]))) {
      const c1 = L.colToIndex(m[1]), r1 = parseInt(m[2], 10);
      const c2 = L.colToIndex(m[3]), r2 = parseInt(m[4], 10);
      const minR = Math.min(r1, r2), maxR = Math.max(r1, r2);
      const minC = Math.min(c1, c2), maxC = Math.max(c1, c2);
      if (minR <= headerRow && headerRow <= maxR && minC <= col && col <= maxC) {
        return { start: minR, end: maxR };
      }
    }
  }
  return { start: headerRow, end: headerRow };
}

/* Строка, с которой начинаются данные, — ИСПРАВЛЕННАЯ версия эвристики из
   add_azimuth.py (см. там же и в README про сам баг). Раньше признаком
   «здесь подзаголовок, а не данные» считалось «в строке есть хоть что-то» —
   а у настоящей строки данных есть всегда, поэтому для файлов с
   одностроч­ной (не объединённой) шапкой первая строка данных пропускалась
   молча. Правильный признак — пустая именно ячейка GID: у данных она есть
   всегда, у строки-подзаголовка (напр. дата в «Статистика по дням») — нет. */
function detectDataStart(rowByNum, maxRow, headerEnd, gidCol, shared) {
  const rowAfter = headerEnd + 1;
  if (rowAfter > maxRow) return rowAfter;
  const row = rowByNum.get(rowAfter);
  if (!row) return rowAfter;
  const gidCell = cellInRow(row, gidCol);
  const gidVal = cellValue(gidCell, shared);
  const gidEmpty = gidVal === null || String(gidVal).trim() === '';
  if (!gidEmpty) return rowAfter;
  const hasOther = row.cells.some(function (c) {
    if (c.col === gidCol) return false;
    const v = cellValue(c, shared);
    return v !== null && String(v).trim() !== '';
  });
  return hasOther ? rowAfter + 1 : rowAfter;
}

function maxColumnUsed(rows) {
  let max = -1;
  for (const row of rows) for (const c of row.cells) if (c.col > max) max = c.col;
  return max;
}

function maxRowUsed(rows) {
  let max = 0;
  for (const row of rows) if (row.num > max) max = row.num;
  return max;
}

/* ───────────────────────── сборка новой ячейки ──────────────────────────── */

function buildCell(colIdx, rowNum, styleAttr, value) {
  const ref = L.indexToCol(colIdx) + rowNum;
  if (value === null || value === undefined || value === '') {
    return '<c r="' + ref + '"' + (styleAttr ? ' ' + styleAttr : '') + ' t="n"></c>';
  }
  if (typeof value === 'number' && isFinite(value)) {
    return '<c r="' + ref + '"' + (styleAttr ? ' ' + styleAttr : '') + ' t="n"><v>' + value + '</v></c>';
  }
  // Текст всегда как inlineStr: не трогаем sharedStrings.xml, а смешивать
  // inlineStr с shared-строками в одном листе — валидный OOXML.
  return '<c r="' + ref + '"' + (styleAttr ? ' ' + styleAttr : '') +
    ' t="inlineStr"><is><t xml:space="preserve">' + L.escapeXml(String(value)) + '</t></is></c>';
}

/* Правка одной строки: заменить существующую ячейку столбца targetCol,
   вставить новую в конец, либо (если строки вообще не было в этом
   диапазоне) вставить целую новую <row>. Возвращает {start, end, text} —
   заготовку для applyEdits. rowByNum/sortedNums — для случая «строки нет». */
function planRowEdit(xml, rowByNum, sortedNums, rowNum, targetCol, styleAttr, value) {
  const row = rowByNum.get(rowNum);
  const cellXml = buildCell(targetCol, rowNum, styleAttr, value);

  if (!row) {
    // Такой строки в листе нет вовсе (полностью пустая, «дырка» в разметке).
    // Вставляем новую <row> перед первой строкой с большим номером —
    // либо перед </sheetData>, если это последняя строка листа.
    let insertAt = -1;
    for (const n of sortedNums) {
      if (n > rowNum) { insertAt = rowByNum.get(n).start; break; }
    }
    if (insertAt < 0) {
      const sd = /<\/sheetData>/.exec(xml);
      insertAt = sd ? sd.index : xml.length;
    }
    return { start: insertAt, end: insertAt, text: '<row r="' + rowNum + '">' + cellXml + '</row>' };
  }

  const existing = cellInRow(row, targetCol);
  if (existing) {
    return { start: existing.start, end: existing.end, text: cellXml };
  }
  if (row.selfClosing) {
    return { start: row.start, end: row.end, text: '<row' + row.attrs + '>' + cellXml + '</row>' };
  }
  // Вставляем в конец детей строки. Целевой столбец у нас почти всегда
  // последний (max+1), так что позиция и без сортировки будет верной; если
  // когда-то он окажется не последним — ячейка всё равно попадёт в строку,
  // просто не по возрастанию номеров колонок (Excel порядок <c> внутри
  // <row> не требует, читает по r=).
  return { start: row.innerEnd, end: row.innerEnd, text: cellXml };
}

/* Обновляет spans="a:b" строки, если новый столбец вышел за старую границу. */
function planSpansEdit(row, targetCol) {
  const m = /\bspans="(\d+):(\d+)"/.exec(row.attrs);
  if (!m) return null;
  const lo = parseInt(m[1], 10), hi = parseInt(m[2], 10);
  const need = targetCol + 1;
  if (need <= hi) return null;
  const attrStart = row.start + 4 + row.attrs.indexOf(m[0]);
  return { start: attrStart, end: attrStart + m[0].length, text: 'spans="' + lo + ':' + need + '"' };
}

/* ───────────────────────── дополнительные штрихи ────────────────────────── */

/* Ширина столбца GID → тот же width для нового столбца (только когда столбец
   создаётся, а не переиспользуется существующий). */
function planColWidth(xml, gidCol, targetCol) {
  const colsM = /<cols>([\s\S]*?)<\/cols>/.exec(xml);
  if (!colsM) return null;
  const re = /<col\b([^>]*)\/>/g;
  let m, width = null;
  while ((m = re.exec(colsM[1]))) {
    const minM = /\bmin="(\d+)"/.exec(m[1]);
    const maxM = /\bmax="(\d+)"/.exec(m[1]);
    if (!minM || !maxM) continue;
    const lo = parseInt(minM[1], 10) - 1, hi = parseInt(maxM[1], 10) - 1;   // 1-based → 0-based
    if (lo <= gidCol && gidCol <= hi) {
      const wM = /\bwidth="([\d.]+)"/.exec(m[1]);
      if (wM) width = wM[1];
      break;
    }
  }
  if (width === null) return null;
  const insertAt = xml.indexOf('</cols>', colsM.index);
  const colTag = '<col min="' + (targetCol + 1) + '" max="' + (targetCol + 1) +
    '" width="' + width + '" customWidth="1"/>';
  return { start: insertAt, end: insertAt, text: colTag };
}

/* <mergeCells> для нового столбца — только когда шапка объединена НЕ в одну
   строку и столбец создаётся впервые. */
function planMerge(xml, headerStart, headerEnd, targetCol) {
  if (headerEnd <= headerStart) return null;
  const ref = L.indexToCol(targetCol) + headerStart + ':' + L.indexToCol(targetCol) + headerEnd;
  const mcM = /<mergeCells\b([^>]*)count="(\d+)"([^>]*)>([\s\S]*?)<\/mergeCells>/.exec(xml);
  if (mcM) {
    const newCount = parseInt(mcM[2], 10) + 1;
    const insertAt = mcM.index + mcM[0].length - '</mergeCells>'.length;
    return [
      { start: mcM.index, end: mcM.index + mcM[0].indexOf('>') + 1,
        text: '<mergeCells' + mcM[1] + 'count="' + newCount + '"' + mcM[3] + '>' },
      { start: insertAt, end: insertAt, text: '<mergeCell ref="' + ref + '"/>' }
    ];
  }
  const sdEnd = /<\/sheetData>/.exec(xml);
  const insertAt = sdEnd ? sdEnd.index + sdEnd[0].length : xml.length;
  return [{ start: insertAt, end: insertAt,
    text: '<mergeCells count="1"><mergeCell ref="' + ref + '"/></mergeCells>' }];
}

function planDimension(xml, targetCol, maxRow) {
  const dM = /<dimension ref="([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)"\s*\/>/.exec(xml);
  if (!dM) return null;
  const endColIdx = L.colToIndex(dM[3]);
  const endRow = parseInt(dM[4], 10);
  const newEndCol = Math.max(endColIdx, targetCol);
  const newEndRow = Math.max(endRow, maxRow);
  if (newEndCol === endColIdx && newEndRow === endRow) return null;
  return {
    start: dM.index, end: dM.index + dM[0].length,
    text: '<dimension ref="' + dM[1] + dM[2] + ':' + L.indexToCol(newEndCol) + newEndRow + '"/>'
  };
}

/* Применяет правки к исходной строке: сортирует по убыванию start и режет
   строку от конца к началу — более ранние смещения остаются верными. */
function applyEdits(xml, edits) {
  const sorted = edits.filter(Boolean).sort(function (a, b) { return b.start - a.start; });
  let out = xml;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/* ───────────────────────── резолв активного листа ───────────────────────── */
/* Тот же принцип, что и везде в панели (АП, источники) — берём первый лист
   книги. Логика резолва пути через workbook.xml + rels зеркалит внутреннюю
   часть OmniLib.readXlsx (там она не экспортирована как отдельная функция). */
function firstSheetPath(wbXml, relsXml) {
  const rels = {};
  const relRe = /<Relationship\b([^>]*)\/?>/g;
  let rm;
  while ((rm = relRe.exec(relsXml))) {
    const a = rm[1];
    const id = /\bId="([^"]+)"/.exec(a);
    const tgt = /\bTarget="([^"]+)"/.exec(a);
    if (id && tgt) rels[id[1]] = L.unescapeXml(tgt[1]);
  }
  const sm = /<sheet\b([^>]*)\/?>/.exec(wbXml);
  if (!sm) return null;
  const a = sm[1];
  const nameM = /\bname="([^"]*)"/.exec(a);
  const ridM = /\br:id="([^"]+)"/.exec(a) || /\bid="([^"]+)"/.exec(a);
  const name = nameM ? L.unescapeXml(nameM[1]) : 'Sheet1';
  let target = ridM ? rels[ridM[1]] : null;
  if (!target) target = 'worksheets/sheet1.xml';
  let path = target.replace(/^\/+/, '');
  if (!/^xl\//.test(path)) path = 'xl/' + path;
  return { name: name, path: path };
}

async function entryText(zip, entry) {
  const bytes = await L.zipRead(zip, entry);
  return new TextDecoder('utf-8').decode(bytes);
}

/* ─────────────────────────── правка одного файла ────────────────────────── */

async function patchFile(file, azimuthMap, options) {
  const opt = Object.assign({}, DEFAULTS, options || {});
  const zip = await L.zipOpen(L.blobSource(file));
  const byName = new Map();
  for (const e of zip.entries) if (!e.isDir) byName.set(e.name.replace(/^\/+/, ''), e);

  const result = { name: file.name };

  const wbEntry = byName.get('xl/workbook.xml');
  if (!wbEntry) return Object.assign(result, { action: 'skipped', reason: 'это не файл .xlsx' });

  const wbXml = await entryText(zip, wbEntry);
  const relsEntry = byName.get('xl/_rels/workbook.xml.rels');
  const relsXml = relsEntry ? await entryText(zip, relsEntry) : '';
  const sheetInfo = firstSheetPath(wbXml, relsXml);
  const sheetEntry = sheetInfo && byName.get(sheetInfo.path);
  if (!sheetEntry) return Object.assign(result, { action: 'skipped', reason: 'не нашёл лист в архиве' });

  let sheetXml = await entryText(zip, sheetEntry);

  let shared = [];
  const ssEntry = byName.get('xl/sharedStrings.xml');
  if (ssEntry) shared = L.parseSharedStrings(await entryText(zip, ssEntry));

  const rows = parseRows(sheetXml);
  const rowByNum = new Map(rows.map(function (r) { return [r.num, r]; }));
  const sortedNums = rows.map(function (r) { return r.num; }).sort(function (a, b) { return a - b; });
  const maxRow = maxRowUsed(rows);

  const gidHit = findHeaderCell(rows, opt.gidColumn, opt.headerScanRows, shared);
  if (!gidHit) {
    return Object.assign(result, {
      action: 'skipped', reason: 'столбец «' + opt.gidColumn + '» не найден', matched: 0, unmatched: 0
    });
  }
  const gidCol = gidHit.col;
  const span = mergeSpan(sheetXml, gidHit.row, gidCol);
  const headerStart = span.start, headerEnd = span.end;
  const dataStart = detectDataStart(rowByNum, maxRow, headerEnd, gidCol, shared);

  const azHit = findHeaderCell(rows, opt.azimuthHeader, opt.headerScanRows, shared);
  const isNew = !azHit;
  const targetCol = isNew ? maxColumnUsed(rows) + 1 : azHit.col;

  const edits = [];

  // шапка (сама «Азимут» — в верхней строке диапазона; остальные строки
  // диапазона — пустые ячейки со стилем соседней GID-подстроки, как в
  // add_azimuth.py)
  for (let r = headerStart; r <= headerEnd; r++) {
    const row = rowByNum.get(r);
    const gidCell = row ? cellInRow(row, gidCol) : null;
    const style = styleAttrOf(gidCell);
    const value = (r === headerStart) ? opt.azimuthHeader : null;
    edits.push(planRowEdit(sheetXml, rowByNum, sortedNums, r, targetCol, style, value));
    if (row) { const sp = planSpansEdit(row, targetCol); if (sp) edits.push(sp); }
  }

  // данные
  let matched = 0, unmatched = 0;
  for (let r = dataStart; r <= maxRow; r++) {
    const row = rowByNum.get(r);
    if (!row) continue;
    const gidCell = cellInRow(row, gidCol);
    const gidVal = cellValue(gidCell, shared);
    const style = styleAttrOf(gidCell);
    let value = null;
    if (gidVal !== null && String(gidVal).trim() !== '') {
      const az = azimuthMap.get(String(gidVal).trim());
      if (az !== undefined && az !== null && az !== '') { value = az; matched++; }
      else { unmatched++; }
    }
    edits.push(planRowEdit(sheetXml, rowByNum, sortedNums, r, targetCol, style, value));
    const sp = planSpansEdit(row, targetCol); if (sp) edits.push(sp);
  }

  if (isNew) {
    const colEdit = planColWidth(sheetXml, gidCol, targetCol);
    if (colEdit) edits.push(colEdit);
    const mergeEdits = planMerge(sheetXml, headerStart, headerEnd, targetCol);
    if (mergeEdits) edits.push.apply(edits, mergeEdits);
  }
  const dimEdit = planDimension(sheetXml, targetCol, maxRow);
  if (dimEdit) edits.push(dimEdit);

  sheetXml = applyEdits(sheetXml, edits);

  // ── пересобираем zip: непосещённые записи — байт-в-байт, лист — новый ──
  const outFiles = [];
  for (const e of zip.entries) {
    if (e.isDir) continue;
    if (e === sheetEntry) {
      outFiles.push({ name: e.name, bytes: L.encodeUtf8(sheetXml) });
    } else {
      outFiles.push({ name: e.name, bytes: await L.zipRead(zip, e) });
    }
  }
  const blob = L.zipWrite(outFiles);

  return Object.assign(result, {
    action: isNew ? 'added' : 'updated',
    matched: matched, unmatched: unmatched,
    headerRow: headerStart, dataStartRow: dataStart, targetCol: targetCol,
    blob: blob
  });
}

root.AzimuthCore = {
  DEFAULTS: DEFAULTS,
  loadAzimuthMap: loadAzimuthMap,
  patchFile: patchFile,
  /* низкоуровневые — используются гайдом и тестами */
  parseRows: parseRows,
  cellValue: cellValue,
  findHeaderCell: findHeaderCell,
  mergeSpan: mergeSpan,
  detectDataStart: detectDataStart
};

})(typeof globalThis !== 'undefined' ? globalThis : this);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.AzimuthCore;
