import * as Path from 'path'
import { IOAuthAction, URLActionType } from './parse-app-url'

export interface IOAuthCallbackRelayPayload extends IOAuthAction {
  readonly relayId: string
  readonly relayedAt: number
}

export const OAuthCallbackRelayFileName = 'desktop-dev-oauth-callback-relay.json'

export function isOAuthAction(action: URLActionType): action is IOAuthAction {
  return action.name === 'oauth'
}

export function createOAuthCallbackRelayPayload(
  action: IOAuthAction,
  relayId: string = crypto.randomUUID(),
  relayedAt: number = Date.now()
): IOAuthCallbackRelayPayload {
  return {
    ...action,
    relayId,
    relayedAt,
  }
}

export function getOAuthCallbackRelayPath(userDataPath: string) {
  return Path.join(userDataPath, OAuthCallbackRelayFileName)
}
