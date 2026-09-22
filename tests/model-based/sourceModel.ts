// Independent character-provenance model for MagicString.
//
// This is deliberately *not* a mirror of the library's Chunk implementation:
// it models only the public editing contract — a tiling of the original code
// units into groups, ordered lists of inserted text at the boundaries, and the
// effects the documented operations have on them. The map oracle then emits
// decoded mappings straight from the provenance of every emitted character.

export interface EditRecord {
  content: string
  storeName: boolean
}

/** A contiguous range of original code units ([start, end)) plus its inserts. */
export interface Group {
  start: number
  end: number
  intro: string
  outro: string
  edited: boolean
  removed: boolean
  edit?: EditRecord
  originalName?: string
}

type Side = 'intro' | 'outro'
type Order = 'append' | 'prepend'

export class SourceModel {
  readonly original: string
  /** Index of each group by its *original-coordinate* start. */
  byStart = new Map<number, Group>()
  /** Emission order; move() reorders this array without touching byStart. */
  order: Group[] = []
  intro = ''
  outro = ''
  readonly sourcemapLocations = new Set<number>()
  readonly storedNames = new Map<string, true>()
  hasMoved = false

  constructor(original: string) {
    this.original = original
    if (original.length > 0) {
      const group: Group = {
        start: 0,
        end: original.length,
        intro: '',
        outro: '',
        edited: false,
        removed: false,
      }
      this.byStart.set(0, group)
      this.order = [group]
    }
  }

  // ---- basic queries -------------------------------------------------------

  private groupContaining(index: number): Group {
    let result: Group | undefined
    for (const start of this.byStart.keys()) {
      if (start < index) {
        if (!result || start > result.start)
          result = this.byStart.get(start)
      }
    }
    return result ?? this.byStart.get(0)!
  }

  private split(index: number): void {
    if (this.byStart.has(index) || index === 0 || index === this.original.length)
      return

    const group = this.groupContaining(index)
    if (group.edited && group.edit!.content.length > 0)
      throw new Error('cannot split a chunk that has already been edited')

    const before: Group = {
      start: group.start,
      end: index,
      intro: group.intro,
      outro: '',
      edited: group.edited,
      removed: group.removed,
      edit: group.edit,
      originalName: group.originalName,
    }
    const after: Group = {
      start: index,
      end: group.end,
      intro: '',
      outro: group.outro,
      edited: group.edited,
      removed: group.removed,
      edit: group.edited ? { content: '', storeName: false } : undefined,
    }

    const orderIndex = this.order.indexOf(group)
    this.order.splice(orderIndex, 1, before, after)
    this.byStart.delete(group.start)
    this.byStart.set(before.start, before)
    this.byStart.set(after.start, after)
  }

  private coordNext(group: Group): Group | undefined {
    return this.byStart.get(group.end)
  }

  // ---- inserts -------------------------------------------------------------

  private insertAt(index: number, side: Side, order: Order, content: string): void {
    if (index === 0) {
      // Boundary 0: every insertion variant lands in the string-level intro.
      this.intro = order === 'append' ? this.intro + content : content + this.intro
      return
    }
    if (index === this.original.length) {
      // Boundary n: every insertion variant lands in the string-level outro.
      this.outro = order === 'append' ? this.outro + content : content + this.outro
      return
    }

    this.split(index)

    if (side === 'intro') {
      // Attached to the chunk *starting* at index.
      const group = this.byStart.get(index)!
      group.intro = order === 'append' ? group.intro + content : content + group.intro
    }
    else {
      // Attached to the chunk *ending* at index.
      const group = this.groupContaining(index)
      group.outro = order === 'append' ? group.outro + content : content + group.outro
    }
  }

  appendLeft(index: number, content: string): void {
    this.insertAt(index, 'outro', 'append', content)
  }

  prependLeft(index: number, content: string): void {
    this.insertAt(index, 'outro', 'prepend', content)
  }

  appendRight(index: number, content: string): void {
    this.insertAt(index, 'intro', 'append', content)
  }

  prependRight(index: number, content: string): void {
    this.insertAt(index, 'intro', 'prepend', content)
  }

  // ---- remove / overwrite --------------------------------------------------

  /** Forward-contiguous groups covering [start, end) in emission order. */
  private coveringGroups(start: number, end: number): Group[] {
    const first = this.byStart.get(start)
    let last: Group | undefined
    for (const group of this.byStart.values()) {
      if (group.end === end)
        last = group
    }
    if (!first || !last)
      throw new Error('split point missing')

    const result: Group[] = [first]
    let group: Group = first
    while (group !== last) {
      const coordinateNext = this.coordNext(group)
      const emissionNext = this.order[this.order.indexOf(group) + 1]
      if (coordinateNext !== emissionNext || !coordinateNext || coordinateNext.start >= end)
        throw new Error('cannot overwrite across a split point')
      group = coordinateNext
      result.push(group)
    }
    return result
  }

  remove(start: number, end: number): void {
    if (start === end)
      return
    this.split(start)
    this.split(end)

    let group = this.byStart.get(start)
    while (group && group.start < end) {
      // Inserts strictly inside the range die with the characters; inserts
      // anchored at the `start`/`end` boundaries (including those added
      // after the removal) are preserved by the library.
      if (group.start >= start && group.end <= end && group.start !== start)
        group.intro = ''
      if (group.start >= start && group.end <= end && group.end !== end)
        group.outro = ''
      group.edit = { content: '', storeName: false }
      group.edited = true
      group.removed = true
      group = this.coordNext(group)
    }
  }

  overwrite(
    start: number,
    end: number,
    content: string,
    opts: { contentOnly?: boolean, storeName?: boolean } = {},
  ): void {
    this.split(start)
    this.split(end)

    const groups = this.coveringGroups(start, end)
    const first = groups[0]
    const last = groups[groups.length - 1]

    // update()/overwrite() clears every interior group's inserts. Edge inserts
    // at `start` (first.intro) and `end` (last.outro) survive; contentOnly
    // (update) additionally keeps first.outro, plain overwrite removes it.
    for (const group of groups) {
      if (group !== first)
        group.intro = ''
      if (group !== last)
        group.outro = ''
    }
    if (!opts.contentOnly)
      first.outro = ''

    for (let i = 1; i < groups.length; i += 1) {
      groups[i].edit = { content: '', storeName: false }
      groups[i].edited = true
    }

    first.edit = { content, storeName: !!opts.storeName }
    first.edited = true
    first.removed = false
    first.originalName = this.original.slice(start, end)

    if (opts.storeName)
      this.storedNames.set(this.original.slice(start, end), true)
  }

  update(
    start: number,
    end: number,
    content: string,
    opts: { storeName?: boolean } = {},
  ): void {
    this.overwrite(start, end, content, { contentOnly: true, storeName: opts.storeName })
  }

  // ---- move ----------------------------------------------------------------

  /** Mirrors the public contract: throws if an earlier move split this range. */
  move(start: number, end: number, index: number, affinity: 'left' | 'right' = 'right'): void {
    if (start === end)
      return

    this.split(start)
    this.split(end)
    this.split(index)

    const first = this.byStart.get(start)!
    let last: Group | undefined
    for (const group of this.byStart.values()) {
      if (group.end === end)
        last = group
    }

    // Chunks covering the range must still form a forward run in the output.
    let cursor: Group = first
    while (cursor !== last) {
      cursor = this.order[this.order.indexOf(cursor) + 1]
      if (!cursor || cursor.start < start || cursor.end > end)
        throw new Error('cannot move range because an earlier move split that range')
    }

    const firstPos = this.order.indexOf(first)
    const lastPos = this.order.indexOf(last!)

    let alreadyInPlace: boolean
    let anchor: Group | undefined
    if (affinity === 'left') {
      anchor = index === 0 ? undefined : this.groupEndingAt(index)
      if (!anchor) {
        alreadyInPlace = firstPos === 0
      }
      else {
        alreadyInPlace = this.order.indexOf(anchor) + 1 === firstPos
      }
    }
    else {
      anchor = index === this.original.length ? undefined : this.byStart.get(index)
      if (!anchor) {
        alreadyInPlace = lastPos === this.order.length - 1
      }
      else {
        alreadyInPlace = this.order.indexOf(anchor) - 1 === lastPos
      }
    }
    if (alreadyInPlace)
      return

    const run = this.order.splice(firstPos, lastPos - firstPos + 1)

    let insertAt: number
    if (anchor) {
      const anchorPos = this.order.indexOf(anchor)
      insertAt = affinity === 'left' ? anchorPos + 1 : anchorPos
    }
    else {
      insertAt = affinity === 'left' ? 0 : this.order.length
    }
    this.order.splice(insertAt, 0, ...run)
    this.hasMoved = true
  }

  private groupEndingAt(index: number): Group | undefined {
    for (const group of this.byStart.values()) {
      if (group.end === index)
        return group
    }
    return undefined
  }

  // ---- indent --------------------------------------------------------------

  indent(
    indentStr: string,
    options: { exclude?: [number, number][], indentStart?: boolean } = {},
  ): void {
    if (indentStr === '')
      return

    const excluded = new Set<number>()
    for (const [s, e] of options.exclude ?? []) {
      for (let i = s; i < e; i += 1)
        excluded.add(i)
    }

    let shouldIndentNext = options.indentStart !== false

    // One flag is shared across intro/chunks/outro and updated from the
    // trailing character of every indented piece, exactly like the library.
    const indentPiece = (str: string): string => {
      if (str === '')
        return str
      const indented = str.replace(/^[^\r\n]/gm, (match: string, offset: number) =>
        offset > 0 || shouldIndentNext ? `${indentStr}${match}` : match)
      shouldIndentNext = str[str.length - 1] === '\n'
      return indented
    }

    this.intro = indentPiece(this.intro)

    // Emission-order walk. indentAt may split the current group; the library
    // then continues the loop on the freshly created right-hand group.
    let charIndex = 0
    let oi = 0

    while (oi < this.order.length) {
      const startOi = oi
      let chunk = this.order[oi]
      const end = chunk.end

      if (!excluded.has(chunk.start))
        chunk.intro = indentPiece(chunk.intro)

      const indentAt = (index: number): void => {
        shouldIndentNext = false
        if (index === chunk.start) {
          chunk.intro += indentStr
        }
        else {
          this.split(index)
          chunk = this.byStart.get(index)!
          chunk.intro = indentStr + chunk.intro
          oi = this.order.indexOf(chunk)
        }
      }

      if (chunk.edited) {
        if (!excluded.has(charIndex))
          chunk.edit!.content = indentPiece(chunk.edit!.content)
      }
      else if (options.exclude) {
        charIndex = chunk.start
        while (charIndex < end) {
          if (!excluded.has(charIndex)) {
            const code = this.original.charCodeAt(charIndex)
            if (code === 10) {
              shouldIndentNext = true
            }
            else if (code !== 13 && shouldIndentNext) {
              indentAt(charIndex)
            }
          }
          charIndex += 1
        }
      }
      else {
        charIndex = chunk.start
        while (charIndex < end) {
          if (!shouldIndentNext) {
            const nextLine = this.original.indexOf('\n', charIndex)
            if (nextLine === -1 || nextLine >= end)
              break
            shouldIndentNext = true
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

      if (!excluded.has(chunk.end - 1))
        chunk.outro = indentPiece(chunk.outro)

      charIndex = chunk.end
      if (oi === startOi)
        oi += 1
    }

    this.outro = indentPiece(this.outro)
  }

  addSourcemapLocation(index: number): void {
    this.sourcemapLocations.add(index)
  }

  // ---- output --------------------------------------------------------------

  toString(): string {
    let result = this.intro
    for (const group of this.order) {
      result += group.intro
      result += group.edited
        ? group.edit!.content
        : this.original.slice(group.start, group.end)
      result += group.outro
    }
    return result + this.outro
  }
}
