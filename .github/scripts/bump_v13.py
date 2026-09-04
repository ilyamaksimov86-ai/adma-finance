from pathlib import Path
p=Path('index.html')
s=p.read_text()
for v in range(1,13):
    s=s.replace(f'cloud.js?v={v}', 'cloud.js?v=13')
if 'cloud.js?v=13' not in s:
    raise SystemExit('cloud.js cache tag not found')
p.write_text(s)
