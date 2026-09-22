/**
 * Fixed-seed random operation generator for the model-based tests.
 */
import type { EditOp } from './EditModel.ts'
import { EditModel } from './EditModel.ts'

export class Rng {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  next(): number {
    // mulberry32
    this.state = (this.state + 0x6D2B79F5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  int(n: number): number {
    return Math.floor(this.next() * n)
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability
  }
}

export const SOURCES = [
  '',
  'a',
  'abcdef',
  'ab\ncd\nef',
  'a\nb\nc',
  'x\n',
  'foo123_bar',
  'xy  xy z',
  'a\uD83D\uDE00bc',
  'lorem\nipsum',
] as const

const INSERT_CONTENTS = ['X', 'Y', '->', '|', '  ', 'Z\nW', '\n', '', '=='] as const
const REPLACEMENTS = ['Q', 'gh', 'Q\nR', ''] as const
const INDENT_STRINGS = ['  ', '\t'] as const

export type SequenceOp = EditOp | { kind: 'cloneCheckpoint' }

function boundary(model: EditModel, rng: Rng): number {
  return rng.int(model.original.length + 1)
}

function proposeEdit(model: EditModel, rng: Rng): EditOp | null {
  const len = model.original.length
  const roll = rng.int(10)

  if (roll < 4 && len > 0) {
    // insert
    const kind = rng.pick(['appendLeft', 'prependRight', 'appendRight', 'prependLeft'] as const)
    const index = boundary(model, rng)
    return { kind, index, content: rng.pick(INSERT_CONTENTS) }
  }
  if (roll < 6 && len >= 2) {
    const start = rng.int(len - 1)
    const end = start + 1 + rng.int(len - start)
    return { kind: 'remove', start, end }
  }
  if (roll < 8 && len >= 2) {
    const start = rng.int(len - 1)
    const end = start + 1 + rng.int(len - start)
    return {
      kind: 'overwrite',
      start,
      end,
      content: rng.pick(REPLACEMENTS),
      storeName: rng.bool(0.3),
    }
  }
  if (roll < 9 && len >= 2) {
    const start = rng.int(len - 1)
    const end = start + 1 + rng.int(len - start)
    let index = boundary(model, rng)
    if (index >= start && index <= end)
      index = rng.bool() ? 0 : len
    return {
      kind: 'move',
      start,
      end,
      index,
      affinity: rng.bool(0.35) ? 'left' : 'right',
    }
  }
  if (len > 0) {
    return { kind: 'addSourcemapLocation', index: boundary(model, rng) }
  }
  return null
}

export interface Generated {
  source: string
  ops: SequenceOp[]
}

export function generateSequence(seed: number): Generated {
  const rng = new Rng(seed)
  const source = rng.pick(SOURCES)
  const model = new EditModel(source)
  const length = source.length
  const ops: SequenceOp[] = []
  const opCount = 3 + rng.int(11)

  for (let i = 0; i < opCount; i += 1) {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const op = proposeEdit(model, rng)
      if (op && model.canApply(op)) {
        model.apply(op)
        ops.push(op)
        break
      }
    }
  }

  // indent is last-mutating (the model port tracks the chunk structure as it
  // was before indentation), with aligned exclusion ranges
  if (length > 0 && rng.bool(0.6)) {
    const exclude: [number, number][] = []
    if (rng.bool(0.4) && length >= 3) {
      const start = rng.int(length - 2)
      const end = Math.min(length, start + 2 + rng.int(3))
      exclude.push([start, end])
    }
    ops.push({
      kind: 'indent',
      indentStr: rng.pick(INDENT_STRINGS),
      exclude,
      indentStart: rng.bool(0.85),
    })
  }

  // one clone checkpoint, usually before the indent
  if (rng.bool(0.8) && ops.length > 0) {
    let pos = rng.int(ops.length + 1)
    // prefer checkpoints before indent
    const lastIndent = ops.map(o => o.kind).lastIndexOf('indent')
    if (lastIndent !== -1 && pos > lastIndent)
      pos = rng.int(lastIndent + 1)
    ops.splice(pos, 0, { kind: 'cloneCheckpoint' })
  }

  return { source, ops }
}
