/**
 * Keep ephemeral Codex checkpoint refs out of remote negotiation and disable
 * automatic maintenance while a remote operation is updating refs. Codex can
 * rewrite or remove these refs concurrently, so including them can make an
 * otherwise valid fetch or pull fail its connectivity check.
 */
export const gitRemoteOperationConfigArguments = [
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
  '-c',
  'transfer.hideRefs=refs/codex',
] as const
