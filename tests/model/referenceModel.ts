// An independent model of MagicString's public editing contract.
//
// This file deliberately does not import `src/Chunk.ts` or walk the
// implementation's chunk list. Its vocabulary is the public surface
// (appendLeft/prependRight/overwrite/remove/move/indent/addSourcemapLocation/
// clone) plus three deliberately simple pieces of bookkeeping:
//
// - chunks are coordinate intervals [start, end) with an edit state;
// - an output order independent of original coordinates (move reorders it);
// - boundary insert lists (the "left" and "right" piles at every index).
//
// The model is able to answer two questions without ever looking at the real
// object it is compared against:
//   1. would this operation be legal under the documented contract?
//   2. what should toString() be, and which original index (if any) is the
//      provenance of every emitted character?

export interface ModelChunk {
  id: number
  start: number
  end: number
  edited: boolean
  content: string
  storeName: boolean
  /** raw string pieces inserted against this chunk's left/right sides */
  intro: string
  outro: string
}

let nextChunkId = 1

function cloneChunks(chunks: ModelChunk[]): ModelChunk[] {
  return chunks.map(chunk => ({ ...chunk }))
}

export class ReferenceModel {
  original: string
  intro = ''
  outro = ''
  boundary: number
  chunks: ModelChunk[]
  order: number[]
  locations: Set<number>
  names: string[]
  hasMovedChunks = false

  constructor(original: string) {
    this.original = original
    this.boundary = original.length
    this.chunks = [{
      id: nextChunkId++,
      start: 0,
      end: original.length,
      edited: false,
      content: original,
      storeName: false,
      intro: '',
      outro: '',
    }]
    this.order = [this.chunks[0].id]
    this.locations = new Set()
    this.names = []
  }

  clone(): ReferenceModel {
    const model = Object.create(ReferenceModel.prototype) as ReferenceModel
    model.original = this.original
    model.intro = this.intro
    model.outro = this.outro
    model.boundary = this.boundary
    model.chunks = cloneChunks(this.chunks)
    model.order = [...this.order]
    model.locations = new Set(this.locations)
    model.names = [...this.names]
    model.hasMovedChunks = this.hasMovedChunks
    return model
  }

  byId(id: number): ModelChunk {
    return this.chunks.find(chunk => chunk.id === id)!
  }

  /**
   * Chunks always partition [0, n), so at most one chunk starts (or ends) at
   * any given index - but the search is restricted to chunks present in the
   * output order, mirroring the implementation's live chunk maps.
   */
  byStart(index: number): ModelChunk | undefined {
    return this.chunks.find(chunk => this.order.includes(chunk.id) && chunk.start === index)
  }

  byEnd(index: number): ModelChunk | undefined {
    return this.chunks.find(chunk => this.order.includes(chunk.id) && chunk.end === index)
  }

  /** the chunk whose interior strictly contains `index` */
  containing(index: number): ModelChunk | undefined {
    return this.chunks.find(chunk => chunk.start < index && index < chunk.end)
  }

  /** a split point inside any edited chunk (even an emptied one) is rejected */
  splitLegal(index: number): boolean {
    const chunk = this.containing(index)
    return !chunk || !chunk.edited
  }

  split(index: number): void {
    if (this.byStart(index) || this.byEnd(index))
      return
    const chunk = this.containing(index)!
    const originalBefore = this.original.slice(chunk.start, index)
    const after: ModelChunk = {
      id: nextChunkId++,
      start: index,
      end: chunk.end,
      // splitting an empty edited range yields two empty edited fragments;
      // only unedited chunks keep their share of the original text
      edited: chunk.edited,
      content: chunk.edited ? '' : this.original.slice(index, chunk.end),
      storeName: false,
      intro: '',
      // the whole "left" pile crosses the cut with the right-hand fragment
      outro: chunk.outro,
    }
    chunk.end = index
    chunk.outro = ''
    chunk.storeName = false
    if (chunk.edited)
      chunk.content = ''
    else
      chunk.content = originalBefore

    this.chunks.push(after)
    const at = this.order.indexOf(chunk.id)
    this.order.splice(at + 1, 0, after.id)
  }

  canInsert(index: number): boolean {
    return index >= 0 && index <= this.original.length && this.splitLegal(index)
  }

  appendLeft(index: number, content: string): this {
    this.split(index)
    const chunk = this.byEnd(index)
    if (chunk) {
      chunk.outro += content
    }
    else {
      this.intro += content
    }
    return this
  }

  prependLeft(index: number, content: string): this {
    this.split(index)
    const chunk = this.byEnd(index)
    if (chunk) {
      chunk.outro = content + chunk.outro
    }
    else {
      this.intro = content + this.intro
    }
    return this
  }

  appendRight(index: number, content: string): this {
    this.split(index)
    const chunk = this.byStart(index)
    if (chunk) {
      chunk.intro = chunk.intro + content
    }
    else {
      this.outro += content
    }
    return this
  }

  prependRight(index: number, content: string): this {
    this.split(index)
    const chunk = this.byStart(index)
    if (chunk) {
      chunk.intro = content + chunk.intro
    }
    else {
      this.outro = content + this.outro
    }
    return this
  }

  /** chunks covering [start, end) in *output* order */
  run(start: number, end: number): ModelChunk[] {
    const ids = new Set<number>()
    for (const chunk of this.chunks) {
      if (chunk.start >= start && chunk.end <= end)
        ids.add(chunk.id)
    }
    return this.order.filter(id => ids.has(id)).map(id => this.byId(id))
  }

  /** the chunks covering [start, end), irrespective of output order */
  covering(start: number, end: number): ModelChunk[] {
    return this.chunks.filter(chunk => chunk.start >= start && chunk.end <= end)
  }

  /**
   * Endpoints may not split a non-empty edit, and the interval must be tiled
   * exactly by existing chunks.
   */
  tileLegal(start: number, end: number): boolean {
    if (start < 0 || end > this.original.length || start >= end)
      return false
    if (!this.splitLegal(start) || !this.splitLegal(end))
      return false
    const covering = this.covering(start, end)
    let total = 0
    for (const chunk of covering)
      total += chunk.end - chunk.start
    return total === end - start
  }

  /**
   * The chunks of the interval must also be a contiguous forward run in the
   * current output order, which overwrite and move require while remove walks
   * original order and does not.
   */
  contiguousRunLegal(start: number, end: number): boolean {
    if (!this.tileLegal(start, end))
      return false
    const covering = this.covering(start, end)
    // walk the chunks in output order (as the implementation follows next
    // pointers): all covering chunks must appear there as one adjacent,
    // forward run - adjacent in output order and increasing by coordinate
    const run = this.run(start, end)
    if (run.length !== covering.length)
      return false
    let previous: ModelChunk | null = null
    let previousPosition = -2
    for (const chunk of run) {
      const position = this.order.indexOf(chunk.id)
      if (previous) {
        if (position !== previousPosition + 1 || chunk.start !== previous.end)
          return false
      }
      previous = chunk
      previousPosition = position
    }
    return true
  }

  removeLegal(start: number, end: number): boolean {
    if (start === end)
      return true
    return this.tileLegal(start, end)
  }

  overwriteLegal(start: number, end: number): boolean {
    if (start === end)
      return false
    return this.contiguousRunLegal(start, end)
  }

  remove(start: number, end: number): void {
    if (start === end)
      return
    this.split(start)
    this.split(end)
    const run = this.covering(start, end)
    for (const chunk of run) {
      if (chunk.start > start)
        chunk.intro = ''
      if (chunk.end < end)
        chunk.outro = ''
      chunk.edited = true
      chunk.storeName = false
      chunk.content = ''
    }
  }

  overwrite(start: number, end: number, content: string, opts: { storeName?: boolean, contentOnly?: boolean } = {}): void {
    this.split(start)
    this.split(end)
    const run = this.run(start, end)
    const first = run[0]

    if (opts.storeName) {
      const name = this.original.slice(start, end)
      if (!this.names.includes(name))
        this.names.push(name)
    }

    // every chunk after the first is emptied together with its edge inserts
    for (let i = 1; i < run.length; i++) {
      const chunk = run[i]
      chunk.edited = true
      chunk.storeName = false
      chunk.content = ''
      chunk.intro = ''
      chunk.outro = ''
    }

    first.edited = true
    first.storeName = !!opts.storeName
    first.content = content
    // the first chunk keeps its own edge inserts only with contentOnly
    if (!opts.contentOnly) {
      first.intro = ''
      first.outro = ''
    }
  }

  moveLegal(start: number, end: number, index: number): boolean {
    if (start === end)
      return true
    if (index >= start && index <= end)
      return false
    return this.contiguousRunLegal(start, end) && this.splitLegal(index)
  }

  move(start: number, end: number, index: number, affinity: 'left' | 'right' = 'right'): void {
    if (start === end)
      return

    // splits at the range edges and destination happen before any run checks,
    // so inserts anchored at those boundaries stay with the anchor chunk and
    // are not carried along
    this.split(start)
    this.split(end)
    this.split(index)

    const run = this.run(start, end)
    const first = run[0]
    const last = run[run.length - 1]
    const ids = new Set(run.map(chunk => chunk.id))

    const anchor
      = affinity === 'left'
        ? (this.byEnd(index) ?? null)
        : (this.byStart(index) ?? null)

    // early no-op detection, measured in the current (pre-extraction) order
    if (affinity === 'left') {
      if (!anchor) {
        if (this.order[0] === first.id)
          return
      }
      else if (this.order.indexOf(anchor.id) + 1 === this.order.indexOf(first.id)) {
        return
      }
    }
    else {
      if (!anchor) {
        if (this.order[this.order.length - 1] === last.id)
          return
      }
      else if (this.order.indexOf(anchor.id) - 1 === this.order.indexOf(last.id)) {
        return
      }
    }

    this.order = this.order.filter(id => !ids.has(id))

    const insertAt = affinity === 'left'
      ? (anchor ? this.order.indexOf(anchor.id) + 1 : 0)
      : (anchor ? this.order.indexOf(anchor.id) : this.order.length)
    this.order.splice(insertAt, 0, ...ids)
    this.hasMovedChunks = true
  }

  addSourcemapLocation(index: number): this {
    this.locations.add(index)
    return this
  }

  indent(indentStr: string, options: { exclude?: Array<[number, number]>, indentStart?: boolean } = {}): void {
    if (indentStr === '')
      return
    const pattern = /^[^\r\n]/gm
    const isExcluded = new Set<number>()
    if (options.exclude) {
      for (const [start, end] of options.exclude) {
        for (let i = start; i < end; i++)
          isExcluded.add(i)
      }
    }
    let shouldIndentNextCharacter = options.indentStart !== false

    const indentPiece = (str: string): string => {
      if (str === '')
        return str
      const indented = str.replace(pattern, (match, offset: number) =>
        offset > 0 || shouldIndentNextCharacter ? `${indentStr}${match}` : match)
      shouldIndentNextCharacter = str[str.length - 1] === '\n'
      return indented
    }

    this.intro = indentPiece(this.intro)

    let charIndex = 0
    let pos = 0
    let chunk = this.byId(this.order[0])

    const indentAt = (index: number) => {
      shouldIndentNextCharacter = false

      if (index === chunk.start) {
        // appendRight: in front of the content, after any existing intro
        chunk.intro = chunk.intro + indentStr
      }
      else {
        this.split(index)
        pos += 1
        chunk = this.byId(this.order[pos])
        chunk.intro = indentStr + chunk.intro
      }
    }

    while (pos < this.order.length) {
      chunk = this.byId(this.order[pos])
      const end = chunk.end

      if (!isExcluded.has(chunk.start))
        chunk.intro = indentPiece(chunk.intro)

      if (chunk.edited) {
        if (!isExcluded.has(charIndex))
          chunk.content = indentPiece(chunk.content)
      }
      else if (options.exclude) {
        charIndex = chunk.start

        while (charIndex < end) {
          if (!isExcluded.has(charIndex)) {
            const code = this.original.charCodeAt(charIndex)
            if (code === 10) {
              shouldIndentNextCharacter = true
            }
            else if (code !== 13 && shouldIndentNextCharacter) {
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

          const code = this.original.charCodeAt(charIndex)

          if (code === 10 || code === 13) {
            charIndex += 1
            continue
          }

          indentAt(charIndex)
          charIndex += 1
        }
      }

      if (!isExcluded.has(chunk.end - 1))
        chunk.outro = indentPiece(chunk.outro)

      charIndex = chunk.end
      pos += 1
    }

    this.outro = indentPiece(this.outro)
  }
}
