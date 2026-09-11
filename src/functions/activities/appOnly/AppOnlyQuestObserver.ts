import { AppOnlyDecision, AppOnlyPolicy, AppOnlyQuest } from './AppOnlyTypes'
import { AppOnlyClassificationInput, AppOnlyQuestClassifier } from './AppOnlyQuestClassifier'
import { AppOnlyCapabilityCache } from './AppOnlyCapabilityCache'
import { ManualQuestQueue } from '../../../runtime/manual/ManualQuestQueue'
import { ManualQuestRecord, SanitizedDestination } from '../../../runtime/manual/ManualQuestTypes'
import { redactAccountKey } from '../../../util/Redaction'

export interface AppOnlyQuestObserverOptions {
    policy: AppOnlyPolicy
    cacheTtlHours: number
    onManualRequired?: (record: ManualQuestRecord) => void | Promise<void>
    onNotification?: (quest: AppOnlyQuest) => void | Promise<void>
    logger?: {
        info: (msg: string) => void
        warn: (msg: string) => void
        debug: (msg: string) => void
    }
}

function sanitizeDestination(urlStr?: string): SanitizedDestination | undefined {
    if (!urlStr || typeof urlStr !== 'string') return undefined
    try {
        const parsed = new URL(urlStr)
        return {
            scheme: parsed.protocol.replace(':', ''),
            origin: parsed.origin,
            path: parsed.pathname
        }
    } catch {
        return undefined
    }
}

export class AppOnlyQuestObserver {
    private classifier: AppOnlyQuestClassifier
    private cache: AppOnlyCapabilityCache
    private queue?: ManualQuestQueue

    constructor(
        classifier?: AppOnlyQuestClassifier,
        cache?: AppOnlyCapabilityCache,
        queue?: ManualQuestQueue
    ) {
        this.classifier = classifier || new AppOnlyQuestClassifier()
        this.cache = cache || AppOnlyCapabilityCache.getInstance()
        this.queue = queue
    }

    /**
     * Observes promotional tiles and makes policy decisions without making speculative network requests.
     */
    public async observe(
        promotions: AppOnlyClassificationInput[],
        options: AppOnlyQuestObserverOptions
    ): Promise<AppOnlyDecision[]> {
        const decisions: AppOnlyDecision[] = []
        const policy = options.policy || 'skip'
        const ttlHours = options.cacheTtlHours || 24
        const logger = options.logger

        let detectedCount = 0
        let skippedCount = 0
        let queuedManualCount = 0

        for (const promo of promotions) {
            const rawAccount = promo.accountKey || 'anonymous'
            const accountId = promo.accountId || (promo.accountKey ? redactAccountKey(promo.accountKey) : 'anonymous')
            const displayAccount = promo.displayAccount || redactAccountKey(rawAccount)
            const offerId = (promo.offerId || '').trim()

            // 1. Check capability cache first using accountId
            const cached = await this.cache.getRecord(accountId, offerId)
            if (cached && cached.serverState === 'locked' && cached.classification === 'app-only') {
                logger?.debug?.(`[APP-ONLY-CACHE] hit=true offerId=${offerId} state=locked`)
                decisions.push({
                    quest: this.classifier.classify({ ...promo, accountId, displayAccount }),
                    policy,
                    action: 'skip',
                    reason: 'cached-negative-capability'
                })
                skippedCount++
                continue
            }

            // 2. Classify card independently
            const quest = this.classifier.classify({ ...promo, accountId, displayAccount })

            // Log diagnostic classification
            if (quest.lockReason === 'app-only') {
                logger?.info?.(
                    `[APP-ONLY-CLASSIFY] offerId=${quest.offerId} reason=app-only confidence=${quest.confidence}`
                )
                detectedCount++
            } else if (quest.locked && quest.lockReason === 'unknown') {
                logger?.debug?.(`[APP-ONLY-CLASSIFY] lockReason=unknown action=ignore offerId=${quest.offerId}`)
            }

            // 3. Make decision based on classification & policy
            if (quest.complete) {
                decisions.push({
                    quest,
                    policy,
                    action: 'ignore',
                    reason: 'Already completed on server'
                })
                // Ensure negative cache is cleared if card is completed
                await this.cache.recordCompleted(accountId, offerId)
                continue
            }

            if (quest.lockReason === 'app-only') {
                // Update capability cache with negative capability using accountId
                await this.cache.recordLocked(
                    accountId,
                    offerId,
                    'app-only',
                    quest.confidence,
                    ttlHours,
                    quest.expiresAt
                )

                if (policy === 'skip') {
                    decisions.push({
                        quest,
                        policy: 'skip',
                        action: 'skip',
                        reason: 'Classified as app-only; skipped by policy'
                    })
                    skippedCount++
                } else if (policy === 'notify') {
                    decisions.push({
                        quest,
                        policy: 'notify',
                        action: 'notify',
                        reason: 'Classified as app-only; dispatched notification'
                    })
                    try {
                        await options.onNotification?.(quest)
                    } catch {}
                    skippedCount++
                } else if (policy === 'manual-handoff') {
                    const manualRecord: ManualQuestRecord = {
                        accountId,
                        displayAccount,
                        questKind: 'app-only',
                        offerId: quest.offerId,
                        title: quest.title,
                        expectedPoints: quest.expectedPoints,
                        destination: sanitizeDestination(quest.destinationUrl),
                        expiresAt: quest.expiresAt,
                        complete: false,
                        locked: quest.locked,
                        lockReason: quest.lockReason,
                        confidence: quest.confidence,
                        state: 'manual-required',
                        observedAt: quest.observedAt,
                        queuedAt: new Date().toISOString()
                    }
                    if (this.queue) {
                        await this.queue.enqueue(manualRecord)
                    }
                    try {
                        await options.onManualRequired?.(manualRecord)
                    } catch {}
                    decisions.push({
                        quest,
                        policy: 'manual-handoff',
                        action: 'queue-manual',
                        reason: 'Classified as app-only; queued for operator manual handoff'
                    })
                    queuedManualCount++
                }
            } else {
                // Other lock reasons (cooldown, future-dated, unknown) are left untouched
                decisions.push({
                    quest,
                    policy,
                    action: 'ignore',
                    reason: `Not app-only (reason=${quest.lockReason})`
                })
            }
        }

        // Summary log
        if (detectedCount > 0 || skippedCount > 0 || queuedManualCount > 0) {
            if (policy === 'manual-handoff') {
                logger?.info?.(
                    `[APP-ONLY] policy=manual-handoff detected=${detectedCount} queuedManual=${queuedManualCount}`
                )
            } else {
                logger?.info?.(
                    `[APP-ONLY] policy=${policy} detected=${detectedCount} skipped=${skippedCount} queuedManual=${queuedManualCount}`
                )
            }
        }

        return decisions
    }
}
