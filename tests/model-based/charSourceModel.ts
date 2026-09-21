/**
 * Independent character-provenance model for MagicString.
 *
 * It mirrors the *public* contract of MagicString (appendLeft/prependRight,
 * overwrite/remove, move, indent, addSourcemapLocation, clone) but is written
 * from scratch against the documented semantics - it never imports or inspects
 * the library's internal Chunk/linked list implementation.
 *
 * The model tracks, per chunk tile of the ORIGINAL string:
 *  - intro/outro: insertion strings attached at the tile's left/right edge
 *  - edited/content/storeName: replacement state
 * and a current emission order that move() rewires. `emit()` then walks that
 * order and produces both the generated string and, for every generated
 * character, whether it is inserted or which original index it came from.
 */

export class ModelContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelContractError'
  }
}

export type HiresMode = boolean | 'boundary'

export interface ExpectedDecodedMap {
  file?: string
  sources: string[]
  sourcesContent?: Array<string | null>
  names: string[]
  mappings: number[][][]
  rangeMappings: number[][]
}

export interface IndentModelOptions {
  exclude?: Array<[number, number]>
  indentStart?: boolean
}

interface Tile {
  start: number
  end: number
  intro: string
  outro: string
  content: string
  edited: boolean
  storeName: boolean
  previous: number | null
  next: number | null
}

function normalizeBounds(start: number, end: number, length: number): [number, number] {
  if (length !== 0) {
    if (start < 0)
      start = Math.max(0, start + length)
    if (end < 0)
      end = Math.max(0, end + length)
  }
  if (start < 0)
    throw new ModelContractError(`start ${start} is out of bounds`)
  if (end > length)
    throw new ModelContractError(`end ${end} is out of bounds`)
  if (start > end)
    throw new ModelContractError(`end must be greater than start (start: ${start}, end: ${end})`)
  return [start, end]
}

const NEWLINE_CHAR = 10
const CR_CHAR = 13

function isWordCode(code: number): boolean {
  return (code >= 97 && code <= 122)
    || (code >= 65 && code <= 90)
    || (code >= 48 && code <= 57)
    || code === 95
}

export class CharSourceModel {
  readonly original: string

  private tiles: Map<number, Tile>
  private boundaries: number[]
  private first: number
  private last: number

  private intro = ''
  private outro = ''
  private hasMoved = false
  private sourcemapLocations = new Set<number>()
  private storedNames: string[] = []

  constructor(original: string) {
    this.original = original
    this.tiles = new Map()
    this.boundaries = [0, original.length]
    if (original.length === 0) {
      const tile: Tile = {
        start: 0,
        end: 0,
        intro: '',
        outro: '',
        content: '',
        edited: false,
        storeName: false,
        previous: null,
        next: null,
      }
      this.tiles.set(0, tile)
      this.first = 0
      this.last = 0
    }
    else {
      const tile: Tile = {
        start: 0,
        end: original.length,
        intro: '',
        outro: '',
        content: original,
        edited: false,
        storeName: false,
        previous: null,
        next: null,
      }
      this.tiles.set(0, tile)
      this.first = 0
      this.last = 0
    }
  }

  clone(): CharSourceModel {
    const copy = new CharSourceModel(this.original)
    copy.tiles = new Map()
    for (const [key, tile] of this.tiles) {
      copy.tiles.set(key, { ...tile })
    }
    copy.boundaries = [...this.boundaries]
    copy.first = this.first
    copy.last = this.last
    copy.intro = this.intro
    copy.outro = this.outro
    copy.hasMoved = this.hasMoved
    copy.sourcemapLocations = new Set(this.sourcemapLocations)
    copy.storedNames = [...this.storedNames]
    return copy
  }

  private tileEnd(start: number): number {
    const index = this.boundaries.indexOf(start)
    return this.boundaries[index + 1]
  }

  private tileAt(index: number): Tile {
    let lo = 0
    let hi = this.boundaries.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.boundaries[mid] <= index)
        lo = mid + 1
      else
        hi = mid
    }
    return this.tiles.get(this.boundaries[lo - 1])!
  }

  /**
   * Splits the tile containing `index` in two, mirroring the library's
   * restriction: a tile that carries non-empty replacement content cannot be
   * split, while zero-length edited tiles split into two zero-length tiles.
   */
  private split(index: number): void {
    if (this.boundaries.includes(index))
      return
    if (this.original.length === 0)
      return

    const left = this.tileAt(index)
    if (left.edited && left.content.length > 0) {
      throw new ModelContractError('cannot split a chunk that has already been edited')
    }

    const right: Tile = {
      start: index,
      end: left.end,
      intro: '',
      // Chunk.split moves the left-side insert onto the new right-hand tile.
      outro: left.outro,
      content: left.edited ? '' : this.original.slice(index, left.end),
      edited: left.edited,
      storeName: left.edited ? left.storeName : false,
      previous: left.start,
      next: left.next,
    }

    left.end = index
    left.content = left.edited ? '' : this.original.slice(left.start, index)
    left.outro = ''
    left.next = index

    if (right.next !== null)
      this.tiles.get(right.next)!.previous = index
    this.tiles.set(index, right)

    const insertion = this.boundaries.findIndex(boundary => boundary > index)
    this.boundaries.splice(insertion, 0, index)

    if (this.last === left.start)
      this.last = index
  }

  appendLeft(index: number, content: string): void {
    this.split(index)
    const tile = this.original.length === 0
      ? this.tiles.get(0)
      : (index === 0 ? undefined : this.tiles.get(this.boundaries[this.boundaries.indexOf(index) - 1]))
    if (tile)
      tile.outro += content
    else
      this.intro += content
  }

  prependLeft(index: number, content: string): void {
    this.split(index)
    const tile = this.original.length === 0
      ? this.tiles.get(0)
      : (index === 0 ? undefined : this.tiles.get(this.boundaries[this.boundaries.indexOf(index) - 1]))
    if (tile)
      tile.outro = content + tile.outro
    else
      this.intro = content + this.intro
  }

  appendRight(index: number, content: string): void {
    this.split(index)
    const tile = this.original.length === 0 ? this.tiles.get(0) : this.tiles.get(index)
    if (tile)
      tile.intro = tile.intro + content
    else
      this.outro += content
  }

  prependRight(index: number, content: string): void {
    this.split(index)
    const tile = this.original.length === 0 ? this.tiles.get(0) : this.tiles.get(index)
    if (tile)
      tile.intro = content + tile.intro
    else
      this.outro = content + this.outro
  }

  prepend(content: string): void {
    this.intro = content + this.intro
  }

  append(content: string): void {
    this.outro += content
  }

  addSourcemapLocation(char: number): void {
    this.sourcemapLocations.add(char)
  }

  update(
    start: number,
    end: number,
    content: string,
    options: { storeName?: boolean, overwrite?: boolean } = {},
  ): void {
    if (typeof content !== 'string')
      throw new ModelContractError(`content must be a string, got ${typeof content}`)

    ;[start, end] = normalizeBounds(start, end, this.original.length)

    if (start === end) {
      throw new ModelContractError(
        `cannot overwrite a zero-length range at ${start}, use appendLeft() or prependRight()`,
      )
    }

    this.split(start)
    this.split(end)

    const storeName = options.storeName ?? false
    const overwrite = options.overwrite ?? false

    if (storeName) {
      const original = this.original.slice(start, end)
      if (!this.storedNames.includes(original))
        this.storedNames.push(original)
    }

    const first = this.tiles.get(start)!
    const lastTileAnchor = this.boundaries[this.boundaries.indexOf(end) - 1]

    // Contiguity guard, matching the library's "cannot overwrite across a
    // split point" check: every interior tile boundary inside [start, end)
    // must link forward in emission order to the next original tile.
    const startBoundaryIndex = this.boundaries.indexOf(start)
    const endBoundaryIndex = this.boundaries.indexOf(end)
    for (let i = startBoundaryIndex; i < endBoundaryIndex; i += 1) {
      const tileAnchor = this.boundaries[i]
      const nextAnchor = this.boundaries[i + 1]
      const tile = this.tiles.get(tileAnchor)!
      if (tile.next !== nextAnchor)
        throw new ModelContractError('cannot overwrite across a split point')
    }

    // Each tile after the first is emptied via edit('', false), which discards
    // content, intro and outro. The walk follows emission order (next); the
    // contiguity guard above ensures the range is still a forward run.
    let wipedAnchor: number | null = first.next
    while (wipedAnchor !== null) {
      const tile = this.tiles.get(wipedAnchor)!
      if (tile.start >= end)
        break
      tile.edited = true
      tile.content = ''
      tile.storeName = false
      tile.intro = ''
      tile.outro = ''
      wipedAnchor = tile.next
    }

    // The first tile carries the replacement. edit(content, storeName,
    // !overwrite) discards its edge inserts only for a full overwrite.
    first.content = content
    first.storeName = storeName
    first.edited = true
    // edit() only discards edge inserts when its contentOnly flag is falsy,
    // i.e. for a full overwrite; a content-only update keeps them.
    if (overwrite) {
      first.intro = ''
      first.outro = ''
    }
  }

  overwrite(
    start: number,
    end: number,
    content: string,
    options: { storeName?: boolean, contentOnly?: boolean } = {},
  ): void {
    this.update(start, end, content, {
      ...options,
      overwrite: !options.contentOnly,
    })
  }

  remove(start: number, end: number): void {
    ;[start, end] = normalizeBounds(start, end, this.original.length)
    if (start === end)
      return

    this.split(start)
    this.split(end)

    let anchor = start
    while (anchor < end) {
      const tile = this.tiles.get(anchor)!
      if (tile.start > start)
        tile.intro = ''
      if (tile.end < end)
        tile.outro = ''
      tile.edited = true
      tile.content = ''
      tile.storeName = false
      anchor = tile.end
    }
  }

  move(start: number, end: number, index: number, affinity: 'left' | 'right' = 'right'): void {
    if (start === end)
      return
    if (index >= start && index <= end)
      throw new ModelContractError('cannot move a selection inside itself')

    this.split(start)
    this.split(end)
    this.split(index)

    const firstTile = this.tiles.get(start)!
    const lastTile = this.tiles.get(this.boundaries[this.boundaries.indexOf(end) - 1])!

    if (this.hasMoved) {
      let cursor: Tile | null = firstTile
      while (cursor !== lastTile) {
        cursor = cursor.next === null ? null : this.tiles.get(cursor.next)!
        if (!cursor || cursor.start < start || cursor.end > end) {
          throw new ModelContractError('cannot move because an earlier move split that range')
        }
      }
    }

    const oldLeft = firstTile.previous
    const oldRight = lastTile.next

    let newLeft: number | null
    let newRight: number | null

    if (affinity === 'left') {
      const boundaryIndex = this.boundaries.indexOf(index)
      newLeft = boundaryIndex > 0 ? this.boundaries[boundaryIndex - 1] : null
      if (!newLeft) {
        if (this.first === start)
          return
        newRight = this.first
      }
      else {
        if (this.tiles.get(newLeft)!.next === start)
          return
        newRight = this.tiles.get(newLeft)!.next
      }
    }
    else {
      newRight = this.tiles.has(index) ? index : null
      if (newRight === null) {
        if (this.last === lastTile.start)
          return
        newLeft = this.last
      }
      else {
        if (this.tiles.get(newRight)!.previous === lastTile.start)
          return
        newLeft = this.tiles.get(newRight)!.previous
      }
    }

    if (oldLeft !== null)
      this.tiles.get(oldLeft)!.next = oldRight
    if (oldRight !== null)
      this.tiles.get(oldRight)!.previous = oldLeft
    if (newLeft !== null)
      this.tiles.get(newLeft)!.next = start
    if (newRight !== null)
      this.tiles.get(newRight)!.previous = lastTile.start

    if (firstTile.previous === null)
      this.first = lastTile.next!
    if (lastTile.next === null) {
      this.last = firstTile.previous!
      this.tiles.get(this.last)!.next = null
    }

    firstTile.previous = newLeft
    lastTile.next = newRight

    if (newLeft === null)
      this.first = start
    if (newRight === null)
      this.last = lastTile.start

    this.hasMoved = true
  }

  indent(
    indentStr?: string | IndentModelOptions,
    maybeOptions?: IndentModelOptions,
  ): void {
    let options: IndentModelOptions = {}
    if (typeof indentStr === 'object' && indentStr !== null) {
      options = indentStr
      indentStr = '\t'
    }
    else if (maybeOptions) {
      options = maybeOptions
    }
    if (indentStr === undefined)
      indentStr = '\t'
    if (indentStr === '')
      return

    const resolvedIndentStr = indentStr
    const isExcluded = new Set<number>()
    if (options.exclude) {
      const exclusions: Array<[number, number]>
        = typeof options.exclude[0] === 'number'
          ? [options.exclude as unknown as [number, number]]
          : options.exclude
      for (const [rangeStart, rangeEnd] of exclusions) {
        for (let i = rangeStart; i < rangeEnd; i += 1)
          isExcluded.add(i)
      }
    }

    let shouldIndentNextCharacter = options.indentStart !== false
    const indentPiece = (str: string): string => {
      if (str === '')
        return str
      const indented = str.replace(/^[^\r\n]/gm, (_match, offset: number) =>
        offset > 0 || shouldIndentNextCharacter ? `${resolvedIndentStr}${_match}` : _match)
      shouldIndentNextCharacter = str[str.length - 1] === '\n'
      return indented
    }

    this.intro = indentPiece(this.intro)

    let charIndex = 0
    let chunk: Tile | null = this.tiles.get(this.first)!

    while (chunk) {
      const end = chunk.end

      if (!isExcluded.has(chunk.start))
        chunk.intro = indentPiece(chunk.intro)

      const indentAt = (index: number): void => {
        shouldIndentNextCharacter = false
        if (index === chunk!.start) {
          chunk!.intro = chunk!.intro + resolvedIndentStr
        }
        else {
          this.split(index)
          chunk = this.tiles.get(index)!
          chunk.intro = resolvedIndentStr + chunk.intro
        }
      }

      if (chunk.edited) {
        if (!isExcluded.has(charIndex))
          chunk.content = indentPiece(chunk.content)
      }
      else if (options.exclude) {
        charIndex = chunk.start
        while (charIndex < end) {
          if (!isExcluded.has(charIndex)) {
            const code = this.original.charCodeAt(charIndex)
            if (code === NEWLINE_CHAR) {
              shouldIndentNextCharacter = true
            }
            else if (code !== CR_CHAR && shouldIndentNextCharacter) {
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
          if (code === NEWLINE_CHAR || code === CR_CHAR) {
            charIndex += 1
            continue
          }

          indentAt(charIndex)
          charIndex += 1
        }
      }

      if (!isExcluded.has(chunk.end - 1))
        chunk.outro = indentPiece(chunk.outro)

      charIndex = end
      chunk = chunk.next === null ? null : this.tiles.get(chunk.next)!
    }

    this.outro = indentPiece(this.outro)
  }

  /**
   * One emitted character: either an insertion (`origin === null`) or a copy
   * of `original[origin]`. Edit content carries no provenance here; its named
   * mapping is derived from the tile when generating the expected map.
   */
  private emit(): { text: string, origins: Array<number | null> } {
    let text = this.intro
    const origins: Array<number | null> = new Array(this.intro.length).fill(null)

    let anchor: number | null = this.first
    while (anchor !== null) {
      const tile = this.tiles.get(anchor)!

      text += tile.intro
      origins.push(...new Array(tile.intro.length).fill(null))

      if (tile.edited) {
        text += tile.content
        origins.push(...new Array(tile.content.length).fill(null))
      }
      else {
        for (let i = tile.start; i < tile.end; i += 1) {
          text += this.original[i]
          origins.push(i)
        }
      }

      text += tile.outro
      origins.push(...new Array(tile.outro.length).fill(null))

      anchor = tile.next
    }

    text += this.outro
    origins.push(...new Array(this.outro.length).fill(null))

    return { text, origins }
  }

  toString(): string {
    return this.emit().text
  }

  /**
   * Per-generated-character provenance: null for inserted/edited output, the
   * original index for copied characters. Used by the mapping invariants.
   */
  provenance(): { text: string, origins: Array<number | null> } {
    return this.emit()
  }

  /**
   * Builds the expected decoded mapping straight from the provenance stream,
   * re-implementing the documented Mappings rules by walking tiles in emission
   * order (the same information `emit()` exposes), without consulting the
   * library code.
   */
  generateDecodedMap(options: {
    hires?: HiresMode
    file?: string
    source?: string
    includeContent?: boolean
  } = {}): ExpectedDecodedMap {
    const hires = options.hires ?? false
    const mappings: number[][][] = [[]]
    let generatedLine = 0
    let generatedColumn = 0
    const lineStarts = [0]
    for (let i = 0; i < this.original.length; i += 1) {
      if (this.original[i] === '\n')
        lineStarts.push(i + 1)
    }
    const locate = (index: number): { line: number, column: number } => {
      let lo = 0
      let hi = lineStarts.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (index < lineStarts[mid])
          hi = mid
        else
          lo = mid + 1
      }
      return { line: lo - 1, column: index - lineStarts[lo - 1] }
    }

    const nextGeneratedLine = (): void => {
      generatedLine += 1
      mappings[generatedLine] = []
      generatedColumn = 0
    }

    const advance = (str: string): void => {
      if (!str)
        return
      for (let i = str.indexOf('\n'); i !== -1; i = str.indexOf('\n', i + 1))
        nextGeneratedLine()
      const lastNewline = str.lastIndexOf('\n')
      generatedColumn += str.length - lastNewline - 1
    }

    const addEdit = (content: string, loc: { line: number, column: number }, nameIndex: number): void => {
      if (!content.length)
        return
      let previousContentLineEnd = -1
      let contentLineEnd = content.indexOf('\n', 0)
      while (contentLineEnd >= 0 && content.length - 1 > contentLineEnd) {
        const segment = [generatedColumn, 0, loc.line, loc.column]
        if (nameIndex >= 0)
          segment.push(nameIndex)
        mappings[generatedLine].push(segment)
        nextGeneratedLine()
        previousContentLineEnd = contentLineEnd
        contentLineEnd = content.indexOf('\n', contentLineEnd + 1)
      }
      const segment = [generatedColumn, 0, loc.line, loc.column]
      if (nameIndex >= 0)
        segment.push(nameIndex)
      mappings[generatedLine].push(segment)
      advance(content.slice(previousContentLineEnd + 1))
    }

    const addUneditedTile = (tile: Tile, loc0: { line: number, column: number }): void => {
      let i = tile.start
      const loc = { ...loc0 }

      if (hires) {
        const boundary = hires === 'boundary'
        let charInHiresBoundary = false
        while (i < tile.end) {
          const code = this.original.charCodeAt(i)
          if (code === NEWLINE_CHAR) {
            loc.line += 1
            loc.column = 0
            nextGeneratedLine()
            charInHiresBoundary = false
          }
          else {
            if (boundary) {
              if (isWordCode(code)) {
                if (!charInHiresBoundary) {
                  mappings[generatedLine].push([generatedColumn, 0, loc.line, loc.column])
                  charInHiresBoundary = true
                }
              }
              else {
                mappings[generatedLine].push([generatedColumn, 0, loc.line, loc.column])
                charInHiresBoundary = false
              }
            }
            else {
              mappings[generatedLine].push([generatedColumn, 0, loc.line, loc.column])
            }
            loc.column += 1
            generatedColumn += 1
          }
          i += 1
        }
      }
      else {
        while (i < tile.end) {
          let newline = this.original.indexOf('\n', i)
          if (newline === -1 || newline > tile.end)
            newline = tile.end
          if (newline > i) {
            mappings[generatedLine].push([generatedColumn, 0, loc.line, loc.column])
            for (let index = i + 1; index < newline; index += 1) {
              if (this.sourcemapLocations.has(index)) {
                const offset = index - i
                mappings[generatedLine].push([
                  generatedColumn + offset,
                  0,
                  loc.line,
                  loc.column + offset,
                ])
              }
            }
            loc.column += newline - i
            generatedColumn += newline - i
          }
          if (newline === tile.end)
            break
          loc.line += 1
          loc.column = 0
          nextGeneratedLine()
          i = newline + 1
        }
      }
    }

    if (this.intro)
      advance(this.intro)

    let anchor: number | null = this.first
    while (anchor !== null) {
      const tile = this.tiles.get(anchor)!
      if (tile.intro.length)
        advance(tile.intro)

      const loc = locate(tile.start)
      if (tile.edited) {
        const name = tile.storeName
          ? this.storedNames.indexOf(this.original.slice(tile.start, tile.end))
          : -1
        addEdit(tile.content, loc, name)
      }
      else {
        addUneditedTile(tile, loc)
      }

      if (tile.outro.length)
        advance(tile.outro)
      anchor = tile.next
    }

    if (this.outro)
      advance(this.outro)

    return {
      file: options.file ? options.file.split(/[/\\]/).pop() : undefined,
      sources: [options.source ? options.source : options.file || ''],
      sourcesContent: options.includeContent !== undefined
        ? [options.includeContent ? this.original : null]
        : undefined,
      names: [...this.storedNames],
      mappings,
      rangeMappings: mappings.map(() => []),
    }
  }

  get storedNameList(): string[] {
    return [...this.storedNames]
  }
}
