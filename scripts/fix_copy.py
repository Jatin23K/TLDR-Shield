import os
f = os.path.join(os.path.dirname(__file__), 'extension', 'sidepanel.js')
with open(f, 'r', encoding='utf-8') as fh:
    c = fh.read()
c2 = c.replace('Copy to Clipboard \u2713', 'Copy to Clipboard')
with open(f, 'w', encoding='utf-8') as fh:
    fh.write(c2)
print('changed:', c != c2)
