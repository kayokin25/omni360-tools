/* Проверка расчётов правки видео. Без ffmpeg и без браузера: здесь только
   арифметика пропорций, сборка аргументов и разбор лога.
   Запуск: node lib/test_video.mjs                                          */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const V = require('./video-core.js');

let fails = 0;
function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: ${g}${ok ? '' : '  != эталон ' + w}`);
}

console.log('=== scaleTo: пропорции и чётные стороны ===');
eq('1920x1080 по ширине 1280', V.scaleTo(1920, 1080, 1280, null), { w: 1280, h: 720 });
eq('1920x1080 по высоте 720', V.scaleTo(1920, 1080, null, 720), { w: 1280, h: 720 });
eq('вписать 1920x1080 в 1000x1000', V.scaleTo(1920, 1080, 1000, 1000), { w: 1000, h: 562 });
eq('нечётное округляется до чётного', V.scaleTo(1080, 1921, 540, null), { w: 540, h: 960 });
eq('заданный размер больше исходного — не трогаем', V.scaleTo(720, 360, 1920, null), null);
eq('ровно исходный размер — не трогаем', V.scaleTo(720, 360, 720, 360), null);
eq('без исходного разрешения нечего считать', V.scaleTo(0, 0, 640, null), null);

console.log('=== loopPlan: удлинение повтором ===');
eq('10 с → 25 с', V.loopPlan(10, 25), { copies: 3, lastCut: 5, whole: false });
eq('10 с → 30 с укладывается целиком', V.loopPlan(10, 30), { copies: 3, lastCut: 10, whole: true });
eq('обрезка — не удлинение', V.loopPlan(10, 5), null);
eq('та же длительность — не удлинение', V.loopPlan(10, 10), null);

console.log('=== buildArgs ===');
eq('обрезка до 5 с, без звука, 2000 кбит/с, 640x320',
  V.buildArgs({ inName: 'in.mp4', outName: 'out.mp4', srcDur: 10, targetDur: 5,
                scale: { w: 640, h: 320 }, mute: true, bitrateK: 2000 }),
  ['-i', 'in.mp4', '-t', '5', '-vf', 'scale=640:320',
   '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
   '-b:v', '2000k', '-maxrate', '2000k', '-bufsize', '4000k', '-an',
   '-movflags', '+faststart', '-y', 'out.mp4']);

eq('удлинение до 25 с — -stream_loop строго до -i',
  V.buildArgs({ inName: 'in.mp4', outName: 'out.mp4', srcDur: 10, targetDur: 25,
                scale: null, mute: false, bitrateK: null }),
  ['-stream_loop', '-1', '-i', 'in.mp4', '-t', '25',
   '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-crf', '20',
   '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', 'out.mp4']);

console.log('=== parseProbe ===');
const LOG = [
  'Input #0, mov,mp4,m4a,3gp,3g2,mj2, from \'in.mp4\':',
  '  Metadata:',
  '    encoder         : Lavf60.3.100',
  '  Duration: 00:00:10.04, start: 0.000000, bitrate: 1509 kb/s',
  '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 720x360 [SAR 1:1 DAR 2:1], 1506 kb/s, 25 fps, 25 tbr, 12800 tbn (default)',
  '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)'
].join('\n');
eq('лог со звуком', V.parseProbe(LOG),
  { durSec: 10.04, width: 720, height: 360, fps: 25,
    videoKbps: 1506, totalKbps: 1509, hasAudio: true });
eq('без звуковой дорожки hasAudio=false',
  V.parseProbe(LOG.split('\n').slice(0, -1).join('\n')).hasAudio, false);
eq('пустой лог не роняет разбор', V.parseProbe('').width, null);

console.log('=== disclaimer ===');
const d = V.disclaimer([{ w: 720, h: 36 }], 720, 360);
eq('полоса на всю ширину: 10% высоты и 10% площади',
  [d.rows[0].hPct, d.rows[0].areaPct, d.rows[0].wPct], [10, 10, 100]);
const d2 = V.disclaimer([{ w: 360, h: 36 }, { w: 72, h: 72 }], 720, 360);
eq('две рамки: «всего» — сумма высот и площадей',
  [Math.round(d2.total.hPct * 100) / 100, Math.round(d2.total.areaPct * 100) / 100,
   d2.total.hPx], [30, 7, 108]);
eq('кадр без размера не делит на ноль', V.disclaimer([{ w: 10, h: 10 }], 0, 0).rows[0].areaPct, 0);

console.log('=== мелочи ===');
eq('outName', V.outName('Регионы_РИМ_DBB_720x360_10s.mp4', ['640x320', '5 с', 'без звука']),
  'Регионы_РИМ_DBB_720x360_10s — 640x320 5 с без звука.mp4');
eq('outName без правок', V.outName('крео.mp4', []), 'крео — правка.mp4');
eq('fmtNum целое', V.fmtNum(5), '5');
eq('fmtNum дробное', V.fmtNum(5.25), '5,25');
eq('fmtNum округление', V.fmtNum(6.666, 1), '6,7');

eq('plural 1', V.plural(1, ['раз', 'раза', 'раз']), 'раз');
eq('plural 3', V.plural(3, ['раз', 'раза', 'раз']), 'раза');
eq('plural 5', V.plural(5, ['раз', 'раза', 'раз']), 'раз');
eq('plural 11', V.plural(11, ['раз', 'раза', 'раз']), 'раз');
eq('plural 22', V.plural(22, ['раз', 'раза', 'раз']), 'раза');

console.log(fails ? `\n${fails} проверок не прошло` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
