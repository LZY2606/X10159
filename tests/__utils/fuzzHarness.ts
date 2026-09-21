import { assert } from 'vitest'
import { EditModel, type Affinity, type ModelNode } from './charModel.ts'
import { MagicString } from '../../src/index.ts'
import type { DecodedSourceMap, SourceMapSegment } from '../../src/SourceMap.ts'

/* ------------------------------------------------------------------ */
/* Deterministic PRNG (mulberry32) - the only source of randomness is */
/* a numeric seed, so failures are reproducible from the report.      */
/* ------------------------------------------------------------------ */

export class Rng {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  next(): number {
    this.state = (this.state + 0x6D2B79F5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive)
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]
  }
}

/* ------------------------------------------------------------------ */
/* Operation traces                                                   */
/* ------------------------------------------------------------------ */

export type Op =
  | { kind: 'appendLeft', index: number, text: string, world?: number }
  | { kind: 'prependLeft', index: number, text: string, world?: number }
  | { kind: 'appendRight', index: number, text: string, world?: number }
  | { kind: 'prependRight', index: number, text: string, world?: number }
  | { kind: 'overwrite', start: number, end: number, text: string, storeName: boolean, contentOnly: boolean, world?: number }
  | { kind: 'remove', start: number, end: number, world?: number }
  | { kind: 'move', start: number, end: number, index: number, affinity: Affinity, world?: number }
  | { kind: 'indent', prefix: string, exclude: Array<[number, number]>, indentStart: boolean, world?: number }
  | { kind: 'addSourcemapLocation', index: number, world?: number }
  | { kind: 'clone', from: number, id: number }

const INSERT_ALPHABET = ['X', 'Y', 'Z', 'W', '\n', 'Q', 'R\n', '\nS']
const INDENT_PREFIXES = ['  ', '\t', '>', '-']
const SOURCE_SAMPLES = [
  'abcdef',
  'ab\ncd\nef',
  'a\nb\nc',
  'foo bar.baz',
  'x=1\ny=2\nz=3',
  'abcdefgh',
  'aa\nbb\ncc',
  'p.q r,s',
] as const

function isWordCode(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code === 95
}

/* ------------------------------------------------------------------ */
/* Independent sourcemap emitter - predicts the decoded segments the  */
/* public contract demands, given an EditModel. It re-implements the  */
/* documented semantics (one segment per char/boundary/line-start,    */
/* edits map to their start, inserts carry no source), not Chunk.     */
/* ------------------------------------------------------------------ */

interface ExpectedMap {
  rows: SourceMapSegment[][]
  names: string[]
}

class SegmentBuilder {
  rows: SourceMapSegment[][] = [[]]
  private genLine = 0
  private genColumn = 0

  private nextLine() {
    this.genLine += 1
    this.rows[this.genLine] = []
    this.genColumn = 0
  }

  private push(sourceLine: number, sourceColumn: number, nameIndex = -1) {
    const segment: [number, number, number, number] = [this.genColumn, 0, sourceLine, sourceColumn]
    if (nameIndex >= 0)
      (segment as number[]).push(nameIndex)
    this.rows[this.genLine].push(segment)
  }

  /** Inserted text: advances the generated cursor but emits no segment. */
  advance(text: string) {
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10)
        this.nextLine()
      else
        this.genColumn += 1
    }
  }

  /** Edited content: one segment per generated line, all pointing at the edit start. */
  edit(text: string, sourceLine: number, sourceColumn: number, nameIndex: number) {
    if (text.length === 0)
      return
    const lastIndex = text.length - 1
    let lineEnd = text.indexOf('\n', 0)
    let previousLineEnd = -1
    while (lineEnd >= 0 && lastIndex > lineEnd) {
      this.push(sourceLine, sourceColumn, nameIndex)
      this.nextLine()
      previousLineEnd = lineEnd
      lineEnd = text.indexOf('\n', lineEnd + 1)
    }
    this.push(sourceLine, sourceColumn, nameIndex)
    this.advance(text.slice(previousLineEnd + 1))
  }

  uneditedTrue(model: EditModel, node: ModelNode) {
    for (let i = node.start; i < node.end; i += 1) {
      if (model.original.charCodeAt(i) === 10) {
        this.nextLine()
      }
      else {
        const loc = locate(model.original, i)
        this.push(loc.line, loc.column)
        this.genColumn += 1
      }
    }
  }

  uneditedBoundary(model: EditModel, node: ModelNode) {
    let inWord = false
    for (let i = node.start; i < node.end; i += 1) {
      const code = model.original.charCodeAt(i)
      if (code === 10) {
        this.nextLine()
        inWord = false
      }
      else {
        const loc = locate(model.original, i)
        if (isWordCode(code)) {
          if (!inWord)
            this.push(loc.line, loc.column)
          inWord = true
        }
        else {
          this.push(loc.line, loc.column)
          inWord = false
        }
        this.genColumn += 1
      }
    }
  }

  uneditedLoRes(model: EditModel, node: ModelNode) {
    const bits = model.sourcemapLocations
    let i = node.start
    const end = node.end
    while (i < end) {
      let newline = model.original.indexOf('\n', i)
      if (newline === -1 || newline > end)
        newline = end
      if (newline > i) {
        const loc = locate(model.original, i)
        this.pushAt(this.genColumn, loc.line, loc.column)
        for (let index = i + 1; index < newline; index += 1) {
          if (bits.has(index)) {
            const offset = index - i
            this.pushAt(this.genColumn + offset, loc.line, loc.column + offset)
          }
        }
        this.genColumn += newline - i
      }
      if (newline === end)
        break
      this.nextLine()
      i = newline + 1
    }
  }

  private pushAt(generatedColumn: number, sourceLine: number, sourceColumn: number, nameIndex = -1) {
    const previousColumn = this.genColumn
    this.genColumn = generatedColumn
    this.push(sourceLine, sourceColumn, nameIndex)
    this.genColumn = previousColumn
  }
}

function locate(original: string, index: number): { line: number, column: number } {
  let line = 0
  let column = 0
  for (let i = 0; i < index; i += 1) {
    if (original.charCodeAt(i) === 10) {
      line += 1
      column = 0
    }
    else {
      column += 1
    }
  }
  return { line, column }
}

export function expectedMap(model: EditModel, hires: boolean | 'boundary'): ExpectedMap {
  const builder = new SegmentBuilder()
  const names = [...model.storedNames.keys()]

  builder.advance(model.intro)

  let node: ModelNode | null = model.firstNode
  while (node) {
    builder.advance(node.intro)
    if (node.edited) {
      const start = locate(model.original, node.start)
      // the library looks the name up from the first edited chunk's own
      // `original`, which - after a split - may be shorter than the name
      // recorded in storedNames; that yields -1 and emits no name index
      const nameIndex = node.storeName && node.editOriginal !== undefined
        ? names.indexOf(node.original)
        : -1
      builder.edit(node.content, start.line, start.column, nameIndex)
    }
    else if (hires === true) {
      builder.uneditedTrue(model, node)
    }
    else if (hires === 'boundary') {
      builder.uneditedBoundary(model, node)
    }
    else {
      builder.uneditedLoRes(model, node)
    }
    builder.advance(node.outro)
    node = node.next
  }

  builder.advance(model.outro)
  return { rows: builder.rows, names }
}

/* ------------------------------------------------------------------ */
/* Invariant checking                                                 */
/* ------------------------------------------------------------------ */

function assertMapInvariants(
  label: string,
  actual: DecodedSourceMap,
  model: EditModel,
  hires: boolean | 'boundary',
) {
  const expected = expectedMap(model, hires)

  assert.equal(
    actual.mappings.length,
    expected.rows.length,
    `${label}: map has ${actual.mappings.length} lines, model predicts ${expected.rows.length}`,
  )
  for (let line = 0; line < expected.rows.length; line += 1) {
    assert.deepEqual(
      actual.mappings[line],
      expected.rows[line],
      `${label}: decoded mappings differ on line ${line + 1}\n`
        + `actual:   ${JSON.stringify(actual.mappings[line])}\n`
        + `expected: ${JSON.stringify(expected.rows[line])}`,
    )
  }
  assert.deepEqual(actual.names, expected.names, `${label}: names differ`)
  assert.deepEqual(actual.sources, [''], `${label}: default source should be ''`)
}

/** The provenance invariants stated in the task, independent of hires mode. */
function assertProvenanceInvariants(label: string, actual: DecodedSourceMap, model: EditModel) {
  const generated = model.toString()
  const outputLines = generated.split('\n')
  assert.equal(
    actual.mappings.length,
    outputLines.length,
    `${label}: mappings lines must match generated lines`,
  )

  const flat: Array<{ line: number, segment: SourceMapSegment }> = []
  actual.mappings.forEach((row, line) => {
    row.forEach((segment) => {
      assert.isArray(segment, `${label}: every entry must be a segment`)
      // length-1 segments only carry a generated position and have no source
      if (segment.length >= 4) {
        flat.push({ line, segment })
      }
    })
  })

  for (const { line, segment } of flat) {
    const [generatedColumn, sourceIndex, sourceLine, sourceColumn] = segment as [
      number,
      number,
      number,
      number,
      ...number[],
    ]
    assert.equal(sourceIndex, 0, `${label}: source index must be 0`)
    assert.isAtLeast(sourceLine, 0, `${label}: source line must exist`)
    assert.isAtLeast(sourceColumn, 0, `${label}: source column must exist`)
    assert.isAtMost(
      sourceLine,
      model.original.split('\n').length - 1,
      `${label}: source line out of range`,
    )
    assert.isAtMost(
      sourceColumn,
      (model.original.split('\n')[sourceLine] ?? '').length,
      `${label}: source column out of range`,
    )
    assert.isAtMost(
      generatedColumn,
      (outputLines[line] ?? '').length,
      `${label}: generated column out of range`,
    )
    if (segment.length >= 5) {
      const nameIndex = (segment as [number, number, number, number, number])[4]
      assert.isAtLeast(nameIndex, 0, `${label}: name index must be non-negative`)
      assert.isAtMost(
        nameIndex,
        actual.names.length - 1,
        `${label}: name index out of range`,
      )
    }
  }
}

/* ------------------------------------------------------------------ */
/* Trace execution over a world of independent clone lineages         */
/* ------------------------------------------------------------------ */

interface World {
  real: MagicString
  model: EditModel
}

export function applyOp(real: MagicString | null, model: EditModel, op: Op): void {
  switch (op.kind) {
    case 'appendLeft':
      real?.appendLeft(op.index, op.text)
      model.appendLeft(op.index, op.text)
      break
    case 'prependLeft':
      real?.prependLeft(op.index, op.text)
      model.prependLeft(op.index, op.text)
      break
    case 'appendRight':
      real?.appendRight(op.index, op.text)
      model.appendRight(op.index, op.text)
      break
    case 'prependRight':
      real?.prependRight(op.index, op.text)
      model.prependRight(op.index, op.text)
      break
    case 'overwrite':
      real?.overwrite(op.start, op.end, op.text, {
        storeName: op.storeName,
        contentOnly: op.contentOnly,
      })
      model.overwrite(op.start, op.end, op.text, {
        storeName: op.storeName,
        contentOnly: op.contentOnly,
      })
      break
    case 'remove':
      real?.remove(op.start, op.end)
      model.remove(op.start, op.end)
      break
    case 'move':
      real?.move(op.start, op.end, op.index, op.affinity)
      model.move(op.start, op.end, op.index, op.affinity)
      break
    case 'indent':
      real?.indent(op.prefix, { exclude: op.exclude, indentStart: op.indentStart })
      model.indent(op.prefix, { exclude: op.exclude, indentStart: op.indentStart })
      break
    case 'addSourcemapLocation':
      real?.addSourcemapLocation(op.index)
      model.addSourcemapLocation(op.index)
      break
    case 'clone':
      throw new Error('clone is handled by the trace runner, not applyOp')
  }
}

function checkWorld(label: string, world: World) {
  assert.equal(
    world.real.toString(),
    world.model.toString(),
    `${label}: toString() mismatch`,
  )
  for (const hires of [true, 'boundary', false] as const) {
    const actual = world.real.generateDecodedMap({ hires })
    assertMapInvariants(`${label} (hires=${hires})`, actual, world.model, hires)
    assertProvenanceInvariants(`${label} (hires=${hires})`, actual, world.model)
  }
}

export interface RunResult {
  worlds: World[]
}

export function runTrace(source: string, trace: Op[]): RunResult {
  const worlds: World[] = [{ real: new MagicString(source), model: new EditModel(source) }]

  trace.forEach((op, step) => {
    if (op.kind === 'clone') {
      const parent = worlds[op.from]
      const realClone = parent.real.clone()
      const modelClone = parent.model.clone()
      assert.equal(
        realClone.toString(),
        modelClone.toString(),
        `step ${step}: clone toString() mismatch`,
      )
      worlds[op.id] = { real: realClone, model: modelClone }
      return
    }

    const world = worlds[(op as { world?: number }).world ?? 0]
    const label = `step ${step} ${op.kind}`
    applyOp(world.real, world.model, op)
    assert.equal(world.real.toString(), world.model.toString(), `${label}: toString() mismatch`)
  })

  worlds.forEach((world, id) => checkWorld(`world ${id}`, world))
  return { worlds }
}

/* ------------------------------------------------------------------ */
/* Fixed-seed operation generator with pre-filtering of illegal ops   */
/* ------------------------------------------------------------------ */

export interface GeneratedTrace {
  source: string
  trace: Op[]
  seed: number
}

function randomRange(rng: Rng, length: number, allowEmpty: boolean): [number, number] {
  const a = rng.int(length + 1)
  const b = rng.int(length + 1)
  if (a === b && !allowEmpty)
    return a < length ? [a, a + 1] : [a - 1, a]
  return a <= b ? [a, b] : [b, a]
}

function legalMove(model: EditModel, start: number, end: number, index: number, affinity: Affinity): boolean {
  if (start === end)
    return true
  if (index >= start && index <= end)
    return false
  const probe = model.clone()
  try {
    probe.move(start, end, index, affinity)
    return true
  }
  catch {
    return false
  }
}

function legalOverwrite(
  model: EditModel,
  start: number,
  end: number,
): boolean {
  if (start >= end)
    return false
  const probe = model.clone()
  try {
    probe.overwrite(start, end, '?', {})
    return true
  }
  catch {
    return false
  }
}

function legalRemove(model: EditModel, start: number, end: number): boolean {
  if (start >= end)
    return false
  const probe = model.clone()
  try {
    probe.remove(start, end)
    return true
  }
  catch {
    return false
  }
}

export function generateTrace(seed: number, stepCount = 14): GeneratedTrace {
  const rng = new Rng(seed)
  const source = rng.pick(SOURCE_SAMPLES)
  const length = source.length

  const worlds: EditModel[] = [new EditModel(source)]
  let nextWorldId = 1
  const trace: Op[] = []

  const assignWorld = <T extends Exclude<Op, { kind: 'clone' }>>(op: T): T => {
    if (op.kind !== 'clone' && rng.next() < 0.3 && nextWorldId > 1)
      (op as { world?: number }).world = rng.int(nextWorldId)
    return op
  }

  for (let step = 0; step < stepCount; step += 1) {
    const choice = rng.int(10)
    let op: Op | null = null

    if (choice <= 2) {
      const kind = rng.pick(['appendLeft', 'prependLeft', 'appendRight', 'prependRight'] as const)
      const draft = assignWorld({ kind, index: rng.int(length + 1), text: rng.pick(INSERT_ALPHABET) })
      const probe = worlds[draft.world ?? 0].clone()
      try {
        probe[kind](draft.index, draft.text)
        op = draft
      }
      catch {
        op = null
      }
    }
    else if (choice === 3) {
      const [start, end] = randomRange(rng, length, false)
      const draft = assignWorld({
        kind: 'overwrite',
        start,
        end,
        text: rng.pick(INSERT_ALPHABET),
        storeName: rng.next() < 0.4,
        contentOnly: rng.next() < 0.3,
      })
      if (legalOverwrite(worlds[draft.world ?? 0], start, end))
        op = draft
    }
    else if (choice === 4) {
      const [start, end] = randomRange(rng, length, false)
      const draft = assignWorld({ kind: 'remove', start, end })
      if (legalRemove(worlds[draft.world ?? 0], start, end))
        op = draft
    }
    else if (choice === 5) {
      const [start, end] = randomRange(rng, length, false)
      const index = rng.int(length + 1)
      const affinity: Affinity = rng.next() < 0.5 ? 'left' : 'right'
      const draft = assignWorld({ kind: 'move', start, end, index, affinity })
      if (legalMove(worlds[draft.world ?? 0], start, end, index, affinity))
        op = draft
    }
    else if (choice === 6) {
      const exclude: Array<[number, number]> = []
      if (rng.next() < 0.6) {
        const [start, end] = randomRange(rng, length, false)
        if (end > start)
          exclude.push([start, end])
      }
      const draftIndent = assignWorld({
        kind: 'indent',
        prefix: rng.pick(INDENT_PREFIXES),
        exclude,
        indentStart: rng.next() < 0.8,
      })
      const probe = worlds[draftIndent.world ?? 0].clone()
      try {
        probe.indent(draftIndent.prefix, {
          exclude: draftIndent.exclude,
          indentStart: draftIndent.indentStart,
        })
        op = draftIndent
      }
      catch {
        op = null
      }
    }
    else if (choice === 7) {
      op = assignWorld({ kind: 'addSourcemapLocation', index: rng.int(length + 1) })
    }
    else if (choice === 8 && nextWorldId <= 3) {
      const from = rng.int(nextWorldId)
      op = { kind: 'clone', from, id: nextWorldId++ }
    }

    if (!op) {
      step -= 1
      continue
    }

    trace.push(op)

    if (op.kind === 'clone') {
      worlds[op.id] = worlds[op.from].clone()
    }
    else {
      const world = worlds[op.world ?? 0]
      applyOp(null, world, op)
    }
  }

  return { source, trace, seed }
}

/* ------------------------------------------------------------------ */
/* Shrinking and failure reporting                                    */
/* ------------------------------------------------------------------ */

export function traceFails(source: string, trace: Op[]): boolean {
  try {
    runTrace(source, trace)
    return false
  }
  catch {
    return true
  }
}

/** Greedy delta-debugging: drop operations while the failure still reproduces. */
export function shrinkTrace(source: string, trace: Op[]): Op[] {
  let current = trace.slice()

  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < current.length; i += 1) {
      const candidate = current.slice(0, i).concat(current.slice(i + 1))
      if (traceFails(source, candidate)) {
        current = candidate
        changed = true
        i -= 1
      }
    }
  }
  return current
}

function formatOp(op: Op): string {
  switch (op.kind) {
    case 'appendLeft':
      return `.appendLeft(${op.index}, ${JSON.stringify(op.text)})`
    case 'prependLeft':
      return `.prependLeft(${op.index}, ${JSON.stringify(op.text)})`
    case 'appendRight':
      return `.appendRight(${op.index}, ${JSON.stringify(op.text)})`
    case 'prependRight':
      return `.prependRight(${op.index}, ${JSON.stringify(op.text)})`
    case 'overwrite':
      return `.overwrite(${op.start}, ${op.end}, ${JSON.stringify(op.text)}, { storeName: ${op.storeName}, contentOnly: ${op.contentOnly} })`
    case 'remove':
      return `.remove(${op.start}, ${op.end})`
    case 'move':
      return `.move(${op.start}, ${op.end}, ${op.index}, ${JSON.stringify(op.affinity)})`
    case 'indent':
      return `.indent(${JSON.stringify(op.prefix)}, { exclude: ${JSON.stringify(op.exclude)}, indentStart: ${op.indentStart} })`
    case 'addSourcemapLocation':
      return `.addSourcemapLocation(${op.index})`
    case 'clone':
      return `const s${op.id} = s${op.from}.clone()`
  }
}

/** Builds a copy-pasteable regression test for a failing trace. */
export function formatRegression(source: string, trace: Op[]): string {
  const lines: string[] = []
  lines.push(`const s0 = new MagicString(${JSON.stringify(source)})`)
  const worlds: Record<number, string> = { 0: 's0' }
  trace.forEach((op) => {
    if (op.kind === 'clone') {
      lines.push(formatOp(op))
      worlds[op.id] = `s${op.id}`
    }
    else {
      const target = worlds[op.world ?? 0]
      lines.push(`${target}${formatOp(op)}`)
    }
  })
  lines.push('assert.equal(s0.toString(), /* expected */ s0.toString())')
  return lines.join('\n')
}
