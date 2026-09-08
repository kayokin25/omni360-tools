/* ============================================================================
   Движок гайдов: рисует слайды из lib/guide-data.js и оживляет мини-демо.

   Гайд открывается в iframe внутри панели: какой инструмент показывать,
   говорит #tool=<id> в адресе. Наружу общаемся через postMessage — открыть
   инструмент, открыть его с демо-данными, закрыть, отметить как прочитанный.
   Хранение прочитанных на стороне панели: у неё один localStorage на всё,
   а iframe с blob:-адресом до него дотягивается не везде.

   Мини-демо считают НАСТОЯЩИМ кодом инструментов (TTCore.lookupDuration,
   MergeCore.mergeTables, OmniLib.reduceRatio) — иначе гайд рано или поздно
   начнёт врать про поведение, которое рядом изменили.
   ========================================================================== */
(function (root) {
'use strict';

const D = root.OmniGuideData;
const L = root.OmniLib;
const T = root.TTCore;
const M = root.MergeCore;
const AZ = root.AzimuthCore;
const IC = root.InventoryCore;
const VD = root.VideoCore;

const $ = function (id) { return document.getElementById(id); };

function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function post(msg) {
  try { root.parent.postMessage({ omniGuide: msg }, '*'); } catch (e) { /* нет родителя */ }
}

/* ─────────────────────────────── состояние ─────────────────────────────── */

function toolFromHash() {
  const m = /(?:^|[#&])tool=([A-Za-z0-9_-]+)/.exec(root.location.hash || '');
  return m ? m[1] : null;
}

const toolId = toolFromHash();
const guide = toolId ? D.GUIDES[toolId] : null;
const savings = toolId ? D.SAVINGS[toolId] : null;

let idx = 0;
const visited = new Set([0]);

/* ─────────────────────────── отрисовка слайдов ─────────────────────────── */

function introHtml(s) {
  let h = '<div class="g-kick">зачем это</div>' +
          '<div class="g-h2">' + esc(s.h) + '</div>';
  for (const p of s.lead) h += '<div class="g-lead">' + p + '</div>';

  if (savings) {
    h += '<div class="g-cmp">' +
      '<div class="g-cmp-box"><div class="g-cmp-k">руками</div>' +
        '<div class="g-cmp-v">' + esc(savings.manual) + '</div>' +
        '<div class="g-cmp-d">' + esc(savings.manualNote) + '</div></div>' +
      '<div class="g-arrow">→</div>' +
      '<div class="g-cmp-box now"><div class="g-cmp-k">здесь</div>' +
        '<div class="g-cmp-v">' + esc(savings.tool) + '</div>' +
        '<div class="g-cmp-d">' + esc(savings.toolNote) + '</div></div>' +
      '</div>' +
      '<div class="g-note-est">Объём для сравнения: ' + esc(savings.on) +
      '. Время «руками» — оценка, а не замер.</div>';
  }

  if (s.gain && s.gain.length) {
    h += '<div class="g-list">';
    for (const g of s.gain) h += '<div class="g-li"><span class="m">✓</span><span>' + g + '</span></div>';
    h += '</div>';
  }
  return h;
}

function stepsHtml(s) {
  let h = '<div class="g-kick">по шагам</div><div class="g-h2">' + esc(s.h) + '</div>';
  if (s.lead) for (const p of s.lead) h += '<div class="g-lead">' + p + '</div>';
  h += '<div class="g-steps">';
  s.items.forEach(function (it, i) {
    h += '<div class="g-step"><div class="g-step-n">' + (i + 1) + '</div><div>' +
         '<div class="g-step-t">' + it.t + '</div>' +
         '<div class="g-step-d">' + it.d + '</div></div></div>';
  });
  return h + '</div>';
}

function pitsHtml(s) {
  let h = '<div class="g-kick">частые ошибки</div><div class="g-h2">' + esc(s.h) + '</div>' +
          '<div class="g-pits">';
  for (const it of s.items) {
    h += '<div class="g-pit"><div class="g-pit-t">' + it.t + '</div>' +
         '<div class="g-pit-d">' + it.d + '</div></div>';
  }
  return h + '</div>';
}

function demoHtml(s) {
  let h = '<div class="g-kick">попробуйте сами</div><div class="g-h2">' + esc(s.h) + '</div>';
  if (s.lead) for (const p of s.lead) h += '<div class="g-lead">' + p + '</div>';
  h += '<div class="g-demo"><div class="g-demo-head"><span class="live"></span>' +
       'живой пример</div><div class="g-demo-body" id="demoHost"></div></div>';
  if (s.hint) h += '<div class="g-demo-hint">' + s.hint + '</div>';
  return h;
}

function finishHtml(s) {
  let h = '<div class="g-kick">и напоследок</div><div class="g-h2">' + esc(s.h) + '</div>';
  if (s.lead) for (const p of s.lead) h += '<div class="g-lead">' + p + '</div>';
  if (s.links && s.links.length) {
    h += '<div class="g-steps">';
    for (const it of s.links) {
      h += '<div class="g-step"><div class="g-step-n">→</div><div>' +
           '<div class="g-step-t">' + esc(it.t) + '</div>' +
           '<div class="g-step-d">' + esc(it.d) + '</div></div></div>';
    }
    h += '</div>';
  }
  return h;
}

const RENDER = { intro: introHtml, steps: stepsHtml, pits: pitsHtml, demo: demoHtml, finish: finishHtml };

function render() {
  const slides = guide.slides;
  const s = slides[idx];

  $('gBody').innerHTML = '<div class="g-slide">' + RENDER[s.kind](s) + '</div>';
  if (s.kind === 'demo' && DEMOS[s.demo]) DEMOS[s.demo]($('demoHost'));

  $('gCount').textContent = 'шаг ' + (idx + 1) + ' из ' + slides.length;

  $('gProg').innerHTML = slides.map(function (_, i) {
    return '<button data-i="' + i + '" class="' +
      (i === idx ? 'on' : (visited.has(i) ? 'seen' : '')) + '" title="' +
      esc(slides[i].h) + '"></button>';
  }).join('');
  [...$('gProg').children].forEach(function (b) {
    b.addEventListener('click', function () { go(parseInt(b.dataset.i, 10)); });
  });

  const last = idx === slides.length - 1;
  const cta = last ? (s.cta || {}) : null;
  let nav = '<button class="g-btn-sm" id="gPrev"' + (idx === 0 ? ' disabled' : '') + '>← Назад</button>';
  if (last) {
    nav += '<span class="sp"></span>';
    if (cta.demo) nav += '<button class="g-btn-sm" id="gDemoRun">' + esc(cta.demo) + '</button>';
    nav += '<button class="g-btn-pri" id="gOpen">' +
           (guide.ext ? 'Открыть сервис ↗' : 'Открыть инструмент →') + '</button>';
  } else {
    nav += '<span class="g-keyhint">стрелки ← → тоже работают</span><span class="sp"></span>' +
           '<button class="g-btn-pri" id="gNext">Далее →</button>';
  }
  $('gNav').innerHTML = nav;

  if ($('gPrev')) $('gPrev').addEventListener('click', function () { go(idx - 1); });
  if ($('gNext')) $('gNext').addEventListener('click', function () { go(idx + 1); });
  if ($('gOpen')) $('gOpen').addEventListener('click', function () {
    post({ action: 'open', tool: toolId });
  });
  if ($('gDemoRun')) $('gDemoRun').addEventListener('click', function () {
    post({ action: 'open', tool: toolId, demo: true });
  });

  $('gBody').scrollTop = 0;
}

function go(i) {
  if (i < 0 || i >= guide.slides.length || i === idx) return;
  idx = i;
  visited.add(i);
  render();
}

/* ═══════════════════════════════ мини-демо ══════════════════════════════ */

const DEMOS = {};

/* ── ТТ: настоящий поиск длительности по справочнику ── */
DEMOS.ttDuration = function (host) {
  const data = root.TTData;
  const ops = [...new Set(data.INVENTORY_DURATIONS.map(function (r) { return r[0]; }))];
  // Russ Outdoor в таблице связок нет — он обрабатывается отдельным правилом,
  // но в демо без него не показать самое интересное.
  if (!ops.some(function (o) { return L.normName(o) === 'russ outdoor'; })) ops.push('Russ Outdoor');
  ops.sort(function (a, b) { return a.localeCompare(b, 'ru'); });

  const fmts = [...new Set(
    data.INVENTORY_DURATIONS.map(function (r) { return r[1]; })
      .concat(data.RUSS_10SEC_FORMATS)
  )].sort();

  host.innerHTML =
    '<div class="g-demo-row">' +
      '<div class="field"><label>Оператор</label><select id="dOp">' +
        ops.map(function (o) {
          return '<option' + (o === 'Russ Outdoor' ? ' selected' : '') + '>' + esc(o) + '</option>';
        }).join('') +
      '</select></div>' +
      '<div class="field"><label>Формат экрана</label><select id="dFmt">' +
        fmts.map(function (f) {
          return '<option' + (f === 'CITY_FORMAT' ? ' selected' : '') + '>' + esc(f) + '</option>';
        }).join('') +
      '</select></div>' +
    '</div>' +
    '<div class="g-demo-out" id="dOut"></div>';

  function rule(op, fmt) {
    const n = L.normName(op);
    if (data.RUSS_OPERATORS.indexOf(n) >= 0) {
      return data.RUSS_10SEC_FORMATS.indexOf(fmt) >= 0
        ? 'правило Russ Outdoor: CITY_FORMAT и PVZ_SCREEN — 10 секунд'
        : 'правило Russ Outdoor: остальные форматы — 5 секунд';
    }
    if (data.MAER_OUTDOOR_OPERATORS.indexOf(n) >= 0) {
      return fmt === 'MEDIAFACADE'
        ? 'правило MAER (Outdoor): медиафасад — 10 секунд'
        : 'правило MAER (Outdoor): остальные форматы — 5 секунд';
    }
    if (Object.prototype.hasOwnProperty.call(data.FLAT_DURATIONS, n)) {
      return 'у этого оператора одна длительность на все форматы';
    }
    return 'из справочника связок «оператор + формат»';
  }

  function upd() {
    const op = $('dOp').value, fmt = $('dFmt').value;
    const dur = T.lookupDuration(op, fmt);
    $('dOut').innerHTML = dur === null
      ? '<div class="g-out-none">длительности нет</div>' +
        '<div class="g-out-k">Такой связки в справочнике нет. В отчёте строка будет с пустой ' +
        'длительностью и попадёт во вкладку с ненайденными — это сигнал, что связку надо добавить.</div>'
      : '<div class="g-out-big">' + dur + ' сек</div>' +
        '<div class="g-out-k">' + esc(rule(op, fmt)) + '</div>';
  }
  $('dOp').addEventListener('change', upd);
  $('dFmt').addEventListener('change', upd);
  upd();
};

/* ── креативы: правило подбора под размер экрана ── */
DEMOS.creativeMatch = function (host) {
  const creatives = [
    { name: 'kreo_16x9_hd.mp4', w: 1920, h: 1080 },
    { name: 'kreo_16x9_big.mp4', w: 2560, h: 1440 },
    { name: 'kreo_vertical.mp4', w: 1080, h: 1920 },
    { name: 'kreo_square.mp4', w: 768, h: 768 }
  ];
  // Два экрана 16:9 разных размеров — специально: показать, что оба уходят
  // в ОДИН и тот же, самый большой файл этого соотношения.
  const screens = [
    { t: 'MAER · 1280×720 (16:9)', op: 'MAER (Outdoor)', w: 1280, h: 720 },
    { t: 'РА Прайм · 960×540 (16:9)', op: 'РА Прайм', w: 960, h: 540 },
    { t: 'Russ Outdoor · 1920×1080 (16:9)', op: 'Russ Outdoor', w: 1920, h: 1080 },
    { t: 'Russ Outdoor · 1280×720 (16:9)', op: 'Russ Outdoor', w: 1280, h: 720 },
    { t: 'Оператор · 1080×1920 (вертикаль)', op: 'РА Прайм', w: 1080, h: 1920 },
    { t: 'Оператор · 960×960 (квадрат)', op: 'Другой оператор', w: 960, h: 960 }
  ];

  host.innerHTML =
    '<div class="field" style="margin-bottom:12px"><label>Экран из адресной программы</label>' +
      '<select id="dScr">' + screens.map(function (s, i) {
        return '<option value="' + i + '">' + esc(s.t) + '</option>';
      }).join('') + '</select></div>' +
    '<div class="g-mini-cap">Что лежит в архиве</div>' +
    '<div class="g-mini-wrap"><table class="g-mini">' +
      '<thead><tr><th>Файл</th><th>Размер</th><th>Соотношение</th><th></th></tr></thead>' +
      '<tbody id="dCre"></tbody></table></div>' +
    '<div class="g-demo-out" id="dScrOut"></div>';

  /* Правило один в один как в creatives-core: для Russ — точный размер, без
     исключений; остальным — то же соотношение сторон, и из подходящих (не
     меньше экрана) берётся САМЫЙ БОЛЬШОЙ, а не ближайший по размеру. Один
     такой файл потом покрывает сразу все экраны этого соотношения меньше
     себя — поэтому у операторов из примера ниже совпадает результат. */
  function pick(scr) {
    const russ = /russ/i.test(scr.op);
    if (russ) {
      const exact = creatives.filter(function (c) { return c.w === scr.w && c.h === scr.h; });
      return { best: exact[0] || null, rule: 'Russ Outdoor — только точное совпадение размера' };
    }
    const tr = L.reduceRatio(scr.w, scr.h);
    const fit = creatives.filter(function (c) {
      const cr = L.reduceRatio(c.w, c.h);
      return cr[0] === tr[0] && cr[1] === tr[1] && c.w >= scr.w && c.h >= scr.h;
    });
    const best = fit.length ? fit.reduce(function (a, b) {
      return a.w * a.h >= b.w * b.h ? a : b;
    }) : null;
    return { best: best, rule: 'тот же AR — самый большой доступный файл этого соотношения' };
  }

  function upd() {
    const scr = screens[parseInt($('dScr').value, 10)];
    const res = pick(scr);
    const tr = L.reduceRatio(scr.w, scr.h);

    $('dCre').innerHTML = creatives.map(function (c) {
      const r = L.reduceRatio(c.w, c.h);
      const hit = res.best && res.best.name === c.name;
      return '<tr class="' + (hit ? 'hit' : 'out') + '">' +
        '<td>' + esc(c.name) + '</td>' +
        '<td>' + c.w + '×' + c.h + '</td>' +
        '<td>' + r[0] + ':' + r[1] + '</td>' +
        '<td>' + (hit ? 'подходит' : '') + '</td></tr>';
    }).join('');

    if (res.best) {
      const exact = res.best.w === scr.w && res.best.h === scr.h;
      $('dScrOut').innerHTML =
        '<div class="g-out-big">' + esc(res.best.name) + '</div>' +
        '<div class="g-out-k">' + esc(res.rule) + '. Экран ' + scr.w + '×' + scr.h +
        ' (' + tr[0] + ':' + tr[1] + '), креатив ' + res.best.w + '×' + res.best.h +
        (exact ? ' — размер совпал точно.' : ' — с запасом, на экране уменьшится.') + '</div>';
    } else {
      $('dScrOut').innerHTML =
        '<div class="g-out-none">под этот экран крео нет</div>' +
        '<div class="g-out-k">' + esc(res.rule) + '. Экран попадёт в список незакрытых — ' +
        'это и есть то, что нужно запросить у дизайна.</div>';
    }
  }
  $('dScr').addEventListener('change', upd);
  upd();
};

/* ── адреса: снятие дублей по координатам ── */
DEMOS.addrDedupe = function (host) {
  // Так справочник и отдаёт: один объект приходит по нескольким страницам и
  // под слегка разными названиями, а координаты у него одни и те же.
  const raw = [
    { n: 'Пятёрочка', lat: 55.796100, lon: 49.106400 },
    { n: 'Пятёрочка, магазин', lat: 55.796100, lon: 49.106400 },
    { n: 'Пятёрочка', lat: 55.812300, lon: 49.121900 },
    { n: 'Пятёрочка', lat: 55.774500, lon: 49.138200 },
    { n: 'Пятёрочка (у дома)', lat: 55.774500, lon: 49.138200 },
    { n: 'Пятёрочка', lat: 55.830700, lon: 49.061500 },
    { n: 'Пятёрочка', lat: 55.830700, lon: 49.061500 }
  ];

  host.innerHTML =
    '<div class="g-mini-wrap"><table class="g-mini">' +
      '<thead><tr><th>Название</th><th>Широта</th><th>Долгота</th><th></th></tr></thead>' +
      '<tbody id="dRaw"></tbody></table></div>' +
    '<div class="btn-row" style="margin-top:12px">' +
      '<button class="g-btn-sm" id="dDedup">Снять дубли</button>' +
      '<button class="g-btn-sm" id="dReset" style="display:none">Показать как было</button>' +
    '</div>' +
    '<div class="g-demo-out" id="dRawOut"></div>';

  function draw(dedup) {
    const seen = new Set();
    const marks = raw.map(function (r) {
      const k = r.lat + ',' + r.lon;
      const dup = seen.has(k);
      seen.add(k);
      return dup;
    });
    $('dRaw').innerHTML = raw.map(function (r, i) {
      if (dedup && marks[i]) return '';
      return '<tr class="' + (dedup ? 'hit' : (marks[i] ? 'out' : '')) + '">' +
        '<td>' + esc(r.n) + '</td>' +
        '<td>' + r.lat.toFixed(6) + '</td>' +
        '<td>' + r.lon.toFixed(6) + '</td>' +
        '<td>' + (!dedup && marks[i] ? 'та же точка' : '') + '</td></tr>';
    }).join('');

    const kept = marks.filter(function (m) { return !m; }).length;
    $('dRawOut').innerHTML = dedup
      ? '<div class="g-out-big">' + kept + '</div>' +
        '<div class="g-out-k">Столько объектов попадёт в файл. Справочник отдал ' + raw.length +
        ' записей — ' + (raw.length - kept) + ' из них описывают те же точки.</div>'
      : '<div class="g-out-k">Справочник отдал ' + raw.length + ' записей. Совпадающие ' +
        'координаты помечены — именно по ним инструмент и снимает дубли, а не по названию.</div>';

    $('dDedup').style.display = dedup ? 'none' : '';
    $('dReset').style.display = dedup ? '' : 'none';
  }

  $('dDedup').addEventListener('click', function () { draw(true); });
  $('dReset').addEventListener('click', function () { draw(false); });
  draw(false);
};

/* ── объединение: настоящая склейка по названиям столбцов ── */
DEMOS.mergeDemo = function (host) {
  const tables = [
    { name: 'Казань.xlsx', header: ['Название', 'Широта', 'Долгота'],
      data: [['Пятёрочка', 55.7961, 49.1064], ['Магнит', 55.8123, 49.1219]] },
    // столбцы в другом порядке — по названию это не мешает
    { name: 'Уфа.xlsx', header: ['Широта', 'Долгота', 'Название'],
      data: [[54.7351, 55.9587, 'Пятёрочка'], [54.7423, 55.9721, 'Магнит']] },
    // свой столбец — уедет в конец шапки
    { name: 'Самара.xlsx', header: ['Название', 'Широта', 'Долгота', 'Комментарий'],
      data: [['Пятёрочка', 53.1959, 50.1002, 'проверить вывеску']] }
  ];

  host.innerHTML =
    '<div class="g-two" id="dSrc"></div>' +
    '<div class="btn-row" style="margin-top:12px">' +
      '<button class="g-btn-sm" id="dMerge">Объединить</button>' +
    '</div>' +
    '<div class="g-demo-out" id="dMergeOut"></div>';

  $('dSrc').innerHTML = tables.map(function (t) {
    return '<div><div class="g-mini-cap">' + esc(t.name) + '</div>' +
      '<div class="g-mini-wrap"><table class="g-mini"><thead><tr>' +
      t.header.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      t.data.map(function (r) {
        return '<tr>' + r.map(function (v) { return '<td>' + esc(v) + '</td>'; }).join('') + '</tr>';
      }).join('') +
      '</tbody></table></div></div>';
  }).join('');

  $('dMerge').addEventListener('click', function () {
    const merged = M.mergeTables(tables, { matchBy: 'name', addSource: true });
    const header = merged.header.concat(['Файл-источник']);
    $('dMergeOut').innerHTML =
      '<div class="g-mini-cap">Объединено.xlsx</div>' +
      '<div class="g-mini-wrap"><table class="g-mini"><thead><tr>' +
      header.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      merged.rows.map(function (r) {
        return '<tr>' + r.values.concat([r.source]).map(function (v) {
          return '<td>' + esc(v) + '</td>';
        }).join('') + '</tr>';
      }).join('') +
      '</tbody></table></div>' +
      '<div class="g-out-k" style="margin-top:10px">Строк: ' + merged.rows.length +
      '. Столбцы легли по названиям, хотя в «Уфа.xlsx» они идут в другом порядке. ' +
      '«Комментарий» был только в одном файле — он добавился в конец шапки, ' +
      'у остальных строк там пусто.</div>';
    $('dMerge').disabled = true;
  });
};

/* ── калькулятор: та же формула, что в инструменте ── */
DEMOS.markup = function (host) {
  const TIERS = [10, 12, 14, 16, 20];

  host.innerHTML =
    '<div class="g-demo-row">' +
      '<div class="field"><label>Стоимость подрядчика, ₽</label>' +
        '<input type="number" id="dCon" value="500000" min="0" step="10000"></div>' +
      '<div class="field"><label>Мин. комиссия агентства, %</label>' +
        '<input type="number" id="dComm" value="10" min="0" step="0.5"></div>' +
    '</div>' +
    '<div class="g-demo-out" id="dMarkOut"></div>';

  function money(n) {
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency', currency: 'RUB', maximumFractionDigits: 0
    }).format(n);
  }

  function upd() {
    const con = parseFloat($('dCon').value) || 0;
    const comm = parseFloat($('dComm').value);
    const minComm = isNaN(comm) || comm < 0 ? 10 : comm;
    const maxSK = Math.max.apply(null, TIERS) / 100;
    const denom = 1 - maxSK - minComm / 100;

    if (con <= 0) {
      $('dMarkOut').innerHTML = '<div class="g-out-k">Введите стоимость подрядчика.</div>';
      return;
    }
    if (denom <= 0) {
      $('dMarkOut').innerHTML = '<div class="g-out-none">решения нет</div>' +
        '<div class="g-out-k">Минимальная комиссия и максимальный СК вместе дают 100% и больше — ' +
        'делить не на что. Калькулятор в этом случае тоже показывает прочерк.</div>';
      return;
    }

    const list = con / denom;
    const markup = (list / con - 1) * 100;
    const worst = list * (1 - maxSK) - con;                       // при максимальном СК
    const best = list * (1 - Math.min.apply(null, TIERS) / 100) - con;  // при минимальном

    $('dMarkOut').innerHTML =
      '<div class="g-out-big">' + markup.toFixed(1) + '%</div>' +
      '<div class="g-out-k">Цена в системе: <b>' + money(list) + '</b>. ' +
      'При максимальном СК ' + Math.max.apply(null, TIERS) + '% заработаем ' + money(worst) +
      ', при минимальном ' + Math.min.apply(null, TIERS) + '% — ' + money(best) +
      '. Ступени взяты по умолчанию, в калькуляторе их можно поправить.</div>';
  }
  $('dCon').addEventListener('input', upd);
  $('dComm').addEventListener('input', upd);
  upd();
};

/* ── карта: сборка ссылок по координатам ── */
DEMOS.mapLinks = function (host) {
  host.innerHTML =
    '<div class="field"><label>Координаты точки</label>' +
      '<input type="text" id="dCoord" value="55.796100, 49.106400" spellcheck="false"></div>' +
    '<div class="g-demo-out" id="dCoordOut"></div>';

  function upd() {
    const m = /(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)/.exec($('dCoord').value || '');
    if (!m) {
      $('dCoordOut').innerHTML = '<div class="g-out-k">Ожидаются два числа: сначала широта, ' +
        'потом долгота — например <code>55.7961, 49.1064</code>.</div>';
      return;
    }
    const lat = m[1].replace(',', '.'), lon = m[2].replace(',', '.');
    const z = 16;
    const links = [
      ['Яндекс', 'https://yandex.ru/maps/?ll=' + lon + ',' + lat + '&z=' + z + '&pt=' + lon + ',' + lat],
      ['2ГИС', 'https://2gis.ru/geo/' + lon + ',' + lat],
      ['Google', 'https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lon],
      ['OSM', 'https://www.openstreetmap.org/?mlat=' + lat + '&mlon=' + lon + '#map=' + z + '/' + lat + '/' + lon]
    ];
    $('dCoordOut').innerHTML =
      '<div class="g-list">' + links.map(function (l) {
        return '<div class="g-li"><span class="m">→</span><span><a href="' + esc(l[1]) +
          '" target="_blank" rel="noopener">' + esc(l[0]) + '</a> ' +
          '<span style="color:var(--dim)">· та же точка</span></span></div>';
      }).join('') + '</div>' +
      '<div class="g-out-k" style="margin-top:10px">Обратите внимание: у Яндекса и 2ГИС ' +
      'в адресе сначала идёт долгота, у Google и OSM — широта. Инструмент это учитывает, ' +
      'а при ручной копипасте так и уезжают в другой город.</div>';
  }
  $('dCoord').addEventListener('input', upd);
  upd();
};

/* ── мониторинг: расчёт темпа с настоящими порогами сервиса ── */
DEMOS.pace = function (host) {
  host.innerHTML =
    '<div class="g-demo-row">' +
      '<div class="field"><label>Бюджет, ₽</label>' +
        '<input type="number" id="pB" value="900000" min="0" step="50000"></div>' +
      '<div class="field"><label>Дней всего</label>' +
        '<input type="number" id="pT" value="30" min="1" step="1"></div>' +
    '</div>' +
    '<div class="g-demo-row" style="margin-top:10px">' +
      '<div class="field"><label>Дней прошло</label>' +
        '<input type="number" id="pP" value="10" min="0" step="1"></div>' +
      '<div class="field"><label>Потрачено, ₽</label>' +
        '<input type="number" id="pS" value="180000" min="0" step="10000"></div>' +
    '</div>' +
    '<div class="g-demo-out" id="pOut"></div>';

  function money(n) {
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency', currency: 'RUB', maximumFractionDigits: 0
    }).format(n);
  }

  function upd() {
    const budget = parseFloat($('pB').value) || 0;
    const total = Math.max(1, parseInt($('pT').value, 10) || 1);
    const passed = Math.min(total, Math.max(0, parseInt($('pP').value, 10) || 0));
    const spent = parseFloat($('pS').value) || 0;

    const plan = budget / total * passed;
    const pace = plan > 0 ? spent / plan : 0;
    const left = Math.max(0, total - passed + 1);
    const remaining = Math.max(0, budget - spent);
    const daily = left > 0 ? remaining / left : 0;

    // Плана ещё нет — сравнивать не с чем. Сервис в этом случае тоже не строит
    // алерты: в первые полчаса эфира статистика ещё ни о чём не говорит.
    if (plan <= 0) {
      $('pOut').innerHTML = '<div class="g-out-k">Плана на этот момент ещё нет — ' +
        'кампания не начала вещать, сравнивать не с чем. Поставьте «дней прошло» ' +
        'больше нуля.</div>';
      return;
    }

    // Пороги — как в сервисе: <70% красный, <95% жёлтый, дальше зелёный.
    const label = pace < 0.70 ? 'Отстаём' : (pace < 0.95 ? 'Небольшое отставание' : 'В графике');
    const color = pace < 0.70 ? 'var(--err-text)' : (pace < 0.95 ? 'var(--warn-text)' : 'var(--ok-text)');

    $('pOut').innerHTML =
      '<div class="g-out-big" style="-webkit-text-fill-color:' + color +
        ';background-image:none;color:' + color + '">' + Math.round(pace * 100) + '% · ' + label + '</div>' +
      '<div class="g-out-k">План к этому дню: <b>' + money(plan) + '</b>, потрачено ' + money(spent) +
      '. Недобор: <b>' + money(Math.max(0, plan - spent)) + '</b>. ' +
      'Рекомендуемый суточный лимит на остаток: <b>' + money(daily) + '</b>.</div>' +
      '<div class="g-demo-hint">В сервисе тот же расчёт, но точнее: план считается по ' +
      'прошедшим эфирным часам, а лимит делится на дни, когда кампания действительно ' +
      'вещает. Поэтому у кампании с расписанием цифры будут отличаться от этой прикидки.</div>';
  }
  ['pB', 'pT', 'pP', 'pS'].forEach(function (id) {
    $(id).addEventListener('input', upd);
  });
  upd();
};

/* ── планировщик: что заполняется на каждом шаге ── */
DEMOS.plannerSteps = function (host) {
  const steps = [
    { t: '1. География', items: [
        'Регион: крупные города отдельно, МО и ЛО — областью целиком',
        'Список городов можно загрузить файлом (.xlsx, .csv, .txt)',
        'Тут же видно объём доступного инвентаря'
      ] },
    { t: '2. Период', items: [
        'Даты начала и окончания',
        'Расписание: весь день 07:00–22:00, часы пик или свой график',
        'Свой график задаётся по дням недели'
      ] },
    { t: '3. Цели', items: [
        'Есть бюджет — распределит сумму по регионам',
        'Есть цель по OTS — подберёт экраны и бюджет под охват',
        'Подскажите оптимальный — соберёт адреску под адекватный охват региона',
        'НДС и комиссию системы можно включить тут же'
      ] },
    { t: '4. Настройки', items: [
        'Форматы: все, макс. охват, улицы, indoor',
        'Как собираем: равномерно, рядом с POI, рядом с адресом, вдоль маршрута',
        'Зона на карте — полигон, вне его экраны не попадут',
        'Операторы, фильтр по GRP, режим ставки: минимальная или рекомендованная'
      ] }
  ];

  host.innerHTML =
    '<div class="g-chips" id="pcChips">' + steps.map(function (s, i) {
      return '<button class="g-chip' + (i === 0 ? ' on' : '') + '" data-i="' + i + '">' +
        esc(s.t) + '</button>';
    }).join('') + '</div>' +
    '<div class="g-demo-out" id="pcOut"></div>';

  function draw(i) {
    [...$('pcChips').children].forEach(function (b, j) {
      b.classList.toggle('on', i === j);
    });
    $('pcOut').innerHTML = '<div class="g-list">' + steps[i].items.map(function (t) {
      return '<div class="g-li"><span class="m">·</span><span>' + esc(t) + '</span></div>';
    }).join('') + '</div>';
  }
  [...$('pcChips').children].forEach(function (b) {
    b.addEventListener('click', function () { draw(parseInt(b.dataset.i, 10)); });
  });
  draw(0);
};

/* ── добавление азимутов: тот самый разбор шапки, что и в инструменте ──
   Две мини-таблицы XML собираются на месте и прогоняются через
   AzimuthCore.parseRows/findHeaderCell/mergeSpan/detectDataStart — то же
   самое определяет, с какой строки реально начинаются данные (и раньше в
   похожей логике путало под-заголовок с первой строкой данных). */
DEMOS.azimuthHeader = function (host) {
  const CASES = {
    plain: {
      title: 'Обычная — без объединения',
      rows: [
        [[0, 'Оператор'], [1, 'GID'], [2, 'Город']],
        [[0, 'Оп1'], [1, 'G-001'], [2, 'Казань']],
        [[0, 'Оп1'], [1, 'G-002'], [2, 'Уфа']]
      ],
      note: 'Данные начинаются сразу после шапки — раньше здесь и терялась первая строка.'
    },
    sub: {
      title: 'С под-заголовком',
      rows: [
        [[0, 'Оператор'], [1, 'GID'], [2, 'Показы']],
        [[2, 'Кол-во']],
        [[0, 'Оп1'], [1, 'G-777'], [2, 10]]
      ],
      note: 'В строке 2 ячейка GID пуста — это и есть настоящий признак подзаголовка, а не «в строке хоть что-то есть».'
    }
  };

  function buildXml(rowsSpec) {
    let x = '';
    rowsSpec.forEach(function (cells, i) {
      const num = i + 1;
      x += '<row r="' + num + '">';
      cells.forEach(function (pair) {
        const ref = L.indexToCol(pair[0]) + num;
        x += (typeof pair[1] === 'number')
          ? '<c r="' + ref + '" t="n"><v>' + pair[1] + '</v></c>'
          : '<c r="' + ref + '" t="inlineStr"><is><t>' + L.escapeXml(String(pair[1])) + '</t></is></c>';
      });
      x += '</row>';
    });
    return x;
  }

  host.innerHTML =
    '<div class="g-chips" id="azChips">' + Object.keys(CASES).map(function (k, i) {
      return '<button class="g-chip' + (i === 0 ? ' on' : '') + '" data-k="' + k + '">' + esc(CASES[k].title) + '</button>';
    }).join('') + '</div>' +
    '<div class="g-mini-wrap" style="margin-top:12px"><table class="g-mini">' +
      '<thead><tr><th>№</th><th>A</th><th>B</th><th>C</th><th></th></tr></thead>' +
      '<tbody id="azBody"></tbody></table></div>' +
    '<div class="g-demo-out" id="azOut"></div>';

  function draw(key) {
    [...$('azChips').children].forEach(function (b) { b.classList.toggle('on', b.dataset.k === key); });
    const c = CASES[key];
    const xml = buildXml(c.rows);
    const rows = AZ.parseRows(xml);
    const rowByNum = new Map(rows.map(function (r) { return [r.num, r]; }));
    const gidHit = AZ.findHeaderCell(rows, 'GID', 20, null);
    const maxRow = rows.reduce(function (m, r) { return Math.max(m, r.num); }, 0);
    const span = gidHit ? AZ.mergeSpan(xml, gidHit.row, gidHit.col) : null;
    const dataStart = span ? AZ.detectDataStart(rowByNum, maxRow, span.end, gidHit.col, null) : null;

    $('azBody').innerHTML = c.rows.map(function (cells, i) {
      const num = i + 1;
      const byCol = new Map(cells);
      const isHeader = gidHit && num === gidHit.row;
      const isData = num === dataStart;
      const skipped = !isHeader && dataStart && num < dataStart;
      const kind = isHeader ? 'шапка' : (isData ? 'данные ↓' : (skipped ? 'подзаголовок' : ''));
      const cls = skipped ? 'out' : (isData ? 'hit' : '');
      const tds = [0, 1, 2].map(function (col) {
        return '<td>' + (byCol.has(col) ? esc(byCol.get(col)) : '') + '</td>';
      });
      return '<tr class="' + cls + '"><td class="muted">' + num + '</td>' + tds.join('') +
        '<td class="muted">' + kind + '</td></tr>';
    }).join('');

    $('azOut').innerHTML = '<div class="g-out-k">' + esc(c.note) + ' Вычислено: шапка в строке <b>' +
      (gidHit ? gidHit.row : '—') + '</b>, данные — с строки <b>' + dataStart + '</b>.</div>';
  }
  [...$('azChips').children].forEach(function (b) {
    b.addEventListener('click', function () { draw(b.dataset.k); });
  });
  draw('plain');
};

/* Показывает ту же перестановку столбцов, что и настоящий инвенто-инструмент
   (IC.remapColumn): удаление «Комиссия платформы» + вставка «№» в начало —
   без пересборки стилей, только координаты. */
DEMOS.reportsColumns = function (host) {
  const HEADERS = ['Оператор', 'Город', 'GID', 'Формат экрана', 'Адрес', 'Сторона',
    'Фото', 'CPT', 'Кол-во показов', 'Бюджет', 'Комиссия платформы', 'Сумма OTS'];
  const dropCol0 = 10; // «Комиссия платформы» — 0-based индекс

  host.innerHTML =
    '<div class="g-mini-wrap"><table class="g-mini">' +
    '<thead><tr><th>Было</th><th>Столбец</th><th>Стало</th></tr></thead>' +
    '<tbody id="repBody"></tbody></table></div>' +
    '<div class="g-demo-out" id="repOut"></div>';

  $('repBody').innerHTML = HEADERS.map(function (h, i) {
    const newCol0 = IC.remapColumn(i, dropCol0);
    const dropped = newCol0 === null;
    const was = L.indexToCol(i), now = dropped ? '—' : L.indexToCol(newCol0);
    return '<tr class="' + (dropped ? 'out' : (i === 0 ? 'hit' : '')) + '">' +
      '<td class="muted">' + was + '</td><td>' + esc(h) + '</td>' +
      '<td class="muted">' + now + (dropped ? ' (удалён)' : '') + '</td></tr>';
  }).join('');

  $('repOut').innerHTML = '<div class="g-out-k">Столбец «№» (новый, сюда не входит) встаёт в A — всё, что было ' +
    'ДО «Комиссия платформы», сдвигается на 1 вправо; всё, что ПОСЛЕ — остаётся на месте (сдвиги от удаления ' +
    'и от вставки гасят друг друга). Стиль каждой ячейки при этом не пересобирается — переезжает целиком.</div>';
};

/* ── видео: пересчёт разрешения и план удлинения настоящим кодом ── */
DEMOS.videoScale = function (host) {
  host.innerHTML =
    '<div class="g-demo-row">' +
      '<div class="field"><label>Ролик</label><select id="vSrc">' +
        '<option value="1920x1080x10">1920×1080, 10 с</option>' +
        '<option value="720x360x5">720×360, 5 с</option>' +
        '<option value="1080x1920x15">1080×1920, 15 с</option>' +
      '</select></div>' +
      '<div class="field"><label>Вписать в ширину</label><select id="vW">' +
        '<option>1280</option><option selected>720</option><option>640</option><option>2560</option>' +
      '</select></div>' +
      '<div class="field"><label>Нужная длительность, с</label><select id="vDur">' +
        '<option>5</option><option selected>25</option><option>30</option>' +
      '</select></div>' +
    '</div>' +
    '<div class="g-demo-out" id="vOut"></div>';

  function upd() {
    const p = $('vSrc').value.split('x');
    const sw = +p[0], sh = +p[1], sd = +p[2];
    const scale = VD.scaleTo(sw, sh, +$('vW').value, null);
    const loop = VD.loopPlan(sd, +$('vDur').value);

    const res = scale
      ? '<div class="g-out-big">' + scale.w + '×' + scale.h + '</div>' +
        '<div class="g-out-k">Пропорции те же, стороны округлены до чётных — иначе H.264 ' +
        'не возьмёт кадр. Увеличивать инструмент не станет.</div>'
      : '<div class="g-out-none">разрешение оставим как есть</div>' +
        '<div class="g-out-k">Заданная ширина не меньше исходной: растянуть можно, но резче ' +
        'ролик от этого не станет.</div>';

    const dur = loop
      ? '<div class="g-out-k" style="margin-top:9px">Длительность ' + sd + ' → ' + $('vDur').value +
        ' с: ролик пройдёт ' + loop.copies + ' ' + VD.plural(loop.copies, ['раз', 'раза', 'раз']) +
        (loop.whole ? ' целиком.' : ', последний повтор обрежется на ' + VD.fmtNum(loop.lastCut, 2) + ' с.') +
        '</div>'
      : '<div class="g-out-k" style="margin-top:9px">Длительность ' + sd + ' → ' + $('vDur').value +
        ' с: удлинять не нужно, лишнее просто обрежется с конца.</div>';

    $('vOut').innerHTML = res + dur;
  }
  ['vSrc', 'vW', 'vDur'].forEach(function (id) { $(id).addEventListener('change', upd); });
  upd();
};

/* ════════════════════════════════ запуск ════════════════════════════════ */

if (!guide) {
  document.body.innerHTML =
    '<div class="g-card"><div class="note err" style="margin-top:24px">' +
    'Не понимаю, гайд какого инструмента открывать: в адресе нет <code>#tool=…</code>.' +
    '</div></div>';
} else {
  $('gIcon').textContent = guide.letter || '?';
  if (guide.ext) $('gIcon').classList.add('ext');
  $('gTitle').textContent = guide.title;
  $('gSub').textContent = guide.ext
    ? 'внешний сервис · как это работает'
    : 'как это работает';
  document.title = guide.title + ' — гайд';

  render();
  post({ action: 'seen', tool: toolId });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') go(idx + 1);
    else if (e.key === 'ArrowLeft') go(idx - 1);
    else if (e.key === 'Escape') post({ action: 'close' });
    else return;
    e.preventDefault();
  });
}

})(typeof globalThis !== 'undefined' ? globalThis : this);
