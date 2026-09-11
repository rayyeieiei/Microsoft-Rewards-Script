import { SanitizedDestination } from '../../runtime/manual/ManualQuestTypes'

export type OnboardingState =
    | 'not-detected'
    | 'detected'
    | 'active'
    | 'completed'
    | 'expired'
    | 'unknown'

export type OnboardingTaskKind =
    | 'account-choice'
    | 'daily-set-dependent'
    | 'official-navigation'
    | 'progress-container'
    | 'unknown'

export type OnboardingHandling =
    | 'manual-required'
    | 'delegated-to-existing-worker'
    | 'passive-only'
    | 'already-complete'
    | 'unsupported'

export type OnboardingConfidence = 'high' | 'medium' | 'low'

export interface OnboardingTask {
    offerId: string
    parentOfferId?: string
    title: string
    description?: string
    taskKind: OnboardingTaskKind
    handling: OnboardingHandling
    complete: boolean
    isLocked: boolean
    advertisedPoints: number
    pointProgress?: number
    pointProgressMax?: number
    expiresAt?: string
    destination?: SanitizedDestination
}

export interface OnboardingEvidence {
    state: OnboardingState
    confidence: OnboardingConfidence
    detectedOfferIds: string[]
    incompleteCount: number
    completedCount: number
    evidence: string[]
    tasks: OnboardingTask[]
    parentOfferId?: string
}

export interface OnboardingVerificationResult {
    offerId: string
    beforeComplete: boolean
    afterComplete: boolean
    serverCompleted: boolean
    serverEvidence: string
    advertisedPoints: number
    observedAccountBalanceDelta?: number
    attributedPoints: 'unknown'
    status:
        | 'verified-complete'
        | 'still-pending'
        | 'manual-required'
        | 'not-found'
        | 'expired'
}
