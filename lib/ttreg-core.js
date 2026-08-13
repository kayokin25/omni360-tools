/* ============================================================================
   Технические требования по адресной программе — логика.

   Раньше инструмент отдавал ссылку на файл ТТ и длительность ролика: сами
   требования лежали на Диске картинкой, и в отчёте их не было. Теперь источник
   требований — реестр ТТ операторов (xlsx, листы «Операторы», «ТТ по
   конструкциям», «Форматы в системе», «Отраслевой дефолт»), поэтому в отчёт
   попадают конкретные значения.

   Два листа на выходе, и это главное решение по отображению:

     «Задание на макеты» — 1 строка = 1 уникальный макет (разрешение ×
        длительность). В строке сведены требования всех операторов, которым
        этот макет нужен: пересечение форматов файлов, самое строгое из
        ограничений веса и битрейта, плюс отдельные колонки под конфликты и
        замечания. Именно это отдаётся клиенту в производство.

     «Карточки операторов» — вертикальная раскладка «Блок | Параметр |
        Значение» по блокам A–G, свёрнутая в раскрывающиеся группы. 42 колонки
        реестра в ширину читать невозможно, а карточку — можно.

   Зависит от OmniLib и TTCore (чтение АП и длительность как запасной путь).
   ========================================================================== */
(function (root) {
'use strict';

const L = root.OmniLib;
const TT = root.TTCore;

const norm = L.normName;

/* Ключ Map «оператор + что-нибудь». Склеиваем через NUL — такого символа нет
   ни в названиях операторов, ни в разрешениях, поэтому разные пары не могут
   дать одинаковый ключ. */
const KEY_SEP = '\u0000';

/* Реестр раздаётся статикой из dist/data — как инвентарь для азимутов.
   Имя латиницей намеренно: русское имя в URL пришлось бы кодировать, и любая
   разница в нормализации между Netlify и браузером ломала бы загрузку. */
const REGISTRY_URL = '/data/tt_registry.xlsx';

/* ────────────────────────────── чтение реестра ─────────────────────────── */

const SHEET = {
  ABOUT: 'О файле',
  OPERATORS: 'Операторы',
  CONSTRUCTIONS: 'ТТ по конструкциям',
  FORMATS: 'Форматы в системе',
  DEFAULTS: 'Отраслевой дефолт'
};

/* Параметры, отсутствие которых делает ТТ непригодными для производства.
   Список — тот же, что на листе «Пробелы и задачи» в колонке «Чего не
   хватает»: считаем его сами по пустым ячейкам, чтобы единственным
   источником правды остался лист «Операторы». */
const CRITICAL_PARAMS = ['Разрешения, указанные в ТТ', 'Форматы видео', 'Кодек',
  'Частота кадров', 'Битрейт', 'Макс. вес файла', 'Хронометраж, сек'];

/* Названия параметров на листе «Отраслевой дефолт» короче, чем колонки листа
   «Операторы» («Мин. высота текста» против «Мин. размер текста»). Держим
   соответствие явно: молча не совпавший дефолт хуже отсутствующего.
   «Соотношение сторон / ориентация» в списке нет намеренно — отдельной
   колонки под него на листе «Операторы» тоже нет. */
const DEFAULT_TO_PARAM = {
  'Разрешение макета': 'Разрешения, указанные в ТТ',
  'Формат видео': 'Форматы видео',
  'Кодек': 'Кодек',
  'Частота кадров': 'Частота кадров',
  'Битрейт': 'Битрейт',
  'Развёртка / пиксели': 'Развёртка',
  'Звук': 'Звук',
  'Макс. вес файла': 'Макс. вес файла',
  'Хронометраж': 'Хронометраж, сек',
  'Форматы статики': 'Форматы статики',
  'Ограничение белого': 'Ограничение белого',
  'Мин. высота текста': 'Мин. размер текста',
  'Шрифт': 'Требования к шрифту',
  'Дисклеймер': 'Дисклеймер',
  'Знак возрастного ценза': 'Знак возрастного ценза',
  'Запреты': 'Запреты',
  'Юр. требования': 'Юр. требования'
};

function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  return isFinite(n) ? n : 0;
}

function sheetByName(workbook, name) {
  for (const s of workbook.sheets) if (s.name === name) return s;
  return null;
}

/* Строка шапки — первая, где есть все обязательные заголовки. Ищем, а не
   берём по номеру: на листе «Операторы» над шапкой ещё строка с подписями
   блоков, и она вполне может уехать. */
function findHeaderRow(rows, must) {
  const n = Math.min(rows.length, 20);
  for (let i = 0; i < n; i++) {
    const cells = new Set((rows[i] || []).map(L.cellStr));
    let ok = true;
    for (const m of must) if (!cells.has(m)) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

function colMap(header) {
  const colOf = {};
  header.forEach(function (name, i) { if (name && !(name in colOf)) colOf[name] = i; });
  return colOf;
}

/* Хвост листа «Операторы» — не требования, а служебные поля: они стоят после
   подписи блока G, и без явного списка блок G забирал бы их себе. В карточке
   они выводятся отдельно, в блоке «Справка». */
const META_COLUMNS = new Set(['Расхождение с инвентарём', 'Источник ТТ', 'Примечание']);

/* Блоки A–G берём из строки над шапкой: подписи там стоят в первой колонке
   каждого блока. Так добавленная в реестр колонка попадёт в свой блок сама,
   без правки кода. Колонки до первой подписи — шапка оператора (ID, Экранов,
   Статус ТТ и прочее), в блоки они не идут. */
function readBlocks(labelRow, header) {
  const blocks = [];
  let cur = null;
  for (let i = 0; i < header.length; i++) {
    const label = L.cellStr(labelRow[i]);
    if (label) { cur = { title: label, params: [] }; blocks.push(cur); }
    const name = header[i];
    if (name && cur && !META_COLUMNS.has(name)) cur.params.push(name);
  }
  return blocks;
}

function readOperators(sheet) {
  const idx = findHeaderRow(sheet.rows, ['ID', 'Оператор', 'Статус ТТ']);
  if (idx < 0) {
    throw new Error('лист «' + SHEET.OPERATORS + '»: не нашёл строку шапки ' +
      '(нужны колонки ID, Оператор, Статус ТТ)');
  }
  const header = (sheet.rows[idx] || []).map(L.cellStr);
  const blocks = readBlocks(idx > 0 ? (sheet.rows[idx - 1] || []) : [], header);
  const colOf = colMap(header);
  const get = function (row, name) { return name in colOf ? L.cellStr(row[colOf[name]]) : ''; };

  const operators = [];
  for (let r = idx + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] || [];
    const name = get(row, 'Оператор');
    if (!name) continue;

    const params = {};
    for (const b of blocks) {
      for (const p of b.params) {
        const v = get(row, p);
        if (v) params[p] = v;
      }
    }

    const missing = CRITICAL_PARAMS.filter(function (p) { return !params[p]; });

    operators.push({
      id: get(row, 'ID'),
      name: name,
      norm: norm(name),
      screens: num(get(row, 'Экранов')),
      placement: get(row, 'Размещение'),
      cities: get(row, 'Города (топ-3)'),
      resInSystem: get(row, 'Разрешения в системе (топ-5)'),
      slots: get(row, 'Доступные слоты, сек (по инвентарю)'),
      status: get(row, 'Статус ТТ'),
      params: params,
      missing: missing,
      mismatch: get(row, 'Расхождение с инвентарём'),
      source: get(row, 'Источник ТТ'),
      note: get(row, 'Примечание')
    });
  }
  return { blocks: blocks, operators: operators };
}

function readConstructions(sheet) {
  if (!sheet) return new Map();
  const idx = findHeaderRow(sheet.rows, ['Оператор', 'Формат / конструкция']);
  if (idx < 0) return new Map();
  const colOf = colMap((sheet.rows[idx] || []).map(L.cellStr));
  const get = function (row, name) { return name in colOf ? L.cellStr(row[colOf[name]]) : ''; };

  const byOp = new Map();
  for (let r = idx + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] || [];
    const op = get(row, 'Оператор');
    if (!op) continue;
    const item = {
      operator: op,
      format: get(row, 'Формат / конструкция'),
      where: get(row, 'Адрес или город'),
      size: get(row, 'Физический размер'),
      res: get(row, 'Разрешение, px'),
      aspect: get(row, 'Соотношение'),
      video: get(row, 'Видео'),
      weight: get(row, 'Вес / битрейт'),
      other: get(row, 'Прочее')
    };
    const k = norm(op);
    if (!byOp.has(k)) byOp.set(k, []);
    byOp.get(k).push(item);
  }
  return byOp;
}

/* Лист «Форматы в системе» — факт из инвентаря: какие разрешения реально есть
   у оператора и какие длительности слотов на них доступны. Нужен, чтобы
   проверить длительность из АП, а не поверить ей на слово. */
function readFormats(sheet) {
  const byOpRes = new Map();
  if (!sheet) return byOpRes;
  const idx = findHeaderRow(sheet.rows, ['Оператор', 'Разрешение, px']);
  if (idx < 0) return byOpRes;
  const colOf = colMap((sheet.rows[idx] || []).map(L.cellStr));
  const get = function (row, name) { return name in colOf ? L.cellStr(row[colOf[name]]) : ''; };

  for (let r = idx + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] || [];
    const op = get(row, 'Оператор');
    const res = L.normRes(get(row, 'Разрешение, px'));
    if (!op || !res) continue;
    byOpRes.set(norm(op) + KEY_SEP + res, {
      slots: get(row, 'Доступные слоты, сек'),
      aspect: get(row, 'Соотношение'),
      screens: num(get(row, 'Экранов')),
      physical: get(row, 'Физический размер поверхности, мм')
    });
  }
  return byOpRes;
}

function readDefaults(sheet, warnings, knownParams) {
  const out = { list: [], byParam: {}, caveat: '' };
  const list = out.list, byParam = out.byParam;
  if (!sheet) return out;
  const idx = findHeaderRow(sheet.rows, ['Параметр']);
  if (idx < 0) return out;
  const colOf = colMap((sheet.rows[idx] || []).map(L.cellStr));
  const vCol = 'Безопасное значение по умолчанию' in colOf
    ? colOf['Безопасное значение по умолчанию'] : 1;

  for (let r = idx + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] || [];
    const key = L.cellStr(row[colOf['Параметр']]);
    const value = L.cellStr(row[vCol]);
    if (!key || !value) continue;
    /* «ВАЖНО» на этом листе — не параметр, а оговорка про то, что дефолт
       нельзя подавать как требование оператора. Показываем её отдельно. */
    if (key === 'ВАЖНО') { out.caveat = value; continue; }
    const param = DEFAULT_TO_PARAM[key];
    if (!param) { list.push({ key: key, param: null, value: value }); continue; }
    if (knownParams && !knownParams.has(param)) {
      warnings.push('отраслевой дефолт «' + key + '» ссылается на параметр «' + param +
        '», которого нет среди колонок листа «' + SHEET.OPERATORS + '»');
    }
    list.push({ key: key, param: param, value: value });
    byParam[param] = value;
  }
  return out;
}

function readAbout(sheet) {
  const about = { builtAt: '', inventory: '' };
  if (!sheet) return about;
  for (const row of sheet.rows) {
    const k = L.cellStr((row || [])[0]);
    const v = L.cellStr((row || [])[1]);
    if (k === 'Дата сборки') about.builtAt = v;
    if (k === 'Источник инвентаря') about.inventory = v;
  }
  return about;
}

function readRegistry(workbook) {
  const opsSheet = sheetByName(workbook, SHEET.OPERATORS);
  if (!opsSheet) {
    throw new Error('в файле нет листа «' + SHEET.OPERATORS + '» — это не реестр ТТ. ' +
      'Листы в файле: ' + workbook.sheets.map(function (s) { return s.name; }).join(', '));
  }

  const warnings = [];
  const parsed = readOperators(opsSheet);

  const knownParams = new Set();
  for (const b of parsed.blocks) for (const p of b.params) knownParams.add(p);

  const byNorm = new Map(), byId = new Map();
  for (const op of parsed.operators) {
    /* Тёзок в реестре быть не должно: он построен по операторам системы, где
       имя уникально. Если два — молча потерять второго нельзя. */
    if (byNorm.has(op.norm)) warnings.push('в реестре два оператора с одним именем: ' + op.name);
    else byNorm.set(op.norm, op);
    if (op.id) byId.set(String(op.id), op);
  }

  const defaults = readDefaults(sheetByName(workbook, SHEET.DEFAULTS), warnings, knownParams);

  return {
    about: readAbout(sheetByName(workbook, SHEET.ABOUT)),
    blocks: parsed.blocks,
    operators: parsed.operators,
    byNorm: byNorm,
    byId: byId,
    constructions: readConstructions(sheetByName(workbook, SHEET.CONSTRUCTIONS)),
    formats: readFormats(sheetByName(workbook, SHEET.FORMATS)),
    defaults: defaults.list,
    defaultsByParam: defaults.byParam,
    defaultsCaveat: defaults.caveat,
    warnings: warnings
  };
}

/* ────────────────────────── разбор значений из ТТ ──────────────────────── */

/* Синонимы форматов и кодеков. Ключ — normName от подписи: пунктуация там
   уже превращена в пробелы, поэтому «H.264 / AVC» и «H264» сходятся в один
   ключ. Без этого пересечение форматов у двух операторов пустело на разном
   написании одного и того же. */
const TOKEN_SYNONYMS = {
  'mp4': 'MP4', 'mpeg 4': 'MP4', 'mpeg4': 'MP4', 'mp4 mpeg 4': 'MP4',
  'h 264 avc': 'H.264/AVC', 'h 264': 'H.264/AVC', 'h264': 'H.264/AVC', 'avc': 'H.264/AVC',
  'h 265': 'H.265/HEVC', 'hevc': 'H.265/HEVC',
  'mov': 'MOV', 'mkv': 'MKV', 'avi': 'AVI',
  'jpeg': 'JPEG', 'jpg': 'JPEG', 'jpeg jpg': 'JPEG',
  'png': 'PNG', 'gif': 'GIF', 'tga': 'TGA', 'tif': 'TIFF', 'tiff': 'TIFF', 'bmp': 'BMP',
  'apple prores': 'Apple ProRes', 'prores': 'Apple ProRes',
  'uncompressed': 'Uncompressed', 'uncompressed без сжатия': 'Uncompressed',
  'без сжатия': 'Uncompressed',
  'rgb': 'RGB', 'cmyk': 'CMYK', 'srgb': 'sRGB'
};

/* Значение вида «MP4, MPEG-4 (MOV тоже)» → ['MP4'].
   Делим только по запятой и точке с запятой: «H.264 / AVC» — один кодек,
   записанный двумя именами, и делить его по «/» нельзя. Скобки срезаем до
   деления — внутри них у операторов встречается своя точка с запятой. */
function tokens(value) {
  const parens = [];
  const flat = String(value).replace(/\([^()]*\)/g, function (m) {
    parens.push(m.slice(1, -1).trim());
    return ' ';
  });
  const out = [];
  for (const part of flat.split(/[,;]/)) {
    const t = part.trim().replace(/\s+/g, ' ');
    if (!t) continue;
    const key = norm(t);
    if (Object.prototype.hasOwnProperty.call(TOKEN_SYNONYMS, key)) {
      out.push(TOKEN_SYNONYMS[key]);
      continue;
    }
    /* Незнакомую подпись пропускаем, только если она похожа на название
       формата: начинается с буквы, короткая, без цифр в начале. Иначе в
       пересечение попадают куски прозы вроде «75–92 dpi». */
    if (!/^[A-Za-z][A-Za-z0-9.\-/ ]{0,20}$/.test(t)) continue;
    if (t.split(' ').length > 3) continue;
    out.push(t);
  }
  /* Оговорка в скобках на два слова — обычно просто второе имя формата
     («MP4 (MPEG-4)»), а вот фраза длиннее — уже исключение по конструкции,
     и его нельзя терять при сведении. */
  const caveat = parens.some(function (p) { return p.split(/\s+/).length > 2; });
  return { list: uniq(out), caveat: caveat };
}

function uniq(arr) {
  const seen = new Set(), out = [];
  for (const v of arr) if (!seen.has(v)) { seen.add(v); out.push(v); }
  return out;
}

/* «не более 10 МБ» → 10. «по формату: 1 МБ (ситиформат), 2 МБ …, 100 МБ» → 1:
   макет на 1 МБ проходит всюду, поэтому из перечисления берём минимум.
   Отрицательный просмотр после «Мб» обязателен — иначе «3 Мбит/с» прочитается
   как 3 мегабайта. */
const MB_RE = /(\d+(?:[.,]\d+)?)\s*(?:мбайт|мб|mb)(?!ит|it|ps|\/)/gi;
const BITRATE_RE = /(\d+(?:[.,]\d+)?)\s*(?:[–—-]\s*(\d+(?:[.,]\d+)?)\s*)?(кбит|kbps|kbit|мбит|mbit|mbps|mb\s*\/\s*s)/gi;

function parseMb(value) {
  const out = [];
  let m;
  MB_RE.lastIndex = 0;
  while ((m = MB_RE.exec(value))) out.push(parseFloat(String(m[1]).replace(',', '.')));
  return out.length ? Math.min.apply(null, out) : null;
}

/* Битрейт приводим к Мбит/с. Из диапазона «10–20 Мбит» берём нижнюю границу:
   это то, что гарантированно принимают все. */
function parseMbps(value) {
  const out = [];
  let m;
  BITRATE_RE.lastIndex = 0;
  while ((m = BITRATE_RE.exec(value))) {
    const lo = parseFloat(String(m[1]).replace(',', '.'));
    if (!isFinite(lo)) continue;
    const kilo = /кбит|kbps|kbit/i.test(m[3]);
    out.push(kilo ? lo / 1000 : lo);
  }
  return out.length ? Math.min.apply(null, out) : null;
}

/* Разрешения, которые оператор перечислил в ТТ. Требуем минимум две цифры
   с каждой стороны: иначе «6х3 → 1440x720» дало бы фантомное «6x3», а
   физический размер «10,56x5,76» — «56x5». */
function ttResolutions(value) {
  const out = new Set();
  const re = /(\d{2,5})\s*[xхXХ×*]\s*(\d{2,5})/g;
  let m;
  while ((m = re.exec(String(value)))) out.add(parseInt(m[1], 10) + 'x' + parseInt(m[2], 10));
  return out;
}

function parseSeconds(value) {
  const out = new Set();
  const re = /(\d{1,4})/g;
  let m;
  while ((m = re.exec(String(value)))) out.add(parseInt(m[1], 10));
  return out;
}

function fmtNum(n) {
  const s = Math.round(n * 1000) / 1000;
  return String(s).replace('.', ',');
}

/* ─────────────────────── сведение требований по макету ─────────────────── */

/* Как сводить каждый параметр в строку «Задания на макеты».
     set     — пересечение перечислений (что примут все операторы разом)
     minMb   — минимум из ограничений веса
     minMbps — минимум из ограничений битрейта
     fps     — точное совпадение, иначе конфликт
     list    — перечисление значений с указанием операторов
   Числовое сведение только там, где направление однозначно: и вес, и битрейт
   задаются как «не более», поэтому минимум безопасен. «Мин. размер текста» и
   «Дисклеймер» сведены как list намеренно — в них числа вперемешку с прозой
   («не менее 9 px (для текста высотой до 13 px…)»), и любой автоматический
   максимум был бы выдумкой. */
const TASK_PARAMS = [
  { col: 'Формат видео', param: 'Форматы видео', merge: 'set', w: 15 },
  { col: 'Кодек', param: 'Кодек', merge: 'set', w: 15 },
  { col: 'FPS', param: 'Частота кадров', merge: 'fps', w: 10 },
  { col: 'Битрейт, Мбит/с ≤', param: 'Битрейт', merge: 'minMbps', w: 18 },
  { col: 'Вес, МБ ≤', param: 'Макс. вес файла', merge: 'minMb', w: 16 },
  { col: 'Звук', param: 'Звук', merge: 'list', w: 12 },
  { col: 'Хронометраж, сек', param: 'Хронометраж, сек', merge: 'list', w: 16 },
  { col: 'Статика', param: 'Форматы статики', merge: 'set', w: 14 },
  { col: 'Цветовая модель', param: 'Цветовая модель', merge: 'set', w: 14 },
  { col: 'Ограничение белого', param: 'Ограничение белого', merge: 'list', w: 30 },
  { col: 'Мин. размер текста', param: 'Мин. размер текста', merge: 'list', w: 24 },
  { col: 'Дисклеймер', param: 'Дисклеймер', merge: 'list', w: 28 },
  { col: 'Знак ценза', param: 'Знак возрастного ценза', merge: 'list', w: 24 },
  { col: 'Ночное вещание', param: 'Ночное вещание', merge: 'list', w: 30 }
];

const TASK_HEAD = ['№', 'Разрешение', 'Соотношение', 'Длительность, сек',
  'Экранов в АП', 'Операторов', 'Операторы'];
const TASK_TAIL = ['⚠ Конфликты', '⚠ Замечания', 'Допущения'];

const TASK_COLUMNS = TASK_HEAD
  .concat(TASK_PARAMS.map(function (p) { return p.col; }))
  .concat(TASK_TAIL);

/* Собранные по операторам значения одного параметра. assumed — значение взято
   из отраслевого дефолта, а не из ТТ оператора. */
function collect(group, param, reg, useDefaults) {
  const out = [];
  for (const e of group.ops) {
    let value = e.rec ? (e.rec.params[param] || '') : '';
    let assumed = false;
    if (!value && useDefaults && reg.defaultsByParam[param]) {
      value = reg.defaultsByParam[param];
      assumed = true;
    }
    if (value) out.push({ op: e.name, value: value, assumed: assumed });
  }
  return out;
}

function byValue(entries) {
  const map = new Map();
  for (const e of entries) {
    if (!map.has(e.value)) map.set(e.value, []);
    map.get(e.value).push(e.op);
  }
  return map;
}

/* Перечисление «значение (кто так требует)». Больше двух разных значений в
   ячейку не кладём: строка «Задания» должна оставаться читаемой, а подробности
   всё равно лежат в карточках. */
function joinByOperator(entries, limit) {
  const map = byValue(entries);
  if (map.size === 1) return entries[0].value;
  const parts = [];
  let shown = 0, hidden = 0;
  for (const [value, ops] of map) {
    if (shown < (limit || 2)) { parts.push(value + ' (' + ops.join(', ') + ')'); shown++; }
    else hidden++;
  }
  if (hidden) parts.push('ещё ' + hidden + ' — см. карточки операторов');
  return parts.join(' | ');
}

function mergeSet(entries) {
  let inter = null;
  const unclear = [];
  let caveat = false;
  for (const e of entries) {
    const t = tokens(e.value);
    if (t.caveat) caveat = true;
    if (!t.list.length) { unclear.push(e.op); continue; }
    if (inter === null) { inter = new Set(t.list); continue; }
    const prev = inter;
    inter = new Set(t.list.filter(function (x) { return prev.has(x); }));
  }
  if (inter === null) return { value: joinByOperator(entries), conflict: '' };
  if (!inter.size) {
    return { value: joinByOperator(entries), conflict: 'нет ни одного формата, который примут все' };
  }
  let value = [...inter].join(', ');
  if (unclear.length) value += ' · формулировка у ' + unclear.join(', ') + ' — см. карточки';
  else if (caveat) value += ' · есть оговорки по конструкциям — см. карточки';
  return { value: value, conflict: '' };
}

/* 25 fps и «не ниже 30» — требования несовместимые: одним роликом их не
   закрыть, нужны два макета. Поэтому не выбираем «построже», а сообщаем. */
function mergeFps(entries) {
  const map = byValue(entries);
  if (map.size <= 1) return { value: entries.length ? entries[0].value : '', conflict: '' };
  const plain = [...map.keys()].every(function (v) { return /^\s*\d+(\s*fps)?\s*$/i.test(v); });
  const nums = new Set([...map.keys()].map(function (v) { return parseInt(v, 10); }));
  if (plain && nums.size === 1) return { value: String([...nums][0]), conflict: '' };
  return { value: joinByOperator(entries), conflict: 'частота кадров не совпадает у операторов' };
}

function mergeMin(entries, parse, unit) {
  let best = null, bestOp = '';
  const unparsed = [];
  for (const e of entries) {
    const v = parse(e.value);
    if (v === null) { unparsed.push(e.op); continue; }
    if (best === null || v < best) { best = v; bestOp = e.op; }
  }
  if (best === null) return { value: joinByOperator(entries), conflict: '' };
  let value = '≤ ' + fmtNum(best) + ' ' + unit;
  if (byValue(entries).size > 1) value += ' · строже всех ' + bestOp;
  if (unparsed.length) value += ' · формулировка у ' + unparsed.join(', ') + ' — см. карточки';
  return { value: value, conflict: '' };
}

function mergeParam(spec, entries) {
  if (!entries.length) return { value: '', conflict: '' };
  if (spec.merge === 'set') return mergeSet(entries);
  if (spec.merge === 'fps') return mergeFps(entries);
  if (spec.merge === 'minMb') return mergeMin(entries, parseMb, 'МБ');
  if (spec.merge === 'minMbps') return mergeMin(entries, parseMbps, 'Мбит/с');
  return { value: joinByOperator(entries), conflict: '' };
}

/* ──────────────────────────── чтение и разбор АП ───────────────────────── */

const AP_FIELDS = {
  operator: ['Оператор'],
  format: ['Формат экрана', 'Формат'],
  resolution: ['Вид. разрешение', 'Разрешение'],
  aspect: ['Соотношение сторон', 'Соотношение'],
  duration: ['Длительность, сек', 'Длительность', 'Длительность (сек)'],
  city: ['Город'],
  gid: ['GID']
};

/* Строки АП в вид, с которым дальше работаем. Длительность берём из АП: она
   там теперь есть штатной колонкой. Если колонки нет (старые файлы) —
   падаем на справочник связок из tt-core, как было раньше. */
function readAp(table) {
  const rows = [];
  const durationFallback = [];
  const hasDurCol = AP_FIELDS.duration.some(function (n) { return n in table.colOf; });

  for (const row of table.rows) {
    const operator = L.cellStr(getField(table, row, AP_FIELDS.operator));
    if (!operator) continue;
    const format = L.cellStr(getField(table, row, AP_FIELDS.format));
    const resRaw = L.cellStr(getField(table, row, AP_FIELDS.resolution));
    const aspectRaw = L.cellStr(getField(table, row, AP_FIELDS.aspect));

    let duration = '';
    if (hasDurCol) {
      const d = num(getField(table, row, AP_FIELDS.duration));
      if (d > 0) duration = d;
    }
    if (duration === '') {
      const d = TT.lookupDuration(operator, format);
      if (d !== null) { duration = d; durationFallback.push(operator + ' | ' + format); }
    }

    const res = L.normRes(resRaw);
    let aspect = L.normAspect(aspectRaw);
    if (!aspect && res) {
      const wh = L.parseRes(res);
      const r = L.reduceRatio(wh[0], wh[1]);
      aspect = r[0] + ':' + r[1];
    }

    rows.push({
      operator: operator,
      format: format,
      resolution: res || resRaw,
      aspect: aspect || '',
      duration: duration,
      city: L.cellStr(getField(table, row, AP_FIELDS.city)),
      gid: L.cellStr(getField(table, row, AP_FIELDS.gid))
    });
  }
  return { rows: rows, hasDurationColumn: hasDurCol, durationFallback: uniq(durationFallback) };
}

function getField(table, row, names) {
  for (const n of names) {
    if (n in table.colOf) {
      const v = row[table.colOf[n]];
      if (v !== null && v !== undefined && v !== '') return v;
    }
  }
  return '';
}

/* Оператор из АП → запись реестра. Оба имени приходят из Omniboard, поэтому
   обычно сходятся напрямую; алиасы из tt-data.js оставлены вторым заходом для
   файлов, где имя записано по-своему. */
function matchOperator(reg, apName) {
  const n = norm(apName);
  if (reg.byNorm.has(n)) return reg.byNorm.get(n);
  if (TT && TT.operatorToken) {
    const alias = TT.operatorToken(apName);
    if (alias !== n && reg.byNorm.has(alias)) return reg.byNorm.get(alias);
  }
  return null;
}

/* ──────────────────────── замечания по одному макету ───────────────────── */

/* Что стоит проверить руками до отправки клиенту. Считается по фактам
   реестра, ничего не додумывая: разрешения из ТТ, слоты из инвентаря,
   хронометраж и кратность из ТТ, статус ТТ оператора. */
function notesFor(reg, group, entry) {
  const out = [];
  const rec = entry.rec;
  if (!rec) return ['нет в реестре — сверьте написание оператора'];

  if (/ТТ нет|не заполнять|только юр/i.test(rec.status)) out.push('статус ТТ: ' + rec.status);

  const declared = ttResolutions(rec.params['Разрешения, указанные в ТТ'] || '');
  if (declared.size && group.res !== '—' && !declared.has(group.res)) {
    out.push('разрешение ' + group.res + ' не заявлено в ТТ оператора');
  }

  if (group.durNum) {
    const fmt = reg.formats.get(rec.norm + KEY_SEP + group.res);
    const slots = fmt ? fmt.slots : rec.slots;
    if (slots) {
      const allowed = parseSeconds(slots);
      if (allowed.size && !allowed.has(group.durNum)) {
        out.push(group.durNum + ' сек нет среди слотов инвентаря (' + slots + ')');
      }
    }
    const chron = rec.params['Хронометраж, сек'];
    if (chron) {
      const allowed = parseSeconds(chron);
      if (allowed.size && !allowed.has(group.durNum)) {
        out.push('в ТТ хронометраж ' + chron + ' — не ' + group.durNum + ' сек');
      }
    }
    const step = rec.params['Кратность хронометража'];
    if (step) {
      const m = /(\d+)/.exec(step);
      if (m && group.durNum % parseInt(m[1], 10) !== 0) {
        out.push(group.durNum + ' сек не кратно ' + m[1] + ' сек');
      }
    }
  }

  if (reg.constructions.has(rec.norm)) {
    out.push('есть отдельные ТТ по конструкциям (' + reg.constructions.get(rec.norm).length + ')');
  }
  return out;
}

/* ───────────────────────────── сборка результата ───────────────────────── */

/* Группируем строки АП по «разрешение × длительность» — это и есть один
   макет. Формат экрана в ключ не берём: под разные форматы с одинаковым
   разрешением и слотом делается один и тот же файл. */
function buildTasks(reg, apRows, opts) {
  const useDefaults = !opts || opts.useDefaults !== false;
  const groups = new Map();
  const unknownOperators = new Set();

  for (const r of apRows) {
    const res = r.resolution || '—';
    const durKey = r.duration === '' ? '—' : String(r.duration);
    const key = res + KEY_SEP + durKey;

    let g = groups.get(key);
    if (!g) {
      g = {
        res: res, aspect: r.aspect, dur: durKey,
        durNum: r.duration === '' ? null : Number(r.duration),
        screens: 0, formats: new Set(), cities: new Set(),
        opByKey: new Map(), ops: []
      };
      groups.set(key, g);
    }
    g.screens++;
    if (r.format) g.formats.add(r.format);
    if (r.city) g.cities.add(r.city);
    if (!g.aspect && r.aspect) g.aspect = r.aspect;

    const ok = norm(r.operator);
    let e = g.opByKey.get(ok);
    if (!e) {
      const rec = matchOperator(reg, r.operator);
      if (!rec) unknownOperators.add(r.operator);
      e = { name: r.operator, rec: rec, screens: 0 };
      g.opByKey.set(ok, e);
      g.ops.push(e);
    }
    e.screens++;
  }

  const tasks = [];
  for (const g of groups.values()) {
    g.ops.sort(function (a, b) { return b.screens - a.screens; });

    const cells = {};
    const conflicts = [], assumptions = [];

    for (const spec of TASK_PARAMS) {
      const entries = collect(g, spec.param, reg, useDefaults);
      const merged = mergeParam(spec, entries);
      cells[spec.col] = merged.value;
      if (merged.conflict) conflicts.push(spec.col + ': ' + merged.conflict);
      const assumedOps = entries.filter(function (e) { return e.assumed; })
        .map(function (e) { return e.op; });
      if (assumedOps.length) assumptions.push({ param: spec.col, ops: assumedOps });
    }

    const notes = [];
    for (const e of g.ops) {
      const n = notesFor(reg, g, e);
      if (n.length) notes.push(e.name + ': ' + n.join('; '));
    }

    /* Допущения группируем по оператору, а не по параметру: читателю важно
       «у этого оператора ТТ нет, вот что подставлено», а не наоборот. */
    const byOp = new Map();
    for (const a of assumptions) {
      for (const op of a.ops) {
        if (!byOp.has(op)) byOp.set(op, []);
        byOp.get(op).push(a.param);
      }
    }
    const assumedText = [...byOp.entries()].map(function (e) {
      return e[0] + ': отраслевой дефолт (' + e[1].join(', ') + ')';
    }).join('; ');

    tasks.push({
      res: g.res,
      aspect: g.aspect || '',
      dur: g.dur,
      durNum: g.durNum,
      screens: g.screens,
      opCount: g.ops.length,
      operators: g.ops.map(function (e) { return e.name + ' (' + e.screens + ')'; }).join(', '),
      formats: [...g.formats].join(', '),
      cells: cells,
      conflicts: conflicts.join('; '),
      notes: notes.join('; '),
      assumed: assumedText,
      ops: g.ops
    });
  }

  /* Сортировка: сначала самые массовые макеты — с них начинают производство. */
  tasks.sort(function (a, b) {
    if (b.screens !== a.screens) return b.screens - a.screens;
    return a.res < b.res ? -1 : a.res > b.res ? 1 : 0;
  });
  tasks.forEach(function (t, i) { t.no = i + 1; });

  return { tasks: tasks, unknownOperators: [...unknownOperators].sort() };
}

/* Карточки — только по операторам этой АП, отсортированным по числу
   поверхностей в ней. */
function buildCards(reg, apRows, opts) {
  const useDefaults = !opts || opts.useDefaults !== false;
  const byOp = new Map();

  for (const r of apRows) {
    const k = norm(r.operator);
    let c = byOp.get(k);
    if (!c) {
      c = {
        name: r.operator, rec: matchOperator(reg, r.operator),
        screens: 0, res: new Map(), durs: new Set()
      };
      byOp.set(k, c);
    }
    c.screens++;
    if (r.resolution) c.res.set(r.resolution, (c.res.get(r.resolution) || 0) + 1);
    if (r.duration !== '') c.durs.add(Number(r.duration));
  }

  const cards = [];
  for (const c of byOp.values()) {
    const rec = c.rec;
    const blocks = [];

    if (rec) {
      for (const b of reg.blocks) {
        const items = [];
        for (const p of b.params) {
          if (rec.params[p]) items.push({ param: p, value: rec.params[p], assumed: false });
        }
        if (items.length) blocks.push({ title: b.title, items: items });
      }

      /* Отраслевой дефолт — отдельным блоком в конце и только там, где
         оператор молчит. Смешивать его с настоящими требованиями нельзя:
         читатель обязан видеть, где кончаются ТТ оператора. */
      if (useDefaults) {
        const items = [];
        for (const d of reg.defaults) {
          if (!d.param || rec.params[d.param]) continue;
          items.push({ param: d.param, value: d.value, assumed: true });
        }
        if (items.length) {
          blocks.push({ title: 'Допущение — отраслевой дефолт', items: items, assumed: true });
        }
      }
    }

    const info = [];
    const resList = [...c.res.entries()].sort(function (a, b) { return b[1] - a[1]; })
      .map(function (e) { return e[0] + ' (' + e[1] + ')'; }).join(', ');
    info.push({ param: 'Разрешения в этой АП', value: resList });
    if (c.durs.size) {
      info.push({
        param: 'Длительности в этой АП',
        value: [...c.durs].sort(function (a, b) { return a - b; }).join(' / ') + ' сек'
      });
    }
    if (rec) {
      if (rec.slots) info.push({ param: 'Доступные слоты по инвентарю', value: rec.slots + ' сек' });
      if (rec.missing.length) info.push({ param: 'Не указано оператором', value: rec.missing.join(', ') });
      if (rec.mismatch) info.push({ param: 'Расхождение с инвентарём', value: rec.mismatch });
      if (rec.note) info.push({ param: 'Примечание', value: rec.note });
      if (rec.source) info.push({ param: 'Источник ТТ', value: rec.source });
      const cons = reg.constructions.get(rec.norm);
      if (cons) {
        info.push({
          param: 'ТТ по конструкциям',
          value: cons.length + ' листов: ' + uniq(cons.map(function (x) { return x.format; }))
            .slice(0, 8).join(', ')
        });
      }
    } else {
      info.push({
        param: 'Нет в реестре',
        value: 'оператор не найден по имени — сверьте написание или добавьте его в реестр'
      });
    }

    blocks.push({ title: 'Справка', items: info });

    cards.push({
      name: c.name,
      id: rec ? rec.id : '',
      status: rec ? rec.status : 'нет в реестре',
      screensAp: c.screens,
      screensTotal: rec ? rec.screens : 0,
      placement: rec ? rec.placement : '',
      blocks: blocks
    });
  }

  cards.sort(function (a, b) { return b.screensAp - a.screensAp; });
  return cards;
}

function analyze(reg, table, opts) {
  const ap = readAp(table);
  const built = buildTasks(reg, ap.rows, opts);
  const cards = buildCards(reg, ap.rows, opts);

  const conflicts = built.tasks.filter(function (t) { return t.conflicts; });
  const noTt = cards.filter(function (c) {
    return !c.id || /ТТ нет|не заполнять|только юр/i.test(c.status);
  });

  return {
    ap: ap,
    tasks: built.tasks,
    cards: cards,
    unknownOperators: built.unknownOperators,
    stats: {
      apRows: ap.rows.length,
      tasks: built.tasks.length,
      operators: cards.length,
      conflicts: conflicts.length,
      assumed: built.tasks.filter(function (t) { return t.assumed; }).length,
      noTt: noTt.length,
      noTtScreens: noTt.reduce(function (s, c) { return s + c.screensAp; }, 0)
    }
  };
}

/* ─────────────────────────────── выгрузка xlsx ─────────────────────────── */

function taskRow(t) {
  const row = [
    { v: t.no, s: L.S.INT },
    { v: t.res, s: L.S.BODY },
    { v: t.aspect, s: L.S.BODY },
    { v: t.durNum === null ? '—' : t.durNum, s: t.durNum === null ? L.S.WARN : L.S.INT },
    { v: t.screens, s: L.S.INT },
    { v: t.opCount, s: L.S.INT },
    { v: t.operators, s: L.S.BODY }
  ];
  /* Пустая ячейка — параметр не указал ни один оператор группы. Красным её не
     красим: у половины колонок пусто — норма (ночное вещание, знак ценза), и
     сплошная краснота обесценила бы настоящие предупреждения справа. */
  for (const spec of TASK_PARAMS) {
    row.push({ v: t.cells[spec.col] || '', s: L.S.BODY });
  }
  row.push({ v: t.conflicts, s: t.conflicts ? L.S.WARN : L.S.BODY });
  row.push({ v: t.notes, s: t.notes ? L.S.WARN : L.S.BODY });
  row.push({ v: t.assumed, s: t.assumed ? L.S.WARN : L.S.BODY });
  return row;
}

const TASK_COLS = [6, 13, 12, 15, 13, 12, 34]
  .concat(TASK_PARAMS.map(function (p) { return p.w; }))
  .concat([34, 44, 34]);

function buildWorkbook(result) {
  const tasks = {
    name: 'Задание на макеты',
    cols: TASK_COLS,
    rows: [TASK_COLUMNS.map(function (c) { return { v: c, s: L.S.HEADER }; })]
  };
  for (const t of result.tasks) tasks.rows.push(taskRow(t));

  /* Карточки — раскрывающиеся группы: шапка оператора видна всегда, блоки
     A–G прячутся под неё. Плоской таблицей на 148 операторов пользоваться
     невозможно, а свёрнутый список читается как оглавление. */
  const cards = {
    name: 'Карточки операторов',
    cols: [30, 30, 90],
    outlineSummaryAbove: true,
    rows: [[
      { v: 'Оператор / блок', s: L.S.HEADER },
      { v: 'Параметр', s: L.S.HEADER },
      { v: 'Значение', s: L.S.HEADER }
    ]]
  };
  for (const c of result.cards) {
    cards.rows.push({
      cells: [
        { v: c.name, s: L.S.GROUP },
        { v: (c.id ? 'ID ' + c.id + ' · ' : '') + 'поверхностей в АП: ' + c.screensAp, s: L.S.GROUP },
        { v: 'статус ТТ: ' + c.status + (c.placement ? ' · ' + c.placement : ''), s: L.S.GROUP }
      ]
    });
    for (const b of c.blocks) {
      b.items.forEach(function (it, i) {
        const style = (it.assumed || b.assumed) ? L.S.WARN : L.S.BODY;
        cards.rows.push({
          outlineLevel: 1,
          cells: [
            { v: i === 0 ? b.title : '', s: style },
            { v: it.param, s: style },
            { v: it.value, s: style }
          ]
        });
      });
    }
  }

  return [tasks, cards];
}

/* ──────────────────────────────── экспорт ──────────────────────────────── */

root.TTRegCore = {
  REGISTRY_URL: REGISTRY_URL,
  SHEET: SHEET,
  CRITICAL_PARAMS: CRITICAL_PARAMS,
  TASK_PARAMS: TASK_PARAMS,
  TASK_COLUMNS: TASK_COLUMNS,
  readRegistry: readRegistry,
  readAp: readAp,
  matchOperator: matchOperator,
  tokens: tokens,
  parseMb: parseMb,
  parseMbps: parseMbps,
  ttResolutions: ttResolutions,
  parseSeconds: parseSeconds,
  mergeParam: mergeParam,
  buildTasks: buildTasks,
  buildCards: buildCards,
  analyze: analyze,
  buildWorkbook: buildWorkbook
};

})(typeof globalThis !== 'undefined' ? globalThis : this);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.TTRegCore;
