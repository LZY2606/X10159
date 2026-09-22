/*
 * Deterministic (fixed-seed) operation-sequence generator.
 *
 * The generator only emits operations that *might* be legal; legality against
 * the current edit state is still decided by ReferenceModel.apply, which acts
 * as the independent filter for overlaps the public contract rejects
 * ("cannot split a chunk that has already been edited", "cannot overwrite
 * across a split point", moves inside/across a moved range, ...).
 */
import type { Op } from './model.ts'

export interface Rng {
  next: () => number
  range: (maxExclusive: number) => number
  pick: <T>(items: readonly T[]) => T
  bool: (probability?: number) => boolean
}

// mulberry32: tiny, fully deterministic
export function makeRng(seed: number): Rng {
  let state = seed >>> 0
  const next = () => {
    state |= 0
    state = (state + 0x6D2B79F5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const range = (maxExclusive: number) => Math.floor(next() * maxExclusive)
  const pick = <T>(items: readonly T[]): T => items[range(items.length)]
  const bool = (probability = 0.5) => next() < probability
  return { next, range, pick, bool }
}

// Short insert alphabet: ASCII punctuation/letters plus one multiline string,
// so insert interactions with indentation/newline mapping are exercised.
const INSERT_TOKENS = ['a', 'b', 'X', '_', ' ', '1', '!', '\n', '  ', '\t', 'q\nz'] as const
const INDENT_STRINGS = ['  ', '\t', '>>', ''] as const

export interface GenerateOptions {
  length: number
  source: string
  seed: number
}

function rangeOp(rng: Rng, n: number): { start: number, end: number } {
  const a = rng.range(n + 1)
  const b = rng.range(n + 1)
  return { start: Math.min(a, b), end: Math.max(a, b) }
}

function randomBoundary(rng: Rng, n: number): number {
  return rng.range(n + 1)
}

export function generateOperations({ source, length, seed }: GenerateOptions): Op[] {
  const rng = makeRng(seed)
  const n = source.length
  const ops: Op[] = []
  // operation weights bias towards boundary/range edits; indent is rarer and
  // clone/move show up regularly to exercise order + isolation
  const kinds = [
    'appendLeft',
    'appendLeft',
    'prependRight',
    'prependRight',
    'appendRight',
    'prependLeft',
    'append',
    'prepend',
    'overwrite',
    'overwrite',
    'remove', 'reset',
    'move',
    'move',
    'indent',
    'addSourcemapLocation',
  ] as const

  for (let i = 0; i < length; i++) {
    const kind = rng.pick(kinds)
    switch (kind) {
      case 'appendLeft':
        ops.push({ type: 'appendLeft', index: randomBoundary(rng, n), text: rng.pick(INSERT_TOKENS) })
        break
      case 'prependLeft':
        ops.push({ type: 'prependLeft', index: randomBoundary(rng, n), text: rng.pick(INSERT_TOKENS) })
        break
      case 'appendRight':
        ops.push({ type: 'appendRight', index: randomBoundary(rng, n), text: rng.pick(INSERT_TOKENS) })
        break
      case 'prependRight':
        ops.push({ type: 'prependRight', index: randomBoundary(rng, n), text: rng.pick(INSERT_TOKENS) })
        break
      case 'append':
        ops.push({ type: 'append', text: rng.pick(INSERT_TOKENS) })
        break
      case 'prepend':
        ops.push({ type: 'prepend', text: rng.pick(INSERT_TOKENS) })
        break
      case 'overwrite': {
        let { start, end } = rangeOp(rng, n)
        if (start === end)
          end = Math.min(n, start + 1)
        if (start === end)
          break // empty source: overwrite is never legal, skip the draw
        const text = rng.pick(INSERT_TOKENS)
        const storeName = rng.bool(0.4)
        const contentOnly = rng.bool(0.3)
        ops.push({ type: 'overwrite', start, end, text, storeName, contentOnly })
        break
      }
      case 'remove': {
        const { start, end } = rangeOp(rng, n)
        ops.push({ type: 'remove', start, end })
        break
      }
      case 'reset': {
        const { start, end } = rangeOp(rng, n)
        ops.push({ type: 'reset', start, end })
        break
      }
      case 'move': {
        if (n < 2)
          break
        const { start, end } = rangeOp(rng, n)
        if (start === end)
          break
        const index = rng.range(n + 1)
        const affinity = rng.bool(0.3) ? 'left' : 'right'
        ops.push({ type: 'move', start, end, index, affinity })
        break
      }
      case 'indent': {
        const indentStr = rng.pick(INDENT_STRINGS)
        const op: Op = { type: 'indent', indentStr }
        if (n >= 2 && rng.bool(0.5)) {
          const a = rng.range(n)
          const b = a + 1 + rng.range(Math.min(3, n - a))
          op.exclude = [[a, b]]
        }
        if (rng.bool(0.3))
          op.indentStart = rng.bool(0.5)
        ops.push(op)
        break
      }
      case 'addSourcemapLocation':
        ops.push({ type: 'addSourcemapLocation', index: randomBoundary(rng, n) })
        break
    }
  }
  return ops
}
