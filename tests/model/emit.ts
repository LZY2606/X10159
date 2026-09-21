import type { ReferenceModel } from './referenceModel.ts'

export type Provenance
  = { kind: 'original', index: number }
    | { kind: 'insert' }

export interface Piece {
  /** emitted text */
  text: string
  /** provenance per UTF-16 unit of `text` */
  tags: Provenance[]
  /** present for edited chunks: the original index the edit maps from */
  editOrigin?: number
  /** present for unedited chunks: original half-open interval */
  raw?: [number, number]
}

const NEWLINE = 10

function plain(text: string): Piece | null {
  if (!text.length)
    return null
  return { text, tags: Array.from({ length: text.length }, () => ({ kind: 'insert' }) as Provenance) }
}

/** The model's output, as an ordered list of pieces carrying provenance. */
export function pieces(model: ReferenceModel): Piece[] {
  const out: Piece[] = []
  const head = plain(model.intro)
  if (head)
    out.push(head)

  for (const id of model.order) {
    const chunk = model.byId(id)
    const intro = plain(chunk.intro)
    if (intro)
      out.push(intro)

    if (chunk.edited) {
      if (chunk.content.length) {
        out.push({
          text: chunk.content,
          tags: Array.from({ length: chunk.content.length }, () => ({
            kind: 'original',
            index: chunk.start,
          })),
          editOrigin: chunk.start,
        })
      }
    }
    else {
      const text = model.original.slice(chunk.start, chunk.end)
      const tags: Provenance[] = []
      for (let index = chunk.start; index < chunk.end; index++)
        tags.push({ kind: 'original', index })
      out.push({ text, tags, raw: [chunk.start, chunk.end] })
    }

    const outro = plain(chunk.outro)
    if (outro)
      out.push(outro)
  }

  const tail = plain(model.outro)
  if (tail)
    out.push(tail)

  return out
}

export function outputText(list: Piece[]): string {
  return list.map(piece => piece.text).join('')
}

export type HiresMode = boolean | 'boundary'

type Segment = number[]

/**
 * Builds the expected decoded `mappings` field independently of the library,
 * following the public mapping contract (lores/hires/boundary).
 */
export function expectedMappings(
  model: ReferenceModel,
  list: Piece[],
  hires: HiresMode,
): Segment[][] {
  const original = model.original
  const lines: Segment[][] = [[]]
  let line = 0
  let generatedColumn = 0
  let sourceLine = 0
  let sourceColumn = 0

  const ensureLine = (index: number) => {
    while (lines.length <= index)
      lines.push([])
  }

  const locatorLineStarts = [0]
  for (let i = 0; i < original.length; i++) {
    if (original.charCodeAt(i) === NEWLINE)
      locatorLineStarts.push(i + 1)
  }
  const locate = (index: number): { line: number, column: number } => {
    let lo = 0
    let hi = locatorLineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (locatorLineStarts[mid] <= index)
        lo = mid
      else
        hi = mid - 1
    }
    return { line: lo, column: index - locatorLineStarts[lo] }
  }

  const nameIndex = (chunkStart: number): number => {
    // the library emits a name only for single-chunk overwrites whose
    // storeName survived and whose recorded key is the chunk's original text
    const chunk = model.byStart(chunkStart)!
    if (!chunk.storeName)
      return -1
    return model.names.indexOf(original.slice(chunk.start, chunk.end))
  }

  const advance = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === NEWLINE) {
        line += 1
        ensureLine(line)
        generatedColumn = 0
      }
      else {
        generatedColumn += 1
      }
    }
  }

  const addEdit = (piece: Piece) => {
    const loc = locate(piece.editOrigin!)
    let contentLineEnd = piece.text.indexOf('\n', 0)
    const last = piece.text.length - 1
    let previous = -1
    const ni = nameIndex(piece.editOrigin!)
    while (contentLineEnd >= 0 && last > contentLineEnd) {
      const seg: Segment = [generatedColumn, 0, loc.line, loc.column]
      if (ni >= 0)
        seg.push(ni)
      lines[line].push(seg)
      line += 1
      ensureLine(line)
      generatedColumn = 0
      previous = contentLineEnd
      contentLineEnd = piece.text.indexOf('\n', contentLineEnd + 1)
    }
    const seg: Segment = [generatedColumn, 0, loc.line, loc.column]
    if (ni >= 0)
      seg.push(ni)
    lines[line].push(seg)
    advance(piece.text.slice(previous + 1))
  }

  const isWordCode = (code: number): boolean =>
    (code >= 97 && code <= 122)
    || (code >= 65 && code <= 90)
    || (code >= 48 && code <= 57)
    || code === 95

  const addRawRun = (piece: Piece) => {
    const [start, end] = piece.raw!
    let i = start
    const loc = locate(start)
    sourceLine = loc.line
    sourceColumn = loc.column

    if (hires) {
      const boundary = hires === 'boundary'
      let inWord = false
      while (i < end) {
        const code = original.charCodeAt(i)
        if (code === NEWLINE) {
          sourceLine += 1
          sourceColumn = 0
          line += 1
          ensureLine(line)
          generatedColumn = 0
          inWord = false
        }
        else {
          if (boundary) {
            if (isWordCode(code)) {
              if (!inWord) {
                lines[line].push([generatedColumn, 0, sourceLine, sourceColumn])
                inWord = true
              }
            }
            else {
              lines[line].push([generatedColumn, 0, sourceLine, sourceColumn])
              inWord = false
            }
          }
          else {
            lines[line].push([generatedColumn, 0, sourceLine, sourceColumn])
          }
          sourceColumn += 1
          generatedColumn += 1
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
          lines[line].push([generatedColumn, 0, sourceLine, sourceColumn])
          for (let location = i + 1; location < newline; location++) {
            if (model.locations.has(location)) {
              lines[line].push([
                generatedColumn + (location - i),
                0,
                sourceLine,
                sourceColumn + (location - i),
              ])
            }
          }
          sourceColumn += newline - i
          generatedColumn += newline - i
        }
        if (newline === end)
          break
        sourceLine += 1
        sourceColumn = 0
        line += 1
        ensureLine(line)
        generatedColumn = 0
        i = newline + 1
      }
    }
  }

  for (const piece of list) {
    if (piece.raw) {
      addRawRun(piece)
    }
    else if (piece.editOrigin !== undefined) {
      addEdit(piece)
    }
    else {
      advance(piece.text)
    }
  }

  return lines
}

export interface ProvenanceViolation {
  line: number
  column: number
  expected: string
  actual: string
}

/**
 * Verifies the inverse mapping invariants directly:
 * - unmodified and moved characters map back to their own original index;
 * - inserted characters have no segment pointing at them;
 * - deleted originals produce no generated segment.
 */
export function checkProvenance(
  model: ReferenceModel,
  list: Piece[],
  actual: Segment[][],
): ProvenanceViolation | null {
  // reconstruct (line, column) provenance for every generated unit
  const grid = new Map<string, Provenance>()
  let line = 0
  let column = 0
  for (const piece of list) {
    for (let i = 0; i < piece.text.length; i++) {
      if (piece.text.charCodeAt(i) === NEWLINE) {
        line += 1
        column = 0
      }
      else {
        grid.set(`${line}:${column}`, piece.tags[i])
        column += 1
      }
    }
  }

  const locatorLineStarts = [0]
  for (let i = 0; i < model.original.length; i++) {
    if (model.original.charCodeAt(i) === NEWLINE)
      locatorLineStarts.push(i + 1)
  }
  const locate = (index: number): [number, number] => {
    let lo = 0
    let hi = locatorLineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (locatorLineStarts[mid] <= index)
        lo = mid
      else
        hi = mid - 1
    }
    return [lo, index - locatorLineStarts[lo]]
  }

  for (let segLine = 0; segLine < actual.length; segLine++) {
    for (const segment of actual[segLine]) {
      if (segment.length < 4)
        continue
      const key = `${segLine}:${segment[0]}`
      const tag = grid.get(key)
      if (!tag) {
        return {
          line: segLine,
          column: segment[0],
          expected: 'no character / insertion',
          actual: `segment claims source ${segment[2]}:${segment[3]}`,
        }
      }
      if (tag.kind === 'insert') {
        return {
          line: segLine,
          column: segment[0],
          expected: 'inserted character (no source)',
          actual: `segment claims source ${segment[2]}:${segment[3]}`,
        }
      }
      const [sl, sc] = locate(tag.index)
      if (segment[2] !== sl || segment[3] !== sc) {
        return {
          line: segLine,
          column: segment[0],
          expected: `original index ${tag.index} (${sl}:${sc})`,
          actual: `source ${segment[2]}:${segment[3]}`,
        }
      }
    }
  }

  return null
}
