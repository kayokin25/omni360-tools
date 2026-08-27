/* Регрессия на раскладку Инвенто после вставки столбца «№».
   Реальный кейс: «Efirnaia_spravka_Kazan…» — шапка отчёта уезжала на пустой
   столбец, <mergeCells> оставались на исходных буквах (из-за чего
   горизонтальный мёрдж «Фотоотчет» съедал «Источник OTS», а пара
   «Фото 1 / Фото 2» разъезжалась), и <dimension> не знал про новый край. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('./omnilib.js');
const I = require('./inventory-core.js');

const s = (v) => '<is><t xml:space="preserve">' + v + '</t></is>';
const c = (ref, v, t) => '<c r="' + ref + '" s="2"' +
  (t === 'n' ? '><v>' + v + '</v></c>' : ' t="inlineStr">' + s(v) + '</c>');

/* Шапка отчёта в строках 1-2, двухстрочная шапка таблицы в 3-4, данные с 5. */
const SHEET =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<dimension ref="A1:E7"/>' +
  '<cols><col min="1" max="1" width="31.25" customWidth="true"/>' +
  '<col min="4" max="4" width="50.0" customWidth="true"/></cols>' +
  '<sheetData>' +
  '<row r="1">' + c('A1', 'Рекламодатель') + c('B1', 'А7 — форумы') + '</row>' +
  '<row r="2">' + c('A2', 'Период размещения') + c('B2', 'август') + '</row>' +
  '<row r="3">' + c('A3', 'Оператор') + c('B3', 'GID') + c('C3', 'Кол-во показов') +
    c('D3', 'Фотоотчет') + c('E3', 'Фотоотчет') + '</row>' +
  '<row r="4">' + c('A4', '') + c('B4', '') + c('C4', '') +
    c('D4', 'Фото 1') + c('E4', 'Фото 2') + '</row>' +
  '<row r="5">' + c('A5', 'РИМ') + c('B5', 'ZZZ-1') + c('C5', 100, 'n') + '</row>' +
  '<row r="6">' + c('A6', 'РИМ') + c('B6', 'AAA-1') + c('C6', 200, 'n') + '</row>' +
  '<row r="7">' + c('A7', 'РИМ') + c('B7', 'MMM-1') + c('C7', 0, 'n') + '</row>' +
  '</sheetData>' +
  '<mergeCells count="4"><mergeCell ref="A3:A4"/><mergeCell ref="B3:B4"/>' +
  '<mergeCell ref="C3:C4"/><mergeCell ref="D3:E3"/></mergeCells>' +
  '</worksheet>';

const FILES = [
  { name: 'xl/workbook.xml', bytes: L.encodeUtf8('<workbook><sheets><sheet name="Лист1" sheetId="1" r:id="rId1"/></sheets></workbook>') },
  { name: 'xl/_rels/workbook.xml.rels', bytes: L.encodeUtf8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
  { name: 'xl/worksheets/sheet1.xml', bytes: L.encodeUtf8(SHEET) }
];

const blob = L.zipWrite(FILES);
const res = await I.patchFile(blob);
assert.equal(res.action, 'ok', res.reason);

const out = await unzipSheet(res.blob);

/* 1. шапка отчёта осталась в A/B — столбец «№» ей не нужен */
assert.match(out, /<c r="A1"[^>]*>[\s\S]*?Рекламодатель/, 'шапка отчёта должна остаться в столбце A');
assert.match(out, /<c r="B1"[^>]*>[\s\S]*?А7 — форумы/, 'значение шапки должно остаться в столбце B');
assert.ok(!/<c r="C1"/.test(out), 'шапка отчёта не должна уезжать вправо');

/* 2. таблица сдвинулась, нумерация с 1 (вторая строка мёрджнутой шапки — не данные) */
assert.match(out, /<c r="A3"[^>]*>[\s\S]*?№/, '«№» в строке заголовков');
assert.match(out, /<c r="B3"[^>]*>[\s\S]*?Оператор/, 'таблица сдвинулась на столбец вправо');
assert.match(out, /<c r="A4"[^>]*\/>/, 'нижняя половинка «№» должна быть — иначе дыра без рамки');
assert.match(out, /<c r="A5"[^>]*><v>1<\/v>/, 'первый экран должен получить номер 1');
assert.match(out, /<c r="C5"[^>]*>[\s\S]*?AAA-1/, 'показанные строки — по GID, непоказанные в конец');
assert.match(out, /<c r="A7"[^>]*><v>3<\/v>/, 'нумерация сквозная до последней строки');

/* 3. мёрджи переехали вместе с ячейками, двойной ФО не разъехался */
const merges = /<mergeCells[^>]*>([\s\S]*?)<\/mergeCells>/.exec(out)[1];
const refs = [...merges.matchAll(/ref="([^"]+)"/g)].map((m) => m[1]);
assert.deepEqual(refs, ['A3:A4', 'B3:B4', 'C3:C4', 'D3:D4', 'E3:F3'],
  'вертикальные мёрджи шапки +1 столбец, «Фотоотчет» D3:E3 → E3:F3, «№» получает свой A3:A4');

/* 4. dimension знает про новый правый край */
assert.match(out, /<dimension ref="A1:F7"\/>/, 'dimension должен доехать до нового края');

console.log('ok: раскладка Инвенто (шапка, мёрджи, двойной ФО, dimension)');

async function unzipSheet(b) {
  const zip = await L.zipOpen(L.blobSource(b));
  const e = zip.entries.find((x) => x.name.replace(/^\/+/, '') === 'xl/worksheets/sheet1.xml');
  return new TextDecoder('utf-8').decode(await L.zipRead(zip, e));
}
