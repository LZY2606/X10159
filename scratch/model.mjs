import assert from 'node:assert'
import { MagicString } from '../dist/index.mjs'

const NEWLINE_CHAR = 10
const CR_CHAR = 13
const isWordCode = code => (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code === 95

// ---------------- deterministic RNG ----------------
export function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------- independent reference model ----------------
// Tiling of the original: blocks partition [0, n) in original coordinates and
// carry the boundary insertion buckets. `order` is the current output order.
export function createModel(original) {
  const model = {
    original,
    intro: '',
    outro: '',
    boundaries: new Set([0]),
    buckets: new Map(),
    blocks: [],
    order: [],
    locations: new Set(),
  }
  if (original.length > 0) model.boundaries.add(original.length)
  const block = makeBlock(0, original.length, false, original)
  model.blocks.push(block)
  model.order.push(block)
  return model
}

function makeBlock(start, end, edited, content) {
  return { start, end, edited, content }
}

export function cloneModel(m) {
  const copy = {
    original: m.original,
    intro: m.intro,
    outro: m.outro,
    boundaries: new Set(m.boundaries),
    buckets: new Map([...m.buckets].map(([k, v]) => [k, { ...v }])),
    blocks: [],
    order: [],
    locations: new Set(m.locations),
  }
  for (const b of m.blocks) copy.blocks.push({ ...b })
  const byKey = new Map(copy.blocks.map(b => [blockKey(b), b]))
  copy.order = m.order.map(b => byKey.get(blockKey(b)))
  return copy
}
const blockKey = b => `${b.start}:${b.end}`

function getBucket(m, index, create) {
  let b = m.buckets.get(index)
  if (!b) {
    if (!create) return { R: '', L: '' }
    b = { R: '', L: '' }
    m.buckets.set(index, b)
  }
  return b
}

function inBounds(m, i) { return i >= 0 && i <= m.original.length }
function blockContaining(m, i) { return m.blocks.find(b => b.start < i && i < b.end) }
function splittable(m, i) {
  if (m.boundaries.has(i)) return true
  const b = blockContaining(m, i)
  return Boolean(b) && (!b.edited || b.content === '')
}
function splitAt(m, i) {
  if (m.boundaries.has(i)) return
  const tileIdx = m.blocks.findIndex(b => b.start < i && i < b.end)
  const old = m.blocks[tileIdx]
  const next = makeBlock(i, old.end, old.edited, old.edited ? '' : m.original.slice(i, old.end))
  old.end = i
  if (old.edited) old.content = ''
  m.blocks.splice(tileIdx + 1, 0, next)
  m.order.splice(m.order.indexOf(old) + 1, 0, next)
  m.boundaries.add(i)
}
function tileRun(m, start, end) {
  const run = []
  for (const b of m.blocks) if (b.start >= start && b.end <= end) run.push(b)
  return run
}
function isForwardRun(m, run) {
  let idx = m.order.indexOf(run[0])
  for (let i = 0; i < run.length; i++) if (m.order[idx + i] !== run[i]) return false
  return true
}
function hasEndChunk(m, i) { return m.blocks.some(b => b.end === i) }
function hasStartChunk(m, i) { return m.blocks.some(b => b.start === i) }

// legality of a candidate op under the documented public contract
export function legal(m, op) {
  switch (op.type) {
    case 'append':
    case 'prepend':
    case 'indent':
    case 'clone':
      return true
    case 'appendLeft':
    case 'prependLeft':
    case 'appendRight':
    case 'prependRight':
    case 'addSourcemapLocation':
      return inBounds(m, op.index)
    case 'overwrite':
    case 'remove':
      return inBounds(m, op.start) && inBounds(m, op.end) && op.start < op.end
        && splittable(m, op.start) && splittable(m, op.end)
    case 'move':
      return inBounds(m, op.start) && inBounds(m, op.end) && inBounds(m, op.index)
        && op.start < op.end && !(op.index >= op.start && op.index <= op.end)
        && splittable(m, op.start) && splittable(m, op.end) && splittable(m, op.index)
    default:
      return false
  }
}

export function apply(m, op) {
  switch (op.type) {
    case 'append': m.outro += op.content; return
    case 'prepend': m.intro = op.content + m.intro; return
    case 'appendLeft': { splitAt(m, op.index); const b = getBucket(m, op.index, true); if (hasEndChunk(m, op.index)) b.L += op.content; else m.intro += op.content; return }
    case 'prependLeft': { splitAt(m, op.index); const b = getBucket(m, op.index, true); if (hasEndChunk(m, op.index)) b.L = op.content + b.L; else m.intro = op.content + m.intro; return }
    case 'appendRight': { splitAt(m, op.index); const b = getBucket(m, op.index, true); if (hasStartChunk(m, op.index)) b.R += op.content; else m.outro += op.content; return }
    case 'prependRight': { splitAt(m, op.index); const b = getBucket(m, op.index, true); if (hasStartChunk(m, op.index)) b.R = op.content + b.R; else m.outro = op.content + m.outro; return }
    case 'addSourcemapLocation': m.locations.add(op.index); return
    case 'overwrite':
    case 'remove': {
      splitAt(m, op.start)
      splitAt(m, op.end)
      const run = tileRun(m, op.start, op.end)
      if (op.type === 'overwrite' && !isForwardRun(m, run)) throw new Error('cannot overwrite across a split point')
      if (op.type === 'remove') {
        for (const b of run) b.content = ''
        for (const [i, bk] of m.buckets) if (i > op.start && i < op.end) { bk.R = ''; bk.L = '' }
      }
      else {
        const [first, ...rest] = run
        first.content = op.content
        first.edited = true
        for (const b of rest) { b.content = ''; b.edited = true }
        getBucket(m, op.start, true).R = ''
        getBucket(m, op.end, true).L = ''
        for (const [i, bk] of m.buckets) if (i > op.start && i < op.end) { bk.R = ''; bk.L = '' }
      }
      return
    }
    case 'move': applyMove(m, op); return
  }
}

function applyMove(m, op) {
  splitAt(m, op.start)
  splitAt(m, op.end)
  splitAt(m, op.index)
  const run = tileRun(m, op.start, op.end)
  if (!isForwardRun(m, run)) throw new Error('cannot move because an earlier move split that range')

  const first = run[0]
  const last = run[run.length - 1]

  let newLeft = null
  let newRight = null
  if (op.affinity === 'left') {
    newLeft = m.blocks.find(b => b.end === op.index) ?? null
    if (!newLeft) {
      if (first === m.order[0]) return
      newRight = m.order[0]
    }
    else {
      if (orderNext(m, newLeft) === first) return
      newRight = orderNext(m, newLeft)
    }
  }
  else {
    newRight = m.blocks.find(b => b.start === op.index) ?? null
    if (!newRight) {
      if (last === m.order[m.order.length - 1]) return
      newLeft = m.order[m.order.length - 1]
    }
    else {
      if (orderPrev(m, newRight) === last) return
      newLeft = orderPrev(m, newRight)
    }
  }

  const runSet = new Set(run)
  const nextOrder = []
  for (const b of m.order) {
    if (runSet.has(b)) {
      if (b === first) {
        if (newLeft == null || (!runSet.has(newLeft) && b === first)) {
          // inserted lazily at the anchor below
        }
      }
    }
  }
  // Build by splicing run out, then inserting before newRight / after newLeft
  const remaining = m.order.filter(b => !runSet.has(b))
  if (newRight == null) {
    m.order = [...remaining, ...run]
  }
  else {
    const pos = remaining.indexOf(newRight)
    m.order = [...remaining.slice(0, pos), ...run, ...remaining.slice(pos)]
  }
}
function orderNext(m, b) { return m.order[m.order.indexOf(b) + 1] ?? null }
function orderPrev(m, b) { return m.order[m.order.indexOf(b) - 1] ?? null }

// ---------------- rendering ----------------
export function render(m) {
  let out = m.intro
  for (const b of m.order) {
    out += getBucket(m, b.start).R
    out += b.content
    out += getBucket(m, b.end).L
  }
  return out + m.outro
}

// ---------------- indent ----------------
// Public semantics: insert prefix at the start of the output and before the
// first non-CR/LF character following each LF, mirroring MagicString#indent
// with no exclusion ranges. Insertions are booked onto boundary buckets (a
// split is introduced where needed) so subsequent edits see identical effects.
export function indent(m, prefix = '\t') {
  if (prefix === '') return m
  let shouldIndent = true

  const indentPiece = (str) => {
    if (str === '') return str
    let result = ''
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i)
      if (code !== NEWLINE_CHAR && code !== CR_CHAR && (i > 0 || shouldIndent)) {
        result += prefix
      }
      result += str[i]
      shouldIndent = code === NEWLINE_CHAR
    }
    shouldIndent = str[str.length - 1] === '\n'
    return result
  }

  m.intro = indentPiece(m.intro)

  for (const block of m.order) {
    const rb = m.buckets.get(block.start)
    if (rb && rb.R) rb.R = indentPiece(rb.R)

    if (block.edited) {
      if (block.content) block.content = indentPiece(block.content)
    }
    else {
      let i = block.start
      const end = block.end
      while (i < end) {
        if (!shouldIndent) {
          const nextLine = m.original.indexOf('\n', i)
          if (nextLine === -1 || nextLine >= end) break
          shouldIndent = true
          i = nextLine + 1
          continue
        }
        const code = m.original.charCodeAt(i)
        if (code === NEWLINE_CHAR || code === CR_CHAR) { i += 1; continue }
        if (i === block.start) {
          const b = getBucket(m, block.start, true)
          b.R += prefix
        }
        else {
          splitAt(m, i)
          const b = getBucket(m, i, true)
          b.R = prefix + b.R
        }
        shouldIndent = false
        i += 1
      }
    }

    const lb = m.buckets.get(block.end)
    if (lb && lb.L) lb.L = indentPiece(lb.L)
  }

  m.outro = indentPiece(m.outro)
  return m
}
