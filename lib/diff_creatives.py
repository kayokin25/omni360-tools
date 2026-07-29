# -*- coding: utf-8 -*-
import sys, warnings, zipfile, hashlib
sys.stdout.reconfigure(encoding='utf-8')
warnings.filterwarnings('ignore')
import openpyxl

REF = r'C:\Users\tuefr\OneDrive\Desktop\работа\скрипты\подбор крео\Отчет_подбор_крео.xlsx'
REFZIP = r'C:\Users\tuefr\OneDrive\Desktop\работа\скрипты\подбор крео\Крео_для_загрузки.zip'

def grid(path):
    wb = openpyxl.load_workbook(path)
    out = {}
    for ws in wb.worksheets:
        rows = []
        for row in ws.iter_rows():
            rows.append(['' if c.value is None else str(c.value) for c in row])
        out[ws.title] = rows
    wb.close()
    return out

py = grid(REF)
js = grid('out_creatives.xlsx')

print('листы python:', list(py))
print('листы js    :', list(js))
allok = True
for name in py:
    a = py[name]
    b = js.get(name, [])
    print(f'--- лист "{name}": python {len(a)} строк, js {len(b)} строк')
    if len(a) != len(b):
        allok = False
        print('    !!! разное число строк')
    n = max(len(a), len(b))
    diffs = 0
    for i in range(n):
        ra = a[i] if i < len(a) else []
        rb = b[i] if i < len(b) else []
        # у «Сводки» в python есть пустая строка-разделитель; сравниваем как есть
        if ra != rb:
            diffs += 1
            allok = False
            if diffs <= 5:
                print(f'    строка {i+1}:')
                print('      python:', ra)
                print('      js    :', rb)
    if diffs == 0:
        print('    идентично')
    else:
        print(f'    расхождений: {diffs}')

print()
print('=== сверка архивов ===')
def zinfo(p):
    with zipfile.ZipFile(p) as z:
        assert z.testzip() is None, 'битый архив'
        return {i.filename: (i.file_size, hashlib.sha256(z.read(i)).hexdigest()[:16]) for i in z.infolist()}

a = zinfo(REFZIP)
b = zinfo('out_creatives.zip')
print(f'python: {len(a)} файлов | js: {len(b)} файлов')
if set(a) == set(b):
    print('  имена файлов совпадают')
else:
    print('  только в python:', set(a) - set(b))
    print('  только в js    :', set(b) - set(a))
    allok = False
for k in sorted(set(a) & set(b)):
    same = a[k] == b[k]
    if not same:
        allok = False
    print(f'  {"ok  " if same else "FAIL"} {k}: size={a[k][0]} sha={a[k][1]} | js size={b[k][0]} sha={b[k][1]}')

print()
print('ВСЁ СОВПАДАЕТ С PYTHON' if allok else 'ЕСТЬ РАСХОЖДЕНИЯ (см. выше)')
