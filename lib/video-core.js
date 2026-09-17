/* ============================================================================
   Правка видео под ТТ — расчёты.

   Здесь нет ни ffmpeg, ни DOM: только собрать аргументы командной строки,
   разобрать лог ffmpeg и посчитать проценты дисклеймера. Кодирует уже сам
   ffmpeg.wasm в tools/video.html, а эти функции проверяются в node
   (lib/test_video.mjs) — иначе арифметику пропорций пришлось бы проверять
   тридцатимегабайтным wasm-ом.
   ========================================================================== */
(function (root) {
'use strict';

/* Кодировщики H.264 не берут нечётные стороны при yuv420p — округляем до
   чётного сразу, а не ловим потом «width not divisible by 2». */
function even(x) {
  return Math.max(2, Math.round(x / 2) * 2);
}

/* Новое разрешение с сохранением пропорций: вписываем в заданные габариты,
   любой из них можно не задавать. Увеличивать не берёмся — пропорции-то
   сохранятся, а резкость нет, поэтому null: «оставить как есть». */
function scaleTo(srcW, srcH, wantW, wantH) {
  if (!srcW || !srcH) return null;
  let k = 1;
  if (wantW) k = Math.min(k, wantW / srcW);
  if (wantH) k = Math.min(k, wantH / srcH);
  if (k >= 1) return null;
  return { w: even(srcW * k), h: even(srcH * k) };
}

/* План удлинения: сколько раз ролик пройдёт целиком и где обрежется последний
   повтор. Нужен, чтобы предупредить заранее — «повторится 2,5 раза» выглядит
   в отчёте оператору совсем не так, как «повторится 3 раза». */
function loopPlan(srcDur, targetDur) {
  if (!srcDur || !targetDur || targetDur <= srcDur + 0.05) return null;
  const copies = Math.ceil(targetDur / srcDur);
  const lastCut = targetDur - srcDur * (copies - 1);
  return { copies: copies, lastCut: lastCut, whole: Math.abs(lastCut - srcDur) < 0.05 };
}

/* Кадров в секунду у ролика из картинки: меньше 25 операторы не берут, больше
   для неподвижного кадра бессмысленно. */
const STILL_FPS = 25;
/* Сколько секунд крутить картинку, если длительность не задали. */
const STILL_DEFAULT_SEC = 10;

/* Аргументы ffmpeg. Порядок важен: -stream_loop и -loop — опции входа, поэтому
   строго до -i, а -t — опция выхода, строго после.

   still: вход — неподвижная картинка. Тогда вместо повторов ролика крутится
   один кадр (-loop 1), длительность обязательна (иначе ffmpeg кодирует
   бесконечно), звука нет по определению. Нужно это затем, что часть
   операторов не принимает изображения вовсе: Russ Outdoor на десятисекундном
   билборде берёт только видео (Катя, 17.09). */
function buildArgs(o) {
  const a = [];
  const still = !!o.still;
  const dur = still
    ? (o.targetDur || STILL_DEFAULT_SEC)
    : o.targetDur;

  if (still) a.push('-loop', '1');
  else if (loopPlan(o.srcDur, o.targetDur)) a.push('-stream_loop', '-1');
  a.push('-i', o.inName);
  if (dur) a.push('-t', String(Math.round(dur * 1000) / 1000));
  if (o.scale) a.push('-vf', 'scale=' + o.scale.w + ':' + o.scale.h);
  /* Картинке размер никто не подбирал под кодировщик: 601×476 роняет libx264
     («width not divisible by 2»). Округляем стороны вниз до чётных, когда
     своего масштаба не задали. */
  else if (still) a.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2');
  if (still) a.push('-r', String(o.fps || STILL_FPS));

  a.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
  if (o.bitrateK) {
    /* Операторы пишут в ТТ «не выше N» — значит нужен потолок, а не средний
       битрейт: одного -b:v мало, он про среднее. */
    a.push('-b:v', o.bitrateK + 'k', '-maxrate', o.bitrateK + 'k',
           '-bufsize', (o.bitrateK * 2) + 'k');
  } else {
    a.push('-crf', '20');
  }

  if (still || o.mute) a.push('-an');
  else a.push('-c:a', 'aac', '-b:a', '128k');

  a.push('-movflags', '+faststart', '-y', o.outName);
  return a;
}

/* Разбор того, что ffmpeg печатает на «-i файл» без выхода. Свойств у видео
   больше, чем отдаёт браузерный <video> (битрейт и наличие звука он не знает),
   а лишний проход всё равно нужен — файл после него уже в памяти ffmpeg. */
function parseProbe(logText) {
  const t = String(logText || '');
  const out = { durSec: null, width: null, height: null, fps: null,
                videoKbps: null, totalKbps: null, hasAudio: false };

  const d = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(t);
  if (d) out.durSec = (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]);

  const tb = /Duration:[^\n]*?bitrate:\s*(\d+)\s*kb\/s/.exec(t);
  if (tb) out.totalKbps = +tb[1];

  const v = /Stream #\d+:\d+[^\n]*?: Video:[^\n]*/.exec(t);
  if (v) {
    const res = /,\s*(\d{2,5})x(\d{2,5})/.exec(v[0]);
    if (res) { out.width = +res[1]; out.height = +res[2]; }
    const br = /,\s*(\d+)\s*kb\/s/.exec(v[0]);
    if (br) out.videoKbps = +br[1];
    const fps = /,\s*([\d.]+)\s*fps/.exec(v[0]);
    if (fps) out.fps = parseFloat(fps[1]);
  }
  out.hasAudio = /Stream #\d+:\d+[^\n]*?: Audio:/.test(t);
  return out;
}

/* Дисклеймер: рамки заданы в пикселях кадра, а не экрана, — считать проценты
   по картинке на странице нельзя, она масштабирована по ширине карточки.
   Рамок может быть несколько (текст предупреждения и знак возраста — это два
   разных объекта), «всего» тогда сумма. Пересечения рамок не вычитаются:
   мерить один и тот же объект дважды смысла нет. */
function disclaimer(boxes, frameW, frameH) {
  const area = (frameW || 0) * (frameH || 0);
  const rows = [];
  let sumH = 0, sumArea = 0;

  for (const b of boxes) {
    const w = Math.round(b.w), h = Math.round(b.h);
    const r = {
      wPx: w, hPx: h,
      wPct: frameW ? w / frameW * 100 : 0,
      hPct: frameH ? h / frameH * 100 : 0,
      areaPct: area ? w * h / area * 100 : 0
    };
    rows.push(r);
    sumH += h;
    sumArea += r.areaPct;
  }

  return {
    rows: rows,
    total: { hPx: sumH, hPct: frameH ? sumH / frameH * 100 : 0, areaPct: sumArea }
  };
}

/* Имя выходного файла: «крео.mp4» + ['720x360', '5 с'] → «крео — 720x360 5 с.mp4».
   Видно, что именно правили, и файл не затирает исходник в папке загрузок. */
function outName(srcName, parts) {
  const base = String(srcName || 'видео').replace(/\.[^.]*$/, '');
  return base + ' — ' + (parts.length ? parts.join(' ') : 'правка') + '.mp4';
}

/* 5 → «5», 5.25 → «5,25»: запятая, потому что читают это в русских ТТ. */
function fmtNum(x, digits) {
  const n = Number(x);
  if (!isFinite(n)) return '';
  const s = n.toFixed(digits === undefined ? 2 : digits)
             .replace(/\.?0+$/, '');
  return s.replace('.', ',');
}

/* «ролик пройдёт 3 раз» читается как опечатка. forms — [1, 2-4, 5-20]. */
function plural(n, forms) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

root.VideoCore = {
  STILL_FPS: STILL_FPS,
  STILL_DEFAULT_SEC: STILL_DEFAULT_SEC,
  even: even,
  scaleTo: scaleTo,
  loopPlan: loopPlan,
  buildArgs: buildArgs,
  parseProbe: parseProbe,
  disclaimer: disclaimer,
  outName: outName,
  fmtNum: fmtNum,
  plural: plural
};

})(typeof globalThis !== 'undefined' ? globalThis : this);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.VideoCore;
