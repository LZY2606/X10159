// Deterministic, fixed-seed generator of legal MagicString edit sequences.
//
// Every generated operation is checked against the independent EditModel
// first: only operations the documented contract accepts are emitted, so a
// test replay never has to guess which call was "supposed" to throw.

import { EditModel, type Op } from './editModel.ts'

// mulberry32 — small, seedable PRNG so a failing run is fully reproducible
export function createRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Short multiline sources. One contains an astral character so code-unit
// indices walk across a surrogate pair; the rest stay ASCII for readability.
export const SOURCE_POOL = [
  'abcdefgh',
  'ab\ncd\nef',
  'x = 1\ny = 2\n',
  'a\nbb\nccc',
  'foo bar;\n baz',
  'a\uD83D\uDE00b\ncd',
]

const INSERT_CHARS = ['X', 'Y', 'Z', '1', '_', ' ', '\n', '>>']
const REPLACE_CHARS = ['R', 'Q', 'T', '-\n', ' ']
const INDENT_PREFIXES = ['\t', '  ', '>>']

const pick = <T,>(rng: () => number, items: T[]): T =>
  items[Math.floor(rng() * items.length)]

const int = (rng: () => number, maxExclusive: number): number =>
  Math.floor(rng() * maxExclusive)

// Sometimes the same boundary is targeted repeatedly, which exercises the
// intro/outro slot ordering (appendLeft vs prependRight stacks).
function chooseIndex(rng: () => number, length: number, hotspots: number[]): number {
  if (hotspots.length && rng() < 0.35)
    return pick(rng, hotspots)
  return int(rng, length + 1)
}

export interface GeneratedCase {
  seed: number
  source: string
  ops: Op[]
}

export function generateCase(seed: number): GeneratedCase {
  const rng = createRng(seed)
  const source = SOURCE_POOL[seed % SOURCE_POOL.length]
  const model = new EditModel(source)
  const length = source.length
  const ops: Op[] = []
  const hotspots: number[] = []
  const count = 8 + int(rng, 12)

  for (let i = 0; i < count; i += 1) {
    const roll = rng()
    let op: Op | null = null

    if (roll < 0.32) {
      const index = chooseIndex(rng, length, hotspots)
      hotspots.length < 3 && rng() < 0.5 && hotspots.push(index)
      const kind = pick(rng, ['appendLeft', 'prependLeft', 'appendRight', 'prependRight'])
      op = { kind, index, content: pick(rng, INSERT_CHARS) }
    }
    else if (roll < 0.5) {
      const start = int(rng, length)
      const end = start + 1 + int(rng, Math.min(4, length - start))
      const op0: Op = {
        kind: 'overwrite',
        start,
        end,
        content: pick(rng, REPLACE_CHARS),
      }
      if (rng() < 0.3)
        op0.storeName = true
      if (rng() < 0.2)
        op0.contentOnly = true
      op = op0
    }
    else if (roll < 0.62) {
      const start = int(rng, length)
      const end = start + 1 + int(rng, Math.min(4, length - start))
      op = { kind: 'remove', start, end }
    }
    else if (roll < 0.78) {
      const start = int(rng, length)
      const end = start + 1 + int(rng, Math.min(4, length - start))
      let to = int(rng, length + 1)
      if (to >= start && to <= end)
        to = to > (start + end) / 2 ? Math.min(length, end + 1) : Math.max(0, start - 1)
      op = {
        kind: 'move',
        start,
        end,
        to,
        affinity: rng() < 0.5 ? 'left' : 'right',
      }
    }
    else if (roll < 0.88) {
      op = {
        kind: 'indent',
        prefix: pick(rng, INDENT_PREFIXES),
        indentStart: rng() < 0.8,
      }
    }
    else {
      op = { kind: 'addSourcemapLocation', index: int(rng, length + 1) }
    }

    if (op && model.apply(op))
      ops.push(op)
  }

  return { seed, source, ops }
}

// Human/regression-test friendly rendering of a case: source + a copy-pasteable
// sequence that constructs a MagicString and replays every operation.
export function renderCase(source: string, ops: Op[]): string {
  const lines: string[] = []
  lines.push(`const s = new MagicString(${JSON.stringify(source)})`)
  for (const op of ops)
    lines.push(`s.${renderOp(op)}`)
  return lines.join('\n')
}

function renderOp(op: Op): string {
  switch (op.kind) {
    case 'appendLeft':
    case 'prependLeft':
    case 'appendRight':
    case 'prependRight':
      return `${op.kind}(${op.index}, ${JSON.stringify(op.content)})`
    case 'addSourcemapLocation':
      return `addSourcemapLocation(${op.index})`
    case 'remove':
      return `remove(${op.start}, ${op.end})`
    case 'move':
      return `move(${op.start}, ${op.end}, ${op.to}${op.affinity === 'left' ? ", 'left'" : ''})`
    case 'indent':
      return `indent(${JSON.stringify(op.prefix)}${op.indentStart === false ? ', { indentStart: false }' : ''})`
    case 'overwrite': {
      const options: string[] = []
      if (op.storeName)
        options.push('storeName: true')
      if (op.contentOnly)
        options.push('contentOnly: true')
      return `overwrite(${op.start}, ${op.end}, ${JSON.stringify(op.content)}${options.length ? `, { ${options.join(', ')} }` : ''})`
    }
  }
}
