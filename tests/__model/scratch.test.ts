import { assert, describe, it } from 'vitest'
import { MagicString } from '../../src/index.ts'
import { EditModel } from './EditModel.ts'
import { expectedOutput } from './MappingOracle.ts'
import { generateSequence, type SequenceOp } from './generator.ts'

function decode(seg: any) {
  if (seg.length >= 4) {
    const out: any = { col: seg[0], source: seg[1], line: seg[2], column: seg[3] }
    if (seg.length === 5)
      out.name = seg[4]
    return out
  }
  return { col: seg[0] }
}

describe('scratch', () => {
  it('explores', () => {
    let tried = 0
    for (let seed = 1; seed <= 3000; seed += 1) {
      const { source, ops } = generateSequence(seed)
      tried += 1
      const s = new MagicString(source, { filename: 'source.js' })
      const model = new EditModel(source)
      let snapshot: { s: MagicString, m: EditModel } | null = null

      for (const op of ops as SequenceOp[]) {
        if (op.kind === 'cloneCheckpoint') {
          snapshot = { s: s.clone(), m: cloneModel(model) }
          continue
        }
        if (model.canApply(op) === false)
          throw new Error(`illegal op at seed ${seed}: ${JSON.stringify(op)}`)
        applyLib(s, op)
        model.apply(op)
      }

      assert.equal(s.toString(), model.toString(), `string seed ${seed} ops=${JSON.stringify(ops)}`)

      for (const hires of [true, 'boundary', false] as const) {
        const libMap = s.generateDecodedMap({ hires, includeContent: true, file: 'out.js', source: 'source.js' })
        const oracle = expectedOutput(model, hires)
        const libDecoded = libMap.mappings.map((line: any) => line.map(decode))
        assert.deepEqual(normalize(libDecoded, libMap.names), normalizeSegs(oracle.map.mappings, oracle.map.names), `seg seed ${seed} hires ${hires} ops=${JSON.stringify(ops)}`)
      }

      if (snapshot) {
        const prefixOps: SequenceOp[] = []
        for (const op of ops) {
          if (op.kind === 'cloneCheckpoint')
            break
          prefixOps.push(op)
        }
        assert.equal(snapshot.s.toString(), snapshot.m.toString(), `clone string seed ${seed}`)
        // isolation: mutating original must not touch clone
        const before = snapshot.s.toString()
        s.appendLeft(source.length, 'K')
        assert.equal(snapshot.s.toString(), before, `isolation seed ${seed}`)
        void prefixOps
      }
    }
    console.log('tried', tried)
  })
})

function normalizeSegs(segs: any, names: string[]) {
  return segs.map((line: any) => line.map((s: any) => {
    const out: any = { col: s.col, source: s.source, line: s.line, column: s.column }
    if (s.name !== undefined)
      out.name = s.name
    return out
  }))
}

function normalize(segs: any, names: string[]) {
  return segs.map((line: any) => line.map((s: any) => {
    const out: any = { col: s.col, source: s.source, line: s.line, column: s.column }
    if (s.name !== undefined)
      out.name = names.indexOf ? s.name : s.name
    if ('name' in s)
      out.name = s.name
    return out
  }))
}

function cloneModel(m: EditModel): EditModel {
  const c = new EditModel(m.original)
  c.intro = m.intro
  c.outro = m.outro
  c.items = m.items.map(i => ({ ...i }))
  c.byStart = new Map(m.byStart)
  c.byEnd = new Map(m.byEnd)
  c.sourcemapLocations = new Set(m.sourcemapLocations)
  c.names = [...m.names]
  c.hasMoved = m.hasMoved
  return c
}

function applyLib(s: MagicString, op: any) {
  switch (op.kind) {
    case 'appendLeft': s.appendLeft(op.index, op.content); break
    case 'appendRight': s.appendRight(op.index, op.content); break
    case 'prependLeft': s.prependLeft(op.index, op.content); break
    case 'prependRight': s.prependRight(op.index, op.content); break
    case 'remove': s.remove(op.start, op.end); break
    case 'overwrite': s.overwrite(op.start, op.end, op.content, { storeName: op.storeName }); break
    case 'move': s.move(op.start, op.end, op.index, op.affinity); break
    case 'indent': s.indent(op.indentStr, { exclude: op.exclude, indentStart: op.indentStart }); break
    case 'addSourcemapLocation': s.addSourcemapLocation(op.index); break
  }
}
