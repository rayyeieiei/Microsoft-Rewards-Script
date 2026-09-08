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

export type PunchCardRunStatus =
    | 'verified-complete-today'
    | 'processed-unverified'
    | 'waiting-cooldown'
    | 'already-complete'
    | 'no-actionable-child'
    | 'failed'

export interface PunchCardServerSnapshot {
    parentOfferId: string
    childOfferId?: string
    completedChildren: number
    totalChildren: number
    actionableNow: number
    locked: number
    futureDated: number
    parentComplete: boolean
    childComplete?: boolean
    childLocked?: boolean
}

export type PunchCardVerificationEvidence =
    | 'exact-child-complete'
    | 'completed-count-increased'
    | 'parent-complete'
    | 'state-unchanged'
    | 'server-state-unavailable'

export interface PunchCardRunResult {
    status: PunchCardRunStatus
    before: PunchCardServerSnapshot
    after?: PunchCardServerSnapshot
    targetChildOfferId?: string
    observedBalanceDelta: number
    evidence: PunchCardVerificationEvidence
}

export interface PunchCardStateReader {
    fetchPunchCardSnapshot(
        parentOfferId: string,
        targetChildOfferId?: string
    ): Promise<PunchCardServerSnapshot | null>
}

export function evaluatePunchCardRun(
    before: PunchCardServerSnapshot,
    after?: PunchCardServerSnapshot,
    targetChildOfferId?: string,
    observedBalanceDelta: number = 0
): PunchCardRunResult {
    if (before.parentComplete) {
        return {
            status: 'already-complete',
            before,
            after,
            targetChildOfferId,
            observedBalanceDelta,
            evidence: 'parent-complete'
        }
    }

    if (before.actionableNow === 0) {
        if (before.locked > 0 || before.futureDated > 0) {
            return {
                status: 'waiting-cooldown',
                before,
                after,
                targetChildOfferId,
                observedBalanceDelta,
                evidence: 'state-unchanged'
            }
        }
        return {
            status: 'no-actionable-child',
            before,
            after,
            targetChildOfferId,
            observedBalanceDelta,
            evidence: 'state-unchanged'
        }
    }

    if (!after) {
        return {
            status: 'processed-unverified',
            before,
            after: undefined,
            targetChildOfferId,
            observedBalanceDelta,
            evidence: 'server-state-unavailable'
        }
    }

    // Deterministic rules:
    // 1. after.parentComplete === true -> parent-complete
    // 2. after.childComplete === true -> exact-child-complete
    // 3. after.completedChildren > before.completedChildren -> completed-count-increased
    // 4. otherwise -> state-unchanged
    if (after.parentComplete === true) {
        return {
            status: 'verified-complete-today',
            before,
            after,
            targetChildOfferId,
            observedBalanceDelta,
            evidence: 'parent-complete'
        }
    }

    if (after.childComplete === true) {
        return {
            status: 'verified-complete-today',
            before,
            after,
            targetChildOfferId,
            observedBalanceDelta,
            evidence: 'exact-child-complete'
        }
    }

    if (after.completedChildren > before.completedChildren) {
        return {
            status: 'verified-complete-today',
            before,
            after,
            targetChildOfferId,
            observedBalanceDelta,
            evidence: 'completed-count-increased'
        }
    }

    return {
        status: 'processed-unverified',
        before,
        after,
        targetChildOfferId,
        observedBalanceDelta,
        evidence: 'state-unchanged'
    }
}

export type DataSaverCategory = 'document' | 'script' | 'xhr/fetch' | 'image' | 'media' | 'font' | 'other'

export interface DataSaverBudgetResult {
    consumedBytes: number
    budgetBytes: number
    consumedMb: number
    budgetMb: number
    percentage: number
    withinBudget: boolean
    status: 'PASS' | 'OVER_BUDGET'
    overBytes: number
    overMb: number
}

export function evaluateDataSaverBudget(
    consumedBytes: number,
    budgetBytes: number = 20 * 1024 * 1024
): DataSaverBudgetResult {
    const consumedMb = consumedBytes / (1024 * 1024)
    const budgetMb = budgetBytes / (1024 * 1024)
    const withinBudget = consumedBytes <= budgetBytes
    const percentage = budgetBytes > 0 ? (consumedBytes / budgetBytes) * 100 : 0
    const overBytes = Math.max(0, consumedBytes - budgetBytes)
    const overMb = overBytes / (1024 * 1024)

    return {
        consumedBytes,
        budgetBytes,
        consumedMb,
        budgetMb,
        percentage,
        withinBudget,
        status: withinBudget ? 'PASS' : 'OVER_BUDGET',
        overBytes,
        overMb
    }
}
