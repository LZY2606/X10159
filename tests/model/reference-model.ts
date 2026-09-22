// Independent reference model for the model-based tests.
//
// It deliberately re-implements the *documented public contract* of
// magic-string with a tiny linked list of plain chunks plus a simple
// character-provenance model. It does NOT import or mirror the library's
// internal `Chunk`/`MagicString` machinery: the only shared ground is the
// observable semantics of `toString()` and decoded source maps.

export type Hires = boolean | 'boundary'

export type Op =
  | { type: 'appendLeft', index: number, text: string }
  | { type: 'prependRight', index: number, text: string }
  | { type: 'overwrite', start: number, end: number, text: string, storeName: boolean }
  | { type: 'remove', start: number, end: number }
  | { type: 'move', start: number, end: number, index: number, affinity: 'left' | 'right' }
  | { type: 'indent', indentStr: string }
  | { type: 'addSourcemapLocation', index: number }

interface ModelChunk {
  start: number
  end: number
  original: string
  content: string
  intro: string
  outro: string
  edited: boolean
  storeName: boolean
  previous: ModelChunk | null
  next: ModelChunk | null
}

type Segment = [number, number, number, number] | [number, number, number, number, number]

interface VirtualTile {
  start: number
  end: number
  next: VirtualTile | null
}

function isWordCode(code: number): boolean {
  return (code >= 97 && code <= 122)
    || (code >= 65 && code <= 90)
    || (code >= 48 && code <= 57)
    || code === 95
}

function makeChunk(start: number, end: number, original: string): ModelChunk {
  return {
    start,
    end,
    original,
    content: original,
    intro: '',
    outro: '',
    edited: false,
    storeName: false,
    previous: null,
    next: null,
  }
}

function cloneChunk(chunk: ModelChunk): ModelChunk {
  return {
    start: chunk.start,
    end: chunk.end,
    original: chunk.original,
    content: chunk.content,
    intro: chunk.intro,
    outro: chunk.outro,
    edited: chunk.edited,
    storeName: chunk.storeName,
    previous: null,
    next: null,
  }
}

export class ReferenceModel {
  original: string
  intro = ''
  outro = ''
  firstChunk: ModelChunk
  lastChunk: ModelChunk
  sourcemapLocations = new Set<number>()
  storedNames: string[] = []

  constructor(original: string) {
    this.original = original
    const chunk = makeChunk(0, original.length, original)
    this.firstChunk = chunk
    this.lastChunk = chunk
  }

  // ---------------------------------------------------------------- walks

  private chunkContaining(index: number): ModelChunk | null {
    let chunk = this.firstChunk
    while (chunk) {
      if (chunk.start < index && index < chunk.end)
        return chunk
      chunk = chunk.next!
    }
    return null
  }

  private findStart(index: number): ModelChunk | null {
    let chunk = this.firstChunk
    while (chunk) {
      if (chunk.start === index)
        return chunk
      chunk = chunk.next!
    }
    return null
  }

  private findEnd(index: number): ModelChunk | null {
    let chunk = this.firstChunk
    while (chunk) {
      if (chunk.end === index)
        return chunk
      chunk = chunk.next!
    }
    return null
  }

  // A split point at `index` is legal when there is already a boundary there,
  // or when the spanning chunk is unedited / edited-but-empty. This mirrors the
  // public error "cannot split a chunk that has already been edited".
  private canSplitAt(index: number): boolean {
    if (this.findStart(index) || this.findEnd(index))
      return true
    const chunk = this.chunkContaining(index)
    if (!chunk)
      return false
    return !chunk.edited || chunk.content.length === 0
  }

  private split(index: number): void {
    if (this.findStart(index) || this.findEnd(index))
      return
    const chunk = this.chunkContaining(index)!
    const sliceIndex = index - chunk.start
    const originalBefore = chunk.original.slice(0, sliceIndex)
    const originalAfter = chunk.original.slice(sliceIndex)

    chunk.original = originalBefore
    const newChunk = makeChunk(index, chunk.end, originalAfter)
    newChunk.outro = chunk.outro
    chunk.outro = ''
    chunk.end = index

    if (chunk.edited) {
      newChunk.edited = true
      newChunk.content = ''
      chunk.content = ''
    }
    else {
      chunk.content = originalBefore
    }

    newChunk.next = chunk.next
    if (newChunk.next)
      newChunk.next.previous = newChunk
    newChunk.previous = chunk
    chunk.next = newChunk

    if (chunk === this.lastChunk)
      this.lastChunk = newChunk
  }

  // ------------------------------------------------------------ queries

  /**
   * Whether `[start, end)` can currently be overwritten. After virtual
   * splits at the two edges, the chunks covering the range must be a forward
   * run in the current output order (the "cannot overwrite across a split
   * point" contract).
   */
  canOverwrite(start: number, end: number): boolean {
    if (start < 0 || end > this.original.length || start >= end)
      return false
    if (!this.canSplitAt(start) || !this.canSplitAt(end))
      return false
    const tiles = this.virtualTiles([start, end])
    let cursor: VirtualTile = tiles.get(start)!
    while (cursor.end !== end) {
      const next = cursor.next
      if (!next || next.start !== cursor.end)
        return false
      cursor = next
    }
    return true
  }

  canMove(start: number, end: number, index: number): boolean {
    if (start === end)
      return true
    if (index >= start && index <= end)
      return false
    if (!this.canSplitAt(start) || !this.canSplitAt(end) || !this.canSplitAt(index))
      return false
    const tiles = this.virtualTiles([start, end])
    let cursor: VirtualTile = tiles.get(start)!
    while (cursor.end !== end) {
      const next = cursor.next
      if (!next || next.start !== cursor.end)
        return false
      cursor = next
    }
    return true
  }

  canRemove(start: number, end: number): boolean {
    if (start === end)
      return true
    if (start < 0 || end > this.original.length || start > end)
      return false
    return this.canSplitAt(start) && this.canSplitAt(end)
  }

  canInsertAt(index: number): boolean {
    return index >= 0 && index <= this.original.length && this.canSplitAt(index)
  }

  /**
   * Lightweight projection of the chunk list as if splits at `points`
   * existed. Tiles are emitted in *output* order (chunks may be moved) and
   * linked to their output-order successor. No model state is mutated.
   */
  private virtualTiles(points: number[]): Map<number, VirtualTile> {
    const cuts = new Set(points)
    const tiles: VirtualTile[] = []
    let chunk = this.firstChunk
    while (chunk) {
      let from = chunk.start
      const inner = [...cuts].filter(p => p > chunk.start && p < chunk.end).sort((a, b) => a - b)
      for (const cut of inner) {
        tiles.push({ start: from, end: cut })
        from = cut
      }
      tiles.push({ start: from, end: chunk.end })
      chunk = chunk.next!
    }
    for (let i = 0; i < tiles.length - 1; i += 1)
      tiles[i].next = tiles[i + 1]
    return new Map(tiles.map(t => [t.start, t]))
  }
  // ------------------------------------------------------------ edits

  private storeNameForRange(start: number, end: number): void {
    const name = this.original.slice(start, end)
    if (!this.storedNames.includes(name))
      this.storedNames.push(name)
  }

  apply(op: Op): void {
    switch (op.type) {
      case 'appendLeft': {
        const { index, text } = op
        this.split(index)
        const chunk = this.findEnd(index)
        if (chunk)
          chunk.outro += text
        else
          this.intro += text
        break
      }
      case 'prependRight': {
        const { index, text } = op
        this.split(index)
        const chunk = this.findStart(index)
        if (chunk)
          chunk.intro = text + chunk.intro
        else
          this.outro = text + this.outro
        break
      }
      case 'overwrite': {
        const { start, end, text, storeName } = op
        this.split(start)
        this.split(end)
        if (storeName)
          this.storeNameForRange(start, end)
        const first = this.findStart(start)!
        const last = this.findEnd(end)!
        let chunk: ModelChunk | null = first
        while (chunk && chunk !== last) {
          chunk = chunk.next
          chunk!.edited = true
          chunk!.content = ''
          chunk!.intro = ''
          chunk!.outro = ''
          chunk!.storeName = false
        }
        first.edited = true
        first.content = text
        first.intro = ''
        first.outro = ''
        first.storeName = storeName
        break
      }
      case 'remove': {
        const { start, end } = op
        if (start === end)
          break
        this.split(start)
        this.split(end)
        let chunk: ModelChunk | null = this.findStart(start)
        while (chunk) {
          if (chunk.start > start)
            chunk.intro = ''
          if (chunk.end < end)
            chunk.outro = ''
          chunk.edited = true
          chunk.content = ''
          chunk.storeName = false
          chunk = end > chunk.end ? this.findStart(chunk.end) : null
        }
        break
      }
      case 'move': {
        const { start, end, index, affinity } = op
        this.move(start, end, index, affinity)
        break
      }
      case 'indent': {
        this.indent(op.indentStr)
        break
      }
      case 'addSourcemapLocation': {
        this.sourcemapLocations.add(op.index)
        break
      }
    }
  }

  private move(start: number, end: number, index: number, affinity: 'left' | 'right'): void {
    if (start === end)
      return

    if (index >= start && index <= end)
      throw new Error('cannot move a selection inside itself')

    this.split(start)
    this.split(end)
    this.split(index)

    const first = this.findStart(start)!
    const last = this.findEnd(end)!

    let cursor: ModelChunk | null = first
    while (cursor !== last) {
      cursor = cursor.next
      if (!cursor || cursor.start < start || cursor.end > end)
        throw new Error('cannot move because an earlier move split that range')
    }

    const oldLeft = first.previous
    const oldRight = last.next

    let newLeft: ModelChunk | null
    let newRight: ModelChunk | null
    if (affinity === 'left') {
      newLeft = this.findEnd(index)
      if (!newLeft) {
        if (first === this.firstChunk)
          return
        newRight = this.firstChunk
      }
      else {
        if (newLeft.next === first)
          return
        newRight = newLeft.next
      }
    }
    else {
      newRight = this.findStart(index)
      if (!newRight) {
        if (last === this.lastChunk)
          return
        newLeft = this.lastChunk
      }
      else {
        if (newRight.previous === last)
          return
        newLeft = newRight.previous
      }
    }

    if (oldLeft)
      oldLeft.next = oldRight
    if (oldRight)
      oldRight.previous = oldLeft

    if (newLeft)
      newLeft.next = first
    if (newRight)
      newRight.previous = last

    if (!first.previous)
      this.firstChunk = last.next!
    if (!last.next) {
      this.lastChunk = first.previous!
      this.lastChunk.next = null
    }

    first.previous = newLeft
    last.next = newRight || null

    if (!newLeft)
      this.firstChunk = first
    if (!newRight)
      this.lastChunk = last
  }

  // ------------------------------------------------------------- indent

  indent(indentStr: string, excludeRanges: Array<[number, number]> = []): void {
    if (indentStr === '')
      return

    const pattern = /^[^\r\n]/gm
    const isExcluded: Record<number, boolean> = {}
    for (const [rangeStart, rangeEnd] of excludeRanges) {
      for (let i = rangeStart; i < rangeEnd; i += 1)
        isExcluded[i] = true
    }

    let shouldIndentNextCharacter = true
    const indentPiece = (str: string): string => {
      if (str === '')
        return str
      const indented = str.replace(pattern, (_match: string, offset: number) =>
        offset > 0 || shouldIndentNextCharacter ? `${indentStr}${_match}` : _match)
      shouldIndentNextCharacter = str[str.length - 1] === '\n'
      return indented
    }

    this.intro = indentPiece(this.intro)

    let chunk = this.firstChunk
    const self = this
    function indentAt(index: number) {
      shouldIndentNextCharacter = false
      if (index === chunk!.start) {
        // appendRight rather than prependRight: the indent lands directly in
        // front of the content, behind an already-indented intro
        chunk!.intro = chunk!.intro + indentStr
      }
      else {
        self.split(index)
        chunk = chunk!.next!
        chunk.intro = indentStr + chunk.intro
      }
    }

    let charIndex = 0
    while (chunk) {
      const end = chunk.end

      if (!isExcluded[chunk.start])
        chunk.intro = indentPiece(chunk.intro)

      if (chunk.edited) {
        if (!isExcluded[charIndex])
          chunk.content = indentPiece(chunk.content)
      }
      else if (excludeRanges.length) {
        charIndex = chunk.start
        while (charIndex < end) {
          if (!isExcluded[charIndex]) {
            const char = this.original.charCodeAt(charIndex)
            if (char === 10) {
              shouldIndentNextCharacter = true
            }
            else if (char !== 13 && shouldIndentNextCharacter) {
              indentAt(charIndex)
            }
          }
          charIndex += 1
        }
      }
      else {
        charIndex = chunk.start
        while (charIndex < end) {
          if (!shouldIndentNextCharacter) {
            const nextLine = this.original.indexOf('\n', charIndex)
            if (nextLine === -1 || nextLine >= end)
              break
            shouldIndentNextCharacter = true
            charIndex = nextLine + 1
            continue
          }
          const char = this.original.charCodeAt(charIndex)
          if (char === 10 || char === 13) {
            charIndex += 1
            continue
          }
          indentAt(charIndex)
          charIndex += 1
        }
      }

      if (!isExcluded[chunk.end - 1])
        chunk.outro = indentPiece(chunk.outro)

      charIndex = chunk.end
      chunk = chunk.next!
    }

    this.outro = indentPiece(this.outro)
  }


  // ----------------------------------------------------------- toString

  toString(): string {
    let str = this.intro
    let chunk: ModelChunk | null = this.firstChunk
    while (chunk) {
      str += chunk.intro + chunk.content + chunk.outro
      chunk = chunk.next
    }
    return str + this.outro
  }

  // ------------------------------------------------------------- clone

  clone(): ReferenceModel {
    const cloned = new ReferenceModel(this.original)
    cloned.intro = this.intro
    cloned.outro = this.outro
    cloned.sourcemapLocations = new Set(this.sourcemapLocations)
    cloned.storedNames = [...this.storedNames]

    const map = new Map<ModelChunk, ModelChunk>()
    let originalChunk: ModelChunk | null = this.firstChunk
    while (originalChunk) {
      map.set(originalChunk, cloneChunk(originalChunk))
      originalChunk = originalChunk.next
    }
    let first: ModelChunk | null = null
    originalChunk = this.firstChunk
    while (originalChunk) {
      const copy = map.get(originalChunk)!
      copy.previous = originalChunk.previous ? map.get(originalChunk.previous)! : null
      copy.next = originalChunk.next ? map.get(originalChunk.next)! : null
      if (!first)
        first = copy
      originalChunk = originalChunk.next
    }
    cloned.firstChunk = first!
    cloned.lastChunk = map.get(this.lastChunk)!
    return cloned
  }

  // ------------------------------------------------------ source maps

  generateDecodedMap(hires: Hires = false): {
    mappings: Segment[][]
    names: string[]
  } {
    const lineOffsets = [0]
    for (let i = 0; i < this.original.length; i += 1) {
      if (this.original.charCodeAt(i) === 10)
        lineOffsets.push(i + 1)
    }
    const locate = (index: number): { line: number, column: number } => {
      let line = 0
      while (line + 1 < lineOffsets.length && lineOffsets[line + 1] <= index)
        line += 1
      return { line, column: index - lineOffsets[line] }
    }

    const lines: Segment[][] = [[]]
    let generatedCodeLine = 0
    let generatedCodeColumn = 0
    let rawSegments = lines[0]

    const nextLine = () => {
      generatedCodeLine += 1
      generatedCodeColumn = 0
      rawSegments = lines[generatedCodeLine] = []
    }
    const advance = (str: string) => {
      if (!str)
        return
      for (let i = str.indexOf('\n'); i !== -1; i = str.indexOf('\n', i + 1))
        nextLine()
      const lastNewline = str.lastIndexOf('\n')
      generatedCodeColumn += str.length - lastNewline - 1
    }
    const pushSegment = (loc: { line: number, column: number }, nameIndex = -1) => {
      const segment = nameIndex >= 0
        ? [generatedCodeColumn, 0, loc.line, loc.column, nameIndex] as Segment
        : [generatedCodeColumn, 0, loc.line, loc.column] as Segment
      rawSegments.push(segment)
    }
    const addEdit = (content: string, loc: { line: number, column: number }, nameIndex: number) => {
      if (!content.length)
        return
      let contentLineEnd = content.indexOf('\n', 0)
      let previousContentLineEnd = -1
      const contentLengthMinusOne = content.length - 1
      while (contentLineEnd >= 0 && contentLengthMinusOne > contentLineEnd) {
        pushSegment(loc, nameIndex)
        nextLine()
        previousContentLineEnd = contentLineEnd
        contentLineEnd = content.indexOf('\n', contentLineEnd + 1)
      }
      pushSegment(loc, nameIndex)
      advance(content.slice(previousContentLineEnd + 1))
    }
    const addUneditedChunk = (chunk: ModelChunk) => {
      let i = chunk.start
      const end = chunk.end
      let loc = locate(i)
      if (hires === true || hires === 'boundary') {
        const boundary = hires === 'boundary'
        let charInHiresBoundary = false
        while (i < end) {
          const code = this.original.charCodeAt(i)
          if (code === 10) {
            loc = { line: loc.line + 1, column: 0 }
            nextLine()
            charInHiresBoundary = false
          }
          else {
            if (boundary) {
              if (isWordCode(code)) {
                if (!charInHiresBoundary) {
                  pushSegment(loc)
                  charInHiresBoundary = true
                }
              }
              else {
                pushSegment(loc)
                charInHiresBoundary = false
              }
            }
            else {
              pushSegment(loc)
            }
            loc = { line: loc.line, column: loc.column + 1 }
            generatedCodeColumn += 1
          }
          i += 1
        }
      }
      else {
        const marked = this.sourcemapLocations
        while (i < end) {
          let newline = this.original.indexOf('\n', i)
          if (newline === -1 || newline > end)
            newline = end
          if (newline > i) {
            pushSegment(loc)
            for (let index = i + 1; index < newline; index += 1) {
              if (marked.has(index)) {
                const markedLoc = locate(index)
                rawSegments.push([
                  generatedCodeColumn + (index - i),
                  0,
                  markedLoc.line,
                  markedLoc.column,
                ])
              }
            }
            loc = { line: loc.line, column: loc.column + newline - i }
            generatedCodeColumn += newline - i
          }
          if (newline === end)
            break
          loc = { line: loc.line + 1, column: 0 }
          nextLine()
          i = newline + 1
        }
      }
    }

    advance(this.intro)
    let chunk: ModelChunk | null = this.firstChunk
    while (chunk) {
      const loc = locate(chunk.start)
      advance(chunk.intro)
      if (chunk.edited) {
        const nameIndex = chunk.storeName ? this.storedNames.indexOf(chunk.original) : -1
        addEdit(chunk.content, loc, nameIndex)
      }
      else {
        addUneditedChunk(chunk)
      }
      advance(chunk.outro)
      chunk = chunk.next
    }
    advance(this.outro)

    return { mappings: lines, names: [...this.storedNames] }
  }

  // ------------------------------------------------------ provenance

  /**
   * Produces, for each line of the generated output, an entry per column:
   *  - { kind: 'orig', index }: an unedited original char (may have moved)
   *  - { kind: 'edit', start, end, name }: a char emitted by an overwrite; it
   *    maps back to the start of the chunk's original range
   *  - { kind: 'insert' }: a char with no source (insertions / intros / outros)
   */
  provenance(): ProvenanceEntry[][] {
    const lines: ProvenanceEntry[][] = [[]]
    let line = lines[0]
    const emit = (text: string, entry: ProvenanceEntry) => {
      for (const char of text) {
        if (char === '\n') {
          line = []
          lines.push(line)
        }
        else {
          line.push(entry)
        }
      }
    }
    emit(this.intro, { kind: 'insert' })
    let chunk: ModelChunk | null = this.firstChunk
    while (chunk) {
      emit(chunk.intro, { kind: 'insert' })
      if (chunk.edited) {
        const nameIndex = chunk.storeName ? this.storedNames.indexOf(chunk.original) : -1
        emit(chunk.content, {
          kind: 'edit',
          start: chunk.start,
          end: chunk.end,
          name: nameIndex,
        })
      }
      else {
        for (let i = chunk.start; i < chunk.end; i += 1)
          emit(this.original[i], { kind: 'orig', index: i })
      }
      emit(chunk.outro, { kind: 'insert' })
      chunk = chunk.next
    }
    emit(this.outro, { kind: 'insert' })
    return lines
  }
}

export type ProvenanceEntry =
  | { kind: 'insert' }
  | { kind: 'orig', index: number }
  | { kind: 'edit', start: number, end: number, name: number }
