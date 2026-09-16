import crypto from 'crypto'
import path from 'path'
import type { PunchCardAttemptRecord } from '../functions/activities/ActivitySemantics'
import { ResolvedActionSecret } from '../functions/UrlRewardActionResolver'
import { resolveAccountIdentity } from './identity/AccountIdentity'
import type { AccountOwnershipIdentity } from './identity/AccountOwnershipIdentity'
import type {
    AccountScopeCreateOptions,
    StorageStatePaths
} from './environment/BrowserEnvironmentTypes'
import { AccountDisposer } from './AccountDisposer'
import type { MicrosoftRewardsBot } from '../index'

export type AccountScopeLifecycleState = 'active' | 'disposing' | 'disposed'

export class AccountScope {
    public readonly id: string
    public readonly runId: string
    public readonly accountKey: string
    public readonly accountId: string
    public readonly identity: Readonly<AccountOwnershipIdentity>
    public readonly storagePaths: StorageStatePaths
    public readonly bot?: MicrosoftRewardsBot
    public readonly abortController: AbortController = new AbortController()

    private _lifecycleState: AccountScopeLifecycleState = 'active'
    private _disposalPromise: Promise<void> | null = null
    private activeOperations = new Set<Promise<unknown>>()
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
        ownershipIdentity: AccountOwnershipIdentity,
        bot?: MicrosoftRewardsBot
    ) {
        this.accountKey = accountKey
        this.runId = runId
        this.id = id
        this.accountId = accountId
        this.storagePaths = storagePaths
        this.identity = Object.freeze({
            accountId: ownershipIdentity.accountId,
            participantId: ownershipIdentity.participantId,
            householdId: ownershipIdentity.householdId
        })
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

        const ownershipIdentity: AccountOwnershipIdentity = {
            accountId: identity.accountId,
            participantId: options.account.participantId?.trim() || 'unassigned-participant',
            householdId: options.account.householdId?.trim() || 'unassigned-household'
        }

        const scope = new AccountScope(
            identity.displayAccount,
            runId,
            scopeId,
            identity.accountId,
            storagePaths,
            ownershipIdentity,
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
        customScopeId?: string,
        customOwnership?: Partial<AccountOwnershipIdentity>,
        customSessionDir?: string
    ): AccountScope {
        const resolvedRunId = runId || `run_test_${Date.now()}`
        const scopeId =
            customScopeId ||
            `scope_test_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
        const accountId = customOwnership?.accountId || crypto.createHash('sha256').update(accountKey).digest('hex')
        const storageKey = crypto
            .createHash('sha256')
            .update(accountId)
            .digest('hex')
            .slice(0, 32)

        const sessionDir = customSessionDir || path.join(process.cwd(), 'browser', 'sessions')
        const storagePaths: StorageStatePaths = {
            storageKey,
            sessionDir,
            mobilePath: path.join(sessionDir, `${storageKey}.mobile.storageState.json`),
            desktopPath: path.join(sessionDir, `${storageKey}.desktop.storageState.json`)
        }

        const ownershipIdentity: AccountOwnershipIdentity = {
            accountId,
            participantId: customOwnership?.participantId || 'test-participant-id',
            householdId: customOwnership?.householdId || 'test-household-id'
        }

        return new AccountScope(
            accountKey,
            resolvedRunId,
            scopeId,
            accountId,
            storagePaths,
            ownershipIdentity
        )
    }

    public get lifecycleState(): AccountScopeLifecycleState {
        return this._lifecycleState
    }

    public get isDisposed(): boolean {
        return this._lifecycleState === 'disposed' || this._isDisposed
    }

    public get isDisposing(): boolean {
        return this._lifecycleState === 'disposing'
    }

    public get isActive(): boolean {
        return this._lifecycleState === 'active'
    }

    public markDisposed(): void {
        this._lifecycleState = 'disposed'
        this._isDisposed = true
    }

    private assertActive(operationName: string): void {
        if (this._lifecycleState !== 'active') {
            throw new Error(`Cannot perform ${operationName}: AccountScope is ${this._lifecycleState}`)
        }
    }

    public trackOperation<T>(promise: Promise<T>): Promise<T> {
        this.assertActive('trackOperation')
        this.activeOperations.add(promise)
        promise
            .finally(() => {
                this.activeOperations.delete(promise)
            })
            .catch(() => {})
        return promise
    }

    public async waitForActiveOperations(timeoutMs: number = 2000): Promise<void> {
        if (this.activeOperations.size === 0) return
        const operations = Array.from(this.activeOperations)
        await Promise.race([
            Promise.allSettled(operations),
            new Promise<void>(resolve => setTimeout(resolve, timeoutMs))
        ])
    }

    public getActiveOperationCount(): number {
        return this.activeOperations.size
    }

    /**
     * Synchronous latch ensures that disposalPromise is created and assigned
     * BEFORE abortController.abort() fires, preventing duplicate disposal passes
     * if abort listeners re-enter disposal synchronously.
     */
    public beginDisposal(work: () => Promise<void>): Promise<void> {
        if (this._disposalPromise) {
            return this._disposalPromise
        }
        if (this._lifecycleState === 'disposed' || this._isDisposed) {
            return Promise.resolve()
        }

        this._lifecycleState = 'disposing'
        let resolvePromise!: () => void
        let rejectPromise!: (err: unknown) => void
        this._disposalPromise = new Promise<void>((res, rej) => {
            resolvePromise = res
            rejectPromise = rej
        })

        // 1. Abort signal fired AFTER disposalPromise is created & assigned
        try {
            this.abortController.abort()
        } catch {}

        // 2. Execute work asynchronously
        ;(async () => {
            try {
                await work()
                resolvePromise()
            } catch (err) {
                rejectPromise(err)
            } finally {
                this._lifecycleState = 'disposed'
                this._isDisposed = true
            }
        })()

        return this._disposalPromise
    }

    // --- DAPI Token Management ---

    public getDapiToken(): string {
        if (this._lifecycleState !== 'active') return ''
        return this.dapiToken
    }

    public setDapiToken(token: string): void {
        if (this._lifecycleState !== 'active') {
            throw new Error('Cannot set DAPI token on disposed AccountScope')
        }
        this.dapiToken = token
    }

    public clearDapiToken(): void {
        this.dapiToken = ''
    }

    // --- Ghost Cursor Management ---

    public bindCursor(page: any, cursor: any): void {
        if (this._lifecycleState === 'active' && page) {
            this.cursors.set(page, cursor)
        }
    }

    public getCursor(page: any): any | undefined {
        if (this._lifecycleState !== 'active' || !page) return undefined
        return this.cursors.get(page)
    }

    public clearCursors(): void {
        this.cursors.clear()
    }

    // --- Context Management ---

    public setContext(kind: 'mobile' | 'desktop', context: any): void {
        if (this._lifecycleState !== 'active') {
            if (context && typeof context.close === 'function') {
                context.close().catch(() => {})
            }
            throw new Error(`Cannot attach ${kind} context to ${this._lifecycleState} AccountScope`)
        }
        if (kind === 'mobile') {
            this.mobileContext = context
        } else {
            this.desktopContext = context
        }
    }

    public getContext(kind: 'mobile' | 'desktop'): any | undefined {
        if (this._lifecycleState === 'disposed') return undefined
        return kind === 'mobile' ? this.mobileContext : this.desktopContext
    }

    // --- Route & Response Handlers (Exact unroute support) ---

    public registerRouteHandler(context: any, url: string, handler: any): void {
        if (this._lifecycleState === 'active') {
            this.routeHandlers.push({ context, url, handler })
        }
    }

    public registerResponseListener(context: any, listener: any): void {
        if (this._lifecycleState === 'active') {
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
        if (this._lifecycleState !== 'active') {
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
        if (this._lifecycleState !== 'active') return undefined
        return this.secrets.get(offerId)
    }

    public hasSecret(offerId: string): boolean {
        if (this._lifecycleState !== 'active') return false
        return this.secrets.has(offerId)
    }

    public getSecrets(): Map<string, ResolvedActionSecret> {
        return this.secrets
    }

    public setSecret(offerId: string, secret: ResolvedActionSecret): void {
        if (this._lifecycleState === 'disposed') {
            throw new Error('AccountScope is already disposed; cannot set secret')
        }
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
        if (this._lifecycleState === 'disposed') return false
        const key = this.makeAttemptKey(parentOfferId, childOfferId)
        return this.attemptRecords.has(key)
    }

    public getAttempt(parentOfferId: string, childOfferId: string): PunchCardAttemptRecord | undefined {
        if (this._lifecycleState === 'disposed') return undefined
        const key = this.makeAttemptKey(parentOfferId, childOfferId)
        return this.attemptRecords.get(key)
    }

    public recordAttempt(
        parentOfferId: string,
        childOfferId: string,
        result: 'verified' | 'processed-unverified' | 'execution-unavailable'
    ): PunchCardAttemptRecord {
        this.assertActive('recordAttempt')
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
        if (!page) return
        if (this._lifecycleState !== 'active') {
            if (typeof page.close === 'function') {
                page.close().catch(() => {})
            }
            return
        }
        this.trackedPages.add(page)
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
        if (this._lifecycleState === 'active' && timer) {
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

    public dispose(): Promise<void> {
        return AccountDisposer.dispose(this)
    }

    public toJSON() {
        return {
            id: this.id,
            runId: this.runId,
            accountKey: this.accountKey,
            lifecycleState: this._lifecycleState,
            isDisposed: this.isDisposed
        }
    }

    public toString(): string {
        return `[AccountScope id=${this.id} runId=${this.runId} accountKey=${this.accountKey} state=${this._lifecycleState}]`
    }
}
