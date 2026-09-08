import type { AppOnlyPolicy } from './AppOnlyTypes'

export type AppOnlyPolicySource = 'account-override' | 'global-default' | 'fallback'

export interface ResolvedAppOnlyPolicy {
    policy: AppOnlyPolicy
    source: AppOnlyPolicySource
}

/**
 * Resolves App-Only policy with explicit precedence:
 * account override → global default → fallback ('skip')
 */
export function resolveAppOnlyPolicy(
    accountPolicy: AppOnlyPolicy | undefined,
    globalPolicy: AppOnlyPolicy | undefined
): ResolvedAppOnlyPolicy {
    if (accountPolicy) {
        return { policy: accountPolicy, source: 'account-override' }
    }
    if (globalPolicy) {
        return { policy: globalPolicy, source: 'global-default' }
    }
    return { policy: 'skip', source: 'fallback' }
}
