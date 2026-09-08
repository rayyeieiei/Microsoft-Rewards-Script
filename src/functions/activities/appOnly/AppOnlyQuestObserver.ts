import { AppOnlyDecision, AppOnlyPolicy, AppOnlyQuest, ManualQuestRecord, redactAccountKey } from './AppOnlyTypes'
import { AppOnlyClassificationInput, AppOnlyQuestClassifier } from './AppOnlyQuestClassifier'
import { AppOnlyCapabilityCache } from './AppOnlyCapabilityCache'

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

/**
 * In-memory registry for pending manual quests, accessible by C2 and Verifier.
 */
export class ManualQuestQueue {
    private static instance: ManualQuestQueue
    private queue = new Map<string, Map<string, ManualQuestRecord>>() // accountKey -> (offerId -> record)

    public static getInstance(): ManualQuestQueue {
        if (!ManualQuestQueue.instance) {
            ManualQuestQueue.instance = new ManualQuestQueue()
        }
        return ManualQuestQueue.instance
    }

    public enqueue(record: ManualQuestRecord): void {
        const acc = record.accountKey
        if (!this.queue.has(acc)) {
            this.queue.set(acc, new Map())
        }
        this.queue.get(acc)!.set(record.offerId, record)
    }

    public getPendingForAccount(accountKey: string): ManualQuestRecord[] {
        const accMap = this.queue.get(accountKey)
        if (!accMap) return []
        return Array.from(accMap.values()).filter(r => r.state === 'manual-required' || r.state === 'detected')
    }

    public getAllPending(): ManualQuestRecord[] {
        const all: ManualQuestRecord[] = []
        for (const accMap of this.queue.values()) {
            for (const r of accMap.values()) {
                if (r.state === 'manual-required' || r.state === 'detected') {
                    all.push(r)
                }
            }
        }
        return all
    }

    public updateState(accountKey: string, offerId: string, state: ManualQuestRecord['state'], delta?: number): void {
        const accMap = this.queue.get(accountKey)
        if (accMap && accMap.has(offerId)) {
            const item = accMap.get(offerId)!
            item.state = state
            if (state === 'verified-complete') {
                item.completedAt = new Date().toISOString()
                if (typeof delta === 'number') {
                    item.verifiedBalanceDelta = delta
                }
            }
        }
    }

    public clear(): void {
        this.queue.clear()
    }
}

export class AppOnlyQuestObserver {
    private classifier: AppOnlyQuestClassifier
    private cache: AppOnlyCapabilityCache

    constructor(classifier?: AppOnlyQuestClassifier, cache?: AppOnlyCapabilityCache) {
        this.classifier = classifier || new AppOnlyQuestClassifier()
        this.cache = cache || AppOnlyCapabilityCache.getInstance()
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
            const safeAccount = redactAccountKey(rawAccount)
            const offerId = (promo.offerId || '').trim()

            // 1. Check capability cache first
            const cached = await this.cache.getRecord(safeAccount, offerId)
            if (cached && cached.serverState === 'locked' && cached.classification === 'app-only') {
                logger?.debug?.(`[APP-ONLY-CACHE] hit=true offerId=${offerId} state=locked`)
            }

            // 2. Classify card independently
            const quest = this.classifier.classify({ ...promo, accountKey: safeAccount })

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
                await this.cache.recordCompleted(safeAccount, offerId)
                continue
            }

            if (quest.lockReason === 'app-only') {
                // Update capability cache with negative capability
                await this.cache.recordLocked(
                    safeAccount,
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
                        ...quest,
                        state: 'manual-required',
                        queuedAt: new Date().toISOString()
                    }
                    ManualQuestQueue.getInstance().enqueue(manualRecord)
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
