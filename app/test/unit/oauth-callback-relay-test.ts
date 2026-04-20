import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  createOAuthCallbackRelayPayload,
  getOAuthCallbackRelayPath,
  isOAuthAction,
  OAuthCallbackRelayFileName,
} from '../../src/lib/oauth-callback-relay'

describe('oauth-callback-relay', () => {
  it('creates a stable relay file path under userData', () => {
    assert.equal(
      getOAuthCallbackRelayPath('C:\\Users\\Olly\\AppData\\Roaming\\GitHub Desktop-dev'),
      `C:\\Users\\Olly\\AppData\\Roaming\\GitHub Desktop-dev\\${OAuthCallbackRelayFileName}`
    )
  })

  it('identifies oauth actions', () => {
    assert.equal(
      isOAuthAction({ name: 'oauth', code: 'code-123', state: 'state-123' }),
      true
    )
    assert.equal(
      isOAuthAction({ name: 'unknown', url: 'x-github-client://noop' }),
      false
    )
  })

  it('adds relay metadata to oauth actions', () => {
    const payload = createOAuthCallbackRelayPayload(
      { name: 'oauth', code: 'code-123', state: 'state-123' },
      'relay-123',
      42
    )

    assert.deepEqual(payload, {
      name: 'oauth',
      code: 'code-123',
      state: 'state-123',
      relayId: 'relay-123',
      relayedAt: 42,
    })
  })
})
