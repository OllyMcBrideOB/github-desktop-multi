import '../lib/logging/main/install'

import { spawn } from 'child_process'

import {
  app,
  Menu,
  BrowserWindow,
  Tray,
  nativeImage,
  shell,
  session,
  systemPreferences,
  nativeTheme,
} from 'electron'
import * as Fs from 'fs'
import * as Path from 'path'

import { AppWindow } from './app-window'
import { buildDefaultMenu, getAllMenuItems } from './menu'
import { shellNeedsPatching, updateEnvironmentForProcess } from '../lib/shell'
import { parseAppURL } from '../lib/parse-app-url'
import {
  handleSquirrelEvent,
  installWindowsCLI,
  uninstallWindowsCLI,
} from './squirrel-updater'
import { fatalError } from '../lib/fatal-error'

import { log as writeLog } from './log'
import { UNSAFE_openDirectory } from './shell'
import { reportError } from './exception-reporting'
import {
  enableSourceMaps,
  withSourceMappedStack,
} from '../lib/source-map-support'
import { now } from './now'
import { showUncaughtException } from './show-uncaught-exception'
import { buildContextMenu } from './menu/build-context-menu'
import { OrderedWebRequest } from './ordered-webrequest'
import { installAuthenticatedImageFilter } from './authenticated-image-filter'
import { installAliveOriginFilter } from './alive-origin-filter'
import { installSameOriginFilter } from './same-origin-filter'
import * as ipcMain from './ipc-main'
import {
  getArchitecture,
  isAppRunningUnderARM64Translation,
} from '../lib/get-architecture'
import { buildSpellCheckMenu } from './menu/build-spell-check-menu'
import { getMainGUID, saveGUIDFile } from '../lib/get-main-guid'
import {
  getNotificationsPermission,
  requestNotificationsPermission,
  showNotification,
} from 'desktop-notifications'
import { initializeDesktopNotifications } from './notifications'
import parseCommandLineArgs from 'minimist'
import { CLIAction } from '../lib/cli-action'
import {
  DevelopmentOAuthCallbackProtocol,
  getStartupPolicy,
} from './startup-policy'
import {
  createOAuthCallbackRelayPayload,
  getOAuthCallbackRelayPath,
  isOAuthAction,
} from '../lib/oauth-callback-relay'

const shouldEnableDevToolsExtensions =
  process.env.GITHUB_DESKTOP_INSTALL_DEVTOOLS?.toLowerCase() === '1'

const isSecondaryTrayInstance = process.argv.includes('--secondary-desktop-instance')

if (__DEV__ && !shouldEnableDevToolsExtensions) {
  // Keep the main process predictable in the fork when running with multiple
  // windows. Extensions like Axe devtools have been a source of startup/render
  // instability and can surface as blank white windows in newer Electron builds.
  app.commandLine.appendSwitch('disable-extensions')
}

app.setAppLogsPath()
enableSourceMaps()

let mainWindow: AppWindow | null = null
const appWindows = new Map<number, AppWindow>()

const launchTime = now()

let preventQuit = false
let readyTime: number | null = null
let shouldCreateInitialWindow = true
let appTray: Electron.Tray | null = null
let didInstallDevTools = false

type OnDidLoadFn = (window: AppWindow) => void
/** See the `onDidLoad` function. */
let onDidLoadFns: Array<OnDidLoadFn> | null = []

function installDevToolsExtensions() {
  const installDevTools =
    process.env.GITHUB_DESKTOP_INSTALL_DEVTOOLS?.toLowerCase() === '1'

  if (!__DEV__ || !installDevTools || didInstallDevTools) {
    return
  }

  const {
    default: installExtension,
    REACT_DEVELOPER_TOOLS,
  } = require('electron-devtools-installer')

  const axeDevTools = {
    id: 'lhdoppojpmngadmnindnejefpokejbdd',
  }

  const extensions = [REACT_DEVELOPER_TOOLS, axeDevTools]

  didInstallDevTools = true

  try {
    void installExtension(extensions, {
      loadExtensionOptions: { allowFileAccess: true },
    })
    console.log('Added Extensions: "React Developer Tools", "axe DevTools"')
  } catch (e) {
    console.log('An error occurred while loading extensions: ', e)
    didInstallDevTools = false
  }
}

function resolveTrayIcon(): Electron.NativeImage | null {
  const candidatePaths = [
    Path.join(__dirname, 'static', 'windows-logo-64x64@2x.png'),
    Path.join(__dirname, '..', 'static', 'windows-logo-64x64@2x.png'),
    Path.join(process.cwd(), 'dist', 'GitHubDesktop-dev-win32-x64', 'resources', 'app', 'static', 'windows-logo-64x64@2x.png'),
  ]

  for (const candidate of candidatePaths) {
    const image = nativeImage.createFromPath(candidate)
    if (!image.isEmpty()) {
      return image
    }
  }

  return null
}

function showWindowInForeground() {
  const window = mainWindow ?? appWindows.values().next().value ?? null
  if (window) {
    if (window.isMinimized()) {
      window.restore()
    }

    window.show()
    window.focus()
    return
  }

  createWindow()
}

function createAppTray() {
  if (appTray !== null) {
    return
  }

  const trayIcon = resolveTrayIcon()
  if (trayIcon === null) {
    log.warn(`Unable to resolve tray icon; skipping tray setup`)
    return
  }

  appTray = new Tray(trayIcon)
  appTray.setToolTip('GitHub Desktop (Development)')
  appTray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'New window',
        click: () => {
          createWindow()
        },
      },
      {
        role: 'quit',
      },
    ])
  )

  appTray.on('click', event => {
    const clickEvent = event as {
      button?: number
    }
    const isMiddleButton = clickEvent.button === 1
    if (isMiddleButton) {
      launchAdditionalInstanceFromTray()
      return
    }

    if (mainWindow === null && appWindows.size === 0) {
      createWindow()
      return
    }

    showWindowInForeground()
  })

  appTray.on('mouse-up', event => {
    const clickEvent = event as {
      button?: number
    }
    if (clickEvent.button === 1) {
      launchAdditionalInstanceFromTray()
    }
  })
}

function launchAdditionalInstanceFromTray() {
  if (!__WIN32__) {
    createWindow({ shouldActivate: false })
    return
  }

  const executablePath = getDevelopmentBuildExecutablePath()
  if (!executablePath) {
    createWindow({ shouldActivate: false })
    return
  }

  const child = spawn(executablePath, ['--secondary-desktop-instance'], {
    detached: true,
    stdio: 'ignore',
  })

  if (child.pid === undefined) {
    createWindow({ shouldActivate: false })
    return
  }

  child.unref()
}

function destroyAppTray() {
  if (appTray === null) {
    return
  }

  appTray.destroy()
  appTray = null
}

function getWindowFromEvent(
  event?: Pick<Electron.IpcMainEvent | Electron.IpcMainInvokeEvent, 'sender'>
): AppWindow | null {
  if (!event) {
    return mainWindow
  }

  const senderWindow = BrowserWindow.fromWebContents(event.sender)
  if (!senderWindow) {
    return mainWindow
  }

  return appWindows.get(senderWindow.id) ?? mainWindow
}

function broadcastAppMenu() {
  appWindows.forEach(window => window.sendAppMenu())
}

function handleUncaughtException(error: Error) {
  preventQuit = true

  // If we haven't got a window we'll assume it's because
  // we've just launched and haven't created it yet.
  // It could also be because we're encountering an unhandled
  // exception on shutdown but that's less likely and since
  // this only affects the presentation of the crash dialog
  // it's a safe assumption to make.
  const isLaunchError = appWindows.size === 0

  if (appWindows.size > 0) {
    appWindows.forEach(window => window.destroy())
    appWindows.clear()
    mainWindow = null
  }

  showUncaughtException(isLaunchError, error)
}

/**
 * Calculates the number of seconds the app has been running
 */
function getUptimeInSeconds() {
  return (now() - launchTime) / 1000
}

function getExtraErrorContext(): Record<string, string> {
  return {
    uptime: getUptimeInSeconds().toFixed(3),
    time: new Date().toString(),
  }
}

/** Extra argument for the protocol launcher on Windows */
const protocolLauncherArg = '--protocol-launcher'

const possibleProtocols = new Set(['x-github-client'])
if (__DEV_SECRETS__) {
  possibleProtocols.add('x-github-desktop-dev-auth')
} else {
  possibleProtocols.add('x-github-desktop-auth')
}
// Also support Desktop Classic's protocols.
if (__DARWIN__) {
  possibleProtocols.add('github-mac')
} else if (__WIN32__) {
  possibleProtocols.add('github-windows')
}

const startupPolicy = getStartupPolicy({
  isDevelopmentBuild: __DEV__,
  isWindows: __WIN32__,
})

if (startupPolicy.windowsAppUserModelId !== null) {
  app.setAppUserModelId(startupPolicy.windowsAppUserModelId)
}

app.on('window-all-closed', () => {
  // If we don't subscribe to this event and all windows are closed, the default
  // behavior is to quit the app. We don't want that though, we control that
  // behavior through the mainWindow onClose event such that on macOS we only
  // hide the main window when a user attempts to close it.
  //
  // If we don't subscribe to this and change the default behavior we break
  // the crash process window which is shown after the main window is closed.
})

process.on('uncaughtException', (error: Error) => {
  error = withSourceMappedStack(error)
  reportError(error, getExtraErrorContext())
  handleUncaughtException(error)
})

let handlingSquirrelEvent = false
if (__WIN32__ && process.argv.length > 1) {
  const arg = process.argv[1]
  const promise = handleSquirrelEvent(arg)

  if (promise) {
    handlingSquirrelEvent = true
    promise
      .catch(e => log.error(`Failed handling Squirrel event: ${arg}`, e))
      .then(() => app.quit())
  }
}

if (!handlingSquirrelEvent) {
  void handleCommandLineArguments(process.argv)
}

initializeDesktopNotifications()

function handleAppURL(url: string) {
  log.info('Processing protocol url')
  const action = parseAppURL(url)

  if (startupPolicy.registerDevelopmentAuthProtocolOnly && isOAuthAction(action)) {
    void relayOAuthCallbackAction(action)
  }

  onDidLoad(window => {
    // This manual focus call _shouldn't_ be necessary, but is for Chrome on
    // macOS. See https://github.com/desktop/desktop/issues/973.
    window.focus()
    window.sendURLAction(action)
  })
}

let isDuplicateInstance = false
// If we're handling a Squirrel event we don't want to enforce single instance.
// We want to let the updated instance launch and do its work. It will then quit
// once it's done.
if (
  !handlingSquirrelEvent &&
  startupPolicy.enforceSingleInstance &&
  !isSecondaryTrayInstance
) {
  const gotSingleInstanceLock = app.requestSingleInstanceLock()
  isDuplicateInstance = !gotSingleInstanceLock

  app.on('second-instance', async (_event, args, _workingDirectory) => {
    const protocolLaunchWillRelay = await shouldHandleOAuthRelay(args)
    if (protocolLaunchWillRelay) {
      await handleCommandLineArguments(args)
      return
    }

    // Someone tried to run a second instance, we should focus our window and
    // open a new one.
    const window = mainWindow ?? appWindows.values().next().value ?? null
    if (window) {
      if (window?.isMinimized()) {
        window.restore()
      }

      if (window && !window.isVisible()) {
        window.show()
      }

      window?.focus()
    }

    createWindow()
    void handleCommandLineArguments(args)
  })

  if (isDuplicateInstance) {
    app.quit()
  }
}

if (shellNeedsPatching(process)) {
  updateEnvironmentForProcess()
}

app.on('will-finish-launching', () => {
  // macOS only
  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleAppURL(url)
  })
})

if (__DARWIN__) {
  app.on('open-file', async (event, path) => {
    event.preventDefault()

    log.info(`[main] a path to ${path} was triggered`)

    Fs.stat(path, (err, stats) => {
      if (err) {
        log.error(`Unable to open path '${path}' in Desktop`, err)
        return
      }

      if (stats.isFile()) {
        log.warn(
          `A file at ${path} was dropped onto Desktop, but it can only handle folders. Ignoring this action.`
        )
        return
      }

      // Yeah this isn't technically a CLI action we use it here to indicate
      // that it's more trusted than a URL action.
      handleCLIAction({ kind: 'open-repository', path })
    })
  })
}

function getProtocolURLFromCommandLine(argv: string[]) {
  if (!__WIN32__) {
    return null
  }

  // Desktop registers it's protocol handler callback on Windows as
  // `[executable path] --protocol-launcher "%1"`. Note that extra command
  // line arguments might be added by Chromium
  // (https://electronjs.org/docs/api/app#event-second-instance).
  if (!argv.some(arg => arg === `${protocolLauncherArg}` || arg === '--protocol-launcher')) {
    return null
  }

  const prefixes = Array.from(possibleProtocols, p => `${p}://`)
  let matchingUrl: string | null = null
  argv.some(arg => {
    const possibleValues = [arg]
    try {
      possibleValues.push(decodeURIComponent(arg))
    } catch {
      // Ignore malformed URI sequences.
    }

    const found = possibleValues.some(candidate => {
      if (!prefixes.some(p => candidate.startsWith(p))) {
        return false
      }

      try {
        new URL(candidate)
        matchingUrl = candidate
        return true
      } catch (e) {
        log.error(`Unable to parse argument as URL: ${candidate}`)
        return false
      }
    })

    return found
  })

  return matchingUrl
}

function removeLoadedExtensions() {
  if (!__DEV__ || shouldEnableDevToolsExtensions) {
    return
  }

  const extensions = session.defaultSession.getAllExtensions()
  for (const extension of extensions) {
    try {
      session.defaultSession.removeExtension(extension.id)
    } catch (e) {
      log.warn(
        `Unable to remove extension '${extension.name}' (${extension.id}) before startup`,
        e as Error
      )
    }
  }
}

async function shouldHandleOAuthRelay(argv: string[]): Promise<boolean> {
  const matchingUrl = getProtocolURLFromCommandLine(argv)
  if (matchingUrl === null) {
    return false
  }

  if (!startupPolicy.registerDevelopmentAuthProtocolOnly) {
    return false
  }

  const action = parseAppURL(matchingUrl)
  if (!isOAuthAction(action)) {
    return false
  }

  await relayOAuthCallbackAction(action)
  shouldCreateInitialWindow = false
  return true
}

async function handleCommandLineArguments(argv: string[]): Promise<void> {
  const args = parseCommandLineArgs(argv, {
    boolean: ['protocol-launcher'],
  })

  // Desktop registers it's protocol handler callback on Windows as
  // `[executable path] --protocol-launcher "%1"`. Note that extra command
  // line arguments might be added by Chromium
  // (https://electronjs.org/docs/api/app#event-second-instance).
  if (__WIN32__ && args['protocol-launcher'] === true) {
    // On Windows we'll end up getting called with something like
    // `--protocol-launcher --allow-file-access-from-files x-github-client://..`
    // which minimist naturally interprets as
    // `--allow-file-access-from-files=x:/github-client`. This is due to
    // Chromium's hot take on parsing command line arguments, see:
    // https://github.com/electron/electron/issues/20322#issuecomment-534137321
    // So while we could add '--allow-file...' as a boolean we can't know for
    // sure that Chromium won't add more switches later on which is why we have
    // to resort to looking through all arguments looking for something that
    // appears to be an app url.
    const prefixes = Array.from(possibleProtocols, p => `${p}://`)
    let matchingUrl: string | null = null
    argv.some(arg => {
      const possibleValues = [arg]
      try {
        possibleValues.push(decodeURIComponent(arg))
      } catch {
        // Ignore malformed URI sequences.
      }

      const found = possibleValues.some(candidate => {
        if (!prefixes.some(p => candidate.startsWith(p))) {
          return false
        }

        try {
          new URL(candidate)
          matchingUrl = candidate
          return true
        } catch (e) {
          log.error(`Unable to parse argument as URL: ${candidate}`)
          return false
        }
      })

      return found
    })

    if (matchingUrl) {
      const action = parseAppURL(matchingUrl)

      await shouldHandleOAuthRelay([`--protocol-launcher`, matchingUrl])
      if (
        startupPolicy.registerDevelopmentAuthProtocolOnly &&
        isOAuthAction(action)
      ) {
        // The OAuth callback was relayed and this invocation should not
        // create a new window.
        return
      }

      handleAppURL(matchingUrl)
    } else {
      log.error(`Encountered --protocol-launcher without app url`)
    }
    // If --protocol-launcher is present we always want to bail and not
    // risk a smuggled cli switch
    return
  }

  if (typeof args['cli-open'] === 'string') {
    handleCLIAction({ kind: 'open-repository', path: args['cli-open'] })
  } else if (typeof args['cli-clone'] === 'string') {
    handleCLIAction({
      kind: 'clone-url',
      url: args['cli-clone'],
      branch:
        typeof args['cli-branch'] === 'string' ? args['cli-branch'] : undefined,
    })
  }

  return
}

function handleCLIAction(action: CLIAction) {
  onDidLoad(window => {
    // This manual focus call _shouldn't_ be necessary, but is for Chrome on
    // macOS. See https://github.com/desktop/desktop/issues/973.
    window.focus()
    window.sendCLIAction(action)
  })
}

/**
 * Wrapper around app.setAsDefaultProtocolClient that adds our
 * custom prefix command line switches on Windows.
 */
function setAsDefaultProtocolClient(protocol: string) {
  if (__WIN32__) {
    const executablePath =
      startupPolicy.registerDevelopmentAuthProtocolOnly
        ? getDevelopmentBuildExecutablePath() ?? process.execPath
        : process.execPath

    app.setAsDefaultProtocolClient(protocol, executablePath, [
      protocolLauncherArg,
    ])
  } else {
    app.setAsDefaultProtocolClient(protocol)
  }
}

function openNewAppWindow() {
  createWindow()
}

function getDevelopmentBuildExecutablePath(): string | null {
  if (!__WIN32__) {
    return process.execPath
  }

  for (const candidate of [app.getPath('exe'), process.execPath]) {
    const basename = Path.basename(candidate).toLowerCase()
    if (basename !== 'electron.exe' && basename !== 'node.exe') {
      return candidate
    }
  }

  const preferredArchitecture = process.arch === 'arm64' ? 'arm64' : 'x64'

  return Path.resolve(
    process.cwd(),
    'dist',
    `GitHubDesktop-dev-win32-${preferredArchitecture}`,
    'GitHubDesktop-dev.exe'
  )
}

async function relayOAuthCallbackAction(
  action: ReturnType<typeof parseAppURL>
): Promise<boolean> {
  if (!isOAuthAction(action)) {
    return false
  }

  try {
    const relayPath = getOAuthCallbackRelayPath(app.getPath('userData'))
    const payload = createOAuthCallbackRelayPayload(action)
    await Fs.promises.writeFile(relayPath, JSON.stringify(payload), 'utf8')
    return true
  } catch (e) {
    log.error(`Unable to relay OAuth callback action`, e)
    return false
  }
}

function updateWindowsUserTasks() {
  if (!__WIN32__ || !startupPolicy.registerDevelopmentAuthProtocolOnly) {
    return
  }

  const executablePath = getDevelopmentBuildExecutablePath()
  if (!executablePath) {
    return
  }

  app.setUserTasks([
    {
      program: executablePath,
      arguments: '',
      iconPath: executablePath,
      iconIndex: 0,
      title: 'New window',
      description: 'Open another GitHub Desktop development window',
    },
  ])
}

if (process.env.GITHUB_DESKTOP_DISABLE_HARDWARE_ACCELERATION) {
  log.info(
    `GITHUB_DESKTOP_DISABLE_HARDWARE_ACCELERATION environment variable set, disabling hardware acceleration`
  )
  app.disableHardwareAcceleration()
}

app.on('ready', () => {
  removeLoadedExtensions()

  if (isDuplicateInstance || handlingSquirrelEvent || !shouldCreateInitialWindow) {
    if (!shouldCreateInitialWindow) {
      app.quit()
    }
    return
  }

  readyTime = now() - launchTime

  if (startupPolicy.registerProtocolHandlers) {
    possibleProtocols.forEach(protocol => setAsDefaultProtocolClient(protocol))
  } else if (startupPolicy.registerDevelopmentAuthProtocolOnly) {
    setAsDefaultProtocolClient(DevelopmentOAuthCallbackProtocol)
    updateWindowsUserTasks()
  }

  createWindow()
  if (!isSecondaryTrayInstance) {
    createAppTray()
  }

  const orderedWebRequest = new OrderedWebRequest(
    session.defaultSession.webRequest
  )

  // Ensures auth-related headers won't traverse http redirects to hosts
  // on different origins than the originating request.
  installSameOriginFilter(orderedWebRequest)

  // Ensures Alive websocket sessions are initiated with an acceptable Origin
  installAliveOriginFilter(orderedWebRequest)

  // Adds an authorization header for requests of avatars on GHES and private
  // repo assets
  const updateAccounts = installAuthenticatedImageFilter(orderedWebRequest)

  Menu.setApplicationMenu(
    buildDefaultMenu({
      selectedShell: null,
      selectedExternalEditor: null,
      askForConfirmationOnRepositoryRemoval: false,
      askForConfirmationOnForcePush: false,
    })
  )

  ipcMain.on('update-accounts', (_, accounts) => updateAccounts(accounts))

  ipcMain.on('update-preferred-app-menu-item-labels', (_, labels) => {
    // The current application menu is mutable and we frequently
    // change whether particular items are enabled or not through
    // the update-menu-state IPC event. This menu that we're creating
    // now will have all the items enabled so we need to merge the
    // current state with the new in order to not get a temporary
    // race conditions where menu items which shouldn't be enabled
    // are.
    const newMenu = buildDefaultMenu(labels)

    const currentMenu = Menu.getApplicationMenu()

    // This shouldn't happen but whenever one says that it does
    // so here's the escape hatch when we can't merge the current
    // menu with the new one; we just use the new one.
    if (currentMenu === null) {
      // https://github.com/electron/electron/issues/2717
      Menu.setApplicationMenu(newMenu)

      broadcastAppMenu()

      return
    }

    // It's possible that after rebuilding the menu we'll end up
    // with the exact same structural menu as we had before so we
    // keep track of whether anything has actually changed in order
    // to avoid updating the global menu and telling the renderer
    // about it.
    let menuHasChanged = false

    for (const newItem of getAllMenuItems(newMenu)) {
      // Our menu items always have ids and Electron.MenuItem takes on whatever
      // properties was defined on the MenuItemOptions template used to create it
      // but doesn't surface those in the type declaration.
      const id = (newItem as any).id

      if (!id) {
        continue
      }

      const currentItem = currentMenu.getMenuItemById(id)

      // Unfortunately the type information for getMenuItemById
      // doesn't specify if it'll return null or undefined when
      // the item doesn't exist so we'll do a falsy check here.
      if (!currentItem) {
        menuHasChanged = true
      } else {
        if (currentItem.label !== newItem.label) {
          menuHasChanged = true
        }

        // Copy the enabled property from the existing menu
        // item since it'll be the most recent reflection of
        // what the renderer wants.
        if (currentItem.enabled !== newItem.enabled) {
          newItem.enabled = currentItem.enabled
          menuHasChanged = true
        }
      }
    }

    if (menuHasChanged) {
      // https://github.com/electron/electron/issues/2717
      Menu.setApplicationMenu(newMenu)
      broadcastAppMenu()
    }
  })

  /**
   * An event sent by the renderer asking that the menu item with the given id
   * is executed (ie clicked).
   */
  ipcMain.on('execute-menu-item-by-id', (event, id) => {
    if (id === 'new-window') {
      createWindow()
      return
    }

    const currentMenu = Menu.getApplicationMenu()

    if (currentMenu === null) {
      return
    }

    const menuItem = currentMenu.getMenuItemById(id)
    if (menuItem) {
      const window = BrowserWindow.fromWebContents(event.sender) || undefined
      const fakeEvent = { preventDefault: () => {}, sender: event.sender }
      menuItem.click(fakeEvent, window, event.sender)
    }
  })

  ipcMain.on('update-menu-state', (_, items) => {
    let sendMenuChangedEvent = false

    const currentMenu = Menu.getApplicationMenu()

    if (currentMenu === null) {
      log.debug(`unable to get current menu, bailing out...`)
      return
    }

    for (const item of items) {
      const { id, state } = item

      const menuItem = currentMenu.getMenuItemById(id)

      if (menuItem) {
        // Only send the updated app menu when the state actually changes
        // or we might end up introducing a never ending loop between
        // the renderer and the main process
        if (state.enabled !== undefined && menuItem.enabled !== state.enabled) {
          menuItem.enabled = state.enabled
          sendMenuChangedEvent = true
        }
      } else {
        fatalError(`Unknown menu id: ${id}`)
      }
    }

    if (sendMenuChangedEvent) {
      Menu.setApplicationMenu(currentMenu)
      broadcastAppMenu()
    }
  })

  /**
   * Handle the action to show a contextual menu.
   *
   * It responds an array of indices that maps to the path to reach
   * the menu (or submenu) item that was clicked or null if the menu was closed
   * without clicking on any item or the item click was handled by the main
   * process as opposed to the renderer.
   */
  ipcMain.handle('show-contextual-menu', (event, items, addSpellCheckMenu) => {
    return new Promise(async resolve => {
      const window = BrowserWindow.fromWebContents(event.sender) || undefined

      const spellCheckMenuItems = addSpellCheckMenu
        ? await buildSpellCheckMenu(window)
        : undefined

      const menu = buildContextMenu(
        items,
        indices => resolve(indices),
        spellCheckMenuItems
      )

      menu.popup({ window, callback: () => resolve(null) })
    })
  })

  ipcMain.handle('check-for-updates', async (event, url) => {
    const window = getWindowFromEvent(event)
    return window?.checkForUpdates(url)
  })

  ipcMain.on('quit-and-install-updates', event => {
    const window = getWindowFromEvent(event)
    window?.quitAndInstallUpdate()
  })

  ipcMain.on('quit-app', () => app.quit())

  ipcMain.on('open-new-app-instance', () => openNewAppWindow())

  ipcMain.on('minimize-window', event =>
    getWindowFromEvent(event)?.minimizeWindow()
  )

  ipcMain.on('maximize-window', event =>
    getWindowFromEvent(event)?.maximizeWindow()
  )

  ipcMain.on('unmaximize-window', event =>
    getWindowFromEvent(event)?.unmaximizeWindow()
  )

  ipcMain.on('close-window', event => getWindowFromEvent(event)?.closeWindow())

  ipcMain.handle(
    'is-window-maximized',
    async event => getWindowFromEvent(event)?.isMaximized() ?? false
  )

  ipcMain.handle('get-apple-action-on-double-click', async () =>
    systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string')
  )

  ipcMain.handle('get-current-window-state', async event =>
    getWindowFromEvent(event)?.getCurrentWindowState()
  )

  ipcMain.handle('get-current-window-zoom-factor', async event =>
    getWindowFromEvent(event)?.getCurrentWindowZoomFactor()
  )

  ipcMain.on('set-window-zoom-factor', (event, zoomFactor: number) =>
    getWindowFromEvent(event)?.setWindowZoomFactor(zoomFactor)
  )

  if (__WIN32__) {
    ipcMain.on('install-windows-cli', installWindowsCLI)
    ipcMain.on('uninstall-windows-cli', uninstallWindowsCLI)
  }

  /**
   * An event sent by the renderer asking for a copy of the current
   * application menu.
   */
  ipcMain.on('get-app-menu', event => getWindowFromEvent(event)?.sendAppMenu())

  ipcMain.on('show-certificate-trust-dialog', (_, certificate, message) => {
    // This API is only implemented for macOS and Windows right now.
    if (__DARWIN__ || __WIN32__) {
      onDidLoad(window => {
        window.showCertificateTrustDialog(certificate, message)
      })
    }
  })

  ipcMain.on('log', (_, level, message) => writeLog(level, message))

  ipcMain.on('uncaught-exception', (_, error) => handleUncaughtException(error))

  ipcMain.on('send-error-report', (_, error, extra, nonFatal) => {
    reportError(error, { ...getExtraErrorContext(), ...extra }, nonFatal)
  })

  ipcMain.handle('open-external', async (_, path: string) => {
    const pathLowerCase = path.toLowerCase()
    if (
      pathLowerCase.startsWith('http://') ||
      pathLowerCase.startsWith('https://')
    ) {
      log.info(`opening in browser: ${path}`)
    }

    try {
      await shell.openExternal(path)
      return true
    } catch (e) {
      log.error(`Call to openExternal failed: '${e}'`)
      return false
    }
  })

  /**
   * An event sent by the renderer asking for the app's architecture
   */
  ipcMain.handle('get-path', async (_, path) => app.getPath(path))

  /**
   * An event sent by the renderer asking for the app's architecture
   */
  ipcMain.handle('get-app-architecture', async () => getArchitecture(app))

  /**
   * An event sent by the renderer asking for the app's path
   */
  ipcMain.handle('get-app-path', async () => app.getAppPath())

  /**
   * An event sent by the renderer asking for the executable path
   */
  ipcMain.handle('get-exec-path', async () => process.execPath)

  /**
   * An event sent by the renderer asking for whether the app is running under
   * rosetta translation
   */
  ipcMain.handle('is-running-under-arm64-translation', async () =>
    isAppRunningUnderARM64Translation(app)
  )

  /**
   * An event sent by the renderer asking to move the app to the application
   * folder
   */
  ipcMain.handle('move-to-applications-folder', async () => {
    app.moveToApplicationsFolder?.()
  })

  ipcMain.handle('move-to-trash', (_, path) => shell.trashItem(path))
  ipcMain.handle('show-item-in-folder', async (_, path) =>
    shell.showItemInFolder(path)
  )

  ipcMain.on('unsafe-open-directory', async (_, path) =>
    UNSAFE_openDirectory(path)
  )

  /** An event sent by the renderer asking to select all of the window's contents */
  ipcMain.on('select-all-window-contents', event =>
    getWindowFromEvent(event)?.selectAllWindowContents()
  )

  /** An event sent by the renderer indicating a modal dialog is opened */
  ipcMain.on('dialog-did-open', event => getWindowFromEvent(event)?.dialogDidOpen())

  /**
   * An event sent by the renderer asking whether the Desktop is in the
   * applications folder
   *
   * Note: This will return null when not running on Darwin
   */
  ipcMain.handle('is-in-application-folder', async () => {
    // Contrary to what the types tell you the `isInApplicationsFolder` will be undefined
    // when not on macOS
    return app.isInApplicationsFolder?.() ?? null
  })

  /**
   * Handle action to resolve proxy
   */
  ipcMain.handle('resolve-proxy', async (_, url: string) => {
    return session.defaultSession.resolveProxy(url)
  })

  /**
   * An event sent by the renderer asking to show the save dialog
   *
   * Returns null if filepath is undefined or if dialog is canceled.
   */
  ipcMain.handle('show-save-dialog', async (event, options) => {
    return (await getWindowFromEvent(event)?.showSaveDialog(options)) ?? null
  })

  /**
   * An event sent by the renderer asking to show the open dialog
   */
  ipcMain.handle('show-open-dialog', async (event, options) => {
    return (await getWindowFromEvent(event)?.showOpenDialog(options)) ?? null
  })

  /**
   * An event sent by the renderer asking obtain whether the window is focused
   */
  ipcMain.handle(
    'is-window-focused',
    async event => getWindowFromEvent(event)?.isFocused() ?? false
  )

  /** An event sent by the renderer asking to focus the main window. */
  ipcMain.on('focus-window', event => {
    getWindowFromEvent(event)?.focus()
  })

  ipcMain.on('set-native-theme-source', (_, themeName) => {
    nativeTheme.themeSource = themeName
  })

  ipcMain.handle(
    'should-use-dark-colors',
    async () => nativeTheme.shouldUseDarkColors
  )

  ipcMain.handle('get-guid', () => getMainGUID())

  ipcMain.handle('save-guid', (_, guid) => saveGUIDFile(guid))

  ipcMain.handle('show-notification', async (_, title, body, userInfo) =>
    showNotification(title, body, userInfo)
  )

  ipcMain.handle('get-notifications-permission', async () =>
    getNotificationsPermission()
  )
  ipcMain.handle('request-notifications-permission', async () =>
    requestNotificationsPermission()
  )
})

app.on('will-quit', () => {
  destroyAppTray()
})

app.on('activate', () => {
  onDidLoad(window => {
    window.show()
  })
})

app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    log.warn(`Prevented new window to: ${url}`)
    return { action: 'deny' }
  })

  // prevent link navigation within our windows
  // see https://www.electronjs.org/docs/tutorial/security#12-disable-or-limit-navigation
  contents.on('will-navigate', (event, url) => {
    event.preventDefault()
    log.warn(`Prevented navigation to: ${url}`)
  })
})

app.on(
  'certificate-error',
  (event, webContents, url, error, certificate, callback) => {
    callback(false)

    onDidLoad(window => {
      window.sendCertificateError(certificate, error, url)
    })
  }
)

function createWindow(options: { shouldActivate?: boolean } = {}) {
  const window = new AppWindow(options.shouldActivate ?? true)
  installDevToolsExtensions()

  window.onClosed(() => {
    appWindows.delete(window.id)

    if (mainWindow === window) {
      const nextWindow = appWindows.values().next().value ?? null
      mainWindow = nextWindow
    }

    if (!__DARWIN__ && !preventQuit && appWindows.size === 0) {
      app.quit()
    }
  })

  window.onDidLoad(() => {
    window.show(options.shouldActivate ?? true)
    window.sendLaunchTimingStats({
      mainReadyTime: readyTime!,
      loadTime: window.loadTime!,
      rendererReadyTime: window.rendererReadyTime!,
    })

    const fns = onDidLoadFns
    if (fns !== null) {
      onDidLoadFns = null
      for (const fn of fns) {
        fn(window)
      }
    }
  })

  appWindows.set(window.id, window)
  mainWindow = window

  window.load()
}

/**
 * Register a function to be called once the window has been loaded. If the
 * window has already been loaded, the function will be called immediately.
 */
function onDidLoad(fn: OnDidLoadFn) {
  if (onDidLoadFns) {
    onDidLoadFns.push(fn)
  } else {
    if (mainWindow) {
      fn(mainWindow)
    }
  }
}
