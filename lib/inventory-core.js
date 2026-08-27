/* ============================================================================
   Инвенто — подготовка эфирной справки к отправке клиенту (порт script.py).

   Делает три вещи с исходным xlsx:
     1. удаляет столбец «Комиссия платформы» (наша внутренняя комиссия — не
        для клиента);
     2. вставляет столбец «№» в начало и нумерует строки по порядку;
     3. переставляет строки: сначала показанные строки (Кол-во показов > 0),
        отсортированные по GID, затем непоказанные — в исходном порядке.

   Как и в азимутах — это ХИРУРГИЧЕСКАЯ правка XML одного листа внутри ZIP,
   а не readXlsx/writeXlsx. Причина та же: обычный openpyxl-подход (что и
   делает исходный script.py через ws.insert_cols/ws.delete_cols) на практике
   ломает форматирование — не косметически, а заметно:

     - ws.insert_cols(1) не переносит ширину столбцов дальше вставленного:
       из 11 заданных ширин в реальном файле после вставки+удаления остаются
       всего 5 — остальные столбцы (Город, Формат экрана, Бюджет, Сумма OTS…)
       съезжают на автоширину;
     - у новой ячейки «№» в шапке нет вообще никакого стиля — ни жирного, ни
       зелёной заливки, ни рамки, — хотя все соседние ячейки шапки её имеют
       (обнаружено сравнением реального input/output script.py: столбец A11
       выходит с fill=none/bold=False, у остальных — fill=E2EFD9/bold=True);
     - число потом перезаписывается Excel-ем при пересохранении числового
       формата («# ##0» → «#\ ##0» — визуально то же, но лишний дифф).

   Здесь же ни один стиль не декомпозируется и не создаётся заново: каждая
   существующая ячейка просто переезжает на новые координаты (меняется
   только r="...", всё остальное — s=, t=, содержимое — байт-в-байт), а
   новые ячейки «№» берут ЦЕЛИКОМ индекс стиля соседней ячейки той же
   (новой) строки. Ширины столбцов пересчитываются той же перестановкой, а
   не пересобираются заново. Гиперссылки (переезжают вместе со своей
   ячейкой) и все остальные части архива (styles.xml, sharedStrings.xml,
   темы) копируются в новый ZIP байт-в-байт.

   Зависит от OmniLib.
   ========================================================================== */
(function (root) {
'use strict';

const L = root.OmniLib;

const DEFAULTS = {
  gidHeader: 'GID',
  impHeader: 'Кол-во показов',
  dropHeader: 'Комиссия платформы',
  numberHeader: '№',
  numberColWidth: 6,
  headerScanRows: 60
};

/* Та же лениво-квантифицированная регулярка, что и в azimuth-core.js/omnilib.js —
   жадная версия на самозакрывающихся пустых ячейках склеивает соседние
   элементы и тихо портит данные (подробности там же). */
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
    rows.push({ num: num, attrs: attrs, cells: parseCells(inner) });
  }
  return rows;
}

function parseCells(inner) {
  const cells = [];
  const re = new RegExp(CELL_RE);
  let m, autoCol = 0;
  while ((m = re.exec(inner))) {
    const attrs = m[1] || '';
    const selfClosing = m[2] === '/>';
    const body = selfClosing ? '' : (m[3] || '');
    const refM = /\br="([A-Za-z]+)\d+"/.exec(attrs);
    const col = refM ? L.colToIndex(refM[1]) : autoCol;
    autoCol = col + 1;
    cells.push({ col: col, attrs: attrs, selfClosing: selfClosing, body: body });
  }
  return cells;
}

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
  return sM ? sM[0] : '';
}

/* Ищет ячейку с текстом targetName (без учёта регистра) в первых maxRows
   строках листа — так находим строку шапки и столбец GID. */
function findHeaderCell(rows, targetName, maxRows, shared) {
  const target = targetName.trim().toLowerCase();
  for (const row of rows) {
    if (row.num > maxRows) continue;
    for (const cell of row.cells) {
      const v = cellValue(cell, shared);
      if (v !== null && String(v).trim().toLowerCase() === target) return { row: row.num, col: cell.col };
    }
  }
  return null;
}

/* Ищет ячейку с таким текстом ТОЛЬКО в указанной строке (остальные столбцы
   шапки — они все в одной строке с GID, отдельного скана не нужно). */
function findInRow(row, targetName, shared) {
  if (!row) return null;
  const target = targetName.trim().toLowerCase();
  for (const cell of row.cells) {
    const v = cellValue(cell, shared);
    if (v !== null && String(v).trim().toLowerCase() === target) return cell.col;
  }
  return null;
}

function maxRowUsed(rows) {
  let max = 0;
  for (const row of rows) if (row.num > max) max = row.num;
  return max;
}

/* Некоторые выгрузки делают шапку в 2 физические строки — вертикальный
   мёрдж A11:A12, B11:B12... (например, у столбцов «Источник OTS» и
   «Фотоотчет» вторая строка несёт легенду «Фото 1» вместо мёрджа).
   cellValue/cellInRow читают XML буквально и не знают про <mergeCells>,
   поэтому вторая строка шапки выглядит как обычная строка данных с кучей
   пустых строк — а пустой GID ('') сортируется раньше любого настоящего
   и отъедает номер 1 у первого реального экрана. Раздвигаем dataStart за
   нижнюю границу любого мёрджа, начинающегося в headerRow. */
function mergedHeaderBottom(sheetXml, headerRow) {
  let bottom = headerRow;
  const mcRe = /<mergeCell\s+ref="[A-Za-z]+(\d+):[A-Za-z]+(\d+)"\s*\/>/g;
  let m;
  while ((m = mcRe.exec(sheetXml))) {
    const r1 = parseInt(m[1], 10), r2 = parseInt(m[2], 10);
    if (r1 <= headerRow && r2 > bottom) bottom = r2;
  }
  return bottom;
}

/* ─────────────────── перестановка координат ─────────────────── */

/* Столбец: dropCol удаляется целиком, всё после него сдвигается влево на 1,
   затем всё сдвигается вправо на 1 (вставка нового столбца в начало).
   Итог для столбца ПОСЛЕ dropCol — тот же самый номер (сдвиги гасят друг
   друга); для столбца ДО dropCol — просто +1. */
function remapColumn(oldCol0, dropCol0) {
  if (dropCol0 !== null && oldCol0 === dropCol0) return null;
  let c = oldCol0;
  if (dropCol0 !== null && oldCol0 > dropCol0) c -= 1;
  return c + 1;
}

/* Ключ сортировки — точный аналог str(x[0][GID_COL-1]) из script.py: у
   Python str(None) == 'None', а не пустая строка — тот же ключ и здесь,
   чтобы порядок совпадал буква в букву. */
function gidSortKey(v) {
  if (v === null || v === undefined) return 'None';
  return String(v);
}

/* ─────────────────────────── правка файла ──────────────────────────── */

async function firstSheetPath(wbXml, relsXml) {
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
  return new TextDecoder('utf-8').decode(await L.zipRead(zip, entry));
}

async function patchFile(file, options) {
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
  const sheetInfo = await firstSheetPath(wbXml, relsXml);
  const sheetEntry = sheetInfo && byName.get(sheetInfo.path);
  if (!sheetEntry) return Object.assign(result, { action: 'skipped', reason: 'не нашёл лист в архиве' });

  let sheetXml = await entryText(zip, sheetEntry);
  let shared = [];
  const ssEntry = byName.get('xl/sharedStrings.xml');
  if (ssEntry) shared = L.parseSharedStrings(await entryText(zip, ssEntry));

  const rows = parseRows(sheetXml);
  const maxRow = maxRowUsed(rows);

  const gidHit = findHeaderCell(rows, opt.gidHeader, opt.headerScanRows, shared);
  if (!gidHit) {
    return Object.assign(result, {
      action: 'skipped',
      reason: 'столбец «' + opt.gidHeader + '» не найден в первых ' + opt.headerScanRows + ' строках'
    });
  }
  const headerRow = gidHit.row, gidCol0 = gidHit.col;
  const rowByNum = new Map(rows.map(function (r) { return [r.num, r]; }));
  const headerRowObj = rowByNum.get(headerRow);

  const impCol0 = findInRow(headerRowObj, opt.impHeader, shared);
  const dropCol0 = findInRow(headerRowObj, opt.dropHeader, shared);
  const dataStart = mergedHeaderBottom(sheetXml, headerRow) + 1;
  const dataEnd = maxRow;

  // ── порядок строк данных: показанные (сорт по GID) → непоказанные (как были) ──
  const nonzero = [], zero = [];
  for (let r = dataStart; r <= dataEnd; r++) {
    const row = rowByNum.get(r);
    if (!row) continue;
    const imp = impCol0 === null ? 1 : cellValue(cellInRow(row, impCol0), shared);
    const isZero = imp === 0 || imp === null || imp === undefined;
    (isZero ? zero : nonzero).push(row);
  }
  nonzero.sort(function (a, b) {
    const ka = gidSortKey(cellValue(cellInRow(a, gidCol0), shared));
    const kb = gidSortKey(cellValue(cellInRow(b, gidCol0), shared));
    return ka < kb ? -1 : (ka > kb ? 1 : 0);
  });
  const orderedDataRows = nonzero.concat(zero);

  const newRowOf = new Map();  // старый номер строки → новый
  orderedDataRows.forEach(function (row, i) { newRowOf.set(row.num, dataStart + i); });

  // ── переносим все ячейки листа на новые координаты ──
  const byNewRow = new Map();  // newRow → [{col, xml}]
  function place(newRow, col0, xml) {
    let arr = byNewRow.get(newRow);
    if (!arr) { arr = []; byNewRow.set(newRow, arr); }
    arr.push({ col: col0, xml: xml });
  }
  function rebuildCell(cell, newCol0, newRow) {
    const ref = L.indexToCol(newCol0) + newRow;
    const newAttrs = /\br="[^"]*"/.test(cell.attrs)
      ? cell.attrs.replace(/\br="[^"]*"/, 'r="' + ref + '"')
      : ' r="' + ref + '"' + cell.attrs;
    return '<c' + newAttrs + (cell.selfClosing ? '/>' : '>' + cell.body + '</c>');
  }

  /* Шапка отчёта над таблицей («Рекламодатель», «Период размещения», «Бюджет»…)
     живёт в тех же A/B, но к таблице отношения не имеет: столбец «№» ей не
     нужен, а от сдвига вправо она просто уезжала на пустую колонку. Строки
     ВЫШЕ строки заголовков оставляем на месте — двигаем только таблицу. */
  function mapRow(r) {
    return (r >= dataStart && r <= dataEnd) ? newRowOf.get(r) : r;
  }
  function mapCol(col0, rowNum) {
    return rowNum < headerRow ? col0 : remapColumn(col0, dropCol0);
  }

  for (const row of rows) {
    const newRow = mapRow(row.num);
    if (newRow === undefined) continue; // строка вне диапазона данных без записи (не бывает, но на всякий случай)
    for (const cell of row.cells) {
      const newCol0 = mapCol(cell.col, row.num);
      if (newCol0 === null) continue; // столбец «Комиссия платформы» — выбрасываем
      place(newRow, newCol0, rebuildCell(cell, newCol0, newRow));
    }
  }

  // ── новый столбец «№»: в шапке — текст со стилем соседа, в данных — номер по порядку ──
  function neighborStyle(newRow) {
    const arr = byNewRow.get(newRow) || [];
    const sib = arr.find(function (c) { return c.col === 1; });
    if (!sib) return '';
    const sM = /\bs="(\d+)"/.exec(sib.xml);
    return sM ? ' ' + sM[0] : '';
  }
  function numberCell(newRow, col0, value, styleAttr) {
    const ref = L.indexToCol(col0) + newRow;
    if (typeof value === 'number') {
      return '<c r="' + ref + '"' + styleAttr + ' t="n"><v>' + value + '</v></c>';
    }
    return '<c r="' + ref + '"' + styleAttr + ' t="inlineStr"><is><t xml:space="preserve">' +
      L.escapeXml(String(value)) + '</t></is></c>';
  }
  place(headerRow, 0, numberCell(headerRow, 0, opt.numberHeader, neighborStyle(headerRow)));
  /* Шапка в две физические строки (A11:A12…): у соседей есть нижняя половинка,
     у нового «№» её не было — заголовок висел в верхней ячейке, а под ним
     зияла дыра без заливки и рамки. Кладём пустые ячейки того же стиля;
     сам мёрдж A11:A12 добавляется ниже, вместе с остальными. */
  for (let r = headerRow + 1; r < dataStart; r++) {
    place(r, 0, '<c r="' + L.indexToCol(0) + r + '"' + neighborStyle(r) + '/>');
  }
  orderedDataRows.forEach(function (row, i) {
    const newRow = dataStart + i;
    place(newRow, 0, numberCell(newRow, 0, i + 1, neighborStyle(newRow)));
  });

  // ── <sheetData> целиком по новым координатам ──
  const newRowNums = [...byNewRow.keys()].sort(function (a, b) { return a - b; });
  let sheetDataInner = '';
  for (const rn of newRowNums) {
    const cells = byNewRow.get(rn).sort(function (a, b) { return a.col - b.col; });
    sheetDataInner += '<row r="' + rn + '">' + cells.map(function (c) { return c.xml; }).join('') + '</row>';
  }
  sheetXml = sheetXml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, '<sheetData>' + sheetDataInner + '</sheetData>');

  // ── <cols> — те же ширины, сдвинутые по той же формуле, плюс новый столбец «№» ──
  const colsM = /<cols>([\s\S]*?)<\/cols>/.exec(sheetXml);
  if (colsM) {
    const colRe = /<col\b([^>]*)\/>/g;
    const newCols = [];
    let cm;
    while ((cm = colRe.exec(colsM[1]))) {
      const a = cm[1];
      const minM = /\bmin="(\d+)"/.exec(a), maxM = /\bmax="(\d+)"/.exec(a);
      if (!minM || !maxM) continue;
      const lo = parseInt(minM[1], 10) - 1, hi = parseInt(maxM[1], 10) - 1; // 0-based
      const rest = a.replace(/\bmin="\d+"/, '').replace(/\bmax="\d+"/, '').replace(/\s{2,}/g, ' ').trim();
      for (let c = lo; c <= hi; c++) {
        const nc = remapColumn(c, dropCol0);
        if (nc === null) continue;
        newCols.push('<col min="' + (nc + 1) + '" max="' + (nc + 1) + '"' + (rest ? ' ' + rest : '') + '/>');
      }
    }
    newCols.push('<col min="1" max="1" width="' + opt.numberColWidth + '" customWidth="1"/>');
    newCols.sort(function (x, y) {
      return parseInt(/min="(\d+)"/.exec(x)[1], 10) - parseInt(/min="(\d+)"/.exec(y)[1], 10);
    });
    sheetXml = sheetXml.slice(0, colsM.index) + '<cols>' + newCols.join('') + '</cols>' +
      sheetXml.slice(colsM.index + colsM[0].length);
  }

  // ── <mergeCells> — те же мёрджи по новым координатам ──
  // Без этого весь блок оставался на исходных буквах и после вставки «№»
  // съезжал на столбец влево: вертикальные мёрджи шапки накрывали не свои
  // колонки, а горизонтальный «Фотоотчет» (M11:N11) вместо пары «Фото 1 /
  // Фото 2» захватывал «Источник OTS» — отсюда и спотыкание на двойном ФО.
  const mcM = /<mergeCells\b[^>]*>([\s\S]*?)<\/mergeCells>/.exec(sheetXml);
  if (mcM) {
    const refs = [];
    // «№» мёрджим на ту же высоту, что и соседние столбцы шапки
    if (dataStart > headerRow + 1) {
      refs.push(L.indexToCol(0) + headerRow + ':' + L.indexToCol(0) + (dataStart - 1));
    }
    const mcRe = /<mergeCell\b[^>]*\bref="([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)"[^>]*\/>/g;
    let mc;
    while ((mc = mcRe.exec(mcM[1]))) {
      const r1 = parseInt(mc[2], 10), r2 = parseInt(mc[4], 10);
      const c1 = L.colToIndex(mc[1]), c2 = L.colToIndex(mc[3]);
      const nr1 = mapRow(r1), nr2 = mapRow(r2);
      if (nr1 === undefined || nr2 === undefined) continue;
      // край, стоявший ровно на удалённом столбце, поджимаем внутрь мёрджа
      const n1 = (r1 >= headerRow && c1 === dropCol0) ? remapColumn(c1 + 1, dropCol0) : mapCol(c1, r1);
      const n2 = (r2 >= headerRow && c2 === dropCol0) ? remapColumn(c2 - 1, dropCol0) : mapCol(c2, r2);
      if (n1 === null || n2 === null || n1 > n2 || nr1 > nr2) continue;
      refs.push(L.indexToCol(n1) + nr1 + ':' + L.indexToCol(n2) + nr2);
    }
    sheetXml = sheetXml.slice(0, mcM.index) +
      (refs.length
        ? '<mergeCells count="' + refs.length + '">' +
          refs.map(function (r) { return '<mergeCell ref="' + r + '"/>'; }).join('') + '</mergeCells>'
        : '') +
      sheetXml.slice(mcM.index + mcM[0].length);
  }

  // ── <dimension> — правый край уехал на столбец, Excel иначе «чинит» файл ──
  if (/<dimension\b[^>]*\/>/.test(sheetXml)) {
    let maxCol = 0, maxRowOut = 0;
    for (const [rn, arr] of byNewRow) {
      if (rn > maxRowOut) maxRowOut = rn;
      for (const c of arr) if (c.col > maxCol) maxCol = c.col;
    }
    sheetXml = sheetXml.replace(/<dimension\b[^>]*\/>/,
      '<dimension ref="A1:' + L.indexToCol(maxCol) + maxRowOut + '"/>');
  }

  // ── <hyperlinks> — те же ссылки, ref переезжает вместе с ячейкой ──
  const hlM = /<hyperlinks>([\s\S]*?)<\/hyperlinks>/.exec(sheetXml);
  if (hlM) {
    const hlRe = /<hyperlink\b([^>]*)\/>/g;
    const newLinks = [];
    let hm;
    while ((hm = hlRe.exec(hlM[1]))) {
      const a = hm[1];
      const refM = /\bref="([A-Za-z]+)(\d+)"/.exec(a);
      if (!refM) continue;
      const oldCol0 = L.colToIndex(refM[1]), oldRow = parseInt(refM[2], 10);
      const newRow = mapRow(oldRow);
      const newCol0 = mapCol(oldCol0, oldRow);
      if (newCol0 === null || newRow === undefined) continue; // ссылка была в удалённом столбце/строке
      const newRef = L.indexToCol(newCol0) + newRow;
      newLinks.push('<hyperlink' + a.replace(/\bref="[^"]*"/, 'ref="' + newRef + '"') + '/>');
    }
    sheetXml = sheetXml.slice(0, hlM.index) +
      (newLinks.length ? '<hyperlinks>' + newLinks.join('') + '</hyperlinks>' : '') +
      sheetXml.slice(hlM.index + hlM[0].length);
  }

  const outFiles = [];
  for (const e of zip.entries) {
    if (e.isDir) continue;
    outFiles.push({ name: e.name, bytes: (e === sheetEntry) ? L.encodeUtf8(sheetXml) : await L.zipRead(zip, e) });
  }
  const blob = L.zipWrite(outFiles);

  return Object.assign(result, {
    action: 'ok',
    headerRow: headerRow,
    rows: orderedDataRows.length,
    nonzero: nonzero.length,
    zero: zero.length,
    droppedColumn: dropCol0 !== null,
    dropNote: dropCol0 === null ? 'столбец «' + opt.dropHeader + '» не найден — ничего не удалено' : null,
    impNote: impCol0 === null ? 'столбец «' + opt.impHeader + '» не найден — сортировка без разделения на показанные/непоказанные' : null,
    blob: blob
  });
}

root.InventoryCore = {
  DEFAULTS: DEFAULTS,
  patchFile: patchFile,
  /* низкоуровневые — для гайда/тестов */
  parseRows: parseRows,
  cellValue: cellValue,
  findHeaderCell: findHeaderCell,
  findInRow: findInRow,
  remapColumn: remapColumn,
  gidSortKey: gidSortKey,
  mergedHeaderBottom: mergedHeaderBottom
};

})(typeof globalThis !== 'undefined' ? globalThis : this);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.InventoryCore;
