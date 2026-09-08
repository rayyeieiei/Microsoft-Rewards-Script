import type { PunchCardAttemptRecord } from '../functions/activities/ActivitySemantics'
import { ResolvedActionSecret } from '../functions/UrlRewardActionResolver'

export class AccountScope {
    public readonly id: string
    public readonly runId: string
    public readonly accountKey: string
    private _isDisposed = false
    private secrets = new Map<string, ResolvedActionSecret>()
    private attemptRecords = new Map<string, PunchCardAttemptRecord>()
    private trackedPages = new Set<any>()
    private trackedTimers = new Set<NodeJS.Timeout>()

    constructor(accountKey: string, runId?: string, customScopeId?: string) {
        this.accountKey = accountKey
        this.runId = runId || `run_${Date.now()}`
        this.id = customScopeId || `scope_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
    }

    public get isDisposed(): boolean {
        return this._isDisposed
    }

    public storeSecret(secret: ResolvedActionSecret): void {
        if (this._isDisposed) {
            throw new Error('AccountScope is already disposed; cannot store secret')
        }
        if (secret.accountScopeId !== this.id) {
            throw new Error(
                `Account scope mismatch: secret scope ${secret.accountScopeId} does not match active scope ${this.id}`
            )
        }
        this.secrets.set(secret.offerId, secret)
    }

    public getSecret(offerId: string): ResolvedActionSecret | undefined {
        if (this._isDisposed) return undefined
        return this.secrets.get(offerId)
    }

    public hasSecret(offerId: string): boolean {
        if (this._isDisposed) return false
        return this.secrets.has(offerId)
    }

    private makeAttemptKey(parentOfferId: string, childOfferId: string): string {
        return `${this.runId}::${this.id}::${parentOfferId}::${childOfferId}`
    }

    public hasAttempted(parentOfferId: string, childOfferId: string): boolean {
        if (this._isDisposed) return false
        const key = this.makeAttemptKey(parentOfferId, childOfferId)
        return this.attemptRecords.has(key)
    }

    public getAttempt(parentOfferId: string, childOfferId: string): PunchCardAttemptRecord | undefined {
        if (this._isDisposed) return undefined
        const key = this.makeAttemptKey(parentOfferId, childOfferId)
        return this.attemptRecords.get(key)
    }

    public recordAttempt(
        parentOfferId: string,
        childOfferId: string,
        result: 'verified' | 'processed-unverified' | 'execution-unavailable'
    ): PunchCardAttemptRecord {
        const key = this.makeAttemptKey(parentOfferId, childOfferId)
        const record: PunchCardAttemptRecord = {
            runId: this.runId,
            accountScopeId: this.id,
            parentOfferId,
            childOfferId,
            attemptedAt: Date.now(),
            result
        }
        this.attemptRecords.set(key, record)
        return record
    }

    public trackPage(page: any): void {
        if (!this._isDisposed && page) {
            this.trackedPages.add(page)
        }
    }

    public untrackPage(page: any): void {
        if (page) {
            this.trackedPages.delete(page)
        }
    }

    public trackTimer(timer: NodeJS.Timeout): void {
        if (!this._isDisposed && timer) {
            this.trackedTimers.add(timer)
        }
    }

    public untrackTimer(timer: NodeJS.Timeout): void {
        if (timer) {
            this.trackedTimers.delete(timer)
        }
    }

    public async dispose(): Promise<void> {
        if (this._isDisposed) return
        this._isDisposed = true

        // Overwrite and wipe secrets to clear memory residency
        for (const [key] of this.secrets) {
            this.secrets.set(key, new ResolvedActionSecret({ accountScopeId: '', offerId: '' }))
        }
        this.secrets.clear()

        // Close all tracked pages / popups
        for (const p of this.trackedPages) {
            try {
                if (p && typeof p.close === 'function') {
                    await p.close()
                }
            } catch {}
        }
        this.trackedPages.clear()

        // Clear all tracked timers
        for (const t of this.trackedTimers) {
            try {
                clearTimeout(t)
            } catch {}
        }
        this.trackedTimers.clear()

        // Clear attempt records
        this.attemptRecords.clear()
    }

    public toJSON() {
        return {
            id: this.id,
            runId: this.runId,
            accountKey: this.accountKey,
            isDisposed: this._isDisposed
        }
    }

    public toString(): string {
        return `[AccountScope id=${this.id} runId=${this.runId} accountKey=${this.accountKey} disposed=${this._isDisposed}]`
    }
}
