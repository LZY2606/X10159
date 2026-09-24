/**
 * Independent character-provenance model of the public MagicString contract.
 *
 * This model is deliberately written from the documented public semantics
 * (appendLeft/appendRight, overwrite, remove, move, indent, ...) rather than
 * from the library's internal Chunk list. It keeps track, for every emitted
 * UTF-16 code unit, whether it is:
 *
 *   - a surviving original character (and which original index it came from),
 *   - a character introduced by an edit (overwrite/update), or
 *   - pure insertion text (intros/outros, indentation, appends).
 *
 * That provenance is the reference used to check decoded sourcemaps without
 * re-implementing the library's segment encoder.
 */

export interface EditOptions {
  storeName?: boolean
  contentOnly?: boolean
}

interface Tile {
  /** Inclusive original range [start, end); invariant once created. */
  start: number
  end: number
  /** false for surviving original text, true for edit (possibly empty). */
  edited: boolean
  /** Replacement text (only meaningful when edited). */
  content: string
  /** Original text covered by this tile (only kept for storeName tiles). */
  name: string | null
}

/** What an emitted code unit can claim as its source. */
export type Origin
  = { kind: 'original', index: number }
  | { kind: 'edit', line: number, column: number, name: string | null }
  | { kind: 'insert' }

export interface EmittedUnit {
  char: string
  origin: Origin
  /** Generated column where the unit sits on its output line. */
  column: number
  /**
   * True for original units that open a hires 'boundary' word group, and for
   * original units at a lo-res mapping position (line start or a location
   * registered with addSourcemapLocation).
   */
  expectSegment: boolean
  /** lo-res mapping position: source line start or addSourcemapLocation. */
  lores?: boolean
  /** hires 'boundary' mapping position. */
  boundary?: boolean
}

export type Op =
  | { type: 'appendLeft' | 'prependLeft' | 'appendRight' | 'prependRight', index: number, text: string }
  | { type: 'append' | 'prepend', text: string }
  | { type: 'overwrite', start: number, end: number, text: string, options: EditOptions }
  | { type: 'remove', start: number, end: number }
  | { type: 'move', start: number, end: number, index: number, affinity: 'left' | 'right' }
  | { type: 'indent', indentStr: string, exclude?: Array<[number, number]>, indentStart?: boolean }
  | { type: 'addSourcemapLocation', index: number }
  | { type: 'clone' }

const INSERT_TEXTS = ['', 'x', 'X', '}', 'ab', '\n', '>\n', ' ']

export class ReferenceModel {
  original: string
  /** Tiles in static (original) order; static neighbours are array positions. */
  tiles: Tile[]
  /** Current emission order as indices into tiles. */
  order: number[]
  /** L[b] is text attached on the left side of original boundary b (appendLeft/prependLeft). */
  leftAt: string[]
  /** R[b] is text attached on the right side of original boundary b (appendRight/prependRight). */
  rightAt: string[]
  stringIntro = ''
  stringOutro = ''
  sourcemapLocations = new Set<number>()
  storedNames: string[] = []

  constructor(original: string, source?: ReferenceModel) {
    this.original = original
    if (source) {
      this.tiles = source.tiles.map(tile => ({ ...tile }))
      this.order = source.order.slice()
      this.leftAt = source.leftAt.slice()
      this.rightAt = source.rightAt.slice()
      this.stringIntro = source.stringIntro
      this.stringOutro = source.stringOutro
      this.sourcemapLocations = new Set(source.sourcemapLocations)
      this.storedNames = source.storedNames.slice()
    }
    else {
      this.tiles = [{ start: 0, end: original.length, edited: false, content: original, name: null }]
      this.order = [0]
      this.leftAt = new Array(original.length + 1).fill('')
      this.rightAt = new Array(original.length + 1).fill('')
    }
  }

  clone(): ReferenceModel {
    return new ReferenceModel(this.original, this)
  }

  tileContent(tile: Tile): string {
    return tile.edited ? tile.content : this.original.slice(tile.start, tile.end)
  }

  // ---- structure -------------------------------------------------------

  /** Tile containing boundary `index` strictly inside it. */
  private containingTile(index: number): Tile | undefined {
    return this.tiles.find(tile => tile.start < index && index < tile.end)
  }

  /**
   * Mirrors MagicString._split: a boundary already at a tile edge is a no-op,
   * unedited tiles split freely, empty edited tiles split into two empty
   * edited pieces, and non-empty edited tiles reject the split.
   */
  private split(index: number): void {
    if (this.containingTile(index) === undefined)
      return

    const tile = this.containingTile(index)!
    if (tile.edited && tile.content.length > 0)
      throw new Error(`cannot split non-empty edited range at ${index}`)

    const position = this.tiles.indexOf(tile)
    const before: Tile = {
      start: tile.start,
      end: index,
      edited: tile.edited,
      content: tile.edited ? '' : this.original.slice(tile.start, index),
      name: tile.name,
    }
    const after: Tile = {
      start: index,
      end: tile.end,
      edited: tile.edited,
      content: tile.edited ? '' : this.original.slice(index, tile.end),
      name: tile.name,
    }
    this.tiles.splice(position, 1, before, after)

    const orderPosition = this.order.indexOf(position)
    this.order.splice(orderPosition, 1, position, position + 1)
    for (let i = orderPosition + 2; i < this.order.length; i += 1)
      this.order[i] += 1

    // Chunk.split moves the left chunk's outro onto the new right chunk:
    // the boundary's left-side text now belongs to the right-hand tile.
    const carriedOutro = this.leftAt[tile.end]
    this.leftAt.splice(index, 0, carriedOutro)
    this.rightAt.splice(index, 0, '')
  }

  // ---- insertions ------------------------------------------------------

  appendLeft(index: number, text: string): void {
    this.split(index)
    if (index === 0 && !this.tiles.some(tile => tile.end === 0))
      this.stringIntro += text
    else
      this.leftAt[index] += text
  }

  prependLeft(index: number, text: string): void {
    this.split(index)
    if (index === 0 && !this.tiles.some(tile => tile.end === 0))
      this.stringIntro = text + this.stringIntro
    else
      this.leftAt[index] = text + this.leftAt[index]
  }

  appendRight(index: number, text: string): void {
    this.split(index)
    if (index === this.original.length && !this.tiles.some(tile => tile.start === index))
      this.stringOutro += text
    else
      this.rightAt[index] += text
  }

  prependRight(index: number, text: string): void {
    this.split(index)
    if (index === this.original.length && !this.tiles.some(tile => tile.start === index))
      this.stringOutro = text + this.stringOutro
    else
      this.rightAt[index] = text + this.rightAt[index]
  }

  append(text: string): void {
    this.stringOutro += text
  }

  prepend(text: string): void {
    this.stringIntro = text + this.stringIntro
  }

  // ---- range edits -----------------------------------------------------

  private tilesBetween(start: number, end: number): Tile[] {
    return this.tiles.filter(tile => tile.start >= start && tile.end <= end)
  }

  /**
   * The static tiles of [start, end) must still appear as a forward run in the
   * current emission order. An earlier move that interleaved the range makes a
   * later overwrite/move illegal - this is the same structural check the
   * library performs on its chunk list.
   */
  private isForwardRun(start: number, end: number): boolean {
    const run = this.tilesBetween(start, end)
    const positions = run.map(tile => this.order.indexOf(this.tiles.indexOf(tile)))
    for (let i = 1; i < positions.length; i += 1) {
      if (positions[i] !== positions[i - 1] + 1)
        return false
    }
    return true
  }

  /** All boundaries required by [start, end) plus `index` must split cleanly. */
  private boundariesSplittable(points: number[]): boolean {
    return points.every((index) => {
      if (index < 0 || index > this.original.length)
        return false
      const tile = this.containingTile(index)
      return !tile || (!tile.edited || tile.content.length === 0)
    })
  }

  canMove(start: number, end: number, index: number): boolean {
    if (start === end || start >= end)
      return false
    if (start < 0 || end > this.original.length)
      return false
    if (index >= start && index <= end)
      return false
    if (!this.boundariesSplittable([start, end, index]))
      return false
    return this.isForwardRun(start, end)
  }

  move(start: number, end: number, index: number, affinity: 'left' | 'right' = 'right'): void {
    if (!this.canMove(start, end, index))
      throw new Error(`illegal move ${start},${end} -> ${index}`)

    this.split(start)
    this.split(end)
    this.split(index)

    const firstPos = this.tiles.findIndex(tile => tile.start === start)
    const last = this.tiles.find(tile => tile.end === end)!
    const lastPos = this.tiles.indexOf(last)

    const runStart = this.order.indexOf(firstPos)
    const runLength = lastPos - firstPos + 1
    const segment = this.order.splice(runStart, runLength)

    // Collect intro/outro strings attached strictly inside the moved range;
    // they belong to chunks inside the segment and must travel with it.
    const innerRight: string[] = []
    const innerLeft: string[] = []
    for (let k = start + 1; k < end; k += 1) {
      innerRight.push(this.rightAt[k])
      innerLeft.push(this.leftAt[k])
    }

    let newLeft: number | null
    let newRight: number | null
    if (affinity === 'left') {
      const anchorTile = this.tiles.find(tile => tile.end === index)
      newLeft = anchorTile ? this.tiles.indexOf(anchorTile) : null
      if (newLeft === null) {
        if (this.order[0] === firstPos)
          throw new Error('no-op move')
        newRight = this.order[0]
      }
      else {
        const anchorOrder = this.order.indexOf(newLeft)
        if (this.order[anchorOrder + 1] === firstPos)
          throw new Error('no-op move')
        newRight = this.order[anchorOrder + 1] ?? null
      }
    }
    else {
      const anchorTile = this.tiles.find(tile => tile.start === index)
      newRight = anchorTile ? this.tiles.indexOf(anchorTile) : null
      if (newRight === null) {
        if (this.order[this.order.length - 1] === lastPos)
          throw new Error('no-op move')
        newLeft = this.order[this.order.length - 1]
      }
      else {
        const anchorOrder = this.order.indexOf(newRight)
        if (this.order[anchorOrder - 1] === lastPos)
          throw new Error('no-op move')
        newLeft = this.order[anchorOrder - 1] ?? null
      }
    }

    const insertAt = newRight === null
      ? this.order.length
      : this.order.indexOf(newRight)
    this.order.splice(insertAt, 0, ...segment)

    // Relocate the inner boundary strings onto the segment's static slots in
    // order; the boundary values themselves remain indexed by original index,
    // but emission reads them through the tile currently at that index.
    let p = 0
    for (let k = start + 1; k < end; k += 1) {
      this.rightAt[k] = innerRight[p]
      this.leftAt[k] = innerLeft[p]
      p += 1
    }
  }

  canOverwrite(start: number, end: number): boolean {
    if (start >= end || start < 0 || end > this.original.length)
      return false
    if (!this.boundariesSplittable([start, end]))
      return false
    return this.isForwardRun(start, end)
  }

  overwrite(start: number, end: number, content: string, options: EditOptions = {}): void {
    if (!this.canOverwrite(start, end))
      throw new Error(`illegal overwrite ${start},${end}`)

    this.split(start)
    this.split(end)

    if (options.storeName) {
      const name = this.original.slice(start, end)
      if (!this.storedNames.includes(name))
        this.storedNames.push(name)
    }

    const run = this.tilesBetween(start, end)
    const contentOnly = options.contentOnly === true

    run.forEach((tile, i) => {
      tile.edited = true
      tile.content = i === 0 ? content : ''
      tile.name = i === 0 && options.storeName ? this.original.slice(start, end) : null
    })

    if (!contentOnly) {
      // update(): the first tile is edit(content, ..., !overwrite) so it keeps
      // its intro but loses its outro; every following tile loses both intro
      // and outro. The outro at `end` therefore survives (it is the kept
      // intro/outro pair on the last tile's outer edge).
      for (let i = 0; i < run.length - 1; i += 1) {
        this.leftAt[run[i].end] = ''
        this.rightAt[run[i + 1].start] = ''
      }
      if (run.length === 1) {
        // single-tile edit: edit(contentOnly=false) clears intro and outro
        this.rightAt[start] = ''
        this.leftAt[end] = ''
      }
      else {
        this.leftAt[run[run.length - 2].end] = ''
      }
    }
  }

  remove(start: number, end: number): void {
    if (start === end)
      return
    if (start < 0 || end > this.original.length || start > end)
      throw new Error(`range ${start}-${end} out of bounds`)

    this.split(start)
    this.split(end)

    const run = this.tilesBetween(start, end)
    run.forEach((tile) => {
      if (tile.start > start)
        this.rightAt[tile.start] = ''
      if (tile.end < end)
        this.leftAt[tile.end] = ''
      tile.edited = true
      tile.content = ''
      tile.name = null
    })
  }

  addSourcemapLocation(index: number): void {
    this.sourcemapLocations.add(index)
  }

  // ---- indent ----------------------------------------------------------

  indent(indentStr: string, options: { exclude?: Array<[number, number]>, indentStart?: boolean } = {}): void {
    if (indentStr === '')
      return

    const excluded: boolean[] = []
    for (const [start, end] of options.exclude ?? []) {
      for (let i = start; i < end; i += 1)
        excluded[i] = true
    }

    let shouldIndentNextCharacter = options.indentStart !== false

    const pattern = /^[^\r\n]/gm
    const indentPiece = (text: string): string => {
      if (text === '')
        return text
      const result = text.replace(pattern, (match, offset: number) =>
        (offset > 0 || shouldIndentNextCharacter) ? indentStr + match : match)
      shouldIndentNextCharacter = text[text.length - 1] === '\n'
      return result
    }

    this.stringIntro = indentPiece(this.stringIntro)

    const indentAt = (index: number, tile: Tile): void => {
      shouldIndentNextCharacter = false
      if (index === tile.start) {
        this.rightAt[index] += indentStr
      }
      else {
        this.split(index)
        this.rightAt[index] = indentStr + this.rightAt[index]
      }
    }

    let charIndex = 0
    for (const tilePos of this.order) {
      const tile = this.tiles[tilePos]
      const end = tile.end

      if (!excluded[tile.start])
        this.rightAt[tile.start] = indentPiece(this.rightAt[tile.start])

      if (tile.edited) {
        if (!excluded[charIndex])
          tile.content = indentPiece(tile.content)
      }
      else if (options.exclude) {
        charIndex = tile.start
        while (charIndex < end) {
          if (!excluded[charIndex]) {
            const ch = this.original.charCodeAt(charIndex)
            if (ch === 10) {
              shouldIndentNextCharacter = true
            }
            else if (ch !== 13 && shouldIndentNextCharacter) {
              indentAt(charIndex, tile)
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

          const ch = this.original.charCodeAt(charIndex)
          if (ch === 10 || ch === 13) {
            charIndex += 1
            continue
          }

          indentAt(charIndex, tile)
          charIndex += 1
        }
      }

      if (!excluded[tile.end - 1])
        this.leftAt[tile.end] = indentPiece(this.leftAt[tile.end])

      charIndex = tile.end
      if (!options.exclude)
        shouldIndentNextCharacter = false
    }

    this.stringOutro = indentPiece(this.stringOutro)
  }

  // ---- emission with provenance ----------------------------------------

  /**
   * Emits the generated string as lines of provenance units. Every surviving
   * original unit remembers its source index; edit units point at the start of
   * the edited source range; inserts have no source.
   *
   * Units also carry the positions each hires mode must map:
   *   - hires true: every surviving original code unit and each edit line start
   *   - hires boundary: word-boundary starts and each edit line start
   *   - lo-res: source-line starts and addSourcemapLocation positions
   */
  emit(): { text: string, rows: EmittedUnit[][] } {
    const rows: EmittedUnit[][] = [[]]

    const pushInsert = (text: string) => {
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i]
        if (ch === '\n') {
          rows.push([])
          continue
        }
        rows[rows.length - 1].push({ char: ch, origin: { kind: 'insert' }, column: rows[rows.length - 1].length, expectSegment: false })
      }
    }

    const lineOf: number[] = new Array(this.original.length + 1)
    const columnOf: number[] = new Array(this.original.length + 1)
    let srcLine = 0
    let srcColumn = 0
    for (let i = 0; i <= this.original.length; i += 1) {
      lineOf[i] = srcLine
      columnOf[i] = srcColumn
      if (i < this.original.length) {
        if (this.original[i] === '\n') {
          srcLine += 1
          srcColumn = 0
        }
        else {
          srcColumn += 1
        }
      }
    }

    const isWordChar = (code: number) =>
      (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code === 95

    pushInsert(this.stringIntro)

    for (const tilePos of this.order) {
      const tile = this.tiles[tilePos]
      pushInsert(this.rightAt[tile.start])

      const row = () => rows[rows.length - 1]

      if (tile.edited) {
        const content = this.tileContent(tile)
        for (let i = 0; i < content.length; i += 1) {
          const ch = content[i]
          if (ch === '\n') {
            rows.push([])
            continue
          }
          const atLineStart = i === 0 || content[i - 1] === '\n'
          row().push({
            char: ch,
            origin: {
              kind: 'edit',
              line: lineOf[tile.start],
              column: columnOf[tile.start],
              name: tile.name,
            },
            column: row().length,
            expectSegment: atLineStart,
          })
        }
      }
      else {
        let inWord = false
        for (let i = tile.start; i < tile.end; i += 1) {
          const ch = this.original[i]
          if (ch === '\n') {
            inWord = false
            rows.push([])
            continue
          }
          const sourceLineStart = i === 0 || this.original[i - 1] === '\n'
          const lores = sourceLineStart || this.sourcemapLocations.has(i)
          const isWord = isWordChar(ch.charCodeAt(0))
          const boundary = !isWord || !inWord
          inWord = isWord

          row().push({
            char: ch,
            origin: { kind: 'original', index: i },
            column: row().length,
            expectSegment: false,
            lores,
            boundary,
          })
        }
      }

      pushInsert(this.leftAt[tile.end])
    }

    pushInsert(this.stringOutro)

    const text = rows.map(r => r.map(u => u.char).join('')).join('\n')
    return { text, rows }
  }

  toString(): string {
    return this.emit().text
  }
}

export type HiresMode = boolean | 'boundary'

export interface Segment {
  0: number
  1?: number
  2?: number
  3?: number
  4?: number
}

export interface MapCheckOptions {
  hires?: HiresMode
  names?: string[]
}

/**
 * Validates a decoded sourcemap against the provenance model:
 *
 *  1. line count matches the generated output;
 *  2. every segment sits at a generated column that actually originates in the
 *     claimed (source line, column) - inserted text can never be mapped, and
 *     moved/edited content keeps pointing at its original position;
 *  3. name segments reference the expected stored name;
 *  4. every position the given hires mode is expected to map is covered.
 */
export function checkDecodedMap(
  model: ReferenceModel,
  mappings: Segment[][],
  options: MapCheckOptions = {},
): string | null {
  const hires = options.hires ?? false
  const { rows } = model.emit()

  if (mappings.length !== rows.length)
    return `map has ${mappings.length} lines but output has ${rows.length}`

  for (let line = 0; line < mappings.length; line += 1) {
    const segments = mappings[line]
    const units = rows[line]
    let previousColumn = -1

    for (const segment of segments) {
      const generatedColumn = segment[0]
      if (segments.indexOf(segment) > 0 && generatedColumn <= previousColumn)
        return `line ${line}: columns not strictly increasing`
      previousColumn = generatedColumn

      if (generatedColumn >= units.length)
        return `line ${line}: segment column ${generatedColumn} past end of generated line (${units.length})`

      if (segment.length === 1)
        return `line ${line}: unexpected continuation-only segment`

      const unit = units[generatedColumn]
      const origin = unit.origin
      const sourceLine = segment[2]!
      const sourceColumn = segment[3]!

      if (origin.kind === 'insert') {
        return `line ${line} col ${generatedColumn}: segment maps inserted text "${unit.char}" to source ${sourceLine}:${sourceColumn}`
      }

      if (origin.kind === 'original') {
        if (sourceLine !== lineOfIndex(model, origin.index).line || sourceColumn !== lineOfIndex(model, origin.index).column) {
          return `line ${line} col ${generatedColumn}: surviving char "${unit.char}" (original index ${origin.index}) maps to ${sourceLine}:${sourceColumn}, expected ${lineOfIndex(model, origin.index).line}:${lineOfIndex(model, origin.index).column}`
        }
      }
      else if (sourceLine !== origin.line || sourceColumn !== origin.column) {
        return `line ${line} col ${generatedColumn}: edit text maps to ${sourceLine}:${sourceColumn}, expected edit anchor ${origin.line}:${origin.column}`
      }

      if (segment.length >= 5) {
        const nameIndex = segment[4]!
        const names = options.names ?? model.storedNames
        const name = names[nameIndex]
        if (origin.kind !== 'edit' || origin.name !== name) {
          return `line ${line} col ${generatedColumn}: name segment "${name}" does not match edit name "${origin.kind === 'edit' ? origin.name : '<none>'}"`
        }
      }
    }

    // Completeness: every expected position must be at or before the next
    // segment whose generated column is <= that position (segments cover from
    // their column until the next segment).
    // A mapped segment covers columns until the next segment (of any kind).
    let nextMapped = -1
    const coversUpTo: number[] = new Array(segments.length)
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      coversUpTo[i] = nextMapped === -1 ? units.length : segments[nextMapped][0]
      if (segments[i].length >= 4)
        nextMapped = i
    }

    const expected: Array<{ column: number, mode: 'hires' | 'lores' | 'boundary' }> = []
    units.forEach((unit, column) => {
      if (unit.origin.kind === 'insert' || unit.char === '\n')
        return
      if (hires === true)
        expected.push({ column, mode: 'hires' })
      else if (hires === 'boundary') {
        if (unit.origin.kind === 'edit' ? unit.expectSegment : unit.boundary)
          expected.push({ column, mode: 'boundary' })
      }
      else if (unit.origin.kind === 'edit' ? unit.expectSegment : unit.lores) {
        expected.push({ column, mode: 'lores' })
      }
    })

    for (const { column, mode } of expected) {
      const covering = segments.findIndex((segment, i) =>
        segment.length >= 4 && segment[0] <= column && column < coversUpTo[i])
      if (covering === -1) {
        const origin = units[column].origin
        const where = origin.kind === 'original' ? `original index ${origin.index}` : 'edit'
        return `line ${line} col ${column}: ${mode} mapping missing for surviving char "${units[column].char}" (${where})`
      }
    }
  }

  return null
}

function lineOfIndex(model: ReferenceModel, index: number): { line: number, column: number } {
  let line = 0
  let column = 0
  for (let i = 0; i < index; i += 1) {
    if (model.original[i] === '\n') {
      line += 1
      column = 0
    }
    else {
      column += 1
    }
  }
  return { line, column }
}

/** Replays one public operation on the model; throws for contract-illegal ops. */
export function applyOp(model: ReferenceModel, op: Op): void {
  switch (op.type) {
    case 'appendLeft': model.appendLeft(op.index, op.text); break
    case 'prependLeft': model.prependLeft(op.index, op.text); break
    case 'appendRight': model.appendRight(op.index, op.text); break
    case 'prependRight': model.prependRight(op.index, op.text); break
    case 'append': model.append(op.text); break
    case 'prepend': model.prepend(op.text); break
    case 'overwrite': model.overwrite(op.start, op.end, op.text, op.options); break
    case 'remove': model.remove(op.start, op.end); break
    case 'move': model.move(op.start, op.end, op.index, op.affinity); break
    case 'indent': model.indent(op.indentStr, { exclude: op.exclude, indentStart: op.indentStart }); break
    case 'addSourcemapLocation': model.addSourcemapLocation(op.index); break
    case 'clone': throw new Error('clone is handled by the replay harness, not the model')
  }
}
