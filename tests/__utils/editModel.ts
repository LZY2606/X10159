// Independent reference model for sequences of MagicString edits.
//
// This deliberately does not import or inspect MagicString internals: it is a
// from-scratch model of the documented public behaviour. It tracks where every
// emitted character came from (an original code unit, an edit, or a
// boundary/line insert) and predicts both `toString()` and the decoded
// sourcemap for every hires mode.

export type OpKind =
  | 'appendLeft'
  | 'prependLeft'
  | 'appendRight'
  | 'prependRight'
  | 'overwrite'
  | 'remove'
  | 'move'
  | 'indent'
  | 'addSourcemapLocation'

export interface Op {
  kind: OpKind
  index?: number
  start?: number
  end?: number
  to?: number
  affinity?: 'left' | 'right'
  content?: string
  storeName?: boolean
  contentOnly?: boolean
  prefix?: string
  indentStart?: boolean
}

type Tag =
  | { t: 'i'; s: string } // inserted text with no source (boundary insert, bookend, indent)
  | { t: 'o'; s: string; start: number; name: string | null } // edited content sourced at range start
  | { t: 'u'; index: number } // surviving original code unit

export type Provenance =
  | { kind: 'insert'; text: string }
  | { kind: 'edit'; text: string; start: number; name: string | null }
  | { kind: 'original'; index: number }

interface Atom {
  start: number
  end: number
  intro: string
  outro: string
  edited: boolean
  content: string
  storeName: boolean
  originalText: string
  prev: Atom | null
  next: Atom | null
}

export const isWordCode = (code: number): boolean =>
  (code >= 97 && code <= 122)
  || (code >= 65 && code <= 90)
  || (code >= 48 && code <= 57)
  || code === 95

export class EditModel {
  readonly original: string

  private head: Atom
  private tail: Atom
  private byStart = new Map<number, Atom>()
  private byEnd = new Map<number, Atom>()
  private intro = ''
  private outro = ''
  private locations = new Set<number>()
  names: string[] = []

  constructor(original: string) {
    this.original = original
    const atom: Atom = {
      start: 0,
      end: original.length,
      intro: '',
      outro: '',
      edited: false,
      content: original,
      storeName: false,
      originalText: original,
      prev: null,
      next: null,
    }
    this.head = atom
    this.tail = atom
    this.byStart.set(0, atom)
    this.byEnd.set(original.length, atom)
  }

  // Returns false when the public contract rejects the operation; the fuzzer
  // skips such operations rather than expecting a throw.
  apply(op: Op): boolean {
    switch (op.kind) {
      case 'appendLeft': return this.insertAt(op.index!, op.content!, 'appendLeft')
      case 'prependLeft': return this.insertAt(op.index!, op.content!, 'prependLeft')
      case 'appendRight': return this.insertAt(op.index!, op.content!, 'appendRight')
      case 'prependRight': return this.insertAt(op.index!, op.content!, 'prependRight')
      case 'overwrite':
        return this.overwrite(op.start!, op.end!, op.content ?? '', !!op.storeName, !!op.contentOnly)
      case 'remove':
        return this.remove(op.start!, op.end!)
      case 'move':
        return this.move(op.start!, op.end!, op.to!, op.affinity ?? 'right')
      case 'indent':
        this.indent(op.prefix ?? '\t', op.indentStart !== false)
        return true
      case 'addSourcemapLocation':
        this.locations.add(op.index!)
        return true
    }
  }

  clone(): EditModel {
    const copy = new EditModel(this.original)
    copy.intro = this.intro
    copy.outro = this.outro
    copy.locations = new Set(this.locations)
    copy.names = this.names.slice()

    copy.byStart.clear()
    copy.byEnd.clear()
    let source: Atom | null = this.head
    let previous: Atom | null = null
    while (source) {
      const atom: Atom = {
        start: source.start,
        end: source.end,
        intro: source.intro,
        outro: source.outro,
        edited: source.edited,
        content: source.content,
        storeName: source.storeName,
        originalText: source.originalText,
        prev: previous,
        next: null,
      }
      if (previous)
        previous.next = atom
      previous = atom
      copy.byStart.set(atom.start, atom)
      copy.byEnd.set(atom.end, atom)
      if (source === this.head)
        copy.head = atom
      if (source === this.tail)
        copy.tail = atom
      source = source.next
    }
    return copy
  }

  hasLocation(index: number): boolean {
    return this.locations.has(index)
  }

  private insertAt(
    index: number,
    content: string,
    where: 'appendLeft' | 'prependLeft' | 'appendRight' | 'prependRight',
  ): boolean {
    if (typeof content !== 'string')
      return false
    if (index < 0 || index > this.original.length)
      return false

    // boundary inserts split first; the split moves the right-side slot onto
    // the new atom, so an appendLeft before the split point still lands after
    // it in the output (it travels with the following content)
    if (!this.split(index))
      return false

    const isLeftApi = where === 'appendLeft' || where === 'prependLeft'
    const isPrepend = where === 'prependLeft' || where === 'prependRight'
    const length = this.original.length

    if (isLeftApi) {
      // anchored to content ending at `index`
      const atom = this.byEnd.get(index)
      if (index === 0 && (!atom || atom.end !== 0)) {
        this.outro = isPrepend ? content + this.outro : this.outro + content
      }
      else if (atom) {
        atom.outro = isPrepend ? content + atom.outro : atom.outro + content
      }
      else {
        this.outro = isPrepend ? content + this.outro : this.outro + content
      }
    }
    else {
      // anchored to content starting at `index`
      const atom = this.byStart.get(index)
      if (index === length && (!atom || atom.start !== length)) {
        this.outro = isPrepend ? content + this.outro : this.outro + content
      }
      else if (atom) {
        atom.intro = isPrepend ? content + atom.intro : atom.intro + content
      }
      else {
        this.intro = isPrepend ? content + this.intro : this.intro + content
      }
    }
    return true
  }

  private split(index: number): boolean {
    if (this.byStart.has(index) || this.byEnd.has(index))
      return true

    const atom = this.findAtomContaining(index)
    if (!atom)
      return false

    // non-empty edited content cannot be split
    if (atom.edited && atom.content.length > 0)
      return false

    const right: Atom = {
      start: index,
      end: atom.end,
      intro: '',
      outro: atom.outro,
      edited: atom.edited,
      content: atom.edited ? '' : this.original.slice(index, atom.end),
      storeName: false,
      originalText: atom.originalText.slice(index - atom.start),
      prev: atom,
      next: atom.next,
    }
    if (atom.next)
      atom.next.prev = right
    atom.next = right
    atom.end = index
    atom.outro = ''
    atom.originalText = atom.originalText.slice(0, index - atom.start)
    atom.content = atom.edited ? '' : this.original.slice(atom.start, index)

    this.byEnd.set(index, atom)
    this.byStart.set(index, right)
    this.byEnd.set(right.end, right)
    if (this.tail === atom)
      this.tail = right
    return true
  }

  private findAtomContaining(index: number): Atom | null {
    let atom: Atom | null = this.head
    while (atom) {
      if (atom.start < index && index < atom.end)
        return atom
      atom = atom.next
    }
    return null
  }

  private normalizeRange(start: number, end: number): [number, number] | null {
    if (start < 0 || end < 0) {
      if (this.original.length === 0)
        return null
      if (start < 0)
        start = Math.max(0, start + this.original.length)
      if (end < 0)
        end = Math.max(0, end + this.original.length)
    }
    if (start < 0 || end > this.original.length || start > end)
      return null
    return [start, end]
  }

  private overwrite(
    startIn: number,
    endIn: number,
    content: string,
    storeName: boolean,
    contentOnly: boolean,
  ): boolean {
    const range = this.normalizeRange(startIn, endIn)
    if (!range)
      return false
    const [start, end] = range
    if (start === end)
      return false

    if (!this.split(start) || !this.split(end))
      return false

    const first = this.byStart.get(start)!
    const last = this.byEnd.get(end)!

    let cursor: Atom | null = first
    while (cursor !== last) {
      if (cursor.next !== this.byStart.get(cursor.end))
        return false
      cursor = cursor.next
    }

    if (storeName) {
      const name = this.original.slice(start, end)
      if (!this.names.includes(name))
        this.names.push(name)
    }

    let atom: Atom | null = first
    while (atom !== last) {
      atom.edited = true
      atom.storeName = false
      atom.content = ''
      if (!contentOnly) {
        atom.intro = ''
        atom.outro = ''
      }
      atom = atom.next
    }
    first.edited = true
    first.content = content
    first.storeName = storeName
    first.originalText = this.original.slice(start, end)
    if (!contentOnly) {
      first.intro = ''
      first.outro = ''
    }
    return true
  }

  private remove(startIn: number, endIn: number): boolean {
    const range = this.normalizeRange(startIn, endIn)
    if (!range)
      return true
    const [start, end] = range
    if (start === end)
      return true
    if (!this.split(start) || !this.split(end))
      return false

    let atom: Atom | null = this.byStart.get(start)!
    const last = this.byEnd.get(end)!
    while (atom) {
      if (atom.start > start)
        atom.intro = ''
      if (atom.end < end)
        atom.outro = ''
      atom.edited = true
      atom.storeName = false
      atom.content = ''
      if (atom === last)
        break
      atom = this.byStart.get(atom.end) ?? null
    }
    return true
  }

  private move(startIn: number, endIn: number, index: number, affinity: 'left' | 'right'): boolean {
    const range = this.normalizeRange(startIn, endIn)
    if (!range)
      return false
    const [start, end] = range
    if (start === end)
      return true
    if (index < 0 || index > this.original.length)
      return false
    if (index >= start && index <= end)
      return false

    if (!this.split(start) || !this.split(end) || !this.split(index))
      return false

    const first = this.byStart.get(start)!
    const last = this.byEnd.get(end)!

    let check: Atom | null = first
    while (check !== last) {
      check = check.next
      if (!check || check.start < start || check.end > end)
        return false
    }

    const oldLeft = first.prev
    const oldRight = last.next

    let newLeft: Atom | null
    let newRight: Atom | null
    if (affinity === 'left') {
      newLeft = this.byEnd.get(index) ?? null
      if (!newLeft) {
        if (first === this.head)
          return true
        newRight = this.head
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
        if (last === this.tail)
          return true
        newLeft = this.tail
      }
      else {
        if (newRight.prev === last)
          return true
        newLeft = newRight.prev
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

    if (!first.prev)
      this.head = last.next!
    if (!last.next) {
      this.tail = first.prev!
      this.tail.next = null
    }
    first.prev = newLeft
    last.next = newRight
    if (!newLeft)
      this.head = first
    if (!newRight)
      this.tail = last
    return true
  }

  // Model of indent() with no exclusion ranges (the fuzzer never generates
  // those; excluded indentation is covered by the hand-written boundary set).
  private indent(prefix: string, indentStart: boolean): void {
    if (prefix === '')
      return

    let pending = indentStart

    const indentPiece = (str: string): string => {
      if (str === '')
        return str
      const out = str.replace(/^[^\n]/gm, (_match, offset: number) =>
        offset > 0 || pending ? prefix + _match : _match)
      pending = str[str.length - 1] === '\n'
      return out
    }

    this.intro = indentPiece(this.intro)

    let atom: Atom | null = this.head
    while (atom) {
      atom.intro = indentPiece(atom.intro)

      if (atom.edited) {
        atom.content = indentPiece(atom.content)
      }
      else {
        for (let i = atom.start; i < atom.end; i += 1) {
          const code = this.original.charCodeAt(i)
          if (code === 10) {
            pending = true
          }
          else if (pending) {
            if (i === atom.start) {
              // appendRight: ahead of the atom's own intro
              atom.intro += prefix
            }
            else {
              // split first; the new atom starts with prependRight content
              this.split(i)
              const target = this.byStart.get(i)!
              target.intro = prefix + target.intro
              atom = target
            }
            pending = false
          }
        }
      }

      atom.outro = indentPiece(atom.outro)
      atom = atom.next
    }

    this.outro = indentPiece(this.outro)
  }

  // Emits the output as provenance tags, in generated order.
  provenance(): Provenance[] {
    const tags: Tag[] = []
    const pushText = (s: string) => {
      if (s)
        tags.push({ t: 'i', s })
    }
    pushText(this.intro)
    let atom: Atom | null = this.head
    while (atom) {
      pushText(atom.intro)
      if (atom.edited) {
        if (atom.content) {
          // names resolve through the holder's own original text, matching the
          // observable implementation quirk after later splits
          const name = atom.storeName && this.names.includes(atom.originalText)
            ? atom.originalText
            : null
          tags.push({ t: 'o', s: atom.content, start: atom.start, name })
        }
      }
      else {
        for (let i = atom.start; i < atom.end; i += 1)
          tags.push({ t: 'u', index: i })
      }
      pushText(atom.outro)
      atom = atom.next
    }
    pushText(this.outro)
    return tags.map(tag =>
      tag.t === 'u'
        ? { kind: 'original', index: tag.index }
        : tag.t === 'i'
          ? { kind: 'insert', text: tag.s }
          : { kind: 'edit', text: tag.s, start: tag.start, name: tag.name })
  }

  toString(): string {
    let out = ''
    for (const tag of this.provenance())
      out += tag.kind === 'original' ? this.original[tag.index] : tag.text
    return out
  }

  // Original code-unit indices that still appear in the generated output.
  emittedOriginalIndices(): Set<number> {
    const set = new Set<number>()
    for (const tag of this.provenance()) {
      if (tag.kind === 'original')
        set.add(tag.index)
    }
    return set
  }

  // Predicts the decoded `mappings` array (without sources/names metadata).
  decodeMappings(hires: boolean | 'boundary'): number[][][][] {
    const lines: number[][][][] = [[]]
    let genLine = 0
    let genCol = 0
    let srcLine = 0
    let srcCol = 0
    let boundaryInWord = false

    const advance = (s: string) => {
      if (!s)
        return
      let i = s.indexOf('\n')
      while (i !== -1) {
        genLine += 1
        lines[genLine] = []
        genCol = 0
        i = s.indexOf('\n', i + 1)
      }
      const lastNl = s.lastIndexOf('\n')
      genCol += s.length - lastNl - 1
    }

    const pushEdit = (s: string, start: number, name: string | null) => {
      // locator is recomputed per piece from the original index, like the impl
      const pos = this.locate(start)
      let previousEnd = -1
      let nl = s.indexOf('\n')
      while (nl >= 0 && s.length - 1 > nl) {
        const seg = [genCol, 0, pos.line, pos.col]
        if (name !== null)
          seg.push(this.names.indexOf(name))
        lines[genLine].push(seg)
        genLine += 1
        lines[genLine] = []
        genCol = 0
        previousEnd = nl
        nl = s.indexOf('\n', nl + 1)
      }
      const tail = s.slice(previousEnd + 1)
      const seg = [genCol, 0, pos.line, pos.col]
      if (name !== null)
        seg.push(this.names.indexOf(name))
      lines[genLine].push(seg)
      advance(tail)
      boundaryInWord = false
    }

    // state carried into each unedited piece, mirroring the per-chunk emitter:
    // locator is anchored at the atom start
    const emitUnedited = (atom: Atom) => {
      const loc = this.locate(atom.start)
      // boundary grouping is local to every emitted chunk
      boundaryInWord = false
      if (hires === true) {
        for (let i = atom.start; i < atom.end; i += 1) {
          if (this.original.charCodeAt(i) === 10) {
            loc.line += 1
            loc.col = 0
            genLine += 1
            lines[genLine] = []
            genCol = 0
            boundaryInWord = false
          }
          else {
            lines[genLine].push([genCol, 0, loc.line, loc.col])
            loc.col += 1
            genCol += 1
          }
        }
      }
      else if (hires === 'boundary') {
        for (let i = atom.start; i < atom.end; i += 1) {
          const code = this.original.charCodeAt(i)
          if (code === 10) {
            genLine += 1
            lines[genLine] = []
            genCol = 0
            loc.line += 1
            loc.col = 0
            boundaryInWord = false
          }
          else {
            if (isWordCode(code)) {
              if (!boundaryInWord) {
                lines[genLine].push([genCol, 0, loc.line, loc.col])
                boundaryInWord = true
              }
            }
            else {
              lines[genLine].push([genCol, 0, loc.line, loc.col])
              boundaryInWord = false
            }
            loc.col += 1
            genCol += 1
          }
        }
      }
      else {
        // lo-res: one segment per line start, plus explicit locations
        let i = atom.start
        while (i < atom.end) {
          let nl = this.original.indexOf('\n', i)
          if (nl === -1 || nl > atom.end)
            nl = atom.end
          if (nl > i) {
            lines[genLine].push([genCol, 0, loc.line, loc.col])
            for (let j = i + 1; j < nl; j += 1) {
              if (this.locations.has(j))
                lines[genLine].push([genCol + (j - i), 0, loc.line, loc.col + (j - i)])
            }
            loc.col += nl - i
            genCol += nl - i
          }
          if (nl === atom.end)
            break
          loc.line += 1
          loc.col = 0
          genLine += 1
          lines[genLine] = []
          genCol = 0
          i = nl + 1
        }
        boundaryInWord = false
      }
    }

    // intro advances without segments, but resets the boundary flag state
    const pushIntro = (s: string) => {
      advance(s)
      boundaryInWord = false
    }

    pushIntro(this.intro)
    let atom: Atom | null = this.head
    while (atom) {
      pushIntro(atom.intro)
      if (atom.edited) {
        if (atom.content) {
          const name = atom.storeName && this.names.includes(atom.originalText)
            ? atom.originalText
            : null
          pushEdit(atom.content, atom.start, name)
        }
      }
      else {
        emitUnedited(atom)
      }
      pushIntro(atom.outro)
      atom = atom.next
    }
    pushIntro(this.outro)

    return lines
  }

  private locate(index: number): { line: number, col: number } {
    let line = 0
    let col = 0
    for (let i = 0; i < index; i += 1) {
      if (this.original.charCodeAt(i) === 10) {
        line += 1
        col = 0
      }
      else {
        col += 1
      }
    }
    return { line, col }
  }
}
