# -*- coding: utf-8 -*-
"""
Сборка панели инструментов Omni360 в один offline-HTML.

1) Собирает каждый инструмент в самостоятельный HTML (инлайнит lib/*).
2) Пересобирает bundle: добавляет три инструмента в manifest + ext_resources
   и переключает их карточки в шаблоне с заметки на iframe.

Запуск:  python build.py
"""
import base64
import gzip
import hashlib
import json
import os
import re
import sys

sys.stdout.reconfigure(encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, 'lib')
TOOLS = os.path.join(HERE, 'tools')
DIST = os.path.join(HERE, 'dist')

BUNDLE_NAME = 'Omni360 - Панель инструментов (offline).html'

# Исходная панель БЕЗ наших инструментов (только калькулятор и карта).
# Лежит рядом, в source/ — чтобы сборку можно было повторить в любой момент,
# не завися от того, что сейчас в Downloads.
SRC_BUNDLE = os.path.join(HERE, 'source', BUNDLE_NAME)

# id ресурса в bundle → файл инструмента.
# omnibuyTool и mapTool уже были в исходной панели — для них переиспользуем
# существующий uuid, чтобы старый блоб не оставался в manifest мёртвым грузом.
NEW_TOOLS = [
    ('techreqTool',   'techreq.html'),
    ('creativesTool', 'creatives.html'),
    ('addressesTool', 'addresses.html'),
    ('mergeTool',     'merge.html'),
    ('azimuthTool',   'azimuth.html'),
    ('reportsTool',   'reports.html'),
    ('omnibuyTool',   'omnibuy.html'),
    ('mapTool',       'map.html'),
    # Гайды — такая же страница в iframe, только вместо инструмента показывает
    # рассказ о нём. Какой именно — задаёт #tool=<id> в адресе.
    ('guideTool',     'guide.html'),
]

INJECT_RE = re.compile(r'/\*__INJECT:([A-Za-z0-9_.\-]+)__\*/')

# Инструмент «Подбор адресов» ходит за данными через функции Netlify
# (netlify/functions/*.mjs). Ключ 2ГИС лежит в переменной окружения GIS_API_KEY
# на Netlify: ни в репозитории, ни в исходнике страницы его нет, и вводить
# пользователю ничего не нужно.
ENDPOINTS = {'mode': 'proxy', 'gis': '/api/2gis', 'geocode': '/api/geocode'}


def endpoints_js():
    """JS-настройка эндпоинтов, вставляется перед addresses-core.js."""
    return 'window.OMNI_ENDPOINTS = ' + json.dumps(ENDPOINTS, ensure_ascii=False) + ';'


def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


def build_tool(filename):
    """Инлайнит /*__INJECT:file__*/ содержимым lib/file."""
    src = read(os.path.join(TOOLS, filename))
    used = []

    def sub(m):
        name = m.group(1)
        path = os.path.join(LIB, name)
        if not os.path.exists(path):
            raise SystemExit(f'{filename}: нет файла для вставки: lib/{name}')
        used.append(name)
        text = read(path)
        # настройку эндпоинтов кладём перед ядром адресов
        if name == 'addresses-core.js':
            text = endpoints_js() + '\n' + text
        # чтобы вставленный код не закрыл наш <script> раньше времени
        return text.replace('</script>', '<\\/script>')

    out = INJECT_RE.sub(sub, src)
    left = INJECT_RE.findall(out)
    if left:
        raise SystemExit(f'{filename}: остались невставленные метки: {left}')

    # В отдельном инструменте никаких uuid быть не должно — а ключ 2ГИС выглядит
    # именно как uuid. Так что любое совпадение здесь — утечка секрета.
    m = re.search(r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b', out)
    if m:
        raise SystemExit(
            f'{filename}: в собранный файл попал похожий на ключ API идентификатор '
            f'{m.group(0)} — уберите его, репозиторий публичный')
    return out, used


# Старый ключ 2ГИС из script.py задан хешем, а не текстом: сам файл лежит
# в публичном репозитории, и держать в нём секрет ради проверки на секреты
# было бы странно.
LEAKED_KEY_SHA256 = '7e84bf8a62f25f99f9c63150139e4648e2004d410d1bc6400fdea05302d55ce0'

UUID_RE = re.compile(r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b')


def check_no_secrets(path):
    """В панели куча законных uuid ресурсов, поэтому проверяем каждый по списку.
    Ключ API выглядит как uuid, так что любой незнакомый — повод остановиться."""
    blob = read(path)
    known = set(UUIDS.values()) | KNOWN_BUNDLE_UUIDS
    for m in UUID_RE.finditer(blob):
        val = m.group(0)
        if val in known:
            continue
        if hashlib.sha256(val.encode()).hexdigest() == LEAKED_KEY_SHA256:
            raise SystemExit(
                f'{os.path.basename(path)}: внутри старый ключ 2ГИС — коммитить нельзя. '
                'Ключ должен жить только в переменной GIS_API_KEY на Netlify.')
        raise SystemExit(
            f'{os.path.basename(path)}: неизвестный uuid {val} — проверьте, не ключ ли это')


# детерминированные uuid для новых ресурсов bundle
UUIDS = {
    'techreqTool':   '7c1f9a20-4d3b-4f57-9e1a-2b8c6d0f3a41',
    'creativesTool': '9b2e7c31-5f4a-4c68-8d2b-3e7f1a9c4b52',
    'addressesTool': 'a3d5f842-6e1b-4d79-9c3e-4f8a2b6d5c63',
    'mergeTool':     'b7e419d6-8c25-4a3f-91d4-5a6c7e8b9f70',
    'guideTool':     'c8f52ae3-9d16-4b48-82e5-6b7d8fa9c081',
    'azimuthTool':   'd4a67c19-2e5f-4b83-a196-7c3f0e8b5d42',
    'reportsTool':   'e5b83d24-3f6a-4c95-a207-8d4e1b7c6a93',
}

# uuid ресурсов, которые были в исходной панели (калькулятор, карта, react, рантайм).
# Заполняется при чтении исходника — нужно, чтобы проверка на секреты их не путала с ключом.
KNOWN_BUNDLE_UUIDS = set()


PANEL_TEMPLATE = os.path.join(HERE, 'panel', 'template.html')


def build_panel_template(orig_template):
    """Наш шаблон панели + подстановки из исходного.

    Из исходника берём ровно две вещи: uuid рантайма x-dc (его подменяет на blob
    сам загрузчик панели) и значение data-props (описание свойств для редактора).
    """
    tpl = read(PANEL_TEMPLATE)

    m = re.search(r'<script src="([0-9a-f-]{36})"></script>', orig_template)
    if not m:
        raise SystemExit('не нашёл в исходном шаблоне подключение рантайма x-dc')
    runtime_uuid = m.group(1)

    m = re.search(r'data-props="([^"]*)"', orig_template)
    if not m:
        raise SystemExit('не нашёл в исходном шаблоне data-props')
    dc_props = m.group(1)

    for token, value in (('__DC_RUNTIME__', runtime_uuid), ('__DC_PROPS__', dc_props)):
        if token not in tpl:
            raise SystemExit(f'{PANEL_TEMPLATE}: нет метки {token}')
        tpl = tpl.replace(token, value)

    print(f'  шаблон панели: panel/template.html (рантайм {runtime_uuid[:8]}…)')
    return tpl


def make_bundle(built):
    """Собирает панель, встраивая переданные HTML инструментов. Возвращает текст файла."""
    lines = read(SRC_BUNDLE).split('\n')
    # индексы строк с данными (проверяем по маркерам, а не по номерам)
    idx = {}
    for i, ln in enumerate(lines):
        m = re.search(r'<script type="__bundler/(manifest|ext_resources|page_order|template)">', ln)
        if m:
            idx[m.group(1)] = i + 1        # данные — на следующей строке
    for k in ('manifest', 'ext_resources', 'template'):
        if k not in idx:
            raise SystemExit(f'не нашёл в bundle секцию {k}')

    manifest = json.loads(lines[idx['manifest']])
    ext = json.loads(lines[idx['ext_resources']])
    template = json.loads(lines[idx['template']])

    KNOWN_BUNDLE_UUIDS.update(manifest.keys())

    for u in UUIDS.values():
        if u in manifest:
            raise SystemExit(f'uuid уже занят в manifest: {u}')

    uuid_by_id = {e['id']: e['uuid'] for e in ext}
    for res_id, _fn in NEW_TOOLS:
        html = built[res_id]
        # ресурс уже был в панели → пишем на его место, иначе берём свой uuid
        uuid = uuid_by_id.get(res_id) or UUIDS[res_id]
        raw = html.encode('utf-8')
        gz = gzip.compress(raw, 9, mtime=0)
        manifest[uuid] = {
            'mime': 'text/html',
            'compressed': True,
            'data': base64.b64encode(gz).decode('ascii'),
        }
        if res_id not in uuid_by_id:
            ext.append({'id': res_id, 'uuid': uuid})
            uuid_by_id[res_id] = uuid

    # ── шаблон панели целиком берём из panel/template.html ──
    template = build_panel_template(template)

    # каждый window.__resources.X должен существовать в ext_resources,
    # иначе карточка молча откроется пустой
    available = {e['id'] for e in ext}
    for ref in sorted(set(re.findall(r'window\.__resources\.(\w+)', template))):
        if ref not in available:
            raise SystemExit(f'шаблон ссылается на ресурс {ref}, которого нет в ext_resources')
    print(f'  ресурсы шаблона на месте: {len(available)}')

    def dump(obj):
        """JSON для вставки внутрь <script>…</script>.

        Обязательно экранируем '</' как '<\\u002F' — иначе парсер HTML закроет
        наш script-тег на первом же '</script>' внутри данных и JSON оборвётся.
        Ровно так же сделано в исходном bundle.
        """
        s = json.dumps(obj, ensure_ascii=False, separators=(',', ':'))
        return s.replace('</', '<\\u002F')

    lines[idx['manifest']] = dump(manifest)
    lines[idx['ext_resources']] = dump(ext)
    lines[idx['template']] = dump(template)

    # ── самопроверка: данные не должны рвать script-тег и должны парситься ──
    for key, want in (('manifest', manifest), ('ext_resources', ext), ('template', template)):
        line = lines[idx[key]]
        if '</' in line:
            raise SystemExit(f'{key}: в данных остался "</" — HTML закроет script-тег раньше времени')
        if '\n' in line or '\r' in line:
            raise SystemExit(f'{key}: в данных перевод строки — bundle читает ровно одну строку')
        if json.loads(line) != want:
            raise SystemExit(f'{key}: JSON не совпал после кодирования')

    return '\n'.join(lines), len(manifest), len(ext)


DATA_DIR = os.path.join(HERE, 'data')


def copy_data():
    """Статические данные (сейчас — только инвентарь для добавления азимутов)
    копируются в dist/data как есть и раздаются Netlify напрямую, без прокси:
    файл не секретный, ключа в нём нет. tools/azimuth.html берёт его по
    абсолютному URL (location.origin + '/data/...') — относительный путь не
    резолвится из документа на blob:, как и с /api/* у подбора адресов."""
    if not os.path.isdir(DATA_DIR):
        return
    out_dir = os.path.join(DIST, 'data')
    os.makedirs(out_dir, exist_ok=True)
    import shutil
    for name in os.listdir(DATA_DIR):
        shutil.copy2(os.path.join(DATA_DIR, name), os.path.join(out_dir, name))
        size = os.path.getsize(os.path.join(out_dir, name))
        print(f'  data/{name}  ({size / 1024 / 1024:.1f} МБ)')


def main():
    if not os.path.exists(SRC_BUNDLE):
        raise SystemExit(
            f'нет исходной панели: {SRC_BUNDLE}\n'
            'Положи туда версию БЕЗ трёх новых инструментов (с карточками note:).')

    os.makedirs(os.path.join(DIST, 'tools'), exist_ok=True)

    print('── статические данные ──')
    copy_data()

    print('── сборка инструментов ──')
    web = {}
    for res_id, fn in NEW_TOOLS:
        html, used = build_tool(fn)
        web[res_id] = html
        with open(os.path.join(DIST, 'tools', fn), 'w', encoding='utf-8') as f:
            f.write(html)
        print(f'  {fn:16} {len(html):>7} символов  ← {", ".join(used)}')

    index_html, n_man, n_ext = make_bundle(web)
    index_path = os.path.join(DIST, 'index.html')
    with open(index_path, 'w', encoding='utf-8') as f:
        f.write(index_html)
    print(f'  панель: manifest {n_man} ресурсов, ext_resources {n_ext}')

    # ── ключа не должно быть ни в одном артефакте: репозиторий публичный ──
    check_no_secrets(index_path)
    print('  проверка: ключей API в собранных файлах нет')

    print()
    print('готово:')
    print(f'  панель   {index_path}  ({os.path.getsize(index_path) / 1024:.0f} КБ)')
    print(f'  отдельно {os.path.join(DIST, "tools")}')
    print()
    print('Ключ 2ГИС задаётся переменной GIS_API_KEY в настройках Netlify.')


if __name__ == '__main__':
    main()
