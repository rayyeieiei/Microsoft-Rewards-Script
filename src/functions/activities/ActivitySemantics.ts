export type ActivityCompletionStatus = 'verified-complete' | 'processed-unverified' | 'pending' | 'skipped' | 'failed'

export type CompletionEvidence = 'server-offer-state' | 'server-dashboard-state' | 'none'

export interface ActivityExecutionResult {
    offerId: string
    title: string
    status: ActivityCompletionStatus
    advertisedPoints: number
    observedBalanceDelta: number
    attributedPoints: number | null
    serverCompleted: boolean
    completionEvidence: CompletionEvidence
}

export interface ActivityBatchSummary {
    total: number
    verifiedComplete: number
    processedUnverified: number
    pending: number
    skipped: number
    failed: number
    observedAccountBalanceDelta: number
}

export interface PunchCardTaskCounts {
    total: number
    completed: number
    remaining: number
    actionableNow: number
    locked: number
    futureDated: number
    disabled: number
}

/**
 * Reconciles execution result with strict attribution semantics:
 * - Positive balance delta alone is NOT proof of completion
 * - attributedPoints is non-null ONLY if exact offer credit is explicitly verified by server
 * - If advertised points differ from balance delta (e.g. +10 advertised vs +13 delta), attributedPoints remains unknown (null)
 */
export function evaluateActivityCompletion(params: {
    offerId: string
    title: string
    advertisedPoints: number
    observedBalanceDelta: number
    serverCompleted: boolean
    completionEvidence: CompletionEvidence
    explicitCredit?: number | null
}): ActivityExecutionResult {
    const {
        offerId,
        title,
        advertisedPoints,
        observedBalanceDelta,
        serverCompleted,
        completionEvidence,
        explicitCredit
    } = params

    if (!serverCompleted || completionEvidence === 'none') {
        return {
            offerId,
            title,
            status: 'processed-unverified',
            advertisedPoints,
            observedBalanceDelta,
            attributedPoints: null,
            serverCompleted: false,
            completionEvidence: 'none'
        }
    }

    // Exact credit explicitly confirmed by server response
    if (typeof explicitCredit === 'number' && explicitCredit > 0) {
        return {
            offerId,
            title,
            status: 'verified-complete',
            advertisedPoints,
            observedBalanceDelta,
            attributedPoints: explicitCredit,
            serverCompleted: true,
            completionEvidence
        }
    }

    // Server says offer is complete, and balance delta matches advertised points
    if (observedBalanceDelta === advertisedPoints && advertisedPoints > 0) {
        return {
            offerId,
            title,
            status: 'verified-complete',
            advertisedPoints,
            observedBalanceDelta,
            attributedPoints: advertisedPoints,
            serverCompleted: true,
            completionEvidence
        }
    }

    // Server completed, but balance delta does not equal advertised points (e.g. +10 advertised, +13 delta)
    // attributedPoints must be null (unknown) to prevent phantom / misattributed points
    return {
        offerId,
        title,
        status: 'verified-complete',
        advertisedPoints,
        observedBalanceDelta,
        attributedPoints: null,
        serverCompleted: true,
        completionEvidence
    }
}
