// Independent character-provenance model for MagicString.
//
// It deliberately does not mirror the library's internal Chunk linked list: the
// state is described as a small set of source "cells" (ranges of the original
// string) plus provenance for every generated character, and the emitted token
// stream is derived from the public contract of appendLeft/prependRight/
// overwrite/remove/move/indent. Both `toString()` and the decoded sourcemap are
// then derived from that token stream.

export type HiresMode = boolean | 'boundary'

export type Op =
  | { kind: 'appendLeft', index: number, text: string }
  | { kind: 'prependRight', index: number, text: string }
  | { kind: 'overwrite', start: number, end: number, text: string, storeName: boolean, contentOnly: boolean }
  | { kind: 'remove', start: number, end: number }
  | { kind: 'move', start: number, end: number, index: number, affinity: 'left' | 'right' }
  | { kind: 'indent', indentStr: string, exclude?: [number, number][] }
  | { kind: 'addSourcemapLocation', index: number }
  | { kind: 'clone' }

export type Segment = number[]

export interface DecodedMapLike {
  sources: string[]
  sourcesContent: Array<string | null> | undefined
  names: string[]
  mappings: Segment[][]
}

interface Cell {
  start: number
  end: number
  intro: string
  outro: string
  content: string
  edited: boolean
  storeName: boolean
  nameAnchor: string
  previous: Cell | null
  next: Cell | null
}

/** Deterministic PRNG (mulberry32) so every generated sequence is reproducible. */
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

  int(below: number): number {
    return Math.floor(this.next() * below)
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]
  }
}

function guessIndent(code: string): string | null {
  const lines = code.split('\n')
  const tabbed = lines.filter(line => /^\t+/.test(line))
  const spaced = lines.filter(line => /^ {2,}/.test(line))
  if (tabbed.length === 0 && spaced.length === 0)
    return null
  if (tabbed.length >= spaced.length)
    return '\t'
  const min = spaced.reduce((previous, current) => {
    const numSpaces = /^ +/.exec(current)![0].length
    return Math.min(numSpaces, previous)
  }, Number.POSITIVE_INFINITY)
  return ' '.repeat(min)
}

const NEWLINE = 10
const CR = 13

function isWordCode(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code === 95
}

export class CharModel {
  original: string
  intro = ''
  outro = ''
  locations = new Set<number>()
  storedNames: string[] = []
  private first: Cell
  private last: Cell
  private hasMoved = false

  constructor(original: string) {
    this.original = original
    const cell: Cell = {
      start: 0,
      end: original.length,
      intro: '',
      outro: '',
      content: original,
      edited: false,
      storeName: false,
      nameAnchor: original,
      previous: null,
      next: null,
    }
    this.first = this.last = cell
  }

  private byStart(index: number): Cell | null {
    let cell = this.first
    while (cell) {
      if (cell.start === index)
        return cell
      cell = cell.next
    }
    return null
  }

  private byEnd(index: number): Cell | null {
    let cell = this.first
    while (cell) {
      if (cell.end === index)
        return cell
      cell = cell.next
    }
    return null
  }

  private containing(index: number): Cell | null {
    let cell = this.first
    while (cell) {
      if (cell.start < index && index < cell.end)
        return cell
      cell = cell.next
    }
    return null
  }

  /** Splitting a non-empty edited cell is the one illegal split. */
  private hardCellAt(index: number): Cell | null {
    const cell = this.containing(index)
    return cell && cell.edited && cell.content.length > 0 ? cell : null
  }

  private split(index: number): void {
    if (this.byStart(index) || this.byEnd(index))
      return
    const cell = this.containing(index)
    if (!cell)
      return
    const edited = cell.edited
    const left: Cell = {
      start: cell.start,
      end: index,
      intro: edited ? '' : cell.intro,
      outro: '',
      content: '',
      edited,
      storeName: false,
      nameAnchor: '',
      previous: cell.previous,
      next: null,
    }
    const right: Cell = {
      start: index,
      end: cell.end,
      intro: '',
      outro: edited ? '' : cell.outro,
      content: '',
      edited,
      storeName: false,
      nameAnchor: '',
      previous: null,
      next: cell.next,
    }
    if (edited) {
      // zero-length edited cells may be split; the replacement lives on the
      // left-hand cell and every trailing insert is dropped by the split
      left.storeName = cell.storeName
      left.nameAnchor = cell.nameAnchor
    }
    else {
      left.content = this.original.slice(left.start, left.end)
      right.content = this.original.slice(right.start, right.end)
      left.nameAnchor = left.content
      right.nameAnchor = right.content
    }
    if (left.previous)
      left.previous.next = left
    if (right.next)
      right.next.previous = right
    left.next = right
    right.previous = left
    if (cell === this.first)
      this.first = left
    if (cell === this.last)
      this.last = right
  }

  appendLeft(index: number, text: string): void {
    const cell = this.byEnd(index)
    if (cell)
      cell.outro += text
    else
      this.intro += text
  }

  prependRight(index: number, text: string): void {
    const cell = this.byStart(index)
    if (cell)
      cell.intro = cell.intro + text
    else
      this.outro = text + this.outro
  }

  prependLeft(index: number, text: string): void {
    const cell = this.byEnd(index)
    if (cell)
      cell.outro = text + cell.outro
    else
      this.intro = text + this.intro
  }

  appendRight(index: number, text: string): void {
    const cell = this.byStart(index)
    if (cell)
      cell.intro += text
    else
      this.outro += text
  }

  private rangeCells(start: number, end: number): Cell[] {
    const cells: Cell[] = []
    let cell = this.byStart(start)
    while (cell && cell.start < end) {
      cells.push(cell)
      cell = this.nextIndexCell(cell)
    }
    return cells
  }

  /** The cell whose source range starts where this one ends, or null. */
  private nextIndexCell(cell: Cell): Cell | null {
    let candidate = this.first
    let result: Cell | null = null
    while (candidate) {
      if (candidate.start === cell.end)
        result = candidate
      candidate = candidate.next
    }
    return result
  }

  private coveringCell(pos: number, edge: 'start' | 'end'): Cell | null {
    let cell = this.first
    while (cell) {
      const atStart = cell.start === pos
      const atEnd = cell.end === pos
      const contains = cell.start < pos && pos < cell.end
      if ((edge === 'start' && (atStart || contains)) || (edge === 'end' && (atEnd || contains)))
        return cell
      cell = cell.next
    }
    return null
  }

  /**
   * Walks the list run that would cover [start, end) once the two boundary
   * cells had been split. The run is editable only when every list step is also
   * an index-space step, i.e. a move has not interleaved it with another cell.
   */
  private rangeRun(start: number, end: number): boolean {
    const first = this.coveringCell(start, 'start')
    const last = this.coveringCell(end, 'end')
    if (!first || !last || first.end <= start || last.start >= end)
      return false

    let pos = start
    let cell: Cell | null = first
    while (cell) {
      if (cell !== first && cell.start !== pos)
        return false
      if (cell.start < start || cell.end > end)
        return false
      if (cell === last)
        return cell.end >= end
      if (cell.end >= end)
        return false
      pos = cell.end
      cell = cell.next
    }
    return false
  }

  private isContiguous(start: number, end: number): boolean {
    return this.rangeRun(start, end)
  }

  overwrite(start: number, end: number, text: string, opts: { storeName?: boolean, contentOnly?: boolean } = {}): void {
    const storeName = opts.storeName ?? false
    const overwrite = !opts.contentOnly
    if (storeName && !this.storedNames.includes(this.original.slice(start, end)))
      this.storedNames.push(this.original.slice(start, end))

    const first = this.byStart(start)!
    const last = this.byEnd(end)!
    let cell: Cell | null = first
    while (cell && cell !== last) {
      cell.content = ''
      if (overwrite) {
        cell.intro = ''
        cell.outro = ''
      }
      cell.edited = true
      cell.storeName = false
      cell.nameAnchor = ''
      cell = this.nextIndexCell(cell)
    }
    first.content = text
    if (overwrite)
      first.outro = ''
    first.edited = true
    first.storeName = storeName
    first.nameAnchor = this.original.slice(start, end)
  }

  remove(start: number, end: number): void {
    let cell = this.byStart(start)
    while (cell && cell.start < end) {
      if (cell.start > start)
        cell.intro = ''
      if (cell.end < end)
        cell.outro = ''
      cell.content = ''
      cell.edited = true
      cell.storeName = false
      cell.nameAnchor = ''
      cell = this.nextIndexCell(cell)
    }
  }

  move(start: number, end: number, index: number, affinity: 'left' | 'right' = 'right'): void {
    if (start === end)
      return

    const first = this.byStart(start)!
    const last = this.byEnd(end)!

    let cursor: Cell | null = first
    while (cursor && cursor !== last) {
      cursor = cursor.next
      if (!cursor || cursor.start < start || cursor.end > end)
        throw new Error('cannot move range split by an earlier move')
    }

    const oldLeft = first.previous
    const oldRight = last.next

    let newLeft: Cell | null
    let newRight: Cell | null
    if (affinity === 'left') {
      newLeft = this.byEnd(index)
      if (!newLeft) {
        if (first === this.first)
          return
        newRight = this.first
      }
      else {
        if (newLeft.next === first)
          return
        newRight = newLeft.next
      }
    }
    else {
      newRight = this.byStart(index)
      if (!newRight) {
        if (last === this.last)
          return
        newLeft = this.last
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
      this.first = last.next
    if (!last.next) {
      this.last = first.previous!
      this.last.next = null
    }

    first.previous = newLeft
    last.next = newRight
    if (!newLeft)
      this.first = first
    if (!newRight)
      this.last = last

    this.hasMoved = true
  }

  addSourcemapLocation(index: number): void {
    this.locations.add(index)
  }

  /** Whether an operation boundary may be split at in the current state. */
  canSplitAt(index: number): boolean {
    return !this.hardCellAt(index)
  }

  /** Validates the same preconditions the public API enforces; returns the error message otherwise. */
  legalityError(op: Op): string | null {
    switch (op.kind) {
      case 'appendLeft':
      case 'prependRight':
        if (!this.canSplitAt(op.index))
          return 'cannot split a chunk that has already been edited'
        return null
      case 'overwrite':
        if (op.start === op.end)
          return 'cannot overwrite a zero-length range'
        if (op.start < 0 || op.end > this.original.length || op.start > op.end)
          return 'overwrite range out of bounds'
        if (this.hardCellAt(op.start) || this.hardCellAt(op.end))
          return 'cannot split a chunk that has already been edited'
        if (!this.isContiguous(op.start, op.end))
          return 'cannot overwrite across a split point'
        return null
      case 'remove':
        if (op.start === op.end)
          return null
        if (op.start < 0 || op.end > this.original.length || op.start > op.end)
          return 'remove range out of bounds'
        if (this.hardCellAt(op.start) || this.hardCellAt(op.end))
          return 'cannot split a chunk that has already been edited'
        return null
      case 'move':
        if (op.start === op.end)
          return null
        if (op.index >= op.start && op.index <= op.end)
          return 'cannot move a selection inside itself'
        if (this.hardCellAt(op.start) || this.hardCellAt(op.end) || this.hardCellAt(op.index))
          return 'cannot split a chunk that has already been edited'
        if (!this.rangeRun(op.start, op.end))
          return 'cannot move a range split by an earlier move'
        return null
      case 'indent':
      case 'addSourcemapLocation':
      case 'clone':
        return null
    }
  }

  /** Splits every boundary an operation touches before applying it. */
  prepare(op: Op): void {
    if (op.kind === 'appendLeft' || op.kind === 'prependRight')
      this.split(op.index)
    else if (op.kind === 'overwrite' || op.kind === 'remove')
      (this.split(op.start), this.split(op.end))
    else if (op.kind === 'move')
      (this.split(op.start), this.split(op.end), this.split(op.index))
  }

  apply(op: Op): void {
    switch (op.kind) {
      case 'appendLeft':
        this.prepare(op)
        this.appendLeft(op.index, op.text)
        break
      case 'prependRight':
        this.prepare(op)
        this.prependRight(op.index, op.text)
        break
      case 'overwrite':
        this.prepare(op)
        this.overwrite(op.start, op.end, op.text, { storeName: op.storeName, contentOnly: op.contentOnly })
        break
      case 'remove':
        this.prepare(op)
        this.remove(op.start, op.end)
        break
      case 'move':
        this.prepare(op)
        this.move(op.start, op.end, op.index, op.affinity)
        break
      case 'indent':
        this.indent(op.indentStr, op.exclude)
        break
      case 'addSourcemapLocation':
        this.addSourcemapLocation(op.index)
        break
      case 'clone':
        break
    }
  }

  indent(indentStr: string, excludeRanges?: [number, number][]): void {
    if (indentStr === '')
      return
    if (indentStr === '__guess__')
      indentStr = guessIndent(this.original) || '\t'

    const isExcluded: Record<number, boolean> = {}
    for (const [exStart, exEnd] of excludeRanges ?? []) {
      for (let i = exStart; i < exEnd; i += 1)
        isExcluded[i] = true
    }

    const pattern = /^[^\r\n]/gm
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

    let charIndex = 0
    let chunk = this.first

    while (chunk) {
      const end = chunk.end

      const indentAt = (index: number) => {
        shouldIndentNextCharacter = false
        if (index === chunk!.start) {
          // appendRight semantics: directly before the content, before older intros
          chunk!.intro = chunk!.intro + indentStr
        }
        else {
          this.split(index)
          chunk = this.byStart(index)!
          chunk.intro = indentStr + chunk.intro
        }
      }

      if (!isExcluded[chunk.start])
        chunk.intro = indentPiece(chunk.intro)

      if (chunk.edited) {
        if (!isExcluded[charIndex])
          chunk.content = indentPiece(chunk.content)
      }
      else if (excludeRanges) {
        charIndex = chunk.start
        while (charIndex < end) {
          if (!isExcluded[charIndex]) {
            const code = this.original.charCodeAt(charIndex)
            if (code === NEWLINE) {
              shouldIndentNextCharacter = true
            }
            else if (code !== CR && shouldIndentNextCharacter) {
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
          if (code === NEWLINE || code === CR) {
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
      chunk = chunk.next
    }

    this.outro = indentPiece(this.outro)
  }

  private emittedCells(): Cell[] {
    const cells: Cell[] = []
    let cell: Cell | null = this.first
    while (cell) {
      cells.push(cell)
      cell = cell.next
    }
    return cells
  }

  toString(): string {
    let str = this.intro
    for (const cell of this.emittedCells())
      str += cell.intro + cell.content + cell.outro
    return str + this.outro
  }

  clone(): CharModel {
    const copy = Object.create(CharModel.prototype) as CharModel
    Object.assign(copy, this)
    copy.locations = new Set(this.locations)
    copy.storedNames = this.storedNames.slice()
    const map = new Map<Cell, Cell>()
    for (const cell of this.emittedCells())
      map.set(cell, { ...cell })
    for (const [old, fresh] of map) {
      fresh.previous = old.previous ? map.get(old.previous)! : null
      fresh.next = old.next ? map.get(old.next)! : null
    }
    copy.first = map.get(this.first)!
    copy.last = map.get(this.last)!
    return copy
  }

  /**
   * Builds the decoded mappings from emitted provenance. Each emitted character
   * is either:
   *  - an unedited original code unit, mapping to its own source index;
   *  - edited content (from overwrite), mapping to the start of its cell and,
   *    when `storeName` was set, carrying the stored name;
   *  - inserted content (intros/outros/string-level pieces), mapping nowhere.
   */
  decodedMap(hires: HiresMode): DecodedMapLike {
    const lines: Segment[][] = [[]]
    let genLine = 0
    let genColumn = 0
    let boundaryInWord = false

    const loc = (index: number): [number, number] => {
      let line = 0
      let column = index
      for (let i = 0; i < index; i += 1) {
        if (this.original.charCodeAt(i) === NEWLINE) {
          line += 1
          column = index - i - 1
        }
      }
      return [line, column]
    }

    const newLine = () => {
      genLine += 1
      genColumn = 0
      lines[genLine] = []
      boundaryInWord = false
    }

    const advance = (text: string) => {
      for (let i = 0; i < text.length; i += 1) {
        if (text.charCodeAt(i) === NEWLINE)
          newLine()
        else
          genColumn += 1
      }
    }

    const pushSegment = (srcLine: number, srcColumn: number, nameIndex: number) => {
      const segment: Segment = [genColumn, 0, srcLine, srcColumn]
      if (nameIndex >= 0)
        segment.push(nameIndex)
      lines[genLine].push(segment)
    }

    const emitEdited = (cell: Cell) => {
      const text = cell.content
      if (!text.length)
        return
      const [srcLine, srcColumn] = loc(cell.start)
      const nameIndex = cell.storeName ? this.storedNames.indexOf(cell.nameAnchor) : -1
      let lineStart = 0
      for (let i = 0; i < text.length; i += 1) {
        if (text.charCodeAt(i) === NEWLINE) {
          pushSegment(srcLine, srcColumn, nameIndex)
          newLine()
          lineStart = i + 1
        }
      }
      pushSegment(srcLine, srcColumn, nameIndex)
      advance(text.slice(lineStart))
    }

    const emitUnedited = (cell: Cell) => {
      const end = cell.end
      let srcLine = 0
      let srcColumn = 0
      ;[srcLine, srcColumn] = loc(cell.start)
      for (let i = cell.start; i < end; i += 1) {
        const code = this.original.charCodeAt(i)
        if (code === NEWLINE) {
          srcLine += 1
          srcColumn = 0
          newLine()
        }
        else {
          if (hires === true) {
            pushSegment(srcLine, srcColumn, -1)
          }
          else if (hires === 'boundary') {
            if (isWordCode(code)) {
              if (!boundaryInWord) {
                pushSegment(srcLine, srcColumn, -1)
                boundaryInWord = true
              }
            }
            else {
              pushSegment(srcLine, srcColumn, -1)
              boundaryInWord = false
            }
          }
          else {
            // lo-res: one segment per source line at its first emitted char,
            // plus any explicitly registered locations
            if (i === cell.start || srcColumn === 0) {
              if (i === cell.start) {
                const [l, c] = loc(i)
                pushSegment(l, c, -1)
              }
            }
            if (this.locations.has(i)) {
              const [l, c] = loc(i)
              pushSegment(l, c, -1)
            }
          }
          srcColumn += 1
          genColumn += 1
        }
      }
    }

    advance(this.intro)
    for (const cell of this.emittedCells()) {
      advance(cell.intro)
      if (cell.edited)
        emitEdited(cell)
      else
        emitUnedited(cell)
      advance(cell.outro)
    }
    advance(this.outro)

    return {
      sources: [''],
      sourcesContent: undefined,
      names: this.storedNames.slice(),
      mappings: lines,
    }
  }
}
