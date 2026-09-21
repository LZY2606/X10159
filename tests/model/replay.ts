/**
 * Replays generated ops against the real MagicString while the independent
 * EditingModel predicts the result, and compares toString(), clone isolation
 * and decoded sourcemaps for every lane after every op.
 */
import { assert } from 'vitest'
import { MagicString } from '../../src/index.ts'
import { EditingModel, type HiresMode } from './EditingModel.ts'
import type { GeneratedCase, TestOp } from './generator.ts'

export interface Mismatch {
  kind: 'throw' | 'toString' | 'map' | 'clone'
  message: string
  opIndex: number
  hires?: HiresMode
}

const HIRES_MODES: HiresMode[] = [false, true, 'boundary']

function createMagicString(source: string): MagicString {
  return new MagicString(source, { filename: 'input.js' })
}

function applyToMagicString(s: MagicString, op: TestOp): void {
  switch (op.type) {
    case 'appendLeft': s.appendLeft(op.index, op.text); return
    case 'appendRight': s.appendRight(op.index, op.text); return
    case 'prependLeft': s.prependLeft(op.index, op.text); return
    case 'prependRight': s.prependRight(op.index, op.text); return
    case 'append': s.append(op.text); return
    case 'prepend': s.prepend(op.text); return
    case 'overwrite': s.overwrite(op.start, op.end, op.text, { storeName: op.storeName }); return
    case 'remove': s.remove(op.start, op.end); return
    case 'move': s.move(op.start, op.end, op.index, op.affinity); return
    case 'indent':
      s.indent(op.indentStr, op.options && {
        exclude: op.options.exclude as [number, number][] | undefined,
        indentStart: op.options.indentStart,
      }); return
    case 'addSourcemapLocation': s.addSourcemapLocation(op.index); return
    case 'clone': return
  }
}

function decodeActualMap(s: MagicString, hires: HiresMode) {
  return s.generateDecodedMap({ hires, source: 'input.js' })
}

/**
 * Core, renderer-independent invariants over hires maps:
 *  - every mapped generated position holds an original character at that
 *    exact generated column, and the segment points at that character
 *  - surviving original characters are all mapped (hires === true)
 *  - pure insertions (append/prepend/intro/outro) never get a segment,
 *    while replacement characters of an overwrite map to the edit anchor
 */
function checkAtomInvariants(model: EditingModel, actualMappings: number[][][], hires: true | 'boundary'): string | null {
  const atoms = model.renderAtoms()
  const edits = model.renderEditAnchors()
  const at = new Map<string, typeof atoms[number]>()
  for (const a of atoms)
    at.set(`${a.genLine}:${a.genCol}`, a)

  for (let line = 0; line < actualMappings.length; line++) {
    for (const segment of actualMappings[line]) {
      if (segment.length < 4)
        return `hires=${String(hires)}: unexpected unary segment on line ${line}`
      const [genCol, , srcLine, srcCol] = segment
      const a = at.get(`${line}:${genCol}`)
      if (!a) {
        // edit segments may stand on a line that a trailing newline opened
        // with zero replacement characters left on it
        if (edits.some(e => e.genLine === line && e.genCol === genCol))
          continue
        return `hires=${String(hires)}: segment at generated ${line + 1}:${genCol} has no generated atom`
      }
      if (a.kind === 'insert')
        return `hires=${String(hires)}: inserted character at generated ${line + 1}:${genCol} was given a source segment`
      // edit atoms on continuation lines all anchor at the edit start; the
      // library emits one edit segment per generated line at that anchor
      if (a.kind !== 'edit' && (a.srcLine !== srcLine || a.srcCol !== srcCol)) {
        return `hires=${String(hires)}: segment at generated ${line + 1}:${genCol} points at ${srcLine + 1}:${srcCol}, expected ${a.srcLine + 1}:${a.srcCol} (original index ${a.origin})`
      }
      if (a.kind === 'edit' && a.genLine !== line) {
        return `hires=${String(hires)}: edit segment for generated ${line + 1}:${genCol} landed on wrong line`
      }
    }
  }

  if (hires === true) {
    for (const a of atoms) {
      if (a.kind !== 'original')
        continue
      const line = actualMappings[a.genLine]
      if (!line || !line.some(seg => seg[0] === a.genCol))
        return `hires=true: surviving original character (index ${a.origin}) at generated ${a.genLine + 1}:${a.genCol} has no segment`
    }
  }

  return null
}

function compareMaps(model: EditingModel, s: MagicString): { hires: HiresMode, message: string } | null {
  for (const hires of HIRES_MODES) {
    let actual
    try {
      actual = decodeActualMap(s, hires)
    }
    catch (e) {
      return { hires, message: `generateDecodedMap threw: ${(e as Error).message}` }
    }

    const expected = model.renderExpectedMap(hires)

    // exact structural comparison (names + every segment)
    try {
      assert.deepEqual(actual.names, expected.names)
      assert.deepEqual(actual.mappings, expected.mappings)
    }
    catch (e) {
      return {
        hires,
        message: `decoded map mismatch:\nexpected mappings ${JSON.stringify(expected.mappings)}\nactual   mappings ${JSON.stringify(actual.mappings)}\nexpected names ${JSON.stringify(expected.names)}\nactual names   ${JSON.stringify(actual.names)}`,
      }
    }

    if (hires !== false) {
      const inv = checkAtomInvariants(model, actual.mappings as number[][][], hires)
      if (inv)
        return { hires, message: inv }
    }
  }
  return null
}

interface Lane {
  s: MagicString
  model: EditingModel
}

/**
 * Runs one case. Returns a Mismatch describing the first failure, or null.
 * If `upTo` is given, only the first `upTo` ops are replayed (used by the
 * shrinker).
 */
export function runCase(testCase: GeneratedCase, upTo?: number): Mismatch | null {
  const limit = upTo ?? testCase.ops.length
  const lanes = new Map<number, Lane>()
  lanes.set(0, { s: createMagicString(testCase.source), model: new EditingModel(testCase.source) })

  for (let i = 0; i < limit; i++) {
    const op = testCase.ops[i]

    if (op.type === 'clone') {
      const parent = lanes.get(op.from)!
      let cloned: MagicString
      try {
        cloned = parent.s.clone()
      }
      catch (e) {
        return { kind: 'throw', opIndex: i, message: `clone threw: ${(e as Error).message}` }
      }
      lanes.set(op.lane, { s: cloned, model: parent.model.cloneDeep() })
      continue
    }

    const lane = lanes.get(op.lane)!

    try {
      applyToMagicString(lane.s, op)
    }
    catch (e) {
      return { kind: 'throw', opIndex: i, message: `library threw on op ${i} ${JSON.stringify(op)}: ${(e as Error).message}` }
    }
    lane.model.apply(op)

    const actualString = lane.s.toString()
    const expectedString = lane.model.toString()
    if (actualString !== expectedString) {
      return {
        kind: 'toString',
        opIndex: i,
        message: `toString mismatch after op ${i} ${JSON.stringify(op)}:\nexpected ${JSON.stringify(expectedString)}\nactual   ${JSON.stringify(actualString)}`,
      }
    }

    const mapFailure = compareMaps(lane.model, lane.s)
    if (mapFailure)
      return { kind: 'map', opIndex: i, hires: mapFailure.hires, message: mapFailure.message }

    // clone isolation: a fresh clone must mirror the current lane
    const freshClone = lane.s.clone()
    if (freshClone.toString() !== lane.model.toString()) {
      return {
        kind: 'clone',
        opIndex: i,
        message: `fresh clone text differs after op ${i}:\nmodel    ${JSON.stringify(lane.model.toString())}\nclone    ${JSON.stringify(freshClone.toString())}`,
      }
    }
  }

  // After the full sequence, mutate every cloned lane once and confirm it
  // neither shares mutable chunk state with another lane nor changes the
  // others ("clone shares mutable chunk" class).
  const snapshots = new Map<number, string>()
  for (const [id, lane] of lanes)
    snapshots.set(id, lane.s.toString())

  for (const [id, lane] of lanes) {
    const probe = lane.s.clone()
    probe.append('\u0000PROBE\u0000')
    if (lane.s.toString().includes('\u0000PROBE\u0000')) {
      return {
        kind: 'clone',
        opIndex: limit,
        message: `mutating a clone of lane ${id} also mutated the parent`,
      }
    }
  }
  for (const [id, lane] of lanes) {
    if (lane.s.toString() !== snapshots.get(id)) {
      return {
        kind: 'clone',
        opIndex: limit,
        message: `lane ${id} changed after another lane's clone probe`,
      }
    }
  }

  return null
}
