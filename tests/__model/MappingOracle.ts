/**
 * Independent sourcemap oracle for the character-source model.
 *
 * Reimplements the observable mapping rules described in the public README
 * (hires true / "boundary" / default) without touching the library internals:
 *
 * - unedited content maps generated positions back to their original indices,
 * - inserted content (intros, outros, indentation) emits no segment,
 * - overwritten content emits a single edit segment per emitted line pointing
 *   at the start of the overwritten range,
 * - removed content emits nothing at all,
 * - moved content keeps mapping to its original indices (only walk order moves),
 * - without hires only line starts and addSourcemapLocation positions map.
 */
import type { GeneratedCell, HiresMode } from './EditModel.ts'
import type { EditModel } from './EditModel.ts'

export interface ExpectedSegment {
  col: number
  source: number
  line: number
  column: number
  name?: number
}

export interface ExpectedDecodedMap {
  sources: string[]
  sourcesContent: string[] | undefined
  names: string[]
  mappings: ExpectedSegment[][]
}

interface Loc {
  line: number
  column: number
}

function buildLocator(original: string): (index: number) => Loc {
  const starts: number[] = [0]
  for (let i = 0; i < original.length; i += 1) {
    if (original.charCodeAt(i) === 10)
      starts.push(i + 1)
  }
  return (index: number) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= index)
        lo = mid
      else
        hi = mid - 1
    }
    return { line: lo, column: index - starts[lo] }
  }
}

const LF = 10
const CR = 13

function isWordCode(code: number): boolean {
  return (code >= 97 && code <= 122)
    || (code >= 65 && code <= 90)
    || (code >= 48 && code <= 57)
    || code === 95
}

interface OracleItem {
  start: number
  end: number
  content: string
  edited: boolean
  storeName: boolean
  intro: string
  outro: string
  /** original slice stored at edit time (name provenance) */
  originalSlice: string
}

class Emitter {
  segments: ExpectedSegment[][] = [[]]
  cells: GeneratedCell[][] = [[]]
  textLines: string[] = ['']
  line = 0
  column = 0

  private newline(): void {
    this.segments.push([])
    this.cells.push([])
    this.textLines.push('')
    this.line += 1
    this.column = 0
  }

  private cell(cell: GeneratedCell, isNewline: boolean): void {
    this.cells[this.line].push(cell)
    if (isNewline)
      this.newline()
    else
      this.column += 1
  }

  private char(cell: GeneratedCell, char: string): void {
    this.cells[this.line].push(cell)
    if (char === '\n') {
      this.textLines[this.line] += char
      this.newline()
    }
    else {
      this.textLines[this.line] += char
      this.column += 1
    }
  }

  /** inserted text: advance without mapping */
  inserted(str: string): void {
    for (let i = 0; i < str.length; i += 1)
      this.char({ type: 'insert' }, str[i])
  }

  /** edited content: a segment on every emitted line start, all at range start */
  edited(str: string, loc: Loc, nameIndex: number, originalIndex: number): void {
    if (str.length === 0)
      return
    const named = nameIndex >= 0
    let lineStart = 0
    for (let i = 0; i < str.length; i += 1) {
      if (i === lineStart) {
        const segment: ExpectedSegment = {
          col: this.column,
          source: 0,
          line: loc.line,
          column: loc.column,
        }
        if (named)
          segment.name = nameIndex
        this.segments[this.line].push(segment)
      }
      this.char({ type: 'edit', originalIndex, named }, str[i])
      if (str.charCodeAt(i) === LF)
        lineStart = i + 1
    }
  }

  /** unedited original chunk - independent port of the public hires semantics */
  unedited(item: OracleItem, original: string, hires: HiresMode, locations: Set<number>, locate: (i: number) => Loc): void {
    const boundary = hires === 'boundary'
    let i = item.start
    const end = item.end
    let loc = locate(i)

    if (hires) {
      let inBoundary = false
      while (i < end) {
        const code = original.charCodeAt(i)
        if (code === LF) {
          this.char({ type: 'src', originalIndex: i }, '\n')
          loc = { line: loc.line + 1, column: 0 }
          inBoundary = false
        }
        else {
          if (boundary) {
            if (isWordCode(code)) {
              if (!inBoundary) {
                this.segments[this.line].push({ col: this.column, source: 0, line: loc.line, column: loc.column })
                inBoundary = true
              }
            }
            else {
              this.segments[this.line].push({ col: this.column, source: 0, line: loc.line, column: loc.column })
              inBoundary = false
            }
          }
          else {
            this.segments[this.line].push({ col: this.column, source: 0, line: loc.line, column: loc.column })
          }
          this.char({ type: 'src', originalIndex: i }, original[i])
          loc = { line: loc.line, column: loc.column + 1 }
        }
        i += 1
      }
      return
    }

    // lo-res: one segment per line start within the chunk, plus explicit locations
    while (i < end) {
      let newline = original.indexOf('\n', i)
      if (newline === -1 || newline > end)
        newline = end
      if (newline > i) {
        const startLoc = locate(i)
        this.segments[this.line].push({ col: this.column, source: 0, line: startLoc.line, column: startLoc.column })
        for (const index of locations) {
          if (index > i && index < newline) {
            const l = locate(index)
            this.segments[this.line].push({
              col: this.column + (index - i),
              source: 0,
              line: l.line,
              column: l.column,
            })
          }
        }
        for (let c = i; c < newline; c += 1) {
          this.char({ type: 'src', originalIndex: c }, original[c])
          loc = { line: loc.line, column: loc.column + 1 }
        }
      }
      if (newline === end)
        break
      this.char({ type: 'src', originalIndex: newline }, '\n')
      loc = { line: loc.line + 1, column: 0 }
      i = newline + 1
    }
  }
}

export interface OracleResult {
  map: ExpectedDecodedMap
  provenance: { text: string, cells: GeneratedCell[] }[]
}

export function expectedOutput(model: EditModel, hires: HiresMode, includeContent = true): OracleResult {
  const emitter = new Emitter()
  const locate = buildLocator(model.original)

  if (model.intro)
    emitter.inserted(model.intro)

  for (const item of model.items) {
    if (item.intro)
      emitter.inserted(item.intro)
    if (item.edited) {
      const nameIndex = item.storeName ? model.names.indexOf(item.original) : -1
      emitter.edited(item.content, locate(item.start), nameIndex, item.start)
    }
    else {
      emitter.unedited(item, model.original, hires, model.sourcemapLocations, locate)
    }
    if (item.outro)
      emitter.inserted(item.outro)
  }

  if (model.outro)
    emitter.inserted(model.outro)

  return {
    map: {
      sources: ['source.js'],
      sourcesContent: includeContent ? [model.original] : undefined,
      names: [...model.names],
      mappings: emitter.segments,
    },
    provenance: emitter.cells.map((cells, i) => ({
      text: emitter.textLines[i],
      cells,
    })),
  }
}
