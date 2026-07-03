export interface IStartupPolicyOptions {
  readonly isDevelopmentBuild: boolean
  readonly isWindows: boolean
}

export type AppLaunchMode = 'normal' | 'new-window-on-current-desktop'

export interface IStartupPolicy {
  readonly enforceSingleInstance: boolean
  readonly registerProtocolHandlers: boolean
  readonly registerDevelopmentAuthProtocolOnly: boolean
  readonly windowsAppUserModelId: string | null
}

// Keep dev-fork identity distinct from official GitHub Desktop on Windows.
export const WindowsDevForkAppUserModelId =
  'com.squirrel.GitHubDesktopMulti.GitHubDesktopMulti'

export const DevelopmentOAuthCallbackProtocol = 'x-github-desktop-dev-auth'
export const DevelopmentOAuthCallbackURL = `${DevelopmentOAuthCallbackProtocol}://oauth`
export const NewWindowOnCurrentDesktopArg = '--new-window-on-current-desktop'

export function getAppLaunchMode(args: ReadonlyArray<string>): AppLaunchMode {
  return args.includes(NewWindowOnCurrentDesktopArg)
    ? 'new-window-on-current-desktop'
    : 'normal'
}

export function getStartupPolicy(
  options: IStartupPolicyOptions
): IStartupPolicy {
  const { isDevelopmentBuild, isWindows } = options

  if (isDevelopmentBuild) {
    return {
      enforceSingleInstance: true,
      registerProtocolHandlers: false,
      registerDevelopmentAuthProtocolOnly: true,
      windowsAppUserModelId: isWindows ? WindowsDevForkAppUserModelId : null,
    }
  }

  return {
    enforceSingleInstance: true,
    registerProtocolHandlers: true,
    registerDevelopmentAuthProtocolOnly: false,
    windowsAppUserModelId: null,
  }
}
