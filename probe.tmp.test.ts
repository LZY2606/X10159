import { writeFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { MagicString } from './src/index.ts'
import { EditModel, type Op } from './tests/__utils/editModel.ts'
import { generateCase } from './tests/__utils/operationGenerator.ts'

function applyTo(s: MagicString, op: Op): void {
  switch (op.kind) {
    case 'appendLeft': s.appendLeft(op.index!, op.content!); break
    case 'prependLeft': s.prependLeft(op.index!, op.content!); break
    case 'appendRight': s.appendRight(op.index!, op.content!); break
    case 'prependRight': s.prependRight(op.index!, op.content!); break
    case 'remove': s.remove(op.start!, op.end!); break
    case 'move': s.move(op.start!, op.end!, op.to!, op.affinity); break
    case 'indent': s.indent(op.prefix!, { indentStart: op.indentStart }); break
    case 'addSourcemapLocation': s.addSourcemapLocation(op.index!); break
    case 'overwrite': s.overwrite(op.start!, op.end!, op.content ?? '', { storeName: op.storeName, contentOnly: op.contentOnly }); break
  }
}

describe('p', () => {
  it('prefixes', () => {
    const c = generateCase(12345)
    const lines: string[] = []
    for (let k = 0; k <= c.ops.length; k++) {
      const s = new MagicString(c.source)
      const m = new EditModel(c.source)
      for (let i = 0; i < k; i++) {
        const op = c.ops[i]
        m.apply(op)
        applyTo(s, op)
      }
      const diff = s.toString() !== m.toString()
      lines.push(`k=${k} ${diff ? 'DIFF' : 'ok'} lib=${JSON.stringify(s.toString())} model=${JSON.stringify(m.toString())}`)
    }
    writeFileSync('probe_prefixes.txt', lines.join('\n'))
  })
})
