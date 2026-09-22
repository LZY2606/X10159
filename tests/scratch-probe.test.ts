import { assert, describe, it } from 'vitest'
import { MagicString } from '../src/index.ts'

describe('probe', () => {
  it('move + inserts at boundaries', () => {
    const s = new MagicString('abcdef')
    s.appendLeft(2, 'L2') // left of c
    s.appendRight(2, 'R2') // right of b
    s.appendLeft(4, 'L4')
    s.move(2, 4, 0) // cd -> start
    console.log('A:', JSON.stringify(s.toString()))

    const t = new MagicString('abcdef')
    t.move(1, 3, 5)
    t.appendLeft(2, 'X') // index2 now moved chunk boundary?
    console.log('B:', JSON.stringify(t.toString()))
    const m = t.generateDecodedMap({ hires: true })
    console.log('Bmap:', JSON.stringify(m.mappings))
  })

  it('indent before existing appendRight', () => {
    const s = new MagicString('ab\ncdef\ngh')
    s.appendRight(3, 'Z') // at start of 'c' line
    s.indent('  ')
    console.log('C:', JSON.stringify(s.toString()))
    const m = s.generateDecodedMap({ hires: true })
    console.log('Cmap:', JSON.stringify(m.mappings))
  })

  it('storeName with interior split', () => {
    const s = new MagicString('abcdef')
    s.appendLeft(3, 'Q')
    s.overwrite(2, 5, 'XYZ', { storeName: true })
    const m = s.generateDecodedMap()
    console.log('D names:', JSON.stringify(m.names), JSON.stringify(m.mappings), JSON.stringify(s.toString()))
  })

  it('storeName clean + clone', () => {
    const s = new MagicString('abcdef')
    s.overwrite(2, 5, 'XYZ', { storeName: true })
    s.appendLeft(5, 'z')
    const c = s.clone()
    console.log('E:', JSON.stringify(s.toString()), JSON.stringify(c.generateDecodedMap().names))
  })

  it('empty string inserts', () => {
    const s = new MagicString('')
    s.appendLeft(0, 'aL')
    s.appendRight(0, 'aR')
    s.prependLeft(0, 'pL')
    s.prependRight(0, 'pR')
    console.log('F:', JSON.stringify(s.toString()))
    s.indent('  ')
    console.log('F indent:', JSON.stringify(s.toString()))
  })

  it('move affinity left after prior move', () => {
    const s = new MagicString('abcdef')
    s.move(0, 2, 4)
    console.log('G1:', JSON.stringify(s.toString()))
    s.move(4, 6, 2, 'left')
    console.log('G2:', JSON.stringify(s.toString()))
  })

  it('hires boundary', () => {
    const s = new MagicString('ab cd,ef')
    const m = s.generateDecodedMap({ hires: 'boundary' })
    console.log('H:', JSON.stringify(m.mappings[0]))
  })

  it('overwrite across moved split', () => {
    const s = new MagicString('abcdef')
    s.move(0, 2, 4)
    assert.throws(() => s.overwrite(1, 5, 'X'), /split point/)
    console.log('I ok')
    // but overwrite within still-forward region?
    const t = new MagicString('abcdef')
    t.move(0, 2, 6)
    t.overwrite(2, 4, 'X')
    console.log('J:', t.toString())
  })

  it('indent exclude exactness', () => {
    const s = new MagicString('ab\ncdef\ngh')
    s.indent('  ', { exclude: [[3, 7]] })
    console.log('K:', JSON.stringify(s.toString()))
  })
})
