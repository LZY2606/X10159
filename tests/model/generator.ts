/**
 * Fixed-seed operation generator.
 *
 * Produces random-but-deterministic legal editing sequences on short source
 * strings. Legality is established by dry-running every candidate against the
 * independent model (never the library), so sequences only contain ops the
 * public contract says are valid.
 */
import { EditingModel, type SourceOp } from './EditingModel.ts'

/** Deterministic PRNG (mulberry32) so a failing seed is reproducible. */
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

  int(n: number): number {
    return Math.floor(this.next() * n)
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]
  }
}

/**
 * Short, newline-rich sources. They stay single-line often enough that
 * single-line column invariants are heavily exercised too.
 */
const SOURCES = [
  '',
  'a',
  'ab',
  'abcde',
  'abcdefghij',
  'ab\ncd',
  'abc\ndef\nghi',
  'aa\nbb\ncc\ndd',
  'a\uD83D\uDE00b\nc',
  'x  y\n z',
] as const

const INSERT_CHARS = ['X', 'Y', '_', '1', '\n', ' '] as const
const REPLACEMENTS = ['Q', 'PQ', '\n', 'R\nS', ''] as const
const INDENT_STRINGS = ['\t', '  '] as const

export interface GeneratedCase {
  source: string
  /** Sequence including `clone` markers; see runner for lane semantics. */
  ops: TestOp[]
}

export type TestOp =
  | (SourceOp & { lane: number })
  | { type: 'clone', lane: number, from: number }

function chooseBoundary(rng: Rng, source: string): number {
  // boundaries 0..length, with edges favoured slightly
  if (rng.next() < 0.2)
    return rng.next() < 0.5 ? 0 : source.length
  return rng.int(source.length + 1)
}

function chooseRange(rng: Rng, source: string): [number, number] {
  const i = rng.int(source.length + 1)
  const j = rng.int(source.length + 1)
  return [Math.min(i, j), Math.max(i, j)]
}

function insertText(rng: Rng): string {
  const len = rng.int(3)
  let s = ''
  for (let k = 0; k < len; k++)
    s += rng.pick(INSERT_CHARS)
  return s
}

function makeSourceOp(rng: Rng, source: string): SourceOp {
  // indent is chosen separately and less often
  const kind = rng.pick([
    'appendLeft',
    'prependRight',
    'appendLeft',
    'prependRight',
    'prependLeft',
    'appendRight',
    'append',
    'prepend',
    'overwrite',
    'remove',
    'move',
    'addSourcemapLocation',
  ] as const)

  switch (kind) {
    case 'appendLeft':
      return { type: 'appendLeft', index: chooseBoundary(rng, source), text: insertText(rng) }
    case 'prependRight':
      return { type: 'prependRight', index: chooseBoundary(rng, source), text: insertText(rng) }
    case 'prependLeft':
      return { type: 'prependLeft', index: chooseBoundary(rng, source), text: insertText(rng) }
    case 'appendRight':
      return { type: 'appendRight', index: chooseBoundary(rng, source), text: insertText(rng) }
    case 'append':
      return { type: 'append', text: insertText(rng) }
    case 'prepend':
      return { type: 'prepend', text: insertText(rng) }
    case 'overwrite': {
      let [s, e] = chooseRange(rng, source)
      if (s === e)
        e = Math.min(source.length, s + 1)
      return {
        type: 'overwrite',
        start: s,
        end: e,
        text: rng.pick(REPLACEMENTS),
        storeName: rng.next() < 0.3,
      }
    }
    case 'remove': {
      const [s, e] = chooseRange(rng, source)
      return { type: 'remove', start: s, end: e }
    }
    case 'move': {
      if (source.length < 2)
        return { type: 'appendLeft', index: 0, text: insertText(rng) }
      const s = rng.int(source.length)
      const len = 1 + rng.int(Math.min(3, source.length - s))
      const e = s + len
      let index = rng.int(source.length + 1)
      // avoid "inside itself"
      if (index >= s && index <= e)
        index = index > (s + e) / 2 ? 0 : source.length
      return {
        type: 'move',
        start: s,
        end: e,
        index,
        affinity: rng.next() < 0.5 ? 'left' : 'right',
      }
    }
    case 'addSourcemapLocation':
      return { type: 'addSourcemapLocation', index: rng.int(source.length + 1) }
  }
}

function makeIndentOp(rng: Rng, source: string): SourceOp {
  const opts: { exclude?: Array<[number, number]> } = {}
  if (source.length >= 4 && rng.next() < 0.5) {
    const s = rng.int(source.length - 1)
    const e = s + 1 + rng.int(Math.min(4, source.length - s))
    opts.exclude = [[s, e]]
  }
  return { type: 'indent', indentStr: rng.pick(INDENT_STRINGS), options: opts }
}

/**
 * Generates one deterministic case of up to `maxOps` ops for the given seed.
 * Candidates rejected by the model's legality dry-run are retried a few
 * times, then the sequence terminates early.
 */
export function generateCase(seed: number, maxOps = 26): GeneratedCase {
  const rng = new Rng(seed)
  const source = rng.pick(SOURCES)
  const laneModels: EditingModel[] = [new EditingModel(source)]
  const ops: TestOp[] = []
  let laneCount = 1
  let finished = false

  for (let step = 0; step < maxOps; step++) {
    if (finished)
      break
    // occasionally fork a clone lane
    if (step > 2 && laneCount < 3 && rng.next() < 0.12) {
      const from = rng.int(laneCount)
      const lane = laneCount++
      laneModels[lane] = laneModels[from].cloneDeep()
      ops.push({ type: 'clone', lane, from })
      continue
    }

    const lane = rng.int(laneCount)
    let accepted = false
    for (let attempt = 0; attempt < 6 && !accepted; attempt++) {
      const op = rng.next() < 0.15 ? makeIndentOp(rng, source) : makeSourceOp(rng, source)
      if (tryApply(laneModels[lane], op)) {
        ops.push({ ...op, lane } as TestOp)
        accepted = true
      }
    }
    if (!accepted)
      finished = true
  }

  return { source, ops }
}

// Every lane keeps its own evolving model, so legality of a lane's ops is
// checked against exactly the state the replay's cloned MagicString is in.
function tryApply(model: EditingModel, op: SourceOp): boolean {
  try {
    model.apply(op)
    // also make sure the predicted output and all map modes render
    model.toString()
    model.renderExpectedMap(false)
    model.renderExpectedMap(true)
    model.renderExpectedMap('boundary')
    return true
  }
  catch (e) {
    if (process.env.GEN_DEBUG)
      process.stderr.write(`reject ${op.type}: ${(e as Error).message}\n`)
    return false
  }
}
