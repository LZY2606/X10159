import { MagicString } from './dist/index.mjs'
const t = (name, fn) => { try { console.log(name, '=>', JSON.stringify(fn())) } catch (e) { console.log(name, 'THROWS', e.message) } }

// 1. ordering of inserts at same boundary
t('appendLeft x2', () => new MagicString('abc').appendLeft(1,'X').appendLeft(1,'Y').toString())
t('prependRight x2', () => new MagicString('abc').prependRight(1,'X').prependRight(1,'Y').toString())
t('appendLeft+prependRight same idx', () => new MagicString('abc').appendLeft(1,'L').prependRight(1,'R').toString())
t('prependRight then appendLeft', () => new MagicString('abc').prependRight(1,'R').appendLeft(1,'L').toString())

// 2. insert strictly inside overwritten range
t('appendLeft inside overwrite', () => new MagicString('abcdef').overwrite(1,4,'XY').appendLeft(3,'!').toString())
t('prependRight inside overwrite', () => new MagicString('abcdef').overwrite(1,4,'XY').prependRight(3,'!').toString())
t('appendLeft inside remove', () => new MagicString('abcdef').remove(1,4).appendLeft(3,'!').toString())

// 3. overwrite edge inserts
t('overwrite clears edge inserts', () => {
  const s = new MagicString('abcdef')
  s.appendLeft(1,'L1').prependRight(1,'R1').appendLeft(4,'L4').prependRight(4,'R4')
  s.overwrite(1,4,'XY')
  return s.toString()
})
// remove edge inserts
t('remove keeps edge inserts', () => {
  const s = new MagicString('abcdef')
  s.appendLeft(1,'L1').prependRight(1,'R1').appendLeft(4,'L4').prependRight(4,'R4')
  s.appendLeft(2,'in2').prependRight(3,'in3')
  s.remove(1,4)
  return s.toString()
})
// 4. move contiguity
t('move non-contiguous', () => new MagicString('abcdef').move(0,2,4).move(0,3,6).toString())
t('move inside itself', () => new MagicString('abcdef').move(1,4,3).toString())
