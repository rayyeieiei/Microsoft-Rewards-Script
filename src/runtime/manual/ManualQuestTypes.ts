export type ManualQuestKind =
    | 'app-only'
    | 'punch-card'
    | 'native-deeplink'
    | 'new-account-onboarding'
    | 'legacy-unknown'

export type ManualQuestState =
    | 'detected'
    | 'manual-required'
    | 'verify-pending'
    | 'verified-complete'
    | 'expired'
    | 'skipped'

export interface SanitizedDestination {
    scheme: string
    origin?: string
    path?: string
}

export interface ManualQuestRecord {
    accountId: string
    displayAccount: string
    questKind: ManualQuestKind
    offerId: string
    title: string
    expectedPoints: number
    destination?: SanitizedDestination
    expiresAt?: string
    complete: boolean
    locked: boolean
    lockReason?: string
    confidence: 'high' | 'medium' | 'low'
    state: ManualQuestState
    observedAt: string
    queuedAt: string
    completedAt?: string
    observedAccountBalanceDelta?: number
    legacySourceKey?: string
    migrationStatus?: 'migrated' | 'unresolved-account' | 'malformed-quarantined'
}

export interface ManualQuestPublicDto {
    displayAccount: string
    questKind: ManualQuestKind
    offerId: string
    title: string
    expectedPoints: number
    destination?: SanitizedDestination
    complete: boolean
    locked: boolean
    state: ManualQuestState
    queuedAt: string
    observedAt: string
}

export interface ManualQuestStore {
    schemaVersion: 2
    records: ManualQuestRecord[]
}
