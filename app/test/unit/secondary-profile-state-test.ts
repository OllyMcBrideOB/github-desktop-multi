import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  applySecondaryProfileStateSnapshot,
  createSecondaryProfileStateSnapshot,
  HasShownWelcomeFlowLocalStorageKey,
  SecondaryProfileStateVersion,
  UsersLocalStorageKey,
} from '../../src/lib/secondary-profile-state'

class TestStorage {
  private readonly values = new Map<string, string>()

  public getItem(key: string) {
    return this.values.get(key) ?? null
  }

  public setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

describe('secondary-profile-state', () => {
  it('creates a snapshot from local storage values', () => {
    const storage = new TestStorage()
    storage.setItem(UsersLocalStorageKey, '[]')
    storage.setItem(HasShownWelcomeFlowLocalStorageKey, '1')

    const snapshot = createSecondaryProfileStateSnapshot(storage)

    assert.equal(snapshot.version, SecondaryProfileStateVersion)
    assert.equal(snapshot.users, '[]')
    assert.equal(snapshot.hasShownWelcomeFlow, '1')
  })

  it('marks welcome complete when stored users exist', () => {
    const storage = new TestStorage()
    storage.setItem(
      UsersLocalStorageKey,
      JSON.stringify([{ login: 'octocat', endpoint: 'https://github.com' }])
    )

    const snapshot = createSecondaryProfileStateSnapshot(storage)

    assert.equal(snapshot.hasShownWelcomeFlow, '1')
  })

  it('applies a compatible snapshot to local storage', () => {
    const storage = new TestStorage()
    const didApply = applySecondaryProfileStateSnapshot(
      {
        version: SecondaryProfileStateVersion,
        updatedAt: Date.now(),
        users: '[{"login":"octocat"}]',
        hasShownWelcomeFlow: '1',
      },
      storage
    )

    assert.equal(didApply, true)
    assert.equal(storage.getItem(UsersLocalStorageKey), '[{"login":"octocat"}]')
    assert.equal(storage.getItem(HasShownWelcomeFlowLocalStorageKey), '1')
  })

  it('ignores incompatible snapshots', () => {
    const storage = new TestStorage()
    const didApply = applySecondaryProfileStateSnapshot(
      {
        version: 999 as typeof SecondaryProfileStateVersion,
        updatedAt: Date.now(),
        users: '[{"login":"octocat"}]',
        hasShownWelcomeFlow: '1',
      },
      storage
    )

    assert.equal(didApply, false)
    assert.equal(storage.getItem(UsersLocalStorageKey), null)
  })
})
