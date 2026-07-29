# -*- coding: utf-8 -*-
import sys, zipfile
sys.stdout.reconfigure(encoding='utf-8')
import openpyxl

print('=== ZIP validity (python zipfile) ===')
with zipfile.ZipFile('out_test.zip') as z:
    bad = z.testzip()
    print('  testzip (None = ok):', bad)
    for i in z.infolist():
        print(f'  {i.filename!r} size={i.file_size} crc={i.CRC:08x} flag_bits={i.flag_bits:#x}')
        print('     content:', z.read(i).decode('utf-8', 'replace')[:40].encode('unicode_escape').decode())

print()
print('=== XLSX validity (openpyxl) ===')
with zipfile.ZipFile('out_test.xlsx') as z:
    print('  testzip:', z.testzip())
    print('  parts:', z.namelist())

wb = openpyxl.load_workbook('out_test.xlsx')
for ws in wb.worksheets:
    print(f'--- sheet "{ws.title}" dims={ws.dimensions} freeze={ws.freeze_panes}')
    widths = {k: v.width for k, v in ws.column_dimensions.items()}
    print('    col widths:', widths)
    print('    row1 height:', ws.row_dimensions[1].height)
    for row in ws.iter_rows():
        for c in row:
            if c.value is None:
                continue
            info = f'{c.coordinate}={c.value!r}'
            f = c.font
            info += f' font(b={f.bold},u={f.underline},color={f.color.rgb if f.color else None},name={f.name},sz={f.size})'
            if c.fill and c.fill.fgColor and c.fill.fgColor.rgb not in (None, '00000000'):
                info += f' fill={c.fill.fgColor.rgb}'
            if c.hyperlink:
                info += f' LINK->{c.hyperlink.target}'
            if c.number_format != 'General':
                info += f' fmt={c.number_format}'
            if c.border and c.border.left and c.border.left.style:
                info += ' bordered'
            print('   ', info)
wb.close()
print()
print('OK — openpyxl прочитал файл без ошибок')
