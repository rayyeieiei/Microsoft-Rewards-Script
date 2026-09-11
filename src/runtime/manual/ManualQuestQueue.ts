import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import {
    ManualQuestKind,
    ManualQuestPublicDto,
    ManualQuestRecord,
    ManualQuestState,
    ManualQuestStore
} from './ManualQuestTypes'
import { redactAccountKey } from '../../util/Redaction'

export interface ManualQuestQueueOptions {
    storagePath?: string
    logger?: {
      info: (msg: string) => void
      warn: (msg: string) => void
      debug: (msg: string) => void
    }
}

/**
 * Dependency-Injected registry for pending manual quests.
 * Backed by schema version 2 file persistence with an async write mutex,
 * quarantine sidecar for malformed legacy entries, and atomic writes.
 */
export class ManualQuestQueue {
    private queue = new Map<string, Map<string, ManualQuestRecord>>() // accountId -> ("${questKind}::${offerId}" -> record)
    private storagePath: string
    private logger?: ManualQuestQueueOptions['logger']
    private isLoaded = false
    private writeMutex: Promise<void> = Promise.resolve()

    constructor(options?: ManualQuestQueueOptions) {
        this.storagePath = options?.storagePath || path.join(process.cwd(), 'browser', 'manual_quests.json')
        this.logger = options?.logger
    }

    private makeInnerKey(questKind: ManualQuestKind, offerId: string): string {
        return `${questKind.trim().toLowerCase()}::${offerId.trim().toLowerCase()}`
    }

    private makeQuarantineAccountId(legacyKey: string): string {
        const hash = crypto.createHash('sha256').update(legacyKey.trim()).digest('hex').slice(0, 12)
        return `legacy-unresolved:${hash}`
    }

    /**
     * Idempotent loader. Must be awaited during bootstrap before queue access.
     */
    public async load(): Promise<void> {
        if (this.isLoaded) {
            return
        }

        try {
            if (!fs.existsSync(this.storagePath)) {
                this.isLoaded = true
                return
            }

            const raw = fs.readFileSync(this.storagePath, 'utf-8')
            let parsed: any
            try {
                parsed = JSON.parse(raw)
            } catch (err) {
                // If existing file is completely invalid JSON, do not clobber
                this.logger?.warn?.(`[QUEUE-LOAD] Storage file at ${this.storagePath} is corrupted JSON. Preserving.`)
                this.isLoaded = true
                return
            }

            if (!parsed || typeof parsed !== 'object') {
                this.isLoaded = true
                return
            }

            // Check if Schema Version 2
            if (parsed.schemaVersion === 2 && Array.isArray(parsed.records)) {
                for (const r of parsed.records) {
                    if (this.isValidManualRecord(r)) {
                        const accId = r.accountId
                        if (!this.queue.has(accId)) {
                            this.queue.set(accId, new Map())
                        }
                        const innerKey = this.makeInnerKey(r.questKind, r.offerId)
                        this.queue.get(accId)!.set(innerKey, { ...r })
                    } else {
                        // Malformed in v2 store -> quarantine sidecar
                        this.appendQuarantineRecord(r, 'malformed-v2-record')
                    }
                }
                this.isLoaded = true
                return
            }

            // Legacy Migration to Schema Version 2
            this.logger?.info?.(`[QUEUE-MIGRATION] Migrating legacy manual quest store to schemaVersion 2...`)
            await this.migrateLegacyStore(parsed)
            this.isLoaded = true
        } catch (err: any) {
            this.logger?.warn?.(`[QUEUE-LOAD] Error during queue loading: ${err?.message || err}`)
            this.isLoaded = true
            throw err
        }
    }

    private isValidManualRecord(r: any): r is ManualQuestRecord {
        return (
            Boolean(r) &&
            typeof r === 'object' &&
            typeof r.accountId === 'string' &&
            r.accountId.length > 0 &&
            typeof r.displayAccount === 'string' &&
            typeof r.questKind === 'string' &&
            typeof r.offerId === 'string' &&
            r.offerId.length > 0 &&
            typeof r.title === 'string' &&
            typeof r.expectedPoints === 'number' &&
            typeof r.complete === 'boolean' &&
            typeof r.locked === 'boolean' &&
            typeof r.state === 'string' &&
            typeof r.queuedAt === 'string' &&
            typeof r.observedAt === 'string'
        )
    }

    private appendQuarantineRecord(rawRecord: any, reason: string): void {
        try {
            const quarantinePath = `${this.storagePath}.quarantine.json`
            let quarantineList: any[] = []
            if (fs.existsSync(quarantinePath)) {
                try {
                    quarantineList = JSON.parse(fs.readFileSync(quarantinePath, 'utf-8')) || []
                } catch {}
            }
            quarantineList.push({
                quarantinedAt: new Date().toISOString(),
                reason,
                record: rawRecord
            })
            fs.writeFileSync(quarantinePath, JSON.stringify(quarantineList, null, 2), 'utf-8')
        } catch {}
    }

    private async migrateLegacyStore(legacyParsed: Record<string, any>): Promise<void> {
        // 1. Create no-clobber backup
        let backupPath = `${this.storagePath}.v1.bak`
        if (fs.existsSync(backupPath)) {
            backupPath = `${this.storagePath}.v1.${Date.now()}.bak`
        }
        fs.copyFileSync(this.storagePath, backupPath)

        const migratedRecords: ManualQuestRecord[] = []
        const nowIso = new Date().toISOString()

        for (const [legacyKey, items] of Object.entries(legacyParsed)) {
            if (!Array.isArray(items)) {
                this.appendQuarantineRecord({ legacyKey, items }, 'non-array-items-entry')
                continue
            }

            const quarantineAccountId = this.makeQuarantineAccountId(legacyKey)
            const displayAccount = redactAccountKey(legacyKey)

            for (const item of items) {
                if (item && typeof item === 'object' && item.offerId) {
                    const record: ManualQuestRecord = {
                        accountId: quarantineAccountId,
                        displayAccount,
                        questKind: 'legacy-unknown',
                        offerId: String(item.offerId),
                        title: String(item.title || ''),
                        expectedPoints: Number(item.expectedPoints || 10),
                        destination: item.destination
                            ? {
                                  scheme: item.destination.scheme || 'https',
                                  origin: item.destination.origin,
                                  path: item.destination.path
                              }
                            : undefined,
                        expiresAt: item.expiresAt,
                        complete: Boolean(item.complete),
                        locked: Boolean(item.locked),
                        lockReason: item.lockReason || 'unknown',
                        confidence: item.confidence || 'high',
                        state: item.state || 'manual-required',
                        observedAt: item.observedAt || nowIso,
                        queuedAt: item.queuedAt || nowIso,
                        completedAt: item.completedAt,
                        legacySourceKey: legacyKey,
                        migrationStatus: 'unresolved-account'
                    }

                    if (this.isValidManualRecord(record)) {
                        migratedRecords.push(record)
                        if (!this.queue.has(quarantineAccountId)) {
                            this.queue.set(quarantineAccountId, new Map())
                        }
                        const innerKey = this.makeInnerKey(record.questKind, record.offerId)
                        this.queue.get(quarantineAccountId)!.set(innerKey, record)
                    } else {
                        this.appendQuarantineRecord(item, 'invalid-legacy-record')
                    }
                } else {
                    this.appendQuarantineRecord(item, 'malformed-legacy-item')
                }
            }
        }

        // 2. Persist migrated records to schemaVersion 2 atomically
        const store: ManualQuestStore = {
            schemaVersion: 2,
            records: migratedRecords
        }
        await this.atomicWriteStore(store)
        this.logger?.info?.(
            `[QUEUE-MIGRATION] Successfully migrated ${migratedRecords.length} records to v2 store. Backup created at ${backupPath}`
        )
    }

    private atomicWriteStore(store: ManualQuestStore): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                const dir = path.dirname(this.storagePath)
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true })
                }
                const tmpPath = path.join(dir, `.manual_quests_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.tmp`)
                fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8')

                // Directory fsync where supported
                try {
                    const dirFd = fs.openSync(dir, 'r')
                    fs.fsyncSync(dirFd)
                    fs.closeSync(dirFd)
                } catch {}

                // Atomic rename
                fs.renameSync(tmpPath, this.storagePath)
                resolve()
            } catch (err) {
                reject(err)
            }
        })
    }

    private schedulePersist(): Promise<void> {
        this.writeMutex = this.writeMutex.then(async () => {
            const allRecords: ManualQuestRecord[] = []
            for (const accMap of this.queue.values()) {
                for (const r of accMap.values()) {
                    allRecords.push({ ...r })
                }
            }
            const store: ManualQuestStore = {
                schemaVersion: 2,
                records: allRecords
            }
            await this.atomicWriteStore(store)
        }).catch(err => {
            this.logger?.warn?.(`[QUEUE-PERSIST] Failed to persist manual quest store: ${err?.message || err}`)
        })
        return this.writeMutex
    }

    public async enqueue(record: ManualQuestRecord): Promise<void> {
        if (!this.isValidManualRecord(record)) {
            throw new Error(`[QUEUE-ENQUEUE] Attempted to enqueue invalid ManualQuestRecord: missing required fields`)
        }

        const accId = record.accountId
        if (!this.queue.has(accId)) {
            this.queue.set(accId, new Map())
        }

        const accMap = this.queue.get(accId)!
        const innerKey = this.makeInnerKey(record.questKind, record.offerId)
        const existing = accMap.get(innerKey)

        if (existing) {
            // Deduplicate: Never re-queue or overwrite verified completion
            if (existing.state === 'verified-complete') {
                return
            }
            accMap.set(innerKey, {
                ...existing,
                ...record,
                queuedAt: existing.queuedAt || record.queuedAt
            })
        } else {
            accMap.set(innerKey, { ...record })
        }

        await this.schedulePersist()
    }

    public getPendingForAccount(accountId: string, questKind?: ManualQuestKind): ManualQuestRecord[] {
        const accMap = this.queue.get(accountId)
        if (!accMap) return []

        return Array.from(accMap.values()).filter(r => {
            if (questKind && r.questKind !== questKind) {
                return false
            }
            return r.state === 'manual-required' || r.state === 'detected' || r.state === 'verify-pending'
        })
    }

    public getAllPending(): ManualQuestRecord[] {
        const all: ManualQuestRecord[] = []
        for (const accMap of this.queue.values()) {
            for (const r of accMap.values()) {
                if (r.state === 'manual-required' || r.state === 'detected' || r.state === 'verify-pending') {
                    all.push({ ...r })
                }
            }
        }
        return all
    }

    public async updateState(
        accountId: string,
        questKind: ManualQuestKind,
        offerId: string,
        state: ManualQuestState,
        observedDelta?: number
    ): Promise<void> {
        const accMap = this.queue.get(accountId)
        if (!accMap) return

        const innerKey = this.makeInnerKey(questKind, offerId)
        const item = accMap.get(innerKey)
        if (!item) return

        item.state = state
        if (state === 'verified-complete') {
            item.complete = true
            item.completedAt = new Date().toISOString()
            if (typeof observedDelta === 'number') {
                item.observedAccountBalanceDelta = observedDelta
            }
        }

        await this.schedulePersist()
    }

    public getSanitizedSnapshot(): Record<string, ManualQuestPublicDto[]> {
        const snapshot: Record<string, ManualQuestPublicDto[]> = {}

        for (const accMap of this.queue.values()) {
            for (const r of accMap.values()) {
                const displayKey = r.displayAccount || 'unknown'
                if (!snapshot[displayKey]) {
                    snapshot[displayKey] = []
                }
                snapshot[displayKey].push({
                    displayAccount: r.displayAccount,
                    questKind: r.questKind,
                    offerId: r.offerId,
                    title: r.title,
                    expectedPoints: r.expectedPoints,
                    destination: r.destination
                        ? {
                              scheme: r.destination.scheme,
                              origin: r.destination.origin,
                              path: r.destination.path
                          }
                        : undefined,
                    complete: r.complete,
                    locked: r.locked,
                    state: r.state,
                    queuedAt: r.queuedAt,
                    observedAt: r.observedAt
                })
            }
        }

        return snapshot
    }

    public async pruneExpired(retentionDays: number, nowMs = Date.now()): Promise<number> {
        const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000
        let prunedCount = 0

        for (const accMap of this.queue.values()) {
            for (const [key, r] of accMap.entries()) {
                // Pruning ONLY applies to terminal records
                const isTerminal = r.state === 'verified-complete' || r.state === 'expired' || r.state === 'skipped'
                if (!isTerminal) {
                    continue // Pending / manual-required is NEVER pruned
                }

                const refTime = r.completedAt ? new Date(r.completedAt).getTime() : new Date(r.queuedAt).getTime()
                if (!isNaN(refTime) && nowMs - refTime > maxAgeMs) {
                    accMap.delete(key)
                    prunedCount++
                }
            }
        }

        if (prunedCount > 0) {
            await this.schedulePersist()
        }

        return prunedCount
    }

    public async flushPendingWrites(): Promise<void> {
        await this.writeMutex
    }
}
