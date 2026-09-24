import { MagicString } from './dist/index.mjs'
import { ReferenceModel, applyOp, checkDecodedMap, type Op } from './tests/model/ReferenceModel.ts'

function check(source: string, ops: Op[]) {
  const m = new ReferenceModel(source)
  const s = new MagicString(source)
  for (const op of ops) {
    applyOp(m, op)
    // @ts-expect-error dynamic
    const args = (op as any)
    const fn = (s as any)[op.type]
    if (op.type === 'overwrite') fn.call(s, op.start, op.end, op.text, op.options)
    else if (op.type === 'remove') fn.call(s, op.start, op.end)
    else if (op.type === 'move') fn.call(s, op.start, op.end, op.index, op.affinity)
    else if (op.type === 'indent') fn.call(s, op.indentStr, { exclude: op.exclude, indentStart: op.indentStart })
    else if (op.type === 'addSourcemapLocation') fn.call(s, op.index)
    else if (op.type === 'append' || op.type === 'prepend') fn.call(s, op.text)
    else fn.call(s, args.index, args.text)
    if (m.toString() !== s.toString()) {
      console.log('MISMATCH after', op.type, JSON.stringify(op))
      console.log('model:', JSON.stringify(m.toString()))
      console.log('lib  :', JSON.stringify(s.toString()))
      return false
    }
  }
  for (const hires of [false, true, 'boundary'] as const) {
    const map = s.generateDecodedMap({ hires })
    const err = checkDecodedMap(m, map.mappings as any, { hires })
    if (err) {
      console.log('MAP ERROR', hires, '::', err)
      console.log('ops:', JSON.stringify(ops))
      console.log('out:', JSON.stringify(s.toString()))
      console.log('mappings:', JSON.stringify(map.mappings))
      return false
    }
    if (JSON.stringify(map.names) !== JSON.stringify(m.storedNames)) {
      console.log('NAMES mismatch', map.names, m.storedNames)
      return false
    }
  }
  return true
}

const cases: Array<[string, Op[]]> = [
  ['abcdef', [{ type: 'move', start: 2, end: 4, index: 0, affinity: 'right' }]],
  ['abcdef', [
    { type: 'appendRight', index: 1, text: 'R1' },
    { type: 'appendLeft', index: 1, text: 'L1' },
    { type: 'appendRight', index: 4, text: 'R4' },
    { type: 'appendLeft', index: 4, text: 'L4' },
    { type: 'overwrite', start: 1, end: 4, text: 'ZZ', options: {} },
  ]],
  ['ab\ncd\nef', [{ type: 'indent', indentStr: '>>' }]],
  ['ab\ncd\nef', [{ type: 'indent', indentStr: '>>', exclude: [[3, 6]] }]],
  ['abcdefgh', [{ type: 'remove', start: 3, end: 5 }, { type: 'move', start: 1, end: 6, index: 8, affinity: 'right' }]],
  ['abcdef', [
    { type: 'appendRight', index: 3, text: 'I' },
    { type: 'move', start: 2, end: 4, index: 0, affinity: 'right' },
  ]],
  ['abcdef', [
    { type: 'move', start: 2, end: 4, index: 6, affinity: 'right' },
    { type: 'appendLeft', index: 4, text: 'Z' },
  ]],
  ['abcdef', [
    { type: 'overwrite', start: 1, end: 4, text: '', options: { storeName: true } },
    { type: 'appendRight', index: 2, text: 'x' },
  ]],
  ['ab\ncd', [
    { type: 'overwrite', start: 0, end: 2, text: 'X\nY', options: {} },
    { type: 'indent', indentStr: '>>' },
  ]],
  ['abcdef', [
    { type: 'appendRight', index: 2, text: '1' },
    { type: 'appendRight', index: 2, text: '2' },
    { type: 'prependRight', index: 2, text: '3' },
  ]],
]

let allOk = true
for (const [src, ops] of cases) {
  const ok = check(src, ops)
  console.log(ok ? 'ok  ' : 'FAIL', JSON.stringify(src), ops.length, 'ops')
  allOk = allOk && ok
}
process.exit(allOk ? 0 : 1)
