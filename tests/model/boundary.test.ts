import type { Operation } from './generator.ts'
import { assert, describe, it } from 'vitest'
import { Bundle, MagicString } from '../../src/index.ts'
import { applyReal } from './applyReal.ts'
import { checkProvenance, expectedMappings, outputText, pieces } from './emit.ts'
import { applyToModel } from './generator.ts'
import { ReferenceModel } from './referenceModel.ts'

const HIRES_MODES = [false, true, 'boundary'] as const

/** Checks a real string against an independently modelled expectation. */
function expectMatchesModel(source: string, operations: Operation[]): { s: MagicString, model: ReferenceModel } {
  const model = new ReferenceModel(source)
  const s = new MagicString(source)
  for (const operation of operations) {
    applyToModel(model, operation)
    applyReal(s, operation)
  }

  const list = pieces(model)
  assert.equal(s.toString(), outputText(list))
  for (const hires of HIRES_MODES) {
    const actual = s.generateDecodedMap({ hires })
    assert.deepEqual(actual.mappings, expectedMappings(model, list, hires))
    assert.deepEqual(actual.names, model.names)
    assert.equal(checkProvenance(model, list, actual.mappings), null)
  }
  return { s, model }
}

describe('model boundary cases', () => {
  it('handles the empty string: inserts only, edits are impossible', () => {
    const model = new ReferenceModel('')
    const s = new MagicString('')

    s.appendLeft(0, 'a').prependLeft(0, 'b').appendRight(0, 'c').prependRight(0, 'd')
    model.appendLeft(0, 'a').prependLeft(0, 'b').appendRight(0, 'c').prependRight(0, 'd')
    assert.equal(s.toString(), 'dcba')
    assert.equal(s.toString(), outputText(pieces(model)))

    // zero-length removals and self-moves stay no-ops instead of throwing
    s.remove(0, 0)
    s.move(0, 0, 0)

    const list = pieces(model)
    for (const hires of HIRES_MODES) {
      const actual = s.generateDecodedMap({ hires })
      assert.deepEqual(actual.mappings, expectedMappings(model, list, hires))
      assert.equal(checkProvenance(model, list, actual.mappings), null)
      // inserted content must never fabricate a source segment
      assert.deepEqual(actual.mappings, [[]])
    }

    assert.throws(() => s.overwrite(0, 0, 'x'), /zero-length range/)
  })

  it('keeps UTF-16 code-unit indices straight around a surrogate pair', () => {
    // 'a' 0, surrogate pair at 1-2, 'b' 3, 'c' 4
    const source = 'a😀bc'
    assert.equal(source.length, 5)

    expectMatchesModel(source, [
      // indices 1 and 2 are the two surrogate units; insert right at the pair
      // start and inside the pair (left side), then move the whole pair
      { type: 'prependRight', index: 1, content: '+' },
      { type: 'appendLeft', index: 2, content: '|' },
      { type: 'move', start: 1, end: 3, index: 5, affinity: 'right' },
    ])

    // each surviving code unit still maps to its own original unit
    const { s } = expectMatchesModel(source, [
      { type: 'remove', start: 1, end: 3 },
    ])
    assert.equal(s.toString(), 'abc')
  })

  it('stacks left and right inserts at one boundary in the documented order', () => {
    const { s } = expectMatchesModel('ab', [
      { type: 'appendLeft', index: 1, content: 'AL' },
      { type: 'prependLeft', index: 1, content: 'PL' },
      { type: 'appendRight', index: 1, content: 'AR' },
      { type: 'prependRight', index: 1, content: 'PR' },
      { type: 'appendLeft', index: 1, content: 'al2' },
      { type: 'prependRight', index: 1, content: 'pr2' },
    ])
    // left pile: prependLeft before appendLeft; right pile vice versa
    assert.equal(s.toString(), 'aPLALal2pr2PRARb')
  })

  it('stacks inserts at both edges (indices 0 and n)', () => {
    const { s } = expectMatchesModel('ab', [
      { type: 'appendLeft', index: 0, content: 'AL0' },
      { type: 'prependLeft', index: 0, content: 'PL0' },
      { type: 'appendRight', index: 0, content: 'AR0' },
      { type: 'prependRight', index: 0, content: 'PR0' },
      { type: 'appendLeft', index: 2, content: 'AL2' },
      { type: 'prependLeft', index: 2, content: 'PL2' },
      { type: 'appendRight', index: 2, content: 'AR2' },
      { type: 'prependRight', index: 2, content: 'PR2' },
    ])
    assert.equal(s.toString(), 'PL0AL0PR0AR0abPL2AL2PR2AR2')
  })

  it('supports repeated, adjacent moves of the same range in both affinities', () => {
    expectMatchesModel('abcdefgh', [
      { type: 'move', start: 0, end: 2, index: 8, affinity: 'right' },
      { type: 'move', start: 2, end: 6, index: 0, affinity: 'right' },
    ])

    expectMatchesModel('abcd', [
      { type: 'move', start: 0, end: 1, index: 2, affinity: 'right' },
      { type: 'move', start: 3, end: 4, index: 2, affinity: 'right' },
      { type: 'move', start: 0, end: 1, index: 2, affinity: 'right' }, // redundant
    ])

    expectMatchesModel('abcd', [
      { type: 'move', start: 0, end: 1, index: 2, affinity: 'right' },
      { type: 'move', start: 3, end: 4, index: 2, affinity: 'left' },
    ])

    const s = new MagicString('abcdef')
    s.move(0, 2, 3)
    assert.throws(() => s.move(1, 3, 0), /earlier move split that range/)
  })

  it('indents only outside exclusion ranges and shifts map columns exactly', () => {
    const source = 'ab\ncd\nef'

    const { s } = expectMatchesModel(source, [
      { type: 'indent', indentStr: '\t', options: { exclude: [[3, 6]] } },
    ])
    assert.equal(s.toString(), '\tab\ncd\n\tef')
    const map = s.generateDecodedMap({ hires: true })
    // line 2 ("cd") was excluded: its first segment starts at column 0,
    // while indented lines start at column 1 (the tab has no source segment)
    assert.deepEqual(map.mappings, [
      [[1, 0, 0, 0], [2, 0, 0, 1]],
      [[0, 0, 1, 0], [1, 0, 1, 1]],
      [[1, 0, 2, 0], [2, 0, 2, 1]],
    ])

    expectMatchesModel(source, [
      { type: 'overwrite', start: 1, end: 2, content: 'X', storeName: false, contentOnly: false },
      { type: 'indent', indentStr: '  ', options: {} },
    ])
  })

  it('distinguishes hires true from hires boundary', () => {
    const source = 'ab1 2c'

    const sTrue = new MagicString(source)
    const sBoundary = new MagicString(source)
    const hiresTrue = sTrue.generateDecodedMap({ hires: true }).mappings
    const hiresBoundary = sBoundary.generateDecodedMap({ hires: 'boundary' }).mappings
    const hiresFalse = sTrue.generateDecodedMap({ hires: false }).mappings

    // every character gets a segment with hires: true
    assert.equal(hiresTrue[0].length, source.length)
    // word characters share a boundary, punctuation breaks it
    assert.deepEqual(hiresBoundary, [
      [[0, 0, 0, 0], [3, 0, 0, 3], [4, 0, 0, 4]],
    ])
    assert.ok(hiresBoundary[0].length > hiresFalse[0].length)

    // addSourcemapLocation only affects the lo-res map
    const withLocations = new MagicString(source)
    withLocations.addSourcemapLocation(2)
    withLocations.addSourcemapLocation(4)
    const lores = withLocations.generateDecodedMap({ hires: false }).mappings
    // first-char segment plus the two explicitly added locations
    assert.deepEqual(lores, [[
      [0, 0, 0, 0],
      [2, 0, 0, 2],
      [4, 0, 0, 4],
    ]])
  })

  it('preserves the stored name after a later split of surrounding chunks', () => {
    // regression for "split loses the stored name": overwrite a single chunk
    // with storeName, split the neighbourhood, then read the decoded names
    const s = new MagicString('abcdef')
    s.overwrite(1, 4, 'XYZ', { storeName: true })
    s.appendLeft(0, '(')
    s.appendLeft(6, ')')
    const map = s.generateDecodedMap({ hires: true })
    assert.deepEqual(map.names, ['bcd'])
    const editSegment = map.mappings[0].find(segment => segment.length === 5)
    assert.ok(editSegment)
    assert.equal(editSegment![4], 0)

    // contiguous re-overwrites keep the single-chunk name mapping valid
    const s2 = new MagicString('abcdef')
    s2.overwrite(1, 2, 'X', { storeName: true })
    s2.overwrite(2, 3, 'Y')
    const map2 = s2.generateDecodedMap({ hires: true })
    assert.deepEqual(map2.names, ['b'])
  })

  it('clone does not share mutable chunks with the original', () => {
    const s = new MagicString('abcdef')
    s.appendLeft(2, 'X')
    s.move(0, 2, 4)

    const clone = s.clone()
    // mutate the clone on both sides of an existing split
    clone.appendLeft(3, 'Y')
    clone.overwrite(4, 5, 'Q')
    clone.move(2, 4, 0)

    // original is untouched by clone edits
    assert.equal(s.toString(), 'cdabXef')
    assert.equal(clone.toString(), 'cYdabXQf')

    // and the clone's reordering is genuinely independent (no shared links)
    const clone2 = s.clone()
    clone2.remove(0, 6)
    assert.equal(s.toString(), 'cdabXef')
    assert.equal(clone2.toString(), '')

    // decoded maps of the frozen original still match independent model
    const model = new ReferenceModel('abcdef')
    model.appendLeft(2, 'X')
    model.move(0, 2, 4)
    const list = pieces(model)
    assert.deepEqual(s.generateDecodedMap({ hires: true }).mappings, expectedMappings(model, list, true))
  })

  it('bundle keeps same-name sources deduplicated and aligns sourcesContent', () => {
    const a = new MagicString('abc\n', { filename: 'same.js' })
    const b = new MagicString('abc\n', { filename: 'same.js' })
    a.overwrite(0, 3, 'ABC')
    b.prependRight(0, '// hi\n')

    const bundle = new Bundle()
    bundle.addSource({ filename: 'same.js', content: a })
    bundle.addSource({ filename: 'same.js', content: b })

    const map = bundle.generateDecodedMap({ includeContent: true })
    assert.deepEqual(map.sources, ['same.js'])
    assert.deepEqual(map.sourcesContent, ['abc\n'])
    // both sources resolve to the same source index
    const sourceIndices = new Set<number>()
    for (const line of map.mappings) {
      for (const segment of line) {
        if (segment.length >= 4)
          sourceIndices.add(segment[1])
      }
    }
    assert.deepEqual([...sourceIndices], [0])
    assert.equal(bundle.toString(), 'ABC\n\n// hi\nabc\n')

    // a duplicate filename with different content is rejected
    const conflict = new Bundle()
    conflict.addSource({ filename: 'x.js', content: new MagicString('one') })
    assert.throws(
      () => conflict.addSource({ filename: 'x.js', content: new MagicString('two') }),
      /duplicate filename/,
    )

    // omitContent fills non-included slots with null, one per unique source
    const bundle2 = new Bundle()
    bundle2.addSource({ filename: 'only.js', content: new MagicString('zz') })
    const map2 = bundle2.generateDecodedMap()
    assert.deepEqual(map2.sourcesContent, [null])
  })
})
