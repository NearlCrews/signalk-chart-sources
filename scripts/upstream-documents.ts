import type { LngLatBbox } from '../src/index.js'
import { isRecord } from './records.mjs'

// Readers for what the scheduled upstream monitor fetches: WMS layer trees, advertised envelopes, and
// tile image headers. They hold no network code, so the suite can exercise them on fixtures.

export type RecordValue = Record<string, unknown>

/**
 * The widest gap between two published coordinates that still counts as the same value: parse and
 * floating-point residue, such as the 90.00000000000011 EMODnet advertises for a layer reaching the
 * pole. Any real move of an envelope is far larger.
 */
export const PARSE_NOISE_DEGREES = 1e-6

/** The content type a PNG tile arrives as, whatever PNG variant the request named. */
export const PNG_CONTENT_TYPE = /^image\/png/i
/** The content type a WebP tile arrives as. */
export const WEBP_CONTENT_TYPE = /^image\/webp/i

/** A value an XML parser may hand back as one item or many, as a list either way. */
export function array(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

export function strings(value: unknown): string[] {
  return array(value).filter((entry): entry is string => typeof entry === 'string')
}

type EnvelopeEdges = readonly [west: string, south: string, east: string, north: string]

const WMS_ENVELOPE_EDGES: EnvelopeEdges = [
  'westBoundLongitude',
  'southBoundLatitude',
  'eastBoundLongitude',
  'northBoundLatitude'
]
export const ARCGIS_EXTENT_EDGES: EnvelopeEdges = ['xmin', 'ymin', 'xmax', 'ymax']

/**
 * A coordinate published as a number or a numeric string, and NaN for anything else. Number reads a
 * blank string as 0, so an edge left empty or holding only whitespace must not reach it.
 */
function coordinate(value: unknown): number {
  return typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : Number.NaN
}

const isLatitude = (value: number): boolean => Math.abs(value) <= 90 + PARSE_NOISE_DEGREES

/**
 * An advertised envelope as a west-to-east bbox, or null when it is missing or malformed: an edge that
 * is not a finite number, a latitude past a pole, or a south edge north of the north edge. An envelope
 * crossing the antimeridian, west edge east of the east edge, is null too: the comparisons below read
 * every box west to east, and would misjudge one that wraps. The edges default to a WMS
 * EX_GeographicBoundingBox.
 */
export function envelopeOf(box: unknown, [west, south, east, north] = WMS_ENVELOPE_EDGES): LngLatBbox | null {
  if (!isRecord(box)) return null
  const envelope: LngLatBbox = [
    coordinate(box[west]),
    coordinate(box[south]),
    coordinate(box[east]),
    coordinate(box[north])
  ]
  if (!envelope.every(Number.isFinite)) return null
  const [w, s, e, n] = envelope
  return w <= e && s <= n && isLatitude(s) && isLatitude(n) ? envelope : null
}

/** The smallest box holding every envelope, or null when any of them is missing or there are none. */
export function envelopeUnion(envelopes: readonly (LngLatBbox | null)[]): LngLatBbox | null {
  let union: LngLatBbox | null = null
  for (const envelope of envelopes) {
    if (envelope === null) return null
    union =
      union === null
        ? envelope
        : [
            Math.min(union[0], envelope[0]),
            Math.min(union[1], envelope[1]),
            Math.max(union[2], envelope[2]),
            Math.max(union[3], envelope[3])
          ]
  }
  return union
}

/** The four edges of a box, in LngLatBbox order. */
export const EDGES = ['west', 'south', 'east', 'north'] as const
export type Edge = (typeof EDGES)[number]

/**
 * How far, in degrees, the box reaches past the envelope on each edge: zero or less where the envelope
 * holds it. Both must run west to east. envelopeOf never returns a crossing envelope, and a catalog
 * box crossing the antimeridian throws rather than reading as held: its edges compared one by one
 * would give a confident wrong answer.
 */
export function edgeOverhangs(box: LngLatBbox, envelope: LngLatBbox): Readonly<Record<Edge, number>> {
  const crossing = box[0] > box[2] ? box : envelope[0] > envelope[2] ? envelope : null
  if (crossing) {
    throw new RangeError(`${JSON.stringify(crossing)} crosses the antimeridian, which this check cannot compare`)
  }
  return {
    west: envelope[0] - box[0],
    south: envelope[1] - box[1],
    east: box[2] - envelope[2],
    north: box[3] - envelope[3]
  }
}

/** How far the box reaches past the envelope on its worst edge: zero or less when the envelope holds it. */
export function overhang(box: LngLatBbox, envelope: LngLatBbox): number {
  const overhangs = edgeOverhangs(box, envelope)
  return Math.max(...EDGES.map((edge) => overhangs[edge]))
}

/** A named WMS layer, with what WMS 1.3.0 lets it inherit from the layers enclosing it applied. */
export interface WmsLayer {
  readonly entry: RecordValue
  /** Its own EX_GeographicBoundingBox, or the nearest enclosing layer's, which a child inherits. */
  readonly envelope: LngLatBbox | null
  /** Its own style names plus every enclosing layer's, which a child inherits in addition to its own. */
  readonly styles: readonly string[]
}

function styleNames(entry: RecordValue): string[] {
  return strings(
    array(entry['Style'])
      .filter(isRecord)
      .map((style) => style['Name'])
  )
}

/**
 * Index every named layer in a WMS layer tree. WMS 1.3.0 (section 7.2.4.8) lets a child inherit its
 * parent's geographic envelope when it declares none, and adds its parent's styles to its own, so a
 * layer read without its ancestors can look envelope-less or short of a style its server accepts.
 * A layer that declares an envelope keeps its own even when it is malformed, which reads as null.
 */
export function collectWmsLayers(
  layer: unknown,
  inherited: Omit<WmsLayer, 'entry'> = { envelope: null, styles: [] },
  layers = new Map<string, WmsLayer>()
): Map<string, WmsLayer> {
  for (const entry of array(layer)) {
    if (!isRecord(entry)) continue
    const ownEnvelope = entry['EX_GeographicBoundingBox']
    const ownStyles = styleNames(entry)
    const resolved = {
      envelope: ownEnvelope === undefined ? inherited.envelope : envelopeOf(ownEnvelope),
      styles: ownStyles.length === 0 ? inherited.styles : [...inherited.styles, ...ownStyles]
    }
    if (typeof entry['Name'] === 'string') layers.set(entry['Name'], { entry, ...resolved })
    collectWmsLayers(entry['Layer'], resolved, layers)
  }
  return layers
}

/** The pixel size a tile image declares in its header. */
export interface TileDimensions {
  readonly width: number
  readonly height: number
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}

const viewOf = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

function pngDimensions(bytes: Uint8Array): TileDimensions {
  // The signature, then the IHDR chunk, which PNG requires first: length, type, width, height.
  if (bytes.byteLength < 24) throw new RangeError('the PNG tile is truncated')
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte) || ascii(bytes, 12, 16) !== 'IHDR') {
    throw new TypeError('the PNG tile has no PNG header')
  }
  const view = viewOf(bytes)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

// cspell:ignore VP8L VP8X
function webpDimensions(bytes: Uint8Array): TileDimensions {
  // A RIFF container whose first chunk names the encoding: VP8 lossy, VP8L lossless, or VP8X extended.
  if (bytes.byteLength < 30) throw new RangeError('the WebP tile is truncated')
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== 'WEBP') {
    throw new TypeError('the WebP tile has no WebP header')
  }
  const view = viewOf(bytes)
  switch (ascii(bytes, 12, 16)) {
    case 'VP8 ':
      // A three-byte frame tag and the key frame start code, then 14-bit dimensions.
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
        throw new TypeError('the WebP tile has no key frame')
      }
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    case 'VP8L': {
      // One signature byte, then the width and height less one, packed into 14 bits each.
      if (bytes[20] !== 0x2f) throw new TypeError('the WebP tile has no lossless signature')
      const packed = view.getUint32(21, true)
      return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 }
    }
    case 'VP8X':
      // The canvas width and height less one, as 24-bit little-endian values.
      return {
        width: (view.getUint16(24, true) | (view.getUint8(26) << 16)) + 1,
        height: (view.getUint16(27, true) | (view.getUint8(29) << 16)) + 1
      }
    default:
      throw new TypeError(`the WebP tile uses an unknown ${JSON.stringify(ascii(bytes, 12, 16))} chunk`)
  }
}

/**
 * The pixel size a PNG or WebP tile declares, or null for a format the monitor does not read, such as a
 * vector tile. A tile that claims to be PNG or WebP but carries no valid header throws.
 */
export function tileDimensions(contentType: string, bytes: Uint8Array): TileDimensions | null {
  if (PNG_CONTENT_TYPE.test(contentType)) return pngDimensions(bytes)
  if (WEBP_CONTENT_TYPE.test(contentType)) return webpDimensions(bytes)
  return null
}
