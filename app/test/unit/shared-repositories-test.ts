import { describe, it, TestContext } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { SharedRepositories } from '../../src/lib/shared-repositories'

async function createRegistry(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-shared-repos-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'repositories.json')
  return { registry: new SharedRepositories(filePath), filePath }
}

describe('SharedRepositories', () => {
  it('persists additions and removals', async t => {
    const { registry } = await createRegistry(t)
    await registry.initialize([{ path: 'C:\\repo-one' }])
    await registry.setPresent('C:\\repo-two', 'C:\\repo-two\\.git')
    await registry.setRemoved('C:\\repo-one')

    const repositories = await registry.getAll()
    assert.equal(repositories.length, 2)
    assert.equal(
      repositories.find(repository => repository.path === 'C:\\repo-one')
        ?.present,
      false
    )
    assert.equal(
      repositories.find(repository => repository.path === 'C:\\repo-two')
        ?.gitDir,
      'C:\\repo-two\\.git'
    )
  })

  it('serializes concurrent updates from separate instances', async t => {
    const { registry: first, filePath } = await createRegistry(t)
    const second = new SharedRepositories(filePath)
    await first.initialize([])

    await Promise.all([
      first.setPresent('C:\\repo-one'),
      second.setPresent('C:\\repo-two'),
    ])

    assert.deepEqual(
      (await first.getAll()).map(repository => repository.path).sort(),
      ['C:\\repo-one', 'C:\\repo-two']
    )
  })
})
