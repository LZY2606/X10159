/*
 * Independent reference model for random MagicString edit sequences.
 *
 * Written straight from the documented public behaviour - it does not import
 * or mirror the library's internal `Chunk` linked list:
 *
 *  - original characters are partitioned into contiguous blocks over [0, n)
 *    in original ("tiling") order; a separate array holds the same blocks in
 *    output order and `move` reorders that one
 *  - each block carries an `intro` (inserted text emitted before its content,
 *    from appendRight/prependRight) and an `outro` (emitted after, from
 *    appendLeft/prependLeft); splitting a block moves its outro to the new
 *    right-hand block
 *  - blocks can be replaced (`overwrite`) or deleted (`remove`); splitting a
 *    block that currently holds non-empty replacement text is rejected
 *
 * The model predicts the generated string, the original index behind every
 * generated character (`null` = pure insertion), and the exact decoded map.
 */

export type Op
  = | { type: 'appendLeft', index: number, text: string }
    | { type: 'prependLeft', index: number, text: string }
    | { type: 'appendRight', index: number, text: string }
    | { type: 'prependRight', index: number, text: string }
    | { type: 'append', text: string }
    | { type: 'prepend', text: string }
    | {
      type: 'overwrite'
      start: number
      end: number
      text: string
      storeName?: boolean
      contentOnly?: boolean
    }
    | { type: 'remove', start: number, end: number }
    | { type: 'reset', start: number, end: number }
    | {
      type: 'move'
      start: number
      end: number
      index: number
      affinity?: 'left' | 'right'
    }
    | {
      type: 'indent'
      indentStr: string
      exclude?: Array<[number, number]>
      indentStart?: boolean
    }
    | { type: 'addSourcemapLocation', index: number }

export type Hires = boolean | 'boundary'

interface Block {
  start: number
  end: number
  // original text covered by this block; splitting shortens it in place, so
  // storeName segments (which key off chunk.original) see the shortened value
  original: string
  content: string
  intro: string
  outro: string
  edited: boolean
  storeName: boolean
}

const NEWLINE_CHAR = 10
const CR_CHAR = 13

export class ReferenceModel {
  readonly source: string
  private blocks: Block[] = []
  private output: Block[] = []
  private sourcemapLocations = new Set<number>()
  intro = ''
  outro = ''
  private storedNames: string[] = []

  constructor(source: string) {
    this.source = source
    const block: Block = {
      start: 0,
      end: source.length,
      original: source,
      content: source,
      intro: '',
      outro: '',
      edited: false,
      storeName: false,
    }
    this.blocks.push(block)
    this.output.push(block)
  }

  private tilingBlockContaining(index: number): Block {
    let lo = 0
    let hi = this.blocks.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.blocks[mid].end <= index)
        lo = mid + 1
      else
        hi = mid
    }
    return this.blocks[lo]
  }

  private blockStartingAt(index: number): Block | undefined {
    return this.blocks.find(block => block.start === index)
  }

  private blockEndingAt(index: number): Block | undefined {
    return this.blocks.find(block => block.end === index)
  }

  // Splitting inside a block that currently holds non-empty replacement text
  // is a contract error ("cannot split a chunk that has already been edited").
  canSplit(index: number): boolean {
    if (this.blockStartingAt(index) || this.blockEndingAt(index))
      return true
    const block = this.tilingBlockContaining(index)
    return !(block.edited && block.content.length > 0)
  }

  private split(index: number): void {
    if (this.blockStartingAt(index) || this.blockEndingAt(index))
      return
    const block = this.tilingBlockContaining(index)
    const sliceAt = index - block.start
    const before = block.original.slice(0, sliceAt)
    const after = block.original.slice(sliceAt)

    const carriedOutro = block.outro
    const right: Block = {
      start: index,
      end: block.end,
      original: after,
      content: block.edited ? '' : this.source.slice(index, block.end),
      intro: '',
      // an unedited split hands the old right-side insert group to the new
      // block; splitting an already-edited block follows that move with
      // edit(''), which wipes intro+outro again
      outro: block.edited ? '' : carriedOutro,
      edited: block.edited,
      storeName: false,
    }
    void carriedOutro
    if (block.edited) {
      block.content = ''
    }
    else {
      block.content = before
    }
    block.original = before
    block.end = index
    block.outro = ''

    const blockIndex = this.blocks.indexOf(block)
    this.blocks.splice(blockIndex + 1, 0, right)
    const outputIndex = this.output.indexOf(block)
    this.output.splice(outputIndex + 1, 0, right)
  }

  private ensureSplits(indices: number[]): boolean {
    if (indices.some(index => !this.canSplit(index)))
      return false
    indices.forEach(index => this.split(index))
    return true
  }

  // ---- boundary inserts ----

  appendLeft(index: number, text: string): boolean {
    if (!this.ensureSplits([index]))
      return false
    const chunk = this.blockEndingAt(index)
    if (chunk)
      chunk.outro += text
    else
      this.intro += text
    return true
  }

  prependLeft(index: number, text: string): boolean {
    if (!this.ensureSplits([index]))
      return false
    const chunk = this.blockEndingAt(index)
    if (chunk)
      chunk.outro = text + chunk.outro
    else
      this.intro = text + this.intro
    return true
  }

  appendRight(index: number, text: string): boolean {
    if (!this.ensureSplits([index]))
      return false
    const chunk = this.blockStartingAt(index)
    if (chunk)
      chunk.intro = chunk.intro + text
    else
      this.outro += text
    return true
  }

  prependRight(index: number, text: string): boolean {
    if (!this.ensureSplits([index]))
      return false
    const chunk = this.blockStartingAt(index)
    if (chunk)
      chunk.intro = text + chunk.intro
    else
      this.outro = text + this.outro
    return true
  }

  append(text: string): boolean {
    this.outro += text
    return true
  }

  prepend(text: string): boolean {
    this.intro = text + this.intro
    return true
  }

  addSourcemapLocation(index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index > this.source.length)
      return false
    this.sourcemapLocations.add(index)
    return true
  }

  overwrite(start: number, end: number, text: string, options: { storeName?: boolean, contentOnly?: boolean } = {}): boolean {
    if (start < 0 || end > this.source.length || start >= end)
      return false
    if (!this.ensureSplits([start, end]))
      return false

    const first = this.blockStartingAt(start)!
    const last = this.blockEndingAt(end)!

    // "cannot overwrite across a split point": tiling adjacency must survive
    // any earlier move
    let cursor = first
    while (cursor !== last) {
      const tilingNext = this.blocks[this.blocks.indexOf(cursor) + 1]
      const outputNext = this.output[this.output.indexOf(cursor) + 1]
      if (outputNext !== tilingNext)
        return false
      cursor = tilingNext
    }

    // update() registers storeName entries as original.slice(start, end) on
    // the MagicString's source text (not the split chunk's shortened original)
    if (options.storeName) {
      const name = this.source.slice(start, end)
      if (!this.storedNames.includes(name))
        this.storedNames.push(name)
    }

    // Mirrors update(): for chunk = first; chunk !== last; chunk = next -> edit('')
    // then first.edit(content, storeName, !overwrite). Every chunk after first
    // (including last) is emptied and, unless contentOnly, loses intro+outro.
    // run-up chunks are edited with contentOnly=false, so their intro/outro
    // is always wiped; only first.edit() honours contentOnly and keeps its
    // own intro/outro when that option is set.
    const preserveFirstInserts = options.contentOnly ?? false
    let block: Block | undefined = first
    while (block !== last) {
      block = this.blocks[this.blocks.indexOf(block) + 1]
      block.intro = ''
      block.outro = ''
      block.content = ''
      block.edited = true
      block.storeName = false
    }
    if (!preserveFirstInserts) {
      first.intro = ''
      first.outro = ''
    }
    first.content = text
    first.edited = true
    first.storeName = options.storeName ?? false
    return true
  }

  remove(start: number, end: number): boolean {
    if (start < 0 || end > this.source.length || start > end)
      return false
    if (start === end)
      return true
    if (!this.ensureSplits([start, end]))
      return false

    let block = this.blockStartingAt(start)!
    for (;;) {
      // inserts strictly inside the range are removed with the characters;
      // edge inserts (intro on the chunk starting at start, outro on the
      // chunk ending at end) are preserved
      if (block.start > start)
        block.intro = ''
      block.outro = ''
      block.content = ''
      block.edited = true
      block.storeName = false
      if (block.end === end)
        break
      block = this.blocks[this.blocks.indexOf(block) + 1]
    }
    return true
  }

  reset(start: number, end: number): boolean {
    if (start < 0 || end > this.source.length || start > end)
      return false
    if (start === end)
      return true
    if (!this.ensureSplits([start, end]))
      return false

    let block = this.blockStartingAt(start)!
    for (;;) {
      // chunk.reset() always clears the intro; the outro (left-side inserts
      // at the next boundary) is cleared only for chunks strictly inside the
      // range, so an insert anchored exactly at `end` survives
      block.intro = ''
      block.outro = ''
      if (block.edited) {
        block.content = block.original
        block.edited = false
        block.storeName = false
      }
      if (block.end === end)
        break
      block = this.blocks[this.blocks.indexOf(block) + 1]
    }
    return true
  }

  move(start: number, end: number, index: number, affinity: 'left' | 'right' = 'right'): boolean {
    if (start === end)
      return true
    if (start < 0 || end > this.source.length || start > end)
      return false
    if (index < 0 || index > this.source.length)
      return false
    if (index >= start && index <= end)
      return false // cannot move a selection inside itself
    if (!this.ensureSplits([start, end, index]))
      return false

    const first = this.blockStartingAt(start)!
    const last = this.blockEndingAt(end)!

    let probe: Block | undefined = first
    while (probe !== last) {
      probe = this.output[this.output.indexOf(probe) + 1]
      if (!probe || probe.start < start || probe.end > end)
        return false
    }

    let insertAt: number
    if (affinity === 'left') {
      const anchor = this.blockEndingAt(index)
      if (!anchor) {
        if (first === this.output[0])
          return true
        insertAt = 0
      }
      else {
        insertAt = this.output.indexOf(anchor) + 1
        if (this.output[insertAt] === first)
          return true
      }
    }
    else {
      const anchor = this.blockStartingAt(index)
      if (!anchor) {
        if (last === this.output[this.output.length - 1])
          return true
        insertAt = this.output.length
      }
      else {
        insertAt = this.output.indexOf(anchor)
        if (this.output[insertAt - 1] === last)
          return true
      }
    }

    const firstAt = this.output.indexOf(first)
    const moved = this.output.splice(firstAt, this.output.indexOf(last) - firstAt + 1)
    if (insertAt > firstAt)
      insertAt -= moved.length
    this.output.splice(insertAt, 0, ...moved)
    return true
  }

  // Independent re-implementation of MagicString.indent's observable
  // transformation: inserted text is re-indented per block, original
  // characters line by line, honouring exclusion ranges.
  indent(indentStr: string, options: { exclude?: Array<[number, number]>, indentStart?: boolean } = {}): boolean {
    if (indentStr === '')
      return true
    const isExcluded = new Set<number>()
    for (const [start, end] of options.exclude ?? []) {
      for (let i = start; i < end; i += 1)
        isExcluded.add(i)
    }

    let shouldIndentNextCharacter = options.indentStart !== false
    const indentPiece = (text: string): string => {
      if (text === '')
        return text
      const indented = text.replace(/^[^\r\n]/gm, (match, offset: number) =>
        offset > 0 || shouldIndentNextCharacter ? `${indentStr}${match}` : match)
      shouldIndentNextCharacter = text[text.length - 1] === '\n'
      return indented
    }

    this.intro = indentPiece(this.intro)

    let charIndex = 0
    let outputIndex = 0

    // indentAt mirrors the library: when the index is inside the current
    // block it splits and prepends to the new block; the caller keeps scanning
    // with the global charIndex up to the ORIGINAL block end, so we remember
    // which block to resume from rather than following outputIndex blindly.
    let resumeBlock: Block = this.output[0]
    const indentAt = (index: number) => {
      shouldIndentNextCharacter = false
      if (index === resumeBlock.start) {
        resumeBlock.intro += indentStr
      }
      else {
        this.split(index)
        const right = this.blockStartingAt(index)!
        right.intro = indentStr + right.intro
      }
    }

    while (outputIndex < this.output.length) {
      const block = this.output[outputIndex]
      resumeBlock = block
      const end = block.end

      if (!isExcluded.has(block.start))
        block.intro = indentPiece(block.intro)

      if (block.edited) {
        if (!isExcluded.has(charIndex))
          block.content = indentPiece(block.content)
      }
      else if (options.exclude) {
        charIndex = block.start
        while (charIndex < end) {
          if (!isExcluded.has(charIndex)) {
            const char = this.source.charCodeAt(charIndex)
            if (char === NEWLINE_CHAR) {
              shouldIndentNextCharacter = true
            }
            else if (char !== CR_CHAR && shouldIndentNextCharacter) {
              indentAt(charIndex)
            }
          }
          charIndex += 1
        }
      }
      else {
        charIndex = block.start
        while (charIndex < end) {
          if (!shouldIndentNextCharacter) {
            const nextLine = this.source.indexOf('\n', charIndex)
            if (nextLine === -1 || nextLine >= end)
              break
            shouldIndentNextCharacter = true
            charIndex = nextLine + 1
            continue
          }
          const char = this.source.charCodeAt(charIndex)
          if (char === NEWLINE_CHAR || char === CR_CHAR) {
            charIndex += 1
            continue
          }
          indentAt(charIndex)
          charIndex += 1
        }
      }

      // the split may have created blocks after the one we entered on; finish
      // the outro of the block that currently owns end-1, then resume the
      // outer walk at whatever follows it in output order
      const lastTouched = this.tilingBlockContaining(Math.max(block.start, end - 1))
      if (!isExcluded.has(lastTouched.end - 1))
        lastTouched.outro = indentPiece(lastTouched.outro)

      charIndex = end
      outputIndex = this.output.indexOf(this.blockEndingAt(end) ?? this.blocks[this.blocks.length - 1]) + 1
    }

    this.outro = indentPiece(this.outro)
    return true
  }

  // ---- rendering ----

  render(): { text: string, origin: Array<number | null> } {
    let text = this.intro
    let origin: Array<number | null> = Array.from<number | null>({ length: this.intro.length }).fill(null)
    const push = (part: string, partOrigin: Array<number | null>) => {
      text += part
      origin = origin.concat(partOrigin)
    }
    const inserted = (part: string) => Array.from<number | null>({ length: part.length }).fill(null)

    for (const block of this.output) {
      push(block.intro, inserted(block.intro))
      if (block.edited) {
        push(block.content, Array.from<number | null>({ length: block.content.length }).fill(block.start))
      }
      else {
        const origins: Array<number | null> = []
        for (let i = 0; i < block.content.length; i++)
          origins.push(block.start + i)
        push(block.content, origins)
      }
      push(block.outro, inserted(block.outro))
    }

    push(this.outro, inserted(this.outro))
    return { text, origin }
  }

  toString(): string {
    return this.render().text
  }

  private sourceLineStarts(): number[] {
    const starts = [0]
    for (let i = 0; i < this.source.length; i++) {
      if (this.source.charCodeAt(i) === NEWLINE_CHAR)
        starts.push(i + 1)
    }
    return starts
  }

  private setStoredNames(names: string[]): void {
    this.storedNames.length = 0
    this.storedNames.push(...names)
  }

  // Independent re-implementation of the library's emitted decoded mappings.
  expectedMappings(hires: Hires): { lines: FullSegment[][], names: string[] } {
    const lineStarts = this.sourceLineStarts()
    const locate = (index: number): { line: number, column: number } => {
      let line = lineStarts.length - 1
      while (lineStarts[line] > index)
        line -= 1
      return { line, column: index - lineStarts[line] }
    }

    const lines: FullSegment[][] = [[]]
    let genLine = 0
    let genColumn = 0

    const remember = (segment: FullSegment) => lines[genLine].push(segment)
    const nextLine = () => {
      genLine += 1
      genColumn = 0
      lines[genLine] = []
    }
    const advanceInserted = (text: string) => {
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === NEWLINE_CHAR)
          nextLine()
        else
          genColumn += 1
      }
    }
    const addEditSegments = (block: Block) => {
      const content = block.content
      if (!content)
        return
      const makeSegment = (): FullSegment => {
        const loc = locate(block.start)
        const nameIndex = block.storeName ? this.storedNames.indexOf(block.original) : -1
        return nameIndex >= 0
          ? [genColumn, 0, loc.line, loc.column, nameIndex]
          : [genColumn, 0, loc.line, loc.column]
      }
      const lastIndex = content.length - 1
      let previousLineEnd = -1
      let lineEnd = content.indexOf('\n', 0)
      while (lineEnd >= 0 && lastIndex > lineEnd) {
        remember(makeSegment())
        for (let k = 0; k < lineEnd - (previousLineEnd + 1); k++)
          genColumn += 1
        nextLine()
        previousLineEnd = lineEnd
        lineEnd = content.indexOf('\n', lineEnd + 1)
      }
      remember(makeSegment())
      advanceInserted(content.slice(previousLineEnd + 1))
    }
    const addUnedited = (block: Block) => {
      let { line, column } = locate(block.start)
      let i = block.start
      const end = block.end
      if (hires) {
        const boundary = hires === 'boundary'
        let inWordBoundary = false
        while (i < end) {
          const code = this.source.charCodeAt(i)
          if (code === NEWLINE_CHAR) {
            line += 1
            column = 0
            nextLine()
            inWordBoundary = false
          }
          else {
            if (boundary) {
              if (isWordCode(code)) {
                if (!inWordBoundary) {
                  remember([genColumn, 0, line, column])
                  inWordBoundary = true
                }
              }
              else {
                remember([genColumn, 0, line, column])
                inWordBoundary = false
              }
            }
            else {
              remember([genColumn, 0, line, column])
            }
            column += 1
            genColumn += 1
          }
          i += 1
        }
      }
      else {
        while (i < end) {
          let newline = this.source.indexOf('\n', i)
          if (newline === -1 || newline > end)
            newline = end
          if (newline > i) {
            remember([genColumn, 0, line, column])
            for (let index = i + 1; index < newline; index += 1) {
              if (this.sourcemapLocations.has(index)) {
                const at = locate(index)
                lines[genLine].push([genColumn + (index - i), 0, at.line, at.column])
              }
            }
            column += newline - i
            genColumn += newline - i
          }
          if (newline === end)
            break
          line += 1
          column = 0
          nextLine()
          i = newline + 1
        }
      }
    }

    advanceInserted(this.intro)
    for (const block of this.output) {
      advanceInserted(block.intro)
      if (block.edited)
        addEditSegments(block)
      else
        addUnedited(block)
      advanceInserted(block.outro)
    }
    advanceInserted(this.outro)

    return { lines, names: [...this.storedNames] }
  }

  clone(): ReferenceModel {
    const copy = new ReferenceModel(this.source)
    copy.blocks = this.blocks.map(block => ({ ...block }))
    copy.output = this.output.map(block => copy.blocks[this.blocks.indexOf(block)])
    copy.sourcemapLocations = new Set(this.sourcemapLocations)
    copy.intro = this.intro
    copy.outro = this.outro
    copy.setStoredNames([...this.storedNames])
    return copy
  }

  apply(op: Op): boolean {
    switch (op.type) {
      case 'appendLeft': return this.appendLeft(op.index, op.text)
      case 'prependLeft': return this.prependLeft(op.index, op.text)
      case 'appendRight': return this.appendRight(op.index, op.text)
      case 'prependRight': return this.prependRight(op.index, op.text)
      case 'append': return this.append(op.text)
      case 'prepend': return this.prepend(op.text)
      case 'overwrite': return this.overwrite(op.start, op.end, op.text, { storeName: op.storeName, contentOnly: op.contentOnly })
      case 'remove': return this.remove(op.start, op.end)
      case 'reset': return this.reset(op.start, op.end)
      case 'move': return this.move(op.start, op.end, op.index, op.affinity)
      case 'indent': return this.indent(op.indentStr, { exclude: op.exclude, indentStart: op.indentStart })
      case 'addSourcemapLocation': return this.addSourcemapLocation(op.index)
    }
  }
}

export type FullSegment = [number, number, number, number] | [number, number, number, number, number]

function isWordCode(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code === 95
}
