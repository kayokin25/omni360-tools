import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('./omnilib.js');
const I = require('./inventory-core.js');

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

const IN = 'C:/Users/tuefr/OneDrive/Desktop/работа/Отчётность/input/Efirnaia_spravka_msk_prioritiet_iiun_2_862295039590531316.xlsx';

const src = await fileSource(IN);
const file = { name: 'test.xlsx', size: src.size, arrayBuffer: async () => {
  const bytes = await src.slice(0, src.size);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}};
// patchFile принимает L.blobSource(file) внутри — нужен объект с size/slice, как из браузера.
// Подсовываем наш fileSource прямо (он совместим с интерфейсом blobSource).
const origBlobSource = L.blobSource;
L.blobSource = function (f) { return f === file ? src : origBlobSource(f); };

console.log('Патчу...');
const res = await I.patchFile(file);
console.log(JSON.stringify({ ...res, blob: undefined }, null, 1));

await fs.writeFile('./out_inventory.xlsx', Buffer.from(await res.blob.arrayBuffer()));
console.log('записан out_inventory.xlsx');
await src.close();
