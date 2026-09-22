// Independent character-provenance model for property-testing MagicString.
//
// It mirrors only the *public, observable* contract of the library:
//   - the original UTF-16 string is tiled into `SourceTile`s at edit boundaries;
//   - each tile may carry un-sourced intro/outro text attached at its edges
//     (appendLeft/prependLeft land on the left edge, appendRight/prependRight
//     on the right edge, with the documented stacking order);
//   - tiles may be edited (replacement text sourced at the tile's start) or
//     emptied (removed); and may be reordered by move();
//   - string-level intro/outro bookend the tiled output.
//
// Nothing here imports or inspects the library's internal Chunk implementation.

export type HiresMode = boolean | 'boundary'

export interface ModelSegment {
  [0]: number
  [1]: number
  [2]: number
  [3]: number
  [4]?: number
}

export interface DecodedModelMap {
  sources: string[]
  sourcesContent: Array<string | null> | undefined
  names: string[]
  mappings: ModelSegment[][]
}

export type OpType =
  | 'appendLeft'
  | 'prependLeft'
  | 'appendRight'
  | 'prependRight'
  | 'prepend'
  | 'append'
  | 'overwrite'
  | 'update'
  | 'remove'
  | 'move'
  | 'indent'
  | 'addSourcemapLocation'
  | 'clone'

export interface Op {
  type: OpType
  index?: number
  index2?: number
  index3?: number
  content?: string
  storeName?: boolean
  overwrite?: boolean
  affinity?: 'left' | 'right'
  indentStr?: string
  exclude?: Array<[number, number]>
  indentStart?: boolean
}

export class SourceTile {
  start: number
  end: number
  original: string
  intro = ''
  outro = ''
  content: string
  storeName = false
  edited = false
  previous: SourceTile | null = null
  next: SourceTile | null = null

  constructor(start: number, end: number, original: string) {
    this.start = start
    this.end = end
    this.original = original
    this.content = original
  }

  split(index: number): SourceTile {
    const sliceIndex = index - this.start
    const originalBefore = this.original.slice(0, sliceIndex)
    const originalAfter = this.original.slice(sliceIndex)
    this.original = originalBefore

    const right = new SourceTile(index, this.end, originalAfter)
    right.outro = this.outro
    this.outro = ''
    this.end = index

    if (this.edited) {
      right.edit('', false)
      this.content = ''
    }
    else {
      this.content = originalBefore
    }

    right.next = this.next
    if (right.next)
      right.next.previous = right
    right.previous = this
    this.next = right
    return right
  }

  edit(content: string, storeName = false, contentOnly = false): void {
    this.content = content
    if (!contentOnly) {
      this.intro = ''
      this.outro = ''
    }
    this.storeName = storeName
    this.edited = true
  }

  toString(): string {
    return this.intro + this.content + this.outro
  }

  clone(): SourceTile {
    const tile = new SourceTile(this.start, this.end, this.original)
    tile.intro = this.intro
    tile.outro = this.outro
    tile.content = this.content
    tile.storeName = this.storeName
    tile.edited = this.edited
    return tile
  }
}

export class SourceModel {
  original: string
  intro = ''
  outro = ''
  firstTile: SourceTile
  lastTile: SourceTile
  byStart = new Map<number, SourceTile>()
  byEnd = new Map<number, SourceTile>()
  sourcemapLocations = new Set<number>()
  names = new Set<string>()
  hasMovedTiles = false

  constructor(original: string) {
    this.original = original
    const tile = new SourceTile(0, original.length, original)
    this.firstTile = tile
    this.lastTile = tile
    this.byStart.set(0, tile)
    this.byEnd.set(original.length, tile)
  }

  toString(): string {
    let result = this.intro
    let tile: SourceTile | null = this.firstTile
    while (tile) {
      result += tile.toString()
      tile = tile.next
    }
    return result + this.outro
  }

  /** Splits at an original-index boundary; false when the split violates the
   *  public contract (splitting inside a content-bearing edited range). */
  split(index: number): boolean {
    if (this.byStart.has(index) || this.byEnd.has(index))
      return true
    const tile = this.tileContaining(index)
    if (!tile)
      return false
    if (tile.edited && tile.content.length)
      return false

    const right = tile.split(index)
    this.byEnd.set(index, tile)
    this.byStart.set(index, right)
    this.byEnd.set(right.end, right)
    if (tile === this.lastTile)
      this.lastTile = right
    return true
  }

  tileContaining(index: number): SourceTile | null {
    // original-coordinate tiling never changes, so a walk by original start
    // finds the tile regardless of any move() reordering
    let tile = this.byStart.get(0) ?? null
    while (tile && !(tile.start < index && index < tile.end))
      tile = this.byStart.get(tile.end) ?? null
    return tile
  }

  /** Tiles covering original range [start, end), in original order. */
  covering(start: number, end: number): SourceTile[] {
    const tiles: SourceTile[] = []
    let tile = this.byStart.get(start)
    while (tile) {
      tiles.push(tile)
      if (tile.end >= end)
        break
      tile = this.byStart.get(tile.end)
    }
    return tiles
  }

  appendLeft(index: number, content: string): void {
    if (!this.split(index))
      throw new Error('illegal appendLeft')
    const tile = this.byEnd.get(index)
    if (tile)
      tile.outro += content
    else
      this.intro += content
  }

  prependLeft(index: number, content: string): void {
    if (!this.split(index))
      throw new Error('illegal prependLeft')
    const tile = this.byEnd.get(index)
    if (tile)
      tile.outro = content + tile.outro
    else
      this.intro = content + this.intro
  }

  appendRight(index: number, content: string): void {
    if (!this.split(index))
      throw new Error('illegal appendRight')
    const tile = this.byStart.get(index)
    if (tile)
      tile.intro = tile.intro + content
    else
      this.outro += content
  }

  prependRight(index: number, content: string): void {
    if (!this.split(index))
      throw new Error('illegal prependRight')
    const tile = this.byStart.get(index)
    if (tile)
      tile.intro = content + tile.intro
    else
      this.outro = content + this.outro
  }

  /** Returns false when the edit is refused by the public contract: a
   *  zero-length range, or a range whose tiles are not adjacent in the current
   *  emission order because an earlier move() split them. */
  update(start: number, end: number, content: string, opts: { storeName?: boolean, overwrite?: boolean } = {}): boolean {
    if (start === end || start < 0 || end > this.original.length || start > end)
      return false
    if (!this.split(start) || !this.split(end))
      return false

    const first = this.byStart.get(start)!
    const last = this.byEnd.get(end)!
    let cursor: SourceTile | null = first
    while (cursor !== last) {
      if (!cursor.next || this.byStart.get(cursor.end) !== cursor.next)
        return false
      cursor = cursor.next
    }

    if (opts.storeName)
      this.names.add(this.original.slice(start, end))

    // Mirror the library: every tile up to but excluding `last` is emptied
    // (edit('', false) resets its storeName flag), then `first` receives the
    // replacement and the full overwrite flag.
    cursor = first
    while (cursor !== last) {
      cursor.edit('', false)
      cursor = cursor.next!
    }
    first.edit(content, !!opts.storeName, !opts.overwrite)
    return true
  }

  overwrite(start: number, end: number, content: string, opts: { storeName?: boolean, contentOnly?: boolean } = {}): boolean {
    return this.update(start, end, content, {
      storeName: opts.storeName,
      overwrite: !opts.contentOnly,
    })
  }

  remove(start: number, end: number): boolean {
    if (start === end || start < 0 || end > this.original.length || start > end)
      return false
    if (!this.split(start) || !this.split(end))
      return false

    let tile: SourceTile | null = this.byStart.get(start)!
    while (tile) {
      // inserts strictly inside the removed range travel with it; inserts
      // anchored at the range edges are preserved
      if (tile.start > start)
        tile.intro = ''
      if (tile.end < end)
        tile.outro = ''
      // Chunk#edit's third arg is contentOnly: true keeps the intro/outro
      // (only the characters are removed)
      tile.edit('', false, true)
      tile = end > tile.end ? this.byStart.get(tile.end)! : null
    }
    return true
  }

  move(start: number, end: number, index: number, affinity: 'left' | 'right' = 'right'): boolean {
    if (start === end || start < 0 || end > this.original.length)
      return false
    if (index >= start && index <= end)
      return false
    if (!this.split(start) || !this.split(end) || !this.split(index))
      return false

    const first = this.byStart.get(start)!
    const last = this.byEnd.get(end)!

    if (this.hasMovedTiles) {
      let cursor: SourceTile | null = first
      while (cursor !== last) {
        cursor = cursor.next
        if (!cursor || cursor.start < start || cursor.end > end)
          return false
      }
    }

    const oldLeft = first.previous
    const oldRight = last.next

    let newLeft: SourceTile | null
    let newRight: SourceTile | null
    if (affinity === 'left') {
      newLeft = this.byEnd.get(index) ?? null
      if (!newLeft) {
        if (first === this.firstTile)
          return true
        newRight = this.firstTile
      }
      else {
        if (newLeft.next === first)
          return true
        newRight = newLeft.next
      }
    }
    else {
      newRight = this.byStart.get(index) ?? null
      if (!newRight) {
        if (last === this.lastTile)
          return true
        newLeft = this.lastTile
      }
      else {
        if (newRight.previous === last)
          return true
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
      this.firstTile = last.next!
    if (!last.next) {
      this.lastTile = first.previous!
      this.lastTile.next = null
    }

    first.previous = newLeft
    last.next = newRight ?? null

    if (!newLeft)
      this.firstTile = first
    if (!newRight)
      this.lastTile = last

    this.hasMovedTiles = true
    return true
  }

  indent(indentStr: string | undefined, options: { exclude?: Array<[number, number]>, indentStart?: boolean } = {}): void {
    const pattern = /^[^\r\n]/gm

    if (indentStr === undefined) {
      indentStr = guessIndent(this.original) || '\t'
    }
    if (indentStr === '')
      return

    const resolvedIndentStr = indentStr
    const isExcluded: Record<number, boolean> = {}

    if (options.exclude) {
      for (const exclusion of options.exclude) {
        for (let i = exclusion[0]; i < exclusion[1]; i += 1)
          isExcluded[i] = true
      }
    }

    let shouldIndentNextCharacter = options.indentStart !== false

    const indentPiece = (str: string): string => {
      if (str === '')
        return str
      const indented = str.replace(pattern, (_match: string, offset: number) =>
        offset > 0 || shouldIndentNextCharacter ? `${resolvedIndentStr}${_match}` : _match)
      shouldIndentNextCharacter = str[str.length - 1] === '\n'
      return indented
    }

    this.intro = indentPiece(this.intro)

    let charIndex = 0
    let tile: SourceTile | null = this.firstTile

    const indentAt = (index: number) => {
      shouldIndentNextCharacter = false
      if (index === tile!.start) {
        tile!.intro = tile!.intro + resolvedIndentStr
      }
      else {
        this.split(index)
        tile = tile!.next
        tile!.intro = resolvedIndentStr + tile!.intro
      }
    }

    while (tile) {
      const end = tile.end

      if (!isExcluded[tile.start])
        tile.intro = indentPiece(tile.intro)

      if (tile.edited) {
        if (!isExcluded[charIndex])
          tile.content = indentPiece(tile.content)
      }
      else if (options.exclude) {
        charIndex = tile.start
        while (charIndex < end) {
          if (!isExcluded[charIndex]) {
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
        charIndex = tile.start
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

      if (!isExcluded[tile.end - 1])
        tile.outro = indentPiece(tile.outro)

      charIndex = tile.end
      tile = tile.next
    }

    this.outro = indentPiece(this.outro)
  }

  addSourcemapLocation(index: number): void {
    this.sourcemapLocations.add(index)
  }

  clone(): SourceModel {
    const cloned = new SourceModel(this.original)
    cloned.byStart.clear()
    cloned.byEnd.clear()

    let originalTile = this.firstTile
    let clonedTile: SourceTile = originalTile.clone()
    cloned.firstTile = clonedTile
    while (originalTile) {
      cloned.byStart.set(clonedTile.start, clonedTile)
      cloned.byEnd.set(clonedTile.end, clonedTile)

      const nextOriginal = originalTile.next
      const nextCloned = nextOriginal ? nextOriginal.clone() : null
      if (nextCloned) {
        clonedTile.next = nextCloned
        nextCloned.previous = clonedTile
        clonedTile = nextCloned
      }
      originalTile = nextOriginal!
    }
    cloned.lastTile = clonedTile

    cloned.sourcemapLocations = new Set(this.sourcemapLocations)
    cloned.names = new Set(this.names)
    cloned.intro = this.intro
    cloned.outro = this.outro
    cloned.hasMovedTiles = this.hasMovedTiles
    return cloned
  }
}

function guessIndent(code: string): string | null {
  // mirrors the observable indent-guessing contract of the library
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

class ModelMappings {
  hires: HiresMode
  line = 0
  column = 0
  raw: ModelSegment[][] = [[]]

  constructor(hires: HiresMode = false) {
    this.hires = hires
  }

  private nextLine(): void {
    this.line += 1
    this.raw[this.line] = []
    this.column = 0
  }

  private segment(sourceLine: number, sourceColumn: number, nameIndex = -1): void {
    const segment: ModelSegment = [this.column, 0, sourceLine, sourceColumn]
    if (nameIndex >= 0)
      segment.push(nameIndex)
    this.raw[this.line].push(segment)
  }

  advance(str: string): void {
    if (!str)
      return
    const lastNewline = str.lastIndexOf('\n')
    for (let i = str.indexOf('\n'); i !== -1; i = str.indexOf('\n', i + 1))
      this.nextLine()
    this.column += str.length - lastNewline - 1
  }

  addEdit(content: string, sourceLine: number, sourceColumn: number, nameIndex: number): void {
    if (!content.length)
      return
    const lastIndex = content.length - 1
    let lineEnd = content.indexOf('\n', 0)
    let previousLineEnd = -1
    while (lineEnd >= 0 && lastIndex > lineEnd) {
      this.segment(sourceLine, sourceColumn, nameIndex)
      this.nextLine()
      previousLineEnd = lineEnd
      lineEnd = content.indexOf('\n', lineEnd + 1)
    }
    this.segment(sourceLine, sourceColumn, nameIndex)
    this.advance(content.slice(previousLineEnd + 1))
  }

  addUneditedTile(tile: SourceTile, original: string, line: number, column: number, locations: Set<number>, at: { line: number, column: number }): void {
    let i = tile.start
    const end = tile.end

    if (this.hires) {
      const boundary = this.hires === 'boundary'
      let inWord = false
      while (i < end) {
        const code = original.charCodeAt(i)
        if (code === 10) {
          at.line += 1
          at.column = 0
          this.nextLine()
          inWord = false
        }
        else {
          if (boundary) {
            if (isWordCode(code)) {
              if (!inWord) {
                this.segment(at.line, at.column)
                inWord = true
              }
            }
            else {
              this.segment(at.line, at.column)
              inWord = false
            }
          }
          else {
            this.segment(at.line, at.column)
          }
          at.column += 1
          this.column += 1
        }
        i += 1
      }
    }
    else {
      while (i < end) {
        let newline = original.indexOf('\n', i)
        if (newline === -1 || newline > end)
          newline = end
        if (newline > i) {
          this.segment(at.line, at.column)
          for (let index = i + 1; index < newline; index += 1) {
            if (locations.has(index))
              this.raw[this.line].push([this.column + (index - i), 0, at.line, at.column + (index - i)])
          }
          at.column += newline - i
          this.column += newline - i
        }
        if (newline === end)
          break
        at.line += 1
        at.column = 0
        this.nextLine()
        i = newline + 1
      }
    }
  }
}

function isWordCode(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code === 95
}

export function generateDecodedModelMap(model: SourceModel, hires: HiresMode = false, includeContent = false): DecodedModelMap {
  const mappings = new ModelMappings(hires)
  const names = [...model.names]
  const locate = getModelLocator(model.original)

  if (model.intro)
    mappings.advance(model.intro)

  let tile: SourceTile | null = model.firstTile
  while (tile) {
    const loc = locate(tile.start)
    if (tile.intro.length)
      mappings.advance(tile.intro)

    if (tile.edited) {
      const nameIndex = tile.storeName ? names.indexOf(tile.original) : -1
      mappings.addEdit(tile.content, loc.line, loc.column, nameIndex)
    }
    else {
      mappings.addUneditedTile(tile, model.original, loc.line, loc.column, model.sourcemapLocations, loc)
    }

    if (tile.outro.length)
      mappings.advance(tile.outro)
    tile = tile.next
  }

  if (model.outro)
    mappings.advance(model.outro)

  return {
    sources: [''],
    sourcesContent: includeContent ? [model.original] : undefined,
    names,
    mappings: mappings.raw,
  }
}

function getModelLocator(source: string): (index: number) => { line: number, column: number } {
  const lineOffsets = [0]
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1))
    lineOffsets.push(i + 1)

  return (index: number) => {
    let lo = 0
    let hi = lineOffsets.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (index < lineOffsets[mid])
        hi = mid
      else
        lo = mid + 1
    }
    const line = lo - 1
    return { line, column: index - lineOffsets[line] }
  }
}

/**
 * Pure legality predicates mirroring the public contract. They never mutate
 * the model, so the operation generator can reject overlapping/illegal edits
 * before they are applied to either side.
 */
export function canSplit(model: SourceModel, index: number): boolean {
  if (index < 0 || index > model.original.length)
    return false
  if (model.byStart.has(index) || model.byEnd.has(index))
    return true
  const tile = model.tileContaining(index)
  if (!tile)
    return false
  // the library allows splitting an edited tile only when its replacement is
  // empty (the overlapping-replacement case); content-bearing edits throw
  if (tile.edited && tile.content.length > 0)
    return false
  return true
}

export function legalRange(model: SourceModel, start: number, end: number): boolean {
  if (start === end)
    return false
  if (start < 0 || end > model.original.length || start > end)
    return false
  return canSplit(model, start) && canSplit(model, end)
}

export function canUpdate(model: SourceModel, start: number, end: number): boolean {
  if (!legalRange(model, start, end))
    return false
  const first = model.byStart.get(start)
  const last = model.byEnd.get(end)
  if (!first || !last)
    return false
  let cursor: SourceTile | null = first
  while (cursor !== last) {
    if (!cursor.next || model.byStart.get(cursor.end) !== cursor.next)
      return false
    cursor = cursor.next
  }
  return true
}

export function canRemove(model: SourceModel, start: number, end: number): boolean {
  return legalRange(model, start, end)
}

export function canMove(model: SourceModel, start: number, end: number, index: number): boolean {
  if (!legalRange(model, start, end))
    return false
  if (index < 0 || index > model.original.length)
    return false
  if (index >= start && index <= end)
    return false
  if (!canSplit(model, index))
    return false

  if (model.hasMovedTiles) {
    const first = model.byStart.get(start)!
    const last = model.byEnd.get(end)!
    let cursor: SourceTile | null = first
    while (cursor !== last) {
      cursor = cursor.next
      if (!cursor || cursor.start < start || cursor.end > end)
        return false
    }
  }
  return true
}

export function canInsert(model: SourceModel, index: number): boolean {
  return canSplit(model, index)
}
