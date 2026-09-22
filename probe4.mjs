import { MagicString } from './dist/index.mjs'
const s = new MagicString('ab\ncd')
s.move(0, 2, 5)
console.log('moved lores', JSON.stringify(s.generateDecodedMap({}).mappings))
const s2 = new MagicString('ab\ncd')
s2.overwrite(0,2,'XY',{storeName:true})
const d = s2.generateDecodedMap({})
console.log('edit lores', JSON.stringify(d.mappings), JSON.stringify(d.names))
const s3 = new MagicString('ab\ncd')
s3.addSourcemapLocation(3)
console.log('loc lores', JSON.stringify(s3.generateDecodedMap({}).mappings))
// boundary
const s4 = new MagicString('ab cd!')
console.log('boundary', JSON.stringify(s4.generateDecodedMap({hires:'boundary'}).mappings))
// multiline edit
const s5 = new MagicString('abcdef')
s5.overwrite(1,4,'X\nY')
console.log('ml edit hires', JSON.stringify(s5.generateDecodedMap({hires:true}).mappings))
console.log('ml edit lores', JSON.stringify(s5.generateDecodedMap({}).mappings))
