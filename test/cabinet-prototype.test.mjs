import test from 'node:test'
import assert from 'node:assert/strict'
import {
  seedCabinet,
  deriveCabinetTargets,
  AUTH_PATH,
} from '../web/src/prototype/v2/cabinet-seed.js'
import {
  cabinetResetSnapshot,
  validateCabinetReset,
  applyCabinetReset,
  cabinetQrAvailable,
} from '../web/src/prototype/v2/cabinet-logic.js'
import { qrMatrix } from '../web/src/prototype/v2/cabinet-qr.js'

function fixture() {
  const state = {
    projects: {
      sol: {
        id: 'sol',
        name: 'SOL',
        environments: [
          { id: 'sol-test', name: '测试', authBase: 'https://sol-test.example.invalid/' },
        ],
      },
    },
    cabinet: seedCabinet(),
  }
  const device = state.cabinet.devices[0]
  const preview = {
    token: 'single-use-preview',
    expiresAt: 1000,
    consumed: false,
    current: structuredClone(device.platform),
    snapshot: cabinetResetSnapshot(state, device.id),
  }
  return { state, device, preview, options: { now: 500, resolved: ['192.0.2.10'] } }
}

test('automatic cabinet targets follow project environments and preserve manual targets', () => {
  const { state } = fixture()
  const targets = deriveCabinetTargets(state)
  assert.equal(targets[0].url, `https://sol-test.example.invalid${AUTH_PATH}`)
  assert.equal(targets[0].name, 'SOL-测试')
  assert.equal(targets[1].id, 'manual-lab')
  state.projects.sol.environments[0].name = '验收'
  state.cabinet.targetOverrides['env:sol:sol-test'] = { enabled: false }
  assert.equal(deriveCabinetTargets(state)[0].name, 'SOL-验收')
  assert.equal(deriveCabinetTargets(state)[0].enabled, false)
  delete state.projects.sol
  assert.equal(deriveCabinetTargets(state).length, 1)
  assert.equal(state.cabinet.devices.length, 12)
})

test('cabinet reset checks exact IMEI, expiry, single use and all resolved IPs', () => {
  const { state, device, preview, options } = fixture()
  assert.equal(validateCabinetReset(state, device.id, preview, device.imei, options), null)
  assert.match(
    validateCabinetReset(state, device.id, preview, device.imei.slice(1), options),
    /IMEI/,
  )
  assert.match(
    validateCabinetReset(state, device.id, { ...preview, expiresAt: 500 }, device.imei, options),
    /过期/,
  )
  assert.match(
    validateCabinetReset(state, device.id, { ...preview, consumed: true }, device.imei, options),
    /已经使用/,
  )
  assert.match(
    validateCabinetReset(state, device.id, preview, device.imei, {
      ...options,
      resolved: ['192.0.2.10', '192.0.2.11'],
    }),
    /未全部匹配/,
  )
  assert.match(
    validateCabinetReset(state, device.id, preview, device.imei, { ...options, resolved: [] }),
    /未全部匹配/,
  )
})

test('cabinet reset rejects changes after preview without touching business data', () => {
  for (const mutate of [
    ({ device }) => {
      device.platform.branchId = 999
    },
    ({ state }) => {
      state.cabinet.settings.database = 'another_database'
    },
    ({ state }) => {
      state.projects.sol.environments[0].authBase = 'https://new.example.invalid'
    },
    ({ state }) => {
      state.cabinet.targetOverrides['env:sol:sol-test'] = { enabled: false }
    },
  ]) {
    const value = fixture()
    mutate(value)
    const before = structuredClone(value.device.platform)
    assert.equal(
      applyCabinetReset(
        value.state,
        value.device.id,
        value.preview,
        value.device.imei,
        value.options,
      ).status,
      'failed',
    )
    assert.deepEqual(value.device.platform, before)
  }
})

test('cabinet reset modifies only binding and slot platform while preserving routing and photos', () => {
  const { state, device, preview, options } = fixture()
  device.photo = { dataUrl: 'photo-kept' }
  device.platform.otherField = 'keep'
  preview.snapshot = cabinetResetSnapshot(state, device.id)
  const beforeTarget = device.targetId
  const outcome = applyCabinetReset(state, device.id, preview, device.imei, options)
  assert.equal(outcome.status, 'success')
  assert.equal(device.targetId, beforeTarget)
  assert.equal(device.photo.dataUrl, 'photo-kept')
  assert.equal(device.platform.otherField, 'keep')
  assert.equal(device.platform.platformId, 2)
  assert.equal(device.platform.agentId, null)
  assert.equal(device.platform.bindTime, null)
  assert.ok(device.platform.positions.every((position) => position.platformId === 2))
})

test('cabinet reset supports zero slots, no-op, and unknown results without automatic retry', () => {
  const zero = fixture()
  zero.preview.current.positions = []
  assert.equal(
    applyCabinetReset(zero.state, zero.device.id, zero.preview, zero.device.imei, zero.options)
      .status,
    'success',
  )
  assert.equal(zero.device.platform.positions.length, 0)
  const noop = fixture()
  noop.preview.current = {
    platformId: 2,
    agentId: null,
    merchantId: null,
    branchId: null,
    bindTime: null,
    positions: [],
  }
  const noopBefore = structuredClone(noop.device)
  assert.equal(
    applyCabinetReset(noop.state, noop.device.id, noop.preview, noop.device.imei, noop.options)
      .status,
    'noop',
  )
  assert.deepEqual(noop.device, noopBefore)
  const unknown = fixture()
  const before = structuredClone(unknown.device)
  assert.equal(
    applyCabinetReset(unknown.state, unknown.device.id, unknown.preview, unknown.device.imei, {
      ...unknown.options,
      unknown: true,
    }).status,
    'unknown',
  )
  assert.deepEqual(unknown.device, before)
})

test('QR generator produces full data matrices for local short and long device URLs', () => {
  const small = qrMatrix('HELLO')
  const device = qrMatrix(
    'https://sol-test.example.invalid/device/cabinet.html?sno=860000000000001',
  )
  const large = qrMatrix(`https://example.invalid/${'a'.repeat(230)}`)
  assert.equal(small.length, 21)
  assert.equal(device.length, 33)
  assert.equal(large.length, 57)
  assert.ok(
    [...small, ...device, ...large].every((row) => row.every((cell) => typeof cell === 'boolean')),
  )
  assert.throws(() => qrMatrix('a'.repeat(300)), /过长/)
})

test('QR requires a successful auth on the current enabled target, even when two targets use the same URL', () => {
  const { state, device } = fixture()
  const target = deriveCabinetTargets(state)[0]
  assert.equal(cabinetQrAvailable(device, target), true)
  assert.equal(cabinetQrAvailable(device, { ...target, id: 'another-target' }), false)
  assert.equal(cabinetQrAvailable(device, { ...target, enabled: false }), false)
  assert.equal(
    cabinetQrAvailable(device, { ...target, url: 'https://changed.example.invalid/auth' }),
    false,
  )
  assert.equal(
    cabinetQrAvailable({ ...device, lastAuth: { ...device.lastAuth, status: 'failed' } }, target),
    false,
  )
})
