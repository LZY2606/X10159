/**
 * Independent reference model for a single MagicString document.
 *
 * The model describes the observable contract only - an ordered run of
 * "fragments", each a contiguous slice of the ORIGINAL document with:
 *   - intro: inserted text emitted immediately before the slice
 *   - content: the slice itself, or replacement text when edited
 *   - outro: inserted text emitted immediately after the slice
 *
 * It deliberately does not reuse the library's internal Chunk class or any of
 * its helpers: every rule here was derived from the documented public
 * contract, checked against observable behaviour, and is used to predict both
 * `toString()` and every decoded sourcemap segment the library produces.
 */

export type HiresMode = boolean | 'boundary'

export interface ModelIndentOptions {
  exclude?: Array<[number, number]>
  indentStart?: boolean
}

export type SourceOp =
  | { type: 'appendLeft', index: number, text: string }
  | { type: 'appendRight', index: number, text: string }
  | { type: 'prependLeft', index: number, text: string }
  | { type: 'prependRight', index: number, text: string }
  | { type: 'append', text: string }
  | { type: 'prepend', text: string }
  | { type: 'overwrite', start: number, end: number, text: string, storeName?: boolean }
  | { type: 'remove', start: number, end: number }
  | { type: 'move', start: number, end: number, index: number, affinity: 'left' | 'right' }
  | { type: 'indent', indentStr: string, options?: ModelIndentOptions }
  | { type: 'addSourcemapLocation', index: number }

/**
 * Thrown when an op violates the public contract (out of bounds, split across
 * an edited range, move inside itself, ...). Callers filter ops against
 * `isLegal` first, so a raise here indicates a generator bug.
 */
export class IllegalOpError extends Error {}

export interface ExpectedMap {
  names: string[]
  mappings: number[][][]
}

const NEWLINE_CODE = 10
const CR_CODE = 13

function isWordCode(code: number): boolean {
  return (code >= 97 && code <= 122)
    || (code >= 65 && code <= 90)
    || (code >= 48 && code <= 57)
    || code === 95
}

class Frag {
  intro = ''
  outro = ''
  content: string
  edited = false
  storeName = false
  previous: Frag | null = null
  next: Frag | null = null

  constructor(
    public start: number,
    public end: number,
    public original: string,
  ) {
    this.content = original
  }

  toString(): string {
    return this.intro + this.content + this.outro
  }

  edit(content: string, storeName: boolean, contentOnly: boolean): void {
    this.content = content
    if (!contentOnly) {
      this.intro = ''
      this.outro = ''
    }
    this.storeName = storeName
    this.edited = true
  }

  clone(): Frag {
    const c = new Frag(this.start, this.end, this.original)
    c.intro = this.intro
    c.outro = this.outro
    c.content = this.content
    c.edited = this.edited
    c.storeName = !!this.storeName
    return c
  }
}

export class EditingModel {
  original: string
  intro = ''
  outro = ''
  first: Frag
  last: Frag
  private byStart = new Map<number, Frag>()
  private byEnd = new Map<number, Frag>()
  sourcemapLocations = new Set<number>()
  storedNames: string[] = []
  hasMoved = false

  constructor(original: string) {
    this.original = original
    const frag = new Frag(0, original.length, original)
    this.first = this.last = frag
    this.byStart.set(0, frag)
    this.byEnd.set(original.length, frag)
  }

  cloneDeep(): EditingModel {
    const copy = new EditingModel(this.original)
    copy.intro = this.intro
    copy.outro = this.outro
    copy.sourcemapLocations = new Set(this.sourcemapLocations)
    copy.storedNames = this.storedNames.slice()
    copy.hasMoved = this.hasMoved

    copy.byStart.clear()
    copy.byEnd.clear()
    let prev: Frag | null = null
    for (let f = this.first; f !== null; f = f.next) {
      const c = f.clone()
      c.previous = prev
      if (prev)
        prev.next = c
      else
        copy.first = c
      copy.byStart.set(c.start, c)
      copy.byEnd.set(c.end, c)
      prev = c
    }
    copy.last = prev as Frag
    return copy
  }

  // ---- structural helpers -------------------------------------------------

  private fragContaining(index: number): Frag | null {
    for (let f = this.first; f !== null; f = f.next) {
      if (f.start < index && index < f.end)
        return f
    }
    return null
  }

  /**
   * Whether the original character at `index` survives in the output
   * (belongs to a non-edited fragment). Edits and removes empty their
   * fragment content.
   */
  private isAlive(index: number): boolean {
    for (let f = this.first; f !== null; f = f.next) {
      if (f.start <= index && index < f.end)
        return !f.edited
    }
    return false
  }

  /**
   * Whether `index` is a legal split boundary for an insert from `side`:
   * every edge of an unedited fragment works, and the matching outer edge of
   * an edited fragment works (its start for a right-side insert, its end for
   * a left-side insert). A boundary strictly inside an edited fragment is
   * illegal.
   */
  private boundaryAccepts(index: number, side: 'left' | 'right'): boolean {
    const f = side === 'left'
      ? (this.byEnd.get(index) ?? this.fragContaining(index))
      : (this.byStart.get(index) ?? this.fragContaining(index))
    if (!f)
      return true
    if (!f.edited)
      return true
    return side === 'left' ? index === f.end : index === f.start
  }

  /**
   * Whether inserting at `index` would force an illegal split of a
   * non-empty edited fragment (the library throws
   * "cannot split a chunk that has already been edited"). An index that is
   * already a split boundary is always fine, even if the text is empty.
   */
  private illegalInsertSplit(index: number): boolean {
    if (this.byStart.has(index) || this.byEnd.has(index))
      return false
    const f = this.fragContaining(index)
    return !!f && f.edited && f.content.length > 0
  }

  /**
   * Places an insert whose anchoring character was removed. The library
   * relocates every insert made inside a removed gap to the gap's boundary:
   * right-side inserts land at the end of the fragment just BEFORE the gap,
   * and left-side inserts land at the start of the fragment just AFTER it,
   * keeping the within-boundary ordering of the four insert kinds.
   */
  /**
   * Places an insert made at a boundary that currently splits an edited
   * (non-empty) range - the library refuses that split and instead attaches
   * to the nearest legal boundary:
   *   - a right-side insert (appendRight/prependRight) lands at the edited
   *     range's START; a left-side insert (appendLeft/prependLeft) lands at
   *     its END
   *   - legal boundaries are the outer edges of edited fragments, every
   *     edge of unedited fragments, and string ends
   * The walk follows the CURRENT fragment order, so it works after moves.
   */
  /**
   * Left-side insert (appendLeft/prependLeft). The library splits at
   * `index` and appends to the chunk ENDING there; when that chunk was
   * removed (empty edited), the insert survives by walking to the next
   * surviving character's chunk, where it becomes that chunk's outro
   * (appendLeft) / prepends to its outro (prependLeft). If no character
   * survives to the right, the insert falls back to the string outro.
   */
  private leftInsert(index: number, text: string, append: boolean): void {
    const endFrag = this.byEnd.get(index)
    if (index === 0 || (endFrag && endFrag.end === index)) {
      this.split(index)
      const target = this.byEnd.get(index)!
      target.outro = append ? target.outro + text : text + target.outro
      return
    }

    // `index` lies strictly inside an edited chunk (split would throw). The
    // library attaches to the nearest chunk that currently emits content:
    // the trailing edited chunk of an overwrite range still does, while a
    // removed (empty) chunk's inserts relocate to the next survivor.
    let target: Frag | null = null
    for (let i = index + 1; i <= this.original.length; i++) {
      const f = this.byStart.get(i)
      if (f && (!f.edited || f.content.length > 0)) {
        target = f
        break
      }
    }
    if (target)
      target.outro = append ? target.outro + text : text + target.outro
    else
      this.outro = append ? this.outro + text : text + this.outro
  }

  /**
   * Right-side insert (appendRight/prependRight). Symmetric to leftInsert:
   * attaches to the chunk STARTING at `index`; when that chunk was removed
   * it relocates to the previous surviving character's chunk as its intro,
   * falling back to the string intro when nothing survives to the left.
   */
  private rightInsert(index: number, text: string, append: boolean): void {
    const startFrag = this.byStart.get(index)
    if (index === this.original.length || (startFrag && startFrag.start === index)) {
      this.split(index)
      const target = this.byStart.get(index)!
      target.intro = append ? target.intro + text : text + target.intro
      return
    }

    let target: Frag | null = null
    for (let i = index - 1; i >= 0; i--) {
      const f = this.byEnd.get(i)
      if (f && (!f.edited || f.content.length > 0)) {
        target = f
        break
      }
    }
    if (target)
      target.intro = append ? target.intro + text : text + target.intro
    else
      this.intro = append ? this.intro + text : text + this.intro
  }


  private split(index: number): void {
    if (this.byStart.has(index) || this.byEnd.has(index))
      return

    const frag = this.fragContaining(index)
    if (!frag)
      throw new IllegalOpError(`cannot split at index ${index}`)

    // any split strictly inside a non-empty edited fragment is rejected;
    // empty edited fragments (trailing pieces of an overwrite/remove) are
    // splittable
    if (frag.edited && frag.content.length > 0) {
      throw new IllegalOpError(
        `cannot split a chunk that has already been edited (${index} in ${frag.start}-${frag.end})`,
      )
    }

    const sliceIndex = index - frag.start
    const afterOriginal = frag.original.slice(sliceIndex)
    frag.original = frag.original.slice(0, sliceIndex)
    frag.end = index

    const after = new Frag(index, afterOriginal.length ? index + afterOriginal.length : index, afterOriginal)
    after.outro = frag.outro
    frag.outro = ''

    if (frag.edited) {
      after.edited = true
      after.content = ''
      frag.content = ''
    }
    else {
      frag.content = frag.original
    }

    after.next = frag.next
    if (after.next)
      after.next.previous = after
    after.previous = frag
    frag.next = after

    this.byEnd.set(index, frag)
    this.byStart.set(index, after)
    this.byEnd.set(after.end, after)
    if (this.last === frag)
      this.last = after
  }

  private fragmentsForRange(start: number, end: number): Frag[] {
    const out: Frag[] = []
    let f = this.byStart.get(start)
    if (!f)
      throw new IllegalOpError(`no fragment starts at ${start}`)
    out.push(f)
    while (f.end < end) {
      const next = this.byStart.get(f.end)
      if (!next)
        throw new IllegalOpError(`no fragment follows ${f.end}`)
      f = next
      out.push(f)
    }
    return out
  }

  // ---- public mutations ---------------------------------------------------

  apply(op: SourceOp): void {
    switch (op.type) {
      case 'appendLeft': {
        if (this.illegalInsertSplit(op.index))
          throw new IllegalOpError(`cannot split a chunk that has already been edited (index ${op.index})`)
        this.leftInsert(op.index, op.text, true)
        return
      }
      case 'prependLeft': {
        if (this.illegalInsertSplit(op.index))
          throw new IllegalOpError(`cannot split a chunk that has already been edited (index ${op.index})`)
        this.leftInsert(op.index, op.text, false)
        return
      }
      case 'appendRight': {
        if (this.illegalInsertSplit(op.index))
          throw new IllegalOpError(`cannot split a chunk that has already been edited (index ${op.index})`)
        this.rightInsert(op.index, op.text, true)
        return
      }
      case 'prependRight': {
        if (this.illegalInsertSplit(op.index))
          throw new IllegalOpError(`cannot split a chunk that has already been edited (index ${op.index})`)
        this.rightInsert(op.index, op.text, false)
        return
      }
      case 'append':
        this.outro += op.text
        return
      case 'prepend':
        this.intro = op.text + this.intro
        return
      case 'addSourcemapLocation':
        this.sourcemapLocations.add(op.index)
        return
      case 'overwrite':
        this.update(op.start, op.end, op.text, !!op.storeName, true)
        return
      case 'remove':
        this.remove(op.start, op.end)
        return
      case 'move':
        this.move(op.start, op.end, op.index, op.affinity)
        return
      case 'indent':
        this.indent(op.indentStr, op.options)
        return
    }
  }

  private validateRange(start: number, end: number): void {
    if (start < 0 || end > this.original.length)
      throw new IllegalOpError(`range ${start}-${end} is out of bounds`)
    if (start > end)
      throw new IllegalOpError(`end must be greater than start (start: ${start}, end: ${end})`)
  }

  private update(start: number, end: number, content: string, storeName: boolean, overwrite: boolean): void {
    this.validateRange(start, end)
    if (start === end)
      throw new IllegalOpError(`cannot overwrite a zero-length range at ${start}`)

    this.split(start)
    this.split(end)

    const frags = this.fragmentsForRange(start, end)
    const first = frags[0]
    const last = frags[frags.length - 1]

    if (storeName)
      this.recordName(start, end)

    // The library walks the CURRENT fragment list; an earlier move can have
    // broken the forward run, which surfaces as "cannot overwrite across a
    // split point".
    let cursor: Frag | null = first
    while (cursor && cursor !== last) {
      if (cursor.next !== this.byStart.get(cursor.end))
        throw new IllegalOpError('cannot overwrite across a split point')
      cursor = cursor.next
    }

    for (let i = 1; i < frags.length; i++)
      frags[i].edit('', false, false)

    first.edit(content, storeName, !overwrite)
  }

  private remove(start: number, end: number): void {
    this.validateRange(start, end)
    if (start === end)
      return

    this.split(start)
    this.split(end)

    let f: Frag | null = this.byStart.get(start)!
    while (f) {
      const isFirst = f.start === start

      // `chunk.edit('', false, true)` is contentOnly on the first fragment,
      // which preserves its intro AND outro. Interior fragments are reset
      // completely first. The library never special-cases previously edited
      // fragments here; a fragment walked off the byStart chain after an
      // earlier edit simply contributes its (empty) content again.
      if (f.start > start)
        f.intro = ''
      if (f.end < end)
        f.outro = ''
      f.edit('', false, isFirst)
      f = end > f.end ? this.byStart.get(f.end)! : null
    }
  }

  private move(start: number, end: number, index: number, affinity: 'left' | 'right'): void {
    if (start === end)
      return
    if (index >= start && index <= end)
      throw new IllegalOpError('cannot move a selection inside itself')

    this.split(start)
    this.split(end)
    this.split(index)

    const first = this.byStart.get(start)!
    const last = this.byEnd.get(end)!

    if (this.hasMoved) {
      let cursor: Frag | null = first
      while (cursor !== last) {
        cursor = cursor.next
        if (!cursor || cursor.start < start || cursor.end > end)
          throw new IllegalOpError(`cannot move ${start} to ${end} because an earlier move split that range`)
      }
    }

    const oldLeft = first.previous
    const oldRight = last.next

    let newLeft: Frag | null
    let newRight: Frag | null
    if (affinity === 'left') {
      newLeft = this.byEnd.get(index)
      if (!newLeft) {
        if (first === this.first)
          return
        newRight = this.first
      }
      else {
        if (newLeft.next === first)
          return
        newRight = newLeft.next
      }
    }
    else {
      newRight = this.byStart.get(index)
      if (!newRight) {
        if (last === this.last)
          return
        newLeft = this.last
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
      this.first = last.next as Frag
    if (!last.next) {
      this.last = first.previous as Frag
      this.last.next = null
    }

    first.previous = newLeft
    last.next = newRight

    if (!newLeft)
      this.first = first
    if (!newRight)
      this.last = last

    this.hasMoved = true
  }

  private indent(indentStr: string, options: ModelIndentOptions = {}): void {
    if (indentStr === '')
      return

    const isExcluded = new Set<number>()
    if (options.exclude) {
      for (const [s, e] of options.exclude) {
        for (let i = s; i < e; i++)
          isExcluded.add(i)
      }
    }

    let shouldIndentNext = options.indentStart !== false
    const pattern = /^[^\r\n]/gm
    const indentPiece = (str: string): string => {
      if (str === '')
        return str
      const indented = str.replace(pattern, (_m, offset: number) =>
        offset > 0 || shouldIndentNext ? indentStr + _m : _m)
      shouldIndentNext = str[str.length - 1] === '\n'
      return indented
    }

    this.intro = indentPiece(this.intro)

    let charIndex = 0
    let frag = this.first

    const indentAt = (index: number) => {
      shouldIndentNext = false
      if (index === frag!.start) {
        frag!.intro = frag!.intro + indentStr
      }
      else {
        // mirror the library: this split is inside an UNEDITED fragment
        // (edited chunks take the `index === frag.start` branch), and the
        // split can still be refused when the fragment is an empty edited
        // remainder - in that case the indent simply lands on the current
        // fragment
        if (this.illegalInsertSplit(index)) {
          frag!.intro = frag!.intro + indentStr
        }
        else {
          this.split(index)
          frag = frag!.next!
          frag.intro = indentStr + frag.intro
        }
      }
    }

    while (frag) {
      const end = frag.end

      if (!isExcluded.has(frag.start))
        frag.intro = indentPiece(frag.intro)

      if (frag.edited) {
        if (!isExcluded.has(charIndex))
          frag.content = indentPiece(frag.content)
      }
      else if (options.exclude) {
        charIndex = frag.start
        while (charIndex < end) {
          if (!isExcluded.has(charIndex)) {
            const code = this.original.charCodeAt(charIndex)
            if (code === NEWLINE_CODE) {
              shouldIndentNext = true
            }
            else if (code !== CR_CODE && shouldIndentNext) {
              indentAt(charIndex)
            }
          }
          charIndex += 1
        }
      }
      else {
        charIndex = frag.start
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
          if (code === NEWLINE_CODE || code === CR_CODE) {
            charIndex += 1
            continue
          }

          indentAt(charIndex)
          charIndex += 1
        }
      }

      if (!isExcluded.has(frag.end - 1))
        frag.outro = indentPiece(frag.outro)

      charIndex = frag.end
      frag = frag.next!
    }

    this.outro = indentPiece(this.outro)
  }

  // ---- output -------------------------------------------------------------

  toString(): string {
    let str = this.intro
    for (let f = this.first; f !== null; f = f.next)
      str += f.toString()
    return str + this.outro
  }

  /**
   * Records that a `storeName` overwrite of [start, end) happened.
   */
  private recordName(start: number, end: number): void {
    const name = this.original.slice(start, end)
    if (!this.storedNames.includes(name))
      this.storedNames.push(name)
  }

  // ---- expected sourcemap -------------------------------------------------

  /**
   * Renders the decoded mappings this document's sourcemap is expected to
   * contain for the given hires mode.
   *
   * The walk is the contract made concrete: generated columns advance over
   * the generated text in fragment order, but segments are only emitted for
   * surviving original characters (or edit anchors), pointing at original
   * (line, column). Inserted characters never acquire a segment, and removed
   * original characters never appear.
   */
  renderExpectedMap(hires: HiresMode): ExpectedMap {
    const lines: number[][][] = [[]]
    let genLine = 0
    let genCol = 0
    let srcLine = 0
    let srcCol = 0

    const seg = (nameIndex = -1): void => {
      const s = [genCol, 0, srcLine, srcCol]
      if (nameIndex >= 0)
        s.push(nameIndex)
      lines[genLine].push(s)
    }

    const advance = (str: string): void => {
      if (!str)
        return
      const lastNL = str.lastIndexOf('\n')
      for (let i = str.indexOf('\n'); i !== -1; i = str.indexOf('\n', i + 1)) {
        genLine += 1
        genCol = 0
        lines[genLine] = []
      }
      genCol += str.length - lastNL - 1
    }

    const addEdit = (frag: Frag): void => {
      if (!frag.content.length)
        return
      const loc = this.locate(frag.start)
      const nameIndex = frag.storeName ? this.storedNames.indexOf(frag.original) : -1
      const content = frag.content
      let previousContentLineEnd = -1
      let contentLineEnd = content.indexOf('\n', 0)
      // the library emits a segment for every line of the edit content,
      // including one on the line the first newline opens (it starts the
      // next line before deciding whether that line is the empty remainder)
      while (contentLineEnd >= 0) {
        const s = [genCol, 0, loc.line, loc.column]
        if (nameIndex >= 0)
          s.push(nameIndex)
        lines[genLine].push(s)
        genLine += 1
        genCol = 0
        lines[genLine] = []
        previousContentLineEnd = contentLineEnd
        contentLineEnd = content.indexOf('\n', contentLineEnd + 1)
        if (contentLineEnd === -1)
          break
      }
      const remainder = content.slice(previousContentLineEnd + 1)
      if (remainder.length) {
        const s = [genCol, 0, loc.line, loc.column]
        if (nameIndex >= 0)
          s.push(nameIndex)
        lines[genLine].push(s)
      }
      advance(remainder)
    }

    const advanceOriginalPos = (i: number): void => {
      if (this.original.charCodeAt(i) === NEWLINE_CODE) {
        srcLine += 1
        srcCol = 0
      }
      else {
        srcCol += 1
      }
    }

    const addUnedited = (frag: Frag): void => {
      const loc = this.locate(frag.start)
      srcLine = loc.line
      srcCol = loc.column
      let i = frag.start
      const end = frag.end

      if (hires === true) {
        while (i < end) {
          const code = this.original.charCodeAt(i)
          if (code === NEWLINE_CODE) {
            genLine += 1
            genCol = 0
            lines[genLine] = []
            srcLine += 1
            srcCol = 0
          }
          else {
            seg()
            genCol += 1
            srcCol += 1
          }
          i += 1
        }
      }
      else if (hires === 'boundary') {
        let inWord = false
        while (i < end) {
          const code = this.original.charCodeAt(i)
          if (code === NEWLINE_CODE) {
            genLine += 1
            genCol = 0
            lines[genLine] = []
            srcLine += 1
            srcCol = 0
            inWord = false
          }
          else {
            if (isWordCode(code)) {
              if (!inWord) {
                seg()
                inWord = true
              }
            }
            else {
              seg()
              inWord = false
            }
            genCol += 1
            srcCol += 1
          }
          i += 1
        }
      }
      else {
        // lo-res: one segment for each non-empty line slice, plus segments at
        // positions registered with addSourcemapLocation()
        while (i < end) {
          let newline = this.original.indexOf('\n', i)
          if (newline === -1 || newline > end)
            newline = end
          if (newline > i) {
            seg()
            const extras: Array<[number, number]> = []
            for (const location of this.sourcemapLocations) {
              if (location > i && location < newline)
                extras.push([genCol + (location - i), srcCol + (location - i)])
            }
            extras.sort((a, b) => a[0] - b[0])
            for (const [gcol, scol] of extras)
              lines[genLine].push([gcol, 0, srcLine, scol])
            srcCol += newline - i
            genCol += newline - i
          }
          if (newline === end)
            break
          srcLine += 1
          srcCol = 0
          genLine += 1
          genCol = 0
          lines[genLine] = []
          i = newline + 1
        }
      }
    }

    advance(this.intro)
    for (let f = this.first; f !== null; f = f.next) {
      const loc = this.locate(f.start)
      srcLine = loc.line
      srcCol = loc.column

      advance(f.intro)

      if (f.edited)
        addEdit(f)
      else
        addUnedited(f)

      advance(f.outro)
    }
    advance(this.outro)

    return { names: this.storedNames.slice(), mappings: lines }
  }

  /**
   * Returns every generated character as a run of atoms. Each atom records
   * the generated (line, column) and, for original characters, the original
   * index (and line/column); inserted atoms have `origin: null`.
   */
  renderAtoms(): Array<{ genLine: number, genCol: number, kind: 'original' | 'insert' | 'edit', origin: number | null, srcLine: number, srcCol: number }> {
    const atoms: Array<{ genLine: number, genCol: number, kind: 'original' | 'insert' | 'edit', origin: number | null, srcLine: number, srcCol: number }> = []
    let genLine = 0
    let genCol = 0

    const pushInsert = (str: string) => {
      for (const ch of str) {
        if (ch === '\n') {
          genLine += 1
          genCol = 0
        }
        else {
          atoms.push({ genLine, genCol, kind: 'insert', origin: null, srcLine: -1, srcCol: -1 })
          genCol += 1
        }
      }
    }

    const pushOriginal = (frag: Frag) => {
      for (let i = frag.start; i < frag.end; i++) {
        const ch = this.original[i]
        if (ch === '\n') {
          genLine += 1
          genCol = 0
        }
        else {
          const loc = this.locate(i)
          atoms.push({ genLine, genCol, kind: 'original', origin: i, srcLine: loc.line, srcCol: loc.column })
          genCol += 1
        }
      }
    }

    pushInsert(this.intro)
    for (let f = this.first; f !== null; f = f.next) {
      pushInsert(f.intro)
      if (f.edited) {
        // Only the first fragment of an edited range carries replacement
        // content (mapped to the range anchor); every other edited fragment
        // has empty content and contributes no generated characters.
        if (f.content.length) {
          const loc = this.locate(f.start)
          for (const ch of f.content) {
            if (ch === '\n') {
              genLine += 1
              genCol = 0
            }
            else {
              atoms.push({ genLine, genCol, kind: 'edit', origin: f.start, srcLine: loc.line, srcCol: loc.column })
              genCol += 1
            }
          }
        }
      }
      else
        pushOriginal(f)
      pushInsert(f.outro)
    }
    pushInsert(this.outro)

    return atoms
  }

  private locate(index: number): { line: number, column: number } {
    let line = 0
    const lastNL = this.original.lastIndexOf('\n', index - 1)
    for (let i = 0; i < index; i++) {
      if (this.original.charCodeAt(i) === NEWLINE_CODE)
        line += 1
    }
    return { line, column: index - lastNL - 1 }
  }

  /**
   * Positions of every segment an edited fragment emits, including segments
   * on lines opened by a trailing newline in the replacement (which carry no
   * replacement atom of their own).
   */
  renderEditAnchors(): Array<{ genLine: number, genCol: number, srcLine: number, srcCol: number }> {
    const out: Array<{ genLine: number, genCol: number, srcLine: number, srcCol: number }> = []
    let genLine = 0
    let genCol = 0

    const advance = (str: string) => {
      if (!str)
        return
      const lastNL = str.lastIndexOf('\n')
      for (let i = str.indexOf('\n'); i !== -1; i = str.indexOf('\n', i + 1)) {
        genLine += 1
        genCol = 0
      }
      genCol += str.length - lastNL - 1
    }

    advance(this.intro)
    for (let f = this.first; f !== null; f = f.next) {
      advance(f.intro)
      if (f.edited) {
        const loc = this.locate(f.start)
        for (let i = 0; i < f.content.length; i++) {
          if (f.content[i] === '\n') {
            // segment is emitted on the current line before the newline,
            // then the next opened line also receives one
            out.push({ genLine, genCol, srcLine: loc.line, srcCol: loc.column })
            genLine += 1
            genCol = 0
            out.push({ genLine, genCol: 0, srcLine: loc.line, srcCol: loc.column })
          }
          else {
            if (i === 0 || f.content[i - 1] === '\n')
              out.push({ genLine, genCol, srcLine: loc.line, srcCol: loc.column })
            genCol += 1
          }
        }
      }
      else {
        for (let i = f.start; i < f.end; i++) {
          if (this.original.charCodeAt(i) === NEWLINE_CODE) {
            genLine += 1
            genCol = 0
          }
          else {
            genCol += 1
          }
        }
      }
      advance(f.outro)
    }
    advance(this.outro)

    return out
  }
}
