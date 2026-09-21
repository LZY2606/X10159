import type { Operation } from './generator.ts'
import { assert, describe, it } from 'vitest'
import { MagicString } from '../../src/index.ts'
import { applyReal } from './applyReal.ts'
import {
  checkProvenance,
  expectedMappings,
  outputText,
  pieces,
} from './emit.ts'
import {
  applyToModel,
  generateOperation,
  generateSequence,
  Random,
} from './generator.ts'
import { ReferenceModel } from './referenceModel.ts'

const HIRES_MODES = [false, true, 'boundary'] as const

interface CloneRecord {
  name: string
  frozenReal: MagicString
  frozenModel: ReferenceModel
  pairReal: MagicString
  pairModel: ReferenceModel
  localOp: Operation | null
}

interface Failure {
  index: number
  kind: 'throw' | 'invariant'
  detail: string
}

function verifyState(model: ReferenceModel, s: MagicString, label: string): Failure | null {
  const list = pieces(model)
  const expectedText = outputText(list)
  const actualText = s.toString()
  if (actualText !== expectedText) {
    return {
      index: -1,
      kind: 'invariant',
      detail: `${label}: toString mismatch\n  expected ${JSON.stringify(expectedText)}\n  actual   ${JSON.stringify(actualText)}`,
    }
  }

  for (const hires of HIRES_MODES) {
    const expectedMap = expectedMappings(model, list, hires)
    let actual: ReturnType<MagicString['generateDecodedMap']>
    try {
      actual = s.generateDecodedMap({ hires })
    }
    catch (error) {
      return { index: -1, kind: 'invariant', detail: `${label}: generateDecodedMap({hires:${JSON.stringify(hires)}}) threw: ${(error as Error).message}` }
    }
    if (JSON.stringify(actual.mappings) !== JSON.stringify(expectedMap)) {
      return {
        index: -1,
        kind: 'invariant',
        detail: `${label}: decoded mappings mismatch (hires=${JSON.stringify(hires)})\n  expected ${JSON.stringify(expectedMap)}\n  actual   ${JSON.stringify(actual.mappings)}`,
      }
    }
    if (JSON.stringify(actual.names) !== JSON.stringify(model.names)) {
      return {
        index: -1,
        kind: 'invariant',
        detail: `${label}: names mismatch (hires=${JSON.stringify(hires)})\n  expected ${JSON.stringify(model.names)}\n  actual   ${JSON.stringify(actual.names)}`,
      }
    }
    const violation = checkProvenance(model, list, actual.mappings)
    if (violation) {
      return {
        index: -1,
        kind: 'invariant',
        detail: `${label}: provenance invariant violated at ${violation.line}:${violation.column} (hires=${JSON.stringify(hires)})\n  expected ${violation.expected}\n  actual   ${violation.actual}`,
      }
    }
  }

  return null
}

function runSequence(source: string, operations: Operation[]): Failure | null {
  const model = new ReferenceModel(source)
  const s = new MagicString(source)
  const clones: CloneRecord[] = []

  for (let i = 0; i < operations.length; i++) {
    const operation = operations[i]

    if (operation.type === 'cloneCheck') {
      const n = clones.length
      const record: CloneRecord = {
        name: `__clone${n}`,
        frozenReal: s.clone(),
        frozenModel: model.clone(),
        pairReal: s.clone(),
        pairModel: model.clone(),
        localOp: null,
      }

      // choose a deterministic legal local mutation for the mutable pair
      const random = new Random(0x5EED + n * 7919 + i)
      for (let attempt = 0; attempt < 50; attempt++) {
        const candidate = generateOperation(random, record.pairModel)
        if (candidate && candidate.type !== 'cloneCheck') {
          record.localOp = candidate
          break
        }
      }

      const frozenFailure = verifyState(record.frozenModel, record.frozenReal, `clone #${n}`)
      if (frozenFailure)
        return { index: i, kind: 'invariant', detail: frozenFailure.detail }

      if (record.localOp) {
        applyToModel(record.pairModel, record.localOp)
        applyReal(record.pairReal, record.localOp)
        const pairFailure = verifyState(record.pairModel, record.pairReal, `mutated clone #${n} via localOp ${JSON.stringify(record.localOp)}`)
        if (pairFailure)
          return { index: i, kind: 'invariant', detail: pairFailure.detail }
      }

      clones.push(record)
      continue
    }

    try {
      applyReal(s, operation)
    }
    catch (error) {
      return { index: i, kind: 'throw', detail: `operation #${i} ${JSON.stringify(operation)} threw unexpectedly: ${(error as Error).message}` }
    }
    applyToModel(model, operation)

    const failure = verifyState(model, s, `after operation #${i} ${operation.type}`)
    if (failure)
      return { index: i, kind: 'invariant', detail: failure.detail }

    // the frozen clones must be completely isolated from later main edits
    for (const record of clones) {
      const expectedText = outputText(pieces(record.frozenModel))
      if (record.frozenReal.toString() !== expectedText) {
        return {
          index: i,
          kind: 'invariant',
          detail: `clone ${record.name} leaked after operation #${i} ${operation.type}\n  frozen expected ${JSON.stringify(expectedText)}\n  frozen actual   ${JSON.stringify(record.frozenReal.toString())}`,
        }
      }
    }
  }

  return null
}

/** Greedy fixpoint: drop one operation at a time while the failure survives. */
function shrink(source: string, operations: Operation[], failing: Failure): { operations: Operation[], failure: Failure } {
  let current = [...operations]
  let currentFailure = failing

  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < current.length; i++) {
      const candidate = current.slice(0, i).concat(current.slice(i + 1))
      const failure = runSequenceSafe(source, candidate)
      if (failure && failure.kind === currentFailure.kind) {
        current = candidate
        currentFailure = failure
        changed = true
        break
      }
    }
  }

  return { operations: current, failure: currentFailure }
}

function runSequenceSafe(source: string, operations: Operation[]): Failure | null {
  try {
    return runSequence(source, operations)
  }
  catch {
    // an over-shrunk sequence is illegal (e.g. a later op loses its enabling
    // edit) - treat as "no failure reproduced", not as a crash to minimise
    return null
  }
}

function renderCall(operation: Operation): string {
  switch (operation.type) {
    case 'appendLeft':
      return `s.appendLeft(${operation.index}, ${JSON.stringify(operation.content)})`
    case 'prependLeft':
      return `s.prependLeft(${operation.index}, ${JSON.stringify(operation.content)})`
    case 'appendRight':
      return `s.appendRight(${operation.index}, ${JSON.stringify(operation.content)})`
    case 'prependRight':
      return `s.prependRight(${operation.index}, ${JSON.stringify(operation.content)})`
    case 'overwrite':
      return `s.overwrite(${operation.start}, ${operation.end}, ${JSON.stringify(operation.content)}, { storeName: ${operation.storeName}, contentOnly: ${operation.contentOnly} })`
    case 'remove':
      return `s.remove(${operation.start}, ${operation.end})`
    case 'move':
      return `s.move(${operation.start}, ${operation.end}, ${operation.index}, ${JSON.stringify(operation.affinity)})`
    case 'indent':
      return `s.indent(${JSON.stringify(operation.indentStr)}, ${JSON.stringify(operation.options)})`
    case 'addSourcemapLocation':
      return `s.addSourcemapLocation(${operation.index})`
    case 'cloneCheck':
      return '__CLONE__'
  }
}

/** Renders a copy-pasteable regression test from a shrunk sequence. */
function renderRegression(source: string, operations: Operation[], failure: Failure, seed: number): string {
  // re-run purely on the model to learn frozen-clone snapshots
  const model = new ReferenceModel(source)
  const frozenTexts: string[] = []
  for (const operation of operations) {
    if (operation.type === 'cloneCheck') {
      frozenTexts.push(outputText(pieces(model.clone())))
    }
    else {
      applyToModel(model, operation)
    }
  }
  const finalText = outputText(pieces(model))
  const finalMappings = JSON.stringify(expectedMappings(model, pieces(model), true))

  const lines: string[] = [
    'import { assert, it } from \'vitest\'',
    'import { MagicString } from \'../../src/index.ts\'',
    '',
    `it('model regression (seed ${seed})', () => {`,
    `  const s = new MagicString(${JSON.stringify(source)})`,
  ]

  let cloneCount = 0
  for (const operation of operations) {
    const rendered = renderCall(operation)
    if (rendered === '__CLONE__') {
      lines.push(`  const __clone${cloneCount} = s.clone()`)
      cloneCount += 1
    }
    else {
      lines.push(`  ${rendered}`)
    }
  }

  frozenTexts.forEach((text, i) => {
    lines.push(`  assert.equal(__clone${i}.toString(), ${JSON.stringify(text)})`)
  })
  lines.push(`  assert.equal(s.toString(), ${JSON.stringify(finalText)})`)
  lines.push(`  assert.deepEqual(s.generateDecodedMap({ hires: true }).mappings, ${finalMappings})`)
  lines.push('})')

  return `\n${failure.detail}\n\nMinimal reproducer:\n${lines.join('\n')}\n`
}

describe('model-based edit sequences', () => {
  const SEED = 0xDEC0_1234
  const ITERATIONS = 72
  const MAX_OPERATIONS = 18

  for (let i = 0; i < ITERATIONS; i++) {
    const seed = SEED + i
    it(`legal sequence #${i} preserves text and mapping invariants (seed ${seed})`, () => {
      const length = 6 + (i % 12) // 6..17 operations
      void length
      const { source, operations } = generateSequence(seed, 6 + (i % 12) + 1)
      const failure = runSequence(source, operations)
      if (!failure)
        return

      const shrunk = shrink(source, operations, failure)
      assert.fail(renderRegression(source, shrunk.operations, shrunk.failure, seed))
    })
  }

  it('generated sequences are bounded and terminate', () => {
    const { operations } = generateSequence(SEED, MAX_OPERATIONS)
    assert.equal(operations.length, MAX_OPERATIONS)
  })
})
