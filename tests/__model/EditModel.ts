/**
 * Independent character-source model for MagicString.
 *
 * This file deliberately mirrors only the *documented public contract* of
 * MagicString (insertion anchoring, overwrite/remove of original ranges,
 * reordering with move, line indentation and sourcemap emission). It never
 * imports the library's internal Chunk/linked-list implementation, so it can
 * act as an independent oracle in property tests.
 *
 * The model tracks a tiled list of "items" over the original indices. Every
 * item is either a live slice of original characters, an edited replacement or
 * a removed (empty) range. Each item also carries two insertion slots matching
 * the public left/right anchoring rules:
 *
 *   intro = prependRight content (emitted before the item's content)
 *   outro = appendLeft  content (emitted after the item's content)
 */

export type HiresMode = boolean | 'boundary'

export type ExclusionRange = [number, number]

export interface InsertOp {
  kind: 'appendLeft' | 'prependRight' | 'appendRight' | 'prependLeft'
  index: number
  content: string
}

export interface RemoveOp {
  kind: 'remove'
  start: number
  end: number
}

export interface OverwriteOp {
  kind: 'overwrite'
  start: number
  end: number
  content: string
  storeName?: boolean
}

export interface MoveOp {
  kind: 'move'
  start: number
  end: number
  index: number
  affinity?: 'left' | 'right'
}

export interface IndentOp {
  kind: 'indent'
  indentStr: string
  exclude?: ExclusionRange[]
  indentStart?: boolean
}

export interface LocationOp {
  kind: 'addSourcemapLocation'
  index: number
}

export type EditOp = InsertOp | RemoveOp | OverwriteOp | MoveOp | IndentOp | LocationOp

interface Item {
  start: number
  end: number
  /** the slice of the original string this item was born from */
  original: string
  /** current emitted content (=== original for untouched items, '' for removed) */
  content: string
  edited: boolean
  storeName: boolean
  intro: string
  outro: string
}

export type GeneratedCell =
  | { type: 'src'; originalIndex: number }
  | { type: 'edit'; originalIndex: number; named: boolean }
  | { type: 'insert' }

/**
 * One line of the generated output with a provenance cell per code unit, so
 * tests can check exactly which original position every generated position
 * maps to.
 */
export interface ProvenanceLine {
  text: string
  cells: GeneratedCell[]
}

function wordCode(code: number): boolean {
  return (code >= 97 && code <= 122)
    || (code >= 65 && code <= 90)
    || (code >= 48 && code <= 57)
    || code === 95
}

export class EditModel {
  original: string
  intro = ''
  outro = ''
  /** emission order (move() reorders this array) */
  items: Item[]
  byStart = new Map<number, Item>()
  byEnd = new Map<number, Item>()
  sourcemapLocations = new Set<number>()
  /** stored names in first-write order */
  names: string[] = []
  hasMoved = false

  constructor(original: string) {
    this.original = original
    const seed: Item = {
      start: 0,
      end: original.length,
      original,
      content: original,
      edited: false,
      storeName: false,
      intro: '',
      outro: '',
    }
    this.items = original.length === 0 ? [] : [seed]
    if (original.length) {
      this.byStart.set(0, seed)
      this.byEnd.set(original.length, seed)
    }
  }

  /** items in original (tiling) order regardless of move reordering */
  tiled(): Item[] {
    return [...this.items].sort((a, b) => a.start - b.start)
  }

  private rebuildBoundaryMaps(): void {
    this.byStart.clear()
    this.byEnd.clear()
    for (const item of this.items) {
      this.byStart.set(item.start, item)
      this.byEnd.set(item.end, item)
    }
  }

  /**
   * Splitting is illegal at the interior of a non-empty edit. Empty edited
   * items are allowed to split (overlapping replacements special case).
   */
  canSplit(index: number): boolean {
    const item = this.tiled().find(i => index > i.start && index < i.end)
    if (!item)
      return true
    return !(item.edited && item.content.length > 0)
  }

  private split(index: number): void {
    if (this.byStart.has(index) || this.byEnd.has(index))
      return
    const order = this.items
    const pos = order.findIndex(i => index > i.start && index < i.end)
    if (pos === -1)
      return
    const item = order[pos]
    const cut = index - item.start
    const left: Item = {
      start: item.start,
      end: index,
      original: item.original.slice(0, cut),
      content: item.edited ? '' : item.content.slice(0, cut),
      edited: item.edited,
      storeName: false,
      intro: item.intro,
      outro: '',
    }
    const right: Item = {
      start: index,
      end: item.end,
      original: item.original.slice(cut),
      content: item.edited ? '' : item.content.slice(cut),
      edited: item.edited,
      storeName: false,
      intro: '',
      outro: item.outro,
    }
    order.splice(pos, 1, left, right)
    this.rebuildBoundaryMaps()
  }

  canApply(op: EditOp): boolean {
    switch (op.kind) {
      case 'appendLeft':
      case 'appendRight':
      case 'prependRight':
      case 'prependLeft':
      case 'addSourcemapLocation':
        return op.index >= 0 && op.index <= this.original.length
      case 'remove':
        return this.legalRange(op.start, op.end)
          && this.canSplit(op.start)
          && this.canSplit(op.end)
      case 'overwrite':
        return this.legalRange(op.start, op.end)
          && op.start !== op.end
          && this.canSplit(op.start)
          && this.canSplit(op.end)
          && this.tiledContiguous(op.start, op.end)
      case 'move': {
        if (!this.legalRange(op.start, op.end))
          return false
        if (op.start === op.end)
          return true
        const { start, end, index } = op
        if (index >= start && index <= end)
          return false
        if (index < 0 || index > this.original.length)
          return false
        if (!this.canSplit(start) || !this.canSplit(end) || !this.canSplit(index))
          return false
        if (this.hasMoved && !this.chainContiguous(start, end))
          return false
        return true
      }
      case 'indent':
        return true
    }
  }

  private legalRange(start: number, end: number): boolean {
    if (start > end)
      return false
    if (start < 0 || end < 0)
      return false
    return end <= this.original.length
  }

  /** overwrite needs a forward run of tiled neighbours (no move-split boundary inside) */
  private tiledContiguous(start: number, end: number): boolean {
    const run = this.tiled().filter(i => i.start >= start && i.end <= end)
    if (run.length === 0 || run[0].start !== start || run[run.length - 1].end !== end)
      return false
    for (let i = 1; i < run.length; i++) {
      if (run[i - 1].end !== run[i].start)
        return false
    }
    // adjacency in the current emission order must match tiling adjacency
    for (let i = 1; i < run.length; i++) {
      if (this.items.indexOf(run[i]) !== this.items.indexOf(run[i - 1]) + 1)
        return false
    }
    return true
  }

  /** move needs the run to be contiguous in the current (possibly reordered) chain */
  private chainContiguous(start: number, end: number): boolean {
    const firstPos = this.items.findIndex(i => i.start === start)
    if (firstPos === -1)
      return false
    let pos = firstPos
    while (this.items[pos].end !== end) {
      pos += 1
      const item = this.items[pos]
      if (!item || item.start < start || item.end > end)
        return false
    }
    return true
  }

  apply(op: EditOp): void {
    switch (op.kind) {
      case 'appendLeft':
      case 'prependLeft': {
        const { index, content } = op
        this.split(index)
        const item = this.byEnd.get(index)
        if (item) {
          if (op.kind === 'appendLeft')
            item.outro += content
          else
            item.outro = content + item.outro
        }
        else if (op.kind === 'appendLeft') {
          this.intro += content
        }
        else {
          this.intro = content + this.intro
        }
        return
      }
      case 'appendRight':
      case 'prependRight': {
        const { index, content } = op
        this.split(index)
        const item = this.byStart.get(index)
        if (item) {
          if (op.kind === 'appendRight')
            item.intro = item.intro + content
          else
            item.intro = content + item.intro
        }
        else if (op.kind === 'appendRight') {
          this.outro += content
        }
        else {
          this.outro = content + this.outro
        }
        return
      }
      case 'remove':
        this.doRemove(op.start, op.end)
        return
      case 'overwrite':
        this.doOverwrite(op.start, op.end, op.content, !!op.storeName)
        return
      case 'move':
        this.doMove(op.start, op.end, op.index, op.affinity ?? 'right')
        return
      case 'indent':
        this.doIndent(op.indentStr, op.exclude ?? [], op.indentStart ?? true)
        return
      case 'addSourcemapLocation':
        this.sourcemapLocations.add(op.index)
        return
    }
  }

  private doRemove(start: number, end: number): void {
    if (start === end)
      return
    this.split(start)
    this.split(end)
    for (const item of this.tiled()) {
      if (item.start >= start && item.end <= end) {
        if (item.start > start)
          item.intro = ''
        if (item.end < end)
          item.outro = ''
        item.content = ''
        item.edited = true
        item.storeName = false
      }
    }
  }

  private doOverwrite(start: number, end: number, content: string, storeName: boolean): void {
    this.split(start)
    this.split(end)
    if (storeName) {
      const name = this.original.slice(start, end)
      if (!this.names.includes(name))
        this.names.push(name)
    }
    const run = this.tiled().filter(i => i.start >= start && i.end <= end)
    run.forEach((item, i) => {
      item.intro = ''
      item.outro = ''
      if (i === 0) {
        item.content = content
        item.edited = true
        item.storeName = storeName
      }
      else {
        item.content = ''
        item.edited = true
        item.storeName = false
      }
    })
  }

  private doMove(start: number, end: number, index: number, affinity: 'left' | 'right'): void {
    if (start === end)
      return
    this.split(start)
    this.split(end)
    this.split(index)

    const order = this.items
    const firstPos = order.findIndex(i => i.start === start)
    let lastPos = firstPos
    while (order[lastPos].end !== end)
      lastPos += 1
    const moved = order.slice(firstPos, lastPos + 1)

    if (affinity === 'left') {
      const anchor = this.byEnd.get(index)
      if (!anchor) {
        if (firstPos === 0)
          return
      }
      else if (order[order.indexOf(anchor) + 1] === moved[0]) {
        return
      }
    }
    else {
      const anchor = this.byStart.get(index)
      if (!anchor) {
        if (lastPos === order.length - 1)
          return
      }
      else if (order[order.indexOf(anchor) - 1] === moved[moved.length - 1]) {
        return
      }
    }

    order.splice(firstPos, moved.length)

    let insertPos: number
    if (affinity === 'left') {
      const anchor = this.byEnd.get(index)
      insertPos = anchor ? order.indexOf(anchor) + 1 : 0
    }
    else {
      const anchor = this.byStart.get(index)
      insertPos = anchor ? order.indexOf(anchor) : order.length
    }
    order.splice(insertPos, 0, ...moved)
    this.hasMoved = true
  }

  toString(): string {
    let str = this.intro
    for (const item of this.items)
      str += item.intro + item.content + item.outro
    return str + this.outro
  }

  /**
   * Port of the observable semantics of MagicString#indent, operating on the
   * model instead of the library's chunks. Kept structurally close to the
   * public behaviour: every line start gets the indent string, excluded
   * original ranges are skipped, and the "should indent next character" flag
   * is shared across intro/content/outro pieces in emission order.
   */
  private doIndent(indentStr: string, exclusions: ExclusionRange[], indentStart: boolean): void {
    if (indentStr === '')
      return

    const isExcluded = new Set<number>()
    for (const [start, end] of exclusions) {
      for (let i = start; i < end; i += 1)
        isExcluded.add(i)
    }

    let shouldIndentNextCharacter = indentStart

    const indentPiece = (str: string): string => {
      if (str === '')
        return str
      const indented = str.replace(/^[^\n]/gm, (match, offset: number) =>
        offset > 0 || shouldIndentNextCharacter ? `${indentStr}${match}` : match)
      shouldIndentNextCharacter = str[str.length - 1] === '\n'
      return indented
    }

    this.intro = indentPiece(this.intro)

    let charIndex = 0
    let p = 0

    while (this.items[p]) {
      let chunk = this.items[p]
      const end = chunk.end

      const indentAt = (index: number): void => {
        shouldIndentNextCharacter = false
        if (index === chunk.start) {
          // appendRight, not prependRight: lands in front of content but
          // behind an already-indented intro
          chunk.intro = chunk.intro + indentStr
        }
        else {
          this.split(index)
          chunk = this.byStart.get(index)!
        }
      }

      if (!isExcluded.has(chunk.start))
        chunk.intro = indentPiece(chunk.intro)

      if (chunk.edited) {
        if (!isExcluded.has(charIndex))
          chunk.content = indentPiece(chunk.content)
      }
      else if (exclusions.length > 0) {
        charIndex = chunk.start

        while (charIndex < end) {
          if (!isExcluded.has(charIndex)) {
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

      if (!isExcluded.has(chunk.end - 1))
        chunk.outro = indentPiece(chunk.outro)

      charIndex = chunk.end
      p = this.items.indexOf(chunk) + 1
    }

    this.outro = indentPiece(this.outro)
  }
}
