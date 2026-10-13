import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('./omnilib.js');
const M = require('./masterad-core.js');

/* ── Самодостаточная проверка: «% выполнения» (E3/F3 свода) — проценты 0.0% ── */
{
  const assert = (await import('node:assert/strict')).default;
  const day = new Date(2026, 6, 15);
  const facts = [{ city: 'Москва', type: 'CITYBOARD', gid: 'g1', address: 'a', day, contacts: 100, spent: 50 }];
  const plan = { days: 1, cityOrder: ['Москва'], byCity: new Map([['Москва', { budget: 200, ots: 400 }]]) };
  const withPlan = M.buildReport(facts, plan, { campaignName: 'T' }).sheets[0].rows[2];
  assert.equal(withPlan[3], '% выполнения');
  for (const i of [4, 5]) {
    assert.equal(withPlan[i].s, L.S.PCT, 'стиль процента на ячейке ' + i);
    assert.ok(withPlan[i].v > 0 && withPlan[i].v < 1, 'значение — доля, не процент');
  }
  assert.equal(L.S.PCT, 12, 'новый стиль строго в конце cellXfs');
  assert.equal(L.S.INT, 11, 'старые номера стилей не сдвинуты');
  const noPlan = M.buildReport(facts, null, { campaignName: 'T' }).sheets[0].rows;
  assert.ok(noPlan.every(r => r.length <= 4), 'без плана колонок плана нет');
  console.log('[0] % выполнения: ок');
}

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

const ZIP = 'C:/Users/tuefr/Downloads/Statistika_pokazov_Go_Vmiestie_update_872089725890443243.zip';
const PLAN = 'C:/Users/tuefr/OneDrive/Desktop/работа/МП_MasterAd_Яндекс_Go_вар3_15.07-31.08_2026.xlsx';

console.log('[1/4] Читаю план (МП)...');
const planSrc = await fileSource(PLAN);
const planFile = { name: 'plan.xlsx' };
const origBlobSource = L.blobSource;
L.blobSource = function (f) { return f === planFile ? planSrc : origBlobSource(f); };
const plan = await M.loadPlan(planFile);
console.log('      дней:', plan.days, 'города:', plan.cityOrder, [...plan.byCity.entries()]);
await planSrc.close();

console.log('\n[2/4] Читаю статистику из zip (45 МБ, 7 частей)...');
const t0 = Date.now();
const zipSrc = await fileSource(ZIP);
let lastTick = 0;
const { rawRows, skipped } = await M.collectStatRows({ kind: 'zip', source: zipSrc }, (done, total, name) => {
  const now = Date.now();
  if (now - lastTick > 500) { lastTick = now; process.stdout.write(`      ...${done}/${total} ${name}\r\n`); }
});
console.log(`      строк прочитано: ${rawRows.length} за ${((Date.now() - t0) / 1000).toFixed(1)}с`);
if (skipped.length) console.log('      пропущено:', skipped);
await zipSrc.close();

console.log('\n[3/4] Собираю факты...');
const t1 = Date.now();
// таблица замены нулей OTS — из переписки с клиентом
const zeroMap = new Map([
  ['казань CITYFORMAT', 16], ['казань BILLBOARD', 50],
  ['нижний новгород CITYFORMAT', 25], ['нижний новгород BILLBOARD', 33],
  ['санкт-петербург BILLBOARD', 34],
  ['химки CITYBOARD', 73]
]);
const { facts, stats } = M.buildFacts(rawRows, { zeroMap, dateFrom: null, dateTo: null });
console.log(`      факты: ${JSON.stringify(stats)} за ${((Date.now() - t1) / 1000).toFixed(1)}с`);

console.log('\n[4/4] Строю отчёт...');
const t2 = Date.now();
const rep = M.buildReport(facts, plan, { campaignName: 'Яндекс GO Тариф Вместе' });
console.log(`      статистика: ${JSON.stringify(rep.stats)} за ${((Date.now() - t2) / 1000).toFixed(1)}с`);

console.log('\n--- свод (первые 25 строк) ---');
for (const r of rep.sheets[0].rows.slice(0, 25)) {
  console.log('   ' + r.map(c => (c && typeof c === 'object' ? c.v : c)).join(' | '));
}

console.log('\n--- Отчет (первые 5 строк) ---');
for (const r of rep.sheets[1].rows.slice(0, 5)) {
  console.log('   ' + r.map(c => (c && typeof c === 'object' ? c.v : c)).join(' | '));
}

console.log('\n--- Отчет по минутам (первые 5 строк) ---');
for (const r of rep.sheets[2].rows.slice(0, 5)) {
  console.log('   ' + r.map(c => (c && typeof c === 'object' ? c.v : c)).join(' | '));
}

console.log('\n--- свод по минутам: заголовок (первые 10 и последние 5 колонок) ---');
const head4 = rep.sheets[3].rows[0];
console.log('   первые:', head4.slice(0, 10));
console.log('   последние:', head4.slice(-5));
console.log('--- свод по минутам: первая city-группа + первый день ---');
console.log('   ', rep.sheets[3].rows[1].slice(0, 5).map(c => c && c.v));
console.log('   ', rep.sheets[3].rows[2].slice(0, 5).map(c => c && (c.v instanceof Date ? c.v.toISOString() : c.v)));

console.log('\n--- Лист2 (первые 10 строк) ---');
for (const r of rep.sheets[4].rows.slice(0, 10)) {
  console.log('   ' + r.map(c => (c && typeof c === 'object' ? (c.v instanceof Date ? c.v.toISOString().slice(0,10) : c.v) : c)).join(' | '));
}

console.log('\nЗаписываю out_masterad.xlsx (со сжатием)...');
const t3 = Date.now();
let lastPct = -1;
const blob = await L.writeXlsxDeflate(rep.sheets, (i, n, name) => {
  const pct = Math.floor((i / n) * 100);
  if (pct !== lastPct) { lastPct = pct; process.stdout.write(`      ...${i}/${n} ${name}\r\n`); }
});
await fs.writeFile('./out_masterad.xlsx', Buffer.from(await blob.arrayBuffer()));
console.log(`записано за ${((Date.now() - t3) / 1000).toFixed(1)}с, размер ${(await fs.stat('./out_masterad.xlsx')).size} байт`);
