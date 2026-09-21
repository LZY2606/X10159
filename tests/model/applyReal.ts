import type { MagicString } from '../../src/index.ts'
import type { Operation } from './generator.ts'

/** Replays a modelled operation onto a real MagicString instance. */
export function applyReal(s: MagicString, operation: Operation): void {
  switch (operation.type) {
    case 'appendLeft':
      s.appendLeft(operation.index, operation.content)
      break
    case 'prependLeft':
      s.prependLeft(operation.index, operation.content)
      break
    case 'appendRight':
      s.appendRight(operation.index, operation.content)
      break
    case 'prependRight':
      s.prependRight(operation.index, operation.content)
      break
    case 'overwrite':
      s.overwrite(operation.start, operation.end, operation.content, {
        storeName: operation.storeName,
        contentOnly: operation.contentOnly,
      })
      break
    case 'remove':
      s.remove(operation.start, operation.end)
      break
    case 'move':
      s.move(operation.start, operation.end, operation.index, operation.affinity)
      break
    case 'indent':
      s.indent(operation.indentStr, operation.options)
      break
    case 'addSourcemapLocation':
      s.addSourcemapLocation(operation.index)
      break
    case 'cloneCheck':
      break
  }
}
