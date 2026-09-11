import { AppOnlyCapabilityRecord } from './AppOnlyTypes'

export interface AppOnlyCapabilityStore {
    get(accountId: string, offerId: string): Promise<AppOnlyCapabilityRecord | null>
    set(record: AppOnlyCapabilityRecord): Promise<void>
    delete(accountId: string, offerId: string): Promise<void>
    prune(now?: Date): Promise<number>
}

/**
 * In-Memory fallback implementation of AppOnlyCapabilityStore.
 * Keyed strictly per-account: `${accountId}::${offerId}`.
 */
export class InMemoryCapabilityStore implements AppOnlyCapabilityStore {
    private store = new Map<string, AppOnlyCapabilityRecord>()

    private makeKey(accountId: string, offerId: string): string {
        return `${accountId.trim().toLowerCase()}::${offerId.trim().toLowerCase()}`
    }

    public async get(accountId: string, offerId: string): Promise<AppOnlyCapabilityRecord | null> {
        try {
            const key = this.makeKey(accountId, offerId)
            const record = this.store.get(key)
            if (!record) return null

            // Check expiration
            if (record.expiresAt) {
                const expTime = new Date(record.expiresAt).getTime()
                if (!isNaN(expTime) && expTime <= Date.now()) {
                    this.store.delete(key)
                    return null
                }
            }

            return record
        } catch {
            return null
        }
    }

    public async set(record: AppOnlyCapabilityRecord): Promise<void> {
        try {
            const key = this.makeKey(record.accountId, record.offerId)
            this.store.set(key, { ...record })
        } catch {
            // Fail-open: cache errors must never crash account flow
        }
    }

    public async delete(accountId: string, offerId: string): Promise<void> {
        try {
            const key = this.makeKey(accountId, offerId)
            this.store.delete(key)
        } catch {
            // Fail-open
        }
    }

    public async prune(now = new Date()): Promise<number> {
        try {
            let pruned = 0
            const nowTime = now.getTime()
            for (const [key, record] of this.store.entries()) {
                if (record.expiresAt) {
                    const expTime = new Date(record.expiresAt).getTime()
                    if (!isNaN(expTime) && expTime <= nowTime) {
                        this.store.delete(key)
                        pruned++
                    }
                }
            }
            return pruned
        } catch {
            return 0
        }
    }

    public clear(): void {
        this.store.clear()
    }
}

/**
 * Manager for App-Only Capability Cache.
 * Protects accounts from repeatedly attempting locked tasks while strictly enforcing per-account boundaries using accountId.
 */
export class AppOnlyCapabilityCache {
    private static defaultInstance: AppOnlyCapabilityCache
    private store: AppOnlyCapabilityStore

    constructor(store?: AppOnlyCapabilityStore) {
        this.store = store || new InMemoryCapabilityStore()
    }

    public static getInstance(): AppOnlyCapabilityCache {
        if (!AppOnlyCapabilityCache.defaultInstance) {
            AppOnlyCapabilityCache.defaultInstance = new AppOnlyCapabilityCache()
        }
        return AppOnlyCapabilityCache.defaultInstance
    }

    public async getRecord(accountId: string, offerId: string): Promise<AppOnlyCapabilityRecord | null> {
        if (!accountId || !offerId) return null
        try {
            return await this.store.get(accountId, offerId)
        } catch {
            return null
        }
    }

    public async recordLocked(
        accountId: string,
        offerId: string,
        lockReason: AppOnlyCapabilityRecord['classification'],
        confidence: AppOnlyCapabilityRecord['confidence'],
        ttlHours = 24,
        expiresAtCandidate?: string
    ): Promise<void> {
        if (!accountId || !offerId) return
        try {
            const now = new Date()
            const ttlMs = Math.max(1, ttlHours) * 60 * 60 * 1000
            const calculatedExpiry = new Date(now.getTime() + ttlMs).toISOString()

            let finalExpiry = calculatedExpiry
            if (expiresAtCandidate) {
                const candidateTime = new Date(expiresAtCandidate).getTime()
                if (!isNaN(candidateTime) && candidateTime < new Date(calculatedExpiry).getTime()) {
                    finalExpiry = new Date(candidateTime).toISOString()
                }
            }

            const existing = await this.store.get(accountId, offerId)

            const record: AppOnlyCapabilityRecord = {
                accountId,
                offerId,
                classification: lockReason,
                confidence,
                firstSeenAt: existing?.firstSeenAt || now.toISOString(),
                lastSeenAt: now.toISOString(),
                expiresAt: finalExpiry,
                serverState: 'locked'
            }

            await this.store.set(record)
        } catch {
            // Fail-open: cache write failure must never impede execution
        }
    }

    public async recordCompleted(accountId: string, offerId: string): Promise<void> {
        if (!accountId || !offerId) return
        try {
            // Invalidate locked cache entry so that it does not block future queries
            await this.store.delete(accountId, offerId)
        } catch {
            // Fail-open
        }
    }

    public async prune(now = new Date()): Promise<number> {
        try {
            return await this.store.prune(now)
        } catch {
            return 0
        }
    }
}
