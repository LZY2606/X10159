import type { SourceMapOptions } from '../../src/index.ts'
import { decode } from '@jridgewell/sourcemap-codec'
import { assert, describe, it } from 'vitest'
import { IntegrityCheckingMagicString as MagicString } from '../__utils/IntegrityCheckingMagicString.ts'

/*
 * Deterministic, model-based tests for edit combinations.
 *
 * A fixed-seed generator emits random sequences of the public editing
 * operations (appendLeft / prependRight / overwrite / remove / move /
 * indent / addSourcemapLocation / clone). Alongside the real
 * MagicString instances we keep an independent "provenance" model: an
 * ordered list of blocks, each tagged with the original indices it
 * came from. The model (and never the library's internal Chunk type)
 * decides which generated operations are legal under the public
 * contract; illegal ones are filtered out up front. After every
 * sequence the generated text and the decoded sourcemap (all hires
 * modes plus the encoded form) are compared against the model.
 *
 * Invariants checked:
 *   - toString() matches the model exactly
 *   - unedited characters map back to their own original index
 *   - inserted/indented characters produce no segment
 *   - edited content maps to the original start of its range
 *   - moved characters keep pointing at their original positions
 *   - removed characters leave no generated segment
 *   - clones never share mutable state with their source
 *
 * On failure the operation sequence is reduced with greedy
 * delta-debugging and printed as copy-pastable code.
 */

type Hires = SourceMapOptions['hires']
type Segment = [number, number, number, number, number?]

class ModelIllegal extends Error {}

interface Block {
  start: number
  end: number
  edited: boolean
  text: string
  storeName: boolean
  intro: string
  outro: string
}

function makeBlock(start: number, end: number): Block {
  return {
    start,
    end,
    edited: false,
    text: '',
    storeName: false,
    intro: '',
    outro: '',
  }
}

class Model {
  blocks: Block[]
  intro = ''
  outro = ''
  names: string[] = []
  sourcemapLocations = new Set<number>()
  private srcLine: number[]
  private srcCol: number[]

  constructor(readonly original: string) {
    this.blocks = [makeBlock(0, original.length)]
    this.srcLine = new Array(original.length).fill(0)
    this.srcCol = new Array(original.length).fill(0)
    let line = 0
    let col = 0
    for (let i = 0; i < original.length; i += 1) {
      this.srcLine[i] = line
      this.srcCol[i] = col
      if (original[i] === '\n') {
        line += 1
        col = 0
      }
      else {
        col += 1
      }
    }
  }

  clone(): Model {
    const model = Object.create(Model.prototype) as Model
    model.original = this.original
    model.blocks = this.blocks.map(block => ({ ...block }))
    model.intro = this.intro
    model.outro = this.outro
    model.names = this.names.slice()
    model.sourcemapLocations = new Set(this.sourcemapLocations)
    model.srcLine = this.srcLine
    model.srcCol = this.srcCol
    return model
  }

  private blockIndexStartingAt(index: number): number {
    return this.blocks.findIndex(block => block.start === index)
  }

  private blockIndexEndingAt(index: number): number {
    return this.blocks.findIndex(block => block.end === index)
  }

  private requireInRange(index: number): void {
    if (index < 0 || index > this.original.length)
      throw new ModelIllegal(`index ${index} out of range`)
  }

  /**
   * A boundary may not fall strictly inside a chunk whose edit content
   * is non-empty: the library refuses to split such a chunk.
   */
  private boundaryLegal(index: number): boolean {
    return !this.blocks.some(
      block => block.edited && block.text.length > 0 && block.start < index && index < block.end,
    )
  }

  private splitAt(index: number): void {
    if (this.blockIndexStartingAt(index) !== -1 || this.blockIndexEndingAt(index) !== -1)
      return

    const k = this.blocks.findIndex(block => block.start < index && index < block.end)
    if (k === -1)
      return

    const block = this.blocks[k]
    if (block.edited && block.text.length > 0)
      throw new ModelIllegal('cannot split a chunk that has already been edited')

    if (block.edited) {
      const left: Block = { ...block, end: index, outro: '' }
      const right = makeBlock(index, block.end)
      right.edited = true
      this.blocks.splice(k, 1, left, right)
    }
    else {
      const left = makeBlock(block.start, index)
      left.intro = block.intro
      const right = makeBlock(index, block.end)
      right.outro = block.outro
      this.blocks.splice(k, 1, left, right)
    }
  }

  /**
   * Indices of the blocks covering [start, end) after the two boundary
   * splits; they must form a contiguous run in generated order, which is
   * what both overwrite() and move() require.
   */
  private rangeRun(start: number, end: number): number[] {
    const indices: number[] = []
    for (let i = 0; i < this.blocks.length; i += 1) {
      const block = this.blocks[i]
      if (block.start >= start && block.end <= end)
        indices.push(i)
    }
    for (let i = 1; i < indices.length; i += 1) {
      if (indices[i] !== indices[i - 1] + 1)
        throw new ModelIllegal(`range ${start}-${end} straddles an earlier move`)
    }
    return indices
  }

  private prepareRange(start: number, end: number): void {
    if (start < 0 || end > this.original.length || start >= end)
      throw new ModelIllegal(`invalid range ${start}-${end}`)
    if (!this.boundaryLegal(start) || !this.boundaryLegal(end))
      throw new ModelIllegal(`cannot split edited chunk at ${start}-${end}`)
    this.splitAt(start)
    this.splitAt(end)
  }

  appendLeft(index: number, content: string): void {
    this.requireInRange(index)
    if (!this.boundaryLegal(index))
      throw new ModelIllegal(`cannot split edited chunk at ${index}`)
    this.splitAt(index)
    const k = this.blockIndexEndingAt(index)
    if (k === -1)
      this.intro += content
    else
      this.blocks[k].outro += content
  }

  prependRight(index: number, content: string): void {
    this.requireInRange(index)
    if (!this.boundaryLegal(index))
      throw new ModelIllegal(`cannot split edited chunk at ${index}`)
    this.splitAt(index)
    const k = this.blockIndexStartingAt(index)
    if (k === -1)
      this.outro = content + this.outro
    else
      this.blocks[k].intro = content + this.blocks[k].intro
  }

  overwrite(start: number, end: number, content: string, storeName: boolean, clearInserts: boolean): void {
    this.prepareRange(start, end)
    const run = this.rangeRun(start, end)
    const first = this.blocks[run[0]]

    if (storeName) {
      const key = this.original.slice(start, end)
      if (!this.names.includes(key))
        this.names.push(key)
    }

    first.edited = true
    first.text = content
    first.storeName = storeName
    if (clearInserts) {
      first.intro = ''
      first.outro = ''
    }

    for (const k of run.slice(1)) {
      const block = this.blocks[k]
      block.edited = true
      block.text = ''
      block.storeName = false
      block.intro = ''
      block.outro = ''
    }
  }

  remove(start: number, end: number): void {
    this.prepareRange(start, end)
    for (const block of this.blocks) {
      if (block.start < start || block.end > end)
        continue
      if (block.start > start)
        block.intro = ''
      if (block.end < end)
        block.outro = ''
      block.edited = true
      block.text = ''
      block.storeName = false
    }
  }

  move(start: number, end: number, index: number, affinity: 'left' | 'right'): void {
    this.prepareRange(start, end)
    this.requireInRange(index)
    if (index >= start && index <= end)
      throw new ModelIllegal('cannot move a selection inside itself')
    if (!this.boundaryLegal(index))
      throw new ModelIllegal(`cannot split edited chunk at ${index}`)
    this.splitAt(index)

    const run = this.rangeRun(start, end)
    const moved = run.map(k => this.blocks[k])
    const rightAnchor = affinity === 'right'
      ? this.blocks.find(block => block.start === index)
      : undefined
    const leftAnchor = affinity === 'left'
      ? this.blocks.find(block => block.end === index)
      : undefined

    this.blocks = this.blocks.filter(block => !moved.includes(block))

    let insertion: number
    if (affinity === 'left')
      insertion = leftAnchor ? this.blocks.indexOf(leftAnchor) + 1 : 0
    else
      insertion = rightAnchor ? this.blocks.indexOf(rightAnchor) : this.blocks.length

    this.blocks.splice(insertion, 0, ...moved)
  }

  addSourcemapLocation(index: number): void {
    if (index < 0 || index >= this.original.length)
      throw new ModelIllegal(`location ${index} out of range`)
    this.sourcemapLocations.add(index)
  }

  indent(indentStr: string, exclusions: Array<[number, number]> | null): void {
    if (indentStr === '')
      return

    const isExcluded = new Set<number>()
    if (exclusions) {
      for (const [start, end] of exclusions) {
        for (let i = start; i < end; i += 1)
          isExcluded.add(i)
      }
    }

    let shouldIndent = true
    const isLineTerminator = (char: string): boolean =>
      char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029'
    const indentPiece = (str: string): string => {
      if (str === '')
        return str
      let result = ''
      for (let i = 0; i < str.length; i += 1) {
        const char = str[i]
        const atLineStart = i === 0 ? shouldIndent : isLineTerminator(str[i - 1])
        if (atLineStart && char !== '\n' && char !== '\r')
          result += indentStr
        result += char
      }
      shouldIndent = str[str.length - 1] === '\n'
      return result
    }

    this.intro = indentPiece(this.intro)

    let charIndex = 0
    let blockIndex = 0
    while (blockIndex < this.blocks.length) {
      let block = this.blocks[blockIndex]

      if (!isExcluded.has(block.start))
        block.intro = indentPiece(block.intro)

      if (block.edited) {
        if (!isExcluded.has(charIndex))
          block.text = indentPiece(block.text)
      }
      else {
        for (let i = block.start; i < block.end; i += 1) {
          if (isExcluded.has(i))
            continue
          const char = this.original[i]
          if (char === '\n') {
            shouldIndent = true
          }
          else if (char !== '\r' && shouldIndent) {
            shouldIndent = false
            this.splitAt(i)
            block = this.blocks[this.blockIndexStartingAt(i)]
            block.intro += indentStr
          }
        }
      }

      if (!isExcluded.has(block.end - 1))
        block.outro = indentPiece(block.outro)

      charIndex = block.end
      blockIndex = this.blocks.indexOf(block) + 1
    }

    this.outro = indentPiece(this.outro)
  }

  toString(): string {
    let result = this.intro
    for (const block of this.blocks) {
      const content = block.edited ? block.text : this.original.slice(block.start, block.end)
      result += block.intro + content + block.outro
    }
    return result + this.outro
  }

  /**
   * Predicted decoded mappings, expressed purely through the documented
   * sourcemap contract: one segment per unedited character (hires),
   * one per word boundary (boundary), or line starts plus explicit
   * locations (lores); edited content segments at the start of each line
   * pointing at the original range start; inserted and removed text
   * produces nothing.
   */
  expectedMappings(hires: Hires): Segment[][] {
    const lines: Segment[][] = [[]]
    let genLine = 0
    let genCol = 0

    const push = (sourceIndex: number, column: number, nameIndex: number): void => {
      const segment: Segment = [column, 0, this.srcLine[sourceIndex], this.srcCol[sourceIndex]]
      if (nameIndex >= 0)
        segment.push(nameIndex)
      lines[genLine].push(segment)
    }

    const advance = (str: string): void => {
      for (const char of str) {
        if (char === '\n') {
          genLine += 1
          genCol = 0
          lines.push([])
        }
        else {
          genCol += 1
        }
      }
    }

    const advanceEdited = (str: string, sourceIndex: number, nameIndex: number): void => {
      if (str.length === 0)
        return
      push(sourceIndex, genCol, nameIndex)
      for (let i = 0; i < str.length; i += 1) {
        if (str[i] === '\n') {
          genLine += 1
          genCol = 0
          lines.push([])
          if (i < str.length - 1)
            push(sourceIndex, 0, nameIndex)
        }
        else {
          genCol += 1
        }
      }
    }

    const isWordCode = (code: number): boolean =>
      (code >= 97 && code <= 122)
      || (code >= 65 && code <= 90)
      || (code >= 48 && code <= 57)
      || code === 95

    const emitUnedited = (block: Block): void => {
      let i = block.start
      if (hires === 'boundary') {
        let inWord = false
        while (i < block.end) {
          const code = this.original.charCodeAt(i)
          if (code === 10) {
            genLine += 1
            genCol = 0
            lines.push([])
            inWord = false
          }
          else if (isWordCode(code)) {
            if (!inWord)
              push(i, genCol, -1)
            inWord = true
            genCol += 1
          }
          else {
            push(i, genCol, -1)
            inWord = false
            genCol += 1
          }
          i += 1
        }
        return
      }
      if (hires === true) {
        while (i < block.end) {
          if (this.original[i] === '\n') {
            genLine += 1
            genCol = 0
            lines.push([])
          }
          else {
            push(i, genCol, -1)
            genCol += 1
          }
          i += 1
        }
        return
      }
      while (i < block.end) {
        let newline = this.original.indexOf('\n', i)
        if (newline === -1 || newline > block.end)
          newline = block.end
        if (newline > i) {
          push(i, genCol, -1)
          for (const location of [...this.sourcemapLocations].sort((a, b) => a - b)) {
            if (location > i && location < newline)
              push(location, genCol + location - i, -1)
          }
          genCol += newline - i
        }
        if (newline === block.end)
          break
        genLine += 1
        genCol = 0
        i = newline + 1
      }
    }

    advance(this.intro)
    for (const block of this.blocks) {
      advance(block.intro)
      if (block.edited) {
        const key = this.original.slice(block.start, block.end)
        const nameIndex = block.storeName ? this.names.indexOf(key) : -1
        advanceEdited(block.text, block.start, nameIndex)
      }
      else {
        emitUnedited(block)
      }
      advance(block.outro)
    }
    advance(this.outro)

    return lines
  }
}

type Op =
  | { op: 'appendLeft' | 'prependRight', inst: number, index: number, content: string }
  | { op: 'overwrite', inst: number, start: number, end: number, content: string, storeName: boolean, clearInserts: boolean }
  | { op: 'remove', inst: number, start: number, end: number }
  | { op: 'move', inst: number, start: number, end: number, index: number, affinity: 'left' | 'right' }
  | { op: 'indent', inst: number, indentStr: string, exclusions: Array<[number, number]> | null }
  | { op: 'addSourcemapLocation', inst: number, index: number }
  | { op: 'clone', inst: number }

function applyModelOp(models: Model[], op: Op): void {
  switch (op.op) {
    case 'appendLeft':
      models[op.inst].appendLeft(op.index, op.content)
      break
    case 'prependRight':
      models[op.inst].prependRight(op.index, op.content)
      break
    case 'overwrite':
      models[op.inst].overwrite(op.start, op.end, op.content, op.storeName, op.clearInserts)
      break
    case 'remove':
      models[op.inst].remove(op.start, op.end)
      break
    case 'move':
      models[op.inst].move(op.start, op.end, op.index, op.affinity)
      break
    case 'indent':
      models[op.inst].indent(op.indentStr, op.exclusions)
      break
    case 'addSourcemapLocation':
      models[op.inst].addSourcemapLocation(op.index)
      break
    case 'clone':
      models.push(models[op.inst].clone())
      break
  }
}

function applyLibraryOp(ms: MagicString, op: Op): void {
  switch (op.op) {
    case 'appendLeft':
      ms.appendLeft(op.index, op.content)
      break
    case 'prependRight':
      ms.prependRight(op.index, op.content)
      break
    case 'overwrite':
      ms.overwrite(op.start, op.end, op.content, {
        storeName: op.storeName,
        overwrite: op.clearInserts,
      })
      break
    case 'remove':
      ms.remove(op.start, op.end)
      break
    case 'move':
      ms.move(op.start, op.end, op.index, op.affinity)
      break
    case 'indent':
      ms.indent(op.indentStr, op.exclusions ? { exclude: op.exclusions } : undefined)
      break
    case 'addSourcemapLocation':
      ms.addSourcemapLocation(op.index)
      break
    case 'clone':
      break
  }
}

interface Instance {
  s: MagicString
  model: Model
}

function replay(source: string, ops: Op[]): Instance[] {
  const instances: Instance[] = [{
    s: new MagicString(source),
    model: new Model(source),
  }]

  for (const op of ops) {
    if (op.inst >= instances.length)
      continue

    const probe = instances.map(instance => instance.model.clone())
    try {
      applyModelOp(probe, op)
    }
    catch (error) {
      if (error instanceof ModelIllegal)
        continue
      throw error
    }

    probe.forEach((model, i) => {
      if (instances[i])
        instances[i].model = model
    })

    if (op.op === 'clone') {
      instances.push({
        s: instances[op.inst].s.clone(),
        model: probe[probe.length - 1],
      })
    }
    else {
      applyLibraryOp(instances[op.inst].s, op)
    }
  }

  return instances
}

function checkInstances(instances: Instance[]): void {
  for (const { s, model } of instances) {
    assert.strictEqual(s.toString(), model.toString(), 'toString() mismatch')

    for (const hires of [true, 'boundary', false] as const) {
      const decoded = s.generateDecodedMap({
        hires,
        source: 'input.js',
        includeContent: true,
      })
      assert.deepEqual(
        decoded.mappings,
        model.expectedMappings(hires),
        `decoded mappings mismatch (hires: ${String(hires)})`,
      )
      assert.deepEqual(decoded.names, model.names, `names mismatch (hires: ${String(hires)})`)
      assert.deepEqual(decoded.sources, ['input.js'])
      assert.deepEqual(decoded.sourcesContent, [model.original])
    }

    const encoded = s.generateMap({ hires: true, source: 'input.js' })
    assert.deepEqual(
      decode(encoded.mappings),
      model.expectedMappings(true),
      'encoded mappings mismatch',
    )
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SOURCES = [
  'ABCDEFGHIJ',
  'hello world',
  'foo\nbar\nbaz\n',
  'a\tb\nc',
  '',
  'x',
  'a\n\nb\n',
  'let answer = 42;\nconsole.log(answer);\n',
  'a\u{1F600}bc\u{1F601}d',
]

const INSERT_ALPHABET = ['X', 'Y', 'Z', '_', '\n', '\t']
const INDENT_STRINGS = ['\t', '  ', '>> ']
const MAX_INSTANCES = 5
const OP_COUNT = 55

function randomContent(rng: () => number): string {
  const length = rng() < 0.15 ? 0 : 1 + Math.floor(rng() * 3)
  let result = ''
  for (let i = 0; i < length; i += 1)
    result += INSERT_ALPHABET[Math.floor(rng() * INSERT_ALPHABET.length)]
  return result
}

function randomRange(rng: () => number, length: number): [number, number] {
  const start = Math.floor(rng() * length)
  const end = start + 1 + Math.floor(rng() * (length - start))
  return [start, end]
}

function randomOp(rng: () => number, length: number, instanceCount: number): Op {
  const inst = Math.floor(rng() * instanceCount)
  let kind = rng()
  if (instanceCount >= MAX_INSTANCES && kind < 0.9)
    kind = 0.95

  if (kind < 0.14)
    return { op: 'appendLeft', inst, index: Math.floor(rng() * (length + 1)), content: randomContent(rng) }
  if (kind < 0.28)
    return { op: 'prependRight', inst, index: Math.floor(rng() * (length + 1)), content: randomContent(rng) }
  if (kind < 0.46 && length > 0) {
    const [start, end] = randomRange(rng, length)
    return {
      op: 'overwrite',
      inst,
      start,
      end,
      content: randomContent(rng),
      storeName: rng() < 0.3,
      clearInserts: rng() < 0.2,
    }
  }
  if (kind < 0.56 && length > 0) {
    const [start, end] = randomRange(rng, length)
    return { op: 'remove', inst, start, end }
  }
  if (kind < 0.70 && length > 1) {
    const [start, end] = randomRange(rng, length)
    const movable = []
    for (let i = 0; i <= length; i += 1) {
      if (i < start || i > end)
        movable.push(i)
    }
    return {
      op: 'move',
      inst,
      start,
      end,
      index: movable[Math.floor(rng() * movable.length)],
      affinity: rng() < 0.5 ? 'left' : 'right',
    }
  }
  if (kind < 0.80) {
    let exclusions: Array<[number, number]> | null = null
    if (length > 1 && rng() < 0.3) {
      const [start, end] = randomRange(rng, length)
      exclusions = [[start, end]]
    }
    return {
      op: 'indent',
      inst,
      indentStr: INDENT_STRINGS[Math.floor(rng() * INDENT_STRINGS.length)],
      exclusions,
    }
  }
  if (kind < 0.90 && length > 0)
    return { op: 'addSourcemapLocation', inst, index: Math.floor(rng() * length) }

  return { op: 'clone', inst }
}

function generateOps(seed: number, source: string): Op[] {
  const rng = mulberry32(seed)
  let models: Model[] = [new Model(source)]
  const ops: Op[] = []
  let attempts = 0

  while (ops.length < OP_COUNT && attempts < OP_COUNT * 30) {
    attempts += 1
    const op = randomOp(rng, source.length, models.length)
    if (op.inst >= models.length)
      continue

    const probe = models.map(model => model.clone())
    try {
      applyModelOp(probe, op)
    }
    catch (error) {
      if (error instanceof ModelIllegal)
        continue
      throw error
    }
    models = probe
    ops.push(op)
  }

  return ops
}

function fails(source: string, ops: Op[]): boolean {
  try {
    checkInstances(replay(source, ops))
    return false
  }
  catch {
    return true
  }
}

/** Greedy single-op removal until no single removal still fails. */
function minimize(source: string, ops: Op[]): Op[] {
  let current = ops
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < current.length; i += 1) {
      const candidate = current.slice(0, i).concat(current.slice(i + 1))
      if (fails(source, candidate)) {
        current = candidate
        changed = true
        break
      }
    }
  }
  return current
}

function formatReproduction(seed: number, source: string, ops: Op[]): string {
  const lines: string[] = [
    `// failing model-based sequence (seed ${seed})`,
    `const s0 = new MagicString(${JSON.stringify(source)})`,
  ]
  let nextInstance = 1
  const models = [new Model(source)]

  for (const op of ops) {
    if (op.inst >= models.length)
      continue
    // mirror replay(): ops the model considers illegal are skipped
    const probe = models.map(model => model.clone())
    try {
      applyModelOp(probe, op)
    }
    catch (error) {
      if (error instanceof ModelIllegal)
        continue
      throw error
    }
    models.length = 0
    models.push(...probe)

    switch (op.op) {
      case 'clone':
        lines.push(`const s${nextInstance} = s${op.inst}.clone()`)
        nextInstance += 1
        break
      case 'appendLeft':
        lines.push(`s${op.inst}.appendLeft(${op.index}, ${JSON.stringify(op.content)})`)
        break
      case 'prependRight':
        lines.push(`s${op.inst}.prependRight(${op.index}, ${JSON.stringify(op.content)})`)
        break
      case 'overwrite':
        lines.push(`s${op.inst}.overwrite(${op.start}, ${op.end}, ${JSON.stringify(op.content)}, ${JSON.stringify({ storeName: op.storeName, overwrite: op.clearInserts })})`)
        break
      case 'remove':
        lines.push(`s${op.inst}.remove(${op.start}, ${op.end})`)
        break
      case 'move':
        lines.push(`s${op.inst}.move(${op.start}, ${op.end}, ${op.index}, ${JSON.stringify(op.affinity)})`)
        break
      case 'indent':
        lines.push(`s${op.inst}.indent(${JSON.stringify(op.indentStr)}${op.exclusions ? `, { exclude: ${JSON.stringify(op.exclusions)} }` : ''})`)
        break
      case 'addSourcemapLocation':
        lines.push(`s${op.inst}.addSourcemapLocation(${op.index})`)
        break
    }
  }

  return lines.join('\n')
}

const SEED_COUNT = 24

describe('magicString', () => {
  describe('model-based randomised edit sequences', () => {
    for (let seed = 1; seed <= SEED_COUNT; seed += 1) {
      it(`matches the provenance model for seed ${seed}`, () => {
        const source = SOURCES[seed % SOURCES.length]
        const ops = generateOps(seed, source)
        try {
          checkInstances(replay(source, ops))
        }
        catch (error) {
          const reduced = minimize(source, ops)
          const reproduction = formatReproduction(seed, source, reduced)
          const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
          throw new Error(
            `Provenance model violation (seed ${seed})\n`
            + `${message}\n\n`
            + `Minimal failing reproduction:\n${reproduction}\n`,
          )
        }
      })
    }
  })
})
