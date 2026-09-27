/**
 * Independent character-provenance model of the public magic-string edit
 * contract.
 *
 * The model deliberately does not mirror the library's Chunk linked list.
 * It keeps the original source as immutable UTF-16 code units, partitioned at
 * every boundary any edit has ever touched, plus the inserted content
 * anchored at those boundaries. From that state it derives three observable
 * artefacts:
 *
 *   - `render()`            the generated string
 *   - `renderTagged()`      the generated string with a provenance tag per
 *                           generated code unit
 *   - `simulateMap()`       the decoded sourcemap segments the library is
 *                           contractually expected to emit, computed straight
 *                           from the tagged stream
 *
 * Operations that the public API rejects (splitting a non-empty edited
 * interval, overwriting a reordered run, moving a range an earlier move
 * fragmented, moving into self, out-of-range indices) are predicted by
 * `isLegal*`/`apply*` returning `false`, so the fuzzer filters them and every
 * generated sequence is a legal contract sequence.
 */

export type HiresMode = boolean | 'boundary'

export type InsertVariant
  = 'appendLeft' | 'prependLeft' | 'appendRight' | 'prependRight'

export type Op =
  | { type: InsertVariant; index: number; content: string }
  | { type: 'remove'; start: number; end: number }
  | {
    type: 'overwrite'
    start: number
    end: number
    content: string
    contentOnly: boolean
    storeName: boolean
  }
  | {
    type: 'move'
    start: number
    end: number
    index: number
    affinity: 'left' | 'right'
  }
  | { type: 'indent'; indentStr: string; indentStart: boolean; exclusions: Array<[number, number]> }
  | { type: 'addSourcemapLocation'; index: number }

/**
 * Provenance of a generated UTF-16 code unit:
 *   - ['orig', i]   an untouched original unit at index `i`
 *   - ['edit', i]   replacement text emitted for an edited interval; maps to
 *                   the interval start `i` (like an edited chunk)
 *   - ['insert', k] pure insertion with no source; `k` is a unique id used by
 *                   nothing except equality/debugging
 */
export type Tag = ['orig', number] | ['edit', number] | ['insert', number]

interface Interval {
  id: number
  start: number
  end: number
  status: 'alive' | 'removed' | 'edited'
  editedText: string
  /** original text of the edit that owns this interval (storeName key) */
  editKey: string
}

interface Slots {
  /** emitted after the char at the boundary (chunk.outro side) */
  lPrepend: string
  lAppend: string
  /** emitted before the char at the boundary (chunk.intro side) */
  rPrepend: string
  rAppend: string
}

const NEWLINE = 10
const CR = 13

function wordLike(code: number): boolean {
  return (code >= 97 && code <= 122)
    || (code >= 65 && code <= 90)
    || (code >= 48 && code <= 57)
    || code === 95
}

export class CharModel {
  original: string
  /** partition interval ids in original order */
  intervals: Interval[] = []
  /** interval ids in current generated order (a permutation after moves) */
  perm: number[] = []
  slots = new Map<number, Slots>()
  intro = ''
  outro = ''
  locations = new Set<number>()
  namesOrder: string[] = []
  private nextId = 0
  private insertSerial = 0

  constructor(original: string) {
    this.original = original
    const interval: Interval = {
      id: this.nextId++,
      start: 0,
      end: original.length,
      status: 'alive',
      editedText: '',
      editKey: '',
    }
    this.intervals.push(interval)
    this.perm.push(interval.id)
  }

  get length(): number {
    return this.original.length
  }

  private slot(index: number): Slots {
    let value = this.slots.get(index)
    if (!value) {
      value = { lPrepend: '', lAppend: '', rPrepend: '', rAppend: '' }
      this.slots.set(index, value)
    }
    return value
  }

  private intervalById(id: number): Interval {
    return this.intervals.find(interval => interval.id === id)!
  }

  private intervalAt(start: number): Interval | undefined {
    return this.intervals.find(interval => interval.start === start)
  }

  /** A boundary already exists when it is the start or end of an interval. */
  private isBoundary(index: number): boolean {
    return this.intervals.some(interval => interval.start === index || interval.end === index)
  }

  /**
   * Mirrors `_splitChunk`: a boundary may be introduced inside an interval
   * unless that interval is an edited chunk with non-empty replacement.
   * Empty edited chunks (removal results) are safe to split.
   */
  private canSplitAt(index: number): boolean {
    if (this.isBoundary(index))
      return true
    const interval = this.intervals.find(
      candidate => index > candidate.start && index < candidate.end,
    )
    if (!interval)
      return false
    if (interval.status === 'edited' && interval.editedText.length > 0)
      return false
    return true
  }

  private splitAt(index: number): void {
    if (this.isBoundary(index))
      return
    const owner = this.intervals.find(
      interval => index > interval.start && index < interval.end,
    )!
    const left: Interval = {
      id: this.nextId++,
      start: owner.start,
      end: index,
      status: owner.status,
      editedText: owner.editedText,
      editKey: owner.editKey,
    }
    const right: Interval = {
      id: this.nextId++,
      start: index,
      end: owner.end,
      status: owner.status,
      editedText: owner.editedText,
      editKey: owner.editKey,
    }
    const originalIndex = this.intervals.indexOf(owner)
    this.intervals.splice(originalIndex, 1, left, right)
    const permIndex = this.perm.indexOf(owner.id)
    this.perm.splice(permIndex, 1, left.id, right.id)

    // chunk.split: the new right chunk inherits the owner's outro
    const ownerSlots = this.slots.get(index)
    if (ownerSlots) {
      const rightSlots = this.slot(index)
      rightSlots.lPrepend = ownerSlots.lPrepend
      rightSlots.lAppend = ownerSlots.lAppend
      ownerSlots.lPrepend = ''
      ownerSlots.lAppend = ''
    }
  }

  private ensureBoundaries(...indices: number[]): boolean {
    if (!indices.every(index => this.canSplitAt(index)))
      return false
    indices.forEach(index => this.splitAt(index))
    return true
  }

  /**
   * The original-order run [firstStart, lastEnd] must currently be a
   * contiguous forward run in the generated permutation. This is the
   * `cannot overwrite across a split point` / `earlier move split that range`
   * contract shared by overwrite and move.
   */
  private isForwardRun(start: number, end: number): boolean {
    const runIds = this.intervals
      .filter(interval => interval.start >= start && interval.end <= end)
      .map(interval => interval.id)
    let cursor = this.perm.indexOf(runIds[0])
    for (const id of runIds) {
      if (this.perm[cursor] !== id)
        return false
      cursor += 1
    }
    return true
  }

  applyInsert(variant: InsertVariant, index: number, content: string): void {
    if (index === 0 && (variant === 'appendLeft' || variant === 'prependLeft')) {
      if (variant === 'appendLeft')
        this.intro += content
      else
        this.intro = content + this.intro
      return
    }
    if (index === this.length && (variant === 'appendRight' || variant === 'prependRight')) {
      if (variant === 'appendRight')
        this.outro += content
      else
        this.outro = content + this.outro
      return
    }
    const target = this.slot(index)
    switch (variant) {
      case 'appendLeft':
        target.lAppend += content
        break
      case 'prependLeft':
        target.lPrepend = content + target.lPrepend
        break
      case 'appendRight':
        target.rAppend += content
        break
      case 'prependRight':
        target.rPrepend = content + target.rPrepend
        break
    }
  }

  isLegalInsert(index: number): boolean {
    return this.canSplitAt(index)
  }

  isLegalRemove(start: number, end: number): boolean {
    if (start >= end)
      return true
    return this.canSplitAt(start) && this.canSplitAt(end)
  }

  applyRemove(start: number, end: number): void {
    const run = this.intervals.filter(
      interval => interval.start >= start && interval.end <= end,
    )
    for (const interval of run) {
      interval.status = 'removed'
      interval.editedText = ''
      interval.editKey = ''
      this.slot(interval.start).rPrepend = ''
      this.slot(interval.start).rAppend = ''
      this.slot(interval.end).lPrepend = ''
      this.slot(interval.end).lAppend = ''
    }
  }

  isLegalOverwrite(start: number, end: number): boolean {
    if (start >= end)
      return false
    return this.canSplitAt(start)
      && this.canSplitAt(end)
      && this.isForwardRun(start, end)
  }

  applyOverwrite(
    start: number,
    end: number,
    content: string,
    contentOnly: boolean,
    storeName: boolean,
  ): void {
    const run = this.intervals
      .filter(interval => interval.start >= start && interval.end <= end)
      .sort((a, b) => a.start - b.start)

    if (storeName) {
      const key = this.original.slice(start, end)
      if (!this.namesOrder.includes(key))
        this.namesOrder.push(key)
    }

    run.forEach((interval, position) => {
      interval.status = 'edited'
      interval.editedText = position === 0 ? content : ''
      interval.editKey = this.original.slice(interval.start, interval.end)
      // The loop in update() wipes intro/outro of every chunk except the
      // first. The first chunk only wipes them when overwrite !== contentOnly.
      if (position > 0 || !contentOnly) {
        const atStart = this.slot(interval.start)
        atStart.rPrepend = ''
        atStart.rAppend = ''
        const atEnd = this.slot(interval.end)
        atEnd.lPrepend = ''
        atEnd.lAppend = ''
      }
    })
  }

  isLegalMove(start: number, end: number, index: number): boolean {
    if (start >= end)
      return false
    if (index >= start && index <= end)
      return false
    if (!this.canSplitAt(start) || !this.canSplitAt(end) || !this.canSplitAt(index))
      return false
    return this.isForwardRun(start, end)
  }

  /** Mirrors the move() anchor/early-return logic. Returns false for a no-op. */
  applyMove(
    start: number,
    end: number,
    index: number,
    affinity: 'left' | 'right',
  ): boolean {
    const first = this.intervalAt(start)!
    const last = this.intervals.filter(
      interval => interval.end === end,
    )[0]

    let newLeftId: number | null
    let newRightId: number | null
    if (affinity === 'left') {
      const anchor = this.intervals.find(interval => interval.end === index) ?? null
      if (!anchor) {
        if (first.id === this.perm[0])
          return false
        newLeftId = null
        newRightId = this.perm[0]
      }
      else {
        const anchorPos = this.perm.indexOf(anchor.id)
        if (this.perm[anchorPos + 1] === first.id)
          return false
        newLeftId = anchor.id
        newRightId = this.perm[anchorPos + 1] ?? null
      }
    }
    else {
      const anchor = this.intervalAt(index)
      if (!anchor) {
        if (last.id === this.perm[this.perm.length - 1])
          return false
        newRightId = null
        newLeftId = this.perm[this.perm.length - 1]
      }
      else {
        const anchorPos = this.perm.indexOf(anchor.id)
        if (this.perm[anchorPos - 1] === last.id)
          return false
        newRightId = anchor.id
        newLeftId = this.perm[anchorPos - 1] ?? null
      }
    }

    const runIds = this.intervals
      .filter(interval => interval.start >= start && interval.end <= end)
      .map(interval => interval.id)
    this.perm = this.perm.filter(id => !runIds.includes(id))

    const insertAt = newRightId === null
      ? this.perm.length
      : this.perm.indexOf(newRightId)
    this.perm.splice(insertAt, 0, ...runIds)
    void newLeftId
    return true
  }
}
