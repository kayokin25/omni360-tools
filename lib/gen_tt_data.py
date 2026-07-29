# -*- coding: utf-8 -*-
"""Генерирует lib/tt-data.js из tt.py — чтобы словари не расходились."""
import importlib.util, json, os, sys
sys.stdout.reconfigure(encoding='utf-8')

TT = r'C:\Users\tuefr\OneDrive\Desktop\работа\скрипты\тт\новое\tt.py'
spec = importlib.util.spec_from_file_location('tt_src', TT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)   # main() не вызывается — она под __main__

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tt-data.js')

durations = [[op, fmt, d] for (op, fmt), d in m.INVENTORY_DURATIONS.items()]
data = {
    'YADISK_PUBLIC_KEY': m.YADISK_PUBLIC_KEY,
    'LINK_DISPLAY_TEXT': m.LINK_DISPLAY_TEXT,
    'OPERATOR_ALIASES': m.OPERATOR_ALIASES,
    'RUSS_OPERATORS': sorted(m.RUSS_OPERATORS),
    'RUSS_10SEC_FORMATS': sorted(m.RUSS_10SEC_FORMATS),
    'MAER_OUTDOOR_OPERATORS': sorted(m.MAER_OUTDOOR_OPERATORS),
    'FLAT_DURATIONS': m.FLAT_DURATIONS,
    'INVENTORY_DURATIONS': durations,
}

js = ('/* Автогенерировано из tt.py — не править руками.\n'
      '   Пересобрать: python lib/gen_tt_data.py */\n'
      '(function (root) {\n  root.TTData = ')
js += json.dumps(data, ensure_ascii=False, indent=2).replace('\n', '\n  ')
js += (';\n})(typeof globalThis !== "undefined" ? globalThis : this);\n'
       'if (typeof module !== "undefined" && module.exports) module.exports = globalThis.TTData;\n')

open(out, 'w', encoding='utf-8').write(js)

print('записано:', out)
print('  пар (оператор, формат):', len(durations))
print('  алиасов операторов:', len(m.OPERATOR_ALIASES))
print('  RUSS_OPERATORS (норм.):', sorted(m.RUSS_OPERATORS))
print('  RUSS_10SEC_FORMATS:', sorted(m.RUSS_10SEC_FORMATS))
print('  MAER_OUTDOOR (норм.):', sorted(m.MAER_OUTDOOR_OPERATORS))
print('  FLAT_DURATIONS (норм.):', m.FLAT_DURATIONS)
print('  YADISK:', m.YADISK_PUBLIC_KEY)
print('  LINK_DISPLAY_TEXT:', m.LINK_DISPLAY_TEXT)

# заодно выгрузим эталон: что tt.py насчитает по тестовому АП
print()
print('=== эталон lookup_duration по нескольким парам ===')
for op, fmt in [('РИМ', 'BILLBOARD'), ('Russ Outdoor', 'CITY_FORMAT'), ('Russ Outdoor', 'BILLBOARD'),
                ('MAER (Outdoor)', 'BILLBOARD'), ('MAER (Outdoor)', 'MEDIAFACADE'),
                ('РА "ЦВЕТ"', 'BILLBOARD'), ('LBL', 'MEDIAFACADE'), ('LBL', 'BILLBOARD'),
                ('РА Прайм', 'BILLBOARD'), ('Реклама центр OUTDOOR', 'BILLBOARD'),
                ('НетТакого', 'BILLBOARD')]:
    print(f'  {op!r:32} {fmt:14} -> {m.lookup_duration(op, fmt)}')

print()
print('=== эталон parse_filename ===')
for nm in ['Русс 1080х1920.pdf', 'Инсайт.jpg', 'Мособл 960х480 2:1.jpg', 'РА Цвет 720х360.png',
           'Аффикс Групп 2:1.jpg', 'Хэт-Трик общее.jpg', '2 Этаж 3к1.png', 'РЦ 1440х720 2:1.pdf']:
    print(f'  {nm!r:34} -> {m.parse_filename(nm)}')

print()
print('=== эталон operator_token ===')
for nm in ['Russ Outdoor', 'MAER (Outdoor)', 'РА "ЦВЕТ"', 'Мособлреклама', 'РИМ',
           'Реклама Центр Outdoor', 'test@maergroup.ru', 'Инсайт Медиа']:
    print(f'  {nm!r:26} -> {m.operator_token(nm)!r}')
