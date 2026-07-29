import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('./omnilib.js');

// источник поверх файла на диске (аналог blobSource в браузере)
async function fileSource(p) {
  const fh = await fs.open(p, 'r');
  const st = await fh.stat();
  return {
    size: st.size,
    name: path.basename(p),
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

const AP_TT = 'C:/Users/tuefr/OneDrive/Desktop/работа/скрипты/тт/новое/AP_tiest_868095279752977635.xlsx';
const AP_GO = 'C:/Users/tuefr/OneDrive/Desktop/работа/скрипты/подбор крео/AP_Go_866940235059044833.xlsx';

console.log('=== 1. XLSX READ: AP_tiest ===');
{
  const src = await fileSource(AP_TT);
  const wb = await L.readXlsx(src);
  console.log('sheets:', wb.sheets.map(s => `${s.name}(${s.rows.length})`).join(', '));
  const vse = wb.sheets.find(s => s.name === 'Все');
  console.log('Все r10 (header):', JSON.stringify(vse.rows[9].slice(0, 9)));
  console.log('Все r11:', JSON.stringify(vse.rows[10].slice(0, 9)));
  console.log('Все r1:', JSON.stringify(vse.rows[0].slice(0, 3)));
  await src.close();
}

console.log('\n=== 2. XLSX READ: AP_Go ===');
{
  const src = await fileSource(AP_GO);
  const wb = await L.readXlsx(src);
  console.log('sheets:', wb.sheets.map(s => `${s.name}(${s.rows.length})`).join(', '));
  const vse = wb.sheets.find(s => s.name === 'Все');
  console.log('Все r10:', JSON.stringify(vse.rows[9].slice(0, 9)));
  console.log('Все r11:', JSON.stringify(vse.rows[10].slice(0, 9)));
  console.log('rows with data after header:', vse.rows.slice(10).filter(r => r.some(c => c !== null && c !== '')).length);
  await src.close();
}

console.log('\n=== 3. MP4 DIMS from loose files ===');
{
  const dir = 'C:/Users/tuefr/OneDrive/Desktop/работа/скрипты/подбор крео';
  const files = (await fs.readdir(dir)).filter(f => f.toLowerCase().endsWith('.mp4'));
  for (const f of files) {
    const bytes = new Uint8Array(await fs.readFile(path.join(dir, f)));
    const d = L.findStsdDims(bytes, 0, bytes.length);
    const scan = L.scanStsdDims(bytes);
    console.log(`  ${f}\n     structural=${d ? d.join('x') : 'null'}  scan=${scan ? scan.join('x') : 'null'}`);
  }
}

console.log('\n=== 4. XLSX WRITE round-trip ===');
{
  const sheets = [
    {
      name: 'Отправка',
      cols: [22, 13, 8, 34],
      rows: [
        ['Оператор', 'Размер', 'AR', 'Ссылка'],
        ['РА "ЦВЕТ"', '720x360', '2:1', { v: 'Открыть ТТ', s: L.S.LINK, link: 'https://disk.360.yandex.ru/i/abc' }],
        ['РИМ', '512x704', '8:11', { v: 'нет', s: L.S.WARN }],
        [{ v: 55.765975, s: L.S.NUM6 }, { v: 49.127151, s: L.S.NUM6 }, 10, 'ок & <тест> "кавычки"'],
      ]
    },
    { name: 'Сводка', cols: [42, 14], rows: [['Показатель', 'Значение'], ['Всего', 12], ['Пусто', null]] }
  ];
  const blob = L.writeXlsx(sheets);
  const buf = Buffer.from(await blob.arrayBuffer());
  await fs.writeFile('./out_test.xlsx', buf);
  console.log('written out_test.xlsx', buf.length, 'bytes');

  // читаем обратно своей же читалкой
  const src = await fileSource('./out_test.xlsx');
  const wb = await L.readXlsx(src);
  for (const s of wb.sheets) {
    console.log(`  sheet "${s.name}":`);
    for (const r of s.rows) console.log('    ', JSON.stringify(r));
  }
  await src.close();
}

console.log('\n=== 5. ZIP write/read round-trip (UTF-8 имена) ===');
{
  const enc = new TextEncoder();
  const blob = L.zipWrite([
    { name: 'привет/файл №1.txt', bytes: enc.encode('содержимое один') },
    { name: 'second.bin', bytes: new Uint8Array([1, 2, 3, 4, 5]) }
  ]);
  const buf = Buffer.from(await blob.arrayBuffer());
  await fs.writeFile('./out_test.zip', buf);
  const src = await fileSource('./out_test.zip');
  const zip = await L.zipOpen(src);
  for (const e of zip.entries) {
    const data = await L.zipRead(zip, e);
    console.log(`  "${e.name}" size=${e.size} method=${e.method} ->`,
      JSON.stringify(new TextDecoder().decode(data).slice(0, 40)));
  }
  await src.close();
}
