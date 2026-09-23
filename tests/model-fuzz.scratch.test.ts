// SCRATCH: empirical model validation (deleted before finalizing)
import { assert, it } from 'vitest'
import { IntegrityCheckingMagicString as MS } from './__utils/IntegrityCheckingMagicString.ts'

type ItemState = 'alive' | 'removed' | 'interior'
interface ChunkInfo { start: number, end: number, items: number[] }
interface HardRange { start: number, end: number }

function isWordCode(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code === 95
}

class Model {
  original: string
  intro = ''
  outro = ''
  intros: string[]
  outros: string[]
  state: ItemState[]
  content: string[]
  order: number[]
  splits: Set<number>
  hard: HardRange[] = []
  nonEmptyChunks = new Set<number>() // start item id of each non-empty edited chunk
  locations = new Set<number>()
  names: string[] = []

  constructor(original: string) {
    this.original = original
    const n = original.length
    this.intros = new Array(n).fill('')
    this.outros = new Array(n).fill('')
    this.state = new Array(n).fill('alive') as ItemState[]
    this.content = new Array(n).fill('')
    this.order = Array.from({ length: n }, (_, i) => i)
    this.splits = new Set([0, n])
  }

  clone(): Model {
    const m = new Model(this.original)
    m.intro = this.intro
    m.outro = this.outro
    m.intros = this.intros.slice()
    m.outros = this.outros.slice()
    m.state = this.state.slice()
    m.content = this.content.slice()
    m.order = this.order.slice()
    m.splits = new Set(this.splits)
    m.hard = this.hard.map(h => ({ ...h }))
    m.nonEmptyChunks = new Set(this.nonEmptyChunks)
    m.locations = new Set(this.locations)
    m.names = this.names.slice()
    return m
  }

  items(): ChunkInfo[] {
    const chunks: ChunkInfo[] = []
    let cur: ChunkInfo | null = null
    let prev: number | null = null
    for (const id of this.order) {
      if (cur && prev !== null && id === prev + 1 && !this.splits.has(id)) {
        cur.end = id + 1
        cur.items.push(id)
      }
      else {
        cur = { start: id, end: id + 1, items: [id] }
        chunks.push(cur)
      }
      prev = id
    }
    return chunks
  }

  canSplit(index: number): boolean {
    if (this.splits.has(index)) return true
    // splitting inside a chunk whose first item still emits edit content is illegal
    for (const ch of this.items()) {
      if (ch.start < index && index < ch.end && this.nonEmptyChunks.has(ch.start)) return false
    }
    return true
  }

  split(index: number) { this.splits.add(index) }

  appendLeft(i: number, c: string) {
    if (this.original.length === 0) { this.intro += c; return }
    if (i >= this.original.length) { this.outro += c; return }
    if (i === 0) { this.outros[0] += c; return }
    this.outros[i - 1] += c
  }
  prependLeft(i: number, c: string) {
    if (this.original.length === 0) { this.intro = c + this.intro; return }
    if (i >= this.original.length) { this.outro = c + this.outro; return }
    if (i === 0) { this.outros[0] = c + this.outros[0]; return }
    this.outros[i - 1] = c + this.outros[i - 1]
  }
  appendRight(i: number, c: string) {
    if (this.original.length === 0) { this.intro += c; return }
    if (i >= this.original.length) { this.outro += c; return }
    this.intros[i] += c
  }
  prependRight(i: number, c: string) {
    if (this.original.length === 0) { this.intro = c + this.intro; return }
    if (i >= this.original.length) { this.outro = c + this.outro; return }
    this.intros[i] = c + this.intros[i]
  }
  append(c: string) { this.outro += c }
  prepend(c: string) { this.intro = c + this.intro }

  remove(start: number, end: number) {
    if (start === end) return
    this.split(start); this.split(end)
    this.recomputeNonEmpty()
    for (let i = start; i < end; i++) {
      this.state[i] = 'removed'
      this.content[i] = ''
    }
    for (const ch of this.items()) {
      if (ch.end <= start || ch.start >= end) continue
      if (ch.start > start) this.intros[ch.items[0]] = ''
      if (ch.end < end) this.outros[ch.items[ch.items.length - 1]] = ''
    }
    this.recomputeNonEmpty()
  }

  overwrite(start: number, end: number, c: string, opts: { storeName?: boolean, contentOnly?: boolean } = {}) {
    this.split(start); this.split(end)
    this.recomputeNonEmpty()
    for (let i = start; i < end; i++) {
      if (i === start) { this.state[i] = 'alive'; this.content[i] = c }
      else { this.state[i] = 'interior'; this.content[i] = '' }
    }
    this.hard = this.hard.filter(h => !(start <= h.start && h.start < end))
    if (c.length > 0) this.hard.push({ start, end })
    if (opts.storeName && c.length > 0) {
      const name = this.original.slice(start, end)
      if (!this.names.includes(name)) this.names.push(name)
    }
    if (!opts.contentOnly) {
      for (const ch of this.items()) {
        if (ch.end <= start || ch.start >= end) continue
        this.intros[ch.items[0]] = ''
        this.outros[ch.items[ch.items.length - 1]] = ''
      }
    }
    this.recomputeNonEmpty()
  }

  isForwardRun(start: number, end: number): boolean {
    const firstId = this.order.find(id => start <= id && id < end)
    if (firstId === undefined) return false
    let idx = this.order.indexOf(firstId)
    let expected = start
    while (idx < this.order.length && start <= this.order[idx] && this.order[idx] < end) {
      if (this.order[idx] !== expected) return false
      expected++; idx++
    }
    return expected === end
  }

  move(start: number, end: number, index: number, affinity: 'left' | 'right' = 'right') {
    if (start === end) return
    this.split(start); this.split(end); this.split(index)
    this.recomputeNonEmpty()
    const chunks = this.items()
    const firstId = start
    const lastId = end - 1
    const block: number[] = []
    const rest: number[] = []
    for (const id of this.order) (start <= id && id < end ? block : rest).push(id)
    let insertPos: number
    let isNoop = false
    if (affinity === 'right') {
      const anchor = chunks.find(c => c.start === index)
      if (!anchor) {
        // falls to end; no-op if block is already at the end
        if (this.order[this.order.length - 1] === lastId) isNoop = true
        insertPos = rest.length
      }
      else {
        const anchorFirst = anchor.items[0]
        if (this.order.indexOf(anchorFirst) === this.order.indexOf(lastId) + 1) isNoop = true
        insertPos = rest.indexOf(anchorFirst)
      }
    }
    else {
      const anchor = chunks.find(c => c.end === index)
      if (!anchor) {
        // falls to start; no-op if block already at the start
        if (this.order[0] === firstId) isNoop = true
        insertPos = 0
      }
      else {
        const anchorLast = anchor.items[anchor.items.length - 1]
        if (this.order.indexOf(anchorLast) + 1 === this.order.indexOf(firstId)) isNoop = true
        insertPos = rest.indexOf(anchorLast) + 1
      }
    }
    if (isNoop) return
    if (insertPos < 0) insertPos = affinity === 'right' ? rest.length : 0
    this.order = [...rest.slice(0, insertPos), ...block, ...rest.slice(insertPos)]
    this.recomputeNonEmpty()
  }

  addSourcemapLocation(i: number) { this.locations.add(i) }

  indent(indentStr: string | { exclude?: [number, number] | [number, number][], indentStart?: boolean }, rawOptions?: { exclude?: [number, number] | [number, number][], indentStart?: boolean }) {
    let options: { exclude?: [number, number] | [number, number][], indentStart?: boolean } = {}
    if (typeof indentStr === 'object' && indentStr !== null) { options = indentStr; indentStr = '\t' }
    else { options = rawOptions || {} }
    const resolved = indentStr as string
    if (resolved === '') return this
    const pattern = /^[^\r\n]/gm
    const isExcluded: Record<number, boolean> = {}
    if (options.exclude) {
      const exclusions = typeof options.exclude[0] === 'number'
        ? [options.exclude as [number, number]]
        : (options.exclude as [number, number][])
      for (const [a, b] of exclusions) for (let i = a; i < b; i++) isExcluded[i] = true
    }
    let shouldIndent = options.indentStart !== false
    const indentPiece = (str: string): string => {
      if (str === '') return str
      const indented = str.replace(pattern, (_m: string, off: number) =>
        off > 0 || shouldIndent ? resolved + _m : _m)
      shouldIndent = str[str.length - 1] === '\n'
      return indented
    }

    this.intro = indentPiece(this.intro)

    // snapshot chunk boundaries in current (possibly moved) order
    let chunkList = this.items()
    let pendingOutroSkip: number | null = null // chunk.start whose outro must NOT be reindented this pass
    let charIndex = 0

    for (let ci = 0; ci < chunkList.length; ci++) {
      let chunk = chunkList[ci]
      const end = chunk.end

      if (!isExcluded[chunk.start]) chunk.intro = indentPiece(this.intros[chunk.items[0]])

      const edited = chunk.items.some(id => this.state[id] !== 'alive')
      if (edited) {
        if (!isExcluded[charIndex]) this.content[chunk.items[0]] = indentPiece(this.content[chunk.items[0]])
      }
      else if (options.exclude) {
        charIndex = chunk.start
        while (charIndex < end) {
          if (!isExcluded[charIndex]) {
            const ch = this.original.charCodeAt(charIndex)
            if (ch === 10) shouldIndent = true
            else if (ch !== 13 && shouldIndent) {
              // indentAt
              shouldIndent = false
              if (charIndex === chunk.start) {
                this.appendRight(charIndex, resolved)
              }
              else {
                this.split(charIndex)
                chunkList = this.items()
                // locate the front chunk ending at charIndex and remainder starting there
                const front = chunkList.find(c => c.end === charIndex && c.items.every(id => chunk!.items.includes(id)))!
                pendingOutroSkip = front.start
                ci = chunkList.findIndex(c => c.start === charIndex && c.items.every(id => chunk!.items.includes(id))) - 1
                this.prependRight(charIndex, resolved)
                chunkList = this.items()
                chunk = chunkList[ci + 1]
              }
            }
          }
          charIndex++
        }
      }
      else {
        charIndex = chunk.start
        while (charIndex < end) {
          if (!shouldIndent) {
            const nl = this.original.indexOf('\n', charIndex)
            if (nl === -1 || nl >= end) break
            shouldIndent = true
            charIndex = nl + 1
            continue
          }
          const ch = this.original.charCodeAt(charIndex)
          if (ch === 10 || ch === 13) { charIndex++; continue }
          // indentAt
          shouldIndent = false
          if (charIndex === chunk.start) {
            this.appendRight(charIndex, resolved)
          }
          else {
            this.split(charIndex)
            chunkList = this.items()
            const front = chunkList.find(c => c.end === charIndex && c.items.every(id => chunk!.items.includes(id)))!
            pendingOutroSkip = front.start
            ci = chunkList.findIndex(c => c.start === charIndex && c.items.every(id => chunk!.items.includes(id))) - 1
            this.prependRight(charIndex, resolved)
            chunkList = this.items()
            chunk = chunkList[ci + 1]
          }
          charIndex++
        }
      }

      if (pendingOutroSkip === chunk.start) {
        pendingOutroSkip = null
      }
      else if (!isExcluded[chunk.end - 1]) {
        const lastItem = chunk.items[chunk.items.length - 1]
        this.outros[lastItem] = indentPiece(this.outros[lastItem])
      }
      charIndex = chunk.end
    }

    this.outro = indentPiece(this.outro)
    this.recomputeNonEmpty()
    return this
  }

  toString(): string {
    let out = this.intro
    for (const ch of this.items()) {
      out += this.intros[ch.items[0]]
      for (const id of ch.items) {
        if (this.state[id] === 'alive') out += this.original[id]
        else if (this.content[id]) out += this.content[id]
      }
      out += this.outros[ch.items[ch.items.length - 1]]
    }
    return out + this.outro
  }

  regionEndAt(start: number): number {
    const h = this.hard.find(h => h.start === start)
    return h ? h.end : start + 1
  }

  recomputeNonEmpty() {
    this.nonEmptyChunks = new Set()
    for (const ch of this.items()) {
      if (ch.items.some(id => this.state[id] !== 'alive') && this.content[ch.items[0]].length > 0) {
        this.nonEmptyChunks.add(ch.start)
      }
    }
  }

  expectedMappings(hires: boolean | 'boundary'): number[][][] {
    const n = this.original.length
    const locAt = new Array<[number, number]>(n + 1)
    let line = 0, col = 0
    for (let i = 0; i <= n; i++) {
      locAt[i] = [line, col]
      if (i < n) {
        if (this.original.charCodeAt(i) === 10) { line++; col = 0 }
        else col++
      }
    }
    const lines: number[][][] = [[]]
    let gLine = 0, gCol = 0
    const newLine = () => { gLine++; gCol = 0; lines[gLine] = [] }
    const seg = (l: number, c: number, nameIdx?: number) => {
      const s = [gCol, 0, l, c]
      if (nameIdx !== undefined && nameIdx >= 0) s.push(nameIdx)
      lines[gLine].push(s)
    }
    const advance = (str: string) => {
      for (let i = 0; i < str.length; i++) {
        if (str.charCodeAt(i) === 10) newLine()
        else gCol++
      }
    }
    const addEdit = (str: string, srcIndex: number) => {
      if (!str.length) return
      const [l, c] = locAt[srcIndex]
      const nameIdx = this.names.indexOf(this.original.slice(srcIndex, this.regionEndAt(srcIndex)))
      let prev = -1
      let nl = str.indexOf('\n')
      while (nl >= 0 && nl < str.length - 1) {
        seg(l, c, nameIdx)
        newLine()
        prev = nl
        nl = str.indexOf('\n', nl + 1)
      }
      seg(l, c, nameIdx)
      advance(str.slice(prev + 1))
    }
    const addUnedited = (items: number[]) => {
      let [l, c] = locAt[items[0]]
      let inWord = false
      for (const id of items) {
        const code = this.original.charCodeAt(id)
        if (code === 10) {
          l++; c = 0; newLine(); inWord = false
        }
        else {
          if (hires === true) {
            seg(l, c)
          }
          else if (hires === 'boundary') {
            if (isWordCode(code)) {
              if (!inWord) { seg(l, c); inWord = true }
            }
            else {
              seg(l, c); inWord = false
            }
          }
          else {
            // lo-res: first char of each chunk-line, plus explicit locations
            const atLineStart = id === items[0] || this.original.charCodeAt(id - 1) === 10
            if (atLineStart || this.locations.has(id)) seg(l, c)
          }
          c++; gCol++
        }
      }
    }

    advance(this.intro)
    for (const ch of this.items()) {
      advance(this.intros[ch.items[0]])
      const edited = ch.items.some(id => this.state[id] !== 'alive')
      if (edited) addEdit(this.content[ch.items[0]], ch.start)
      else addUnedited(ch.items)
      advance(this.outros[ch.items[ch.items.length - 1]])
    }
    advance(this.outro)
    return lines
  }
}

it('scratch smoke', () => {
  const m = new Model('abcdef')
  const s = new MS('abcdef')
  m.split(0); m.split(2); m.split(3)
  s.move(0, 2, 3); m.move(0, 2, 3)
  assert.equal(m.toString(), s.toString())
})

// ---------------- deterministic RNG + op generator ----------------

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Op =
  | { t: 'appendLeft', i: number, c: string }
  | { t: 'prependLeft', i: number, c: string }
  | { t: 'appendRight', i: number, c: string }
  | { t: 'prependRight', i: number, c: string }
  | { t: 'append', c: string }
  | { t: 'prepend', c: string }
  | { t: 'remove', s: number, e: number }
  | { t: 'overwrite', s: number, e: number, c: string, storeName: boolean, contentOnly: boolean }
  | { t: 'move', s: number, e: number, i: number, aff: 'left' | 'right' }
  | { t: 'loc', i: number }
  | { t: 'indent', str: string, exclude?: [number, number] }

const INSERT_CHOICES = ['X', 'Y', '_', '\n', 'Q\n', ' ']

function pick<T>(r: () => number, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length)]
}

function boundary(m: Model, r: () => number): number {
  return Math.floor(r() * (m.original.length + 1))
}

function generateOps(original: string, r: () => number, count: number): Op[] {
  const m = new Model(original)
  const ops: Op[] = []
  const n = original.length
  const weights = [
    ['al', 3], ['pl', 3], ['ar', 3], ['pr', 3],
    ['ap', 1], ['pp', 1],
    ['rm', 4], ['ow', 4], ['mv', 3], ['loc', 1],
    ['ind', 3],
  ] as const
  const totalWeight = weights.reduce((a, [, w]) => a + w, 0)

  for (let k = 0; k < count; k++) {
    let roll = r() * totalWeight
    let choice = weights[0][0]
    for (const [name, w] of weights) { roll -= w; if (roll < 0) { choice = name; break } }

    if (choice === 'al') { const i = boundary(m, r); const c = pick(r, INSERT_CHOICES); if (!m.canSplit(i)) continue; m.split(i); m.appendLeft(i, c); ops.push({ t: 'appendLeft', i, c }) }
    else if (choice === 'pl') { const i = boundary(m, r); const c = pick(r, INSERT_CHOICES); if (!m.canSplit(i)) continue; m.split(i); m.prependLeft(i, c); ops.push({ t: 'prependLeft', i, c }) }
    else if (choice === 'ar') { const i = boundary(m, r); const c = pick(r, INSERT_CHOICES); if (!m.canSplit(i)) continue; m.split(i); m.appendRight(i, c); ops.push({ t: 'appendRight', i, c }) }
    else if (choice === 'pr') { const i = boundary(m, r); const c = pick(r, INSERT_CHOICES); if (!m.canSplit(i)) continue; m.split(i); m.prependRight(i, c); ops.push({ t: 'prependRight', i, c }) }
    else if (choice === 'ap') { const c = pick(r, INSERT_CHOICES); m.append(c); ops.push({ t: 'append', c }) }
    else if (choice === 'pp') { const c = pick(r, INSERT_CHOICES); m.prepend(c); ops.push({ t: 'prepend', c }) }
    else if (choice === 'loc') { const i = Math.floor(r() * n); m.addSourcemapLocation(i); ops.push({ t: 'loc', i }) }
    else if (choice === 'rm') {
      const s = Math.floor(r() * n)
      const e = s + 1 + Math.floor(r() * Math.min(3, n - s))
      if (!m.canSplit(s) || !m.canSplit(e)) continue
      if (!m.isForwardRun(s, e)) continue
      m.remove(s, e); ops.push({ t: 'remove', s, e })
    }
    else if (choice === 'ow') {
      const s = Math.floor(r() * n)
      const e = s + 1 + Math.floor(r() * Math.min(3, n - s))
      if (!m.canSplit(s) || !m.canSplit(e)) continue
      if (!m.isForwardRun(s, e)) continue
      const c = pick(r, ['Z', 'ZZ', '', 'W\nV'])
      const storeName = r() < 0.4
      const contentOnly = r() < 0.3
      m.overwrite(s, e, c, { storeName, contentOnly }); ops.push({ t: 'overwrite', s, e, c, storeName, contentOnly })
    }
    else if (choice === 'mv') {
      const s = Math.floor(r() * n)
      const len = 1 + Math.floor(r() * Math.min(3, n - s))
      const e = s + len
      const i = Math.floor(r() * (n + 1))
      if (i >= s && i <= e) continue
      if (!m.canSplit(s) || !m.canSplit(e) || !m.canSplit(i)) continue
      if (!m.isForwardRun(s, e)) continue
      const aff = r() < 0.5 ? 'left' as const : 'right' as const
      m.move(s, e, i, aff); ops.push({ t: 'move', s, e, i, aff })
    }
    else if (choice === 'ind') {
      const str = pick(r, ['\t', '  ', '>'])
      let exclude: [number, number] | undefined
      if (r() < 0.5 && n >= 2) {
        const a = Math.floor(r() * n)
        const b = Math.min(n, a + 1 + Math.floor(r() * 3))
        if (a < b) exclude = [a, b]
      }
      m.indent(str, exclude ? { exclude } : {}); ops.push({ t: 'indent', str, ...(exclude ? { exclude } : {}) })
    }
  }
  return ops
}

function applyOp(s: MS, op: Op) {
  switch (op.t) {
    case 'appendLeft': s.appendLeft(op.i, op.c); break
    case 'prependLeft': s.prependLeft(op.i, op.c); break
    case 'appendRight': s.appendRight(op.i, op.c); break
    case 'prependRight': s.prependRight(op.i, op.c); break
    case 'append': s.append(op.c); break
    case 'prepend': s.prepend(op.c); break
    case 'remove': s.remove(op.s, op.e); break
    case 'overwrite': s.overwrite(op.s, op.e, op.c, { storeName: op.storeName, contentOnly: op.contentOnly }); break
    case 'move': s.move(op.s, op.e, op.i, op.aff); break
    case 'loc': s.addSourcemapLocation(op.i); break
    case 'indent': s.indent(op.str, op.exclude ? { exclude: op.exclude } : {}); break
  }
}
function applyModel(m: Model, op: Op) {
  switch (op.t) {
    case 'appendLeft': m.split(op.i); m.appendLeft(op.i, op.c); break
    case 'prependLeft': m.split(op.i); m.prependLeft(op.i, op.c); break
    case 'appendRight': m.split(op.i); m.appendRight(op.i, op.c); break
    case 'prependRight': m.split(op.i); m.prependRight(op.i, op.c); break
    case 'append': m.append(op.c); break
    case 'prepend': m.prepend(op.c); break
    case 'remove': m.remove(op.s, op.e); break
    case 'overwrite': m.overwrite(op.s, op.e, op.c, { storeName: op.storeName, contentOnly: op.contentOnly }); break
    case 'move': m.move(op.s, op.e, op.i, op.aff); break
    case 'loc': m.addSourcemapLocation(op.i); break
    case 'indent': m.indent(op.str, op.exclude ? { exclude: op.exclude } : {}); break
  }
}

it('fuzz: model vs library (toString + decoded maps)', () => {
  const sources = ['abcdefgh', 'abcdefgh\n', 'ab\ncde\nfg', 'aaa\nbb\nc', 'a\uD83D\uDE00\nb\nc']
  let mismatches = 0
  for (let seed = 1; seed <= 8000; seed++) {
    const original = sources[seed % sources.length]
    const r = mulberry32(seed * 2654435761)
    const ops = generateOps(original, r, 14)
    const m = new Model(original)
    const s = new MS(original)
    for (const op of ops) { applyModel(m, op); applyOp(s, op) }
    const mt = m.toString(); const st = s.toString()
    if (mt !== st) {
      if (mismatches < 3) console.log('TEXT mismatch seed', seed, JSON.stringify({ original, ops }, null, 0), '\nmodel:', JSON.stringify(mt), '\nlib  :', JSON.stringify(st))
      mismatches++
      continue
    }
    for (const hires of [true, false, 'boundary'] as const) {
      const exp = m.expectedMappings(hires)
      const got = s.generateDecodedMap({ hires }).mappings
      if (JSON.stringify(exp) !== JSON.stringify(got)) {
        if (mismatches < 3) console.log('MAP mismatch seed', seed, 'hires', hires, JSON.stringify({ original, ops }), '\nexp', JSON.stringify(exp), '\ngot', JSON.stringify(got))
        mismatches++
        break
      }
    }
  }
  console.log('total mismatches:', mismatches)
  assert.ok(true)
}, 30000)
