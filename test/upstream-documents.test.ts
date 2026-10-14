import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ARCGIS_EXTENT_EDGES,
  array,
  collectWmsLayers,
  edgeOverhangs,
  envelopeOf,
  envelopeUnion,
  overhang,
  strings,
  tileDimensions
} from '../scripts/upstream-documents.js'

/** An EX_GeographicBoundingBox as the monitor's XML parser hands it over: every value a string. */
const box = (west: number, south: number, east: number, north: number): Record<string, string> => ({
  westBoundLongitude: String(west),
  southBoundLatitude: String(south),
  eastBoundLongitude: String(east),
  northBoundLatitude: String(north)
})

test('a value parsed as one item or many reads as a list either way', () => {
  assert.deepEqual(array(undefined), [])
  assert.deepEqual(array('one'), ['one'])
  assert.deepEqual(array(['one', 'two']), ['one', 'two'])
  // A repeated element with an attribute parses as an object, which a string list leaves out.
  assert.deepEqual(strings(['EPSG:3857', { '#text': 'EPSG:4326', '@_default': 'true' }, 'CRS:84']), [
    'EPSG:3857',
    'CRS:84'
  ])
  assert.deepEqual(strings('image/png'), ['image/png'])
})

test('advertised envelopes read numbers and numeric strings, and nothing else', () => {
  assert.deepEqual(envelopeOf(box(-10, 20, 30, 40)), [-10, 20, 30, 40])
  assert.deepEqual(
    envelopeOf({ xmin: -180, ymin: -15.5, xmax: 180, ymax: 74.7 }, ARCGIS_EXTENT_EDGES),
    [-180, -15.5, 180, 74.7]
  )
  assert.equal(envelopeOf(undefined), null)
  assert.equal(envelopeOf({ ...box(-10, 20, 30, 40), northBoundLatitude: '' }), null)
  assert.equal(envelopeOf({ ...box(-10, 20, 30, 40), eastBoundLongitude: 'east' }), null)
  // Number reads a blank string as 0, so an edge holding only whitespace must not become the equator.
  assert.equal(envelopeOf({ ...box(-10, 20, 30, 40), westBoundLongitude: ' ' }), null)
})

test('a malformed or antimeridian-crossing envelope reads as unusable', () => {
  // Floating-point residue at a pole is still an envelope.
  assert.deepEqual(
    envelopeOf(box(-70.5, 11, 43.00312503, 90.00000000000011)),
    [-70.5, 11, 43.00312503, 90.00000000000011]
  )
  assert.equal(envelopeOf(box(-10, 20, 30, 95)), null, 'a latitude past the pole')
  assert.equal(envelopeOf(box(-10, -91, 30, 40)), null, 'a latitude past the pole')
  assert.equal(envelopeOf(box(-10, 40, 30, 20)), null, 'south north of north')
  // Every comparison reads west to east, so a wrapping envelope is refused rather than misjudged.
  assert.equal(envelopeOf(box(170, 0, -170, 10)), null, 'crossing the antimeridian')
})

test('the union of envelopes holds every one of them, and fails closed on a missing one', () => {
  assert.deepEqual(
    envelopeUnion([
      [-10, 20, 30, 40],
      [-20, 25, 10, 50]
    ]),
    [-20, 20, 30, 50]
  )
  assert.equal(envelopeUnion([[-10, 20, 30, 40], null]), null)
  assert.equal(envelopeUnion([]), null)
})

test('edge overhangs measure each edge of a box past an envelope', () => {
  assert.deepEqual(edgeOverhangs([-12, 25, 31, 35], [-10, 20, 30, 40]), { west: 2, south: -5, east: 1, north: -5 })
  assert.throws(() => edgeOverhangs([170, 0, -170, 10], [160, 0, 175, 10]), /crosses the antimeridian/)
})

test('overhang measures the worst edge of a box past an envelope', () => {
  const envelope = [-10, 20, 30, 40] as const
  assert.equal(overhang([-5, 25, 25, 35], envelope), -5)
  assert.equal(overhang(envelope, envelope), 0)
  // Each edge is measured outward, so a box past any one side reports that side.
  assert.equal(overhang([-12, 25, 25, 35], envelope), 2)
  assert.equal(overhang([-5, 17, 25, 35], envelope), 3)
  assert.equal(overhang([-5, 25, 31, 35], envelope), 1)
  assert.equal(overhang([-5, 25, 25, 44], envelope), 4)
  // Edge by edge, this box would read as held although it runs about 15 degrees past the east edge.
  assert.throws(() => overhang([170, 0, -170, 10], [160, 0, 175, 10]), /crosses the antimeridian/)
  assert.throws(() => overhang([160, 0, 175, 10], [170, 0, -170, 10]), /\[170,0,-170,10\] crosses/)
})

test('WMS layers inherit an enclosing envelope and add enclosing styles', () => {
  const layers = collectWmsLayers({
    Title: 'Root',
    EX_GeographicBoundingBox: box(-180, -85, 180, 85),
    Style: { Name: 'shared' },
    Layer: [
      { Name: 'plain', Style: [{ Name: 'own' }, { Title: 'unnamed' }] },
      {
        Name: 'regional',
        EX_GeographicBoundingBox: box(-20, 30, 40, 70),
        Layer: { Name: 'nested', Style: { Name: 'deep' } }
      },
      { Name: 'malformed', EX_GeographicBoundingBox: { westBoundLongitude: 'nowhere' } },
      'not a layer'
    ]
  })
  // The unnamed root is walked for what it passes down, but no request can name it.
  assert.deepEqual([...layers.keys()], ['plain', 'regional', 'nested', 'malformed'])
  assert.deepEqual(layers.get('plain')?.envelope, [-180, -85, 180, 85])
  assert.deepEqual(layers.get('plain')?.styles, ['shared', 'own'])
  assert.deepEqual(layers.get('regional')?.envelope, [-20, 30, 40, 70])
  // A layer declaring no style of its own shares its parent's list rather than a copy of it.
  assert.deepEqual(layers.get('regional')?.styles, ['shared'])
  assert.equal(layers.get('regional')?.styles, layers.get('malformed')?.styles)
  assert.deepEqual(layers.get('nested')?.envelope, [-20, 30, 40, 70])
  assert.deepEqual(layers.get('nested')?.styles, ['shared', 'deep'])
  // A layer that declares an envelope keeps it, so a broken one is reported rather than papered over.
  assert.equal(layers.get('malformed')?.envelope, null)
  assert.equal(layers.get('nested')?.entry['Name'], 'nested')
})

test('a WMS layer tree with no envelope anywhere leaves its layers without one', () => {
  assert.equal(collectWmsLayers({ Name: 'bare' }).get('bare')?.envelope, null)
})

const bytes = (...parts: readonly (string | readonly number[])[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((part) => (typeof part === 'string' ? [...part].map((c) => c.charCodeAt(0)) : part)))

const u32be = (value: number): number[] => [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
const u16le = (value: number): number[] => [value & 0xff, value >>> 8]
const u24le = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, value >>> 16]
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

/** A PNG signature and IHDR chunk header, which is all the monitor reads. */
const png = (width: number, height: number): Uint8Array =>
  bytes(PNG_SIGNATURE, u32be(13), 'IHDR', u32be(width), u32be(height), [8, 6, 0, 0, 0])

/** A RIFF WebP container opening with the given chunk and its payload. */
const webp = (chunk: string, payload: readonly number[]): Uint8Array =>
  bytes('RIFF', [0, 0, 0, 0], 'WEBP', chunk, [0, 0, 0, 0], payload, new Array(16).fill(0))

test('PNG tiles report the size in their IHDR header', () => {
  assert.deepEqual(tileDimensions('image/png', png(256, 256)), { width: 256, height: 256 })
  assert.deepEqual(tileDimensions('image/png; mode=8bit', png(512, 512)), { width: 512, height: 512 })
  assert.throws(() => tileDimensions('image/png', png(256, 256).subarray(0, 20)), /truncated/)
  const notPng = png(256, 256)
  notPng[1] = 0
  assert.throws(() => tileDimensions('image/png', notPng), /no PNG header/)
})

// cspell:ignore VP8L VP8X RIFX ALPH
test('WebP tiles report their size from each of the three encodings', () => {
  // Lossy: a three-byte frame tag and the start code, then 14-bit dimensions with two scale bits.
  const lossy = webp('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(512 | 0x4000), ...u16le(256)])
  assert.deepEqual(tileDimensions('image/webp', lossy), { width: 512, height: 256 })
  // Lossless: a signature byte, then the width and height less one in 14 bits each.
  const packed = 511 | (255 << 14)
  const lossless = webp('VP8L', [0x2f, packed & 0xff, (packed >>> 8) & 0xff, (packed >>> 16) & 0xff, packed >>> 24])
  assert.deepEqual(tileDimensions('image/webp', lossless), { width: 512, height: 256 })
  // Extended: flags and reserved bytes, then the canvas size less one in 24 bits each.
  const extended = webp('VP8X', [0, 0, 0, 0, ...u24le(511), ...u24le(255)])
  assert.deepEqual(tileDimensions('image/webp', extended), { width: 512, height: 256 })

  assert.throws(() => tileDimensions('image/webp', lossy.subarray(0, 29)), /truncated/)
  const noKeyFrame = lossy.slice()
  noKeyFrame[23] = 0
  assert.throws(() => tileDimensions('image/webp', noKeyFrame), /no key frame/)
  const noSignature = lossless.slice()
  noSignature[20] = 0
  assert.throws(() => tileDimensions('image/webp', noSignature), /no lossless signature/)
  assert.throws(() => tileDimensions('image/webp', bytes('RIFX', new Array(26).fill(0))), /no WebP header/)
  assert.throws(() => tileDimensions('image/webp', webp('ALPH', [])), /unknown "ALPH" chunk/)
})

test('formats the monitor does not size come back as null', () => {
  assert.equal(tileDimensions('application/x-protobuf', bytes([1, 2, 3])), null)
  assert.equal(tileDimensions('image/jpeg', bytes([0xff, 0xd8, 0xff])), null)
})
