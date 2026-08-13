/* Проверка сборки ТТ по реестру. Эталоны взяты из самого реестра
   (data/tt_registry.xlsx) и из карточек ТТ_карточки_операторов.md, собранных
   тем же проходом: если разбор поедет, значения разойдутся.

   node lib/test_ttreg.mjs                       — на встроенном реестре
   node lib/test_ttreg.mjs <адресная-программа>  — плюс прогон настоящей АП */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('./omnilib.js');
require('./tt-data.js');
require('./tt-core.js');
const R = require('./ttreg-core.js');

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const REGISTRY = path.join(HERE, '..', 'data', 'tt_registry.xlsx');

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

let fails = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: ${g}${ok ? '' : '  != эталон ' + w}`);
}
function ok(label, cond, detail) {
  if (!cond) fails++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ': ' + detail : ''}`);
}

/* ── разбор значений из ТТ ────────────────────────────────────────────────── */

console.log('=== вес файла: из перечисления берём минимум ===');
eq('«не более 10 МБ»', R.parseMb('не более 10 МБ'), 10);
eq('Хэт-Трик, по формату', R.parseMb(
  'по формату: 1 МБ (ситиформат), 2 МБ (ситиборд и билборд), 3 МБ (суперсайты); ' +
  'для DSS 12х5 — не более 100 МБ'), 1);
eq('«не более 150 МБ»', R.parseMb('не более 150 МБ'), 150);
/* Главная ловушка: «Мб» — начало слова «Мбит», и без отрицательного просмотра
   битрейт 3 Мбит/с читался как 3 мегабайта. */
eq('битрейт не путается с весом', R.parseMb('3 Мбит/с'), null);
eq('нет числа — null', R.parseMb('по согласованию'), null);

console.log('=== битрейт: всё в Мбит/с, из диапазона — нижняя граница ===');
eq('РИМ, kbps', R.parseMbps('6800 kbps; не более 6800 kbps'), 6.8);
eq('Трансмедиа', R.parseMbps('3 Мбит/с'), 3);
eq('РАСВЭРО, Mb/s', R.parseMbps('10 Mb/s'), 10);
eq('Неон, кбит', R.parseMbps('50000 кбит; не более 50000 кбит'), 50);
eq('Реклама центр, диапазон', R.parseMbps('10-20 Мбит'), 10);
eq('Sunlight, диапазон с тире', R.parseMbps('не более 10–40 Мбит/с в зависимости от формата'), 10);

console.log('=== форматы и кодеки: делим по запятой, не по «/» ===');
eq('H.264 / AVC — один кодек', R.tokens('H.264 / AVC').list, ['H.264/AVC']);
eq('Мособлреклама, три кодека', R.tokens('H.264 / AVC, Apple ProRes, Uncompressed / без сжатия').list,
  ['H.264/AVC', 'Apple ProRes', 'Uncompressed']);
eq('MPEG-4 — синоним MP4', R.tokens('MP4, MPEG-4, MOV').list, ['MP4', 'MOV']);
eq('«75–92 dpi» — не формат', R.tokens('JPEG (jpg), 75–92 dpi').list, ['JPEG']);
eq('оговорка в скобках замечена', R.tokens('MP4 (для DSS 12х5 — также MKV)').caveat, true);
eq('второе имя формата — не оговорка', R.tokens('MP4 (MPEG-4)').caveat, false);

console.log('=== разрешения из ТТ: физические размеры не путаем с пикселями ===');
eq('РИМ: «6х3 → 1440x720»', [...R.ttResolutions('6х3 → 1440x720; 10,56x5,76 → 1320x720')].sort(),
  ['1320x720', '1440x720']);
eq('РА ЦВЕТ', [...R.ttResolutions('2048x1024')], ['2048x1024']);
eq('проза без разрешений', [...R.ttResolutions('разрешение макета = физическому разрешению')], []);

/* ── реестр ───────────────────────────────────────────────────────────────── */

console.log('=== реестр ===');
const regSrc = await fileSource(REGISTRY);
const reg = R.readRegistry(await L.readXlsx(regSrc));
await regSrc.close();

eq('операторов', reg.operators.length, 148);
eq('дата сборки', reg.about.builtAt, '12.08.2026');
eq('блоки A–G', reg.blocks.map(b => b.title.slice(0, 1)), ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
/* Служебный хвост листа стоит после подписи блока G, и без явного списка
   исключений блок G забирал бы «Источник ТТ» и «Примечание» себе. */
eq('в блоке G только процесс и ссылки',
  reg.blocks[reg.blocks.length - 1].params, ['Процесс сдачи', 'Ссылки из ТТ']);
ok('предупреждений при чтении нет', reg.warnings.length === 0, reg.warnings.join('; '));
ok('отраслевой дефолт прочитан', Object.keys(reg.defaultsByParam).length >= 15,
  Object.keys(reg.defaultsByParam).length + ' параметров');
ok('оговорка про дефолт на месте', /допущение/.test(reg.defaultsCaveat));

const rim = reg.byNorm.get(L.normName('РИМ'));
ok('РИМ найден', !!rim);
eq('РИМ: статус', rim.status, 'полные');
eq('РИМ: кодек', rim.params['Кодек'], 'H.264 / AVC');
eq('РИМ: ничего не потеряно', rim.missing, []);

const hat = reg.byNorm.get(L.normName('Хэт-Трик'));
eq('Хэт-Трик: не указан только битрейт', hat.missing, ['Битрейт']);
eq('Хэт-Трик: листов по конструкциям', reg.constructions.get(hat.norm).length, 6);

const magnit = reg.byNorm.get(L.normName('МАГНИТ'));
eq('МАГНИТ: техпараметров нет вообще', magnit.missing.length, R.CRITICAL_PARAMS.length);

/* ── сведение по макету ───────────────────────────────────────────────────── */

console.log('=== задание на макеты ===');

/* АП собрана из настоящих операторов: РИМ, Хэт-Трик и Перспектива реально
   стоят на 720x360 со слотом 5 сек, поэтому и сведение получается настоящее. */
const AP = [
  ['GID', 'Оператор', 'Формат экрана', 'Длительность, сек', 'Вид. разрешение', 'Соотношение сторон'],
  ['T-1', 'РИМ', 'BILLBOARD', 5, '720×360', '2:1'],
  ['T-2', 'Хэт-Трик', 'BILLBOARD', 5, '720×360', '2:1'],
  ['T-3', 'Перспектива', 'BILLBOARD', 5, '720×360', '2:1'],
  ['T-4', 'Sunlight Indoor', 'INDOOR_SCREEN', 10, '1920×1080', '16:9'],
  ['T-5', 'Трансмедиа', 'INDOOR_SCREEN', 10, '1920×1080', '16:9'],
  ['T-6', 'Russ Outdoor', 'CITY_FORMAT', 5, '1080×1920', '9:16'],
  ['T-7', 'РА Ромашка', 'BILLBOARD', 5, '640×480', '4:3']
];
const apBlob = L.writeXlsx([{ name: 'АП', cols: [10, 26, 18, 16, 16, 16], rows: AP }]);
const apBytes = new Uint8Array(await apBlob.arrayBuffer());
const apWb = await L.readXlsx(L.bytesSource(apBytes, 'ap.xlsx'));
const table = globalThis.TTCore.findApTable(apWb);
ok('таблица АП найдена', !!table, table ? 'лист «' + table.sheetName + '»' : '');

const res = R.analyze(reg, table, { useDefaults: true });
eq('поверхностей', res.stats.apRows, AP.length - 1);
eq('уникальных макетов', res.stats.tasks, 4);
eq('оператор не из реестра', res.unknownOperators, ['РА Ромашка']);

const big = res.tasks.find(t => t.res === '720x360' && t.dur === '5');
eq('720x360: операторов', big.opCount, 3);
eq('720x360: формат файла', big.cells['Формат видео'].split(' ·')[0], 'MP4');
eq('720x360: кодек', big.cells['Кодек'], 'H.264/AVC');
eq('720x360: fps', big.cells['FPS'], '25');
/* У РИМ 6800 kbps, у Перспективы битрейта нет (подставляется дефолт 8–10),
   у Хэт-Трика нет — значит строже всех РИМ. */
ok('720x360: битрейт строже всех у РИМ', /≤ 6,8 Мбит\/с/.test(big.cells['Битрейт, Мбит/с ≤']),
  big.cells['Битрейт, Мбит/с ≤']);
/* Хэт-Трик задаёт вес по форматам от 1 МБ, РИМ и Перспектива — 10 МБ. */
ok('720x360: вес строже всех у Хэт-Трика', /≤ 1 МБ.*Хэт-Трик/.test(big.cells['Вес, МБ ≤']),
  big.cells['Вес, МБ ≤']);
ok('720x360: конфликтов нет', !big.conflicts, big.conflicts);
ok('720x360: замечание про непокрытое разрешение', /не заявлено в ТТ/.test(big.notes), big.notes);

/* 25 fps у Трансмедиа против «не ниже 30» у Sunlight — одним файлом не закрыть. */
const fhd = res.tasks.find(t => t.res === '1920x1080' && t.dur === '10');
ok('1920x1080: конфликт частоты кадров', /частота кадров не совпадает/.test(fhd.conflicts),
  fhd.conflicts);

const russ = res.tasks.find(t => t.res === '1080x1920');
ok('Russ Outdoor: помечен как допущение', /отраслевой дефолт/.test(russ.assumed), russ.assumed);
ok('Russ Outdoor: статус в замечаниях', /не заполнять/.test(russ.notes), russ.notes);

console.log('=== карточки ===');
eq('карточек', res.cards.length, 7);
const hatCard = res.cards.find(c => c.name === 'Хэт-Трик');
ok('в карточке есть блок «Справка»',
  hatCard.blocks.some(b => b.title === 'Справка'));
ok('служебные поля не попали в блок G',
  !hatCard.blocks.some(b => /^G\./.test(b.title) && b.items.some(i => i.param === 'Источник ТТ')));
ok('дефолт вынесен отдельным блоком',
  hatCard.blocks.some(b => b.assumed && b.items.every(i => i.assumed)));

console.log('=== выгрузка ===');
const built = R.buildWorkbook(res);
eq('листов', built.map(s => s.name), ['Задание на макеты', 'Карточки операторов']);
eq('ширин колонок столько же, сколько заголовков',
  built[0].cols.length, R.TASK_COLUMNS.length);
eq('строк в задании', built[0].rows.length, res.stats.tasks + 1);
ok('карточки свёрнуты в группы',
  built[1].rows.some(r => r && r.outlineLevel === 1) && built[1].outlineSummaryAbove === true);

/* Свой же файл читаем назад: так проверяется, что xlsx валиден. */
const outBlob = L.writeXlsx(built);
const outBytes = new Uint8Array(await outBlob.arrayBuffer());
const back = await L.readXlsx(L.bytesSource(outBytes, 'out.xlsx'));
eq('после чтения назад — те же листы', back.sheets.map(s => s.name),
  ['Задание на макеты', 'Карточки операторов']);
eq('шапка задания', back.sheets[0].rows[0], R.TASK_COLUMNS);
await fs.writeFile(path.join(HERE, '..', 'out_ttreg.xlsx'), Buffer.from(outBytes));
console.log(`  записан out_ttreg.xlsx (${Math.round(outBytes.length / 1024)} КБ)`);

/* ── настоящая АП, если её передали аргументом ────────────────────────────── */

if (process.argv[2]) {
  console.log(`=== настоящая АП: ${path.basename(process.argv[2])} ===`);
  const src = await fileSource(process.argv[2]);
  const wb = await L.readXlsx(src);
  const t = globalThis.TTCore.findApTable(wb);
  if (!t) {
    fails++;
    console.log('  FAIL таблица АП не найдена');
  } else {
    const r = R.analyze(reg, t, { useDefaults: true });
    console.log(`  лист «${t.sheetName}», строк ${r.stats.apRows} → макетов ${r.stats.tasks}`);
    console.log(`  операторов ${r.stats.operators}, без пригодных ТТ ${r.stats.noTt}` +
      ` (${r.stats.noTtScreens} поверхностей), конфликтов ${r.stats.conflicts}`);
    if (r.unknownOperators.length) console.log(`  нет в реестре: ${r.unknownOperators.join(', ')}`);
    ok('все строки попали в макеты',
      r.tasks.reduce((s, x) => s + x.screens, 0) === r.stats.apRows);
    ok('длительность известна для всех макетов',
      r.tasks.every(x => x.durNum !== null),
      r.tasks.filter(x => x.durNum === null).map(x => x.res).join(', '));
  }
  await src.close();
}

console.log(fails ? `\n!!! ПРОВАЛЕНО ПРОВЕРОК: ${fails}` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
