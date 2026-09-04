from pathlib import Path

p = Path('cloud.js')
s = p.read_text()
old = "    dlg.showModal();\n    try {\n      const data = await api('list_users');"
new = "    if (!dlg.open) dlg.showModal();\n    try {\n      const data = await api('list_users');"
if old not in s:
    raise SystemExit('team dialog anchor missing')
s = s.replace(old, new, 1)
p.write_text(s)

idx = Path('index.html')
h = idx.read_text()
for v in range(1,14):
    h = h.replace(f'cloud.js?v={v}', 'cloud.js?v=14')
if 'cloud.js?v=14' not in h:
    raise SystemExit('cloud.js cache tag not found')
idx.write_text(h)
