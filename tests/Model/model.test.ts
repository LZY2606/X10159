import { assert, describe, it } from 'vitest'
import { MagicString } from '../../src/index.ts'
import { EditModel, type Op } from '../__utils/editModel.ts'
import {
  generateCase,
  renderCase,
} from '../__utils/operationGenerator.ts'

const SEED_COUNT = 220

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
    case 'overwrite':
      s.overwrite(op.start!, op.end!, op.content ?? '', {
        storeName: op.storeName,
        contentOnly: op.contentOnly,
      })
      break
  }
}

function replay(source: string, ops: Op[]): { s: MagicString, model: EditModel } {
  const s = new MagicString(source)
  const model = new EditModel(source)
  for (const op of ops) {
    model.apply(op)
    applyTo(s, op)
  }
  return { s, model }
}

function locator(source: string) {
  return (index: number) => {
    let line = 0
    let col = 0
    for (let i = 0; i < index; i += 1) {
      if (source.charCodeAt(i) === 10) {
        line += 1
        col = 0
      }
      else {
        col += 1
      }
    }
    return { line, col }
  }
}

// Checks the mapping invariants listed by name, in addition to an exact
// comparison against the independently predicted decoded map.
function checkCase(source: string, ops: Op[]): string | null {
  const { s, model } = replay(source, ops)
  const issues: string[] = []

  const expectedText = model.toString()
  if (s.toString() !== expectedText) {
    issues.push(
      `toString mismatch:\n  expected ${JSON.stringify(expectedText)}\n  actual   ${JSON.stringify(s.toString())}`,
    )
  }

  const actualHires = s.generateDecodedMap({ hires: true })
  if (JSON.stringify(actualHires.names) !== JSON.stringify(model.names)) {
    issues.push(
      `names mismatch:\n  expected ${JSON.stringify(model.names)}\n  actual   ${JSON.stringify(actualHires.names)}`,
    )
  }

  for (const hires of [true, false, 'boundary'] as const) {
    const actual = s.generateDecodedMap({ hires })
    const predicted = model.decodeMappings(hires)
    if (JSON.stringify(actual.mappings) !== JSON.stringify(predicted)) {
      issues.push(
        `decoded mappings mismatch (hires=${String(hires)}):\n  expected ${JSON.stringify(predicted)}\n  actual   ${JSON.stringify(actual.mappings)}`,
      )
    }
  }

  // Position-level walk over generated output, using provenance tags.
  const locate = locator(source)
  const byPos = new Map<string, number[]>()
  actualHires.mappings.forEach((lineSegs, line) => {
    for (const seg of lineSegs)
      byPos.set(`${line}:${seg[0]}`, seg)
  })
  // null marks an inserted (sourceless) column; otherwise the provenance tag
  const tagAtPosition = new Map<string, { kind: 'original', index: number } | { kind: 'edit', start: number } | null>()

  let genLine = 0
  let genCol = 0
  const advance = (ch: string, atColumn: () => void) => {
    if (ch === '\n') {
      genLine += 1
      genCol = 0
    }
    else {
      atColumn()
      genCol += 1
    }
  }

  for (const tag of model.provenance()) {
    if (tag.kind === 'original') {
      const { line, col } = locate(tag.index)
      advance(source[tag.index], () => {
        tagAtPosition.set(`${genLine}:${genCol}`, { kind: 'original', index: tag.index })
        const seg = byPos.get(`${genLine}:${genCol}`)
        if (!seg || seg.length < 4 || seg[2] !== line || seg[3] !== col) {
          issues.push(
            `surviving original index ${tag.index} at generated ${genLine}:${genCol} must map to ${line}:${col}, got ${seg ? JSON.stringify(seg) : 'no segment'}`,
          )
        }
      })
    }
    else if (tag.kind === 'insert') {
      for (const ch of tag.text) {
        advance(ch, () => {
          tagAtPosition.set(`${genLine}:${genCol}`, null)
          const seg = byPos.get(`${genLine}:${genCol}`)
          if (seg && seg.length >= 4) {
            issues.push(
              `inserted character at generated ${genLine}:${genCol} fabricates a source segment ${JSON.stringify(seg)}`,
            )
          }
        })
      }
    }
    else {
      // edit content: first column of each edit line is a segment at
      // tag.start; the exact decoded-map comparison already covers this
      for (const ch of tag.text)
        advance(ch, () => tagAtPosition.set(`${genLine}:${genCol}`, { kind: 'edit', start: tag.start }))
    }
  }

  for (const tag of model.provenance()) {
    if (tag.kind !== 'original')
      continue
  }

  // Segments on edit columns must resolve to that edit's range start, which
  // may be an original index whose characters were overwritten.
  for (const [line, lineSegs] of actualHires.mappings.entries()) {
    for (const seg of lineSegs) {
      if (seg.length < 4)
        continue
      const idx = sourceLineColumnToIndex(source, seg[2], seg[3])
      if (idx < 0) {
        issues.push(`segment points outside the source at ${seg[2]}:${seg[3]}`)
        continue
      }
      const tag = tagAtPosition.get(`${line}:${seg[0]}`)
      if (tag === null) {
        // already reported as inserted-text fabrication
      }
      else if (tag && tag.kind === 'edit' && idx !== tag.start) {
        issues.push(
          `edit segment at generated ${line}:${seg[0]} maps to original index ${idx} but the range starts at ${tag.start}`,
        )
      }
    }
  }
  return issues.length ? issues.join('\n') : null
}

// clone() must produce a fully independent, equal snapshot.
function checkClone(source: string, ops: Op[]): string | null {
  const { s, model } = replay(source, ops)
  const cloned = s.clone()
  const modelClone = model.clone()

  const snapshot = s.toString()
  if (cloned.toString() !== snapshot)
    return `clone output differs immediately: ${JSON.stringify(cloned.toString())} vs ${JSON.stringify(snapshot)}`
  if (modelClone.toString() !== snapshot)
    return 'reference clone output differs (model bug)'

  const mutation: Op = { kind: 'appendLeft', index: source.length, content: '\u00A7' }
  applyTo(s, mutation)
  model.apply(mutation)

  if (cloned.toString() !== snapshot) {
    return `mutating the original leaked into the clone: clone now ${JSON.stringify(cloned.toString())}`
  }
  if (s.toString() !== model.toString())
    return 'original diverged from the model after the post-clone mutation'

  const originalMap = JSON.stringify(s.generateDecodedMap({ hires: true }).mappings)
  const cloneMap = JSON.stringify(cloned.generateDecodedMap({ hires: true }).mappings)
  if (originalMap === cloneMap)
    return 'clone shares mutable map state with the original'

  return null
}

// Greedy delta-debugging shrink: remove operations (and retry in every order)
// until the prefix is locally minimal. Returns the shortest failing sequence.
function shrink(source: string, ops: Op[], failing: (ops: Op[]) => boolean): Op[] {
  let current = ops.slice()
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < current.length; i += 1) {
      const candidate = current.slice(0, i).concat(current.slice(i + 1))
      if (failing(candidate)) {
        current = candidate
        changed = true
        i -= 1
      }
    }
  }
  return current
}

function makeFailureReport(seed: number, source: string, ops: Op[], problem: string, phase: string): Error {
  const message = [
    `model test failure (phase: ${phase}, seed: ${seed})`,
    problem,
    '--- minimal regression case ---',
    renderCase(source, ops),
    `const map = s.generateDecodedMap({ hires: true })`,
    '-------------------------------',
  ].join('\n')
  return new Error(message)
}

describe('deterministic edit-sequence model', () => {
  it('fixed seeds cover legal edit sequences and mapping invariants', () => {
    for (let seed = 1; seed <= SEED_COUNT; seed += 1) {
      const { source, ops } = generateCase(seed)

      const modelFailure = checkCase(source, ops)
      if (modelFailure) {
        const minimal = shrink(source, ops, candidate => checkCase(source, candidate) !== null)
        throw makeFailureReport(seed, source, minimal, checkCase(source, minimal)!, 'model/map')
      }

      const cloneFailure = checkClone(source, ops)
      if (cloneFailure) {
        const minimal = shrink(source, ops, candidate => checkClone(source, candidate) !== null)
        throw makeFailureReport(seed, source, minimal, checkClone(source, minimal)!, 'clone')
      }
    }
  })

  it('generates stable sequences for a fixed seed', () => {
    const a = generateCase(12345)
    const b = generateCase(12345)
    assert.deepEqual(b, a)
    assert.equal(checkCase(a.source, a.ops), null)
  })
})
