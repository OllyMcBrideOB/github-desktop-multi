import * as Fs from 'fs'
import * as Path from 'path'
import { homedir } from 'os'
import { spawnSync } from 'child_process'

type DistDirectoryName =
  | 'GitHubDesktop-dev-win32-x64'
  | 'GitHubDesktop-dev-win32-arm64'

const executableName = 'GitHubDesktop-dev.exe'
const shortcutName = 'GitHub Desktop Dev.lnk'
const newWindowShortcutName = 'GitHub Desktop Dev - New Window.lnk'
const newWindowArguments = '--new-window-on-current-desktop'
const defaultProjectFolder = process.cwd()

const distRoot = Path.resolve(defaultProjectFolder, 'dist')
const preferredDistDirectoryNames: ReadonlyArray<DistDirectoryName> = [
  'GitHubDesktop-dev-win32-x64',
  'GitHubDesktop-dev-win32-arm64',
]

function normalizePowerShellString(value: string) {
  return value.replace(/'/g, "''")
}

function getExecutablePathFromCliArg(): string | null {
  const explicitArg = process.argv[2]
  if (!explicitArg) {
    return null
  }

  return Path.resolve(explicitArg)
}

async function pathExists(path: string) {
  try {
    await Fs.promises.access(path)
    return true
  } catch {
    return false
  }
}

interface IShortcutDetails {
  readonly path: string
  readonly targetPath: string
  readonly arguments: string
  readonly description: string
  readonly workingDirectory: string
}

async function getExecutablePathFromDist(): Promise<string | null> {
  if (!(await pathExists(distRoot))) {
    return null
  }

  for (const dirName of preferredDistDirectoryNames) {
    const candidate = Path.resolve(distRoot, dirName, executableName)
    if (await pathExists(candidate)) {
      return candidate
    }
  }

  const distEntries = await Fs.promises.readdir(distRoot)
  const fallbackCandidates = distEntries
    .filter(name => name.startsWith('GitHubDesktop-dev-win32-'))
    .map(name => Path.resolve(distRoot, name, executableName))

  for (const candidatePath of fallbackCandidates) {
    if (await pathExists(candidatePath)) {
      return candidatePath
    }
  }

  return null
}

function runPowerShell(command: string) {
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', command],
    { encoding: 'utf8' }
  )

  if (result.status !== 0 || result.error) {
    const reason = result.error
      ? result.error.message
      : `PowerShell exited with code ${result.status}: ${result.stderr.trim()}`
    throw new Error(reason)
  }

  return result.stdout
}

async function getShortcutDetails(
  shortcutPath: string
): Promise<IShortcutDetails | null> {
  if (!(await pathExists(shortcutPath))) {
    return null
  }

  const command = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$link = $ws.CreateShortcut('${normalizePowerShellString(shortcutPath)}')`,
    `$details = [pscustomobject]@{ Path = '${normalizePowerShellString(
      shortcutPath
    )}'; TargetPath = $link.TargetPath; Arguments = $link.Arguments; Description = $link.Description; WorkingDirectory = $link.WorkingDirectory }`,
    '$details | ConvertTo-Json -Compress',
  ].join('; ')

  const output = runPowerShell(command).trim()
  if (output.length === 0) {
    return null
  }

  const details = JSON.parse(output) as {
    readonly Path: string
    readonly TargetPath: string
    readonly Arguments: string
    readonly Description: string
    readonly WorkingDirectory: string
  }

  return {
    path: details.Path,
    targetPath: details.TargetPath,
    arguments: details.Arguments,
    description: details.Description,
    workingDirectory: details.WorkingDirectory,
  }
}

async function getExecutablePath(): Promise<string> {
  const explicit = getExecutablePathFromCliArg()
  if (explicit) {
    if (!(await pathExists(explicit))) {
      throw new Error(`Executable not found: ${explicit}`)
    }

    return explicit
  }

  const fromDist = await getExecutablePathFromDist()
  if (!fromDist) {
    throw new Error(
      `Could not find '${executableName}' in dist. Build first with yarn build:dev`
    )
  }

  return fromDist
}

function createShortcut(
  shortcutPath: string,
  executablePath: string,
  options: { readonly arguments?: string; readonly description?: string } = {}
) {
  const workingDirectory = Path.dirname(executablePath)
  const description = options.description ?? Path.basename(shortcutPath)
  const command = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$link = $ws.CreateShortcut('${normalizePowerShellString(shortcutPath)}')`,
    `$link.TargetPath = '${normalizePowerShellString(executablePath)}'`,
    `$link.WorkingDirectory = '${normalizePowerShellString(workingDirectory)}'`,
    `$link.IconLocation = '${normalizePowerShellString(executablePath)}'`,
    `$link.Description = '${normalizePowerShellString(description)}'`,
    options.arguments === undefined
      ? ''
      : `$link.Arguments = '${normalizePowerShellString(options.arguments)}'`,
    '$link.Save()',
  ]
    .filter(commandPart => commandPart.length > 0)
    .join('; ')

  try {
    runPowerShell(command)
  } catch (e) {
    throw new Error(`Failed to create shortcut: ${shortcutPath}. ${e}`)
  }
}

async function createShortcutWithDirectory(
  shortcutPath: string,
  executablePath: string,
  options: { readonly arguments?: string; readonly description?: string } = {}
) {
  await Fs.promises.mkdir(Path.dirname(shortcutPath), { recursive: true })
  createShortcut(shortcutPath, executablePath, options)
}

async function createWindowsShortcuts(executablePath: string) {
  const desktopPath = Path.join(homedir(), 'Desktop', shortcutName)
  const desktopNewWindowPath = Path.join(
    homedir(),
    'Desktop',
    newWindowShortcutName
  )
  const appData = process.env.APPDATA ?? homedir()
  const startMenuDirectory = Path.join(
    appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'GitHub Desktop Dev'
  )
  const startMenuPath = Path.join(startMenuDirectory, shortcutName)
  const startMenuNewWindowPath = Path.join(
    startMenuDirectory,
    newWindowShortcutName
  )
  const pinnedTaskbarPath = Path.join(
    appData,
    'Microsoft',
    'Internet Explorer',
    'Quick Launch',
    'User Pinned',
    'TaskBar',
    'GitHubDesktop-dev.lnk'
  )

  await createShortcutWithDirectory(desktopPath, executablePath)
  await createShortcutWithDirectory(desktopNewWindowPath, executablePath, {
    arguments: newWindowArguments,
    description: newWindowShortcutName,
  })
  await createShortcutWithDirectory(startMenuPath, executablePath)
  await createShortcutWithDirectory(startMenuNewWindowPath, executablePath, {
    arguments: newWindowArguments,
    description: newWindowShortcutName,
  })

  const pinnedTaskbarShortcut = await getShortcutDetails(pinnedTaskbarPath)
  const shouldRepairPinnedTaskbarShortcut =
    pinnedTaskbarShortcut !== null &&
    Path.resolve(pinnedTaskbarShortcut.targetPath).toLowerCase() ===
      Path.resolve(executablePath).toLowerCase()

  if (shouldRepairPinnedTaskbarShortcut) {
    await createShortcutWithDirectory(pinnedTaskbarPath, executablePath, {
      arguments: newWindowArguments,
      description: newWindowShortcutName,
    })
  }

  return [
    desktopPath,
    desktopNewWindowPath,
    startMenuPath,
    startMenuNewWindowPath,
    pinnedTaskbarPath,
  ]
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('This helper only supports Windows.')
    process.exit(1)
  }

  const executablePath = await getExecutablePath()
  const shortcutPaths = await createWindowsShortcuts(executablePath)
  const shortcutDetails = await Promise.all(
    shortcutPaths.map(getShortcutDetails)
  )
  const shortcutSummary = shortcutDetails
    .filter((details): details is IShortcutDetails => details !== null)
    .map(
      details =>
        `- ${details.path}\n  Target: ${details.targetPath}\n  Arguments: ${
          details.arguments || '(none)'
        }`
    )
    .join('\n')

  console.log(
    [
      `Created Desktop shortcuts for:`,
      `- ${executablePath}`,
      '',
      `Verified shortcut arguments:`,
      shortcutSummary,
      '',
      `For taskbar middle-click across virtual desktops:`,
      `- If '${shortcutName}' is already pinned, it has been repaired only when it targets this fork.`,
      `- If Windows still jumps to another virtual desktop, unpin/re-pin the taskbar icon or restart Explorer to clear cached taskbar metadata.`,
    ].join('\n')
  )
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
