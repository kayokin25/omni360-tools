/* ============================================================================
   MasterAd — сборка отчёта по фактическим показам + плану (МП).

   Вход: несколько файлов «Статистика показов» (выгрузка системы, разбитая на
   части из-за лимита строк — возможен и .zip со всеми частями сразу), один
   файл плана (МП) — необязателен, без него отчёт строится без плановых
   колонок и «% выполнения» (как для клиентов без расчёта, см. кейс Atera).

   Правила подобраны по переписке с клиентом (несколько сессий работы над
   этим же отчётом «Яндекс Go Вместе»):
     - факт — только строки со статусом «УСПЕШНЫЙ» (отклонённые выбрасываются);
     - «Количество выходов» = 1 на строку (каждая строка — один показ);
     - «Количество контактов» = столбец OTS; там, где экран передаёт 0,
       0 заменяется на постоянное значение по паре (город, тип конструкции) —
       таблица замен приходит от пользователя, единой для всех кампаний нет;
     - «Потрачено средств» = «Стоимость показа клиента», а если такого столбца
       в выгрузке нет — «Стоимость успешного показа» (в реальных данных они
       совпадают, но не все выгрузки содержат оба столбца);
     - план (МП) даёт ИТОГО по городу на весь период; суточный план — это
       просто «итого / количество дней» (само число дней — из ячейки
       «Количество дней» в МП, у него нет фиксированной позиции).

   Выходной файл — 5 листов, как в примерах отчётов клиенту:
     свод / Отчет / свод по минутам / Отчет по минутам / Лист2.
   «свод» и «свод по минутам» в оригинале оформлены КАК СВОДНАЯ ТАБЛИЦА Excel
   (текст «Названия строк»/«Названия столбцов»), но на самом деле это обычные
   значения, посчитанные один раз и записанные как текст — не настоящий
   pivot-объект OOXML (тот бы требовал отдельного pivotCache/pivotTable XML).
   Здесь эта же идея: посчитано один раз в JS, никаких формул.

   Зависит от OmniLib.
   ========================================================================== */
(function (root) {
'use strict';

const L = root.OmniLib;

const DEFAULTS = {
  successStatus: 'УСПЕШНЫЙ',
  headerScanRows: 10,
  typeMap: {
    BILLBOARD: 'Щит',
    CITYFORMAT: 'Ситиформат',
    CITYBOARD: 'Ситиборд',
    SUPERSITE: 'Суперсайт'
  }
};

/* ─────────────────────────────── утилиты ───────────────────────────────── */

function normKey(s) {
  return String(s === null || s === undefined ? '' : s).trim().toLowerCase();
}
function normFormatKey(city, format) {
  return normKey(city) + ' ' + String(format || '').trim().toUpperCase().replace(/_/g, '');
}
function pad2(n) { return n < 10 ? '0' + n : String(n); }

/* '17.07.2026' -> {y,m,d}: в выгрузке формат ДД.ММ.ГГГГ — день первый. */
function parseRuDate(s) {
  const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(String(s || ''));
  if (!m) return null;
  return { y: parseInt(m[3], 10), m: parseInt(m[2], 10), d: parseInt(m[1], 10) };
}
/* '16:25:14' -> {h,mi,s} */
function parseTime(s) {
  const m = /(\d{1,2}):(\d{1,2}):(\d{1,2})/.exec(String(s || ''));
  if (!m) return null;
  return { h: parseInt(m[1], 10), mi: parseInt(m[2], 10), s: parseInt(m[3], 10) };
}

/* Тот самый формат «  H:MM:SS» (два пробела, час БЕЗ ведущего нуля) — вот
   почему «Время выхода мин» (первые 7 символов) для часа 6 даёт «  6:00:»
   (с двоеточием на конце), а для часа 16 — «  16:25» (без двоеточия: у
   двузначного часа те же 7 символов кончаются на последней цифре минут). */
function timeToStr(t) {
  return '  ' + t.h + ':' + pad2(t.mi) + ':' + pad2(t.s);
}

/* Ключ сортировки для «  H:MM:...» независимо от одно-/двузначного часа. */
function timeMinSortKey(str) {
  const m = /(\d+):(\d+)/.exec(str);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 0;
}

/* Ищет строку-шапку: все токены из need должны встретиться (без учёта
   регистра) СРЕДИ значений одной строки, в первых maxRows строках. */
function findHeaderRow(rows, need, maxRows) {
  const needLower = need.map(normKey);
  const lim = Math.min(rows.length, maxRows);
  for (let r = 0; r < lim; r++) {
    const vals = (rows[r] || []).map(normKey);
    if (needLower.every(function (n) { return vals.indexOf(n) >= 0; })) return r;
  }
  return -1;
}
function colIndexByHeader(headerRow, names) {
  const vals = headerRow.map(normKey);
  for (const name of names) {
    const i = vals.indexOf(normKey(name));
    if (i >= 0) return i;
  }
  return -1;
}

/* ───────────────────────── чтение статистики ───────────────────────────── */

const REQUIRED_HEADERS = ['GID', 'Результат запроса'];

async function readOneStatSheet(source, name, opt) {
  const wb = await L.readXlsx(source);
  const sheet = wb.sheets[0];
  if (!sheet) return { skipped: name + ': в файле нет листов' };
  const headerIdx = findHeaderRow(sheet.rows, REQUIRED_HEADERS, opt.headerScanRows);
  if (headerIdx < 0) return { skipped: name + ': не нашёл шапку со столбцами GID/«Результат запроса»' };
  const header = sheet.rows[headerIdx];
  const col = {
    dateLocal: colIndexByHeader(header, ['Местная дата показа', 'Дата показа']),
    timeLocal: colIndexByHeader(header, ['Местное время показа', 'Время показа']),
    city: colIndexByHeader(header, ['Город']),
    status: colIndexByHeader(header, ['Результат запроса', 'Результат']),
    ots: colIndexByHeader(header, ['OTS']),
    costClient: colIndexByHeader(header, ['Стоимость показа клиента']),
    costOp: colIndexByHeader(header, ['Стоимость успешного показа']),
    gid: colIndexByHeader(header, ['GID']),
    address: colIndexByHeader(header, ['Адрес']),
    format: colIndexByHeader(header, ['Формат', 'Формат экрана'])
  };
  const missing = ['dateLocal', 'timeLocal', 'city', 'status', 'gid', 'address', 'format']
    .filter(function (k) { return col[k] < 0; });
  if (missing.length) return { skipped: name + ': не нашёл столбцы — ' + missing.join(', ') };

  return { rows: sheet.rows, dataStart: headerIdx + 1, col: col };
}

/* Разбирает один файл/архив источника в «сырые» строки (ещё без фильтра
   по статусу и без подстановки нулей — это соседняя функция buildFacts,
   чтобы правило замены можно было поменять и пересчитать без повторного
   чтения файлов). */
async function collectStatRows(input, onProgress) {
  const out = []; // { row, col } — row это исходный массив значений
  const skipped = [];

  async function handleXlsxSource(source, label) {
    const res = await readOneStatSheet(source, label, DEFAULTS);
    if (res.skipped) { skipped.push(res.skipped); return; }
    for (let r = res.dataStart; r < res.rows.length; r++) {
      const row = res.rows[r];
      if (!row || row.length === 0) continue;
      out.push({ row: row, col: res.col });
    }
  }

  if (input.kind === 'zip') {
    const zip = await L.zipOpen(input.source);
    let i = 0;
    for (const e of zip.entries) {
      if (e.isDir) continue;
      if (!/\.xlsx?$/i.test(e.name)) continue;
      i++;
      if (onProgress) onProgress(i, zip.entries.length, e.name);
      const bytes = await L.zipRead(zip, e);
      await handleXlsxSource(L.bytesSource(bytes, e.name), e.name);
    }
  } else {
    for (let i = 0; i < input.files.length; i++) {
      const f = input.files[i];
      if (onProgress) onProgress(i + 1, input.files.length, f.name);
      await handleXlsxSource(L.blobSource(f), f.name);
    }
  }
  return { rawRows: out, skipped: skipped };
}

/* ───────────────────────── факты (фильтр + правила) ────────────────────── */

/* zeroMap: Map('город ФОРМАТ' -> число) — замена нуля в OTS.
   typeMap: 'ФОРМАТ' (без подчёркиваний, верхний регистр) -> русское название.
   dateFrom/dateTo: Date (по числу, без времени) или null — включительно. */
function buildFacts(rawRows, options) {
  const opt = options || {};
  const zeroMap = opt.zeroMap || new Map();
  const typeMap = Object.assign({}, DEFAULTS.typeMap, opt.typeMap || {});
  const successStatus = opt.successStatus || DEFAULTS.successStatus;
  const dateFrom = opt.dateFrom || null, dateTo = opt.dateTo || null;

  const facts = [];
  let rejected = 0, outOfRange = 0, badDate = 0;

  for (const item of rawRows) {
    const row = item.row, col = item.col;
    const status = row[col.status];
    if (normKey(status) !== normKey(successStatus)) { rejected++; continue; }

    const dp = parseRuDate(row[col.dateLocal]);
    const tp = parseTime(row[col.timeLocal]);
    if (!dp) { badDate++; continue; }
    const day = new Date(dp.y, dp.m - 1, dp.d);
    if (dateFrom && day < dateFrom) { outOfRange++; continue; }
    if (dateTo && day > dateTo) { outOfRange++; continue; }

    const city = row[col.city] === null || row[col.city] === undefined ? '' : String(row[col.city]).trim();
    const formatRaw = row[col.format] === null || row[col.format] === undefined ? '' : String(row[col.format]).trim();
    const type = typeMap[formatRaw.toUpperCase().replace(/_/g, '')] || formatRaw;

    let contacts = col.ots >= 0 ? row[col.ots] : null;
    if (contacts === null || contacts === undefined || contacts === 0) {
      const repl = zeroMap.get(normFormatKey(city, formatRaw));
      contacts = (repl !== undefined && repl !== null) ? repl : (contacts || 0);
    }

    let spent = col.costClient >= 0 ? row[col.costClient] : null;
    if (spent === null || spent === undefined) spent = col.costOp >= 0 ? row[col.costOp] : 0;
    if (spent === null || spent === undefined) spent = 0;

    facts.push({
      city: city, type: type, formatRaw: formatRaw,
      gid: row[col.gid] === null || row[col.gid] === undefined ? '' : String(row[col.gid]).trim(),
      address: row[col.address] === null || row[col.address] === undefined ? '' : String(row[col.address]).trim(),
      day: day,
      hour: tp ? tp.h : 0,
      timeStr: tp ? timeToStr(tp) : '',
      timeMinStr: tp ? timeToStr(tp).slice(0, 7) : '',
      contacts: Number(contacts) || 0,
      spent: Number(spent) || 0
    });
  }

  facts.sort(function (a, b) {
    if (a.city !== b.city) return a.city < b.city ? -1 : 1;
    const ad = a.day.getTime(), bd = b.day.getTime();
    if (ad !== bd) return ad - bd;
    if (a.gid !== b.gid) return a.gid < b.gid ? -1 : 1;
    return a.timeStr < b.timeStr ? -1 : (a.timeStr > b.timeStr ? 1 : 0);
  });

  return {
    facts: facts,
    stats: { total: rawRows.length, success: facts.length, rejected: rejected, outOfRange: outOfRange, badDate: badDate }
  };
}

/* ─────────────────────────────── план (МП) ──────────────────────────────── */

async function loadPlan(file) {
  const wb = await L.readXlsx(L.blobSource(file));
  const sheet = wb.sheets.find(function (s) { return /мп/i.test(s.name); }) || wb.sheets[0];
  if (!sheet) throw new Error('в файле плана нет листов');
  const rows = sheet.rows;

  let days = null;
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (normKey(row[c]) === normKey('Количество дней')) {
        for (let c2 = c + 1; c2 < row.length; c2++) {
          if (typeof row[c2] === 'number') { days = row[c2]; break; }
        }
      }
    }
    if (days) break;
  }
  if (!days) throw new Error('в плане не нашёл ячейку «Количество дней»');

  const headerIdx = findHeaderRow(rows, ['Город', 'Прогноз бюджета'], 20);
  if (headerIdx < 0) throw new Error('в плане не нашёл строку шапки со столбцами «Город»/«Прогноз бюджета»');
  const header = rows[headerIdx];
  const colCity = colIndexByHeader(header, ['Город']);
  const colImp = colIndexByHeader(header, ['Прогноз кол-ва выходов']);
  const colOts = colIndexByHeader(header, ['Прогноз кол-ва OTS', 'Прогноз кол-ва ots']);
  const colBudget = colIndexByHeader(header, ['Прогноз бюджета']);
  if (colCity < 0 || colBudget < 0) throw new Error('в плане не нашёл нужные столбцы в строке шапки');

  const byCity = new Map();
  const order = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const cityRaw = row[colCity];
    if (cityRaw === null || cityRaw === undefined || String(cityRaw).trim() === '') break;
    if (normKey(cityRaw) === 'итого') continue;
    const city = String(cityRaw).trim();
    order.push(city);
    byCity.set(city, {
      impressions: Number(row[colImp]) || 0,
      ots: colOts >= 0 ? (Number(row[colOts]) || 0) : 0,
      budget: Number(row[colBudget]) || 0
    });
  }
  if (!byCity.size) throw new Error('в плане не нашёл ни одной строки по городам');

  return { days: days, byCity: byCity, cityOrder: order };
}

/* ────────────────────────────── сборка отчёта ───────────────────────────── */

function sumBy(facts, keyFn) {
  const m = new Map();
  for (const f of facts) {
    const k = keyFn(f);
    let g = m.get(k);
    if (!g) { g = { impressions: 0, contacts: 0, spent: 0 }; m.set(k, g); }
    g.impressions += 1; g.contacts += f.contacts; g.spent += f.spent;
  }
  return m;
}

function groupCityDay(facts) {
  const cities = new Map(); // city -> Map(dayMs -> {impressions,contacts,spent})
  for (const f of facts) {
    let byDay = cities.get(f.city);
    if (!byDay) { byDay = new Map(); cities.set(f.city, byDay); }
    const k = f.day.getTime();
    let g = byDay.get(k);
    if (!g) { g = { day: f.day, impressions: 0, contacts: 0, spent: 0 }; byDay.set(k, g); }
    g.impressions += 1; g.contacts += f.contacts; g.spent += f.spent;
  }
  return cities;
}

function cityOrderFrom(cities, planCityOrder) {
  const present = new Set(cities.keys());
  const order = [];
  if (planCityOrder) {
    for (const c of planCityOrder) if (present.has(c)) { order.push(c); present.delete(c); }
  }
  const rest = [...present].sort();
  return order.concat(rest);
}

function buildReport(facts, plan, options) {
  const opt = options || {};
  const campaignName = opt.campaignName || '';
  const hasPlan = !!plan;
  const cities = groupCityDay(facts);
  const orderedCities = cityOrderFrom(cities, plan ? plan.cityOrder : null);

  /* ── свод ── */
  const s1heads = hasPlan
    ? ['Названия строк', 'Сумма по полю Количество выходов', 'Сумма по полю Количество контактов',
       'Сумма по полю Потрачено средств, руб', 'План бюджета в сутки', 'План OTS в сутки']
    : ['Названия строк', 'Сумма по полю Количество выходов', 'Сумма по полю Количество контактов',
       'Сумма по полю Потрачено средств, руб'];
  const s1 = { name: 'свод', cols: hasPlan ? [22, 20, 22, 22, 18, 18] : [22, 20, 22, 22], rows: [] };

  let planBudgetTotal = 0, planOtsTotal = 0, factBudgetTotal = 0, factOtsTotal = 0;
  const cityRowsOut = [];
  for (const city of orderedCities) {
    const byDay = cities.get(city);
    const days = [...byDay.values()].sort(function (a, b) { return a.day - b.day; });
    const p = hasPlan ? plan.byCity.get(city) : null;
    const dailyBudget = p ? p.budget / plan.days : 0;
    const dailyOts = p ? p.ots / plan.days : 0;
    cityRowsOut.push({ city: city, days: days, dailyBudget: dailyBudget, dailyOts: dailyOts, hasPlanRow: !!p });
    for (const d of days) {
      factBudgetTotal += d.spent; factOtsTotal += d.contacts;
      if (p) { planBudgetTotal += dailyBudget; planOtsTotal += dailyOts; }
    }
  }

  if (hasPlan) {
    s1.rows.push([]); s1.rows.push([]); // строки 1-2 — «план общий»/«% выполнения», см. ниже
  }
  s1.rows.push(s1heads);
  for (const cr of cityRowsOut) {
    s1.rows.push([{ v: cr.city, s: L.S.CITYHDR }, { v: null, s: L.S.CITYHDR }, { v: null, s: L.S.CITYHDR },
      { v: null, s: L.S.CITYHDR }].concat(hasPlan ? [{ v: null, s: L.S.CITYHDR }, { v: null, s: L.S.CITYHDR }] : []));
    for (const d of cr.days) {
      const row = [
        { v: d.day, s: L.S.DATE }, { v: d.impressions, s: L.S.INT },
        { v: d.contacts, s: L.S.INT }, { v: round2(d.spent), s: L.S.MONEY }
      ];
      if (hasPlan) row.push({ v: round2(cr.dailyBudget), s: L.S.MONEY }, { v: round2(cr.dailyOts), s: L.S.MONEY });
      s1.rows.push(row);
    }
  }
  if (hasPlan) {
    s1.rows[0] = [null, null, null, 'план общий', round2(planBudgetTotal), round2(planOtsTotal)];
    s1.rows[1] = [null, null, null, '% выполнения', ratio(factBudgetTotal, planBudgetTotal), ratio(factOtsTotal, planOtsTotal)];
  }

  /* ── Отчет ── */
  const s2 = {
    name: 'Отчет', cols: [14, 26, 16, 16, 14, 40, 12, 12, 12, 16],
    rows: [['ИД кампании', 'Наименование кампании', 'Регион', 'Тип конструкции', 'GID', 'Адрес', 'День',
             'Количество выходов', 'Количество контактов', 'Потрачено средств, руб']]
  };
  for (const f of facts) {
    s2.rows.push([null, campaignName, f.city, f.type, f.gid, f.address,
      { v: f.day, s: L.S.DATE }, 1, f.contacts, round2(f.spent)]);
  }

  /* ── Отчет по минутам ── */
  const s3 = {
    name: 'Отчет по минутам', cols: [14, 26, 16, 16, 14, 40, 12, 8, 12, 12, 12, 12, 16],
    rows: [['ИД кампании', 'Наименование кампании', 'Регион', 'Тип конструкции', 'GID', 'Адрес', 'День',
             'Час', 'Время выхода', 'Время выхода мин', 'Количество выходов', 'Количество контактов', 'Потрачено средств, руб']]
  };
  for (const f of facts) {
    s3.rows.push([null, campaignName, f.city, f.type, f.gid, f.address,
      { v: f.day, s: L.S.DATE }, f.hour, f.timeStr, f.timeMinStr, 1, f.contacts, round2(f.spent)]);
  }

  /* ── свод по минутам ── */
  const minuteBuckets = [...new Set(facts.map(function (f) { return f.timeMinStr; }))]
    .filter(Boolean).sort(function (a, b) { return timeMinSortKey(a) - timeMinSortKey(b); });
  const s4 = { name: 'свод по минутам', cols: [22].concat(minuteBuckets.map(function () { return 8; })).concat([10]),
    rows: [['Названия строк'].concat(minuteBuckets).concat(['Итог'])] };
  for (const cr of cityRowsOut) {
    s4.rows.push([{ v: cr.city, s: L.S.CITYHDR }].concat(minuteBuckets.map(function () { return { v: null, s: L.S.CITYHDR }; }))
      .concat([{ v: null, s: L.S.CITYHDR }]));
    for (const d of cr.days) {
      const byMinute = sumBy(facts.filter(function (f) { return f.city === cr.city && f.day.getTime() === d.day.getTime(); }),
        function (f) { return f.timeMinStr; });
      const row = [{ v: d.day, s: L.S.DATE }];
      let tot = 0;
      for (const b of minuteBuckets) {
        const g = byMinute.get(b);
        row.push(g ? { v: g.impressions, s: L.S.INT } : null);
        tot += g ? g.impressions : 0;
      }
      row.push({ v: tot, s: L.S.INT });
      s4.rows.push(row);
    }
  }

  /* ── Лист2 (по часам, разрез кампания→день→адрес→GID) ── */
  const hours = [...new Set(facts.map(function (f) { return f.hour; }))].sort(function (a, b) { return a - b; });
  const groupKey = function (f) { return f.day.getTime() + ' ' + f.address + ' ' + f.gid; };
  const groups = new Map();
  const groupOrder = [];
  for (const f of facts) {
    const k = groupKey(f);
    let g = groups.get(k);
    if (!g) {
      g = { day: f.day, address: f.address, gid: f.gid, byHour: new Map(), total: 0 };
      groups.set(k, g); groupOrder.push(k);
    }
    g.byHour.set(f.hour, (g.byHour.get(f.hour) || 0) + 1);
    g.total += 1;
  }
  groupOrder.sort(function (ka, kb) {
    const a = groups.get(ka), b = groups.get(kb);
    if (a.day.getTime() !== b.day.getTime()) return a.day - b.day;
    if (a.address !== b.address) return a.address < b.address ? -1 : 1;
    return a.gid < b.gid ? -1 : (a.gid > b.gid ? 1 : 0);
  });

  const s5 = { name: 'Лист2', cols: [26, 14, 40, 16].concat(hours.map(function () { return 8; })).concat([10]),
    rows: [['Наименование кампании', 'День', 'Адрес', 'GID'].concat(hours).concat(['Общий итог'])] };
  let prevCampaign = null, prevDay = null;
  for (const k of groupOrder) {
    const g = groups.get(k);
    const campaignCell = (prevCampaign === campaignName) ? null : campaignName;
    const dayKey = g.day.getTime();
    const dayCell = (prevDay === dayKey) ? null : { v: g.day, s: L.S.DATE };
    prevCampaign = campaignName; prevDay = dayKey;
    const row = [campaignCell, dayCell, g.address, g.gid];
    for (const h of hours) row.push(g.byHour.get(h) || null);
    row.push(g.total);
    s5.rows.push(row);
  }

  const stats = {
    facts: facts.length,
    cities: orderedCities.length,
    hasPlan: hasPlan,
    factBudget: round2(factBudgetTotal), planBudget: round2(planBudgetTotal),
    factOts: round2(factOtsTotal), planOts: round2(planOtsTotal),
    budgetRatio: hasPlan ? ratio(factBudgetTotal, planBudgetTotal) : null,
    otsRatio: hasPlan ? ratio(factOtsTotal, planOtsTotal) : null,
    minuteBuckets: minuteBuckets.length,
    hours: hours.length,
    groups: groupOrder.length
  };

  return { sheets: [s1, s2, s3, s4, s5], stats: stats };
}

function round2(n) { return Math.round((n || 0) * 100) / 100; }
function ratio(a, b) { return b ? a / b : null; }

root.MasterAdCore = {
  DEFAULTS: DEFAULTS,
  collectStatRows: collectStatRows,
  buildFacts: buildFacts,
  loadPlan: loadPlan,
  buildReport: buildReport,
  /* низкоуровневые — для тестов/гайда */
  normFormatKey: normFormatKey,
  parseRuDate: parseRuDate,
  parseTime: parseTime,
  timeToStr: timeToStr,
  timeMinSortKey: timeMinSortKey,
  findHeaderRow: findHeaderRow
};

})(typeof globalThis !== 'undefined' ? globalThis : this);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.MasterAdCore;
