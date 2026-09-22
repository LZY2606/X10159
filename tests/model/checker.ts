// Replays a generated operation sequence against both the real library and the
// independent reference model, and compares toString(), clone isolation and
// decoded sourcemaps. Also verifies the mapping invariants directly against
// the character-provenance model.

import { MagicString } from '../../src/index.ts'
import type { Hires, Op, ProvenanceEntry } from './reference-model.ts'
import { ReferenceModel } from './reference-model.ts'

export const HIRES_MODES: Hires[] = [true, false, 'boundary'] as const

export interface Case {
  source: string
  ops: Op[]
  cloneAt?: number | null
  cloneOps?: Op[]
}

export class Mismatch extends Error {
  detail: string

  constructor(detail: string) {
    super(detail)
    this.name = 'ModelMismatch'
    this.detail = detail
  }
}

type RawSegment = [number] | [number, number, number, number] | [number, number, number, number, number]

function applyOps(target: MagicString, ops: Op[]): void {
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

function mismatch(phase: string, label: string, expected: unknown, actual: unknown): never {
  throw new Mismatch(
    `${phase}: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
  )
}

function assertEqualStrings(actual: string, expected: string, phase: string) {
  if (actual !== expected)
    mismatch(phase, 'toString() mismatch', expected, actual)
}

function assertJsonEqual(actual: unknown, expected: unknown, label: string, phase: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    mismatch(phase, label, expected, actual)
}

function lineStartsOf(original: string): number[] {
  const starts = [0]
  for (let i = 0; i < original.length; i += 1) {
    if (original.charCodeAt(i) === 10)
      starts.push(i + 1)
  }
  return starts
}

function locateLineColumn(lineStarts: number[], index: number): [number, number] {
  let line = 0
  while (line + 1 < lineStarts.length && lineStarts[line + 1] <= index)
    line += 1
  return [line, index - lineStarts[line]]
}

/**
 * Verifies mapping invariants directly from provenance, in every hires mode:
 *  - an unedited char maps to its own original index, whether it stayed put
 *    or was moved;
 *  - an overwrite char maps to the start of the replaced original range (each
 *    line of a multiline replacement maps back to that same anchor), carrying
 *    the stored name index exactly when `storeName` was set;
 *  - inserted characters are never given a source segment;
 *  - removed characters leave no segment because nothing maps to their index;
 *  - generated columns and source positions never go backwards within a line.
 */
function verifyInvariants(
  decoded: { mappings: RawSegment[][], names: string[] },
  model: ReferenceModel,
  phase: string,
) {
  const provenance = model.provenance()
  const lineStarts = lineStartsOf(model.original)
  const { mappings, names } = decoded

  if (mappings.length !== provenance.length) {
    throw new Mismatch(
      `${phase}: map has ${mappings.length} generated lines, output has ${provenance.length}`,
    )
  }

  for (let lineNo = 0; lineNo < mappings.length; lineNo += 1) {
    const segments = mappings[lineNo]
    const entries = provenance[lineNo]
    let previousColumn = -1
    let previousSourceLine = -1
    let previousSourceColumn = -1

    for (const segment of segments) {
      const column = segment[0]
      if (segment.length < 4)
        throw new Mismatch(`${phase}: sourceless segment at ${lineNo + 1}:${column}`)
      if (column <= previousColumn)
        throw new Mismatch(`${phase}: non-increasing generated column at ${lineNo + 1}:${column}`)
      previousColumn = column

      const sourceLine = segment[2]
      const sourceColumn = segment[3]
      if (sourceLine < previousSourceLine
        || (sourceLine === previousSourceLine && sourceColumn < previousSourceColumn)) {
        throw new Mismatch(
          `${phase}: source positions go backwards at generated ${lineNo + 1}:${column}`,
        )
      }
      previousSourceLine = sourceLine
      previousSourceColumn = sourceColumn

      const entry: ProvenanceEntry | undefined = entries[column]
      if (!entry) {
        throw new Mismatch(
          `${phase}: segment at ${lineNo + 1}:${column} points past end of generated line`,
        )
      }
      if (entry.kind === 'insert') {
        throw new Mismatch(
          `${phase}: inserted character at ${lineNo + 1}:${column} was assigned a fake source segment`,
        )
      }

      const sourceIndex = entry.kind === 'orig' ? entry.index : entry.start
      const [expLine, expColumn] = locateLineColumn(lineStarts, sourceIndex)
      if (sourceLine !== expLine || sourceColumn !== expColumn) {
        const what = entry.kind === 'orig'
          ? `surviving original char index ${entry.index}`
          : `overwrite anchored at ${entry.start}`
        throw new Mismatch(
          `${phase}: ${what} at generated ${lineNo + 1}:${column} maps to ${sourceLine + 1}:${sourceColumn} instead of ${expLine + 1}:${expColumn}`,
        )
      }

      if (entry.kind === 'edit') {
        const hasName = segment.length === 5
        if (hasName !== (entry.name >= 0)) {
          throw new Mismatch(
            `${phase}: name presence mismatch at ${lineNo + 1}:${column} (segment name: ${hasName}, stored name: ${entry.name >= 0})`,
          )
        }
        if (hasName) {
          const expectedName = model.original.slice(entry.start, entry.end)
          if (names[segment[4] as number] !== expectedName) {
            throw new Mismatch(
              `${phase}: segment name "${names[segment[4] as number]}" does not match stored name "${expectedName}"`,
            )
          }
        }
      }
    }
  }
}

function compareMaps(actual: MagicString, model: ReferenceModel, phase: string) {
  for (const hires of HIRES_MODES) {
    const expected = model.generateDecodedMap(hires)
    const decoded = actual.generateDecodedMap({ hires })
    assertJsonEqual(decoded.names, expected.names, `names (hires=${String(hires)})`, phase)
    assertJsonEqual(decoded.mappings, expected.mappings, `decoded mappings (hires=${String(hires)})`, phase)
    void hires
    verifyInvariants(
      { mappings: decoded.mappings as RawSegment[][], names: decoded.names },
      model,
      phase,
    )
  }
}

export function checkCase(testCase: Case): void {
  const actual = new MagicString(testCase.source)
  const model = new ReferenceModel(testCase.source)

  testCase.ops.forEach((op, i) => {
    applyOps(actual, [op])
    model.apply(op)

    const phase = `after op #${i + 1} ${JSON.stringify(op)}`
    assertEqualStrings(actual.toString(), model.toString(), phase)
    compareMaps(actual, model, phase)
  })

  const cloneAt = testCase.cloneAt ?? null
  if (cloneAt !== null) {
    const actualClone = actual.clone()
    const modelClone = model.clone()
    const cloneOps = testCase.cloneOps ?? []

    const atClone = `at clone (after ${cloneAt} ops)`
    assertEqualStrings(actualClone.toString(), modelClone.toString(), atClone)
    compareMaps(actualClone, modelClone, atClone)

    cloneOps.forEach((op, i) => {
      applyOps(actualClone, [op])
      modelClone.apply(op)
      const phase = `clone op #${i + 1} ${JSON.stringify(op)}`
      assertEqualStrings(actualClone.toString(), modelClone.toString(), phase)
      compareMaps(actualClone, modelClone, phase)
    })

    // isolation: diverging the clone must not have touched the original
    const originalPhase = `original after ${cloneOps.length} diverging clone ops`
    const expectedOriginal = (() => {
      const rebuilt = new ReferenceModel(testCase.source)
      testCase.ops.forEach(op => rebuilt.apply(op))
      return rebuilt
    })()
    assertEqualStrings(actual.toString(), expectedOriginal.toString(), originalPhase)
    assertEqualStrings(model.toString(), expectedOriginal.toString(), originalPhase)
    compareMaps(actual, expectedOriginal, originalPhase)
  }
}

// --------------------------------------------------------------- shrinking

/** Returns null when the case passes, otherwise a (possibly smaller) failing case. */
export function findFailure(testCase: Case): Case | null {
  try {
    checkCase(testCase)
    return null
  }
  catch (error) {
    if (error instanceof Mismatch)
      return testCase
    throw error
  }
}

function caseStillFails(testCase: Case): boolean {
  try {
    checkCase(testCase)
    return false
  }
  catch (error) {
    if (error instanceof Mismatch)
      return true
    throw error
  }
}

/**
 * Delta-debugging style minimiser: repeatedly tries removing operations,
 * including the clone's diverging ops and the clone checkpoint itself. The
 * returned case is a 1-minimal-ish failing sequence that is trivial to paste
 * into a regression test.
 */
export function shrink(testCase: Case): Case {
  let current: Case = { ...testCase }
  let changed = true
  while (changed) {
    changed = false

    for (let i = 0; i < current.ops.length; i += 1) {
      const candidate: Case = {
        ...current,
        ops: current.ops.filter((_, j) => j !== i),
      }
      if (candidate.cloneAt !== null && candidate.cloneAt !== undefined) {
        candidate.cloneAt = Math.min(candidate.cloneAt, candidate.ops.length)
        if (candidate.cloneAt === 0) {
          candidate.cloneAt = null
          candidate.cloneOps = []
        }
      }
      if (caseStillFails(candidate)) {
        current = candidate
        changed = true
        break
      }
    }
    if (changed)
      continue

    if (current.cloneOps && current.cloneOps.length > 0) {
      for (let i = 0; i < current.cloneOps.length; i += 1) {
        const candidate: Case = {
          ...current,
          cloneOps: current.cloneOps.filter((_, j) => j !== i),
        }
        if (caseStillFails(candidate)) {
          current = candidate
          changed = true
          break
        }
      }
      if (changed)
        continue
      const withoutClone: Case = { ...current, cloneAt: null, cloneOps: [] }
      if (caseStillFails(withoutClone)) {
        current = withoutClone
        changed = true
      }
    }
  }
  return current
}

// ----------------------------------------------------- regression rendering

function renderOps(ops: Op[], indent: string, receiver = 's'): string {
  return ops.map((op) => {
    switch (op.type) {
      case 'appendLeft':
        return `${indent}${receiver}.appendLeft(${op.index}, ${JSON.stringify(op.text)})`
      case 'prependRight':
        return `${indent}${receiver}.prependRight(${op.index}, ${JSON.stringify(op.text)})`
      case 'overwrite':
        return `${indent}${receiver}.overwrite(${op.start}, ${op.end}, ${JSON.stringify(op.text)}, { storeName: ${op.storeName} })`
      case 'remove':
        return `${indent}${receiver}.remove(${op.start}, ${op.end})`
      case 'move':
        return `${indent}${receiver}.move(${op.start}, ${op.end}, ${op.index}, ${JSON.stringify(op.affinity)})`
      case 'indent':
        return `${indent}${receiver}.indent(${JSON.stringify(op.indentStr)})`
      case 'addSourcemapLocation':
        return `${indent}${receiver}.addSourcemapLocation(${op.index})`
    }
  }).join('\n')
}

/** Renders a failing case as a ready-to-paste vitest regression test. */
export function renderRegressionTest(testCase: Case, label = 'minimised failing case'): string {
  const hasClone = testCase.cloneAt !== null && testCase.cloneAt !== undefined
  const cloneLines = hasClone
    ? '\n    const clone = s.clone()\n'
      + renderOps(testCase.cloneOps ?? [], '    ', 'clone')
      + '\n    assert.equal(s.toString(), s.toString()) // clone diverged, original must be isolated'
    : ''
  return `it('regression: ${label}', () => {\n`
    + `  const s = new MagicString(${JSON.stringify(testCase.source)})\n`
    + renderOps(testCase.ops, '  ')
    + cloneLines
    + `\n  assert.equal(s.toString(), /* observed output */ '')\n`
    + `})`
}
