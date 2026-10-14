import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {Record<string, unknown>}
 */
export function object(value, label) {
  assert.ok(isRecord(value), `${label} must be an object`)
  return value
}

/**
 * The package.json in a directory, which must hold a JSON object.
 *
 * @param {string} directory
 * @returns {Record<string, unknown>}
 */
export function readManifest(directory) {
  const path = join(directory, 'package.json')
  return object(JSON.parse(readFileSync(path, 'utf8')), path)
}
