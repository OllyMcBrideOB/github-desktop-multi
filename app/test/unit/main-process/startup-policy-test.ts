import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  DevelopmentOAuthCallbackProtocol,
  DevelopmentOAuthCallbackURL,
  getAppLaunchMode,
  getStartupPolicy,
  NewWindowOnCurrentDesktopArg,
  WindowsDevForkAppUserModelId,
} from '../../../src/main-process/startup-policy'

describe('startup-policy', () => {
  it('allows development fork behavior while keeping a single instance lock', () => {
    const policy = getStartupPolicy({
      isDevelopmentBuild: true,
      isWindows: true,
    })

    assert.equal(policy.enforceSingleInstance, true)
    assert.equal(policy.registerProtocolHandlers, false)
    assert.equal(policy.registerDevelopmentAuthProtocolOnly, true)
  })

  it('uses a fork-specific windows app user model id in development builds', () => {
    const policy = getStartupPolicy({
      isDevelopmentBuild: true,
      isWindows: true,
    })

    assert.equal(policy.windowsAppUserModelId, WindowsDevForkAppUserModelId)
  })

  it('does not set a windows app user model id for non-windows development builds', () => {
    const policy = getStartupPolicy({
      isDevelopmentBuild: true,
      isWindows: false,
    })

    assert.equal(policy.windowsAppUserModelId, null)
  })

  it('keeps non-development behavior unchanged', () => {
    const policy = getStartupPolicy({
      isDevelopmentBuild: false,
      isWindows: true,
    })

    assert.equal(policy.enforceSingleInstance, true)
    assert.equal(policy.registerProtocolHandlers, true)
    assert.equal(policy.registerDevelopmentAuthProtocolOnly, false)
    assert.equal(policy.windowsAppUserModelId, null)
  })

  it('uses a stable development oauth callback protocol and url', () => {
    assert.equal(DevelopmentOAuthCallbackProtocol, 'x-github-desktop-dev-auth')
    assert.equal(
      DevelopmentOAuthCallbackURL,
      'x-github-desktop-dev-auth://oauth'
    )
  })

  it('classifies normal launches by default', () => {
    assert.equal(getAppLaunchMode(['GitHubDesktop-dev.exe']), 'normal')
  })

  it('classifies current-desktop new-window launches', () => {
    assert.equal(
      getAppLaunchMode(['GitHubDesktop-dev.exe', NewWindowOnCurrentDesktopArg]),
      'new-window-on-current-desktop'
    )
  })
})
