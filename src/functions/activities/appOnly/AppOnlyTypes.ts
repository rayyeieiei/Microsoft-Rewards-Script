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

export interface AppOnlyQuest {
    accountId: string
    displayAccount: string
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
    accountId: string
    offerId: string
    classification: QuestLockReason
    confidence: ClassificationConfidence
    firstSeenAt: string
    lastSeenAt: string
    expiresAt?: string
    serverState: 'locked' | 'complete' | 'expired'
}

export interface AppOnlyVerificationResult {
    offerId: string
    complete: boolean
    balanceDelta: number
    source: 'dashboard' | 'app-dashboard'
    verifiedAt: string
}

export * from '../ActivitySemantics'
