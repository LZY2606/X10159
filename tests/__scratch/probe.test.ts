import { describe, it } from 'vitest'
import { MagicString } from '../../src/index.ts'

describe('probe', () => {
  it('slots', () => {
    let s = new MagicString('abc')
    s.appendLeft(1, 'A').prependLeft(1, 'B')
    s.prependRight(1, 'C').appendRight(1, 'D')
    console.log('slots:', JSON.stringify(s.toString()))

    s = new MagicString('ab')
    s.appendLeft(0, 'L').prependLeft(0, 'PL')
    s.appendRight(2, 'R').prependRight(2, 'PR')
    console.log('edges:', JSON.stringify(s.toString()))

    s = new MagicString('abcdef')
    s.appendLeft(3, '(').appendRight(3, '[').appendLeft(6, ')').appendRight(6, ']')
    s.move(3, 6, 0)
    console.log('moved-slots:', JSON.stringify(s.toString()))

    s = new MagicString('abcdef')
    s.move(3, 6, 0)
    s.appendLeft(3, '<').appendRight(3, '>')
    console.log('postmove-insert:', JSON.stringify(s.toString()))

    s = new MagicString('abcdef')
    s.appendLeft(2, '(').appendRight(2, '[').appendLeft(4, ')').appendRight(4, ']')
    s.remove(2, 4)
    console.log('remove-edges:', JSON.stringify(s.toString()))

    s = new MagicString('abcdef')
    s.appendLeft(2, '(').appendRight(2, '[').appendLeft(4, ')').appendRight(4, ']')
    s.overwrite(2, 4, 'X')
    console.log('overwrite:', JSON.stringify(s.toString()))

    s = new MagicString('abcdef')
    s.appendLeft(2, '(').appendRight(2, '[').appendLeft(4, ')').appendRight(4, ']')
    s.overwrite(2, 4, 'X', { contentOnly: true })
    console.log('overwrite-co:', JSON.stringify(s.toString()))
  })
})
