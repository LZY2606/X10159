/**
 * Shrinks a failing case to the shortest op prefix/subsequence that still
 * fails, and renders it as source code that can be pasted straight into a
 * regression test.
 */
import { runCase } from './replay.ts'
import type { GeneratedCase, TestOp } from './generator.ts'

function withOps(source: string, ops: TestOp[]): GeneratedCase {
  return { source, ops }
}

/**
 * Delta-debug style shrink:
 *  1. trim to the shortest failing prefix
 *  2. repeatedly delete any single op whose removal still fails
 * Clone ops whose lane became empty after deletions are removed too.
 */
export function shrink(testCase: GeneratedCase): GeneratedCase {
  const { source } = testCase
  let ops = testCase.ops.slice()

  // 1. shortest failing prefix
  let hi = ops.length
  let lo = 0
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (runCase(withOps(source, ops.slice(0, mid))) === null)
      lo = mid + 1
    else
      hi = mid
  }
  ops = ops.slice(0, hi)

  // 2. delete ops one at a time while the case still fails
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < ops.length; i++) {
      const candidate = ops.slice(0, i).concat(ops.slice(i + 1))
      if (runCase(withOps(source, sanitize(candidate))) !== null) {
        ops = sanitize(candidate)
        changed = true
        break
      }
    }
  }

  return withOps(source, ops)
}

/**
 * Drops ops that reference lanes which no longer have a producing clone op
 * (after deletions), keeping lane 0 and its ops.
 */
function sanitize(ops: TestOp[]): TestOp[] {
  const live = new Set<number>([0])
  const out: TestOp[] = []
  for (const op of ops) {
    if (op.type === 'clone') {
      if (!live.has(op.from))
        continue
      live.add(op.lane)
      out.push(op)
    }
    else if (live.has(op.lane)) {
      out.push(op)
    }
  }
  return out
}

const OP_TEXT: Record<string, string> = {
  appendLeft: 'appendLeft',
  appendRight: 'appendRight',
  prependLeft: 'prependLeft',
  prependRight: 'prependRight',
  append: 'append',
  prepend: 'prepend',
  overwrite: 'overwrite',
  remove: 'remove',
  move: 'move',
  indent: 'indent',
  addSourcemapLocation: 'addSourcemapLocation',
}

function renderOp(op: TestOp, varFor: (lane: number) => string): string {
  const target = varFor(op.type === 'clone' ? op.from : op.lane)
  switch (op.type) {
    case 'appendLeft': return `${target}.appendLeft(${op.index}, ${JSON.stringify(op.text)})`
    case 'appendRight': return `${target}.appendRight(${op.index}, ${JSON.stringify(op.text)})`
    case 'prependLeft': return `${target}.prependLeft(${op.index}, ${JSON.stringify(op.text)})`
    case 'prependRight': return `${target}.prependRight(${op.index}, ${JSON.stringify(op.text)})`
    case 'append': return `${target}.append(${JSON.stringify(op.text)})`
    case 'prepend': return `${target}.prepend(${JSON.stringify(op.text)})`
    case 'overwrite': return `${target}.overwrite(${op.start}, ${op.end}, ${JSON.stringify(op.text)}${op.storeName ? ', { storeName: true }' : ''})`
    case 'remove': return `${target}.remove(${op.start}, ${op.end})`
    case 'move': return `${target}.move(${op.start}, ${op.end}, ${op.index}, ${JSON.stringify(op.affinity)})`
    case 'indent': return `${target}.indent(${JSON.stringify(op.indentStr)}${op.options && op.options.exclude ? `, { exclude: ${JSON.stringify(op.options.exclude)} }` : ''})`
    case 'addSourcemapLocation': return `${target}.addSourcemapLocation(${op.index})`
    case 'clone': {
      const name = varFor(op.lane)
      return `const ${name} = ${varFor(op.from)}.clone()`
    }
  }
}

/** Renders a case as copy-pasteable source using `s0`, `s1`, ... variables. */
export function renderRegression(testCase: GeneratedCase): string {
  const names = new Map<number, string>()
  names.set(0, 's')
  let nextClone = 1
  const varFor = (lane: number): string => {
    if (lane === 0)
      return 's'
    let name = names.get(lane)
    if (!name) {
      name = `c${nextClone++}`
      names.set(lane, name)
    }
    return name
  }

  const lines = [
    `const s = new MagicString(${JSON.stringify(testCase.source)}, { filename: 'input.js' })`,
  ]
  for (const op of testCase.ops)
    lines.push(renderOp(op, varFor))
  return lines.join('\n')
}

/** Full failure report: seed, shrunk case and rendered regression source. */
export function formatFailure(seed: number, testCase: GeneratedCase, mismatchMessage: string): string {
  const shrunk = shrink(testCase)
  return [
    `seed ${seed} failed:`,
    mismatchMessage,
    '',
    '--- minimal regression (paste into a test) ---',
    renderRegression(shrunk),
  ].join('\n')
}

void OP_TEXT
