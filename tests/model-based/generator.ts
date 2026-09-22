// Fixed-seed deterministic generator of *legal* editing sequences.
//
// Every candidate operation is applied to the provenance model first; the model
// throws on anything the public contract rejects (splitting an edited chunk,
// overwriting across a split point, moving into/inside itself or over a range an
// earlier move already split). Candidates that throw are discarded, so the
// library never sees an illegal call — every generated sequence is executable.

import type { SourceModel } from './sourceModel.ts'

export type Op =
  | { type: 'appendLeft', index: number, content: string }
  | { type: 'prependRight', index: number, content: string }
  | { type: 'appendRight', index: number, content: string }
  | { type: 'prependLeft', index: number, content: string }
  | { type: 'remove', start: number, end: number }
  | { type: 'overwrite', start: number, end: number, content: string, storeName: boolean }
  | { type: 'update', start: number, end: number, content: string, storeName: boolean }
  | { type: 'move', start: number, end: number, index: number, affinity: 'left' | 'right' }
  | { type: 'indent' }
  | { type: 'addSourcemapLocation', index: number }

/** Deterministic 32-bit PRNG (mulberry32). */
export class Random {
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

const INSERT_SAMPLES = ['x', 'Y', '[]', '\n', 'z\n', '\n\t', 'ab', '_', '\n\n']
const REPLACEMENT_SAMPLES = ['R', 'ab', '\n', 'x\ny', 'Z', '_\n', '']

export interface GeneratedCase {
  source: string
  ops: Op[]
  indentExclusions?: [number, number][]
}

function randomRange(rng: Random, n: number): [number, number] {
  const a = rng.int(n + 1)
  const b = rng.int(n + 1)
  return a <= b ? [a, b] : [b, a]
}

function cloneModel(model: SourceModel, ctor: new (s: string) => SourceModel): SourceModel {
  // Cheap structural copy via JSON for the plain-data parts...
  const copy = new ctor(model.original)
  copy.intro = model.intro
  copy.outro = model.outro
  copy.hasMoved = model.hasMoved
  copy.byStart = new Map()
  for (const [key, group] of model.byStart) {
    copy.byStart.set(key, { ...group, edit: group.edit ? { ...group.edit } : undefined })
  }
  copy.order = model.order.map(group => copy.byStart.get(group.start)!)
  for (const location of model.sourcemapLocations)
    copy.sourcemapLocations.add(location)
  for (const name of model.storedNames.keys())
    copy.storedNames.set(name, true)
  return copy
}

/**
 * Generates a legal sequence. `cloneEvery` > 0 schedules a clone() at a random
 * later step; the case records it so the harness can verify clone isolation.
 */
export function generateCase(
  seed: number,
  steps: number,
  ModelCtor: new (s: string) => SourceModel,
): GeneratedCase & { clonePoint: number } {
  const rng = new Random(seed)

  // short sources, always at least one newline sometimes; length 1..8 keeps
  // the number of distinct boundaries small and failures easy to read
  const n = 1 + rng.int(8)
  const alphabet = 'abc def\n\t'
  let source = ''
  for (let i = 0; i < n; i += 1)
    source += alphabet[rng.int(alphabet.length)]
  if (!source.includes('\n') && rng.next() < 0.4) {
    const at = 1 + rng.int(Math.max(1, source.length - 1))
    source = `${source.slice(0, at)}\n${source.slice(at)}`
  }

  const model = new ModelCtor(source)
  const ops: Op[] = []
  let indented = false

  const tryOp = (op: Op, apply: (m: SourceModel) => void): boolean => {
    const trial = cloneModel(model, ModelCtor)
    try {
      apply(trial)
    }
    catch {
      return false
    }
    apply(model)
    ops.push(op)
    return true
  }

  for (let step = 0; step < steps; step += 1) {
    if (!indented && rng.next() < 0.12) {
      // indent is a terminal structural op in practice: keep generating only
      // inserts/addSourcemapLocation afterwards (nothing splits edited chunks)
      tryOp({ type: 'indent' }, m => m.indent('\t'))
      indented = true
      continue
    }

    if (indented) {
      // indent() does not re-indent content inserted later, and post-indent
      // moves would need the generator to reason about indented output order;
      // addSourcemapLocation is the only state-neutral op afterwards.
      const index = rng.int(source.length)
      ops.push({ type: 'addSourcemapLocation', index })
      model.addSourcemapLocation(index)
      continue
    }

    const roll = rng.next()
    const length = source.length

    if (roll < 0.34) {
      const index = rng.int(length + 1)
      const content = rng.pick(INSERT_SAMPLES)
      const kind = rng.int(4)
      const op: Op = kind === 0
        ? { type: 'appendLeft', index, content }
        : kind === 1
          ? { type: 'appendRight', index, content }
          : kind === 2
            ? { type: 'prependRight', index, content }
            : { type: 'prependLeft', index, content }
      tryOp(op, (m) => {
        m[op.type](index, content)
      })
    }
    else if (roll < 0.44) {
      const [start, end] = randomRange(rng, length)
      if (start < end)
        tryOp({ type: 'remove', start, end }, m => m.remove(start, end))
    }
    else if (roll < 0.62) {
      const [start, end] = randomRange(rng, length)
      if (start < end) {
        const content = rng.pick(REPLACEMENT_SAMPLES)
        const storeName = rng.next() < 0.3
        const isUpdate = rng.next() < 0.5
        if (isUpdate) {
          tryOp(
            { type: 'update', start, end, content, storeName },
            m => m.update(start, end, content, { storeName }),
          )
        }
        else {
          tryOp(
            { type: 'overwrite', start, end, content, storeName },
            m => m.overwrite(start, end, content, { storeName }),
          )
        }
      }
    }
    else if (roll < 0.8) {
      const [start, end] = randomRange(rng, length)
      if (start < end) {
        const index = rng.int(length + 1)
        const affinity = rng.next() < 0.5 ? 'left' : 'right' as const
        if (!(index >= start && index <= end)) {
          tryOp(
            { type: 'move', start, end, index, affinity },
            m => m.move(start, end, index, affinity),
          )
        }
      }
    }
    else {
      const index = rng.int(length)
      ops.push({ type: 'addSourcemapLocation', index })
      model.addSourcemapLocation(index)
    }
  }

  return { source, ops, clonePoint: 1 + Math.floor(rng.int(Math.max(1, ops.length))) }
}

/** Applies an op list to any object exposing the editing methods. */
export function applyOps(
  target: SourceModel | {
    appendLeft(i: number, c: string): unknown
    prependRight(i: number, c: string): unknown
    appendRight(i: number, c: string): unknown
    prependLeft(i: number, c: string): unknown
    remove(s: number, e: number): unknown
    overwrite(s: number, e: number, c: string, o?: { storeName?: boolean }): unknown
    update(s: number, e: number, c: string, o?: { storeName?: boolean }): unknown
    move(s: number, e: number, i: number, a?: 'left' | 'right'): unknown
    indent(s: string): unknown
    addSourcemapLocation(i: number): unknown
  },
  ops: Op[],
): void {
  for (const op of ops) {
    switch (op.type) {
      case 'appendLeft':
      case 'prependRight':
      case 'appendRight':
      case 'prependLeft':
        target[op.type](op.index, op.content)
        break
      case 'remove':
        target.remove(op.start, op.end)
        break
      case 'overwrite':
        target.overwrite(op.start, op.end, op.content, { storeName: op.storeName })
        break
      case 'update':
        target.update(op.start, op.end, op.content, { storeName: op.storeName })
        break
      case 'move':
        target.move(op.start, op.end, op.index, op.affinity)
        break
      case 'indent':
        target.indent('\t')
        break
      case 'addSourcemapLocation':
        target.addSourcemapLocation(op.index)
        break
    }
  }
}

/** Renders a case as copy-pasteable regression-test source. */
export function renderCase(testCase: GeneratedCase): string {
  const lines = [
    `const s = new MagicString(${JSON.stringify(testCase.source)})`,
  ]
  for (const op of testCase.ops) {
    switch (op.type) {
      case 'appendLeft':
      case 'prependRight':
      case 'appendRight':
      case 'prependLeft':
        lines.push(`s.${op.type}(${op.index}, ${JSON.stringify(op.content)})`)
        break
      case 'remove':
        lines.push(`s.remove(${op.start}, ${op.end})`)
        break
      case 'overwrite':
        lines.push(`s.overwrite(${op.start}, ${op.end}, ${JSON.stringify(op.content)}${op.storeName ? ', { storeName: true }' : ''})`)
        break
      case 'update':
        lines.push(`s.update(${op.start}, ${op.end}, ${JSON.stringify(op.content)}${op.storeName ? ', { storeName: true }' : ''})`)
        break
      case 'move':
        lines.push(`s.move(${op.start}, ${op.end}, ${op.index}, ${JSON.stringify(op.affinity)})`)
        break
      case 'indent':
        lines.push('s.indent(\'\\t\')')
        break
      case 'addSourcemapLocation':
        lines.push(`s.addSourcemapLocation(${op.index})`)
        break
    }
  }
  return lines.join('\n')
}
