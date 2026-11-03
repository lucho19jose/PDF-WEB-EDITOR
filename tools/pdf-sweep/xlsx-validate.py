"""Check every workbook xlsx-batch.mjs wrote: it must parse as XML and load in openpyxl.

    python tools/pdf-sweep/xlsx-validate.py <out-dir>

Reports, per file, any XML error, any openpyxl failure, and overlapping merged
ranges (the one structural mistake Excel answers with "We found a problem").
"""
import sys, os, zipfile, xml.dom.minidom, warnings
warnings.filterwarnings('ignore')
import openpyxl

out = sys.argv[1]
bad = 0
files = sorted(f for f in os.listdir(out) if f.endswith('.xlsx'))
for f in files:
    p = os.path.join(out, f)
    problems = []
    try:
        z = zipfile.ZipFile(p)
        if z.testzip():
            problems.append('zip crc')
        for i in z.infolist():
            try:
                xml.dom.minidom.parseString(z.read(i.filename))
            except Exception as e:
                problems.append(f'xml {i.filename}: {e}')
        wb = openpyxl.load_workbook(p)
        for ws in wb.worksheets:
            ranges = [r.bounds for r in ws.merged_cells.ranges]
            cells = {}
            for (c0, r0, c1, r1) in ranges:
                for r in range(r0, r1 + 1):
                    for c in range(c0, c1 + 1):
                        if (r, c) in cells:
                            problems.append(f'{ws.title}: merge overlap at row {r} col {c}')
                            break
                        cells[(r, c)] = 1
    except Exception as e:
        problems.append(f'load: {e}')
    if problems:
        bad += 1
        print('BAD', f, '; '.join(problems[:3]))
print(f'{len(files)} workbooks, {bad} with problems')
