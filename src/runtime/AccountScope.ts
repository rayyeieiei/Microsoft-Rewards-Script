import crypto from 'crypto'
import path from 'path'
import type { PunchCardAttemptRecord } from '../functions/activities/ActivitySemantics'
import { ResolvedActionSecret } from '../functions/UrlRewardActionResolver'
import { resolveAccountIdentity } from './identity/AccountIdentity'
import type {
    AccountScopeCreateOptions,
    StorageStatePaths
} from './environment/BrowserEnvironmentTypes'
import { AccountDisposer } from './AccountDisposer'
import type { MicrosoftRewardsBot } from '../index'

export class AccountScope {
    public readonly id: string
    public readonly runId: string
    public readonly accountKey: string
    public readonly accountId: string
    public readonly storagePaths: StorageStatePaths
    public readonly bot?: MicrosoftRewardsBot
    public readonly abortController: AbortController = new AbortController()

    private _isDisposed = false
    private dapiToken = ''
    private mobileContext?: any
    private desktopContext?: any
    private secrets = new Map<string, ResolvedActionSecret>()
    private attemptRecords = new Map<string, PunchCardAttemptRecord>()
    private trackedPages = new Set<any>()
    private trackedTimers = new Set<NodeJS.Timeout>()
    private cursors = new Map<any, any>()
    private routeHandlers: Array<{ context: any; url: string; handler: any }> = []
    private responseListeners: Array<{ context: any; listener: any }> = []

    /**
     * Private constructor enforces single creation path.
     * All production consumers must use AccountScope.create(options).
     * Pure unit tests can use AccountScope.createForTesting(...).
     */
    private constructor(
        accountKey: string,
        runId: string,
        id: string,
        accountId: string,
        storagePaths: StorageStatePaths,
        bot?: MicrosoftRewardsBot
    ) {
        this.accountKey = accountKey
        this.runId = runId
        this.id = id
        this.accountId = accountId
        this.storagePaths = storagePaths
        this.bot = bot
    }

    /**
     * Single construction path for production.
     * Resolves stable account identity, validates uniqueness, computes isolated storageState paths,
     * and binds lifecycle controller.
     */
    public static async create(options: AccountScopeCreateOptions): Promise<AccountScope> {
        const identity = resolveAccountIdentity(options.account)
        const runId = options.runId || `run_${Date.now()}`
        const scopeId = `scope_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`

        // storageKey is sha256(accountId) sliced to 32 chars to prevent directory traversal or invalid path chars
        const storageKey = crypto
            .createHash('sha256')
            .update(identity.accountId)
            .digest('hex')
            .slice(0, 32)

        const sessionFolder = options.bot?.config?.sessionPath ?? 'sessions'
        const sessionDir = path.join(process.cwd(), 'browser', sessionFolder)
        const mobilePath = path.join(sessionDir, `${storageKey}.mobile.storageState.json`)
        const desktopPath = path.join(sessionDir, `${storageKey}.desktop.storageState.json`)

        const storagePaths: StorageStatePaths = {
            storageKey,
            sessionDir,
            mobilePath,
            desktopPath
        }

        const scope = new AccountScope(
            identity.displayAccount,
            runId,
            scopeId,
            identity.accountId,
            storagePaths,
            options.bot
        )

        return scope
    }

    /**
     * Factory method strictly for unit tests where bot is not required.
     */
    public static createForTesting(
        accountKey: string,
        runId?: string,
        customScopeId?: string
    ): AccountScope {
        const resolvedRunId = runId || `run_test_${Date.now()}`
        const scopeId =
            customScopeId ||
            `scope_test_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
        const accountId = crypto.createHash('sha256').update(accountKey).digest('hex')
        const storageKey = crypto
            .createHash('sha256')
            .update(accountId)
            .digest('hex')
            .slice(0, 32)

        const sessionDir = path.join(process.cwd(), 'browser', 'sessions')
        const storagePaths: StorageStatePaths = {
            storageKey,
            sessionDir,
            mobilePath: path.join(sessionDir, `${storageKey}.mobile.storageState.json`),
            desktopPath: path.join(sessionDir, `${storageKey}.desktop.storageState.json`)
        }

        return new AccountScope(
            accountKey,
            resolvedRunId,
            scopeId,
            accountId,
            storagePaths
        )
    }

    public get isDisposed(): boolean {
        return this._isDisposed
    }

    public markDisposed(): void {
        this._isDisposed = true
    }

    // --- DAPI Token Management ---

    public getDapiToken(): string {
        if (this._isDisposed) return ''
        return this.dapiToken
    }

    public setDapiToken(token: string): void {
        if (this._isDisposed) {
            throw new Error('Cannot set DAPI token on disposed AccountScope')
        }
        this.dapiToken = token
    }

    public clearDapiToken(): void {
        this.dapiToken = ''
    }

    // --- Ghost Cursor Management ---

    public bindCursor(page: any, cursor: any): void {
        if (!this._isDisposed && page) {
            this.cursors.set(page, cursor)
        }
    }

    public getCursor(page: any): any | undefined {
        if (this._isDisposed || !page) return undefined
        return this.cursors.get(page)
    }

    public clearCursors(): void {
        this.cursors.clear()
    }

    // --- Context Management ---

    public setContext(kind: 'mobile' | 'desktop', context: any): void {
        if (this._isDisposed) {
            throw new Error(`Cannot attach ${kind} context to disposed AccountScope`)
        }
        if (kind === 'mobile') {
            this.mobileContext = context
        } else {
            this.desktopContext = context
        }
    }

    public getContext(kind: 'mobile' | 'desktop'): any | undefined {
        if (this._isDisposed) return undefined
        return kind === 'mobile' ? this.mobileContext : this.desktopContext
    }

    // --- Route & Response Handlers (Exact unroute support) ---

    public registerRouteHandler(context: any, url: string, handler: any): void {
        if (!this._isDisposed) {
            this.routeHandlers.push({ context, url, handler })
        }
    }

    public registerResponseListener(context: any, listener: any): void {
        if (!this._isDisposed) {
            this.responseListeners.push({ context, listener })
        }
    }

    public getRouteHandlers(): Array<{ context: any; url: string; handler: any }> {
        return [...this.routeHandlers]
    }

    public getResponseListeners(): Array<{ context: any; listener: any }> {
        return [...this.responseListeners]
    }

    public clearRouteHandlersAndListeners(): void {
        this.routeHandlers = []
        this.responseListeners = []
    }

    // --- Secrets Management ---

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

    public getSecrets(): Map<string, ResolvedActionSecret> {
        return this.secrets
    }

    public setSecret(offerId: string, secret: ResolvedActionSecret): void {
        this.secrets.set(offerId, secret)
    }

    public clearSecrets(): void {
        this.secrets.clear()
    }

    // --- Attempt Records Management ---

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

    public clearAttemptRecords(): void {
        this.attemptRecords.clear()
    }

    // --- Tracked Pages & Timers ---

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

    public getTrackedPages(): Set<any> {
        return this.trackedPages
    }

    public clearTrackedPages(): void {
        this.trackedPages.clear()
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

    public getTrackedTimers(): Set<NodeJS.Timeout> {
        return this.trackedTimers
    }

    public clearTrackedTimers(): void {
        this.trackedTimers.clear()
    }

    // --- Disposal ---

    public async dispose(): Promise<void> {
        await AccountDisposer.dispose(this)
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
