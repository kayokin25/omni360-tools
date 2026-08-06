/* ============================================================================
   Omni360 — общая мини-библиотека для инструментов панели.
   Без внешних зависимостей. Работает в браузере и в node (для тестов).

   Содержит:
     • ZIP-читалку с произвольным доступом (EOCD / ZIP64 / deflate-raw)
     • ZIP-писалку (STORED + CRC32, UTF-8 имена)
     • XLSX-читалку (workbook/rels/sharedStrings/sheet XML)
     • XLSX-писалку (стили, ширины, закрепление шапки, гиперссылки)
     • разбор пиксельных размеров MP4/MOV из байтов (boxes moov→…→stsd)
   ========================================================================== */
(function (root) {
'use strict';

/* ─────────────────────────── байтовые утилиты ─────────────────────────── */

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function u64(b, o) { // little-endian 64-бит как Number (хватает до 2^53)
  return u32(b, o) + u32(b, o + 4) * 4294967296;
}

// поиск последовательности байт в буфере (с конца или с начала)
function findSeq(buf, seq, from, backwards) {
  const n = buf.length, m = seq.length;
  if (backwards) {
    for (let i = (from === undefined ? n - m : from); i >= 0; i--) {
      let ok = true;
      for (let j = 0; j < m; j++) if (buf[i + j] !== seq[j]) { ok = false; break; }
      if (ok) return i;
    }
  } else {
    for (let i = (from || 0); i <= n - m; i++) {
      let ok = true;
      for (let j = 0; j < m; j++) if (buf[i + j] !== seq[j]) { ok = false; break; }
      if (ok) return i;
    }
  }
  return -1;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const utf8Loose = new TextDecoder('utf-8');
function decodeName(bytes, utf8Flag) {
  if (utf8Flag) return utf8Loose.decode(bytes);
  // Без флага UTF-8 имя может быть в CP866/CP437 (архив из Windows).
  try { return utf8Decoder.decode(bytes); } catch (e) { /* не UTF-8 */ }
  try { return new TextDecoder('ibm866').decode(bytes); } catch (e) { return utf8Loose.decode(bytes); }
}

function encodeUtf8(s) { return new TextEncoder().encode(s); }

/* ─────────────────────────── источники байтов ─────────────────────────── */
/* source = { size, slice(start, end) -> Promise<Uint8Array> }                */

function blobSource(blob) {
  return {
    size: blob.size,
    name: blob.name || '',
    async slice(start, end) {
      const s = Math.max(0, start), e = Math.min(blob.size, end);
      if (e <= s) return new Uint8Array(0);
      return new Uint8Array(await blob.slice(s, e).arrayBuffer());
    }
  };
}

function bytesSource(bytes, name) {
  return {
    size: bytes.length,
    name: name || '',
    async slice(start, end) {
      return bytes.subarray(Math.max(0, start), Math.min(bytes.length, end));
    }
  };
}

/* ───────────────────────────── inflate (raw) ───────────────────────────── */

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  w.write(bytes); w.close();
  const parts = [];
  let total = 0;
  const r = ds.readable.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    parts.push(value); total += value.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/* Потоковая распаковка с удержанием только «головы» и «хвоста» вывода.
   Нужна, чтобы читать размеры видео из огромных архивов, не съедая память. */
async function inflateRawHeadTail(source, compStart, compSize, headCap, tailCap) {
  const ds = new DecompressionStream('deflate-raw');
  const reader = ds.readable.getReader();
  const writer = ds.writable.getWriter();

  const head = new Uint8Array(headCap);
  let headLen = 0;
  let tail = new Uint8Array(0);
  let totalOut = 0;

  const pump = (async () => {
    const CHUNK = 1 << 20;
    try {
      for (let off = 0; off < compSize; off += CHUNK) {
        const chunk = await source.slice(compStart + off, compStart + Math.min(compSize, off + CHUNK));
        await writer.write(chunk);
      }
      await writer.close();
    } catch (e) { try { await writer.abort(e); } catch (e2) {} }
  })();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalOut += value.length;
      if (headLen < headCap) {
        const take = Math.min(headCap - headLen, value.length);
        head.set(value.subarray(0, take), headLen); headLen += take;
      }
      if (value.length >= tailCap) {
        tail = value.slice(value.length - tailCap);
      } else {
        const keep = Math.min(tailCap - value.length, tail.length);
        const nt = new Uint8Array(keep + value.length);
        nt.set(tail.subarray(tail.length - keep), 0);
        nt.set(value, keep);
        tail = nt;
      }
    }
  } finally {
    try { await pump; } catch (e) {}
  }
  return { head: head.subarray(0, headLen), tail: tail, totalOut: totalOut };
}

/* ──────────────────────────── ZIP: чтение ─────────────────────────────── */

const SIG_EOCD  = [0x50, 0x4b, 0x05, 0x06];
const SIG_EOCD64 = [0x50, 0x4b, 0x06, 0x06];
const SIG_LOC64 = [0x50, 0x4b, 0x06, 0x07];

async function zipOpen(source) {
  const tailLen = Math.min(source.size, 66000);
  const tail = await source.slice(source.size - tailLen, source.size);
  const eocdRel = findSeq(tail, SIG_EOCD, undefined, true);
  if (eocdRel < 0) throw new Error('Это не ZIP-архив (не найден EOCD)');

  let cdCount = u16(tail, eocdRel + 10);
  let cdSize = u32(tail, eocdRel + 12);
  let cdOffset = u32(tail, eocdRel + 16);

  // ZIP64: смотрим локатор перед EOCD
  const locRel = findSeq(tail, SIG_LOC64, eocdRel, true);
  if (locRel >= 0) {
    const eocd64Off = u64(tail, locRel + 8);
    const e64 = await source.slice(eocd64Off, eocd64Off + 56);
    if (findSeq(e64, SIG_EOCD64, 0, false) === 0) {
      cdCount = u64(e64, 32);
      cdSize = u64(e64, 40);
      cdOffset = u64(e64, 48);
    }
  }

  const cd = await source.slice(cdOffset, cdOffset + cdSize);
  const entries = [];
  let p = 0;
  for (let i = 0; i < cdCount && p + 46 <= cd.length; i++) {
    if (u32(cd, p) !== 0x02014b50) break;
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    const crc = u32(cd, p + 16);
    let compSize = u32(cd, p + 20);
    let uncompSize = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let localOff = u32(cd, p + 42);
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
    const name = decodeName(nameBytes, !!(flags & 0x800));

    // ZIP64 extra (0x0001) — переопределяет размеры/смещение
    let ep = p + 46 + nameLen;
    const extraEnd = ep + extraLen;
    while (ep + 4 <= extraEnd) {
      const hid = u16(cd, ep), hsz = u16(cd, ep + 2);
      if (hid === 0x0001) {
        let q = ep + 4;
        if (uncompSize === 0xffffffff && q + 8 <= ep + 4 + hsz) { uncompSize = u64(cd, q); q += 8; }
        if (compSize === 0xffffffff && q + 8 <= ep + 4 + hsz) { compSize = u64(cd, q); q += 8; }
        if (localOff === 0xffffffff && q + 8 <= ep + 4 + hsz) { localOff = u64(cd, q); q += 8; }
        break;
      }
      ep += 4 + hsz;
    }

    entries.push({
      name: name,
      isDir: name.endsWith('/') || name.endsWith('\\'),
      method: method,
      crc: crc,
      compSize: compSize,
      size: uncompSize,
      localOff: localOff,
      _dataStart: -1
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { source: source, entries: entries };
}

async function entryDataStart(zip, entry) {
  if (entry._dataStart >= 0) return entry._dataStart;
  const lh = await zip.source.slice(entry.localOff, entry.localOff + 30);
  if (u32(lh, 0) !== 0x04034b50) throw new Error('Повреждён локальный заголовок: ' + entry.name);
  entry._dataStart = entry.localOff + 30 + u16(lh, 26) + u16(lh, 28);
  return entry._dataStart;
}

async function zipRead(zip, entry) {
  const start = await entryDataStart(zip, entry);
  const raw = await zip.source.slice(start, start + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRaw(raw);
  throw new Error('Неподдерживаемый метод сжатия ' + entry.method + ' в ' + entry.name);
}

/* «Голова» и «хвост» распакованных данных записи — без чтения всего файла. */
async function zipReadHeadTail(zip, entry, headCap, tailCap) {
  const start = await entryDataStart(zip, entry);
  if (entry.method === 0) {
    if (entry.size <= headCap + tailCap) {
      const all = await zip.source.slice(start, start + entry.size);
      return { head: all, tail: all, whole: true };
    }
    return {
      head: await zip.source.slice(start, start + headCap),
      tail: await zip.source.slice(start + entry.size - tailCap, start + entry.size),
      whole: false
    };
  }
  if (entry.method !== 8) throw new Error('Неподдерживаемый метод сжатия ' + entry.method);
  const r = await inflateRawHeadTail(zip.source, start, entry.compSize, headCap, tailCap);
  return { head: r.head, tail: r.tail, whole: r.totalOut <= headCap };
}

/* ──────────────────────────── ZIP: запись ─────────────────────────────── */

const CRC_TABLE = (function () {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, seed) {
  let c = (seed === undefined ? 0 : seed) ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function w16(a, v) { a.push(v & 0xff, (v >>> 8) & 0xff); }
function w32(a, v) { a.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); }

/* Собирает ZIP (метод STORED) из [{name, bytes|blob, crc?, size?}].
   Возвращает Blob. Данные держим как Blob-части, чтобы не копить всё в памяти. */
function zipWrite(files) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = encodeUtf8(f.name);
    const size = f.size !== undefined ? f.size : f.bytes.length;
    const crc = f.crc !== undefined ? f.crc : crc32(f.bytes);

    const lh = [];
    w32(lh, 0x04034b50);
    w16(lh, 20);          // version needed
    w16(lh, 0x0800);      // флаг UTF-8 в имени
    w16(lh, 0);           // STORED
    w16(lh, 0); w16(lh, 0); // время/дата
    w32(lh, crc); w32(lh, size); w32(lh, size);
    w16(lh, nameBytes.length); w16(lh, 0);
    const lhBytes = new Uint8Array(lh);

    parts.push(lhBytes, nameBytes, f.blob || f.bytes);

    const cd = [];
    w32(cd, 0x02014b50);
    w16(cd, 20); w16(cd, 20);
    w16(cd, 0x0800); w16(cd, 0);
    w16(cd, 0); w16(cd, 0);
    w32(cd, crc); w32(cd, size); w32(cd, size);
    w16(cd, nameBytes.length); w16(cd, 0); w16(cd, 0);
    w16(cd, 0); w16(cd, 0); w32(cd, 0);
    w32(cd, offset);
    central.push(new Uint8Array(cd), nameBytes);

    offset += lhBytes.length + nameBytes.length + size;
  }

  let cdSize = 0;
  for (const c of central) cdSize += c.length;

  const eocd = [];
  w32(eocd, 0x06054b50);
  w16(eocd, 0); w16(eocd, 0);
  w16(eocd, files.length); w16(eocd, files.length);
  w32(eocd, cdSize); w32(eocd, offset);
  w16(eocd, 0);

  return new Blob(parts.concat(central, [new Uint8Array(eocd)]), { type: 'application/zip' });
}

/* ─────────────────────── размеры видео из MP4/MOV ─────────────────────── */

const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta']);
const AUDIO_FOURCC = new Set(['mp4a', 'ac-3', 'ec-3', 'alac', 'Opus', 'sowt', 'twos', 'ulaw',
  'alaw', '.mp3', 'samr', 'sawb', 'dtsc', 'dtse', 'dtsh', 'dtsl', 'fLaC']);

function fourcc(b, o) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

function* iterBoxes(b, start, end) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = u32be(b, pos);
    const type = fourcc(b, pos + 4);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      size = u64be(b, pos + 8);
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) break;
    yield [type, pos + header, pos + size];
    pos += size;
  }
}
function u32be(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
function u16be(b, o) { return (b[o] << 8) | b[o + 1]; }
function u64be(b, o) { return u32be(b, o) * 4294967296 + u32be(b, o + 4); }

/* Структурный разбор — как в match_creatives.py (_find_stsd_dims). */
function findStsdDims(b, start, end) {
  for (const [type, bs, be] of iterBoxes(b, start, end)) {
    if (type === 'stsd') {
      const p = bs + 8; // version+flags + entry_count
      for (const [etype, es, ee] of iterBoxes(b, p, be)) {
        if (ee - es >= 28) {
          const w = u16be(b, es + 24), h = u16be(b, es + 26);
          if (w && h) return [w, h];
        }
      }
    } else if (CONTAINER_BOXES.has(type)) {
      const r = findStsdDims(b, bs, be);
      if (r) return r;
    }
  }
  return null;
}

/* Резервный путь: буфер начинается «посреди» файла (хвост большого видео),
   структуру от нуля не пройти — ищем маркер stsd напрямую. */
function scanStsdDims(b) {
  const SEQ = [0x73, 0x74, 0x73, 0x64]; // 'stsd'
  let from = 0;
  for (;;) {
    const i = findSeq(b, SEQ, from, false);
    if (i < 0) return null;
    from = i + 1;
    const entry = i + 12;              // размер(4)+тип(4) → +version/flags(4)+count(4)
    if (entry + 40 > b.length) continue;
    const etype = fourcc(b, entry + 4);
    if (AUDIO_FOURCC.has(etype)) continue;
    const w = u16be(b, entry + 32), h = u16be(b, entry + 34);
    if (w > 0 && h > 0 && w <= 16384 && h <= 16384) return [w, h];
  }
}

function dimsFromHeadTail(head, tail, whole) {
  let d = null;
  try { d = findStsdDims(head, 0, head.length); } catch (e) { d = null; }
  if (d) return d;
  if (!whole && tail && tail.length) {
    try { d = scanStsdDims(tail); } catch (e) { d = null; }
    if (d) return d;
  }
  if (!d) { try { d = scanStsdDims(head); } catch (e) { d = null; } }
  return d;
}

/* ───────────────────────────── XML утилиты ────────────────────────────── */

function unescapeXml(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, function (m, g) {
    switch (g) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default:
        return g[1] === 'x' || g[1] === 'X'
          ? String.fromCodePoint(parseInt(g.slice(2), 16))
          : String.fromCodePoint(parseInt(g.slice(1), 10));
    }
  });
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c];
  // eslint-disable-next-line no-control-regex
  }).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

/* ──────────────────────────── XLSX: чтение ────────────────────────────── */

function colToIndex(ref) { // 'BC12' -> 54 (0-based)
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
    else break;
  }
  return n - 1;
}

function parseSharedStrings(xml) {
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const inner = m[1] || '';
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
    let t;
    while ((t = tRe.exec(inner))) text += unescapeXml(t[1] || '');
    out.push(text);
  }
  return out;
}

function parseSheetXml(xml, shared) {
  const rows = [];
  /* Группа атрибутов — ЛЕНИВАЯ ([^>]*?), не жадная. С жадной версией
     самозакрывающийся элемент (напр. пустая <c t="inlineStr"/> — Excel так
     пишет непустую по стилю, но безо всякого значения ячейку) на некоторых
     файлах склеивался со СЛЕДУЮЩИМ элементом: движок сначала жадно съедал
     атрибуты вплотную до конца "/>", альтернатива "\/>" не находила '/' на
     новой позиции и отваливалась, а вторая альтернатива ">...</row>" охотно
     дотягивалась до ЧУЖОГО закрывающего тега. В результате одна строка/ячейка
     пропадала, а следующая получала не своё содержимое — без единой ошибки
     в консоли. Поймано на реальном 37-тысячестрочном инвентаре: часть строк
     сдвигалась на одну ячейку. */
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const attrs = rm[1] || '';
    const body = rm[2] || '';
    const rAttr = /\br="(\d+)"/.exec(attrs);
    const rowIdx = rAttr ? parseInt(rAttr[1], 10) - 1 : rows.length;
    const cells = [];
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm, autoCol = 0;
    while ((cm = cRe.exec(body))) {
      const cAttrs = cm[1] || '';
      const cBody = cm[2] || '';
      const refM = /\br="([A-Za-z]+\d+)"/.exec(cAttrs);
      const col = refM ? colToIndex(refM[1]) : autoCol;
      autoCol = col + 1;
      const tM = /\bt="([^"]+)"/.exec(cAttrs);
      const type = tM ? tM[1] : 'n';
      let val = null;
      if (type === 'inlineStr') {
        let text = '';
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
        let t;
        while ((t = tRe.exec(cBody))) text += unescapeXml(t[1] || '');
        val = text;
      } else {
        const vM = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cBody);
        const raw = vM ? unescapeXml(vM[1]) : null;
        if (raw === null || raw === '') val = null;
        else if (type === 's') val = shared[parseInt(raw, 10)];
        else if (type === 'str' || type === 'e') val = raw;
        else if (type === 'b') val = raw === '1';
        else { const num = Number(raw); val = isNaN(num) ? raw : num; }
      }
      cells[col] = val === undefined ? null : val;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = null;
    rows[rowIdx] = cells;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

/* Читает xlsx → { sheets: [{name, rows}] }. rows — массив массивов ячеек. */
async function readXlsx(source) {
  const zip = await zipOpen(source);
  const byName = {};
  for (const e of zip.entries) if (!e.isDir) byName[e.name.replace(/^\/+/, '')] = e;

  async function text(name) {
    const e = byName[name];
    if (!e) return null;
    return utf8Loose.decode(await zipRead(zip, e));
  }

  const wbXml = await text('xl/workbook.xml');
  if (!wbXml) throw new Error('Это не файл .xlsx (нет xl/workbook.xml)');
  const relsXml = (await text('xl/_rels/workbook.xml.rels')) || '';

  const rels = {};
  const relRe = /<Relationship\b([^>]*)\/?>/g;
  let rm;
  while ((rm = relRe.exec(relsXml))) {
    const a = rm[1];
    const id = /\bId="([^"]+)"/.exec(a);
    const tgt = /\bTarget="([^"]+)"/.exec(a);
    if (id && tgt) rels[id[1]] = unescapeXml(tgt[1]);
  }

  let shared = [];
  const ssXml = await text('xl/sharedStrings.xml');
  if (ssXml) shared = parseSharedStrings(ssXml);

  const sheets = [];
  const shRe = /<sheet\b([^>]*)\/?>/g;
  let sm;
  while ((sm = shRe.exec(wbXml))) {
    const a = sm[1];
    const nameM = /\bname="([^"]*)"/.exec(a);
    const ridM = /\br:id="([^"]+)"/.exec(a) || /\bid="([^"]+)"/.exec(a);
    const name = nameM ? unescapeXml(nameM[1]) : 'Sheet' + (sheets.length + 1);
    let target = ridM ? rels[ridM[1]] : null;
    if (!target) target = 'worksheets/sheet' + (sheets.length + 1) + '.xml';
    let path = target.replace(/^\/+/, '');
    if (!/^xl\//.test(path)) path = 'xl/' + path;
    const xml = await text(path);
    sheets.push({ name: name, rows: xml ? parseSheetXml(xml, shared) : [] });
  }
  return { sheets: sheets };
}

/* ──────────────────────────── XLSX: запись ────────────────────────────── */
/* Стили (индексы cellXfs):
     0 обычный · 1 шапка · 2 тело · 3 тело-красное · 4 тело-зелёное
     5 гиперссылка · 6 число 0.000000                                        */

const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
'<numFmts count="1"><numFmt numFmtId="164" formatCode="0.000000"/></numFmts>' +
'<fonts count="4">' +
  '<font><sz val="10"/><name val="Arial"/></font>' +
  '<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>' +
  '<font><u/><sz val="10"/><color rgb="FF0563C1"/><name val="Arial"/></font>' +
  '<font><sz val="10"/><name val="Arial"/></font>' +
'</fonts>' +
'<fills count="5">' +
  '<fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FF2F3B52"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFCE4E4"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFE7F4E4"/><bgColor indexed="64"/></patternFill></fill>' +
'</fills>' +
'<borders count="2">' +
  '<border><left/><right/><top/><bottom/><diagonal/></border>' +
  '<border><left style="thin"><color rgb="FFD0D0D0"/></left><right style="thin"><color rgb="FFD0D0D0"/></right>' +
  '<top style="thin"><color rgb="FFD0D0D0"/></top><bottom style="thin"><color rgb="FFD0D0D0"/></bottom><diagonal/></border>' +
'</borders>' +
'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
'<cellXfs count="7">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
'</cellXfs>' +
'<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
'</styleSheet>';

const S = { PLAIN: 0, HEADER: 1, BODY: 2, WARN: 3, OK: 4, LINK: 5, NUM6: 6 };

function indexToCol(i) {
  let s = '';
  i += 1;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

/* Лист: { name, cols:[ширины], freeze:true, rows:[ [ {v,s,link} | значение ] ] } */
function sheetToXml(sheet) {
  const hyperlinks = [];
  let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';

  x += '<sheetViews><sheetView workbookViewId="0">';
  if (sheet.freeze !== false) {
    x += '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>';
  }
  x += '</sheetView></sheetViews>';

  if (sheet.cols && sheet.cols.length) {
    x += '<cols>';
    sheet.cols.forEach(function (w, i) {
      x += '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>';
    });
    x += '</cols>';
  }

  x += '<sheetData>';
  sheet.rows.forEach(function (row, ri) {
    const rn = ri + 1;
    x += '<row r="' + rn + '"' + (ri === 0 ? ' ht="30" customHeight="1"' : '') + '>';
    row.forEach(function (cell, ci) {
      if (cell === null || cell === undefined) return;
      const obj = (typeof cell === 'object' && cell !== null && !(cell instanceof Date)) ? cell : { v: cell };
      let v = obj.v;
      if (v === null || v === undefined || v === '') {
        if (obj.s === undefined) return;
        v = '';
      }
      const ref = indexToCol(ci) + rn;
      const st = obj.s === undefined ? (ri === 0 ? S.HEADER : S.BODY) : obj.s;
      if (obj.link) hyperlinks.push({ ref: ref, url: obj.link });
      if (typeof v === 'number' && isFinite(v)) {
        x += '<c r="' + ref + '" s="' + st + '"><v>' + v + '</v></c>';
      } else if (typeof v === 'boolean') {
        x += '<c r="' + ref + '" s="' + st + '" t="b"><v>' + (v ? 1 : 0) + '</v></c>';
      } else {
        x += '<c r="' + ref + '" s="' + st + '" t="inlineStr"><is><t xml:space="preserve">' +
          escapeXml(v) + '</t></is></c>';
      }
    });
    x += '</row>';
  });
  x += '</sheetData>';

  if (hyperlinks.length) {
    x += '<hyperlinks>';
    hyperlinks.forEach(function (h, i) {
      x += '<hyperlink ref="' + h.ref + '" r:id="rId' + (i + 1) + '"/>';
    });
    x += '</hyperlinks>';
  }
  x += '</worksheet>';
  return { xml: x, hyperlinks: hyperlinks };
}

/* sheets: [{name, cols, freeze, rows}] → Blob (.xlsx) */
function writeXlsx(sheets) {
  const files = [];
  const add = function (name, str) { files.push({ name: name, bytes: encodeUtf8(str) }); };

  let ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
  sheets.forEach(function (s, i) {
    ct += '<Override PartName="/xl/worksheets/sheet' + (i + 1) +
      '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
  });
  ct += '</Types>';
  add('[Content_Types].xml', ct);

  add('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>');

  let wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>';
  sheets.forEach(function (s, i) {
    wb += '<sheet name="' + escapeXml(String(s.name).slice(0, 31).replace(/[\\/*?:[\]]/g, '_')) +
      '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
  });
  wb += '</sheets></workbook>';
  add('xl/workbook.xml', wb);

  let wbr = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
  sheets.forEach(function (s, i) {
    wbr += '<Relationship Id="rId' + (i + 1) +
      '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' +
      (i + 1) + '.xml"/>';
  });
  wbr += '<Relationship Id="rId' + (sheets.length + 1) +
    '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
  wbr += '</Relationships>';
  add('xl/_rels/workbook.xml.rels', wbr);

  add('xl/styles.xml', STYLES_XML);

  sheets.forEach(function (s, i) {
    const r = sheetToXml(s);
    add('xl/worksheets/sheet' + (i + 1) + '.xml', r.xml);
    if (r.hyperlinks.length) {
      let rl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
      r.hyperlinks.forEach(function (h, j) {
        rl += '<Relationship Id="rId' + (j + 1) +
          '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' +
          escapeXml(h.url) + '" TargetMode="External"/>';
      });
      rl += '</Relationships>';
      add('xl/worksheets/_rels/sheet' + (i + 1) + '.xml.rels', rl);
    }
  });

  const blob = zipWrite(files);
  return new Blob([blob], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/* ──────────────────── общие хелперы адресных программ ─────────────────── */

/* Нормализация имени оператора: нижний регистр, пунктуация → пробел.
   Точный аналог _norm() из tt.py: \w сохраняет буквы, цифры и подчёркивание. */
function normName(s) {
  return String(s === null || s === undefined ? '' : s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normRes(s) {
  if (s === null || s === undefined) return null;
  const m = /(\d+)\s*[xхXХ×*]\s*(\d+)/.exec(String(s));
  return m ? parseInt(m[1], 10) + 'x' + parseInt(m[2], 10) : null;
}

function parseRes(s) {
  if (s === null || s === undefined) return null;
  const m = /(\d+)\s*[xхXХ×*]\s*(\d+)/.exec(String(s));
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
}

function normAspect(s) {
  if (s === null || s === undefined) return null;
  const m = /(\d+)\s*:\s*(\d+)/.exec(String(s));
  return m ? parseInt(m[1], 10) + ':' + parseInt(m[2], 10) : null;
}

function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { const t = b; b = a % b; a = t; } return a; }
function reduceRatio(w, h) { const g = gcd(w, h) || 1; return [w / g, h / g]; }

function cellStr(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
}

/* ────────────────────────────── экспорт ───────────────────────────────── */

root.OmniLib = {
  blobSource: blobSource, bytesSource: bytesSource,
  zipOpen: zipOpen, zipRead: zipRead, zipReadHeadTail: zipReadHeadTail, zipWrite: zipWrite,
  inflateRaw: inflateRaw, crc32: crc32,
  readXlsx: readXlsx, writeXlsx: writeXlsx, S: S,
  findStsdDims: findStsdDims, scanStsdDims: scanStsdDims, dimsFromHeadTail: dimsFromHeadTail,
  normName: normName, normRes: normRes, parseRes: parseRes, normAspect: normAspect,
  reduceRatio: reduceRatio, cellStr: cellStr, download: download,
  escapeXml: escapeXml, unescapeXml: unescapeXml, encodeUtf8: encodeUtf8,
  indexToCol: indexToCol, colToIndex: colToIndex, parseSharedStrings: parseSharedStrings
};

})(typeof globalThis !== 'undefined' ? globalThis : this);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.OmniLib;
