/**
 * Independent reference model for sequences of MagicString edits.
 *
 * The model speaks only the public contract: the original string is tiled by
 * split boundaries, every tile carries left/right insertion slots, and `move`
 * reorders whole tiles in the emission order. It deliberately mirrors none of
 * the library's internals (there is no Chunk graph, no VLQ encoding): its value
 * is that it predicts `toString()` and every generated segment's provenance
 * from a small set of semantic rules.
 */

export type Affinity = 'left' | 'right'

export interface ModelNode {
  start: number
  end: number
  original: string
  edited: boolean
  content: string
  storeName: boolean
  editOriginal: string | undefined
  intro: string
  outro: string
  previous: ModelNode | null
  next: ModelNode | null
}

export class EditModel {
  original: string
  firstNode: ModelNode
  lastNode: ModelNode
  byStart = new Map<number, ModelNode>()
  byEnd = new Map<number, ModelNode>()
  intro = ''
  outro = ''
  storedNames = new Map<string, true>()
  sourcemapLocations = new Set<number>()
  hasMovedChunks = false

  constructor(original: string) {
    this.original = original
    const node: ModelNode = {
      start: 0,
      end: original.length,
      original,
      edited: false,
      content: original,
      storeName: false,
      editOriginal: undefined,
      intro: '',
      outro: '',
      previous: null,
      next: null,
    }
    this.firstNode = node
    this.lastNode = node
    this.byStart.set(0, node)
    this.byEnd.set(original.length, node)
  }

  /** Deep copy: used both for clone isolation and as a speculative probe. */
  clone(): EditModel {
    const copy = new EditModel(this.original)
    copy.byStart.clear()
    copy.byEnd.clear()

    let previous: ModelNode | null = null
    let node: ModelNode | null = this.firstNode
    while (node) {
      const cloned: ModelNode = {
        start: node.start,
        end: node.end,
        original: node.original,
        edited: node.edited,
        content: node.content,
        storeName: node.storeName,
        editOriginal: node.editOriginal,
        intro: node.intro,
        outro: node.outro,
        previous,
        next: null,
      }
      if (previous)
        previous.next = cloned
      else
        copy.firstNode = cloned

      copy.byStart.set(cloned.start, cloned)
      copy.byEnd.set(cloned.end, cloned)
      previous = cloned
      node = node.next
    }
    copy.lastNode = previous!
    copy.intro = this.intro
    copy.outro = this.outro
    copy.hasMovedChunks = this.hasMovedChunks
    copy.storedNames = new Map(this.storedNames)
    copy.sourcemapLocations = new Set(this.sourcemapLocations)
    return copy
  }

  tileAt(index: number): ModelNode {
    for (const node of this.byStart.values()) {
      if (node.start <= index && index <= node.end)
        return node
    }
    throw new Error(`no tile covers ${index}`)
  }

  /**
   * A boundary is splittable unless it falls strictly inside a tile whose
   * replacement content is non-empty - the library refuses to split those.
   */
  canSplit(index: number): boolean {
    if (this.byStart.has(index) || this.byEnd.has(index))
      return true
    const node = this.tileAt(index)
    return node.edited === false || node.content === ''
  }

  private splitNode(node: ModelNode, index: number): ModelNode {
    const oldEnd = node.end
    const oldOutro = node.outro
    const newNode: ModelNode = {
      start: index,
      end: oldEnd,
      original: this.original.slice(index, oldEnd),
      edited: node.edited,
      content: node.edited ? '' : this.original.slice(index, oldEnd),
      storeName: false,
      editOriginal: undefined,
      intro: '',
      outro: '',
      previous: node,
      next: node.next,
    }
    node.end = index
    if (node.edited)
      node.content = ''
    else
      node.content = this.original.slice(node.start, index)
    node.original = this.original.slice(node.start, index)
    // mirroring Chunk#split exactly: the outro always moves to the new
    // right-hand tile (so an insert at the boundary stays attached to the
    // content that starts there); for edited tiles, `edit('')` on the new
    // tile runs after the outro moved there, which clears it again - an
    // observable quirk of empty edit tiles
    node.outro = ''
    if (node.edited) {
      newNode.edited = true
      newNode.content = ''
      newNode.outro = ''
    }
    else {
      newNode.outro = oldOutro
    }

    if (node.next)
      node.next.previous = newNode
    node.next = newNode

    this.byEnd.set(index, node)
    this.byStart.set(index, newNode)
    this.byEnd.set(oldEnd, newNode)
    if (this.lastNode === node)
      this.lastNode = newNode
    return newNode
  }

  private ensureSplit(index: number): void {
    if (this.byStart.has(index) || this.byEnd.has(index))
      return
    const tile = this.tileAt(index)
    if (tile.edited && tile.content.length)
      throw new Error('cannot split a chunk that has already been edited')
    this.splitNode(tile, index)
  }

  appendLeft(index: number, content: string): void {
    this.ensureSplit(index)
    const node = this.byEnd.get(index)
    if (node)
      node.outro += content
    else
      this.intro += content
  }

  prependLeft(index: number, content: string): void {
    this.ensureSplit(index)
    const node = this.byEnd.get(index)
    if (node)
      node.outro = content + node.outro
    else
      this.intro = content + this.intro
  }

  appendRight(index: number, content: string): void {
    this.ensureSplit(index)
    const node = this.byStart.get(index)
    if (node)
      node.intro += content
    else
      this.outro += content
  }

  prependRight(index: number, content: string): void {
    this.ensureSplit(index)
    const node = this.byStart.get(index)
    if (node)
      node.intro = content + node.intro
    else
      this.outro = content + this.outro
  }

  append(content: string): void {
    this.outro += content
  }

  prepend(content: string): void {
    this.intro = content + this.intro
  }

  addSourcemapLocation(index: number): void {
    this.sourcemapLocations.add(index)
  }

  overwrite(
    start: number,
    end: number,
    content: string,
    options: { storeName?: boolean, contentOnly?: boolean } = {},
  ): void {
    this.ensureSplit(start)
    this.ensureSplit(end)

    if (options.storeName)
      this.storedNames.set(this.original.slice(start, end), true)

    const first = this.byStart.get(start)!
    const last = this.byEnd.get(end)!

    let node: ModelNode = first
    while (node !== last) {
      if (node.next !== this.byStart.get(node.end))
        throw new Error('cannot overwrite across a split point')
      node = node.next!
      node.edited = true
      node.content = ''
      node.storeName = false
      node.editOriginal = undefined
      node.intro = ''
      node.outro = ''
    }

    first.edited = true
    first.content = content
    first.storeName = options.storeName ?? false
    first.editOriginal = this.original.slice(start, end)
    if (!options.contentOnly) {
      first.intro = ''
      first.outro = ''
    }
  }

  remove(start: number, end: number): void {
    this.ensureSplit(start)
    this.ensureSplit(end)

    let node: ModelNode | undefined = this.byStart.get(start)
    while (node) {
      if (node.start > start)
        node.intro = ''
      if (node.end < end)
        node.outro = ''
      node.edited = true
      node.content = ''
      node.storeName = false
      node.editOriginal = undefined
      node = end > node.end ? this.byStart.get(node.end) : undefined
    }
  }

  move(start: number, end: number, index: number, affinity: Affinity = 'right'): void {
    if (start === end)
      return
    if (index >= start && index <= end)
      throw new Error('cannot move a selection inside itself')

    this.ensureSplit(start)
    this.ensureSplit(end)
    this.ensureSplit(index)

    const first = this.byStart.get(start)!
    const last = this.byEnd.get(end)!

    if (this.hasMovedChunks) {
      let cursor: ModelNode | null = first
      while (cursor !== last) {
        cursor = cursor.next
        if (!cursor || cursor.start < start || cursor.end > end)
          throw new Error('cannot move because an earlier move split that range')
      }
    }

    const oldLeft = first.previous
    const oldRight = last.next

    let newLeft: ModelNode | null
    let newRight: ModelNode | null
    if (affinity === 'left') {
      newLeft = this.byEnd.get(index) ?? null
      if (!newLeft) {
        if (first === this.firstNode)
          return
        newRight = this.firstNode
      }
      else {
        if (newLeft.next === first)
          return
        newRight = newLeft.next
      }
    }
    else {
      newRight = this.byStart.get(index) ?? null
      if (!newRight) {
        if (last === this.lastNode)
          return
        newLeft = this.lastNode
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
      this.firstNode = last.next
    if (!last.next) {
      this.lastNode = first.previous
      this.lastNode!.next = null
    }

    first.previous = newLeft
    last.next = newRight || null

    if (!newLeft)
      this.firstNode = first
    if (!newRight)
      this.lastNode = last

    this.hasMovedChunks = true
  }

  indent(
    indentStr: string,
    options: { exclude?: Array<[number, number]>, indentStart?: boolean } = {},
  ): void {
    if (indentStr === '')
      return

    const pattern = /^[^\r\n]/gm
    const isExcluded = new Set<number>()
    if (options.exclude) {
      for (const [excludeStart, excludeEnd] of options.exclude) {
        for (let i = excludeStart; i < excludeEnd; i += 1)
          isExcluded.add(i)
      }
    }

    let shouldIndentNextCharacter = options.indentStart !== false

    const indentPiece = (str: string): string => {
      if (str === '')
        return str
      const indented = str.replace(pattern, (_match, offset: number) =>
        offset > 0 || shouldIndentNextCharacter ? `${indentStr}${_match}` : _match)
      shouldIndentNextCharacter = str[str.length - 1] === '\n'
      return indented
    }

    this.intro = indentPiece(this.intro)

    let charIndex = 0
    let chunk: ModelNode | null = this.firstNode

    const indentAt = (index: number) => {
      shouldIndentNextCharacter = false
      if (index === chunk!.start) {
        chunk!.intro += indentStr
      }
      else {
        chunk = this.splitNode(chunk!, index)
        chunk.intro = indentStr + chunk.intro
      }
    }

    while (chunk) {
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
      chunk = chunk.next
    }

    this.outro = indentPiece(this.outro)
  }

  toString(): string {
    let str = this.intro
    let node: ModelNode | null = this.firstNode
    while (node) {
      str += node.intro + node.content + node.outro
      node = node.next
    }
    return str + this.outro
  }
}
