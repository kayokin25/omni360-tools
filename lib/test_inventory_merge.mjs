/* №111: адрес объединён по вертикали на стороны A/B (B5:B6), значение только в
   верхней ячейке. После перестановки по GID диапазон разъезжается — адрес должен
   остаться у каждой строки, а сам диапазон в мёрджи не попасть. Горизонтальный
   мёрдж строки данных переезжает вместе со строкой. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('./omnilib.js');
const I = require('./inventory-core.js');

const t = (ref, v) => '<c r="' + ref + '" t="inlineStr"><is><t>' + v + '</t></is></c>';
const n = (ref, v) => '<c r="' + ref + '"><v>' + v + '</v></c>';
const SHEET =
  '<worksheet><sheetData>' +
  '<row r="3">' + t('A3', 'GID') + t('B3', 'Адрес') + t('C3', 'Кол-во показов') + t('D3', 'Прим') + '</row>' +
  '<row r="4"><c r="A4"/><c r="B4"/><c r="C4"/><c r="D4"/></row>' +
  '<row r="5">' + t('A5', 'BDB_RC_239A') + t('B5', 'ул. Ленина 1') + n('C5', 0) + '</row>' +
  '<row r="6">' + t('A6', 'BDB_RC_239B') + '<c r="B6" s="3"/>' + n('C6', 10) + '</row>' +
  '<row r="7">' + t('A7', 'AAA_1') + t('B7', 'ул. Мира 2') + n('C7', 5) + t('D7', 'прим') + '<c r="E7"/></row>' +
  '</sheetData><mergeCells count="5"><mergeCell ref="A3:A4"/><mergeCell ref="B3:B4"/><mergeCell ref="C3:C4"/>' +
  '<mergeCell ref="B5:B6"/><mergeCell ref="D7:E7"/></mergeCells></worksheet>';

const blob = L.zipWrite([
  { name: 'xl/workbook.xml', bytes: L.encodeUtf8('<workbook><sheets><sheet name="Лист1" sheetId="1" r:id="rId1"/></sheets></workbook>') },
  { name: 'xl/_rels/workbook.xml.rels', bytes: L.encodeUtf8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
  { name: 'xl/worksheets/sheet1.xml', bytes: L.encodeUtf8(SHEET) }
]);
const res = await I.patchFile(blob);
assert.equal(res.action, 'ok', res.reason);
const zip = await L.zipOpen(L.blobSource(res.blob));
const e = zip.entries.find((x) => x.name.replace(/^\/+/, '') === 'xl/worksheets/sheet1.xml');
const out = new TextDecoder('utf-8').decode(await L.zipRead(zip, e));

// строки: 5 — AAA_1, 6 — BDB_RC_239B (10 показов), 7 — BDB_RC_239A (0); столбец «№» слева
const cell = (ref) => new RegExp('<c r="' + ref + '"[^>]*?(?:/>|>(.*?)</c>)').exec(out)?.[1] ?? '';
assert.match(cell('C5'), /ул. Мира 2/);
assert.match(cell('C6'), /ул. Ленина 1/, 'адрес у уехавшей строки B');
assert.match(cell('C7'), /ул. Ленина 1/, 'адрес у строки A');
const refs = [...out.matchAll(/<mergeCell ref="([^"]+)"/g)].map((m) => m[1]);
assert.deepEqual(refs, ['A3:A4', 'B3:B4', 'C3:C4', 'D3:D4', 'E5:F5'],
  'диапазона данных нет, шапка на месте, горизонтальный мёрдж уехал со строкой');
console.log('ok: вертикальный мёрдж данных не теряет адрес (№111)');
