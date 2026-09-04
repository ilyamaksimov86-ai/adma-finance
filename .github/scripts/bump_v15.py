from pathlib import Path
import re
p = Path('index.html')
s = p.read_text()
s2, n = re.subn(r'cloud\.js\?v=\d+', 'cloud.js?v=15', s)
if n == 0:
    raise SystemExit('cloud.js version reference not found')
p.write_text(s2)
