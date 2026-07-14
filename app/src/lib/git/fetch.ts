import { git, GitError, IGitStringExecutionOptions } from './core'
import { Repository } from '../../models/repository'
import { IFetchProgress } from '../../models/progress'
import { FetchProgressParser, executionOptionsWithProgress } from '../progress'
import { IRemote } from '../../models/remote'
import { ITrackingBranch } from '../../models/branch'
import { envForRemoteOperation } from './environment'
import { coerceToString } from './coerce-to-string'

const codexRefRe = /\brefs\/codex\/[^\s'"`<>]+/g

interface ICodexRef {
  readonly name: string
  readonly objectId: string
}

export function getCodexRefsFromText(text: string) {
  return new Set([...text.matchAll(codexRefRe)].map(match => match[0]))
}

export function getCodexRefsFromFetchError(error: GitError) {
  return new Set([
    ...getCodexRefsFromText(error.message),
    ...getCodexRefsFromText(coerceToString(error.result.stderr)),
    ...getCodexRefsFromText(coerceToString(error.result.stdout)),
  ])
}

export function parseCodexRefs(output: string): ReadonlyArray<ICodexRef> {
  return output
    .split('\n')
    .map(line => line.trim().split(/\s+/, 2))
    .filter(
      (parts): parts is [string, string] =>
        parts.length === 2 && parts[0].startsWith('refs/codex/')
    )
    .map(([name, objectId]) => ({ name, objectId }))
}

export function getMissingObjectIds(output: string): ReadonlySet<string> {
  return new Set(
    output
      .split('\n')
      .map(line => line.trim().split(/\s+/, 2))
      .filter(parts => parts.length === 2 && parts[1] === 'missing')
      .map(parts => parts[0])
  )
}

/**
 * Codex checkpoint refs are ephemeral and can outlive their objects when a
 * task is cleaned up. Remove only broken refs, and only if they still point to
 * the object we inspected, so a concurrently updated checkpoint is preserved.
 */
export async function pruneBrokenCodexRefs(
  repository: Repository
): Promise<number> {
  try {
    const refsResult = await git(
      ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/codex/'],
      repository.path,
      'listCodexRefs'
    )
    const refs = parseCodexRefs(refsResult.stdout)
    if (refs.length === 0) {
      return 0
    }

    const objectResult = await git(
      ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      repository.path,
      'checkCodexRefObjects',
      { stdin: refs.map(ref => ref.objectId).join('\n') }
    )
    const missingObjectIds = getMissingObjectIds(objectResult.stdout)
    const brokenRefs = refs.filter(ref => missingObjectIds.has(ref.objectId))

    for (const ref of brokenRefs) {
      await git(
        ['update-ref', '-d', ref.name, ref.objectId],
        repository.path,
        'deleteBrokenCodexRef',
        { successExitCodes: new Set([0, 1]) }
      )
    }

    if (brokenRefs.length > 0) {
      log.warn(`Pruned ${brokenRefs.length} broken Codex checkpoint refs`)
    }

    return brokenRefs.length
  } catch (e) {
    // Codex metadata must never prevent the user's Git operation. If the
    // preflight itself fails, let fetch continue and preserve its real result.
    log.warn('Unable to inspect Codex checkpoint refs before fetch', e)
    return 0
  }
}

export async function getFetchArgs(
  remote: string,
  progressCallback?: (progress: IFetchProgress) => void
) {
  return [
    // A broken ephemeral Codex ref must not make an otherwise successful fetch
    // fail in the automatic maintenance phase. Other Git invocations can still
    // run repository maintenance normally.
    '-c',
    'gc.auto=0',
    'fetch',
    ...(progressCallback ? ['--progress'] : []),
    '--prune',
    '--recurse-submodules=on-demand',
    // Git normally negotiates from every local ref. Codex checkpoints are
    // transient and may be deleted concurrently, so restrict negotiation to
    // durable branch refs and keep refs/codex out of fetch entirely.
    '--negotiation-tip=refs/heads/*',
    `--negotiation-tip=refs/remotes/${remote}/*`,
    remote,
  ]
}

/**
 * Fetch from the given remote.
 *
 * @param repository - The repository to fetch into
 *
 * @param account    - The account to use when authenticating with the remote
 *
 * @param remote     - The remote to fetch from
 *
 * @param progressCallback - An optional function which will be invoked
 *                           with information about the current progress
 *                           of the fetch operation. When provided this enables
 *                           the '--progress' command line flag for
 *                           'git fetch'.
 * @param isBackgroundTask  - Whether the fetch is being performed as a
 *                            background task as opposed to being user initiated
 */
export async function fetch(
  repository: Repository,
  remote: IRemote,
  progressCallback?: (progress: IFetchProgress) => void,
  isBackgroundTask = false
): Promise<void> {
  let opts: IGitStringExecutionOptions = {
    successExitCodes: new Set([0]),
    env: await envForRemoteOperation(remote.url),
  }

  if (progressCallback) {
    const title = `Fetching ${remote.name}`
    const kind = 'fetch'

    opts = await executionOptionsWithProgress(
      { ...opts, trackLFSProgress: true, isBackgroundTask },
      new FetchProgressParser(),
      progress => {
        // In addition to progress output from the remote end and from
        // git itself, the stderr output from pull contains information
        // about ref updates. We don't need to bring those into the progress
        // stream so we'll just punt on anything we don't know about for now.
        if (progress.kind === 'context') {
          if (!progress.text.startsWith('remote: Counting objects')) {
            return
          }
        }

        const description =
          progress.kind === 'progress' ? progress.details.text : progress.text
        const value = progress.percent

        progressCallback({
          kind,
          title,
          description,
          value,
          remote: remote.name,
        })
      }
    )

    // Initial progress
    progressCallback({ kind, title, value: 0, remote: remote.name })
  }

  const args = await getFetchArgs(remote.name, progressCallback)

  await pruneBrokenCodexRefs(repository)

  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await git(args, repository.path, 'fetch', opts)
      return
    } catch (e) {
      if (!(e instanceof GitError)) {
        throw e
      }

      const codexRefs = getCodexRefsFromFetchError(e)
      if (codexRefs.size === 0) {
        throw e
      }

      const prunedRefCount = await pruneBrokenCodexRefs(repository)
      if (attempt < maxAttempts) {
        log.warn(
          `Fetch attempt ${attempt} encountered ${codexRefs.size} transient Codex refs; pruned ${prunedRefCount} broken refs and retrying`
        )
        continue
      }

      // The remote transfer may have succeeded even though a concurrently
      // changing Codex checkpoint made Git's final connectivity check fail.
      // Do not surface ephemeral Codex bookkeeping as a fatal repository error;
      // the next scheduled fetch will reconcile any remote ref still pending.
      log.warn(
        `Ignoring fetch failure after ${maxAttempts} attempts because it only referenced transient Codex checkpoint refs`
      )
      return
    }
  }
}

/** Fetch a given refspec from the given remote. */
export async function fetchRefspec(
  repository: Repository,
  remote: IRemote,
  refspec: string
): Promise<void> {
  await git(['fetch', remote.name, refspec], repository.path, 'fetchRefspec', {
    successExitCodes: new Set([0, 128]),
    env: await envForRemoteOperation(remote.url),
  })
}

export async function fastForwardBranches(
  repository: Repository,
  branches: ReadonlyArray<ITrackingBranch>
): Promise<void> {
  if (branches.length === 0) {
    return
  }

  const refPairs = branches.map(branch => `${branch.upstreamRef}:${branch.ref}`)

  await git(
    [
      'fetch',
      '.',
      // Make sure we don't try to update branches that can't be fast-forwarded
      // even if the user disabled this via the git config option
      // `fetch.showForcedUpdates`
      '--show-forced-updates',
      // Prevent `git fetch` from touching the `FETCH_HEAD`
      '--no-write-fetch-head',
      // Take branch refs from stdin to circumvent shell max line length
      // limitations (mainly on Windows)
      '--stdin',
    ],
    repository.path,
    'fastForwardBranches',
    {
      // Fetch exits with an exit code of 1 if one or more refs failed to update
      // which is what we expect will happen
      successExitCodes: new Set([0, 1]),
      env: {
        // This will make sure the reflog entries are correct after
        // fast-forwarding the branches.
        GIT_REFLOG_ACTION: 'pull',
      },
      stdin: refPairs.join('\n'),
    }
  )
}
