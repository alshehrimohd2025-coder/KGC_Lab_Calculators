#!/usr/bin/env python3
"""Stamp a fresh version on the site before each commit.

GitHub Pages serves every file with a 10-minute browser cache, so a change
could sit unseen on an open page. This writes one version string into:
  - version.txt, which open pages poll to notice a new release, and
  - every local script and stylesheet link in index.html (?v=...), so the
    reload that follows fetches the new files instead of cached ones.
Run by the git pre-commit hook; safe to run by hand.
"""
import io, os, re, time

HERE = os.path.dirname(os.path.abspath(__file__))
ver = time.strftime('%Y%m%d%H%M%S')
p = os.path.join(HERE, 'index.html')
s = io.open(p, encoding='utf-8').read()
s = re.sub(r'((?:src|href)="(?!https?:|//)[\w./-]+\.(?:js|css))(?:\?v=[^"]*)?"', r'\1?v=' + ver + '"', s)
s = re.sub(r'<meta name="app-version" content="[^"]*">', '<meta name="app-version" content="' + ver + '">', s)
if 'name="app-version"' not in s:
    s = s.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="app-version" content="' + ver + '">', 1)
io.open(p, 'w', encoding='utf-8').write(s)
io.open(os.path.join(HERE, 'version.txt'), 'w').write(ver + '\n')
print('stamped', ver)
