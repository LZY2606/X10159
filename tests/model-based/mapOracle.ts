// Decoded-map oracle: emits a decoded source map straight from the provenance
// model's groups, using the documented segment policy (hires true / boundary /
// lo-res + addSourcemapLocation) without reading any library internals.

import type { SourceMapSegment } from '../../src/SourceMap.ts'
import type { Group, SourceModel } from './sourceModel.ts'

export type Hires = boolean | 'boundary'

const NEWLINE = 10

function isWordCode(code: number): boolean {
  return (code >= 97 && code <= 122)
    || (code >= 65 && code <= 90)
    || (code >= 48 && code <= 57)
    || code === 95
}

function locate(original: string, index: number): [number, number] {
  let line = 0
  let column = 0
  for (let i = 0; i < index; i += 1) {
    if (original.charCodeAt(i) === NEWLINE) {
      line += 1
      column = 0
    }
    else {
      column += 1
    }
  }
  return [line, column]
}

class MapOracle {
  line = 0
  column = 0
  raw: SourceMapSegment[][] = [[]]

  nextLine(): void {
    this.line += 1
    this.column = 0
    this.raw[this.line] = []
  }

  advance(str: string): void {
    if (!str)
      return
    for (let i = str.indexOf('\n'); i !== -1; i = str.indexOf('\n', i + 1))
      this.nextLine()
    this.column += str.length - str.lastIndexOf('\n') - 1
  }

  private push(sourceLine: number, sourceColumn: number, nameIndex: number): void {
    const segment: SourceMapSegment = nameIndex >= 0
      ? [this.column, 0, sourceLine, sourceColumn, nameIndex]
      : [this.column, 0, sourceLine, sourceColumn]
    this.raw[this.line].push(segment)
  }

  edit(content: string, sourceLine: number, sourceColumn: number, nameIndex: number): void {
    if (!content.length)
      return

    let lineEnd = content.indexOf('\n')
    let previousLineEnd = -1
    // one segment at the start of each source line the edit spans
    while (lineEnd >= 0 && content.length - 1 > lineEnd) {
      this.push(sourceLine, sourceColumn, nameIndex)
      this.nextLine()
      previousLineEnd = lineEnd
      lineEnd = content.indexOf('\n', lineEnd + 1)
    }
    this.push(sourceLine, sourceColumn, nameIndex)
    this.advance(content.slice(previousLineEnd + 1))
  }

  unedited(
    group: Group,
    original: string,
    locations: Set<number>,
    hires: Hires,
  ): void {
    let [sourceLine, sourceColumn] = locate(original, group.start)
    let i = group.start

    if (hires) {
      const boundary = hires === 'boundary'
      let inWord = false

      while (i < group.end) {
        const code = original.charCodeAt(i)
        if (code === NEWLINE) {
          this.nextLine()
          sourceLine += 1
          sourceColumn = 0
          inWord = false
        }
        else {
          const word = isWordCode(code)
          if (boundary) {
            // one segment for the first char of a word run, and one for every
            // non-word character
            if (word ? !inWord : true)
              this.push(sourceLine, sourceColumn, -1)
            inWord = word
          }
          else {
            this.push(sourceLine, sourceColumn, -1)
          }
          this.column += 1
          sourceColumn += 1
        }
        i += 1
      }
    }
    else {
      // lo-res: one segment at the group's first char of each line, plus any
      // positions registered with addSourcemapLocation()
      while (i < group.end) {
        let newline = original.indexOf('\n', i)
        if (newline === -1 || newline > group.end)
          newline = group.end

        if (newline > i) {
          this.push(sourceLine, sourceColumn, -1)
          for (let index = i + 1; index < newline; index += 1) {
            if (locations.has(index)) {
              const [l, c] = locate(original, index)
              this.raw[this.line].push([this.column + index - i, 0, l, c])
            }
          }
          this.column += newline - i
          sourceColumn += newline - i
        }

        if (newline === group.end)
          break
        this.nextLine()
        sourceLine += 1
        sourceColumn = 0
        i = newline + 1
      }
    }
  }
}

/** Expected `mappings` for the model with hires true / "boundary" / false. */
export function expectedMappings(model: SourceModel, hires: Hires): SourceMapSegment[][] {
  const oracle = new MapOracle()
  const names = [...model.storedNames.keys()]

  oracle.advance(model.intro)

  for (const group of model.order) {
    oracle.advance(group.intro)
    if (group.edited) {
      const [line, column] = locate(model.original, group.start)
      const nameIndex = group.edit!.storeName && group.originalName !== undefined
        ? names.indexOf(group.originalName)
        : -1
      oracle.edit(group.edit!.content, line, column, nameIndex)
    }
    else {
      oracle.unedited(group, model.original, model.sourcemapLocations, hires)
    }
    oracle.advance(group.outro)
  }

  oracle.advance(model.outro)

  return oracle.raw
}

export function expectedNames(model: SourceModel): string[] {
  return [...model.storedNames.keys()]
}
