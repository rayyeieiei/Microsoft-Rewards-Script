import fs from 'fs'
import path from 'path'
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
 * Registry for pending manual quests, backed by atomic local file persistence
 * and accessible by C2 and Verifier.
 */
export class ManualQuestQueue {
    private static instance: ManualQuestQueue
    private queue = new Map<string, Map<string, ManualQuestRecord>>() // accountKey -> (offerId -> record)
    private storagePath: string

    constructor(storagePath?: string) {
        this.storagePath = storagePath || path.join(process.cwd(), 'browser', 'manual_quests.json')
        this.loadFromDisk()
    }

    public static getInstance(storagePath?: string): ManualQuestQueue {
        if (!ManualQuestQueue.instance) {
            ManualQuestQueue.instance = new ManualQuestQueue(storagePath)
        }
        return ManualQuestQueue.instance
    }

    private loadFromDisk(): void {
        try {
            if (fs.existsSync(this.storagePath)) {
                const raw = fs.readFileSync(this.storagePath, 'utf-8')
                const parsed = JSON.parse(raw)
                if (parsed && typeof parsed === 'object') {
                    for (const [acc, items] of Object.entries(parsed)) {
                        if (Array.isArray(items)) {
                            const safeAcc = redactAccountKey(acc)
                            if (!this.queue.has(safeAcc)) {
                                this.queue.set(safeAcc, new Map())
                            }
                            for (const item of items) {
                                if (item && item.offerId) {
                                    this.queue.get(safeAcc)!.set(item.offerId, {
                                        accountKey: safeAcc,
                                        offerId: String(item.offerId),
                                        title: String(item.title || ''),
                                        expectedPoints: Number(item.expectedPoints || 10),
                                        state: item.state || 'manual-required',
                                        queuedAt: item.queuedAt || new Date().toISOString(),
                                        expiresAt: item.expiresAt,
                                        detectedAt: item.detectedAt,
                                        completedAt: item.completedAt,
                                        verifiedBalanceDelta: item.verifiedBalanceDelta,
                                        complete: Boolean(item.complete),
                                        locked: Boolean(item.locked),
                                        lockReason: item.lockReason || 'app-only',
                                        confidence: item.confidence || 'high',
                                        observedAt: item.observedAt || new Date().toISOString()
                                    })
                                }
                            }
                        }
                    }
                }
            }
        } catch {
            // Fail-safe: corrupted file should never crash the flow
        }
    }

    private persistToDisk(): void {
        try {
            const dir = path.dirname(this.storagePath)
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true })
            }
            const dataToSave: Record<string, ManualQuestRecord[]> = {}
            for (const [acc, map] of this.queue.entries()) {
                dataToSave[acc] = Array.from(map.values()).map(r => ({
                    accountKey: r.accountKey,
                    offerId: r.offerId,
                    title: r.title,
                    expectedPoints: r.expectedPoints,
                    state: r.state,
                    queuedAt: r.queuedAt,
                    expiresAt: r.expiresAt,
                    detectedAt: r.detectedAt,
                    completedAt: r.completedAt,
                    verifiedBalanceDelta: r.verifiedBalanceDelta,
                    complete: r.complete,
                    locked: r.locked,
                    lockReason: r.lockReason,
                    confidence: r.confidence,
                    observedAt: r.observedAt
                }))
            }
            const tmpPath = `${this.storagePath}.tmp`
            fs.writeFileSync(tmpPath, JSON.stringify(dataToSave, null, 2), 'utf-8')
            fs.renameSync(tmpPath, this.storagePath)
        } catch {
            // Fail-safe: persistence write errors must not disrupt operation
        }
    }

    public enqueue(record: ManualQuestRecord): void {
        const acc = redactAccountKey(record.accountKey)
        if (!this.queue.has(acc)) {
            this.queue.set(acc, new Map())
        }
        const accMap = this.queue.get(acc)!
        const existing = accMap.get(record.offerId)
        if (existing) {
            // Deduplicate: Don't overwrite verified completion or duplicate
            if (existing.state === 'verified-complete') {
                return
            }
            accMap.set(record.offerId, {
                ...existing,
                ...record,
                accountKey: acc,
                queuedAt: existing.queuedAt || record.queuedAt
            })
        } else {
            accMap.set(record.offerId, {
                ...record,
                accountKey: acc
            })
        }
        this.persistToDisk()
    }

    public getPendingForAccount(accountKey: string): ManualQuestRecord[] {
        const safeAcc = redactAccountKey(accountKey)
        const accMap = this.queue.get(safeAcc)
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

    public getSanitizedSnapshot(): Record<string, ManualQuestRecord[]> {
        const snapshot: Record<string, ManualQuestRecord[]> = {}
        for (const [acc, map] of this.queue.entries()) {
            snapshot[acc] = Array.from(map.values()).map(r => ({ ...r }))
        }
        return snapshot
    }

    public updateState(accountKey: string, offerId: string, state: ManualQuestRecord['state'], delta?: number): void {
        const safeAcc = redactAccountKey(accountKey)
        const accMap = this.queue.get(safeAcc)
        if (accMap && accMap.has(offerId)) {
            const item = accMap.get(offerId)!
            item.state = state
            if (state === 'verified-complete') {
                item.completedAt = new Date().toISOString()
                item.complete = true
                if (typeof delta === 'number') {
                    item.verifiedBalanceDelta = delta
                }
            }
            this.persistToDisk()
        }
    }

    public clear(): void {
        this.queue.clear()
        try {
            if (fs.existsSync(this.storagePath)) {
                fs.unlinkSync(this.storagePath)
            }
        } catch {}
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
                decisions.push({
                    quest: this.classifier.classify({ ...promo, accountKey: safeAccount }),
                    policy,
                    action: 'skip',
                    reason: 'cached-negative-capability'
                })
                skippedCount++
                continue
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
