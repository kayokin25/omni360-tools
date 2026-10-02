// node lib/test_ssk.mjs [АП.xlsx папка-с-jpeg выход-без-расширения]
// Без аргументов — синтетика: регионы, подбор фото по GID, плейсхолдеры,
// и что Word/PDF собираются и открываются как zip/PDF.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('./omnilib.js');
require('./city-regions.js');
const F = require('./ssk-fonts.js');
const S = require('./ssk-core.js');

/* Размер JPEG по маркеру SOF — в Node нет createImageBitmap. */
function jpegSize(b) {
  for (let i = 2; i < b.length;) {
    const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xc3) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
    i += 2 + len;
  }
  throw new Error('не JPEG');
}

// ── регионы ──
assert.equal(S.regionOf('Москва'), 'Москва');
assert.equal(S.regionOf('Ленинский городской округ'), 'Московская область');
assert.equal(S.regionOf('поселение Московский'), 'Москва');
assert.equal(S.regionOf('Химки'), 'Московская область');
assert.equal(S.regionOf('Неизвестноград'), 'Неизвестноград');
assert.equal(S.regionTitle('Москва'), 'г. Москва');
assert.equal(S.regionTitle('Московская область'), 'Московская область');
assert.equal(S.addressLine({ address: 'Варшавское шоссе  18к1 ', side: 'A' }), 'Варшавское шоссе 18к1, сторона A');
assert.equal(S.addressLine({ address: 'Москва, Ленинградское ш., 134', side: '' }), 'Москва, Ленинградское ш., 134');

// ── фото по GID: оба формата имён, самый длинный GID, самый ранний снимок ──
const screens = [
  { gid: '4792B', city: 'Москва', address: 'Садовая-Сухаревская', side: 'B' },
  { gid: '4792B1', city: 'Москва', address: 'Двойник', side: 'B' },
  { gid: '0102-DF01-1100003A', city: 'Москва', address: 'Ленинградское шоссе, 31 км', side: 'A' },
  { gid: 'MOBB16352A1', city: 'Ленинский городской округ', address: 'Каширское шоссе', side: 'A' },
  { gid: '105', city: 'Москва', address: 'Ленинградское ш., 134', side: '' }
];
const m = S.matchPhotos([
  'x/4792B_Moskva_Sadovaia_B_17082026_19_15_09_c.png',
  '4792B1 Двойник B 17.08.2026 19-15-09.jpeg',
  '0102_DF01_1100003A_Lieninghradskoie_A_17082026_19_16_20_c.png',
  'MOBB16352A1_Kashirskoie_A1_24082026_17_01_36_c.png',
  'MOBB16352A1_Kashirskoie_A1_21082026_21_15_00_c.png',
  'readme.txt'
], screens);
assert.deepEqual(m.get('4792B'), ['x/4792B_Moskva_Sadovaia_B_17082026_19_15_09_c.png']);
assert.deepEqual(m.get('4792B1'), ['4792B1 Двойник B 17.08.2026 19-15-09.jpeg']);
assert.ok(m.get('0102-DF01-1100003A'));
assert.equal(m.get('MOBB16352A1')[0], 'MOBB16352A1_Kashirskoie_A1_21082026_21_15_00_c.png');
assert.equal(m.get('105'), undefined);

// ── модель: группы, без фото, плейсхолдеры ──
const photo = { key: 'p1', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), w: 1600, h: 900 };
const has = new Set(['4792B', 'MOBB16352A1']);
const plain = S.buildModel(screens, g => (has.has(g) ? photo : null), {});
assert.deepEqual(plain.regions.map(r => r.title), ['г. Москва', 'Московская область']);
assert.equal(plain.missing.length, 3);
assert.equal(plain.placeholders, 0);
const ph = S.buildModel(screens, g => (has.has(g) ? photo : null), { placeholders: true, random: () => 0.3 });
assert.equal(ph.placeholders, 3);
assert.ok(ph.regions.every(r => r.items.every(it => it.photo)));
assert.equal(ph.regions[0].items.filter(it => it.placeholder).length, 3);

const blocks = S.documentBlocks(ph, { updNo: '204', updDate: '2026-08-31', customer: 'ООО «МЕДИАЛАЙФ-РЕГИОНЫ»',
  contractor: 'ООО «РТ-Сервис»', contractNo: 'РТС-113', contractDate: '2026-07-13', periodFrom: '2026-08-01',
  periodTo: '2026-08-31', objectName: 'Все сезоны' });
const text = blocks.filter(b => b.type === 'p').map(b => b.runs.map(r => r.t).join('')).join('\n');
assert.match(text, /к УПД № 204 от 31\.08\.2026 г\./);
assert.match(text, /Договор № РТС-113 от "13" июля 2026 г\./);
assert.match(text, /Период: с 01\.08\.2026 по 31\.08\.2026/);
assert.match(text, /рекламной кампании "Все сезоны"/);
assert.match(text, /^1\. г\. Москва$/m);
assert.match(text, /^2\. Московская область$/m);
assert.equal((text.match(/Иллюстративное фото/g) || []).length, 3);

const docx = new Uint8Array(await S.buildDocx(blocks).arrayBuffer());
const zip = await L.zipOpen(L.bytesSource(docx, 'r.docx'));
const names = zip.entries.map(e => e.name);
assert.ok(names.includes('word/document.xml') && names.includes('word/media/image1.jpeg'));
assert.equal(names.filter(n => n.startsWith('word/media/')).length, 1, 'одно фото — один файл, сколько бы раз ни стояло');
const pdf = await S.buildPdf(blocks, F);
const pb = new Uint8Array(await pdf.blob.arrayBuffer());
assert.equal(new TextDecoder().decode(pb.slice(0, 8)), '%PDF-1.7');
assert.ok(pdf.pages >= 1);
console.log('синтетика: ок, PDF страниц', pdf.pages);

// ── живой прогон: node lib/test_ssk.mjs АП.xlsx папка out ──
const [ap, dir, out] = process.argv.slice(2);
if (ap) {
  const buf = fs.readFileSync(ap);
  const apScreens = await S.readAp(L.bytesSource(new Uint8Array(buf), path.basename(ap)));
  const files = fs.readdirSync(dir);
  const idx = S.matchPhotos(files, apScreens);
  const cache = new Map();
  const photoOf = gid => {
    const list = idx.get(gid);
    if (!list) return null;
    if (!cache.has(list[0])) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(dir, list[0])));
      cache.set(list[0], Object.assign({ key: list[0], bytes }, jpegSize(bytes)));
    }
    return cache.get(list[0]);
  };
  const model = S.buildModel(apScreens, photoOf, { placeholders: process.env.PH === '1' });
  const bl = S.documentBlocks(model, { updNo: '204', updDate: '2026-08-31', customer: 'ООО «МЕДИАЛАЙФ-РЕГИОНЫ»',
    contractor: 'ООО «РТ-Сервис»', contractNo: 'РТС-113', contractDate: '2026-07-13',
    periodFrom: '2026-08-01', periodTo: '2026-08-31', objectName: 'Все сезоны' });
  fs.writeFileSync(out + '.docx', Buffer.from(await S.buildDocx(bl).arrayBuffer()));
  const p = await S.buildPdf(bl, F);
  fs.writeFileSync(out + '.pdf', Buffer.from(await p.blob.arrayBuffer()));
  console.log('экранов', apScreens.length, 'с фото', model.withPhoto, 'без фото', model.missing.length,
    'плейсхолдеров', model.placeholders, 'регионы', model.regions.map(r => r.title + ' ' + r.items.length).join(', '),
    'страниц PDF', p.pages);
}
