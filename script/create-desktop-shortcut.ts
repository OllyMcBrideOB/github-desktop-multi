import * as Fs from 'fs'
import * as Path from 'path'
import { homedir } from 'os'
import { spawnSync } from 'child_process'

type DistDirectoryName =
  | 'GitHubDesktop-dev-win32-x64'
  | 'GitHubDesktop-dev-win32-arm64'

const executableName = 'GitHubDesktop-dev.exe'
const shortcutName = 'GitHub Desktop Dev.lnk'
const defaultProjectFolder = Path.resolve(__dirname, '..')

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

function getExecutablePathFromDist(): string | null {
  if (!Fs.existsSync(distRoot)) {
    return null
  }

  for (const dirName of preferredDistDirectoryNames) {
    const candidate = Path.resolve(distRoot, dirName, executableName)
    if (Fs.existsSync(candidate)) {
      return candidate
    }
  }

  const fallback = Fs.readdirSync(distRoot)
    .filter(name => name.startsWith('GitHubDesktop-dev-win32-'))
    .map(name => Path.resolve(distRoot, name, executableName))
    .find(candidatePath => Fs.existsSync(candidatePath))

  return fallback ?? null
}

function getExecutablePath(): string {
  const explicit = getExecutablePathFromCliArg()
  if (explicit) {
    if (!Fs.existsSync(explicit)) {
      throw new Error(`Executable not found: ${explicit}`)
    }

    return explicit
  }

  const fromDist = getExecutablePathFromDist()
  if (!fromDist) {
    throw new Error(
      `Could not find '${executableName}' in dist. Build first with yarn build:dev`
    )
  }

  return fromDist
}

function createShortcut(shortcutPath: string, executablePath: string) {
  Fs.mkdirSync(Path.dirname(shortcutPath), { recursive: true })

  const workingDirectory = Path.dirname(executablePath)
  const command = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$link = $ws.CreateShortcut('${normalizePowerShellString(shortcutPath)}')`,
    `$link.TargetPath = '${normalizePowerShellString(executablePath)}'`,
    `$link.WorkingDirectory = '${normalizePowerShellString(workingDirectory)}'`,
    `$link.IconLocation = '${normalizePowerShellString(executablePath)}'`,
    `$link.Description = '${normalizePowerShellString(shortcutName)}'`,
    '$link.Save()',
  ].join('; ')

  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-NoLogo', '-NonInteractive', '-Command', command],
    { stdio: 'inherit' }
  )

  if (result.status !== 0 || result.error) {
    const reason = result.error
      ? result.error.message
      : `PowerShell exited with code ${result.status}`
    throw new Error(`Failed to create shortcut: ${shortcutPath}. ${reason}`)
  }
}

function createWindowsShortcuts(executablePath: string) {
  const desktopPath = Path.join(homedir(), 'Desktop', shortcutName)
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

  createShortcut(desktopPath, executablePath)
  createShortcut(startMenuPath, executablePath)
}

function main() {
  if (process.platform !== 'win32') {
    console.log('This helper only supports Windows.')
    process.exit(1)
  }

  const executablePath = getExecutablePath()
  createWindowsShortcuts(executablePath)

  console.log(
    `Created Desktop shortcuts for:\n- ${executablePath}`
  )
}

main()
