/* №111: вертикальный мёрдж данных (адрес на стороны A/B) не теряет адрес после перестановки по GID,
   не лезет в чужие строки, не копирует примечания и числа, прямоугольник сохраняет ширину. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('./omnilib.js');
const I = require('./inventory-core.js');

const t = (ref, v) => '<c r="' + ref + '" t="inlineStr"><is><t>' + v + '</t></is></c>';
const n = (ref, v) => '<c r="' + ref + '"><v>' + v + '</v></c>';
const empty = (...refs) => refs.map(r => '<c r="' + r + '"/>').join('');
const HEAD = (...names) => '<row r="3">' + names.map((h, i) => t('ABCDE'[i] + 3, h)).join('') + '</row>'
  + '<row r="4">' + empty(...names.map((_, i) => 'ABCDE'[i] + 4)) + '</row>';
const sheetOf = (rows, merges) => '<worksheet><sheetData>' + rows + '</sheetData><mergeCells count="' + merges.length + '">'
  + merges.map(r => '<mergeCell ref="' + r + '"/>').join('') + '</mergeCells></worksheet>';
const refsOf = xml => [...xml.matchAll(/<mergeCell ref="([^"]+)"/g)].map(m => m[1]).sort();

// A/B: одна конструкция на две стороны, адрес только в верхней ячейке (B5:B6)
const SIDES = sheetOf(HEAD('GID', 'Адрес', 'Кол-во показов', 'Прим')
  + '<row r="5">' + t('A5', 'BDB_RC_239A') + t('B5', 'ул. Ленина 1') + n('C5', 0) + '</row>'
  + '<row r="6">' + t('A6', 'BDB_RC_239B') + '<c r="B6" s="3"/>' + n('C6', 10) + '</row>'
  + '<row r="7">' + t('A7', 'AAA_1') + t('B7', 'ул. Мира 2') + n('C7', 5) + t('D7', 'прим') + '<c r="E7"/></row>',
['A3:A4', 'B3:B4', 'C3:C4', 'B5:B6', 'D7:E7']);
// обе стороны показаны, а между ними встаёт чужая строка: BDB_RC_239A < BDB_RC_239A1 < BDB_RC_239B
const BETWEEN = sheetOf(HEAD('GID', 'Адрес', 'Кол-во показов')
  + '<row r="5">' + t('A5', 'BDB_RC_239A') + t('B5', 'ул. Ленина 1') + n('C5', 10) + '</row>'
  + '<row r="6">' + t('A6', 'BDB_RC_239B') + '<c r="B6"/>' + n('C6', 10) + '</row>'
  + '<row r="7">' + t('A7', 'BDB_RC_239A1') + t('B7', 'ул. Мира 2') + n('C7', 5) + '</row>',
['A3:A4', 'B3:B4', 'C3:C4', 'B5:B6']);
// примечание под таблицей (A7:C8) и числовой столбец «Сумма» (D5:D6): копировать нельзя
const NOTE = sheetOf(HEAD('GID', 'Адрес', 'Кол-во показов', 'Сумма')
  + '<row r="5">' + t('A5', 'G2') + t('B5', 'ул. 2') + n('C5', 5) + n('D5', 10) + '</row>'
  + '<row r="6">' + t('A6', 'G1') + t('B6', 'ул. 1') + n('C6', 7) + '<c r="D6"/></row>'
  + '<row r="7">' + t('A7', 'Примечание') + '<c r="B7"/><c r="C7"/></row>'
  + '<row r="8"><c r="A8"/><c r="B8"/><c r="C8"/></row>',
['A3:A4', 'B3:B4', 'C3:C4', 'D3:D4', 'D5:D6', 'A7:C8']);
// прямоугольник B5:C6: «Адрес» и «Район» объединены на обе стороны
const RECT = sheetOf(HEAD('GID', 'Адрес', 'Район', 'Кол-во показов')
  + '<row r="5">' + t('A5', 'Z_A') + t('B5', 'ул. Ленина 1') + '<c r="C5"/>' + n('D5', 0) + '</row>'
  + '<row r="6">' + t('A6', 'Z_B') + '<c r="B6"/><c r="C6"/>' + n('D6', 10) + '</row>'
  + '<row r="7">' + t('A7', 'A_1') + t('B7', 'ул. Мира 2') + t('C7', 'центр') + n('D7', 5) + '</row>',
['A3:A4', 'B3:B4', 'C3:C4', 'D3:D4', 'B5:C6']);
const patch = async sheet => {
  const blob = L.zipWrite([
    { name: 'xl/workbook.xml', bytes: L.encodeUtf8('<workbook><sheets><sheet name="Лист1" sheetId="1" r:id="rId1"/></sheets></workbook>') },
    { name: 'xl/_rels/workbook.xml.rels', bytes: L.encodeUtf8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
    { name: 'xl/worksheets/sheet1.xml', bytes: L.encodeUtf8(sheet) },
  ]);
  const res = await I.patchFile(blob);
  assert.equal(res.action, 'ok', res.reason);
  const zip = await L.zipOpen(L.blobSource(res.blob));
  const e = zip.entries.find(x => x.name.replace(/^\/+/, '') === 'xl/worksheets/sheet1.xml');
  return { xml: new TextDecoder('utf-8').decode(await L.zipRead(zip, e)) };
};

await (async () => {
  const text = (xml, ref) => (new RegExp('<c r="' + ref + '"[^>]*?(?:/>|>(.*?)</c>)').exec(xml)?.[1] ?? '').replace(/<[^>]+>/g, '');

  // стороны A/B: адрес у каждой, диапазона данных нет, горизонтальный мёрдж уехал со строкой AAA_1
  const a = (await patch(SIDES)).xml;
  assert.deepEqual([5, 6, 7].map(r => text(a, 'B' + r)), ['AAA_1', 'BDB_RC_239B', 'BDB_RC_239A']);
  assert.deepEqual([5, 6, 7].map(r => text(a, 'C' + r)), ['ул. Мира 2', 'ул. Ленина 1', 'ул. Ленина 1']);
  assert.deepEqual(refsOf(a), ['A3:A4', 'B3:B4', 'C3:C4', 'D3:D4', 'E5:F5']);

  // между сторонами встала чужая строка: у неё свой адрес, диапазона на три строки нет
  const b = (await patch(BETWEEN)).xml;
  assert.deepEqual([5, 6, 7].map(r => text(b, 'B' + r)), ['BDB_RC_239A', 'BDB_RC_239A1', 'BDB_RC_239B']);
  assert.deepEqual([5, 6, 7].map(r => text(b, 'C' + r)), ['ул. Ленина 1', 'ул. Мира 2', 'ул. Ленина 1']);
  assert.deepEqual(refsOf(b), ['A3:A4', 'B3:B4', 'C3:C4', 'D3:D4']);

  // примечание не размножается, число из мёрджа не копируется (показы и сумма не задваиваются)
  const c = (await patch(NOTE)).xml;
  assert.deepEqual([5, 6].map(r => text(c, 'B' + r)), ['G1', 'G2']);
  assert.equal(c.split('Примечание').length - 1, 1);
  assert.equal(c.split('<v>10</v>').length - 1, 1);

  // прямоугольник: ширина мёрджа остаётся на каждой стороне, строки уехали вместе с ним
  const d = (await patch(RECT)).xml;
  assert.deepEqual([5, 6, 7].map(r => text(d, 'B' + r)), ['A_1', 'Z_B', 'Z_A']);
  assert.deepEqual([5, 6, 7].map(r => text(d, 'C' + r)), ['ул. Мира 2', 'ул. Ленина 1', 'ул. Ленина 1']);
  assert.deepEqual(refsOf(d), ['A3:A4', 'B3:B4', 'C3:C4', 'C6:D6', 'C7:D7', 'D3:D4', 'E3:E4']);
})();
console.log("ok: вертикальный мёрдж данных (№111): стороны, чужая строка, примечание и число, прямоугольник");
