# -*- coding: utf-8 -*-
import sys, warnings
sys.stdout.reconfigure(encoding='utf-8')
warnings.filterwarnings('ignore')
import openpyxl

def grid(path):
    wb = openpyxl.load_workbook(path)
    ws = wb.active
    out = []
    for row in ws.iter_rows():
        r = []
        for c in row:
            v = '' if c.value is None else str(c.value)
            if c.hyperlink:
                v += '\n@' + c.hyperlink.target
            r.append(v)
        out.append(r)
    wb.close()
    return out

py = grid(r'py_ref\AP_tiest_868095279752977635.xlsx')
js = grid('out_tt.xlsx')

print(f'python: {len(py)} строк | js: {len(js)} строк')
ok = True
if len(py) != len(js):
    ok = False
    print('!!! разное число строк')
for i in range(max(len(py), len(js))):
    a = py[i] if i < len(py) else []
    b = js[i] if i < len(js) else []
    if a != b:
        ok = False
        print(f'--- различие в строке {i+1}')
        print('   python:', a)
        print('   js    :', b)

print()
print('ИДЕНТИЧНО' if ok else 'ЕСТЬ РАСХОЖДЕНИЯ')
