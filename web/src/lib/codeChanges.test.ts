import { describe, expect, it } from 'vitest'
import { codeEffectOutcome, codeSegments, formatChangeCounts, orderFiles, parsePatch, splitPath } from './codeChanges'

const PATCH = `diff --git a/src/engine.py b/src/engine.py
index 1111111..2222222 100644
--- a/src/engine.py
+++ b/src/engine.py
@@ -10,3 +10,4 @@ def step(self):
     a = 1
-    b = 2
+    b = 3
+    c = 4
     return a
\\ No newline at end of file
`

describe('parsePatch', () => {
  it('drops the file header and numbers old and new lines from the hunk header', () => {
    const lines = parsePatch(PATCH)
    expect(lines.map((line) => line.kind)).toEqual(['hunk', 'context', 'del', 'add', 'add', 'context', 'note'])
    expect(lines[1]).toEqual({ kind: 'context', text: '    a = 1', oldNo: 10, newNo: 10 })
    expect(lines[2]).toMatchObject({ kind: 'del', text: '    b = 2', oldNo: 11, newNo: null })
    expect(lines[4]).toMatchObject({ kind: 'add', text: '    c = 4', oldNo: null, newNo: 12 })
    expect(lines[5]).toMatchObject({ oldNo: 12, newNo: 13 })
    expect(lines[6].text).toBe('No newline at end of file')
  })

  it('says when a file is binary and handles empty input', () => {
    expect(parsePatch('diff --git a/x.bin b/x.bin\nindex 1..2 100644\nBinary files a/x.bin and b/x.bin differ\n')).toEqual([
      { kind: 'note', text: 'Binary file: no text diff.', oldNo: null, newNo: null },
    ])
    expect(parsePatch(null)).toEqual([])
  })
})

describe('code change helpers', () => {
  it('orders engine code first, largest first, then config, tests and docs', () => {
    const files = [
      { path: 'docs/a.md', kind: 'docs', additions: 90, deletions: 0 },
      { path: 'tests/test_a.py', kind: 'test', additions: 400, deletions: 0 },
      { path: 'src/small.py', kind: 'source', additions: 3, deletions: 1 },
      { path: 'src/big.py', kind: 'source', additions: 500, deletions: 0 },
    ]
    expect(orderFiles(files).map((file) => file.path)).toEqual(['src/big.py', 'src/small.py', 'tests/test_a.py', 'docs/a.md'])
  })

  it('formats counts, paths, outcomes and code spans', () => {
    expect(formatChangeCounts(1050, 3)).toBe('+1,050 −3')
    expect(formatChangeCounts(0, 0)).toBe('±0')
    expect(formatChangeCounts(null, null)).toBe('binary')
    expect(splitPath('src/lab/engine.py')).toEqual({ folder: 'src/lab/', name: 'engine.py' })
    expect(codeEffectOutcome('no_change').label).toBe('No gain, no loss')
    expect(codeEffectOutcome('bogus').label).toBe('Not measured')
    expect(codeSegments('Adds `draft.py` (+2) behind `flag`.')).toEqual([
      { code: false, text: 'Adds ' },
      { code: true, text: 'draft.py' },
      { code: false, text: ' (+2) behind ' },
      { code: true, text: 'flag' },
      { code: false, text: '.' },
    ])
  })
})
