import { describe, it } from 'vitest'
import { MagicString } from '../../src/index.ts'
import { decode } from '@jridgewell/sourcemap-codec'

describe('probe2', () => {
  it('edge semantics', () => {
    // split inside removed range
    let s = new MagicString('abcdef')
    s.remove(2, 5)
    s.appendLeft(3, 'X').prependRight(4, 'Y')
    console.log('split-removed:', JSON.stringify(s.toString()))
    console.log('split-removed-map:', JSON.stringify(s.generateDecodedMap({ hires: true }).mappings))

    // indent with edited content + exclude
    s = new MagicString('abc\ndef\nghi')
    s.overwrite(4, 7, 'DEF') // def -> DEF
    s.indent('  ', { exclude: [0, 4] })
    console.log('indent-edited:', JSON.stringify(s.toString()))
    console.log('indent-edited-map:', JSON.stringify(s.generateDecodedMap({ hires: true }).mappings))

    // lo-res location on removed char and alive char
    s = new MagicString('abcdef')
    s.addSourcemapLocation(3) // removed
    s.addSourcemapLocation(1) // alive
    s.remove(2, 5)
    console.log('lores:', JSON.stringify(s.generateDecodedMap().mappings))

    // insert containing newline, hires true
    s = new MagicString('ab')
    s.appendLeft(1, 'X\nY')
    console.log('nl-insert:', JSON.stringify(s.generateDecodedMap({ hires: true }).mappings))

    // move then appendLeft at boundary
    s = new MagicString('abcdef')
    s.move(0, 2, 6)
    s.appendLeft(2, 'L').appendRight(2, 'R')
    console.log('move-then-insert:', JSON.stringify(s.toString()))

    // storeName then overwrite same range again, names order
    s = new MagicString('abcdef')
    s.overwrite(0, 3, 'X', { storeName: true })
    s.overwrite(3, 6, 'Y', { storeName: true })
    console.log('names:', JSON.stringify(s.generateDecodedMap({ hires: true }).names))
    console.log('names-map:', JSON.stringify(s.generateDecodedMap({ hires: true }).mappings))

    // empty string maps
    s = new MagicString('')
    s.append('x\ny')
    console.log('empty-map:', JSON.stringify(s.generateDecodedMap({ hires: true }).mappings))
  })
})
