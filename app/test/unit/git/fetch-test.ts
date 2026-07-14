import { describe, it } from 'node:test'
import assert from 'node:assert'
import { Repository } from '../../../src/models/repository'
import {
  setupEmptyRepository,
  setupFixtureRepository,
} from '../../helpers/repositories'
import {
  getBranches,
  getBranchesDifferingFromUpstream,
} from '../../../src/lib/git/for-each-ref'
import { Branch } from '../../../src/models/branch'
import {
  fastForwardBranches,
  getFetchArgs,
  getCodexRefsFromText,
  getMissingObjectIds,
  parseCodexRefs,
  pruneBrokenCodexRefs,
} from '../../../src/lib/git'
import * as Path from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'

function branchWithName(branches: ReadonlyArray<Branch>, name: string) {
  return branches.filter(branch => branch.name === name)[0]
}

describe('git/fetch', () => {
  describe('getCodexRefsFromText', () => {
    it('finds Codex refs in fetch errors', () => {
      const refs =
        getCodexRefsFromText(`fatal: bad object refs/codex/turn-diffs/checkpoints/b823682e8d894aee0e41dc25faa8622a4c5ec87776ae050cee61fcd4a496ec20/c66a9c6d3da8e6863a8fde55bc33bb4b3f8c23e71df6fcecb345b8441c042302/1782309610967/17f9f91d-728b-4322-b8a1-ef7ee6695e4e
error: https://github.com/Open-Bionics/OB2_FW_Common.git did not send all necessary objects`)

      assert.deepEqual(
        [...refs],
        [
          'refs/codex/turn-diffs/checkpoints/b823682e8d894aee0e41dc25faa8622a4c5ec87776ae050cee61fcd4a496ec20/c66a9c6d3da8e6863a8fde55bc33bb4b3f8c23e71df6fcecb345b8441c042302/1782309610967/17f9f91d-728b-4322-b8a1-ef7ee6695e4e',
        ]
      )
    })

    it('ignores non-Codex refs', () => {
      const refs = getCodexRefsFromText('fatal: bad object refs/heads/main')

      assert.equal(refs.size, 0)
    })
  })

  describe('pruneBrokenCodexRefs', () => {
    it('excludes Codex refs from fetch negotiation', async () => {
      const args = await getFetchArgs('origin')

      assert.ok(args.includes('--negotiation-tip=refs/heads/*'))
      assert.ok(args.includes('--negotiation-tip=refs/remotes/origin/*'))
      assert.ok(args.includes('gc.auto=0'))
    })

    it('identifies missing objects from batch-check output', () => {
      assert.deepEqual(
        [...getMissingObjectIds('abc commit\ndef missing\n')],
        ['def']
      )
    })

    it('parses only Codex refs', () => {
      assert.deepEqual(
        parseCodexRefs('refs/codex/checkpoints/one abc\nrefs/heads/main def\n'),
        [{ name: 'refs/codex/checkpoints/one', objectId: 'abc' }]
      )
    })

    it('removes a Codex ref whose object is missing', async t => {
      const repository = await setupEmptyRepository(t)
      const refPath = Path.join(
        repository.path,
        '.git',
        'refs',
        'codex',
        'turn-diffs',
        'checkpoints',
        'broken'
      )
      await mkdir(Path.dirname(refPath), { recursive: true })
      await writeFile(refPath, '0000000000000000000000000000000000000001\n')

      assert.equal(await pruneBrokenCodexRefs(repository), 1)
      assert.equal(await pruneBrokenCodexRefs(repository), 0)
    })
  })

  describe('fastForwardBranches', () => {
    it('fast-forwards branches using fetch', async t => {
      const testRepoPath = await setupFixtureRepository(
        t,
        'repo-with-non-updated-branches'
      )
      const repository = new Repository(testRepoPath, -1, null, false)

      const eligibleBranches = await getBranchesDifferingFromUpstream(
        repository
      )

      await fastForwardBranches(repository, eligibleBranches)

      const resultBranches = await getBranches(repository)

      // Only the branch behind was updated to match its upstream
      const branchBehind = branchWithName(resultBranches, 'branch-behind')
      assert(branchBehind.upstream !== null)

      const branchBehindUpstream = branchWithName(
        resultBranches,
        branchBehind.upstream
      )
      assert.equal(branchBehindUpstream.tip.sha, branchBehind.tip.sha)

      // The branch ahead is still ahead
      const branchAhead = branchWithName(resultBranches, 'branch-ahead')
      assert(branchAhead.upstream !== null)

      const branchAheadUpstream = branchWithName(
        resultBranches,
        branchAhead.upstream
      )

      assert.notEqual(branchAheadUpstream.tip.sha, branchAhead.tip.sha)

      // The branch ahead and behind is still ahead and behind
      const branchAheadAndBehind = branchWithName(
        resultBranches,
        'branch-ahead-and-behind'
      )
      assert(branchAheadAndBehind.upstream !== null)

      const branchAheadAndBehindUpstream = branchWithName(
        resultBranches,
        branchAheadAndBehind.upstream
      )
      assert.notEqual(
        branchAheadAndBehindUpstream.tip.sha,
        branchAheadAndBehind.tip.sha
      )

      // The main branch hasn't been updated, since it's the current branch
      const mainBranch = branchWithName(resultBranches, 'main')
      assert(mainBranch.upstream !== null)

      const mainUpstream = branchWithName(resultBranches, mainBranch.upstream)
      assert.notEqual(mainUpstream.tip.sha, mainBranch.tip.sha)

      // The up-to-date branch is still matching its upstream
      const upToDateBranch = branchWithName(resultBranches, 'branch-up-to-date')
      assert(upToDateBranch.upstream !== null)
      const upToDateBranchUpstream = branchWithName(
        resultBranches,
        upToDateBranch.upstream
      )
      assert.equal(upToDateBranchUpstream.tip.sha, upToDateBranch.tip.sha)
    })

    // We want to avoid messing with the FETCH_HEAD file. Normally, it shouldn't
    // be something users would rely on, but we want to be good gitizens
    // (:badpundog:) when possible.
    it('does not change FETCH_HEAD after fast-forwarding branches with fetch', async t => {
      const testRepoPath = await setupFixtureRepository(
        t,
        'repo-with-non-updated-branches'
      )
      const repository = new Repository(testRepoPath, -1, null, false)

      const eligibleBranches = await getBranchesDifferingFromUpstream(
        repository
      )

      const fetchHeadPath = Path.join(repository.path, '.git', 'FETCH_HEAD')
      const previousFetchHead = await readFile(fetchHeadPath, 'utf-8')

      await fastForwardBranches(repository, eligibleBranches)

      const currentFetchHead = await readFile(fetchHeadPath, 'utf-8')

      assert.equal(currentFetchHead, previousFetchHead)
    })
  })
})
