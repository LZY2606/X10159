import { writeFileSync } from 'node:fs'
import { it } from 'vitest'
import { MagicString } from '../../src/index.ts'
import { ReferenceModel } from './reference-model.ts'
import { generateCase } from './generator.ts'

function applyOps(target: any, ops: any[]) {
  for (const op of ops) {
    switch (op.type) {
      case 'appendLeft': target.appendLeft(op.index, op.text); break
      case 'prependRight': target.prependRight(op.index, op.text); break
      case 'overwrite': target.overwrite(op.start, op.end, op.text, { storeName: op.storeName }); break
      case 'remove': target.remove(op.start, op.end); break
      case 'move': target.move(op.start, op.end, op.index, op.affinity); break
      case 'indent': target.indent(op.indentStr); break
      case 'addSourcemapLocation': target.addSourcemapLocation(op.index); break
    }
  }
}

it('find first library throw', () => {
  for (let i = 0; i < 400; i++) {
    const seed = (20260923 + i) >>> 0
    const g = generateCase(seed, i % 2 === 0)
    const s = new MagicString(g.source)
    const m = new ReferenceModel(g.source)
    try {
      g.ops.forEach((op, idx) => {
        applyOps(s, [op]); m.apply(op)
      })
    }
    catch (e: any) {
      console.log('SEED', seed, 'SOURCE', JSON.stringify(g.source))
      console.log('OPS', JSON.stringify(g.ops, null, 1))
      console.log('ERR', e.message)
      break
    }
  }
})

it('dump', () => {
  let out = ''
  for (let i = 0; i < 400; i++) {
    const seed = (20260923 + i) >>> 0
    const g = generateCase(seed, i % 2 === 0)
    const s = new MagicString(g.source)
    const m = new ReferenceModel(g.source)
    try {
      g.ops.forEach((op) => { applyOps(s, [op]); m.apply(op) })
    }
    catch (e: any) {
      out += `SEED ${seed} SOURCE ${JSON.stringify(g.source)}
OPS ${JSON.stringify(g.ops)}
ERR ${e.message}

`
    }
  }
  writeFileSync('debug-out.txt', out)
})

