// Deterministic, fixed-seed generator of legal edit sequences.
//
// Every candidate operation is proposed against the live reference model and
// only kept when the public contract accepts it (legal splits, non-overlapping
// edits, movable forward runs), so generated sequences never depend on the
// library throwing.

import type { Op } from './reference-model.ts'
import { ReferenceModel } from './reference-model.ts'

// Small, fast, deterministic PRNG (mulberry32). Same seed -> same sequence on
// every engine and every run.
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

  chance(probability: number): boolean {
    return this.next() < probability
  }
}

// Short sources: plain lines, blanks, tabs, word/non-word runs (for hires
// boundary) and a surrogate pair. Indices stay tiny so failure cases shrink
// well and stay readable.
const SOURCES = [
  '',
  'a',
  'ab',
  'abc',
  'abcd',
  'ab cd',
  'ab_cd',
  'a\nb',
  'abc\ndef',
  'ab\ncd\nef',
  'a\n\n\nb',
  '\nabc\n',
  'x = y\nz',
  'foo bar\n baz',
  'a😀b\nc',
  'tab\tcol',
  'a.b;c',
]

const INSERT_TEXTS = ['X', 'Y', '_', '12', '>>', 'Q\n', '\nZ', ' ', '()', ''] as const
const OVERWRITE_TEXTS = ['X', 'ZZ', '..', 'Q\nR', 'x\ny\nz', ''] as const
const INDENT_STRS = ['  ', '\t', '>'] as const

export interface GeneratedCase {
  seed: number
  source: string
  ops: Op[]
  // when present, the model/library are cloned after `cloneAt` main ops and the
  // clone is driven independently with `cloneOps` (isolation check)
  cloneAt: number | null
  cloneOps: Op[]
}

function randomIndex(rng: Random, length: number): number {
  // Bias slightly towards the boundaries where insert/move anchoring differs.
  if (rng.chance(0.3)) {
    return rng.pick([0, length, length, length > 0 ? 1 : 0, length > 0 ? length - 1 : 0])
  }
  return rng.int(length + 1)
}

function randomRange(rng: Random, length: number): [number, number] {
  if (length === 0)
    return [0, 0]
  const a = rng.int(length + 1)
  const b = rng.int(length + 1)
  return a <= b ? [a, b] : [b, a]
}

function proposeOp(rng: Random, model: ReferenceModel, source: string): Op | null {
  const length = source.length
  const kind = rng.int(9)
  switch (kind) {
    case 0:
    case 1: {
      const index = randomIndex(rng, length)
      if (!model.canInsertAt(index))
        return null
      return { type: 'appendLeft', index, text: rng.pick(INSERT_TEXTS) }
    }
    case 2:
    case 3: {
      const index = randomIndex(rng, length)
      if (!model.canInsertAt(index))
        return null
      return { type: 'prependRight', index, text: rng.pick(INSERT_TEXTS) }
    }
    case 4: {
      const [start, end] = randomRange(rng, length)
      if (!model.canOverwrite(start, end))
        return null
      return {
        type: 'overwrite',
        start,
        end,
        text: rng.pick(OVERWRITE_TEXTS),
        storeName: rng.chance(0.35),
      }
    }
    case 5: {
      const [start, end] = randomRange(rng, length)
      if (!model.canRemove(start, end))
        return null
      return { type: 'remove', start, end }
    }
    case 6: {
      const [start, end] = randomRange(rng, length)
      if (start === end)
        return null
      const index = randomIndex(rng, length)
      if (!model.canMove(start, end, index))
        return null
      return {
        type: 'move',
        start,
        end,
        index,
        affinity: rng.chance(0.5) ? 'left' : 'right',
      }
    }
    case 7: {
      return { type: 'indent', indentStr: rng.pick(INDENT_STRS) }
    }
    default: {
      const index = randomIndex(rng, length)
      if (index > length)
        return null
      return { type: 'addSourcemapLocation', index }
    }
  }
}

function generateOps(rng: Random, source: string, count: number, model: ReferenceModel = new ReferenceModel(source)): Op[] {
  const ops: Op[] = []
  let guard = 0
  while (ops.length < count && guard < count * 12) {
    guard += 1
    const op = proposeOp(rng, model, source)
    if (!op)
      continue
    model.apply(op)
    ops.push(op)
  }
  return ops
}

export function generateCase(seed: number, wantClone: boolean): GeneratedCase {
  const rng = new Random(seed)
  const source = rng.pick(SOURCES)
  const count = 10 + rng.int(15)
  const model = new ReferenceModel(source)
  const ops = generateOps(rng, source, count, model)

  let cloneAt: number | null = null
  let cloneOps: Op[] = []
  if (wantClone && ops.length > 1) {
    cloneAt = 1 + rng.int(ops.length - 1)
    // Diverging life for the clone: drive an independently seeded generator
    // forward from the exact clone state, so proposals stay legal there.
    const cloneModel = new ReferenceModel(source)
    for (let i = 0; i < cloneAt; i += 1)
      cloneModel.apply(ops[i])
    const cloneRng = new Random((seed ^ 0x9E3779B9) >>> 0)
    cloneOps = generateOps(cloneRng, source, 6 + cloneRng.int(6), cloneModel)
  }

  return { seed, source, ops, cloneAt, cloneOps }
}
