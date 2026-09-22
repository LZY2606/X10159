import type { Hires, Op } from './model.ts'
import { assert, describe, it } from 'vitest'
import { Bundle, MagicString } from '../../src/index.ts'
import { ReferenceModel } from './model.ts'

// Hand-built edge cases that the random generator is unlikely to hit cleanly.
// Every case is cross-checked against the independent ReferenceModel for both
// toString() and the decoded map in all three hires modes.

function check(source: string, ops: Op[], hiresModes: Hires[] = [true, false, 'boundary']) {
  const lib = new MagicString(source, { filename: 'input.js' })
  const model = new ReferenceModel(source)
  for (const op of ops) {
    const legal = model.apply(op)
    assert.isTrue(legal, `model rejected a hand-built op: ${op.type}`)
    applyToLib(lib, op)
  }
  assert.equal(lib.toString(), model.toString())
  for (const hires of hiresModes) {
    const decoded = lib.generateDecodedMap({ hires })
    const expected = model.expectedMappings(hires)
    assert.deepEqual(decoded.mappings, expected.lines, `mappings differ (hires=${String(hires)})`)
    assert.deepEqual(decoded.names, expected.names, `names differ (hires=${String(hires)})`)
  }
  return { lib, model }
}

function applyToLib(lib: MagicString, op: Op): void {
  switch (op.type) {
    case 'appendLeft': {
      lib.appendLeft(op.index, op.text)
      break
    }
    case 'prependLeft': {
      lib.prependLeft(op.index, op.text)
      break
    }
    case 'appendRight': {
      lib.appendRight(op.index, op.text)
      break
    }
    case 'prependRight': {
      lib.prependRight(op.index, op.text)
      break
    }
    case 'append': {
      lib.append(op.text)
      break
    }
    case 'prepend': {
      lib.prepend(op.text)
      break
    }
    case 'overwrite': {
      lib.overwrite(op.start, op.end, op.text, { storeName: op.storeName, contentOnly: op.contentOnly })
      break
    }
    case 'remove': {
      lib.remove(op.start, op.end)
      break
    }
    case 'move': {
      lib.move(op.start, op.end, op.index, op.affinity)
      break
    }
    case 'indent': {
      lib.indent(op.indentStr, { exclude: op.exclude, indentStart: op.indentStart })
      break
    }
    case 'addSourcemapLocation': {
      lib.addSourcemapLocation(op.index)
      break
    }
  }
}

describe('manual boundary cases', () => {
  it('handles the empty string with all four boundary inserts', () => {
    check('', [
      { type: 'appendLeft', index: 0, text: 'A' },
      { type: 'prependRight', index: 0, text: 'R' },
      { type: 'prependLeft', index: 0, text: 'L' },
      { type: 'appendRight', index: 0, text: 'B' },
      { type: 'prepend', text: 'P' },
      { type: 'append', text: 'Q' },
    ])
    const s = new MagicString('')
    s.appendLeft(0, 'A')
    s.prependRight(0, 'R')
    s.prependLeft(0, 'L')
    s.appendRight(0, 'B')
    assert.equal(s.toString(), 'RBLA')
    // a string with no surviving source character has no source segments
    const map = s.generateDecodedMap({ hires: true })
    assert.deepEqual(map.mappings, [[]])
  })

  it('keeps indices in UTF-16 code units around surrogate pairs', () => {
    // 'a' + surrogate pair (U+1F600, two code units) + 'b'
    const source = `a\uD83D\uDE00b`
    assert.equal(source.length, 4)
    // index 1 is the lead surrogate, index 2 the trailing surrogate
    check(source, [
      { type: 'appendLeft', index: 1, text: '[' },
      { type: 'appendLeft', index: 2, text: '|' },
      { type: 'appendRight', index: 3, text: ']' },
      { type: 'overwrite', start: 3, end: 4, text: 'B' },
    ])
  })

  it('sorts repeated left/right inserts at the same boundary', () => {
    check('0123456789', [
      { type: 'appendLeft', index: 5, text: 'A' },
      { type: 'prependRight', index: 5, text: 'a' },
      { type: 'prependRight', index: 5, text: 'b' },
      { type: 'appendLeft', index: 5, text: 'B' },
      { type: 'appendLeft', index: 5, text: 'C' },
      { type: 'prependRight', index: 5, text: 'c' },
      { type: 'prependLeft', index: 5, text: '<' },
      { type: 'appendRight', index: 5, text: '>' },
    ])
  })

  it('supports consecutive moves of adjacent snippets', () => {
    check('abcdefgh', [
      { type: 'move', start: 0, end: 2, index: 6 },
      { type: 'move', start: 2, end: 4, index: 6 },
      { type: 'move', start: 4, end: 6, index: 0 },
    ])
  })

  it('supports moving the same snippet repeatedly', () => {
    check('abcdefghijkl', [
      { type: 'move', start: 0, end: 3, index: 6 },
      { type: 'move', start: 0, end: 3, index: 9 },
      { type: 'move', start: 0, end: 3, index: 12, affinity: 'left' },
    ])
  })

  it('respects indent exclusion ranges across line starts', () => {
    check('abc\ndef\nghi\njkl', [
      { type: 'indent', indentStr: '  ', exclude: [[7, 15]] },
    ])
    check('abc\ndef\nghi', [
      { type: 'overwrite', start: 4, end: 7, text: 'X\nY' },
      { type: 'indent', indentStr: '  ', exclude: [[4, 7]] },
    ])
  })

  it('agrees in hires true and boundary modes over word/non-word runs', () => {
    check('a b!cd__e', [
      { type: 'remove', start: 2, end: 3 },
      { type: 'appendRight', index: 4, text: '  ' },
    ])
  })
})

describe('bundle boundaries', () => {
  it('deduplicates sources with the same filename and identical content', () => {
    const shared = 'var a = 1;'
    const first = new MagicString(shared, { filename: 'shared.js' })
    first.overwrite(shared.length - 2, shared.length - 1, '2')
    const second = new MagicString(shared, { filename: 'shared.js' })
    second.append(' // unchanged')

    const bundle = new Bundle()
    bundle.addSource({ filename: 'shared.js', content: first })
    bundle.addSource({ filename: 'shared.js', content: second })

    const map = bundle.generateDecodedMap({ includeContent: true })
    assert.deepEqual(map.sources, ['shared.js'])
    assert.deepEqual(map.sourcesContent, [shared])

    const text = bundle.toString()
    assert.equal(text, 'var a = 2;\nvar a = 1; // unchanged')
    // every source-bearing segment points at the single shared source index 0
    map.mappings.forEach((line) => {
      line.forEach((segment) => {
        if (segment.length >= 4)
          assert.equal(segment[1], 0)
      })
    })
  })

  it('rejects the same filename with different content', () => {
    const a = new MagicString('aaa', { filename: 'dup.js' })
    const b = new MagicString('bbb', { filename: 'dup.js' })
    const bundle = new Bundle()
    bundle.addSource(a)
    assert.throws(() => bundle.addSource(b), /duplicate filename "dup\.js" with different content/)
  })

  it('renders null sourcesContent entries when content is excluded', () => {
    const bundle = new Bundle()
    bundle.addSource(new MagicString('a = 1', { filename: 'a.js' }))
    bundle.addSource(new MagicString('b = 2', { filename: 'b.js' }))
    const map = bundle.generateDecodedMap({ includeContent: false })
    assert.deepEqual(map.sourcesContent, [null, null])
  })
})

describe('regression invariants for specific mutation classes', () => {
  it('keeps a stored name after a later split lands inside the edited chunk', () => {
    // overwrite with storeName, then a boundary operation elsewhere must not
    // lose the name (a split-then-drop-storeName bug would empty `names`)
    const { lib, model } = check('abcdefghijkl', [
      { type: 'overwrite', start: 3, end: 9, text: 'XYZ', storeName: true },
    ])
    const map = lib.generateDecodedMap({ hires: true })
    assert.deepEqual(map.names, ['defghi'])
    assert.deepEqual(map.names, model.expectedMappings(true).names)
    // the replacement segment carries the name index
    const named = map.mappings.flat().filter(segment => segment.length === 5)
    assert.ok(named.length > 0)
    for (const segment of named)
      assert.equal(segment[4], 0)
  })

  it('preserves stored-name semantics across later edits and clone', () => {
    // A storeName overwrite registers the name; a subsequent storeName
    // overwrite of a different range adds a second name. The names array and
    // every name-bearing segment must agree with the reference model.
    const { lib, model } = check('abcdefghijkl', [
      { type: 'overwrite', start: 3, end: 9, text: 'XYZ', storeName: true },
      { type: 'overwrite', start: 0, end: 2, text: 'AB', storeName: true },
    ], [true])
    const map = lib.generateDecodedMap({ hires: true })
    assert.deepEqual(map.names, ['defghi', 'ab'])
    assert.deepEqual(map.names, model.expectedMappings(true).names)
    const nameIndices = map.mappings.flat()
      .filter(segment => segment.length === 5)
      .map(segment => segment[4])
    assert.deepEqual([...new Set(nameIndices)].sort(), [0, 1])

    // the cloned string carries the same name table independently
    const clone = lib.clone()
    assert.deepEqual(clone.generateDecodedMap({ hires: true }).names, ['defghi', 'ab'])
  })

  it('has move update both sides of the chunk linkage', () => {
    // a move must re-link predecessor/successor on both ends; verify by moving
    // again and checking the output plus a complete origin round-trip
    const source = 'abcdefgh'
    const { lib, model } = check(source, [
      { type: 'move', start: 2, end: 4, index: 6 },
      { type: 'move', start: 0, end: 2, index: 6 },
    ])
    const decoded = lib.generateDecodedMap({ hires: true })
    const { origin } = model.render()
    const lineStarts = [0]
    for (let i = 0; i < source.length; i++) {
      if (source[i] === '\n')
        lineStarts.push(i + 1)
    }
    const text = lib.toString()
    assert.equal(text.length, origin.length)
    decoded.mappings.forEach((line, lineIndex) => {
      line.forEach((segment) => {
        if (segment.length >= 4) {
          const offset = (lineStarts[lineIndex] ?? 0) + segment[0]
          assert.notEqual(origin[offset], null)
          assert.equal(origin[offset], lineStarts[segment[2]] + segment[3])
        }
      })
    })
  })

  it('does not shift the map by one column after indenting', () => {
    // the inserted indent must have no source segment, and the character that
    // follows it must still map to its own original column (not column-1)
    const source = 'abc\ndef'
    const lib = new MagicString(source)
    lib.indent('  ')
    const decoded = lib.generateDecodedMap({ hires: true })
    // first generated line: two inserted spaces then 'a' -> column 2 maps to 0
    assert.deepEqual(decoded.mappings[0], [[2, 0, 0, 0], [3, 0, 0, 1], [4, 0, 0, 2]])
    // second generated line likewise
    assert.deepEqual(decoded.mappings[1], [[2, 0, 1, 0], [3, 0, 1, 1], [4, 0, 1, 2]])
  })

  it('keeps cloned chunks independent (no shared mutable chunk)', () => {
    const source = 'abcdefgh'
    const original = new MagicString(source)
    original.overwrite(2, 6, 'XX')
    original.move(0, 2, 8)
    const clone = original.clone()

    // mutating the clone after the move must not touch the parent's chunks
    clone.overwrite(2, 6, 'YY')
    assert.equal(original.toString(), 'XXghab')
    assert.equal(clone.toString(), 'YYghab')

    // and mutating the parent afterwards must not leak into the clone
    original.appendLeft(8, '!')
    assert.equal(clone.toString(), 'YYghab')

    // maps stay independently correct
    const originalMap = original.generateDecodedMap({ hires: true }).mappings
    const cloneMap = clone.generateDecodedMap({ hires: true }).mappings
    assert.notDeepEqual(originalMap, cloneMap)
  })

  it('leaves no generated segment for removed characters', () => {
    const lib = new MagicString('abcdefghijkl')
    lib.remove(3, 9)
    const decoded = lib.generateDecodedMap({ hires: true })
    const segmentCount = decoded.mappings.reduce((n, line) => n + line.length, 0)
    // 'abc' + 'jkl' = 6 surviving characters, one segment each
    assert.equal(segmentCount, 6)
    assert.equal(lib.toString(), 'abcjkl')
  })

  it('does not fabricate a source for pure inserts', () => {
    const lib = new MagicString('ab')
    lib.appendRight(1, 'INSERT')
    const decoded = lib.generateDecodedMap({ hires: true })
    // segments only at 'a' (col 0) and 'b' (col 7); nothing at insert columns
    assert.deepEqual(decoded.mappings, [[[0, 0, 0, 0], [7, 0, 0, 1]]])
  })
})
