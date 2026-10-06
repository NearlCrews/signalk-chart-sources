import assert from 'node:assert/strict'

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
