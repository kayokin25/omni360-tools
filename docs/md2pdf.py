# -*- coding: utf-8 -*-
"""
Markdown → PDF для инструкций из docs/.

Зачем свой конвертер: нужен один файл, который можно отдать человеку, с
кириллицей, таблицами и моноширинными вставками. Pandoc и LaTeX ставить ради
этого не хочется, а reportlab уже умеет всё нужное.

Понимает ровно то, что встречается в наших инструкциях: заголовки #/##/###,
абзацы, списки (маркированные и нумерованные, с продолжением строк), таблицы,
блоки кода в ```, горизонтальные линии, а внутри текста — **жирный**,
`код`, [ссылки](…) и <автоссылки>.

Запуск:
    python docs/md2pdf.py docs/tt-upload.md            → docs/tt-upload.pdf
    python docs/md2pdf.py docs/tt-upload.md куда.pdf

Шрифты берём системные (Segoe UI + Consolas): встроенные шрифты reportlab
кириллицу не содержат, вместо букв были бы пустые прямоугольники.
"""
import os
import re
import sys

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.pdfmetrics import registerFontFamily
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, HRFlowable, KeepTogether,
                                ListFlowable, ListItem, PageTemplate, Paragraph,
                                Preformatted, Spacer, Table, TableStyle)

sys.stdout.reconfigure(encoding='utf-8')

FONT_DIR = os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts')
FOOTER = 'omni360 · отдел по ведению РК'

# ── цвета: те же, что в светлой теме панели ──
INK = colors.HexColor('#0f172a')
BODY = colors.HexColor('#334155')
MUTED = colors.HexColor('#64748b')
LINE = colors.HexColor('#dbe3ec')
PANEL = colors.HexColor('#f6f8fb')
ACCENT = colors.HexColor('#0284c7')
CODE_INK = colors.HexColor('#0f172a')
WARN_BG = colors.HexColor('#fffbeb')


def register_fonts():
    faces = [
        ('UI', 'segoeui.ttf'), ('UI-Bold', 'segoeuib.ttf'), ('UI-Italic', 'segoeuii.ttf'),
        ('Mono', 'consola.ttf'), ('Mono-Bold', 'consolab.ttf'),
    ]
    for name, filename in faces:
        path = os.path.join(FONT_DIR, filename)
        if not os.path.exists(path):
            raise SystemExit('нет шрифта: %s (нужен для кириллицы)' % path)
        pdfmetrics.registerFont(TTFont(name, path))
    registerFontFamily('UI', normal='UI', bold='UI-Bold', italic='UI-Italic', boldItalic='UI-Bold')
    registerFontFamily('Mono', normal='Mono', bold='Mono-Bold', italic='Mono', boldItalic='Mono-Bold')


S = {}


def build_styles():
    S['h1'] = ParagraphStyle('h1', fontName='UI-Bold', fontSize=19, leading=24,
                             textColor=INK, spaceAfter=10, keepWithNext=1)
    S['h2'] = ParagraphStyle('h2', fontName='UI-Bold', fontSize=14, leading=18,
                             textColor=INK, spaceBefore=17, spaceAfter=7, keepWithNext=1)
    S['h3'] = ParagraphStyle('h3', fontName='UI-Bold', fontSize=11.5, leading=15,
                             textColor=INK, spaceBefore=13, spaceAfter=5, keepWithNext=1)
    S['body'] = ParagraphStyle('body', fontName='UI', fontSize=10, leading=14.6,
                               textColor=BODY, alignment=TA_LEFT, spaceAfter=8)
    S['li'] = ParagraphStyle('li', parent=S['body'], spaceAfter=4)
    S['th'] = ParagraphStyle('th', fontName='UI-Bold', fontSize=9, leading=12.5,
                             textColor=MUTED, spaceAfter=0)
    S['td'] = ParagraphStyle('td', fontName='UI', fontSize=9, leading=12.5,
                             textColor=BODY, spaceAfter=0)
    # Фон и рамку рисуем таблицей-обёрткой (см. code_block): у Preformatted
    # backColor с borderPadding в PDF не проявились.
    S['code'] = ParagraphStyle('code', fontName='Mono', fontSize=8.8, leading=12.6,
                               textColor=CODE_INK)


def code_block(text, width):
    t = Table([[Preformatted(text, S['code'])]], colWidths=[width])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), PANEL),
        ('BOX', (0, 0), (-1, -1), 0.5, LINE),
        ('LEFTPADDING', (0, 0), (-1, -1), 9),
        ('RIGHTPADDING', (0, 0), (-1, -1), 9),
        ('TOPPADDING', (0, 0), (-1, -1), 8),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
    ]))
    return t


# ─────────────────────────── разметка внутри строки ───────────────────────────

def inline(text):
    """`код`, **жирный**, [ссылки](…), <автоссылки> → разметка reportlab."""
    # Код обрабатываем первым и складываем в заглушки: внутри него ** и [ ]
    # трогать нельзя.
    stash = []

    def keep_code(m):
        stash.append(m.group(1))
        return '\x00%d\x00' % (len(stash) - 1)

    text = re.sub(r'`([^`]+)`', keep_code, text)

    text = text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

    # <https://…> — после экранирования это &lt;https://…&gt;
    text = re.sub(r'&lt;(https?://[^\s&]+)&gt;',
                  lambda m: '<link href="%s" color="#0284c7">%s</link>' % (m.group(1), m.group(1)),
                  text)
    # [текст](url)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)',
                  lambda m: '<link href="%s" color="#0284c7">%s</link>' % (m.group(2), m.group(1)),
                  text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', text)

    def put_code(m):
        raw = stash[int(m.group(1))]
        raw = raw.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
        return '<font name="Mono" size="9">%s</font>' % raw

    return re.sub('\x00(\\d+)\x00', put_code, text)


# ─────────────────────────────── разбор блоков ───────────────────────────────

BULLET = re.compile(r'^\s*[*-]\s+(.*)$')
ORDERED = re.compile(r'^\s*(\d+)\.\s+(.*)$')
HEADING = re.compile(r'^(#{1,3})\s+(.*)$')


def is_block_start(line):
    return (HEADING.match(line) or BULLET.match(line) or ORDERED.match(line)
            or line.startswith('|') or line.startswith('```')
            or line.strip() in ('---', '***', '___') or not line.strip())


def collect_item(lines, i, first):
    """Пункт списка: сама строка плюс её продолжение с отступом."""
    parts = [first]
    i += 1
    while i < len(lines) and lines[i].strip() and lines[i].startswith(('  ', '\t')) \
            and not BULLET.match(lines[i]) and not ORDERED.match(lines[i]):
        parts.append(lines[i].strip())
        i += 1
    return ' '.join(parts), i


def table_widths(rows, total):
    """Ширины столбцов пропорционально содержимому, но без крайностей."""
    n = max(len(r) for r in rows)
    weight = []
    for c in range(n):
        longest = max((len(r[c]) for r in rows if c < len(r)), default=1)
        weight.append(max(6, min(longest, 46)))
    s = float(sum(weight))
    return [total * w / s for w in weight]


def parse(md, width):
    lines = md.split('\n')
    flow = []
    i = 0
    while i < len(lines):
        line = lines[i]

        if not line.strip():
            i += 1
            continue

        # блок кода
        if line.startswith('```'):
            i += 1
            buf = []
            while i < len(lines) and not lines[i].startswith('```'):
                buf.append(lines[i])
                i += 1
            i += 1
            flow.append(code_block('\n'.join(buf), width))
            flow.append(Spacer(1, 10))
            continue

        # линия
        if line.strip() in ('---', '***', '___'):
            flow.append(Spacer(1, 4))
            flow.append(HRFlowable(width='100%', color=LINE, thickness=0.6,
                                   spaceBefore=2, spaceAfter=12))
            i += 1
            continue

        # заголовок
        m = HEADING.match(line)
        if m:
            flow.append(Paragraph(inline(m.group(2)), S['h%d' % len(m.group(1))]))
            i += 1
            continue

        # таблица
        if line.startswith('|'):
            raw = []
            while i < len(lines) and lines[i].startswith('|'):
                raw.append(lines[i])
                i += 1
            cells = []
            for r in raw:
                parts = [c.strip() for c in r.strip().strip('|').split('|')]
                if all(re.fullmatch(r':?-{2,}:?', c or '') for c in parts):
                    continue          # разделитель шапки
                cells.append(parts)
            if not cells:
                continue
            widths = table_widths(cells, width)
            data = []
            for ri, row in enumerate(cells):
                style = S['th'] if ri == 0 else S['td']
                data.append([Paragraph(inline(c), style) for c in row])
            t = Table(data, colWidths=widths, repeatRows=1)
            t.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), PANEL),
                ('GRID', (0, 0), (-1, -1), 0.4, LINE),
                ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('LEFTPADDING', (0, 0), (-1, -1), 7),
                ('RIGHTPADDING', (0, 0), (-1, -1), 7),
                ('TOPPADDING', (0, 0), (-1, -1), 5),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
            ]))
            flow.append(t)
            flow.append(Spacer(1, 11))
            continue

        # списки
        m = BULLET.match(line)
        if m:
            items = []
            while i < len(lines):
                mm = BULLET.match(lines[i])
                if not mm:
                    break
                text, i = collect_item(lines, i, mm.group(1))
                # value на ListItem не задаём: при bulletType='bullet' reportlab
                # печатает его как есть, и вместо точки в PDF выходило «bullet».
                items.append(ListItem(Paragraph(inline(text), S['li']), leftIndent=14))
            flow.append(ListFlowable(items, bulletType='bullet', start='•',
                                     bulletFontName='UI', bulletFontSize=9,
                                     leftIndent=13, bulletColor=ACCENT))
            flow.append(Spacer(1, 7))
            continue

        m = ORDERED.match(line)
        if m:
            items = []
            first_num = int(m.group(1))
            while i < len(lines):
                mm = ORDERED.match(lines[i])
                if not mm:
                    break
                text, i = collect_item(lines, i, mm.group(2))
                items.append(ListItem(Paragraph(inline(text), S['li']), leftIndent=16))
            flow.append(ListFlowable(items, bulletType='1', start=first_num,
                                     bulletFormat='%s.',
                                     bulletFontName='UI-Bold', bulletFontSize=9.5,
                                     leftIndent=16, bulletColor=ACCENT))
            flow.append(Spacer(1, 7))
            continue

        # абзац
        buf = [line.strip()]
        i += 1
        while i < len(lines) and not is_block_start(lines[i]):
            buf.append(lines[i].strip())
            i += 1
        flow.append(Paragraph(inline(' '.join(buf)), S['body']))

    return glue(flow)


def small_enough(f):
    """Можно ли тащить блок на следующую страницу целиком, не оставив дыру."""
    if isinstance(f, Paragraph):
        return True
    if isinstance(f, ListFlowable):
        return len(f._content) <= 5
    if isinstance(f, Table):
        return len(f._cellvalues) <= 6
    return False


def glue(flow):
    """Заголовок и строку-зачин (…:) не оставляем висеть в конце страницы.

    keepWithNext в стиле заголовка списки и таблицы не удерживает — проверено:
    «Чего не делать» оставался последней строкой страницы, а список уезжал на
    следующую. Поэтому склеиваем явно, но только с небольшим блоком: тащить на
    другую страницу таблицу на тринадцать строк значит оставить полстраницы
    пустой, а таблицы и так переносятся с повтором шапки.
    """
    out = []
    i = 0
    while i < len(flow):
        f = flow[i]
        head = isinstance(f, Paragraph) and f.style.name in ('h1', 'h2', 'h3')
        leadin = isinstance(f, Paragraph) and f.style.name == 'body' \
            and f.getPlainText().rstrip().endswith(':')
        nxt = flow[i + 1] if i + 1 < len(flow) else None
        if (head or leadin) and nxt is not None and small_enough(nxt):
            out.append(KeepTogether([f, nxt]))
            i += 2
            continue
        out.append(f)
        i += 1
    return out


# ──────────────────────────────── страница ────────────────────────────────

def draw_footer(canvas, doc):
    canvas.saveState()
    canvas.setFont('UI', 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(doc.leftMargin, 12 * mm, FOOTER)
    canvas.drawRightString(A4[0] - doc.rightMargin, 12 * mm, str(canvas.getPageNumber()))
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.4)
    canvas.line(doc.leftMargin, 16 * mm, A4[0] - doc.rightMargin, 16 * mm)
    canvas.restoreState()


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else 'docs/tt-upload.md'
    dst = sys.argv[2] if len(sys.argv) > 2 else os.path.splitext(src)[0] + '.pdf'

    register_fonts()
    build_styles()

    with open(src, encoding='utf-8') as f:
        md = f.read()

    doc = BaseDocTemplate(dst, pagesize=A4,
                          leftMargin=20 * mm, rightMargin=20 * mm,
                          topMargin=18 * mm, bottomMargin=22 * mm,
                          title=re.sub(r'^#\s+', '', md.split('\n')[0]).strip(),
                          author='omni360')
    frame = Frame(doc.leftMargin, doc.bottomMargin,
                  doc.width, doc.height, id='main',
                  leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate(id='page', frames=[frame], onPage=draw_footer)])

    story = parse(md, doc.width)
    doc.build(story)

    print('готово: %s (%.0f КБ)' % (dst, os.path.getsize(dst) / 1024))


if __name__ == '__main__':
    main()
