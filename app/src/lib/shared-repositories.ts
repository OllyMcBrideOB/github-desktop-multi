import * as Fs from 'fs'
import * as Path from 'path'

export const SharedRepositoriesFileName = 'shared-repositories.json'
const SharedRepositoriesVersion = 1

export interface ISharedRepository {
  readonly path: string
  readonly gitDir?: string
  readonly present: boolean
  readonly updatedAt: number
}

interface ISharedRepositoriesFile {
  readonly version: typeof SharedRepositoriesVersion
  readonly repositories: Record<string, ISharedRepository>
}

const emptyRegistry = (): ISharedRepositoriesFile => ({
  version: SharedRepositoriesVersion,
  repositories: {},
})

const keyForPath = (repositoryPath: string) =>
  Path.normalize(repositoryPath).toLocaleLowerCase()

const delay = (milliseconds: number) =>
  new Promise(resolve => setTimeout(resolve, milliseconds))

export class SharedRepositories {
  private readonly lockPath: string

  public constructor(private readonly filePath: string) {
    this.lockPath = `${filePath}.lock`
  }

  public async initialize(
    repositories: ReadonlyArray<{ path: string; gitDir?: string }>
  ) {
    await this.withLock(async () => {
      if (await this.fileExists()) {
        return
      }

      const registry = emptyRegistry()
      const updatedAt = Date.now()
      for (const repository of repositories) {
        registry.repositories[keyForPath(repository.path)] = {
          ...repository,
          present: true,
          updatedAt,
        }
      }
      await this.write(registry)
    })
  }

  public async getAll(): Promise<ReadonlyArray<ISharedRepository>> {
    return this.withLock(async () =>
      Object.values((await this.read()).repositories)
    )
  }

  public async setPresent(path: string, gitDir?: string) {
    await this.update(path, { path, gitDir, present: true })
  }

  public async setRemoved(path: string) {
    await this.update(path, { path, present: false })
  }

  public async move(oldPath: string, newPath: string, gitDir?: string) {
    await this.withLock(async () => {
      const registry = await this.read()
      const updatedAt = Date.now()
      registry.repositories[keyForPath(oldPath)] = {
        path: oldPath,
        present: false,
        updatedAt,
      }
      registry.repositories[keyForPath(newPath)] = {
        path: newPath,
        gitDir,
        present: true,
        updatedAt,
      }
      await this.write(registry)
    })
  }

  private async update(
    path: string,
    repository: Omit<ISharedRepository, 'updatedAt'>
  ) {
    await this.withLock(async () => {
      const registry = await this.read()
      registry.repositories[keyForPath(path)] = {
        ...repository,
        updatedAt: Date.now(),
      }
      await this.write(registry)
    })
  }

  private async fileExists() {
    try {
      await Fs.promises.access(this.filePath)
      return true
    } catch {
      return false
    }
  }

  private async read(): Promise<ISharedRepositoriesFile> {
    try {
      const parsed = JSON.parse(
        await Fs.promises.readFile(this.filePath, 'utf8')
      ) as ISharedRepositoriesFile
      return parsed.version === SharedRepositoriesVersion
        ? parsed
        : emptyRegistry()
    } catch (e) {
      if (isNodeError(e) && e.code === 'ENOENT') {
        return emptyRegistry()
      }
      throw e
    }
  }

  private async write(registry: ISharedRepositoriesFile) {
    await Fs.promises.mkdir(Path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    await Fs.promises.writeFile(temporaryPath, JSON.stringify(registry), 'utf8')
    await Fs.promises.rm(this.filePath, { force: true })
    await Fs.promises.rename(temporaryPath, this.filePath)
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await Fs.promises.mkdir(Path.dirname(this.filePath), { recursive: true })

    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const handle = await Fs.promises.open(this.lockPath, 'wx')
        try {
          return await operation()
        } finally {
          await handle.close()
          await Fs.promises.rm(this.lockPath, { force: true })
        }
      } catch (e) {
        if (!isNodeError(e) || e.code !== 'EEXIST') {
          throw e
        }

        try {
          const stat = await Fs.promises.stat(this.lockPath)
          if (Date.now() - stat.mtimeMs > 30_000) {
            await Fs.promises.rm(this.lockPath, { force: true })
            continue
          }
        } catch (statError) {
          if (!isNodeError(statError) || statError.code !== 'ENOENT') {
            throw statError
          }
        }
        await delay(25)
      }
    }

    throw new Error(`Timed out waiting for shared repository lock`)
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
