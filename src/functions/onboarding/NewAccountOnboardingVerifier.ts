import { DashboardData, PunchCard } from '../../interface/DashboardData'
import { AccountIdentity } from '../../runtime/identity/AccountIdentity'
import { ManualQuestQueue } from '../../runtime/manual/ManualQuestQueue'
import { OnboardingEvidence, OnboardingVerificationResult } from './NewAccountOnboardingTypes'

export interface OnboardingVerifierOptions {
    queue: ManualQuestQueue
    logger?: {
        info: (msg: string) => void
        warn: (msg: string) => void
        debug: (msg: string) => void
    }
}

export class NewAccountOnboardingVerifier {
    private queue: ManualQuestQueue
    private logger?: OnboardingVerifierOptions['logger']

    constructor(options: OnboardingVerifierOptions) {
        this.queue = options.queue
        this.logger = options.logger
    }

    public async verify(params: {
        identity: AccountIdentity
        before: OnboardingEvidence
        afterDashboard: DashboardData | null | undefined
        observedDelta?: number
    }): Promise<OnboardingVerificationResult[]> {
        const results: OnboardingVerificationResult[] = []
        const { identity, before, afterDashboard, observedDelta } = params

        if (!before.tasks || before.tasks.length === 0) {
            return results
        }

        // Extract after candidates strictly from proven collections
        const candidates: any[] = []
        if (afterDashboard && typeof afterDashboard === 'object') {
            candidates.push(
                ...(afterDashboard.morePromotions ?? []),
                ...(afterDashboard.morePromotionsWithoutPromotionalItems ?? []),
                ...(afterDashboard.promotionalItems ?? []),
                ...(afterDashboard.promotionalItem ? [afterDashboard.promotionalItem] : [])
            )
            const punchCards: PunchCard[] = afterDashboard.punchCards ?? []
            for (const pc of punchCards) {
                if (pc.parentPromotion) candidates.push(pc.parentPromotion)
                if (pc.childPromotions) candidates.push(...pc.childPromotions)
            }
        }

        for (const task of before.tasks) {
            const offerIdLower = task.offerId.toLowerCase()
            const matching = candidates.find(
                c => String(c.offerId || '').trim().toLowerCase() === offerIdLower
            )

            let serverCompleted = false
            let serverEvidence = 'missing-from-payload'
            let status: OnboardingVerificationResult['status'] = 'not-found'

            if (matching) {
                serverCompleted =
                    matching.complete === true ||
                    String(matching.complete).toLowerCase() === 'true' ||
                    (typeof matching.pointProgress === 'number' &&
                        typeof matching.pointProgressMax === 'number' &&
                        matching.pointProgressMax > 0 &&
                        matching.pointProgress >= matching.pointProgressMax)

                if (serverCompleted) {
                    status = 'verified-complete'
                    serverEvidence = 'server-complete-state'
                    // Update queue with exact accountId + questKind + offerId
                    await this.queue.updateState(
                        identity.accountId,
                        'new-account-onboarding',
                        task.offerId,
                        'verified-complete',
                        observedDelta
                    )
                } else {
                    status = task.handling === 'manual-required' ? 'manual-required' : 'still-pending'
                    serverEvidence = 'server-uncompleted-state'
                }
            } else if (task.complete) {
                serverCompleted = true
                status = 'verified-complete'
                serverEvidence = 'already-complete-prior'
            }

            // Attributed points is STRICTLY 'unknown' (never claim balance delta or advertised points)
            const result: OnboardingVerificationResult = {
                offerId: task.offerId,
                beforeComplete: task.complete,
                afterComplete: serverCompleted,
                serverCompleted,
                serverEvidence,
                advertisedPoints: task.advertisedPoints,
                observedAccountBalanceDelta: observedDelta,
                attributedPoints: 'unknown',
                status
            }

            results.push(result)

            this.logger?.info?.(
                `[ONBOARDING-VERIFY] offerId=${task.offerId} beforeComplete=${task.complete} afterComplete=${serverCompleted} status=${status} attributedPoints=unknown`
            )
        }

        return results
    }
}
