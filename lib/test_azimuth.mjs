// Тесты lib/azimuth-core.js на самодостаточных фикстурах (без внешних файлов —
// в отличие от test_tt.mjs/test_creatives.mjs, реальные «эфирки» лежат вне
// репозитория, это чужие клиентские файлы).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('./omnilib.js');
const A = require('./azimuth-core.js');

let failed = 0;
function ok(cond, label) {
  console.log((cond ? '  ok   ' : '  FAIL ') + label);
  if (!cond) failed++;
}
function eq(actual, expected, label) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((same ? '  ok   ' : '  FAIL ') + label +
    (same ? '' : ('  ожидали ' + JSON.stringify(expected) + ', получили ' + JSON.stringify(actual))));
  if (!same) failed++;
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
  '</Types>';
const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';
const WORKBOOK =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheets><sheet name="Справка" sheetId="1" r:id="rId1"/></sheets></workbook>';
const WORKBOOK_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
  '</Relationships>';
const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="1"><font><sz val="10"/></font></fonts>' +
  '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellXfs count="10">' + '<xf/>'.repeat(10) + '</cellXfs>' +
  '</styleSheet>';

function sharedStringsXml(list) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + list.length +
    '" uniqueCount="' + list.length + '">' +
    list.map(function (s) { return '<si><t>' + s + '</t></si>'; }).join('') + '</sst>';
}

function buildFixture(sheetXml, shared) {
  const files = [
    { name: '[Content_Types].xml', bytes: L.encodeUtf8(CONTENT_TYPES) },
    { name: '_rels/.rels', bytes: L.encodeUtf8(ROOT_RELS) },
    { name: 'xl/workbook.xml', bytes: L.encodeUtf8(WORKBOOK) },
    { name: 'xl/_rels/workbook.xml.rels', bytes: L.encodeUtf8(WORKBOOK_RELS) },
    { name: 'xl/styles.xml', bytes: L.encodeUtf8(STYLES) },
    { name: 'xl/worksheets/sheet1.xml', bytes: L.encodeUtf8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + sheetXml + '</worksheet>'
    ) }
  ];
  if (shared) files.push({ name: 'xl/sharedStrings.xml', bytes: L.encodeUtf8(sharedStringsXml(shared)) });
  const blob = L.zipWrite(files);
  blob.name = 'fixture.xlsx';
  return blob;
}

async function reread(blob) {
  const wb = await L.readXlsx(L.blobSource(blob));
  return wb.sheets[0].rows;
}

/* ══════════════════════ Фикстура 1: одностроч­ная шапка, без merge ══════════
   Ровно тот случай бага: GID-заголовок не объединён, данные идут сразу же.
   До фикса первая строка данных («G-001») пропускалась молча. */
console.log('=== 1. Одностроч­ная шапка (бывший баг: пропуск первой строки данных) ===');
{
  const sheet =
    '<dimension ref="A1:C4"/>' +
    '<cols><col min="1" max="1" width="20" customWidth="1"/>' +
    '<col min="2" max="2" width="15" customWidth="1"/>' +
    '<col min="3" max="3" width="15" customWidth="1"/></cols>' +
    '<sheetData>' +
    '<row r="1" spans="1:3"><c r="A1" s="2" t="inlineStr"><is><t>Оператор</t></is></c>' +
    '<c r="B1" s="2" t="inlineStr"><is><t>GID</t></is></c>' +
    '<c r="C1" s="2" t="inlineStr"><is><t>Город</t></is></c></row>' +
    '<row r="2" spans="1:3"><c r="A2" t="inlineStr"><is><t>Оп1</t></is></c>' +
    '<c r="B2" t="inlineStr"><is><t>G-001</t></is></c>' +
    '<c r="C2" t="inlineStr"><is><t>Казань</t></is></c></row>' +
    '<row r="3" spans="1:3"><c r="A3" t="inlineStr"><is><t>Оп1</t></is></c>' +
    '<c r="B3" t="inlineStr"><is><t>G-002</t></is></c>' +
    '<c r="C3" t="inlineStr"><is><t>Уфа</t></is></c></row>' +
    '<row r="4" spans="1:3"><c r="A4" t="inlineStr"><is><t>Оп1</t></is></c>' +
    '<c r="B4" t="inlineStr"><is><t>G-999</t></is></c>' +
    '<c r="C4" t="inlineStr"><is><t>Самара</t></is></c></row>' +
    '</sheetData>';
  const file = buildFixture(sheet);
  const map = new Map([['G-001', 90], ['G-002', 45]]);
  const res = await A.patchFile(file, map);

  ok(res.action === 'added', 'action = added');
  ok(res.headerRow === 1, 'заголовок в строке 1');
  ok(res.dataStartRow === 2, 'данные с строки 2 (НЕ 3 — старый баг съедал G-001)');
  eq([res.matched, res.unmatched], [2, 1], 'совпало 2, не найдено 1');

  const rows = await reread(res.blob);
  eq(rows[0], ['Оператор', 'GID', 'Город', 'Азимут'], 'шапка: столбец Азимут добавлен последним');
  eq(rows[1], ['Оп1', 'G-001', 'Казань', 90], 'строка 2 (G-001) получила азимут — раньше было бы пусто');
  eq(rows[2], ['Оп1', 'G-002', 'Уфа', 45], 'строка 3 (G-002) получила азимут');
  eq(rows[3], ['Оп1', 'G-999', 'Самара', null], 'строка 4 (G-999) — не найдено, пусто');
}

/* ══════════ Фикстура 2: двухстрочная объединённая шапка + shared strings ═══
   Как настоящие «эфирки» с «Фотоотчет»/«Фото 1»: GID объединён, соседняя
   колонка — нет, у неё свой подзаголовок. */
console.log('\n=== 2. Объединённая шапка + shared strings ===');
{
  const shared = ['Оператор', 'GID', 'Фотоотчет', 'Фото 1', 'Оп1', 'G-100', 'G-200'];
  const sheet =
    '<sheetData>' +
    '<row r="1"><c r="A1" s="2" t="s"><v>0</v></c><c r="B1" s="2" t="s"><v>1</v></c>' +
    '<c r="C1" s="2" t="s"><v>2</v></c></row>' +
    '<row r="2"><c r="A2" s="9" t="n"></c><c r="B2" s="9" t="n"></c>' +
    '<c r="C2" s="2" t="s"><v>3</v></c></row>' +
    '<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3" t="s"><v>5</v></c>' +
    '<c r="C3" t="inlineStr"><is><t>photo-url-1</t></is></c></row>' +
    '<row r="4"><c r="A4" t="s"><v>4</v></c><c r="B4" t="s"><v>6</v></c>' +
    '<c r="C4" t="inlineStr"><is><t>photo-url-2</t></is></c></row>' +
    '<mergeCells count="2"><mergeCell ref="A1:A2"/><mergeCell ref="B1:B2"/></mergeCells>' +
    '</sheetData>';
  // mergeCells должен идти ПОСЛЕ sheetData по схеме — но для теста порядок
  // внутри самодельной фикстуры не важен, наш код ищет <mergeCells> по всему
  // документу независимо от места. В настоящих файлах он и лежит снаружи
  // sheetData — здесь так оставлено ради краткости фикстуры.
  const file = buildFixture(sheet.replace('<mergeCells', '</sheetData><mergeCells').replace('</mergeCells></sheetData>', '</mergeCells>'), shared);
  const map = new Map([['G-100', 12], ['G-200', 200]]);
  const res = await A.patchFile(file, map);

  ok(res.action === 'added', 'action = added');
  eq([res.headerRow, res.dataStartRow], [1, 3], 'шапка 1 (span до 2), данные с 3 — без пропуска');
  eq([res.matched, res.unmatched], [2, 0], 'совпало 2, не найдено 0');

  const rows = await reread(res.blob);
  eq(rows[0], ['Оператор', 'GID', 'Фотоотчет', 'Азимут'], 'шапка с Азимутом');
  ok(rows[1][3] === null || rows[1][3] === '', 'подстрока шапки (D2) — пусто');
  eq(rows[2], ['Оп1', 'G-100', 'photo-url-1', 12], 'строка данных 3');
  eq(rows[3], ['Оп1', 'G-200', 'photo-url-2', 200], 'строка данных 4');
}

/* ══════════ Фикстура 3: genuine под-заголовок без merge (GID-ячейка пуста) ═
   Проверяет ОБЕ стороны исправленной эвристики: не съедает настоящие данные
   (фикстура 1), но всё ещё умеет пропустить строку-подзаголовок, если в ней
   именно ячейка GID пуста. */
console.log('\n=== 3. Под-заголовок без merge (GID-ячейка пуста) ===');
{
  const sheet =
    '<sheetData>' +
    '<row r="1"><c r="A1" t="inlineStr"><is><t>Оператор</t></is></c>' +
    '<c r="B1" t="inlineStr"><is><t>GID</t></is></c>' +
    '<c r="C1" t="inlineStr"><is><t>Показы</t></is></c></row>' +
    '<row r="2"><c r="C2" t="inlineStr"><is><t>Кол-во</t></is></c></row>' +
    '<row r="3"><c r="A3" t="inlineStr"><is><t>Оп1</t></is></c>' +
    '<c r="B3" t="inlineStr"><is><t>G-777</t></is></c>' +
    '<c r="C3" t="n"><v>10</v></c></row>' +
    '</sheetData>';
  const file = buildFixture(sheet);
  const map = new Map([['G-777', 271]]);
  const res = await A.patchFile(file, map);

  eq([res.headerRow, res.dataStartRow], [1, 3], 'подзаголовок (строка 2, GID пуст) правильно пропущен');
  eq([res.matched, res.unmatched], [1, 0], 'совпало 1');
  const rows = await reread(res.blob);
  eq(rows[2], ['Оп1', 'G-777', 10, 271], 'строка 3 (настоящие данные) получила азимут');
}

/* ══════════════════════ Фикстура 4: повторный запуск ═══════════════════════
   Столбец «Азимут» уже есть — не дублируется, а обновляется. */
console.log('\n=== 4. Повторный запуск (Азимут уже есть) ===');
{
  const sheet =
    '<sheetData>' +
    '<row r="1"><c r="A1" t="inlineStr"><is><t>GID</t></is></c>' +
    '<c r="B1" t="inlineStr"><is><t>Азимут</t></is></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><t>G-1</t></is></c><c r="B2" t="n"><v>1</v></c></row>' +
    '</sheetData>';
  const file = buildFixture(sheet);
  const map = new Map([['G-1', 359]]);
  const res = await A.patchFile(file, map);

  ok(res.action === 'updated', 'action = updated (не added)');
  ok(res.targetCol === 1, 'использован существующий столбец, а не новый');
  const rows = await reread(res.blob);
  eq(rows[1], ['G-1', 359], 'старое значение (1) перезаписано новым (359)');
}

/* ══════════════════════ Фикстура 5: столбца GID нет ═════════════════════════ */
console.log('\n=== 5. Нет столбца GID ===');
{
  const sheet = '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Оператор</t></is></c></row></sheetData>';
  const file = buildFixture(sheet);
  const res = await A.patchFile(file, new Map());
  ok(res.action === 'skipped', 'action = skipped');
  ok(/GID/.test(res.reason), 'причина упоминает GID');
}

console.log(failed ? ('\nПРОВАЛЕНО: ' + failed) : '\nвсе проверки пройдены');
process.exitCode = failed ? 1 : 0;
