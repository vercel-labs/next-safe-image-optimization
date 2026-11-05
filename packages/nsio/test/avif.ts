import assert from 'node:assert/strict'

interface Box {
  type: string
  start: number
  data: number
  end: number
}

interface Item {
  id: number
  offset: number
  offsetPos: number
  offsetSize: number
  length: number
  lengthPos: number
  lengthSize: number
}

/** Parses the boxes used by the AVIFs that sharp writes, not arbitrary AVIFs. */
function boxes(input: Buffer, start = 0, end = input.length): Box[] {
  const result: Box[] = []
  for (let pos = start; pos + 8 <= end;) {
    const size = input.readUInt32BE(pos)
    assert.ok(size >= 8 && pos + size <= end, 'invalid box size')
    result.push({
      type: input.toString('ascii', pos + 4, pos + 8),
      start: pos,
      data: pos + 8,
      end: pos + size,
    })
    pos += size
  }
  return result
}

function topLevel(input: Buffer, type: string): Box {
  const box = boxes(input).find((box) => box.type === type)
  assert.ok(box, `missing ${type}`)
  return box
}

function metaChild(input: Buffer, type: string): Box {
  const meta = topLevel(input, 'meta')
  // meta is a FullBox, so its children start after its version and flags.
  const box = boxes(input, meta.data + 4, meta.end).find((box) => box.type === type)
  assert.ok(box, `missing ${type}`)
  return box
}

function uint(input: Buffer, pos: number, size: number): number {
  return size === 0 ? 0 : input.readUIntBE(pos, size)
}

/** The single-extent, file-backed items in sharp's version-0 iloc. */
function items(input: Buffer): Item[] {
  const iloc = metaChild(input, 'iloc')
  assert.equal(input[iloc.data], 0, 'only iloc version 0 is supported')
  let pos = iloc.data + 4
  const sizes = input[pos++]
  const baseSizes = input[pos++]
  const offsetSize = sizes >> 4
  const lengthSize = sizes & 0xf
  const baseOffsetSize = baseSizes >> 4
  const count = input.readUInt16BE(pos)
  pos += 2
  const result: Item[] = []
  for (let i = 0; i < count; i++) {
    const id = input.readUInt16BE(pos)
    pos += 4 // item ID and data reference index
    const baseOffsetPos = pos
    const baseOffset = uint(input, pos, baseOffsetSize)
    pos += baseOffsetSize
    const extentCount = input.readUInt16BE(pos)
    pos += 2
    assert.equal(extentCount, 1, 'only one extent is supported')
    const extentOffsetPos = pos
    const extentOffset = uint(input, pos, offsetSize)
    pos += offsetSize
    const lengthPos = pos
    const length = uint(input, pos, lengthSize)
    pos += lengthSize
    // Tests patch whichever field holds the absolute file offset. sharp uses base_offset.
    assert.ok(baseOffset === 0 || extentOffset === 0, 'split offsets are not supported')
    const offsetPos = baseOffsetSize > 0 ? baseOffsetPos : extentOffsetPos
    const offsetSizeForPatch = baseOffsetSize > 0 ? baseOffsetSize : offsetSize
    assert.ok(offsetSizeForPatch > 0 && offsetSizeForPatch <= 6)
    result.push({
      id,
      offset: baseOffset + extentOffset,
      offsetPos,
      offsetSize: offsetSizeForPatch,
      length,
      lengthPos,
      lengthSize,
    })
  }
  return result
}

function primary(input: Buffer): Item {
  const pitm = metaChild(input, 'pitm')
  assert.equal(input[pitm.data], 0, 'only pitm version 0 is supported')
  const id = input.readUInt16BE(pitm.data + 4)
  const item = items(input).find((item) => item.id === id)
  assert.ok(item, 'missing primary item')
  return item
}

/** Replaces the primary AV1 item, retaining the destination's alpha item and other metadata. */
export function replaceAvifPrimary(destination: Buffer, source: Buffer): Buffer {
  const oldPrimary = primary(destination)
  const newPrimary = primary(source)
  const delta = newPrimary.length - oldPrimary.length
  const output = Buffer.concat([
    destination.subarray(0, oldPrimary.offset),
    source.subarray(newPrimary.offset, newPrimary.offset + newPrimary.length),
    destination.subarray(oldPrimary.offset + oldPrimary.length),
  ])
  output.writeUIntBE(newPrimary.length, oldPrimary.lengthPos, oldPrimary.lengthSize)

  // The replacement changes every later absolute item offset, and the containing mdat's size.
  for (const item of items(destination)) {
    if (item.offset > oldPrimary.offset) {
      const offset = item.offset + delta
      assert.ok(offset >= 0)
      output.writeUIntBE(offset, item.offsetPos, item.offsetSize)
    }
  }
  const mdat = topLevel(destination, 'mdat')
  output.writeUInt32BE(destination.readUInt32BE(mdat.start) + delta, mdat.start)
  return output
}
