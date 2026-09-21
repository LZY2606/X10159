// Fixed-seed deterministic generator of legal MagicString edit sequences.
// Every generated operation is first checked against the independent reference
// model's public-contract predicates, so the real API is never called with a
// sequence it documents as illegal.

import { ReferenceModel } from './referenceModel.ts'

export interface IndentOptions { exclude?: Array<[number, number]>, indentStart?: boolean }

export type Operation
  = | { type: 'appendLeft', index: number, content: string }
    | { type: 'prependLeft', index: number, content: string }
    | { type: 'appendRight', index: number, content: string }
    | { type: 'prependRight', index: number, content: string }
    | { type: 'overwrite', start: number, end: number, content: string, storeName: boolean, contentOnly: boolean }
    | { type: 'remove', start: number, end: number }
    | { type: 'move', start: number, end: number, index: number, affinity: 'left' | 'right' }
    | { type: 'indent', indentStr: string, options: IndentOptions }
    | { type: 'addSourcemapLocation', index: number }
    | { type: 'cloneCheck' }

export const SOURCES = [
  'abcdef',
  'ab\ncd\nef',
  'ab😀cd',
  'a1 b_2-c',
  'abcdefghij',
  'x\ny\nz',
  '',
] as const

const INSERT_TOKENS = ['Q', 'Z', 'W', '|', '_', '7', '\t']

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

  int(minInclusive: number, maxExclusive: number): number {
    if (maxExclusive <= minInclusive)
      return minInclusive
    return minInclusive + Math.floor(this.next() * (maxExclusive - minInclusive))
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length)]
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability
  }
}

const weighted: Array<{ type: Operation['type'], weight: number }> = [
  { type: 'appendLeft', weight: 4 },
  { type: 'prependLeft', weight: 3 },
  { type: 'appendRight', weight: 4 },
  { type: 'prependRight', weight: 3 },
  { type: 'overwrite', weight: 4 },
  { type: 'remove', weight: 3 },
  { type: 'move', weight: 4 },
  { type: 'indent', weight: 2 },
  { type: 'addSourcemapLocation', weight: 2 },
  { type: 'cloneCheck', weight: 1 },
]

function chooseType(random: Random): Operation['type'] {
  const total = weighted.reduce((sum, item) => sum + item.weight, 0)
  let roll = random.int(0, total)
  for (const item of weighted) {
    roll -= item.weight
    if (roll < 0)
      return item.type
  }
  return weighted[0].type
}

function randomInterval(random: Random, n: number): [number, number] {
  const a = random.int(0, n + 1)
  const b = random.int(0, n + 1)
  return a < b ? [a, b] : [b, a]
}

/**
 * Produces one legal operation, retrying against the model predicates. Returns
 * null only for a structurally impossible draw (indent needs a multiline
 * source), in which case the caller redraws.
 */
export function generateOperation(
  random: Random,
  model: ReferenceModel,
): Operation | null {
  const n = model.original.length
  const type = chooseType(random)

  switch (type) {
    case 'appendLeft':
    case 'prependLeft':
    case 'appendRight':
    case 'prependRight': {
      for (let attempt = 0; attempt < 20; attempt++) {
        const index = random.int(0, n + 1)
        if (model.canInsert(index))
          return { type, index, content: random.pick(INSERT_TOKENS) }
      }
      return null
    }

    case 'overwrite': {
      for (let attempt = 0; attempt < 30; attempt++) {
        const [start, end] = randomInterval(random, n)
        if (start === end || !model.overwriteLegal(start, end))
          continue
        const content = random.pick(['X', 'YZ', 'KLM', '', 'P\nQ'])
        return {
          type,
          start,
          end,
          content,
          storeName: random.bool(0.3),
          contentOnly: random.bool(0.25),
        }
      }
      return null
    }

    case 'remove': {
      for (let attempt = 0; attempt < 30; attempt++) {
        const [start, end] = randomInterval(random, n)
        if (start === end)
          return { type, start, end } // legal no-op
        if (model.removeLegal(start, end))
          return { type, start, end }
      }
      return null
    }

    case 'move': {
      for (let attempt = 0; attempt < 40; attempt++) {
        const [start, end] = randomInterval(random, n)
        if (start === end)
          continue
        const index = random.int(0, n + 1)
        if (model.moveLegal(start, end, index)) {
          return {
            type,
            start,
            end,
            index,
            affinity: random.bool(0.5) ? 'left' : 'right',
          }
        }
      }
      return null
    }

    case 'indent': {
      if (!model.original.includes('\n'))
        return null
      const indentStr = random.pick(['\t', '  ', '>>'])
      const options: IndentOptions = {}
      if (random.bool(0.4) && n > 1) {
        const a = random.int(0, n)
        const b = random.int(a + 1, n + 1)
        options.exclude = [[a, b]]
      }
      if (random.bool(0.2))
        options.indentStart = false
      return { type, indentStr, options }
    }

    case 'addSourcemapLocation': {
      return { type, index: random.int(0, n + 1) }
    }

    case 'cloneCheck': {
      return { type }
    }
  }
}

export function generateSequence(seed: number, length: number, source?: string): { source: string, operations: Operation[] } {
  const random = new Random(seed)
  const chosenSource = source ?? random.pick(SOURCES)
  const operations: Operation[] = []

  // a shadow model is maintained only for legality filtering
  const model = new ReferenceModel(chosenSource)

  while (operations.length < length) {
    const operation = generateOperation(random, model)
    if (!operation)
      continue
    operations.push(operation)
    applyToModel(model, operation)
  }

  return { source: chosenSource, operations }
}

/** Applies an operation to the reference model. */
export function applyToModel(model: ReferenceModel, operation: Operation): void {
  switch (operation.type) {
    case 'appendLeft':
      model.appendLeft(operation.index, operation.content)
      break
    case 'prependLeft':
      model.prependLeft(operation.index, operation.content)
      break
    case 'appendRight':
      model.appendRight(operation.index, operation.content)
      break
    case 'prependRight':
      model.prependRight(operation.index, operation.content)
      break
    case 'overwrite':
      model.overwrite(operation.start, operation.end, operation.content, {
        storeName: operation.storeName,
        contentOnly: operation.contentOnly,
      })
      break
    case 'remove':
      model.remove(operation.start, operation.end)
      break
    case 'move':
      model.move(operation.start, operation.end, operation.index, operation.affinity)
      break
    case 'indent':
      model.indent(operation.indentStr, operation.options)
      break
    case 'addSourcemapLocation':
      model.addSourcemapLocation(operation.index)
      break
    case 'cloneCheck':
      break
  }
}
