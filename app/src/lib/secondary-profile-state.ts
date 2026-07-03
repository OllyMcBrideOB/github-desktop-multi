export const SecondaryProfileStateVersion = 1
export const SecondaryProfileStateFileName = 'secondary-profile-state.json'

export const UsersLocalStorageKey = 'users'
export const HasShownWelcomeFlowLocalStorageKey = 'has-shown-welcome-flow'

export interface ISecondaryProfileState {
  readonly version: typeof SecondaryProfileStateVersion
  readonly updatedAt: number
  readonly users: string | null
  readonly hasShownWelcomeFlow: string | null
}

function hasStoredUsers(users: string | null) {
  if (users === null || users.length === 0) {
    return false
  }

  try {
    const parsed = JSON.parse(users)
    return Array.isArray(parsed) && parsed.length > 0
  } catch {
    return false
  }
}

export function createSecondaryProfileStateSnapshot(
  storage: Pick<Storage, 'getItem'> = localStorage
): ISecondaryProfileState {
  const users = storage.getItem(UsersLocalStorageKey)
  const hasShownWelcomeFlow =
    storage.getItem(HasShownWelcomeFlowLocalStorageKey) ??
    (hasStoredUsers(users) ? '1' : null)

  return {
    version: SecondaryProfileStateVersion,
    updatedAt: Date.now(),
    users,
    hasShownWelcomeFlow,
  }
}

export function applySecondaryProfileStateSnapshot(
  snapshot: ISecondaryProfileState,
  storage: Pick<Storage, 'setItem'> = localStorage
) {
  if (snapshot.version !== SecondaryProfileStateVersion) {
    return false
  }

  if (snapshot.users !== null) {
    storage.setItem(UsersLocalStorageKey, snapshot.users)
  }

  if (snapshot.hasShownWelcomeFlow !== null) {
    storage.setItem(
      HasShownWelcomeFlowLocalStorageKey,
      snapshot.hasShownWelcomeFlow
    )
  }

  return true
}
