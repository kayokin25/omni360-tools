/* ============================================================================
   ССК — отчёт об оказанных услугах (Word + PDF) по АП и фото экранов.

   Формат — как в отчёте «ССК_РТ-Сервис_август26»: шапка (УПД, заказчик,
   исполнитель, договор, период, объект, работы), список регионов, затем по
   регионам — «Адрес: …» и фото под ним, в конце строка «Оказанные услуги
   подтверждаю … ФИО…/».

   Правила (согласованы с отделом ведения):
     - адрес — как в АП, плюс «, сторона X», если сторона задана;
     - регион — по справочнику городов планировщика DSP (city-regions.js);
       «поселение …» — Новая Москва;
     - на экран одно фото: самый ранний снимок этого GID в архиве. GID
       ищется в начале имени файла — так называет снимки и бэкенд DSP
       (`MSBB01455A1_Varshavskoie_…_21082026_21_14_48_c.png`), и наша
       перепаковка архива (`MSBB01455A1 Варшавское … 21.08.2026 21-14-48.jpeg`);
     - экран без фото остаётся в отчёте с пометкой «фотоотчёт не
       предоставлен». С опцией «плейсхолдеры» ему ставится случайное фото из
       этого же отчёта и подпись «Иллюстративное фото…» — как стр. 44–46
       образца.

   Word пишется руками (document.xml + media в STORE-zip), PDF — тоже руками:
   фото идут как есть (JPEG, DCTDecode), текст — вшитым Tinos (метрики Times
   New Roman, см. ssk-fonts.js) через Type0/Identity-H. Готовой библиотеки
   нет намеренно: инструмент — один offline-HTML без зависимостей.

   Зависит от OmniLib и CityRegions.
   ========================================================================== */
(function (root) {
'use strict';

const L = root.OmniLib;

const PLACEHOLDER_NOTE = 'Иллюстративное фото: фотоотчёт по данной поверхности не предоставлен (по согласованию с Заказчиком).';
const NO_PHOTO_NOTE = 'Фотоотчёт по данной поверхности не предоставлен.';
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа',
  'сентября', 'октября', 'ноября', 'декабря'];

const norm = function (s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
};

/* ─────────────────────────────────── АП ─────────────────────────────────── */

function colOf(header, names) {
  for (const n of names) {
    const i = header.findIndex(function (h) { return norm(h) === norm(n); });
    if (i >= 0) return i;
  }
  return -1;
}

/* Экраны из АП: первый лист, где в первых строках есть GID и «Адрес». Так
   читаются и «Экраны» со страницы РК, и лист «АП» из выгрузки МП. */
async function readAp(source) {
  const wb = await L.readXlsx(source);
  for (const sheet of wb.sheets) {
    for (let r = 0; r < Math.min(sheet.rows.length, 15); r++) {
      const h = sheet.rows[r] || [];
      const c = { gid: colOf(h, ['GID']), city: colOf(h, ['Город']), address: colOf(h, ['Адрес']), side: colOf(h, ['Сторона']) };
      if (c.gid < 0 || c.address < 0) continue;
      const screens = [];
      for (const row of sheet.rows.slice(r + 1)) {
        const gid = L.cellStr(row && row[c.gid]);
        if (!gid) continue;
        screens.push({
          gid: gid,
          city: c.city >= 0 ? L.cellStr(row[c.city]) : '',
          address: L.cellStr(row[c.address]),
          side: c.side >= 0 ? L.cellStr(row[c.side]) : ''
        });
      }
      return screens;
    }
  }
  throw new Error('в АП не нашёл шапку со столбцами GID и «Адрес»');
}

const NOT_CITY = /област|край|республик|округ|автономн/i;

function regionOf(city) {
  const raw = String(city || '').trim();
  // ponytail: «поселение» без «городское/сельское» в DSP — только Новая Москва
  // (в МО с 2019 одни городские округа). Если появится иначе — в справочник.
  if (/^поселение\s/i.test(raw)) return 'Москва';
  const map = root.CityRegions || {};
  const k = norm(raw);
  const bare = k.replace(/^(г\.|город|пгт|пос[её]лок|п\.)\s*/, '')
    .replace(/\s+(городской округ|г\.\s?о\.|муниципальный округ|район)$/, '').trim();
  return map[k] || map[bare] || raw || 'Без города';
}

/* «Москва» → «г. Москва», «Московская область» — как есть. */
function regionTitle(region) {
  return NOT_CITY.test(region) ? region : 'г. ' + region;
}

function addressLine(s) {
  // «регион,Киевское» → «регион, Киевское»; «0,7 км» не трогаем.
  const a = String(s.address || '').replace(/,(?=[^\s\d])/g, ', ').replace(/\s+/g, ' ').replace(/[\s,]+$/, '').trim();
  return s.side ? a + ', сторона ' + s.side : a;
}

/* ──────────────────────────────── фото ──────────────────────────────────── */

const gidKey = function (s) { return String(s).toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '_'); };

/* Время снимка из имени: «…_21082026_21_14_48_c.png» или «… 21.08.2026 21-14-48.jpeg». */
function shotStamp(name) {
  const m = /_(\d{2})(\d{2})(\d{4})_(\d{2})_(\d{2})_(\d{2})/.exec(name) ||
    / (\d{2})\.(\d{2})\.(\d{4}) (\d{2})-(\d{2})-(\d{2})/.exec(name);
  return m ? m[3] + m[2] + m[1] + m[4] + m[5] + m[6] : '';
}

/* GID → имена снимков по времени. Самый длинный подходящий GID — иначе
   «4792B» забрал бы снимки «4792B1». */
function matchPhotos(names, screens) {
  const keys = screens.map(function (s) { return [s.gid, gidKey(s.gid)]; })
    .filter(function (p) { return p[1].replace(/_/g, ''); })
    .sort(function (a, b) { return b[1].length - a[1].length; });
  const out = new Map();
  for (const name of names) {
    const file = name.split('/').pop();
    if (!/\.(jpe?g|png|webp)$/i.test(file)) continue;
    const base = gidKey(file.replace(/\.[^.]+$/, ''));
    const hit = keys.find(function (p) { return base === p[1] || base.startsWith(p[1] + '_'); });
    if (!hit) continue;
    if (!out.has(hit[0])) out.set(hit[0], []);
    out.get(hit[0]).push(name);
  }
  for (const list of out.values()) {
    list.sort(function (a, b) { return (shotStamp(a) + a).localeCompare(shotStamp(b) + b); });
  }
  return out;
}

/* Фото → JPEG не шире 1600 px (только браузер). PDF берёт JPEG как есть, а
   PNG из архива весят в разы больше и требуют разжатия. */
async function prepPhoto(blob, key) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, 1600 / bmp.width);
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const jpeg = await new Promise(function (res) { canvas.toBlob(res, 'image/jpeg', 0.85); });
  return { key: key, bytes: new Uint8Array(await jpeg.arrayBuffer()), w: w, h: h };
}

/* ─────────────────────────────── модель ─────────────────────────────────── */

function shuffle(a, rnd) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* screens — из АП (или из DSP), photoOf(gid) → { key, bytes, w, h } | null.
   Плейсхолдеры берутся по кругу из перемешанных настоящих фото: два экрана
   подряд не получают одно и то же, пока не кончится запас. */
function buildModel(screens, photoOf, opt) {
  const o = opt || {};
  const items = screens.map(function (s) {
    return { screen: s, region: regionOf(s.city), address: addressLine(s), photo: photoOf(s.gid) || null, placeholder: false };
  });
  const missing = items.filter(function (it) { return !it.photo; });
  const pool = items.filter(function (it) { return it.photo; }).map(function (it) { return it.photo; });
  if (o.placeholders && pool.length) {
    let bag = [];
    for (const it of missing) {
      if (!bag.length) bag = shuffle(pool.slice(), o.random || Math.random);
      it.photo = bag.pop();
      it.placeholder = true;
    }
  }
  const byRegion = new Map();
  for (const it of items) {
    if (!byRegion.has(it.region)) byRegion.set(it.region, []);
    byRegion.get(it.region).push(it);
  }
  return {
    regions: [...byRegion].map(function (e) { return { title: regionTitle(e[0]), items: e[1] }; }),
    missing: missing.map(function (it) { return it.screen; }),
    placeholders: o.placeholders && pool.length ? missing.length : 0,
    withPhoto: pool.length
  };
}

/* ─────────────────────────── блоки документа ────────────────────────────── */
/* Общая разметка для Word и PDF: абзацы (runs + отступы в пунктах, line —
   множитель межстрочного) и картинки. Отступы — как в образце. */

function dmy(iso) {
  if (!iso) return '__.__.____';
  const p = String(iso).split('-');
  return p[2] + '.' + p[1] + '.' + p[0];
}
function longDate(iso) {
  if (!iso) return '"__" ________ ____';
  const p = String(iso).split('-');
  return '"' + p[2] + '" ' + MONTHS[Number(p[1]) - 1] + ' ' + p[0];
}
const or = function (v, dflt) { return String(v || '').trim() || dflt; };

function defaultWorks(objectName) {
  return 'Размещение РИМ Заказчика направленных на организацию и проведение рекламной кампании "' +
    or(objectName, '____') + '" с целью увеличения объемов продаж и узнаваемости бренда с разбивкой по адресам';
}

function P(runs, o) {
  return Object.assign({ type: 'p', runs: typeof runs === 'string' ? [{ t: runs }] : runs,
    align: 'both', before: 0, after: 8, line: 1, keepNext: false }, o || {});
}

function documentBlocks(model, header) {
  const h = header || {};
  const b = [
    P('Отчет', { align: 'center', after: 0 }),
    P('Об оказанных услугах к УПД № ' + or(h.updNo, '____') + ' от ' + dmy(h.updDate) + ' г.', { align: 'center', after: 0 }),
    P('', { align: 'center' }),
    P('Заказчик: ' + or(h.customer, '____'), { align: 'left', line: 1.15 }),
    P('Исполнитель: ' + or(h.contractor, '____'), { align: 'left', line: 1.15 }),
    P('Договор № ' + or(h.contractNo, '____') + ' от ' + longDate(h.contractDate) + ' г.'),
    P('Период: с ' + dmy(h.periodFrom) + ' по ' + dmy(h.periodTo)),
    P('Наименование объекта: "' + or(h.objectName, '____') + '"'),
    P('Наименование работ (услуг): ' + or(h.works, defaultWorks(h.objectName))),
    P('Выполнено: ________________'),
    P(''),
    P([{ t: 'Адреса размещения:', b: true }])
  ];
  model.regions.forEach(function (r, i) { b.push(P((i + 1) + '. ' + r.title)); });
  for (const r of model.regions) {
    b.push(P([{ t: r.title, b: true }], { align: 'center', before: 12, keepNext: true }));
    for (const it of r.items) {
      b.push(P([{ t: 'Адрес: ', b: true }, { t: it.address }], { before: 10, keepNext: !!it.photo }));
      if (it.photo) b.push({ type: 'img', photo: it.photo, after: 8 });
      if (it.placeholder) b.push(P([{ t: PLACEHOLDER_NOTE, i: true, size: 10 }]));
      else if (!it.photo) b.push(P([{ t: NO_PHOTO_NOTE, i: true, size: 10 }]));
    }
  }
  b.push(P('Оказанные услуги подтверждаю                    ФИО__________________/'));
  return b;
}

/* Фото — 15,5 см по ширине, как в образце; вертикальное ужимаем по высоте,
   чтобы с адресом влезало на страницу. Пункты. */
const PT_CM = 72 / 2.54;
const IMG_W = 15.5 * PT_CM;
const IMG_MAX_H = 16 * PT_CM;
function imgBox(photo) {
  let w = IMG_W, h = w * photo.h / photo.w;
  if (h > IMG_MAX_H) { h = IMG_MAX_H; w = h * photo.w / photo.h; }
  return { w: w, h: h };
}

/* ───────────────────────────────── Word ─────────────────────────────────── */

function xml(s) { return L.escapeXml(s); }

function docxRun(r) {
  const size = (r.size || 12) * 2;
  return '<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>' +
    (r.b ? '<w:b/>' : '') + (r.i ? '<w:i/>' : '') +
    '<w:sz w:val="' + size + '"/><w:szCs w:val="' + size + '"/></w:rPr>' +
    '<w:t xml:space="preserve">' + xml(r.t) + '</w:t></w:r>';
}

function docxPPr(p) {
  return '<w:pPr>' + (p.keepNext ? '<w:keepNext/>' : '') +
    '<w:spacing w:before="' + Math.round(p.before * 20) + '" w:after="' + Math.round(p.after * 20) +
    '" w:line="' + Math.round(240 * p.line) + '" w:lineRule="auto"/>' +
    '<w:jc w:val="' + p.align + '"/></w:pPr>';
}

function docxImage(rid, n, box) {
  const cx = Math.round(box.w * 12700), cy = Math.round(box.h * 12700);
  return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + cx + '" cy="' + cy + '"/>' +
    '<wp:docPr id="' + n + '" name="Фото ' + n + '"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
    '<pic:nvPicPr><pic:cNvPr id="' + n + '" name="photo' + n + '.jpeg"/><pic:cNvPicPr/></pic:nvPicPr>' +
    '<pic:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
}

function buildDocx(blocks) {
  const media = new Map(); // photo.key → { rid, name, bytes }
  let n = 0;
  const body = blocks.map(function (bl) {
    if (bl.type === 'img') {
      let m = media.get(bl.photo.key);
      if (!m) {
        m = { rid: 'rIdImg' + (media.size + 1), name: 'image' + (media.size + 1) + '.jpeg', bytes: bl.photo.bytes };
        media.set(bl.photo.key, m);
      }
      n++;
      return '<w:p>' + docxPPr({ before: 0, after: bl.after, line: 1, align: 'left' }) + docxImage(m.rid, n, imgBox(bl.photo)) + '</w:p>';
    }
    return '<w:p>' + docxPPr(bl) + bl.runs.filter(function (r) { return r.t; }).map(docxRun).join('') + '</w:p>';
  }).join('');

  const doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>' + body +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701" ' +
    'w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>';

  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults>' +
    '<w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman" w:eastAsia="Times New Roman"/>' +
    '<w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>';

  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    [...media.values()].map(function (m) {
      return '<Relationship Id="' + m.rid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/' + m.name + '"/>';
    }).join('') + '</Relationships>';

  const files = [
    { name: '[Content_Types].xml', bytes: L.encodeUtf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>') },
    { name: '_rels/.rels', bytes: L.encodeUtf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: 'word/document.xml', bytes: L.encodeUtf8(doc) },
    { name: 'word/styles.xml', bytes: L.encodeUtf8(styles) },
    { name: 'word/_rels/document.xml.rels', bytes: L.encodeUtf8(rels) }
  ];
  for (const m of media.values()) files.push({ name: 'word/media/' + m.name, bytes: m.bytes });
  const blob = L.zipWrite(files);
  return new Blob([blob], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

/* ────────────────────────────────── PDF ─────────────────────────────────── */

function b64(s) {
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* Из TrueType нужны метрики и cmap (Юникод → глиф): глифы в PDF пишутся
   номерами (Identity-H), ширины — массивом /W. */
function parseTtf(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const t = {};
  for (let i = 0, n = dv.getUint16(4); i < n; i++) {
    const o = 12 + i * 16;
    t[String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3])] = dv.getUint32(o + 8);
  }
  const upm = dv.getUint16(t.head + 18);
  const ascent = dv.getInt16(t.hhea + 4), descent = dv.getInt16(t.hhea + 6), lineGap = dv.getInt16(t.hhea + 8);
  const nHM = dv.getUint16(t.hhea + 34), numGlyphs = dv.getUint16(t.maxp + 4);
  const widths = [];
  for (let g = 0; g < numGlyphs; g++) widths.push(dv.getUint16(t.hmtx + Math.min(g, nHM - 1) * 4));
  const cmap = new Map();
  for (let i = 0, n = dv.getUint16(t.cmap + 2); i < n; i++) {
    const rec = t.cmap + 4 + i * 8;
    const s = t.cmap + dv.getUint32(rec + 4);
    if (dv.getUint16(rec) !== 3 || dv.getUint16(rec + 2) !== 1 || dv.getUint16(s) !== 4) continue;
    const seg = dv.getUint16(s + 6) / 2;
    const endO = s + 14, startO = endO + seg * 2 + 2, deltaO = startO + seg * 2, rangeO = deltaO + seg * 2;
    for (let k = 0; k < seg; k++) {
      const end = dv.getUint16(endO + k * 2), start = dv.getUint16(startO + k * 2);
      const delta = dv.getUint16(deltaO + k * 2), ro = dv.getUint16(rangeO + k * 2);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let g;
        if (!ro) g = (c + delta) & 0xffff;
        else {
          g = dv.getUint16(rangeO + k * 2 + ro + (c - start) * 2);
          if (g) g = (g + delta) & 0xffff;
        }
        if (g) cmap.set(c, g);
      }
    }
    break;
  }
  return {
    bytes: bytes, upm: upm, ascent: ascent, descent: descent, lineGap: lineGap, widths: widths, cmap: cmap,
    bbox: [dv.getInt16(t.head + 36), dv.getInt16(t.head + 38), dv.getInt16(t.head + 40), dv.getInt16(t.head + 42)],
    italic: dv.getInt32(t.post + 4) / 65536
  };
}

async function deflate(bytes) {
  const cs = new CompressionStream('deflate');
  const out = new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
  return new Uint8Array(await out);
}

const A4 = { w: 595.28, h: 841.89, top: 2 * PT_CM, bottom: 2 * PT_CM, left: 3 * PT_CM, right: 1.5 * PT_CM };
const f2 = function (n) { return (Math.round(n * 100) / 100).toString(); };
const hex4 = function (n) { return ('000' + n.toString(16)).slice(-4); };

async function buildPdf(blocks, fontsB64) {
  const fonts = {};
  for (const k of ['R', 'B', 'I']) fonts[k] = parseTtf(b64(fontsB64[k]));
  const used = { R: new Map(), B: new Map(), I: new Map() };
  const fontOf = function (r) { return r.b ? 'B' : r.i ? 'I' : 'R'; };

  function glyphs(text, fk) {
    const f = fonts[fk], out = [];
    for (const ch of text) {
      const cp = ch.codePointAt(0) === 0xa0 ? 0x20 : ch.codePointAt(0);
      const g = f.cmap.get(cp) || 0;
      if (g) used[fk].set(g, cp);
      out.push(g);
    }
    return out;
  }
  function width(text, fk, size) {
    const f = fonts[fk];
    let w = 0;
    for (const g of glyphs(text, fk)) w += f.widths[g];
    return w * size / f.upm;
  }
  const lineH = function (size, mult) { const f = fonts.R; return size * (f.ascent - f.descent + f.lineGap) / f.upm * mult; };
  const ascentOf = function (size) { return size * fonts.R.ascent / fonts.R.upm; };

  /* Слова с их шрифтом и числом пробелов перед ними (подряд идущие пробелы
     в «подтверждаю … ФИО» держат ширину, как в Word). */
  function tokens(runs) {
    const out = [];
    let sp = 0;
    for (const r of runs) {
      for (const part of String(r.t).replace(/\t/g, ' ').split(/( +)/)) {
        if (!part) continue;
        if (part[0] === ' ') { sp += part.length; continue; }
        const fk = fontOf(r), size = r.size || 12;
        out.push({ t: part, fk: fk, size: size, sp: sp, w: width(part, fk, size), spW: width(' ', fk, size) });
        sp = 0;
      }
    }
    return out;
  }
  function wrap(runs, maxW) {
    const lines = [];
    let line = [], w = 0;
    for (const tk of tokens(runs)) {
      const gap = line.length ? tk.sp * tk.spW : 0;
      if (line.length && w + gap + tk.w > maxW) {
        lines.push({ items: line, w: w });
        line = [{ tk: tk, gap: 0 }]; w = tk.w;
      } else {
        line.push({ tk: tk, gap: gap }); w += gap + tk.w;
      }
    }
    if (line.length) lines.push({ items: line, w: w });
    return lines;
  }
  function pSize(p) { return Math.max.apply(null, p.runs.map(function (r) { return r.size || 12; })); }
  function blockH(bl, maxW) {
    if (bl.type === 'img') return imgBox(bl.photo).h + bl.after;
    return bl.before + Math.max(1, wrap(bl.runs, maxW).length) * lineH(pSize(bl), bl.line) + bl.after;
  }

  const maxW = A4.w - A4.left - A4.right;
  const limit = A4.h - A4.bottom;
  const pages = [];
  const images = new Map(); // photo.key → { name, photo }
  let ops = null, y = 0, atTop = true;
  function newPage() { ops = []; pages.push(ops); y = A4.top; atTop = true; }
  newPage();

  function drawLine(line, isLast, align, baseY) {
    let x = A4.left, extra = 0;
    if (align === 'center') x += (maxW - line.w) / 2;
    else if (align === 'both' && !isLast) {
      const gaps = line.items.filter(function (it) { return it.gap > 0; }).length;
      if (gaps) extra = (maxW - line.w) / gaps;
    }
    const py = A4.h - baseY;
    for (const it of line.items) {
      x += it.gap + (it.gap > 0 ? extra : 0);
      const hex = glyphs(it.tk.t, it.tk.fk).map(hex4).join('');
      ops.push('BT /F' + it.tk.fk + ' ' + it.tk.size + ' Tf 1 0 0 1 ' + f2(x) + ' ' + f2(py) + ' Tm <' + hex + '> Tj ET');
      x += it.tk.w;
    }
  }
  function placeP(p) {
    if (!atTop) y += p.before;
    const size = pSize(p), lh = lineH(size, p.line);
    const lines = wrap(p.runs, maxW);
    if (!lines.length) { if (y + lh > limit) newPage(); y += lh; atTop = false; }
    lines.forEach(function (line, i) {
      if (y + lh > limit) newPage();
      drawLine(line, i === lines.length - 1, p.align, y + ascentOf(size) + (lh - lineH(size, 1)) / 2);
      y += lh;
      atTop = false;
    });
    y += p.after;
  }
  function placeImg(bl) {
    const box = imgBox(bl.photo);
    if (!atTop && y + box.h > limit) newPage();
    let im = images.get(bl.photo.key);
    if (!im) { im = { name: 'Im' + (images.size + 1), photo: bl.photo }; images.set(bl.photo.key, im); }
    ops.push('q ' + f2(box.w) + ' 0 0 ' + f2(box.h) + ' ' + f2(A4.left) + ' ' + f2(A4.h - y - box.h) + ' cm /' + im.name + ' Do Q');
    y += box.h + bl.after;
    atTop = false;
  }

  // «Не отрывать от следующего»: заголовок региона + адрес + фото — одним куском.
  for (let i = 0; i < blocks.length;) {
    let j = i, h = blockH(blocks[i], maxW) - (atTop ? blocks[i].before || 0 : 0);
    while (blocks[j].keepNext && j + 1 < blocks.length) { j++; h += blockH(blocks[j], maxW); }
    if (!atTop && y + h > limit) newPage();
    for (; i <= j; i++) blocks[i].type === 'img' ? placeImg(blocks[i]) : placeP(blocks[i]);
  }

  /* ── сборка файла ── */
  const objs = []; // [Uint8Array|string, …] на объект
  const add = function (parts) { objs.push(parts); return objs.length; };
  const enc = function (s) { return L.encodeUtf8(s); };
  async function stream(dict, data, raw) {
    const body = raw ? data : await deflate(data);
    return add([dict.replace('>>', ' /Length ' + body.length + (raw ? '' : ' /Filter /FlateDecode') + ' >>') + '\nstream\n', body, '\nendstream']);
  }

  const catalogId = add(null), pagesId = add(null);
  const fontIds = {};
  for (const k of ['R', 'B', 'I']) {
    const f = fonts[k], s = 1000 / f.upm, name = 'Tinos' + (k === 'B' ? '-Bold' : k === 'I' ? '-Italic' : '');
    const file = await stream('<< /Length1 ' + f.bytes.length + ' >>', f.bytes);
    const desc = add(['<< /Type /FontDescriptor /FontName /' + name + ' /Flags ' + (k === 'I' ? 98 : 34) +
      ' /FontBBox [' + f.bbox.map(function (v) { return Math.round(v * s); }).join(' ') + '] /ItalicAngle ' + f2(f.italic) +
      ' /Ascent ' + Math.round(f.ascent * s) + ' /Descent ' + Math.round(f.descent * s) + ' /CapHeight 662 /StemV ' +
      (k === 'B' ? 140 : 80) + ' /FontFile2 ' + file + ' 0 R >>']);
    const cid = add(['<< /Type /Font /Subtype /CIDFontType2 /BaseFont /' + name +
      ' /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ' + desc +
      ' 0 R /CIDToGIDMap /Identity /W [0 [' + f.widths.map(function (w) { return Math.round(w * s); }).join(' ') + ']] >>']);
    const map = [...used[k]].map(function (e) {
      const cp = e[1];
      const u = cp > 0xffff ? hex4(0xd800 + ((cp - 0x10000) >> 10)) + hex4(0xdc00 + ((cp - 0x10000) & 0x3ff)) : hex4(cp);
      return '<' + hex4(e[0]) + '> <' + u + '>';
    });
    let cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def ' +
      '/CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n';
    for (let i = 0; i < map.length; i += 100) {
      const chunk = map.slice(i, i + 100);
      cmap += chunk.length + ' beginbfchar\n' + chunk.join('\n') + '\nendbfchar\n';
    }
    cmap += 'endcmap CMapName currentdict /CMap defineresource pop end end';
    const toUni = await stream('<< >>', enc(cmap));
    fontIds[k] = add(['<< /Type /Font /Subtype /Type0 /BaseFont /' + name + ' /Encoding /Identity-H /DescendantFonts [' +
      cid + ' 0 R] /ToUnicode ' + toUni + ' 0 R >>']);
  }

  const imgIds = {};
  for (const im of images.values()) {
    imgIds[im.name] = await stream('<< /Type /XObject /Subtype /Image /Width ' + im.photo.w + ' /Height ' + im.photo.h +
      ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode >>', im.photo.bytes, true);
  }
  const res = '<< /Font << /FR ' + fontIds.R + ' 0 R /FB ' + fontIds.B + ' 0 R /FI ' + fontIds.I + ' 0 R >> /XObject << ' +
    Object.keys(imgIds).map(function (n) { return '/' + n + ' ' + imgIds[n] + ' 0 R'; }).join(' ') + ' >> >>';
  const resId = add([res]);
  const pageIds = [];
  for (const p of pages) {
    const content = await stream('<< >>', enc(p.join('\n')));
    pageIds.push(add(['<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 ' + A4.w + ' ' + A4.h + '] /Resources ' +
      resId + ' 0 R /Contents ' + content + ' 0 R >>']));
  }
  objs[catalogId - 1] = ['<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>'];
  objs[pagesId - 1] = ['<< /Type /Pages /Kids [' + pageIds.map(function (id) { return id + ' 0 R'; }).join(' ') + '] /Count ' + pageIds.length + ' >>'];

  const parts = [enc('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')];
  let off = parts[0].length;
  const xref = [];
  objs.forEach(function (o, i) {
    xref.push(off);
    const chunk = [enc((i + 1) + ' 0 obj\n')].concat(o.map(function (x) { return typeof x === 'string' ? enc(x) : x; }), [enc('\nendobj\n')]);
    for (const c of chunk) { parts.push(c); off += c.length; }
  });
  parts.push(enc('xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' +
    xref.map(function (x) { return ('000000000' + x).slice(-10) + ' 00000 n \n'; }).join('') +
    'trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + catalogId + ' 0 R >>\nstartxref\n' + off + '\n%%EOF\n'));
  return { blob: new Blob(parts, { type: 'application/pdf' }), pages: pages.length };
}

root.SskCore = {
  PLACEHOLDER_NOTE: PLACEHOLDER_NOTE,
  readAp: readAp,
  regionOf: regionOf,
  regionTitle: regionTitle,
  addressLine: addressLine,
  matchPhotos: matchPhotos,
  prepPhoto: prepPhoto,
  buildModel: buildModel,
  defaultWorks: defaultWorks,
  documentBlocks: documentBlocks,
  buildDocx: buildDocx,
  buildPdf: buildPdf,
  /* низкоуровневые — для тестов */
  parseTtf: parseTtf,
  shotStamp: shotStamp
};

})(typeof globalThis !== 'undefined' ? globalThis : this);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.SskCore;
