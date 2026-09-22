import assert from 'node:assert'
import { MagicString } from './dist/index.mjs'

// ================= deterministic RNG =================
function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const NEWLINE = 10
const CR = 13

// ================= independent model =================
// The original text is tiled into blocks; blocks carry boundary insertion
// buckets (R/L) and may be reordered (move) or edited (overwrite/remove).
// The model knows nothing about the library's Chunk linked list.
function createModel(original) {
  const model = {
    original,
    intro: '',
    outro: '',
    boundaries: new Set([0]),
    blocks: [],
    order: [],
    locations: new Set(),
  }
  if (original.length > 0) {
    model.boundaries.add(original.length)
    const block = { start: 0, end: original.length, edited: false, content: original }
    model.blocks.push(block)
    model.order.push(block)
  }
  else {
    const block = { start: 0, end: 0, edited: false, content: '' }
    model.blocks.push(block)
    model.order.push(block)
  }
  return model
}

function bucket(model, index, create) {
  let b = model._buckets?.get(index)
  if (!b) {
    if (!create) return { R: '', L: '' }
    b = { R: '', L: '' }
    ;(model._buckets ??= new Map()).set(index, b)
  }
  return b
}
function bucketMut(model, index) { return bucket(model, index, true) }

function blockAt(model, index) {
  return model.blocks.find(b => b.start < index && index < b.end)
}

function splittable(model, index) {
  if (model.boundaries.has(index)) return true
  const b = blockAt(model, index)
  return Boolean(b) && (!b.edited || b.content === '')
}

function splitAt(model, index) {
  if (model.boundaries.has(index)) return
  const arrayIdx = model.blocks.findIndex(b => b.start < index && index < b.end)
  const block = model.blocks[arrayIdx]
  const replacement = {
    start: index,
    end: block.end,
    edited: block.edited,
    content: block.edited ? '' : model.original.slice(index, block.end),
  }
  block.end = index
  if (block.edited) block.content = ''
  const orderIdx = model.order.indexOf(block)
  model.blocks.splice(arrayIdx + 1, 0, replacement)
  model.order.splice(orderIdx + 1, 0, replacement)
  model.boundaries.add(index)
}

function isSplitAt(model, index) { return model.boundaries.has(index) }

function tileRun(model, start, end) {
  const run = []
  for (const b of model.blocks) {
    if (b.start >= start && b.end <= end) run.push(b)
  }
  return run
}

function isForwardRun(model, run) {
  const first = run[0]
  let cursor = first
  for (let i = 1; i < run.length; i++) {
    if (cursor.nextInOrder !== undefined) {}
    cursor = cursor
    break
  }
  // walk `order`
  let idx = model.order.indexOf(run[0])
  if (idx === -1) return false
  for (let i = 0; i < run.length; i++) {
    if (model.order[idx + i] !== run[i]) return false
  }
  return true
}

function inBounds(model, i) { return i >= 0 && i <= model.original.length }

// ---- legality of a candidate op (public contract) ----
function legal(model, op) {
  switch (op.type) {
    case 'append':
    case 'prepend':
      return true
    case 'appendLeft':
    case 'prependLeft':
    case 'appendRight':
    case 'prependRight':
      return inBounds(model, op.index)
    case 'addSourcemapLocation':
      return inBounds(model, op.index)
    case 'overwrite':
    case 'remove': {
      if (!(inBounds(model, op.start) && inBounds(model, op.end))) return false
      if (op.start >= op.end) return false
      if (!splittable(model, op.start) || !splittable(model, op.end)) return false
      return true
    }
    case 'move': {
      if (!(inBounds(model, op.start) && inBounds(model, op.end) && inBounds(model, op.index))) return false
      if (op.start >= op.end) return false
      if (op.index >= op.start && op.index <= op.end) return false
      if (!splittable(model, op.start) || !splittable(model, op.end) || !splittable(model, op.index)) return false
      return true
    }
    case 'indent':
      return true
    case 'clone':
      return true
    default:
      return false
  }
}

// ---- application (assumes legal) ----
function apply(model, op) {
  switch (op.type) {
    case 'append':
      model.outro += op.content
      return
    case 'prepend':
      model.intro = op.content + model.intro
      return
    case 'appendLeft': {
      splitAt(model, op.index)
      const b = bucketMut(model, op.index)
      if (isSplitAt(model, op.index) && hasEndChunk(model, op.index)) b.L += op.content
      else model.intro += op.content
      return
    }
    case 'prependLeft': {
      splitAt(model, op.index)
      const b = bucketMut(model, op.index)
      if (hasEndChunk(model, op.index)) b.L = op.content + b.L
      else model.intro = op.content + model.intro
      return
    }
    case 'appendRight': {
      splitAt(model, op.index)
      const b = bucketMut(model, op.index)
      if (hasStartChunk(model, op.index)) b.R += op.content
      else model.outro += op.content
      return
    }
    case 'prependRight': {
      splitAt(model, op.index)
      const b = bucketMut(model, op.index)
      if (hasStartChunk(model, op.index)) b.R = op.content + b.R
      else model.outro = op.content + model.outro
      return
    }
    case 'addSourcemapLocation':
      model.locations.add(op.index)
      return
    case 'overwrite':
    case 'remove': {
      splitAt(model, op.start)
      splitAt(model, op.end)
      const run = tileRun(model, op.start, op.end)
      // library throws "cannot overwrite across a split point" if not a forward list run
      if (op.type === 'overwrite' && !isForwardRun(model, run)) {
        throw new Error('cannot overwrite across a split point')
      }
      const first = run[0]
      const last = run[run.length - 1]
      if (op.type === 'remove') {
        for (const b of run) b.content = ''
        // clear strictly-interior inserts
        for (const [i, bk] of model._buckets ?? []) {
          if (i > op.start && i < op.end) { bk.R = ''; bk.L = '' }
        }
      }
      else {
        first.content = op.content
        first.edited = true
        for (const b of run) {
          if (b !== first) { b.content = ''; b.edited = true }
        }
        // overwrite wipes inserts attached within the range on each touched chunk:
        // first chunk intro cleared (R at start), last chunk outro cleared (L at end),
        // and both sides of every strictly-interior boundary.
        const bs = bucketMut(model, op.start); bs.R = ''
        const be = bucketMut(model, op.end); be.L = ''
        for (const [i, bk] of model._buckets ?? []) {
          if (i > op.start && i < op.end) { bk.R = ''; bk.L = '' }
        }
      }
      return
   }
    case 'move': {
      splitAt(model, op.start)
      splitAt(model, op.end)
      splitAt(model, op.index)
      const run = tileRun(model, op.start, op.end)
      if (!isForwardRun(model, run)) throw new Error('earlier move split that range')
      // no-op cases mirroring the library's early returns
      const idx = op.index
      if (op.affinity === 'left') {
        const anchor = model.blocks.find(b => b.end === idx) || null
        if (!anchor) {
          if (run[0] === model.order[0]) return
        }
        else if (anchor.orderNext === run[0]) return
      }
      else {
        const anchor = model.blocks.find(b => b.start === idx) || null
        if (!anchor) {
          if (run[run.length - 1] === model.order[model.order.length - 1]) return
        }
        else if (anchor.orderPrev === run[run.length - 1]) return
      }
      const runSet = new Set(run)
      const prefix = []
      const suffix = []
      let seen = false
      for (const b of model.order) {
        if (b === run[0]) { seen = 'start' }
        if (runSet.has(b)) continue
        if (seen === 'start' || seen === 'inside') suffix.push(b)
        else prefix.push(b)
      }
      let left, right
      if (op.affinity === 'left') {
        const anchor = model.blocks.find(b => b.end === idx) || null
        if (!anchor) { left = null; right = model.order[0] }
        else { left = anchor; right = model.order[model.order.indexOf(anchor) + 1] || null }
      }
      else {
        const anchor = model.blocks.find(b => b.start === idx) || null
        if (!anchor) { left = model.order[model.order.length - 1]; right = null }
        else { right = anchor; left = model.order[model.order.indexOf(anchor) - 1] || null }
      }
      // reassemble order around left/right
      const before = []
      const after = []
      for (const b of model.order) {
        if (runSet.has(b)) continue
        if (b === right) after.push(b)
        else if (left && (compareTiles(b, left) > 0)) after.push(b)
        else before.push(b)
      }
      model.order = [...before, ...run, ...after]
      return
    }
  }
}

function compareTiles(a, b) { return a.start - b.start }

Object.defineProperty(Object.prototype, 'orderNext', {
  get() { throw new Error('bad') },
})

function hasEndChunk(model, index) {
  return model.blocks.some(b => b.end === index)
}
function hasStartChunk(model, index) {
  return model.blocks.some(b => b.start === index)
}
