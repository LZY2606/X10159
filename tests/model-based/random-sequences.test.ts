import type { Hires, Op } from './model.ts'
import { assert, describe, it } from 'vitest'
import { MagicString } from '../../src/index.ts'
import { generateOperations } from './generator.ts'
import { ReferenceModel } from './model.ts'

/*
 * Model-based differential tests.
 *
 * Every generated sequence is replayed against:
 *   - the real MagicString
 *   - the independent ReferenceModel (a simple character-provenance model)
 *   - a live clone of the MagicString, plus its own reference model
 *
 * After each op the generated strings must agree, and at checkpoints the
 * decoded sourcemap (hires true/false/"boundary") must agree exactly. The
 * map invariants (unchanged chars -> their original index, pure inserts have
 * no segment, moved chars keep their origin, removed chars emit nothing) are
 * checked independently of the exact-segment comparison, so a regression that
 * happens to keep segment counts but moves columns is still caught.
 */

interface World {
  lib: MagicString
  model: ReferenceModel
  label: string
}

const SHORT_SOURCES = [
  'abcdef',
  'ab cd ef',
  'abc\ndef',
  'a\nb\nc',
  'foo = 1;\nbar = 2;',
  'x',
  '\r\nab\nc',
  'aaa bbb!cc',
] as const

// A fixed seed keeps the whole suite deterministic across machines and runs.
const BASE_SEED = 0x4D53_4D44 // "MSMD"
const SEQUENCES_PER_SOURCE = 42
const OPS_PER_SEQUENCE = 14
const HIRES_MODES: Hires[] = [true, false, 'boundary']

function checkText(worlds: World[]): string | null {
  const expected = worlds[0].model.toString()
  for (const world of worlds) {
    const actual = world.lib.toString()
    if (actual !== expected)
      return `${world.label} toString mismatch\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`
    const modelText = world.model.toString()
    if (modelText !== expected)
      return `${world.label} model diverged: ${JSON.stringify(modelText)}`
  }
  return null
}

function checkMaps(worlds: World[]): string | null {
  for (const hires of HIRES_MODES) {
    const expected = worlds[0].model.expectedMappings(hires)
    for (const world of worlds) {
      const decoded = world.lib.generateDecodedMap({ hires })
      if (decoded.names.join('') !== expected.names.join('')) {
        return `${world.label} names mismatch (hires=${String(hires)})\n  actual:   ${JSON.stringify(decoded.names)}\n  expected: ${JSON.stringify(expected.names)}`
      }
      if (JSON.stringify(decoded.mappings) !== JSON.stringify(expected.lines)) {
        return `${world.label} decoded mappings mismatch (hires=${String(hires)})\n  actual:   ${JSON.stringify(decoded.mappings)}\n  expected: ${JSON.stringify(expected.lines)}`
      }
    }
  }
  return null
}

function sourceLineStarts(source: string): number[] {
  const starts = [0]
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n')
      starts.push(i + 1)
  }
  return starts
}

function checkProvenance(worlds: World[]): string | null {
  // independent invariant: every source-bearing hires segment must sit on a
  // generated character whose tracked origin is exactly that source index.
  // This catches: unchanged chars remapped wrongly, inserted chars faking a
  // source, moved chars losing their origin, and segments over removed text.
  for (const world of worlds) {
    const { text, origin } = world.model.render()
    const generatedLineStarts = [0]
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n')
        generatedLineStarts.push(i + 1)
    }
    const srcStarts = sourceLineStarts(world.model.source)
    const decoded = world.lib.generateDecodedMap({ hires: true })
    for (let lineIndex = 0; lineIndex < decoded.mappings.length; lineIndex++) {
      const line = decoded.mappings[lineIndex]
      const lineStart = generatedLineStarts[lineIndex]
      for (const segment of line) {
        if (segment.length < 4)
          continue
        const [genColumn, , srcLine, srcColumn] = segment
        const charOffset = lineStart + genColumn
        const sourceIndex = (srcStarts[srcLine] ?? 0) + srcColumn
        const trackedOrigin = origin[charOffset]
        if (trackedOrigin === null)
          return `${world.label} segment at ${lineIndex + 1}:${genColumn} fakes a source (${srcLine + 1}:${srcColumn}) for an inserted character`
        if (trackedOrigin !== sourceIndex) {
          return `${world.label} segment at ${lineIndex + 1}:${genColumn} points at ${srcLine + 1}:${srcColumn} (index ${sourceIndex}), but the generated character originates at index ${trackedOrigin}`
        }
      }
    }
  }
  return null
}

interface RunOutcome {
  ok: boolean
  failure: string | null
}

function runSequence(source: string, allOps: Op[], cloneAt: number): RunOutcome {
  return runSequenceRaw(source, allOps, cloneAt, true)
}

function runSequenceRaw(source: string, allOps: Op[], cloneAt: number, checkRejections: boolean): RunOutcome {
  // primary world
  const lib = new MagicString(source, { filename: 'input.js' })
  const model = new ReferenceModel(source)
  // parallel clone world (created after `cloneAt` accepted ops)
  let cloneLib: MagicString | null = null
  let cloneModel: ReferenceModel | null = null
  const accepted: Op[] = []

  const worlds = (): Array<{ lib: MagicString, model: ReferenceModel, label: string }> => {
    const list = [{ lib, model, label: 'original' }]
    if (cloneLib && cloneModel)
      list.push({ lib: cloneLib, model: cloneModel, label: 'clone' })
    return list
  }

  for (let i = 0; i < allOps.length; i++) {
    const op = allOps[i]
    // legality is decided against the current state with a throwaway clone,
    // so overlapping edits are filtered before either world is touched
    const probe = model.clone()
    if (!probe.apply(op)) {
      if (checkRejections) {
        const rejecting = new MagicString(source, { filename: 'input.js' })
        let threw = false
        try {
          replayAll(rejecting, [...accepted, op])
        }
        catch {
          threw = true
        }
        if (!threw)
          return { ok: false, failure: `op #${i} (${op.type}) is illegal under the reference model but the library accepted it` }
      }
      continue
    }

    model.apply(op)
    replayAll(lib, [op])
    accepted.push(op)
    cloneModel?.apply(op)
    if (cloneLib)
      replayAll(cloneLib, [op])

    if (accepted.length - 1 === cloneAt) {
      cloneLib = lib.clone()
      cloneModel = model.clone()
    }

    {
      const failure = checkText(worlds())
      if (failure)
        return { ok: false, failure }
    }
    if (i % 3 === 0 || i === allOps.length - 1) {
      const mapFailure = checkMaps(worlds())
      if (mapFailure)
        return { ok: false, failure: mapFailure }
      const provFailure = checkProvenance(worlds())
      if (provFailure)
        return { ok: false, failure: provFailure }
    }
  }

  // explicit isolation of the diverged clone:
  //  - the two worlds must still render identically before the final mutation
  //  - marking the clone must not change the parent, and vice versa
  if (cloneLib && cloneModel) {
    const beforeFailure = checkText([
      { lib, model, label: 'original' },
      { lib: cloneLib, model: cloneModel, label: 'clone' },
    ])
    if (beforeFailure)
      return { ok: false, failure: beforeFailure }

    const parentText = lib.toString()
    cloneLib.append('\u0000C')
    cloneModel.append('\u0000C')
    if (lib.toString() !== parentText)
      return { ok: false, failure: 'clone shares mutable chunks with its parent' }

    const cloneText = cloneLib.toString()
    lib.append('\u0000P')
    model.append('\u0000P')
    if (cloneLib.toString() !== cloneText)
      return { ok: false, failure: 'mutation of the parent leaked into the clone' }

    // the markers differ on purpose: just confirm each world agrees with its
    // own model and that the other world's marker did not leak across
    if (lib.toString() !== model.toString()) {
      return { ok: false, failure: `original world after marker:
  actual:   ${JSON.stringify(lib.toString())}
  expected: ${JSON.stringify(model.toString())}` }
    }
    if (cloneLib.toString() !== cloneModel.toString()) {
      return { ok: false, failure: `clone world after marker:
  actual:   ${JSON.stringify(cloneLib.toString())}
  expected: ${JSON.stringify(cloneModel.toString())}` }
    }
    if (lib.toString().endsWith('\u0000C') || cloneLib.toString().endsWith('\u0000P'))
      return { ok: false, failure: 'isolation markers leaked between clone worlds' }
  }
  return { ok: true, failure: null }
}

function replayAll(lib: MagicString, ops: Op[]): void {
  for (const op of ops) {
    switch (op.type) {
      case 'appendLeft': {
        lib.appendLeft(op.index, op.text)
        break
      }
      case 'prependLeft': {
        lib.prependLeft(op.index, op.text)
        break
      }
      case 'appendRight': {
        lib.appendRight(op.index, op.text)
        break
      }
      case 'prependRight': {
        lib.prependRight(op.index, op.text)
        break
      }
      case 'append': {
        lib.append(op.text)
        break
      }
      case 'prepend': {
        lib.prepend(op.text)
        break
      }
      case 'overwrite':
        lib.overwrite(op.start, op.end, op.text, { storeName: op.storeName, contentOnly: op.contentOnly })
        break
      case 'remove': {
        lib.remove(op.start, op.end)
        break
      }
      case 'reset': {
        lib.reset(op.start, op.end)
        break
      }
      case 'move': {
        lib.move(op.start, op.end, op.index, op.affinity)
        break
      }
      case 'indent': {
        lib.indent(op.indentStr, { exclude: op.exclude, indentStart: op.indentStart })
        break
      }
      case 'addSourcemapLocation': {
        lib.addSourcemapLocation(op.index)
        break
      }
    }
  }
}

// ---- deterministic serialisation + ddmin-style reduction ----

function serializeOp(op: Op): string {
  const args: string[] = []
  const pushString = (value: string) => JSON.stringify(value)
  switch (op.type) {
    case 'appendLeft':
    case 'prependLeft':
    case 'appendRight':
    case 'prependRight':
      args.push(String(op.index), pushString(op.text))
      break
    case 'append':
    case 'prepend':
      args.push(pushString(op.text))
      break
    case 'overwrite': {
      args.push(String(op.start), String(op.end), pushString(op.text))
      const opts: string[] = []
      if (op.storeName)
        opts.push('storeName: true')
      if (op.contentOnly)
        opts.push('contentOnly: true')
      if (opts.length)
        args.push(`{ ${opts.join(', ')} }`)
      break
    }
    case 'remove':
    case 'reset':
      args.push(String(op.start), String(op.end))
      break
    case 'move':
      args.push(String(op.start), String(op.end), String(op.index))
      if (op.affinity === 'left')
        args.push('\'left\'')
      break
    case 'indent':
      args.push(pushString(op.indentStr))
      if (op.exclude || op.indentStart !== undefined) {
        const opts: string[] = []
        if (op.exclude)
          opts.push(`exclude: ${JSON.stringify(op.exclude)}`)
        if (op.indentStart !== undefined)
          opts.push(`indentStart: ${op.indentStart}`)
        args.push(`{ ${opts.join(', ')} }`)
      }
      break
    case 'addSourcemapLocation':
      args.push(String(op.index))
      break
  }
  return `s.${op.type}(${args.join(', ')})`
}

function regressionSnippet(source: string, ops: Op[], failure: string): string {
  const lines = [
    'import { MagicString } from \'../src/index.ts\'',
    'import { ReferenceModel } from \'./model.ts\'',
    '',
    `const source = ${JSON.stringify(source)}`,
    'const s = new MagicString(source)',
    'const m = new ReferenceModel(source)',
    ...ops.map(op => `${serializeOp(op)}; m.apply(${JSON.stringify(op).replace(/"(\w+)":/g, '$1:')})`),
    `// failure: ${failure.split('\n').join('\n// ')}`,
  ]
  return lines.join('\n')
}

// ddmin over the raw (legal-only) accepted subsequence. We minimize the
// accepted sequence directly, since that is the library's actual input;
// illegal draws were filtered before touching any state.
function minimize(source: string, ops: Op[], cloneAt: number): { ops: Op[], cloneAt: number } {
  // reconstruct the legal subsequence the library actually received
  const clean = new ReferenceModel(source)
  const accepted: Op[] = []
  ops.forEach((op) => {
    if (clean.apply(op))
      accepted.push(op)
  })
  let current = accepted
  let currentCloneAt = Math.max(0, Math.min(cloneAt, current.length - 1))
  for (let round = 0; round < 12; round++) {
    let reduced = false
    for (let i = 0; i < current.length; i++) {
      const candidate = current.filter((_, idx) => idx !== i)
      const candidateCloneAt = Math.max(0, Math.min(currentCloneAt, candidate.length - 1))
      if (!runSequenceRaw(source, candidate, candidateCloneAt, false).ok) {
        current = candidate
        currentCloneAt = candidateCloneAt
        reduced = true
        break
      }
    }
    if (!reduced)
      break
  }
  return { ops: current, cloneAt: currentCloneAt }
}

describe('model-based differential tests (fixed seed)', () => {
  it('generates deterministic op sequences for the fixed seed', () => {
    const a = generateOperations({ source: SHORT_SOURCES[0], length: 20, seed: BASE_SEED })
    const b = generateOperations({ source: SHORT_SOURCES[0], length: 20, seed: BASE_SEED })
    assert.deepEqual(a, b)
  })

  for (const source of SHORT_SOURCES) {
    for (let seq = 0; seq < SEQUENCES_PER_SOURCE; seq++) {
      const seed = BASE_SEED ^ (source.length * 1_000_003) ^ (seq * 7919)
      it(`source ${JSON.stringify(source)} sequence ${seq}`, () => {
        const ops = generateOperations({ source, length: OPS_PER_SEQUENCE, seed })
        const cloneAt = (seq % (OPS_PER_SEQUENCE - 2)) + 1
        const outcome = runSequence(source, ops, cloneAt)
        if (!outcome.ok) {
          const minimized = minimize(source, ops, cloneAt)
          const minimal = minimized.ops
          const message = [
            outcome.failure,
            '',
            'minimal reproducing sequence:',
            minimal.map((op, i) => `  ${i + 1}. ${serializeOp(op)}`).join('\n'),
            '',
            'paste-ready regression test:',
            regressionSnippet(source, minimal, outcome.failure ?? ''),
          ].join('\n')
          assert.fail(message)
        }
        assert.isTrue(outcome.ok)
      })
    }
  }
})
