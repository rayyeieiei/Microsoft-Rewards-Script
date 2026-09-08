export type AppOnlyPolicy = 'skip' | 'notify' | 'manual-handoff'

export type QuestLockReason =
    | 'app-only'
    | 'cooldown'
    | 'future-dated'
    | 'region-ineligible'
    | 'account-ineligible'
    | 'completed'
    | 'unknown'

export type ClassificationConfidence = 'high' | 'medium' | 'low'

export type ManualQuestState =
    | 'detected'
    | 'manual-required'
    | 'verify-pending'
    | 'verified-complete'
    | 'expired'
    | 'skipped'

export interface AppOnlyQuest {
    accountKey: string
    offerId: string
    title: string
    expectedPoints: number
    destinationUrl?: string
    expiresAt?: string
    complete: boolean
    locked: boolean
    lockReason: QuestLockReason
    confidence: ClassificationConfidence
    observedAt: string
}

export interface AppOnlyDecision {
    quest: AppOnlyQuest
    policy: AppOnlyPolicy
    action: 'skip' | 'notify' | 'queue-manual' | 'ignore'
    reason: string
}

export interface AppOnlyCapabilityRecord {
    accountKey: string
    offerId: string
    classification: QuestLockReason
    confidence: ClassificationConfidence
    firstSeenAt: string
    lastSeenAt: string
    expiresAt?: string
    serverState: 'locked' | 'complete' | 'expired'
}

export interface ManualQuestRecord extends AppOnlyQuest {
    state: ManualQuestState
    queuedAt: string
    detectedAt?: string
    completedAt?: string
    verifiedBalanceDelta?: number
}

export interface AppOnlyVerificationResult {
    offerId: string
    complete: boolean
    balanceDelta: number
    source: 'dashboard' | 'app-dashboard'
    verifiedAt: string
}

/**
 * Redacts email or identifier into a safe accountKey.
 * Never leaks full email, tokens, cookies, or hardware identifiers.
 */
export function redactAccountKey(identifier: string): string {
    if (!identifier) return 'anon'
    const clean = identifier.trim()
    const atIndex = clean.indexOf('@')
    if (atIndex <= 0) {
        if (clean.length <= 4) return 'acc***'
        return `${clean.slice(0, 3)}***`
    }
    const user = clean.slice(0, atIndex)
    const domain = clean.slice(atIndex + 1)
    const visibleLen = Math.min(3, Math.max(1, user.length - 2))
    return `${user.slice(0, visibleLen)}***@${domain}`
}

export * from '../ActivitySemantics'
