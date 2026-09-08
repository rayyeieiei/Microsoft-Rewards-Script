import { AppOnlyVerificationResult, redactAccountKey } from './AppOnlyTypes'
import { ManualQuestQueue } from './AppOnlyQuestObserver'
import { AppOnlyCapabilityCache } from './AppOnlyCapabilityCache'
import { AppOnlyClassificationInput } from './AppOnlyQuestClassifier'

export interface AppOnlyVerifierOptions {
    accountKey: string
    currentBalance?: number
    previousBalance?: number
    logger?: {
        info: (msg: string) => void
        warn: (msg: string) => void
        debug: (msg: string) => void
    }
}

export class AppOnlyQuestVerifier {
    private queue: ManualQuestQueue
    private cache: AppOnlyCapabilityCache

    constructor(queue?: ManualQuestQueue, cache?: AppOnlyCapabilityCache) {
        this.queue = queue || ManualQuestQueue.getInstance()
        this.cache = cache || AppOnlyCapabilityCache.getInstance()
    }

    /**
     * Passively verifies pending manual quests against current server-rendered dashboard promotions.
     * Never performs aggressive polling.
     */
    public async verify(
        serverPromotions: AppOnlyClassificationInput[],
        options: AppOnlyVerifierOptions,
        now = new Date()
    ): Promise<AppOnlyVerificationResult[]> {
        const results: AppOnlyVerificationResult[] = []
        const safeAccount = redactAccountKey(options.accountKey)
        const pendingQuests = this.queue.getPendingForAccount(safeAccount)

        if (!pendingQuests.length) {
            options.logger?.debug?.('[APP-ONLY-VERIFY] pendingLoaded=0 completed=0 stillPending=0 expired=0')
            return results
        }

        const nowTime = now.getTime()
        const baselineDelta =
            typeof options.currentBalance === 'number' && typeof options.previousBalance === 'number'
                ? Math.max(0, options.currentBalance - options.previousBalance)
                : 0

        let completedCount = 0
        let stillPendingCount = 0
        let expiredCount = 0

        for (const quest of pendingQuests) {
            const offerId = quest.offerId
            const matchingPromo = serverPromotions.find(
                p => (p.offerId || '').trim().toLowerCase() === offerId.toLowerCase()
            )

            // Check if expired
            if (quest.expiresAt) {
                const expTime = new Date(quest.expiresAt).getTime()
                if (!isNaN(expTime) && expTime <= nowTime) {
                    this.queue.updateState(safeAccount, offerId, 'expired')
                    expiredCount++
                    results.push({
                        offerId,
                        complete: false,
                        balanceDelta: 0,
                        source: 'dashboard',
                        verifiedAt: now.toISOString()
                    })
                    options.logger?.info?.(`[APP-ONLY-VERIFY] offerId=${offerId} serverComplete=false state=expired`)
                    continue
                }
            }

            if (!matchingPromo) {
                // Not found in current dashboard, keep state
                stillPendingCount++
                options.logger?.debug?.(
                    `[APP-ONLY-VERIFY] offerId=${offerId} serverComplete=false state=manual-required (not found in server payload)`
                )
                continue
            }

            // Priority 1: Exact offer server state complete === true
            const isServerComplete =
                matchingPromo.complete === true ||
                String(matchingPromo.complete).toLowerCase() === 'true' ||
                (typeof matchingPromo.pointProgress === 'number' &&
                    typeof matchingPromo.pointProgressMax === 'number' &&
                    matchingPromo.pointProgressMax > 0 &&
                    matchingPromo.pointProgress >= matchingPromo.pointProgressMax)

            if (isServerComplete) {
                completedCount++
                const delta = baselineDelta > 0 ? baselineDelta : quest.expectedPoints
                this.queue.updateState(safeAccount, offerId, 'verified-complete', delta)
                // Invalidate negative cache upon completion
                await this.cache.recordCompleted(safeAccount, offerId)

                results.push({
                    offerId,
                    complete: true,
                    balanceDelta: delta,
                    source: 'dashboard',
                    verifiedAt: now.toISOString()
                })

                options.logger?.info?.(`[APP-ONLY-VERIFY] offerId=${offerId} serverComplete=true balanceDelta=${delta}`)
            } else {
                stillPendingCount++
                this.queue.updateState(safeAccount, offerId, 'manual-required')
                results.push({
                    offerId,
                    complete: false,
                    balanceDelta: 0,
                    source: 'dashboard',
                    verifiedAt: now.toISOString()
                })
                options.logger?.info?.(
                    `[APP-ONLY-VERIFY] offerId=${offerId} serverComplete=false state=manual-required`
                )
            }
        }

        options.logger?.info?.(
            `[APP-ONLY-VERIFY] pendingLoaded=${pendingQuests.length} completed=${completedCount} stillPending=${stillPendingCount} expired=${expiredCount}`
        )

        return results
    }
}
