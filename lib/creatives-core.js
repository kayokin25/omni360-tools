/* ============================================================================
   Сортировка креативов — логика (порт match_creatives.py).
   Зависит от OmniLib.
   ========================================================================== */
(function (root) {
'use strict';

const L = root.OmniLib;

const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.qt', '.3gp',
  '.mpg', '.mpeg', '.wmv', '.flv', '.ts', '.m2ts', '.mts', '.ogv']);
const ARCHIVE_EXTS = new Set(['.zip']);
const UNSUPPORTED_ARCHIVE_EXTS = new Set(['.rar', '.7z', '.tar', '.gz', '.tgz']);

/* Сколько распакованных байт держим для поиска размеров видео.
   moov лежит либо в начале (faststart), либо в самом конце файла. */
const HEAD_CAP = 1 << 20;
const TAIL_CAP = 1 << 20;

/* Вложенный zip, лежащий без сжатия, читаем «окном» — без копии в память. */
const NESTED_MATERIALIZE_LIMIT = 384 * 1024 * 1024;

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

function baseName(p) {
  const parts = String(p).split(/[/\\]/);
  return parts[parts.length - 1];
}

function isRuss(operator) {
  return String(operator === null || operator === undefined ? '' : operator)
    .toLowerCase().replace(/ /g, '').indexOf('russ') >= 0;
}

function normGid(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  return String(v).trim();
}

/* Источник-«окно» поверх другого источника (для вложенных STORED-архивов). */
function subSource(source, offset, length, name) {
  return {
    size: length,
    name: name || '',
    slice: function (start, end) {
      const s = Math.max(0, start), e = Math.min(length, end);
      if (e <= s) return Promise.resolve(new Uint8Array(0));
      return source.slice(offset + s, offset + e);
    }
  };
}

/* Ключ группировки — «оператор + ширина + высота». NUL как разделитель:
   в названии оператора его быть не может, значит склейки не будет. */
const KEY_SEP = '\u0000';

/* ─────────────────────── чтение адресной программы ─────────────────────── */

function loadAp(workbook) {
  const sheets = workbook.sheets;

  // Лист длительностей: шапка GID / Длительность
  let durSheet = null;
  for (const ws of sheets) {
    const r1 = ws.rows[0] || [];
    const h1 = L.cellStr(r1[0]).toLowerCase();
    const h2 = L.cellStr(r1[1]).toLowerCase();
    if (h1.indexOf('gid') >= 0 && (h2.indexOf('длит') >= 0 || h2.indexOf('dur') >= 0)) {
      durSheet = ws; break;
    }
  }
  if (!durSheet) durSheet = sheets.find(function (s) { return s.name === 'Лист1'; }) || null;

  const durMap = new Map();
  if (durSheet) {
    for (let i = 1; i < durSheet.rows.length; i++) {
      const row = durSheet.rows[i] || [];
      const g = normGid(row[0]);
      if (g) durMap.set(g, row[1] === undefined ? null : row[1]);
    }
  }

  // Лист поверхностей: строка-шапка с «Оператор» и «Разрешение»
  let mainWs = null, headerRow = null;
  const col = {};
  for (const ws of sheets) {
    if (ws === durSheet) continue;
    const maxR = Math.min(ws.rows.length, 30);
    for (let r = 0; r < maxR; r++) {
      const names = new Map();
      const row = ws.rows[r] || [];
      const maxC = Math.min(row.length, 40);
      for (let c = 0; c < maxC; c++) {
        const v = row[c];
        if (v === null || v === undefined) continue;
        names.set(String(v).trim().toLowerCase(), c);
      }
      let hasOp = false, hasRes = false;
      for (const k of names.keys()) {
        if (k.indexOf('оператор') >= 0) hasOp = true;
        if (k.indexOf('разрешение') >= 0) hasRes = true;
      }
      if (hasOp && hasRes) {
        mainWs = ws; headerRow = r;
        for (const [k, c] of names) {
          if (k.indexOf('gid') >= 0 && !('gid' in col)) col.gid = c;
          else if (k.indexOf('оператор') >= 0) col.op = c;
          else if (k.indexOf('разрешение') >= 0) col.res = c;
          else if (k.indexOf('соотношение') >= 0) col.ar = c;
          else if (k === 'ид' || k === 'id') col.id = c;
          else if (k.indexOf('формат экрана') >= 0) col.fmt = c;
          else if (k === 'город') col.city = c;
        }
        break;
      }
    }
    if (mainWs) break;
  }
  if (!mainWs) throw new Error('Не нашёл лист с колонками «Оператор» и «Разрешение».');

  const surfaces = [];
  for (let r = headerRow + 1; r < mainWs.rows.length; r++) {
    const row = mainWs.rows[r] || [];
    const op = row[col.op] === undefined ? null : row[col.op];
    const res = row[col.res] === undefined ? null : row[col.res];
    if ((op === null || op === '') && (res === null || res === '')) continue;
    const wh = L.parseRes(res);
    const gid = 'gid' in col ? normGid(row[col.gid]) : '';
    const arRaw = 'ar' in col ? row[col.ar] : null;
    let ar;
    if (arRaw !== null && arRaw !== undefined && String(arRaw).trim() !== '') ar = String(arRaw).trim();
    else if (wh) { const rr = L.reduceRatio(wh[0], wh[1]); ar = rr[0] + ':' + rr[1]; }
    else ar = '';
    surfaces.push({
      op: op ? String(op).trim() : '',
      resRaw: res ? String(res).trim() : '',
      wh: wh,
      ar: ar,
      gid: gid,
      dur: durMap.has(gid) ? durMap.get(gid) : undefined
    });
  }
  return { surfaces: surfaces, durMap: durMap, sheetName: mainWs.name, headerRow: headerRow + 1 };
}

/* ───────────────────────────── длительности ────────────────────────────── */

function durLabel(raw) {
  if (raw === 5000) return '5 сек';
  if (raw === 10000) return '10 сек';
  if (typeof raw === 'string' && raw.toLowerCase().indexOf('invalid') >= 0) return '5 или 10 сек';
  if (raw === null || raw === undefined) return '—';
  return String(raw);
}

function summarizeDurations(raws) {
  const cnt = new Map();
  for (const r of raws) {
    const k = durLabel(r);
    cnt.set(k, (cnt.get(k) || 0) + 1);
  }
  if (cnt.size === 1) return cnt.keys().next().value;
  const parts = [...cnt.entries()].sort(function (a, b) { return b[1] - a[1]; })
    .map(function (kv) { return kv[0] + ' — ' + kv[1] + ' шт.'; });
  return parts.join('; ');
}

/* ───────────────────────────── сбор креативов ──────────────────────────── */

/* Обходит источник (zip или список файлов), измеряет размеры видео.
   onProgress(done, total, name) — для индикатора. */
async function collectCreatives(input, onProgress) {
  const creatives = [];
  const skippedArchives = [];

  async function scanZip(source, dispPrefix, depth) {
    const zip = await L.zipOpen(source);
    const videos = [];
    const nested = [];
    for (const e of zip.entries) {
      if (e.isDir) continue;
      const ext = extOf(e.name);
      if (VIDEO_EXTS.has(ext)) videos.push(e);
      else if (ARCHIVE_EXTS.has(ext)) nested.push(e);
      else if (UNSUPPORTED_ARCHIVE_EXTS.has(ext)) {
        skippedArchives.push(dispPrefix + e.name + ' (' + ext + ' не поддерживается — распакуй вручную)');
      }
    }

    for (const e of videos) {
      let dims = null;
      try {
        const ht = await L.zipReadHeadTail(zip, e, HEAD_CAP, TAIL_CAP);
        dims = L.dimsFromHeadTail(ht.head, ht.tail, ht.whole);
      } catch (err) { dims = null; }
      creatives.push({
        name: baseName(e.name),
        path: dispPrefix + e.name,
        dims: dims,
        size: e.size,
        read: (function (zz, ee) { return function () { return L.zipRead(zz, ee); }; })(zip, e)
      });
      if (onProgress) onProgress(creatives.length, null, baseName(e.name));
    }

    if (depth >= 4) {
      for (const e of nested) skippedArchives.push(dispPrefix + e.name + ' (слишком глубокая вложенность)');
      return;
    }
    for (const e of nested) {
      try {
        let inner;
        if (e.method === 0) {
          const start = await (async function () {
            const lh = await source.slice(e.localOff, e.localOff + 30);
            return e.localOff + 30 + (lh[26] | (lh[27] << 8)) + (lh[28] | (lh[29] << 8));
          })();
          inner = subSource(source, start, e.size, e.name);
        } else if (e.size <= NESTED_MATERIALIZE_LIMIT) {
          inner = L.bytesSource(await L.zipRead(zip, e), e.name);
        } else {
          skippedArchives.push(dispPrefix + e.name + ' (вложенный архив слишком большой — распакуй вручную)');
          continue;
        }
        await scanZip(inner, dispPrefix + e.name + ' :: ', depth + 1);
      } catch (err) {
        skippedArchives.push(dispPrefix + e.name + ' (повреждён zip)');
      }
    }
  }

  if (input.kind === 'zip') {
    await scanZip(input.source, '', 0);
  } else {
    // список выбранных файлов/папки (webkitdirectory)
    for (const f of input.files) {
      const relPath = f.webkitRelativePath || f.name;
      const ext = extOf(f.name);
      if (VIDEO_EXTS.has(ext)) {
        const src = L.blobSource(f);
        let dims = null;
        try {
          let head, tail, whole;
          if (f.size <= HEAD_CAP + TAIL_CAP) {
            head = await src.slice(0, f.size); tail = head; whole = true;
          } else {
            head = await src.slice(0, HEAD_CAP);
            tail = await src.slice(f.size - TAIL_CAP, f.size);
            whole = false;
          }
          dims = L.dimsFromHeadTail(head, tail, whole);
        } catch (err) { dims = null; }
        creatives.push({
          name: baseName(f.name),
          path: relPath,
          dims: dims,
          size: f.size,
          read: (function (ff) { return async function () { return new Uint8Array(await ff.arrayBuffer()); }; })(f),
          blob: f
        });
        if (onProgress) onProgress(creatives.length, input.files.length, f.name);
      } else if (ARCHIVE_EXTS.has(ext)) {
        try {
          await scanZip(L.blobSource(f), relPath + ' :: ', 0);
        } catch (err) {
          skippedArchives.push(f.name + ' (повреждён zip)');
        }
      } else if (UNSUPPORTED_ARCHIVE_EXTS.has(ext)) {
        skippedArchives.push(f.name + ' (' + ext + ' не поддерживается — распакуй вручную)');
      }
    }
  }

  return { creatives: creatives, skippedArchives: skippedArchives };
}

/* ─────────────────────────────── подбор ────────────────────────────────── */

function buildTargets(surfaces) {
  const groups = new Map();
  const skipped = [];
  for (const s of surfaces) {
    if (!s.wh) { skipped.push(s); continue; }
    const key = s.op + KEY_SEP + s.wh[0] + KEY_SEP + s.wh[1];
    let g = groups.get(key);
    if (!g) {
      g = { op: s.op, w: s.wh[0], h: s.wh[1], ar: s.ar, count: 0, durs: [], gids: [] };
      groups.set(key, g);
    }
    g.count++;
    g.durs.push(s.dur);
    g.gids.push(s.gid);
  }
  return { targets: groups, skipped: skipped };
}

/* Подбор креатива под каждую связку «оператор + размер экрана».

   Правило для всех операторов, кроме Russ Outdoor (у него — только точный
   размер, см. ниже): внутри одного соотношения сторон берётся ОДИН, самый
   большой доступный файл — он покрывает все экраны этого соотношения
   размером не больше себя, поэтому держать вместе с ним ещё и средние, и
   мелкие смысла нет (в реальном процессе загрузки это лишний файл и лишний
   клик — экран с любым подходящим размером просто отмечают галочкой и
   отправляют туда тот же самый крео). Раньше подбирался ближайший по
   размеру файл КАЖДОМУ экрану отдельно — отсюда много разных файлов на одно
   и то же соотношение сторон в отчёте.

   Поскольку все файлы в группе имеют одно и то же (приведённое) соотношение
   сторон, сравнение по площади равносильно сравнению по любой стороне —
   больший файл всегда покрывает всё, что покрывает меньший, сравнивать их
   можно одним числом. */
function match(targets, creatives) {
  const cand = creatives.filter(function (c) { return c.dims; });
  const unknown = creatives.filter(function (c) { return !c.dims; });

  // Дедупликация по размеру: один представитель на (w,h), детерминированно —
  // чтобы один размер закрывался ОДНИМ файлом (как в match_creatives.py).
  const byDim = new Map();
  for (const c of cand) {
    const k = c.dims[0] + 'x' + c.dims[1];
    const cur = byDim.get(k);
    if (!cur || c.size < cur.size || (c.size === cur.size && c.name < cur.name)) byDim.set(k, c);
  }
  const reps = [...byDim.values()];

  // самый большой представитель на каждое соотношение сторон
  const biggestByAR = new Map();
  for (const c of reps) {
    const cr = L.reduceRatio(c.dims[0], c.dims[1]);
    const key = cr[0] + ':' + cr[1];
    const cur = biggestByAR.get(key);
    const area = c.dims[0] * c.dims[1];
    if (!cur) { biggestByAR.set(key, c); continue; }
    const curArea = cur.dims[0] * cur.dims[1];
    if (area > curArea || (area === curArea && c.name < cur.name)) biggestByAR.set(key, c);
  }

  for (const t of targets.values()) {
    const w = t.w, h = t.h;
    const tr = L.reduceRatio(w, h);
    let best = null;
    if (isRuss(t.op)) {
      best = byDim.get(w + 'x' + h) || null;      // строго точный размер, без исключений
      t.rule = 'точное совпадение (Russ Outdoor)';
    } else {
      const candAr = biggestByAR.get(tr[0] + ':' + tr[1]) || null;
      if (candAr && candAr.dims[0] >= w && candAr.dims[1] >= h) best = candAr;
      t.rule = 'тот же AR, самый большой доступный файл этого соотношения';
    }
    t.match = best;
    if (best) {
      t.downscale = (best.dims[0] > w || best.dims[1] > h);
      t.exact = (best.dims[0] === w && best.dims[1] === h);
    }
  }
  return unknown;
}

/* ───────────────────────────── отчёт (xlsx) ────────────────────────────── */

function buildReport(targets, unknown, creatives, skippedArchives) {
  const all = [...targets.values()];
  const used = all.filter(function (t) { return t.match; });
  const missing = all.filter(function (t) { return !t.match; });
  // Сортировка «Отправка» — по файлу, а не по оператору: один файл теперь
  // обычно закрывает сразу нескольких операторов, и в отчёте они должны
  // идти подряд — это ровно тот список, по которому отмечают галочки и
  // грузят один файл разом.
  used.sort(function (a, b) {
    if (a.match.name !== b.match.name) return a.match.name < b.match.name ? -1 : 1;
    if (a.op !== b.op) return a.op < b.op ? -1 : 1;
    return b.count - a.count;
  });
  missing.sort(function (a, b) {
    if (a.op !== b.op) return a.op < b.op ? -1 : 1;
    return b.count - a.count;
  });

  // ── Отправка ──
  // Раскрывающийся список: заголовок группы — сам файл креатива (разрешение,
  // AR, длительность), а под ним — настоящая группировка строк Excel (те
  // самые [+]/[-] слева) с операторами, которым этот файл подходит. Если у
  // оператора несколько экранов ОДНОГО и того же соотношения сторон (внутри
  // одного файла оно всегда одно — иначе файл был бы другим), их разрешения
  // сведены в одну строку через запятую: именно так их отмечают галочками и
  // грузят одним разом.
  const s1 = {
    name: 'Отправка',
    cols: [34, 30, 10, 26],
    outlineSummaryAbove: true,
    rows: [['Креатив / Оператор', 'Разрешение', 'AR', 'Длительность']]
  };
  const fileGroups = [];
  let curFile = null, curOp = null;
  for (const t of used) {
    if (!curFile || curFile.name !== t.match.name) {
      curFile = { name: t.match.name, dims: t.match.dims, durs: [], ops: [] };
      fileGroups.push(curFile);
      curOp = null;
    }
    curFile.durs.push.apply(curFile.durs, t.durs);
    if (!curOp || curOp.op !== t.op) {
      curOp = { op: t.op, res: new Map(), durs: [] };
      curFile.ops.push(curOp);
    }
    curOp.res.set(t.w + 'x' + t.h, t.w * t.h);
    curOp.durs.push.apply(curOp.durs, t.durs);
  }
  for (const fg of fileGroups) {
    if (s1.rows.length > 1) s1.rows.push([]); // разделитель между группами — разные файлы
    const cw = fg.dims[0], ch = fg.dims[1];
    const rr = L.reduceRatio(cw, ch);
    const ar = rr[0] + ':' + rr[1];
    s1.rows.push({
      cells: [
        { v: fg.name, s: L.S.GROUP }, { v: cw + 'x' + ch, s: L.S.GROUP },
        { v: ar, s: L.S.GROUP }, { v: summarizeDurations(fg.durs), s: L.S.GROUP }
      ]
    });
    for (const op of fg.ops) {
      const resStr = [...op.res.entries()].sort(function (a, b) { return b[1] - a[1]; })
        .map(function (e) { return e[0]; }).join(', ');
      s1.rows.push({
        outlineLevel: 1,
        cells: [
          { v: op.op, s: L.S.BODY }, { v: resStr, s: L.S.BODY },
          { v: ar, s: L.S.BODY }, { v: summarizeDurations(op.durs), s: L.S.BODY }
        ]
      });
    }
  }

  // ── Не хватает ──
  const s2 = {
    name: 'Не хватает',
    cols: [22, 13, 8, 9, 24, 26, 30],
    rows: [['Оператор', 'Размер экрана', 'AR', 'Кол-во ФО', 'Длительность',
            'Правило подбора', 'Что нужно']]
  };
  for (const t of missing) {
    const need = isRuss(t.op)
      ? 'видео ровно ' + t.w + 'x' + t.h
      : 'видео ' + t.ar + ' с размером ≥ ' + t.w + 'x' + t.h;
    const row = [t.op, t.w + 'x' + t.h, t.ar, t.count,
                 summarizeDurations(t.durs), t.rule || '', need];
    s2.rows.push(row.map(function (v) { return { v: v, s: L.S.WARN }; }));
  }

  // ── Лишние видео ──
  const usedNames = new Set(used.map(function (t) { return t.match.name; }));
  // Тот же расчёт, что в match(), но по ВСЕМ creatives (не только по тем,
  // что реально нашли свою связку) — нужен, чтобы объяснить, почему именно
  // не взяли каждый конкретный лишний файл: он дубль по точному размеру или
  // просто меньше уже выбранного файла того же соотношения.
  const byDimAll = new Map();
  const biggestByArAll = new Map();
  for (const c of creatives) {
    if (!c.dims) continue;
    const dk = c.dims[0] + 'x' + c.dims[1];
    const curDim = byDimAll.get(dk);
    if (!curDim || c.size < curDim.size || (c.size === curDim.size && c.name < curDim.name)) byDimAll.set(dk, c);
    const cr = L.reduceRatio(c.dims[0], c.dims[1]);
    const ak = cr[0] + ':' + cr[1];
    const curAr = biggestByArAll.get(ak);
    const area = c.dims[0] * c.dims[1];
    if (!curAr) { biggestByArAll.set(ak, c); continue; }
    const curArea = curAr.dims[0] * curAr.dims[1];
    if (area > curArea || (area === curArea && c.name < curAr.name)) biggestByArAll.set(ak, c);
  }

  const s3 = {
    name: 'Лишние видео',
    cols: [34, 13, 8, 60],
    rows: [['Файл', 'Размер видео', 'AR', 'Комментарий']]
  };
  const sorted = creatives.slice().sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
  for (const c of sorted) {
    if (usedNames.has(c.name)) continue;
    if (c.dims) {
      const rr = L.reduceRatio(c.dims[0], c.dims[1]);
      const dk = c.dims[0] + 'x' + c.dims[1];
      const ak = rr[0] + ':' + rr[1];
      const sameDim = byDimAll.get(dk);
      const winner = biggestByArAll.get(ak);
      let comment;
      if (sameDim && sameDim.name !== c.name) {
        comment = 'дубль по размеру — этот размер уже закрыт другим файлом';
      } else if (winner && winner.name !== c.name) {
        comment = 'меньше самого большого файла этого соотношения (' + winner.dims[0] + 'x' + winner.dims[1] +
          ') — по правилу «один файл на соотношение» используется он';
      } else {
        comment = 'не подошёл ни к одной поверхности (нет такого размера/AR в АП)';
      }
      s3.rows.push([c.name, dk, ak, comment]);
    } else {
      s3.rows.push([c.name, '—', '—', 'НЕ УДАЛОСЬ прочитать размер — проверь файл вручную']);
    }
  }

  // ── Сводка ──
  const keepFiles = new Set(used.map(function (t) { return t.match.name; })).size;
  const s4 = {
    name: 'Сводка',
    cols: [42, 14],
    rows: [
      ['Показатель', 'Значение'],
      ['Всего связок оператор × размер экрана', all.length],
      ['Закрыто креативами', used.length],
      ['Не хватает креативов', missing.length],
      ['Уникальных видеофайлов в архив', keepFiles],
      ['Видеофайлов найдено всего', creatives.length],
      ['Видео с нечитаемым размером', unknown.length]
    ]
  };
  if (skippedArchives && skippedArchives.length) {
    s4.rows.push(['', '']);
    s4.rows.push(['⚠ Пропущенные вложенные архивы:', skippedArchives.length]);
    for (const s of skippedArchives) s4.rows.push([s, '']);
  }

  return {
    sheets: [s1, s2, s3, s4],
    stats: {
      targets: all.length, used: used.length, missing: missing.length,
      keep: keepFiles, creatives: creatives.length, unknown: unknown.length
    },
    usedTargets: used, missingTargets: missing
  };
}

/* Собирает архив только с нужными видео (без дублей по имени). */
async function buildZip(targets, onProgress) {
  const keep = new Map();
  for (const t of targets.values()) if (t.match) keep.set(t.match.name, t.match);

  const files = [];
  const taken = new Set();
  let i = 0;
  for (const [name, cre] of keep) {
    let arcname = name;
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let n = 2;
    while (taken.has(arcname)) { arcname = base + '_' + n + ext; n++; }
    taken.add(arcname);

    const bytes = await cre.read();
    files.push({ name: arcname, bytes: bytes, size: bytes.length, crc: L.crc32(bytes) });
    i++;
    if (onProgress) onProgress(i, keep.size, arcname);
  }
  return { blob: L.zipWrite(files), count: keep.size };
}

root.CreativesCore = {
  loadAp: loadAp,
  collectCreatives: collectCreatives,
  buildTargets: buildTargets,
  match: match,
  buildReport: buildReport,
  buildZip: buildZip,
  summarizeDurations: summarizeDurations,
  durLabel: durLabel,
  isRuss: isRuss,
  VIDEO_EXTS: VIDEO_EXTS
};

})(typeof globalThis !== 'undefined' ? globalThis : this);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.CreativesCore;
