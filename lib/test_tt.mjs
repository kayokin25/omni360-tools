import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('./omnilib.js');
require('./tt-data.js');
const T = require('./tt-core.js');

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

console.log('=== lookupDuration (эталон из tt.py) ===');
eq("РИМ|BILLBOARD", T.lookupDuration('РИМ', 'BILLBOARD'), 5);
eq("Russ Outdoor|CITY_FORMAT", T.lookupDuration('Russ Outdoor', 'CITY_FORMAT'), 10);
eq("Russ Outdoor|BILLBOARD", T.lookupDuration('Russ Outdoor', 'BILLBOARD'), 5);
eq("MAER (Outdoor)|BILLBOARD", T.lookupDuration('MAER (Outdoor)', 'BILLBOARD'), 5);
eq("MAER (Outdoor)|MEDIAFACADE", T.lookupDuration('MAER (Outdoor)', 'MEDIAFACADE'), 10);
eq('РА "ЦВЕТ"|BILLBOARD', T.lookupDuration('РА "ЦВЕТ"', 'BILLBOARD'), 10);
eq("LBL|MEDIAFACADE", T.lookupDuration('LBL', 'MEDIAFACADE'), 15);
eq("LBL|BILLBOARD", T.lookupDuration('LBL', 'BILLBOARD'), 15);
eq("РА Прайм|BILLBOARD", T.lookupDuration('РА Прайм', 'BILLBOARD'), 15);
eq("Реклама центр OUTDOOR|BILLBOARD", T.lookupDuration('Реклама центр OUTDOOR', 'BILLBOARD'), 10);
eq("НетТакого|BILLBOARD", T.lookupDuration('НетТакого', 'BILLBOARD'), null);

console.log('=== parseFilename (эталон из tt.py) ===');
eq("Русс 1080х1920.pdf", T.parseFilename('Русс 1080х1920.pdf'), ['русс', '1080x1920', null, false]);
eq("Инсайт.jpg", T.parseFilename('Инсайт.jpg'), ['инсайт', null, null, true]);
eq("Мособл 960х480 2:1.jpg", T.parseFilename('Мособл 960х480 2:1.jpg'), ['мособл', '960x480', '2:1', false]);
eq("РА Цвет 720х360.png", T.parseFilename('РА Цвет 720х360.png'), ['ра цвет', '720x360', null, false]);
eq("Аффикс Групп 2:1.jpg", T.parseFilename('Аффикс Групп 2:1.jpg'), ['аффикс групп', null, '2:1', false]);
eq("Хэт-Трик общее.jpg", T.parseFilename('Хэт-Трик общее.jpg'), ['хэт трик', null, null, true]);
eq("2 Этаж 3к1.png", T.parseFilename('2 Этаж 3к1.png'), ['2 этаж 3к1', null, null, true]);
eq("РЦ 1440х720 2:1.pdf", T.parseFilename('РЦ 1440х720 2:1.pdf'), ['рц', '1440x720', '2:1', false]);

console.log('=== operatorToken (эталон из tt.py) ===');
eq("Russ Outdoor", T.operatorToken('Russ Outdoor'), 'русс');
eq("MAER (Outdoor)", T.operatorToken('MAER (Outdoor)'), 'маер');
eq('РА "ЦВЕТ"', T.operatorToken('РА "ЦВЕТ"'), 'ра цвет');
eq("Мособлреклама", T.operatorToken('Мособлреклама'), 'мособл');
eq("РИМ", T.operatorToken('РИМ'), 'рим');
eq("Реклама Центр Outdoor", T.operatorToken('Реклама Центр Outdoor'), 'рц');
eq("test@maergroup.ru", T.operatorToken('test@maergroup.ru'), 'маер');
eq("Инсайт Медиа", T.operatorToken('Инсайт Медиа'), 'инсайт');

console.log('\n=== END-TO-END: AP_tiest + живой Яндекс.Диск ===');
const src = await fileSource('C:/Users/tuefr/OneDrive/Desktop/работа/скрипты/тт/новое/AP_tiest_868095279752977635.xlsx');
const wb = await L.readXlsx(src);
const table = T.findApTable(wb);
console.log(`  таблица: лист "${table.sheetName}", строка шапки ${table.headerRow}, строк данных ${table.rows.length}`);

const linker = new T.YandexDiskLinker(T.DATA.YADISK_PUBLIC_KEY);
await linker.fetchAll();
console.log(`  Диск: файлов ${linker.files.length}, без публикации ${linker.unpublished.length}, ключей в индексе ${linker.index.size}, запросов ${linker.apiCalls}`);

const { results, durationMisses } = T.processAp(table, linker);
const dedup = T.deduplicate(results);
console.log(`  строк: ${results.length} -> после дедупа ${dedup.length}`);
console.log(`  без длительности: ${durationMisses.size ? [...durationMisses].join('; ') : 'нет'}`);
const withLink = dedup.filter(r => r['Ссылка на ТТ']).length;
console.log(`  со ссылкой: ${withLink} из ${dedup.length}`);
console.log('  результат:');
for (const r of dedup) {
  console.log(`    ${r['Оператор']} | ${r['Формат экрана']} | ${r['Разрешение']} | ${r['Соотношение сторон']} | ${r['Длительность (сек)']}с | ${r['Ссылка на ТТ'] || '— нет ссылки —'}`);
}

const blob = L.writeXlsx(T.buildReport(dedup));
await fs.writeFile('./out_tt.xlsx', Buffer.from(await blob.arrayBuffer()));
console.log('  записан out_tt.xlsx');
await src.close();

console.log(fails ? `\n!!! ПРОВАЛЕНО ПРОВЕРОК: ${fails}` : '\nвсе проверки пройдены');
