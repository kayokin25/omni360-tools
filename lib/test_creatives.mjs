import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('./omnilib.js');
const C = require('./creatives-core.js');

async function fileSource(p) {
  const fh = await fs.open(p, 'r');
  const st = await fh.stat();
  return {
    size: st.size, name: path.basename(p),
    async slice(start, end) {
      const s = Math.max(0, start), e = Math.min(st.size, end);
      if (e <= s) return new Uint8Array(0);
      const buf = Buffer.allocUnsafe(e - s);
      const { bytesRead } = await fh.read(buf, 0, e - s, s);
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    },
    close: () => fh.close()
  };
}

const AP = 'C:/Users/tuefr/OneDrive/Desktop/работа/скрипты/подбор крео/AP_Go_866940235059044833.xlsx';
const ZIP = 'C:/Users/tuefr/OneDrive/Desktop/работа/скрипты/подбор крео/new 13.07.zip';

console.log('[1/4] Читаю АП...');
const apSrc = await fileSource(AP);
const wb = await L.readXlsx(apSrc);
const ap = C.loadAp(wb);
console.log(`      лист "${ap.sheetName}", шапка в строке ${ap.headerRow}, поверхностей: ${ap.surfaces.length}`);
console.log(`      длительностей в словаре: ${ap.durMap.size}`);
await apSrc.close();

console.log('[2/4] Читаю креативы из архива (1.3 ГБ)...');
const t0 = Date.now();
const zipSrc = await fileSource(ZIP);
let last = 0;
const { creatives, skippedArchives } = await C.collectCreatives(
  { kind: 'zip', source: zipSrc },
  (done) => { if (done - last >= 25) { last = done; process.stdout.write(`      ...${done}\r`); } }
);
const known = creatives.filter(c => c.dims).length;
console.log(`      видеофайлов: ${creatives.length} (размер прочитан у ${known}) за ${((Date.now()-t0)/1000).toFixed(1)}с`);
if (skippedArchives.length) console.log('      пропущено архивов:', skippedArchives);

// какие уникальные имена/размеры
const uniqNames = new Set(creatives.map(c => c.name));
console.log(`      уникальных базовых имён: ${uniqNames.size}`);
const dimCount = new Map();
for (const c of creatives) {
  const k = c.dims ? c.dims.join('x') : 'null';
  dimCount.set(k, (dimCount.get(k) || 0) + 1);
}
console.log('      размеры:', [...dimCount.entries()].map(([k, v]) => `${k}×${v}`).join(', '));

console.log('[3/4] Подбираю...');
const { targets } = C.buildTargets(ap.surfaces);
const unknown = C.match(targets, creatives);

console.log('[4/4] Отчёт...');
const rep = C.buildReport(targets, unknown, creatives, skippedArchives);
console.log('      статистика:', JSON.stringify(rep.stats));

console.log('\n--- Отправка ---');
for (const r of rep.sheets[0].rows) {
  console.log('   ' + r.map(c => (c && typeof c === 'object' ? c.v : c)).join(' | '));
}
console.log('\n--- Не хватает ---');
for (const r of rep.sheets[1].rows) {
  console.log('   ' + r.map(c => (c && typeof c === 'object' ? c.v : c)).join(' | '));
}
console.log(`\n--- Лишние видео: ${rep.sheets[2].rows.length - 1} строк ---`);
for (const r of rep.sheets[2].rows.slice(0, 6)) {
  console.log('   ' + r.map(c => (c && typeof c === 'object' ? c.v : c)).join(' | '));
}

const blob = L.writeXlsx(rep.sheets);
await fs.writeFile('./out_creatives.xlsx', Buffer.from(await blob.arrayBuffer()));
console.log('\nзаписан out_creatives.xlsx');

console.log('собираю архив с нужными крео...');
const z = await C.buildZip(targets, (i, n, nm) => console.log(`   ${i}/${n} ${nm}`));
await fs.writeFile('./out_creatives.zip', Buffer.from(await z.blob.arrayBuffer()));
console.log(`записан out_creatives.zip (${z.count} файлов, ${(await fs.stat('./out_creatives.zip')).size} байт)`);

await zipSrc.close();

// ── сверка с эталоном python ──
console.log('\n=== СВЕРКА С ЭТАЛОНОМ (Отчет_подбор_крео.xlsx) ===');
const want = { targets: 12, used: 8, missing: 4, keep: 5, creatives: 108, unknown: 0 };
let ok = true;
for (const k of Object.keys(want)) {
  const good = rep.stats[k] === want[k];
  if (!good) ok = false;
  console.log(`  ${good ? 'ok  ' : 'FAIL'} ${k}: ${rep.stats[k]} (эталон ${want[k]})`);
}
console.log(ok ? '\nСТАТИСТИКА СОВПАДАЕТ С PYTHON' : '\n!!! РАСХОЖДЕНИЕ');
