import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import cluster, { Worker } from 'cluster'
import { chromium, type BrowserContext, type Cookie, type Page } from 'patchright'
import axios from 'axios'
import pkg from '../package.json'
import dns from 'node:dns/promises' // 🚀 UNTUK CEK KONEKSI HEMAT KUOTA

import Browser from './browser/Browser'
import BrowserFunc from './browser/BrowserFunc'
import BrowserUtils from './browser/BrowserUtils'

import { IpcLog, Logger } from './logging/Logger'
import Utils from './util/Utils'
import { loadAccounts, loadConfig, getActiveConfigFile } from './util/Load'
import { checkNodeVersion } from './util/Validator'

import { Login } from './browser/auth/Login'
import { Workers, ensureOnRewardsDashboard } from './functions/Workers'
import Activities from './functions/Activities'
import { SearchManager } from './functions/SearchManager'
import { QueryCore } from './functions/QueryEngine'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { DynamicOutboundProxy } from './util/DynamicOutboundProxy'
import {
    DashboardServer,
    updateDashboardAccount,
    updateDashboardGlobal,
    registerControlCallback,
    registerConfigCallback,
    registerIpConfirmCallback,
    registerManualQuestProvider,
    registerManualQuestActionHandler
} from './util/DashboardServer'
import { AirplaneMode } from './util/AirplaneMode'
import { ManualQuestQueue } from './runtime/manual/ManualQuestQueue'
import { resolveAccountIdentity, validateUniqueAccountIdentities } from './runtime/identity/AccountIdentity'
import { OnboardingEvidence } from './functions/onboarding/NewAccountOnboardingTypes'
import { DataSaverManager, mapResourceTypeToCategory } from './util/DataSaver'
import { Database } from './util/Database'
import { AccountScope } from './runtime/AccountScope'
import { AccountDisposer } from './runtime/AccountDisposer'
import { createManagedPage, recoverOwnerPage } from './runtime/BrowserOperationGuard'
import { AccountSessionStore } from './runtime/session/AccountSessionStore'
import { AccountSuspendedError, checkPageSuspension } from './browser/auth/SuspensionDetector'
import { autoEnrollRewards } from './functions/Onboarding'
import { UserAgentManager } from './browser/UserAgent'

export { AccountSuspendedError }
import crypto from 'crypto'
import {
    validateOwnershipPolicy,
    createSanitizedDiagnosticDto,
    OwnershipEnforcementMode
} from './runtime/identity/AccountOwnershipIdentity'
import {
    NetworkRecoveryController
} from './runtime/network/NetworkRecoveryController'
import {
    AdbNetworkRecoveryAdapter,
    type AdbPreflightStatus
} from './runtime/network/AdbNetworkRecoveryAdapter'
import {
    ManualNetworkRecoveryAdapter
} from './runtime/network/ManualNetworkRecoveryAdapter'
import {
    DefaultNetworkConnectivityProbe
} from './runtime/network/NetworkConnectivityProbe'
import {
    NetworkRecoveryIpcClient
} from './runtime/network/NetworkRecoveryIpcClient'
import {
    ConnectivityFailureReporter,
    type ConnectivityFailureSource
} from './runtime/network/ConnectivityFailureReporter'
import type {
    NetworkRecoveryPolicy,
    NetworkRecoveryResult,
    NetworkRecoveryTrigger
} from './runtime/network/NetworkRecoveryTypes'
import {
    registerNetworkRecoveryResolver,
    registerOperatorRecoveryHandler
} from './util/DashboardServer'
import {
    resolveBuildMetadata
} from './runtime/diagnostics/BuildMetadata'

import type { Account } from './interface/Account'
import AxiosClient from './util/Axios'
import { sendDiscord, flushDiscordQueue } from './logging/Discord'
import { sendNtfy, flushNtfyQueue } from './logging/Ntfy'
import type { DashboardData } from './interface/DashboardData'
import type { AppDashboardData } from './interface/AppDashBoardData'
import readline from 'readline'

export let manualIpConfirmResolver: (() => void) | null = null

export function chunkArrayBySize<T>(arr: T[], size: number): T[][] {
    if (!arr || arr.length === 0) return []
    const safeSize = Math.max(1, size)
    const result: T[][] = []
    for (let i = 0; i < arr.length; i += safeSize) {
        result.push(arr.slice(i, i + safeSize))
    }
    return result
}

export function calculateDynamicDeadline(
    estimatedQueries: number = 0,
    basePreSearchMs: number = 2 * 60 * 1000,
    remainingPoints?: number
): number {
    const isZeroPoints = (remainingPoints !== undefined && remainingPoints <= 0) || (estimatedQueries <= 0 && remainingPoints === 0)
    if (isZeroPoints) {
        return 5 * 60 * 1000
    }
    const dynamicDeadlineMs = Math.min(
        25 * 60 * 1000,
        Math.max(12 * 60 * 1000, basePreSearchMs + (estimatedQueries * 20000) + 4 * 60 * 1000)
    )
    return dynamicDeadlineMs
}

export function waitForManualIpConfirmation(): Promise<void> {
    return new Promise(resolve => {
        let isResolved = false

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        })

        const onConfirm = () => {
            if (isResolved) return
            isResolved = true
            manualIpConfirmResolver = null
            try {
                rl.close()
            } catch {}
            resolve()
        }

        manualIpConfirmResolver = onConfirm

        rl.question('', () => {
            onConfirm()
        })
    })
}

export function waitForUserConfirmation(): Promise<void> {
    return waitForManualIpConfirmation()
}

interface ExecutionContext {
    isMobile: boolean
    account: Account
}

interface BrowserSession {
    context: BrowserContext
    fingerprint?: any
}

interface AccountStats {
    email: string
    initialPoints: number
    finalPoints: number
    collectedPoints: number
    duration: number
    bandwidthMb?: number
    success: boolean
    error?: string
}

const executionContext = new AsyncLocalStorage<ExecutionContext>()

export function getCurrentContext(): ExecutionContext {
    const context = executionContext.getStore()
    if (!context) {
        return { isMobile: false, account: {} as any }
    }
    return context
}

async function flushAllWebhooks(timeoutMs = 5000): Promise<void> {
    await Promise.allSettled([flushDiscordQueue(timeoutMs), flushNtfyQueue(timeoutMs)])
}

export type ShutdownStatus = 'completed' | 'failed' | 'timed-out'

export interface ShutdownResult {
    status: ShutdownStatus
    error?: Error
    durationMs: number
}

interface UserData {
    userName: string
    geoLocale: string
    langCode: string
    initialPoints: number
    currentPoints: number
    gainedPoints: number
    timezoneOffset: string // FIX COMPILER
}

export class MicrosoftRewardsBot {
    public logger: Logger
    public config: any
    public utils: Utils
    public manualQuestQueue: ManualQuestQueue
    public activities: Activities
    public browser: { func: BrowserFunc; utils: BrowserUtils }

    private _mainMobilePage?: Page
    private _mainDesktopPage?: Page
    public get mainMobilePage(): Page {
        return this.accountScope?.mainMobilePage || this._mainMobilePage!
    }
    public set mainMobilePage(page: Page) {
        if (this.accountScope) {
            this.accountScope.mainMobilePage = page
        }
        this._mainMobilePage = page
    }

    public get mainDesktopPage(): Page {
        return this.accountScope?.mainDesktopPage || this._mainDesktopPage!
    }
    public set mainDesktopPage(page: Page) {
        if (this.accountScope) {
            this.accountScope.mainDesktopPage = page
        }
        this._mainDesktopPage = page
    }

    private _userData: UserData
    public get userData(): UserData {
        return this.accountScope?.userData || this._userData
    }
    public set userData(data: UserData) {
        if (this.accountScope) {
            this.accountScope.userData = data
        }
        this._userData = data
    }

    public get currentPoints(): number {
        return this.userData.currentPoints
    }
    public set currentPoints(points: number) {
        this.userData.currentPoints = points
    }

    public get initialPoints(): number {
        return this.userData.initialPoints
    }
    public set initialPoints(points: number) {
        this.userData.initialPoints = points
    }

    public rewardsVersion: 'legacy' | 'modern' = 'legacy'
    public get accessToken(): string {
        return this.accountScope ? this.accountScope.getDapiToken() : ''
    }
    public set accessToken(token: string) {
        if (!this.accountScope) {
            throw new Error('[FATAL-SCOPE] Cannot set DAPI access token: no active AccountScope')
        }
        this.accountScope.setDapiToken(token)
    }
    public requestToken = ''
    private mobileTokenRefreshPromise: Promise<string> | null = null

    public async refreshMobileAccessToken(page?: Page, email?: string): Promise<string> {
        if (this.mobileTokenRefreshPromise) {
            this.logger.debug(
                this.isMobile,
                'TOKEN-MUTEX',
                'In-flight mobile access token refresh already in progress, deduplicating request...'
            )
            return this.mobileTokenRefreshPromise
        }

        const targetPage = page || this.mainMobilePage
        const targetEmail = email || this.activeAccount?.email || ''

        if (!targetPage || targetPage.isClosed()) {
            this.logger.warn(
                this.isMobile,
                'TOKEN-MUTEX',
                'Cannot refresh mobile access token: target page is missing or closed'
            )
            return ''
        }

        this.mobileTokenRefreshPromise = (async () => {
            try {
                const token = await this.login.getAppAccessToken(targetPage, targetEmail)
                if (token) {
                    this.accessToken = token
                }
                return token
            } finally {
                this.mobileTokenRefreshPromise = null
            }
        })()

        return this.mobileTokenRefreshPromise
    }
    private _cookies: { mobile: Cookie[]; desktop: Cookie[] } = { mobile: [], desktop: [] }
    public get cookies(): { mobile: Cookie[]; desktop: Cookie[] } {
        return this.accountScope?.cookies || this._cookies
    }
    public set cookies(c: { mobile: Cookie[]; desktop: Cookie[] }) {
        if (this.accountScope) {
            this.accountScope.cookies = c
        }
        this._cookies = c
    }
    public fingerprint?: any
    public accounts: Account[] = [] // DIUBAH JADI PUBLIC AGAR DISCORDBOT AMAN
    public workers: Workers // DIUBAH JADI PUBLIC AGAR SEARCHMANAGER AMAN
    public localProxy: DynamicOutboundProxy | null = null
    public localProxyPort = 0
    public activeAccount: Account | null = null
    public accountScope: AccountScope | null = null
    public runId: string = `run_${Date.now()}`
    public isRunning = false
    public stopRequested = false
    public sessionStartTime: number = Date.now()
    public sessionTotalAccounts: number = 0
    public sessionCompletedAccounts: number = 0
    public sessionActiveAccountEmail: string = ''
    private hasLoggedShutdownSummary: boolean = false
    public dashboardServer: DashboardServer | null = null
    private dashboardServerActive = false
    private shutdownPromise: Promise<ShutdownResult> | null = null
    private sessionSecret: string = crypto.randomBytes(32).toString('hex')
    public networkRecoveryController?: NetworkRecoveryController
    public manualNetworkRecoveryAdapter?: ManualNetworkRecoveryAdapter
    public adbNetworkRecoveryAdapter?: AdbNetworkRecoveryAdapter
    public networkRecoveryAvailable = true
    public networkRecoveryPreflightStatus: AdbPreflightStatus | null = null
    public networkRecoveryIpcClient?: NetworkRecoveryIpcClient
    public activeRecoveryAbortController: AbortController | null = null
    public pendingOperatorRecovery: {
        source: 'dashboard' | 'cli'
        requestId: string
        receivedAt: number
        ttlMs: number
    } | null = null
    private cliStdinListener: ((chunk: Buffer | string) => void) | null = null
    public connectivityFailureReporter?: ConnectivityFailureReporter
    private activeManualInspector: { email: string; browser: any; context: any; page: any } | null = null

    private activeWorkers: number
    private exitedWorkers: number[]
    public browserFactory: Browser
    private login: Login
    private searchManager: SearchManager
    public searchCooldownActive = false
    public parentBot?: MicrosoftRewardsBot
    private _batchCircuitBreakerTriggered = false
    public get batchCircuitBreakerTriggered(): boolean {
        return this.parentBot ? this.parentBot.batchCircuitBreakerTriggered : this._batchCircuitBreakerTriggered
    }
    public set batchCircuitBreakerTriggered(val: boolean) {
        if (this.parentBot) {
            this.parentBot.batchCircuitBreakerTriggered = val
        }
        this._batchCircuitBreakerTriggered = val
    }
    public axios!: AxiosClient

    public isCircuitBreakerTriggered(): boolean {
        return this.batchCircuitBreakerTriggered
    }

    public triggerCircuitBreaker(reason: string): void {
        this.batchCircuitBreakerTriggered = true
        this.logger.warn(
            this.isMobile,
            'CIRCUIT-BREAKER',
            `[CIRCUIT-BREAKER] Triggered (${reason}). Halting peer searches in current batch to safeguard accounts and IP reputation!`
        )
    }

    public activeWorkerBots: Set<MicrosoftRewardsBot> = new Set<MicrosoftRewardsBot>()

    public async cleanupBrowserResources(): Promise<void> {
        try {
            if (this.accountScope) {
                await AccountDisposer.dispose(this.accountScope).catch(() => {})
            }
            if (this.mainMobilePage && !this.mainMobilePage.isClosed()) {
                await Promise.race([
                    this.mainMobilePage.close(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Mobile page close timeout')), 5000))
                ]).catch(() => {})
            }
            if (this.mainDesktopPage && !this.mainDesktopPage.isClosed()) {
                await Promise.race([
                    this.mainDesktopPage.close(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Desktop page close timeout')), 5000))
                ]).catch(() => {})
            }
            if (this.browserFactory) {
                await this.browserFactory.recycleBrowser().catch(() => {})
            }
        } catch (err) {
            this.logger.debug('main', 'CLEANUP', `cleanupBrowserResources error: ${err}`)
        }
    }

    private _bandwidthTracker = {
        totalBytes: 0,
        blockedRequests: 0
    }
    public get bandwidthTracker() {
        return this.accountScope?.bandwidthTracker || this._bandwidthTracker
    }
    public set bandwidthTracker(b: { totalBytes: number; blockedRequests: number }) {
        if (this.accountScope) {
            this.accountScope.bandwidthTracker = b
        }
        this._bandwidthTracker = b
    }

    public trackBandwidth(bytes: number, resourceType?: string) {
        if (typeof bytes === 'number' && bytes > 0) {
            this.bandwidthTracker.totalBytes += bytes
            const category = mapResourceTypeToCategory(resourceType || 'other')
            DataSaverManager.getInstance().recordTransferredResource(category, bytes)
        }
    }

    public trackBlockedRequest() {
        this.bandwidthTracker.blockedRequests += 1
        DataSaverManager.getInstance().recordBlockedRequest()
    }

    constructor(parentBot?: MicrosoftRewardsBot) {
        this._userData = {
            userName: '',
            geoLocale: 'US',
            langCode: 'en',
            initialPoints: 0,
            currentPoints: 0,
            gainedPoints: 0,
            timezoneOffset: new Date().getTimezoneOffset().toString()
        }
        this._cookies = { mobile: [], desktop: [] }
        this.browserFactory = new Browser(this)
        this.login = new Login(this)
        this.workers = new Workers(this)
        this.searchManager = new SearchManager(this)
        this.browser = {
            func: new BrowserFunc(this),
            utils: new BrowserUtils(this)
        }
        this.activities = new Activities(this)

        if (parentBot) {
            this.parentBot = parentBot
            this.config = parentBot.config
            this.logger = new Logger(this)
            this.utils = parentBot.utils
            this.manualQuestQueue = parentBot.manualQuestQueue
            this.localProxy = parentBot.localProxy
            this.localProxyPort = parentBot.localProxyPort
            this.networkRecoveryController = parentBot.networkRecoveryController
            this.manualNetworkRecoveryAdapter = parentBot.manualNetworkRecoveryAdapter
            this.adbNetworkRecoveryAdapter = parentBot.adbNetworkRecoveryAdapter
            this.networkRecoveryAvailable = parentBot.networkRecoveryAvailable
            this.networkRecoveryPreflightStatus = parentBot.networkRecoveryPreflightStatus
            this.dashboardServerActive = true
            this.dashboardServer = parentBot.dashboardServer
            this.runId = parentBot.runId
            this.activeWorkers = 1
            this.exitedWorkers = []
        } else {
            this.logger = new Logger(this)
            this.utils = new Utils()
            this.config = loadConfig()
            this.manualQuestQueue = new ManualQuestQueue({
                storagePath: `${process.cwd()}/browser/manual_quests.json`,
                logger: {
                    info: msg => this.logger.info(this.isMobile, 'QUEUE', msg),
                    warn: msg => this.logger.warn(this.isMobile, 'QUEUE', msg),
                    debug: msg => this.logger.debug(this.isMobile, 'QUEUE', msg)
                }
            })
            this.activeWorkers = this.config.clusters
            this.exitedWorkers = []
        }
    }

    public resetAccountState() {
        this.searchCooldownActive = false
        const isDualMode = this.config?.executionMode === 'dual'
        if (!isDualMode) {
            this.batchCircuitBreakerTriggered = false
        }
        QueryCore.resetSessionQueries()
        this.userData = {
            userName: '',
            geoLocale: 'US',
            langCode: 'en',
            initialPoints: 0,
            currentPoints: 0,
            gainedPoints: 0,
            timezoneOffset: new Date().getTimezoneOffset().toString()
        }
        this.bandwidthTracker = {
            totalBytes: 0,
            blockedRequests: 0
        }
        this.rewardsVersion = 'legacy'
        if (this.accountScope) {
            this.accountScope.clearDapiToken()
        }
        if (this.workers) {
            this.workers.pass1FoundCoins = false
            this.workers.hadBrowserActivitiesSincePass1 = false
        }
        this.requestToken = ''
        this.cookies = { mobile: [], desktop: [] }
        this.fingerprint = undefined as any
        this.activeAccount = null
        this.mainMobilePage = undefined as any
        this.mainDesktopPage = undefined as any
        this.workers?.completedOffersInSession?.clear()
    }

    public updateDashboardAccount(email: string, update: any) {
        void Database.getInstance().upsertAccountSummary({ email, ...update })
        if (cluster.isWorker && process.send) {
            process.send({ __dashboardUpdate: { email, update } })
        } else {
            updateDashboardAccount(email, update)
        }
    }

    public updateDashboardGlobal(update: any) {
        if (cluster.isWorker) {
            process.send?.({ __dashboardGlobal: update })
        } else {
            updateDashboardGlobal(update)
        }
    }

    public async requestNetworkRecovery(
        trigger: NetworkRecoveryTrigger = 'connectivity-failure'
    ): Promise<NetworkRecoveryResult> {
        if (trigger === 'connectivity-failure' && !this.config.networkRecovery?.connectivityFailureTrigger) {
            return {
                status: 'not-required',
                trigger,
                attempts: 0,
                durationMs: 0,
                finalStage: 'idle',
                airplaneModeKnowledge: 'confirmed-disabled',
                restorationAttempted: false,
                restorationSucceeded: false
            }
        }
        if (trigger === 'operator-request' && !this.config.networkRecovery?.operatorTrigger) {
            return {
                status: 'not-required',
                trigger,
                attempts: 0,
                durationMs: 0,
                finalStage: 'idle',
                airplaneModeKnowledge: 'confirmed-disabled',
                restorationAttempted: false,
                restorationSucceeded: false
            }
        }

        if (!this.networkRecoveryAvailable) {
            this.logger.warn(
                'main',
                'NETWORK-RECOVERY',
                `Recovery requested (${trigger}) but subsystem is unavailable (preflight status: ${this.networkRecoveryPreflightStatus ?? 'unknown'})`
            )
            return {
                status: 'failed',
                trigger,
                attempts: 0,
                durationMs: 0,
                finalStage: 'idle',
                failureReason: (this.networkRecoveryPreflightStatus as any) || 'adb-unavailable',
                airplaneModeKnowledge: 'confirmed-disabled',
                restorationAttempted: false,
                restorationSucceeded: false
            }
        }

        if (cluster.isWorker) {
            if (this.networkRecoveryIpcClient) {
                return this.networkRecoveryIpcClient.requestRecovery(trigger)
            }
            return {
                status: 'failed',
                trigger,
                attempts: 0,
                durationMs: 0,
                finalStage: 'idle',
                failureReason: 'unknown',
                airplaneModeKnowledge: 'confirmed-disabled',
                restorationAttempted: false,
                restorationSucceeded: false
            }
        }

        if (this.adbNetworkRecoveryAdapter && this.networkRecoveryPreflightStatus !== 'ready') {
            try {
                const freshPreflight = await this.adbNetworkRecoveryAdapter.checkPreflightStatus()
                this.networkRecoveryPreflightStatus = freshPreflight.status
                if (freshPreflight.status !== 'ready') {
                    return {
                        status: 'failed',
                        trigger,
                        attempts: 0,
                        durationMs: 0,
                        finalStage: 'idle',
                        failureReason: (freshPreflight.status as any) || 'adb-unavailable',
                        airplaneModeKnowledge: 'confirmed-disabled',
                        restorationAttempted: false,
                        restorationSucceeded: false
                    }
                }
            } catch {
                return {
                    status: 'failed',
                    trigger,
                    attempts: 0,
                    durationMs: 0,
                    finalStage: 'idle',
                    failureReason: 'adb-unavailable',
                    airplaneModeKnowledge: 'confirmed-disabled',
                    restorationAttempted: false,
                    restorationSucceeded: false
                }
            }
        }

        if (this.networkRecoveryController) {
            this.activeRecoveryAbortController = new AbortController()
            try {
                return await this.networkRecoveryController.recover(trigger, this.activeRecoveryAbortController.signal)
            } finally {
                this.activeRecoveryAbortController = null
            }
        } else {
            return {
                status: 'not-required',
                trigger,
                attempts: 0,
                durationMs: 0,
                finalStage: 'idle',
                airplaneModeKnowledge: 'confirmed-disabled',
                restorationAttempted: false,
                restorationSucceeded: false
            }
        }
    }

    public async requestOperatorRecovery(
        source: 'dashboard' | 'cli' = 'cli',
        requestId: string = crypto.randomUUID()
    ): Promise<NetworkRecoveryResult> {
        this.logger.info(
            'main',
            'NETWORK-RECOVERY',
            `requestReceived trigger=operator-request source=${source}`
        )
        if (this.accountScope) {
            const ttlMs = this.config.networkRecovery?.operatorRequestTtlMs ?? 1800000
            this.pendingOperatorRecovery = {
                source,
                requestId,
                receivedAt: Date.now(),
                ttlMs
            }
            this.logger.info(
                'main',
                'NETWORK-RECOVERY',
                `queued reason=account-scope-active ttlMs=${ttlMs}`
            )
            return {
                status: 'queued',
                trigger: 'operator-request',
                attempts: 0,
                durationMs: 0,
                finalStage: 'idle',
                airplaneModeKnowledge: 'confirmed-disabled',
                restorationAttempted: false,
                restorationSucceeded: false
            }
        }
        return this.requestNetworkRecovery('operator-request')
    }

    public setupCliOperatorListener(): void {
        if (!process.stdin.isTTY || this.cliStdinListener) {
            return
        }
        this.cliStdinListener = (chunk: Buffer | string) => {
            const line = chunk.toString().trim().toLowerCase()
            if (line === 'r' || line === 'recover') {
                this.logger.info('main', 'CLI-OPERATOR', 'Operator requested network recovery via CLI')
                void this.requestOperatorRecovery('cli')
            }
        }
        process.stdin.on('data', this.cliStdinListener)
    }

    public teardownCliOperatorListener(): void {
        if (this.cliStdinListener) {
            process.stdin.removeListener('data', this.cliStdinListener)
            this.cliStdinListener = null
        }
    }

    public async notifySuspectedConnectivityFailure(
        source: string,
        error?: any
    ): Promise<NetworkRecoveryResult> {
        if (!this.config.networkRecovery?.connectivityFailureTrigger) {
            return {
                status: 'not-required',
                trigger: 'connectivity-failure',
                attempts: 0,
                durationMs: 0,
                finalStage: 'idle',
                airplaneModeKnowledge: 'confirmed-disabled',
                restorationAttempted: false,
                restorationSucceeded: false
            }
        }

        if (this.connectivityFailureReporter) {
            const res = await this.connectivityFailureReporter.reportFailure(
                source as ConnectivityFailureSource,
                error
            )
            if (res) return res
            return {
                status: 'not-required',
                trigger: 'connectivity-failure',
                attempts: 0,
                durationMs: 0,
                finalStage: 'idle',
                airplaneModeKnowledge: 'confirmed-disabled',
                restorationAttempted: false,
                restorationSucceeded: false
            }
        }

        return this.requestNetworkRecovery('connectivity-failure')
    }

    public cancelActiveRecovery(): void {
        if (this.activeRecoveryAbortController && !this.activeRecoveryAbortController.signal.aborted) {
            this.activeRecoveryAbortController.abort(new Error('Process interrupted (SIGINT/SIGTERM)'))
        }
    }

    public logSessionBandwidthSummary(signal: string = 'SIGINT'): void {
        if (this.hasLoggedShutdownSummary) return
        this.hasLoggedShutdownSummary = true

        const report = DataSaverManager.getInstance().getSessionReport(
            undefined,
            this.sessionTotalAccounts > 0 ? this.sessionTotalAccounts : 1
        )
        const b = report.breakdownMb
        const durationMin = ((Date.now() - this.sessionStartTime) / 60000).toFixed(2)
        const activeEmail = this.sessionActiveAccountEmail || this.activeAccount?.email || 'None'

        const bannerLines = [
            `[MAIN] [SHUTDOWN] ================================================================================`,
            `[MAIN] [SHUTDOWN] 🛑 INTERUPSI TERDETEKSI (${signal} / Operator Stop)`,
            `[MAIN] [SHUTDOWN] 📊 Total Bandwidth Terpakai : ${report.totalMb} MB / Budget ${report.budgetMb} MB [Status: ${report.budgetResult.status}]`,
            `[MAIN] [SHUTDOWN] 📁 Rincian Data: doc=${b.document}MB | js=${b.script}MB | xhr=${b['xhr/fetch']}MB | img=${b.image}MB | other=${b.other}MB`,
            `[MAIN] [SHUTDOWN] ⏱️ Durasi Berjalan         : ${durationMin} menit | Akun Diproses: ${this.sessionCompletedAccounts}/${this.sessionTotalAccounts} (Aktif: ${activeEmail})`,
            `[MAIN] [SHUTDOWN] 🛡️ Request Diblokir        : ${report.blockedRequests} request hemat kuota`,
            `[MAIN] [SHUTDOWN] ================================================================================`
        ]

        for (const line of bannerLines) {
            console.log(line)
        }

        if (this.logger && typeof this.logger.warn === 'function') {
            for (const line of bannerLines) {
                const stripped = line.replace(/^\[MAIN\]\s+\[SHUTDOWN\]\s+/, '')
                this.logger.warn('main', 'SHUTDOWN', stripped)
            }
        }
    }

    public async requestShutdown(reason: string = 'manual', budgetMs: number = 10000): Promise<ShutdownResult> {
        if (typeof this.logSessionBandwidthSummary === 'function') {
            this.logSessionBandwidthSummary(reason === 'manual' ? 'C2-STOP' : reason)
        }
        if (this.shutdownPromise) {
            return this.shutdownPromise
        }

        this.stopRequested = true
        const startTime = Date.now()

        this.shutdownPromise = (async () => {
            this.logger.warn('main', 'SHUTDOWN', `Graceful shutdown initiated (reason: ${reason}, budget: ${budgetMs}ms)...`)
            let timer: NodeJS.Timeout | null = null

            const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
                timer = setTimeout(() => {
                    resolve({ timedOut: true })
                }, budgetMs)
            })

            const performCleanup = async (): Promise<void> => {
                // 1. Cancel active recovery & operator listeners
                try {
                    this.teardownCliOperatorListener()
                    this.cancelActiveRecovery()
                } catch {}

                // 2. Dispose active accountScope if present
                if (this.accountScope) {
                    const scope = this.accountScope
                    try {
                        await AccountDisposer.dispose(scope)
                    } catch (err) {
                        this.logger.error(
                            'main',
                            'SHUTDOWN',
                            `Error disposing active scope during shutdown: ${err instanceof Error ? err.message : String(err)}`
                        )
                    } finally {
                        if (this.accountScope === scope) {
                            this.accountScope = null
                            this.resetAccountState()
                        }
                    }
                }

                // 3. Stop dynamic outbound proxy if running
                if (this.localProxy) {
                    try {
                        await this.localProxy.stop(3000)
                    } catch (err) {
                        this.logger.error(
                            'main',
                            'SHUTDOWN',
                            `Error stopping local proxy during shutdown: ${err instanceof Error ? err.message : String(err)}`
                        )
                    } finally {
                        this.localProxy = null
                    }
                }

                // 4. Stop dashboard server if running
                if (this.dashboardServer) {
                    try {
                        await this.dashboardServer.stop()
                    } catch (err) {
                        this.logger.error(
                            'main',
                            'SHUTDOWN',
                            `Error stopping dashboard server: ${err instanceof Error ? err.message : String(err)}`
                        )
                    }
                }

                // 5. Flush pending writes and webhooks
                try {
                    await this.manualQuestQueue?.flushPendingWrites().catch(() => {})
                } catch {}
                try {
                    await flushAllWebhooks().catch(() => {})
                } catch {}
            }

            try {
                const outcome = await Promise.race([
                    performCleanup().then(() => ({ timedOut: false })),
                    timeoutPromise
                ])

                const durationMs = Date.now() - startTime
                if (outcome.timedOut) {
                    this.logger.warn('main', 'SHUTDOWN', `Graceful shutdown timed out after ${durationMs}ms`)
                    return { status: 'timed-out', durationMs }
                }

                this.logger.info('main', 'SHUTDOWN', `Graceful shutdown completed successfully in ${durationMs}ms`)
                return { status: 'completed', durationMs }
            } catch (err) {
                const durationMs = Date.now() - startTime
                const error = err instanceof Error ? err : new Error(String(err))
                this.logger.error('main', 'SHUTDOWN', `Graceful shutdown failed: ${error.message}`)
                return { status: 'failed', error, durationMs }
            } finally {
                if (timer) {
                    clearTimeout(timer)
                }
            }
        })()

        return this.shutdownPromise
    }

    get isMobile(): boolean {
        return getCurrentContext().isMobile
    }

    // 🛡️ MODUL IP CHECKER: AMAN JALUR DNS + MULTI-PROVIDER FALLBACK RESILIENSI TINGGI
    private async getCurrentIP(localProxyPort?: number): Promise<string> {
        try {
            if (this.localProxy) {
                await this.localProxy.ensureWifiConnected().catch(() => {})
            }
            await dns.lookup('bing.com').catch(() => {})
        } catch {
            // DNS connectivity warning, lanjutkan mencoba penyedia IP
        }

        const ipProviders = [
            'https://api.ipify.org',
            'https://icanhazip.com',
            'https://ident.me',
            'https://checkip.amazonaws.com'
        ]
        const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$|^([0-9a-fA-F]{1,4}:){1,7}[0-9a-fA-F]{1,4}$/

        const config: any = { timeout: 6000 }
        if (localProxyPort) {
            config.httpAgent = new HttpProxyAgent(`http://127.0.0.1:${localProxyPort}`)
            config.httpsAgent = new HttpsProxyAgent(`http://127.0.0.1:${localProxyPort}`)
        }

        for (const provider of ipProviders) {
            try {
                const res = await axios.get(provider, config)
                const ip = typeof res.data === 'string' ? res.data.trim() : String(res.data).trim()
                if (ip && ipRegex.test(ip)) {
                    return ip
                }
            } catch {
                // Fallback otomatis ke provider berikutnya jika gagal atau timeout
            }
        }

        return 'UNKNOWN_IP'
    }

    async initialize(): Promise<void> {
        const activeConfigFile = getActiveConfigFile()
        const channel = this.config.browserChannel || this.config.channel || 'default'
        this.logger.info(
            'main',
            'CONFIG-INIT',
            `Loaded configuration from ${activeConfigFile} | headless=${this.config.headless} | channel=${channel}`
        )

        this.accounts = loadAccounts()

        const enforcementMode: OwnershipEnforcementMode = this.config.identityPolicy?.enforcementMode || 'report-only'
        if (!this.config.identityPolicy) {
            this.logger.warn(
                'main',
                'OWNERSHIP-POLICY',
                '⚠️ No identityPolicy configured in config.json. Running in "report-only" compatibility mode.',
                'yellow'
            )
        }

        const policySummary = validateOwnershipPolicy(this.accounts, enforcementMode)
        const sanitizedDto = createSanitizedDiagnosticDto(policySummary, enforcementMode, this.sessionSecret)
        this.logger.info(
            'main',
            'OWNERSHIP-POLICY',
            `Ownership policy initialized | mode=${enforcementMode} | total=${sanitizedDto.totalAccounts} | valid=${sanitizedDto.validAccounts} | blocked=${sanitizedDto.blockedAccounts}`
        )

        if (enforcementMode === 'block-invalid' && policySummary.blockedAccounts > 0) {
            throw new Error(
                `[FATAL-OWNERSHIP] Policy enforcement failed in 'block-invalid' mode: ${policySummary.blockedAccounts} account(s) are invalid or violate participant/household limits.`
            )
        }

        if (enforcementMode === 'report-only' && policySummary.blockedAccounts > 0) {
            this.logger.warn(
                'main',
                'OWNERSHIP-POLICY',
                `[MIGRATION-REPORT] ${policySummary.blockedAccounts} account(s) have missing or invalid identity metadata. Review accounts.json.`,
                'yellow'
            )
        }

        validateUniqueAccountIdentities(this.accounts)
        await this.manualQuestQueue.load()

        // Sync manual quest queue: bersihkan akun non-aktif dan record basi
        const activeIdentities = this.accounts.map(a => resolveAccountIdentity(a))
        const activeIds = activeIdentities.map(i => i.accountId)
        const prunedInactive = await this.manualQuestQueue.pruneInactiveAccounts(activeIds)
        const prunedStale = await this.manualQuestQueue.pruneStaleRecords(14)
        if (prunedInactive > 0 || prunedStale > 0) {
            this.logger.info(
                'main',
                'QUEUE-SYNC',
                `[QUEUE-SYNC] Antrean manual quest disinkronkan: ${prunedInactive} akun non-aktif, ${prunedStale} quest basi (>14 hari) dibersihkan.`,
                'cyan'
            )
        }

        await Database.getInstance().initialize()

        // 1. Runtime Build Provenance
        const buildMeta = resolveBuildMetadata()
        this.logger.info(
            'main',
            'RUNTIME-BUILD',
            `commit=${buildMeta.commit} builtAt=${buildMeta.builtAt} entrypoint=${buildMeta.entrypoint}`
        )

        // 2. ADB IP Rotation configuration status
        const adbRotationEnabled = Boolean(this.config.useAdbIpRotation)
        const legacyConfigDetected = Boolean(this.config.useAdbIpRotation)
        if (adbRotationEnabled) {
            this.logger.info(
                'main',
                'ADB-ROTATION',
                `ADB IP Rotation enabled=true (auto-rotate per batch every 2 accounts via airplane mode)`
            )
        }

        // 3. Network Recovery Configuration & Preflight
        const recoveryConfig = this.config.networkRecovery
        const isPrimaryProcess = cluster.isPrimary || !cluster.isWorker

        if (!recoveryConfig || !recoveryConfig.enabled || recoveryConfig.mode === 'disabled') {
            const disabledReason = !recoveryConfig
                ? 'not-configured'
                : !recoveryConfig.enabled
                  ? 'disabled-in-config'
                  : 'mode-disabled'

            if (isPrimaryProcess) {
                this.logger.info(
                    'main',
                    'NETWORK-RECOVERY-CONFIG',
                    `enabled=false reason=${disabledReason}`
                )
                this.logger.warn(
                    'main',
                    'NETWORK-RECOVERY',
                    '⚠️ PERINGATAN: networkRecovery.enabled bernilai false di config.json! Risiko deteksi mass-ban akibat IP statis tanpa rotasi/recovery jaringan.'
                )
            }
        } else {
            const policy: NetworkRecoveryPolicy = {
                enabled: recoveryConfig.enabled,
                mode: recoveryConfig.mode,
                trigger: recoveryConfig.connectivityFailureTrigger ? 'connectivity-failure' : 'operator-request',
                operatorTrigger: recoveryConfig.operatorTrigger ?? true,
                connectivityFailureTrigger: recoveryConfig.connectivityFailureTrigger ?? false,
                adbSerial: recoveryConfig.adbSerial,
                maxAttempts: recoveryConfig.maxAttempts ?? 1,
                preflightTimeoutMs: recoveryConfig.preflightTimeoutMs ?? 5000,
                commandTimeoutMs: recoveryConfig.commandTimeoutMs ?? 8000,
                disconnectTimeoutMs: recoveryConfig.disconnectTimeoutMs ?? 10000,
                reconnectTimeoutMs: recoveryConfig.reconnectTimeoutMs ?? 30000,
                verificationIntervalMs: recoveryConfig.verificationIntervalMs ?? 2000,
                totalBudgetMs: recoveryConfig.totalBudgetMs ?? 60000,
                recoveryCooldownMs: recoveryConfig.recoveryCooldownMs ?? 120000,
                operatorRequestTtlMs: recoveryConfig.operatorRequestTtlMs ?? 1800000,
                reassertUsbTethering: recoveryConfig.reassertUsbTethering ?? false,
                operatorTimeoutMs: recoveryConfig.operatorRequestTtlMs ?? 1800000
            }

            const adbSerialConfigured = Boolean(policy.adbSerial && policy.adbSerial.trim().length > 0)

            if (isPrimaryProcess) {
                this.logger.info(
                    'main',
                    'NETWORK-RECOVERY-CONFIG',
                    `enabled=${policy.enabled} mode=${policy.mode} operatorTrigger=${policy.operatorTrigger} connectivityFailureTrigger=${policy.connectivityFailureTrigger} adbSerialConfigured=${adbSerialConfigured} primaryOwner=${isPrimaryProcess} legacyConfigDetected=${legacyConfigDetected}`
                )
            }

            if (isPrimaryProcess) {
                const probe = new DefaultNetworkConnectivityProbe()
                let adapter
                if (policy.mode === 'adb') {
                    const adbAdapter = new AdbNetworkRecoveryAdapter({ policy })
                    this.adbNetworkRecoveryAdapter = adbAdapter
                    adapter = adbAdapter

                    // Phase 3: Safe startup ADB preflight (non-mutating, zero airplane-mode toggling, bounded)
                    this.logger.info('main', 'ADB-PREFLIGHT', `start timeoutMs=${policy.preflightTimeoutMs}`)
                    try {
                        const preflightResult = await adbAdapter.checkPreflightStatus()
                        this.networkRecoveryPreflightStatus = preflightResult.status
                        this.logger.info(
                            'main',
                            'ADB-PREFLIGHT',
                            `end status=${preflightResult.status} deviceCount=${preflightResult.deviceCount} serialConfigured=${preflightResult.serialConfigured}`
                        )
                        if (preflightResult.status !== 'ready') {
                            this.logger.warn(
                                'main',
                                'NET-RECOVERY',
                                `ADB preflight did not pass (status=${preflightResult.status}). Can be retried on operator request.`
                            )
                        }
                    } catch (err: any) {
                        this.networkRecoveryPreflightStatus = 'adb-unavailable'
                        this.logger.warn(
                            'main',
                            'ADB-PREFLIGHT',
                            `end status=adb-unavailable deviceCount=0 serialConfigured=${adbSerialConfigured}`
                        )
                    }
                } else {
                    adapter = new ManualNetworkRecoveryAdapter({
                        policy,
                        logger: {
                            info: msg => this.logger.info(false, 'NET-RECOVERY', msg),
                            warn: msg => this.logger.warn(false, 'NET-RECOVERY', msg),
                            error: msg => this.logger.error(false, 'NET-RECOVERY', msg)
                        }
                    })
                    this.manualNetworkRecoveryAdapter = adapter
                    registerNetworkRecoveryResolver((requestId, action) => {
                        return this.manualNetworkRecoveryAdapter?.resolveManual(requestId, action) ?? false
                    })
                }

                this.networkRecoveryController = new NetworkRecoveryController({
                    policy,
                    adapter,
                    probe,
                    logger: {
                        info: msg => this.logger.info(false, 'NET-RECOVERY', msg),
                        warn: msg => this.logger.warn(false, 'NET-RECOVERY', msg),
                        error: msg => this.logger.error(false, 'NET-RECOVERY', msg)
                    }
                })

                this.logger.info(
                    'main',
                    'NET-RECOVERY',
                    `Network recovery subsystem initialized | mode=${policy.mode} | trigger=${policy.trigger} | maxAttempts=${policy.maxAttempts}`,
                    'green'
                )
            } else {
                this.networkRecoveryIpcClient = new NetworkRecoveryIpcClient(
                    policy.totalBudgetMs + 5000
                )
                this.networkRecoveryAvailable = policy.enabled && policy.mode !== 'disabled'
            }

            const reporterProbe = new DefaultNetworkConnectivityProbe()
            this.connectivityFailureReporter = new ConnectivityFailureReporter({
                cooldownMs: policy.recoveryCooldownMs,
                probe: reporterProbe,
                onEscalate: async () => {
                    return this.requestNetworkRecovery('connectivity-failure')
                },
                logger: {
                    info: msg => this.logger.info(false, 'NET-RECOVERY', msg),
                    warn: msg => this.logger.warn(false, 'NET-RECOVERY', msg),
                    error: msg => this.logger.error(false, 'NET-RECOVERY', msg)
                }
            })
        }

        this.updateDashboardGlobal({
            loadedAccounts: this.accounts.map(a => a.email)
        })

        if ((cluster.isPrimary || !cluster.isWorker) && this.config.networkRecovery?.enabled && this.config.networkRecovery?.operatorTrigger) {
            this.setupCliOperatorListener()
        }
    }

    async run(): Promise<void> {
        const totalAccounts = this.accounts.length
        const runStartTime = Date.now()

        // Start Dashboard Server on primary process if enabled
        if (this.config.useLocalDashboard && (cluster.isPrimary || !cluster.isWorker) && !this.dashboardServerActive) {
            this.dashboardServerActive = true
            const dashboardServer = new DashboardServer(4000)
            this.dashboardServer = dashboardServer
            await dashboardServer.start().catch(err => {
                this.logger.error('main', 'DASHBOARD-ERROR', `Failed to start dashboard: ${err.message}`)
            })
            this.logger.info('main', 'DASHBOARD', `Local dashboard server started at http://localhost:4000`, 'green')

            registerManualQuestProvider(() => {
                const activeAccountIds = this.accounts.map(a => resolveAccountIdentity(a).accountId)
                return this.manualQuestQueue.getSanitizedSnapshot(activeAccountIds)
            })

            registerManualQuestActionHandler(async (action, offerId, displayAccount) => {
                if (action === 'clear-all') {
                    await this.manualQuestQueue.clearAll()
                    this.logger.info('main', 'MANUAL-QUEST', 'Semua antrean manual quest telah dibersihkan.')
                    return true
                }
                if (action === 'sync') {
                    const activeAccountIds = this.accounts.map(a => resolveAccountIdentity(a).accountId)
                    const p1 = await this.manualQuestQueue.pruneInactiveAccounts(activeAccountIds)
                    const p2 = await this.manualQuestQueue.pruneStaleRecords(14)
                    const p3 = await this.manualQuestQueue.pruneExpired(1)
                    this.logger.info('main', 'MANUAL-QUEST', `Manual quest synced: ${p1} inactive accounts pruned, ${p2 + p3} stale/completed records pruned.`)
                    return p1 + p2 + p3
                }
                if (action === 'mark-complete' && offerId) {
                    await this.manualQuestQueue.updateStateByOfferId(offerId, 'verified-complete', displayAccount)
                    this.logger.info('main', 'MANUAL-QUEST', `Quest ${offerId} (${displayAccount || 'unknown'}) ditandai selesai secara manual.`, 'green')
                    return true
                }
                if (action === 'dismiss' && offerId) {
                    await this.manualQuestQueue.deleteRecord(displayAccount || '', offerId)
                    this.logger.info('main', 'MANUAL-QUEST', `Quest ${offerId} (${displayAccount || 'unknown'}) dihapus dari antrean manual.`, 'yellow')
                    return true
                }
                return false
            })

            // Update initial dashboard state with all loaded accounts
            for (const acc of this.accounts) {
                this.updateDashboardAccount(acc.email, {
                    email: acc.email,
                    status: 'Ready',
                    initialPoints: 0,
                    collectedPoints: 0,
                    desktopProgress: '0/0',
                    mobileProgress: '0/0'
                })
            }

            this.updateDashboardGlobal({
                useDynamicWifiProxy: !!this.config.useDynamicWifiProxy,
                useAdbIpRotation: !!this.config.useAdbIpRotation,
                useGhostCursor: this.config.useGhostCursor ?? true,
                executionMode: this.config.executionMode === 'sequential' ? 'sequential' : 'dual',
                staggeredOffsetSeconds:
                    typeof this.config.staggeredOffsetSeconds === 'number'
                        ? this.config.staggeredOffsetSeconds
                        : 45,
                currentBatch: null,
                loadedAccounts: this.accounts.map(a => a.email),
                isRunning: false,
                startTime: 0
            })

            // Register control callbacks
            registerControlCallback(async cmd => {
                if (cmd.action === 'start') {
                    if (this.isRunning) {
                        this.logger.warn('main', 'C2-CONTROL', 'Bot is already running!')
                        return
                    }
                    this.logger.info('main', 'C2-CONTROL', 'Starting execution for all accounts...')
                    this.isRunning = true
                    this.stopRequested = false
                    this.updateDashboardGlobal({ isRunning: true, startTime: Date.now() })

                    try {
                        await this.run()
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err)
                        this.logger.error('main', 'C2-CONTROL-ERROR', `Execution failed: ${errMsg}`)
                    } finally {
                        this.isRunning = false
                        this.updateDashboardGlobal({ isRunning: false, startTime: 0 })
                    }
                } else if (cmd.action === 'stop') {
                    if (!this.isRunning) {
                        this.logger.warn('main', 'C2-CONTROL', 'Bot is not running!')
                        return
                    }
                    this.logger.info('main', 'C2-CONTROL', 'Requesting bot execution to stop gracefully...')
                    this.logSessionBandwidthSummary('C2-STOP')
                    this.stopRequested = true
                } else if (cmd.action === 'set-execution-mode') {
                    const mode = (cmd as any).mode === 'sequential' ? 'sequential' : 'dual'
                    this.config.executionMode = mode
                    this.updateDashboardGlobal({ executionMode: mode })
                    this.logger.info('main', 'C2-CONTROL', `Execution mode switched to: ${mode}`)
                } else if (cmd.action === 'start-single') {
                    if (this.isRunning) {
                        this.logger.warn('main', 'C2-CONTROL', 'Bot is already running!')
                        return
                    }
                    if (!cmd.email) {
                        this.logger.error('main', 'C2-CONTROL', 'No email provided for single account run!')
                        return
                    }
                    const targetAcc = this.accounts.find(a => a.email.toLowerCase() === cmd.email!.toLowerCase())
                    if (!targetAcc) {
                        this.logger.error('main', 'C2-CONTROL', `Account with email ${cmd.email} not found!`)
                        return
                    }

                    this.logger.info(
                        'main',
                        'C2-CONTROL',
                        `Starting execution for single account: ${targetAcc.email}...`
                    )
                    this.isRunning = true
                    this.stopRequested = false
                    this.updateDashboardGlobal({ isRunning: true, startTime: Date.now() })

                    try {
                        await this.runTasks([targetAcc], Date.now())
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err)
                        this.logger.error(
                            'main',
                            'C2-CONTROL-ERROR',
                            `Execution failed for ${targetAcc.email}: ${errMsg}`
                        )
                    } finally {
                        this.isRunning = false
                        this.updateDashboardGlobal({ isRunning: false, startTime: 0 })
                    }
                } else if (cmd.action === 'open-manual-browser') {
                    if (this.activeManualInspector) {
                        this.logger.warn('main', 'MANUAL-BROWSER', `[MANUAL-BROWSER] Browser inspeksi sudah aktif untuk ${this.activeManualInspector.email}. Tutup terlebih dahulu.`)
                        return
                    }
                    if (!cmd.email) {
                        this.logger.error('main', 'MANUAL-BROWSER', '[MANUAL-BROWSER] Parameter email wajib disertakan!')
                        return
                    }
                    const targetAcc = this.accounts.find(a => a.email.toLowerCase() === cmd.email!.toLowerCase())
                    if (!targetAcc) {
                        this.logger.error('main', 'MANUAL-BROWSER', `[MANUAL-BROWSER] Akun ${cmd.email} tidak ditemukan dalam konfigurasi!`)
                        return
                    }
                    if (this.isRunning && this.activeAccount?.email?.toLowerCase() === targetAcc.email.toLowerCase()) {
                        this.logger.warn('main', 'MANUAL-BROWSER', `[MANUAL-BROWSER] Akun ${targetAcc.email} sedang aktif dijalankan bot. Tunggu hingga akun selesai.`)
                        return
                    }

                    this.logger.info('main', 'MANUAL-BROWSER', `[MANUAL-BROWSER] Meluncurkan browser headful inspeksi untuk: ${targetAcc.email}...`, 'cyan')

                    let scope: AccountScope | null = null
                    try {
                        scope = await AccountScope.create({
                            account: targetAcc,
                            bot: this,
                            runId: `manual_${Date.now()}`
                        })

                        const loadResult = await AccountSessionStore.loadSession(scope, 'desktop', { legacyEmail: targetAcc.email })
                        let storageState: any = undefined
                        if (loadResult.status === 'loaded' && loadResult.state) {
                            storageState = loadResult.state
                            this.logger.info('main', 'MANUAL-BROWSER', `[MANUAL-BROWSER] Sesi berhasil dimuat (${loadResult.source}) untuk ${targetAcc.email}`)
                        }

                        if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
                            if (fs.existsSync('/tmp/.X11-unix/X0')) {
                                process.env.DISPLAY = ':0'
                            }
                        }

                        const edgeChannel = this.config.browserChannel || this.config.channel || 'msedge'
                        const browser = await chromium.launch({
                            headless: false,
                            channel: edgeChannel,
                            args: [
                                '--no-sandbox',
                                '--disable-setuid-sandbox',
                                '--disable-blink-features=AutomationControlled'
                            ]
                        })

                        const context = await browser.newContext({
                            storageState,
                            viewport: { width: 1280, height: 800 }
                        })

                        scope.setContext('desktop', context)

                        const page = await context.newPage()
                        this.activeManualInspector = { email: targetAcc.email, browser, context, page }

                        browser.on('disconnected', async () => {
                            try {
                                if (scope) {
                                    const saveRes = await AccountSessionStore.saveContextSession(context, scope, 'desktop')
                                    if (saveRes.status === 'saved') {
                                        this.logger.info('main', 'MANUAL-BROWSER', `[MANUAL-BROWSER] Sesi terbaru berhasil disimpan via AccountSessionStore (${saveRes.path})`, 'green')
                                    }
                                }
                            } catch (syncErr) {
                                this.logger.error('main', 'MANUAL-BROWSER', `[MANUAL-BROWSER] Gagal menyimpan sesi: ${syncErr}`)
                            } finally {
                                if (scope) {
                                    await AccountDisposer.dispose(scope).catch(() => {})
                                }
                                this.activeManualInspector = null
                            }
                        })

                        await page.goto('https://rewards.bing.com/earn', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err)
                        this.logger.error('main', 'MANUAL-BROWSER', `[MANUAL-BROWSER] Gagal membuka browser manual: ${errMsg}`)
                        if (scope) {
                            await AccountDisposer.dispose(scope).catch(() => {})
                        }
                        this.activeManualInspector = null
                    }
                } else if (cmd.action === 'close-manual-browser') {
                    if (this.activeManualInspector) {
                        this.logger.info('main', 'MANUAL-BROWSER', `[MANUAL-BROWSER] Menutup browser inspeksi aktif (${this.activeManualInspector.email})...`)
                        await this.activeManualInspector.browser.close().catch(() => {})
                        this.activeManualInspector = null
                    } else {
                        this.logger.info('main', 'MANUAL-BROWSER', '[MANUAL-BROWSER] Tidak ada browser inspeksi yang sedang aktif.')
                    }
                }
            })

            // Register config callback
            registerConfigCallback(async () => {
                this.config = loadConfig(true)
                this.updateDashboardGlobal({
                    useDynamicWifiProxy: !!this.config.useDynamicWifiProxy,
                    useAdbIpRotation: !!this.config.useAdbIpRotation,
                    useGhostCursor: this.config.useGhostCursor ?? true
                })
                this.logger.info('main', 'C2-CONFIG', 'Configuration reloaded and applied successfully.')
            })

            // Register IP confirm callback for dashboard button
            registerIpConfirmCallback(() => {
                if (manualIpConfirmResolver) {
                    const res = manualIpConfirmResolver
                    manualIpConfirmResolver = null
                    res()
                }
                const reqId = this.manualNetworkRecoveryAdapter?.getCurrentRequestId()
                if (reqId) {
                    this.manualNetworkRecoveryAdapter?.resolveManual(reqId, 'resume')
                }
            })

            // Register operator recovery callback for dashboard
            registerOperatorRecoveryHandler(async (requestId: string) => {
                await this.requestOperatorRecovery('dashboard', requestId)
            })

            // Register exit cleanup
            const stopDashboard = async () => {
                await dashboardServer.stop()
            }
            process.on('SIGINT', stopDashboard)
            process.on('SIGTERM', stopDashboard)
            process.on('exit', stopDashboard)

            this.logger.info(
                'main',
                'C2-STANDBY',
                'Command & Control Active. Waiting for commands via Web UI...',
                'cyan'
            )
            return
        }

        this.logger.info(
            'main',
            'RUN-START',
            `Starting Microsoft Rewards Script | v${pkg.version} | Accounts: ${totalAccounts} | Clusters: ${this.config.clusters}`
        )

        if (this.config.clusters > 1) {
            if (cluster.isPrimary) {
                await this.runMaster(runStartTime)
            } else {
                this.runWorker(runStartTime)
            }
        } else {
            await this.runTasks(this.accounts, runStartTime)
        }
    }

    private async runMaster(runStartTime: number): Promise<void> {
        void this.logger.info('main', 'CLUSTER-PRIMARY', `Primary process started | PID: ${process.pid}`)

        const rawChunks = this.utils.chunkArray(this.accounts, this.config.clusters)
        const accountChunks = rawChunks.filter(c => c && c.length > 0)
        this.activeWorkers = accountChunks.length

        const allAccountStats: AccountStats[] = []
        let hadWorkerFailure = false

        for (const chunk of accountChunks) {
            const worker = cluster.fork()
            worker.send?.({ chunk, runStartTime })

            worker.on(
                'message',
                async (msg: {
                    __ipcLog?: IpcLog
                    __stats?: AccountStats[]
                    __dashboardUpdate?: { email: string; update: any }
                    __dashboardGlobal?: any
                    __networkRecoveryRequest?: { correlationId: string; trigger: NetworkRecoveryTrigger }
                }) => {
                    if (msg.__stats) {
                        allAccountStats.push(...msg.__stats)
                    }
                    if (msg.__dashboardUpdate) {
                        updateDashboardAccount(msg.__dashboardUpdate.email, msg.__dashboardUpdate.update)
                    }
                    if (msg.__dashboardGlobal) {
                        updateDashboardGlobal(msg.__dashboardGlobal)
                    }
                    if (msg.__networkRecoveryRequest) {
                        const { correlationId, trigger } = msg.__networkRecoveryRequest
                        let result: NetworkRecoveryResult
                        if (this.networkRecoveryController) {
                            result = await this.networkRecoveryController.recover(trigger)
                        } else {
                            result = {
                                status: 'not-required',
                                trigger,
                                attempts: 0,
                                durationMs: 0,
                                finalStage: 'idle',
                                airplaneModeKnowledge: 'confirmed-disabled',
                                restorationAttempted: false,
                                restorationSucceeded: false
                            }
                        }
                        worker.send?.({
                            __networkRecoveryResponse: { correlationId, result }
                        })
                    }

                    const log = msg.__ipcLog
                    if (log && typeof log.content === 'string') {
                        const { webhook } = this.config
                        const { content, level } = log

                        if (webhook.discord?.enabled && webhook.discord.url) {
                            sendDiscord(webhook.discord.url, content, level)
                        }
                        if (webhook.ntfy?.enabled && webhook.ntfy.url) {
                            sendNtfy(webhook.ntfy, content, level)
                        }
                    }
                }
            )

            if (accountChunks.indexOf(chunk) !== accountChunks.length - 1) {
                await this.utils.wait(5000)
            }
        }

        const onWorkerExit = async (worker: Worker, code?: number, signal?: string): Promise<void> => {
            const { pid } = worker.process
            if (!pid || this.exitedWorkers.includes(pid)) return

            this.exitedWorkers.push(pid)
            this.activeWorkers -= 1

            if ((code ?? 0) !== 0 || Boolean(signal)) hadWorkerFailure = true

            this.logger.warn(
                'main',
                'CLUSTER-WORKER-EXIT',
                `Worker ${pid} exit | Code: ${code ?? 'n/a'} | Signal: ${signal ?? 'n/a'} | Active workers: ${this.activeWorkers}`
            )

            if (this.activeWorkers <= 0) {
                const totalCollected = allAccountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
                const totalInitial = allAccountStats.reduce((sum, s) => sum + s.initialPoints, 0)
                const totalFinal = allAccountStats.reduce((sum, s) => sum + s.finalPoints, 0)
                const totalDuration = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

                this.logger.info(
                    'main',
                    'RUN-END',
                    `Completed all accounts | Total points collected: +${totalCollected} | Old total: ${totalInitial} → New total: ${totalFinal} | Total runtime: ${totalDuration}min`,
                    'green'
                )

                await flushAllWebhooks()
                process.exit(hadWorkerFailure ? 1 : 0)
            }
        }

        cluster.on('exit', (worker, code, signal) => {
            void onWorkerExit(worker, code ?? undefined, signal ?? undefined)
        })

        cluster.on('disconnect', worker => {
            const pid = worker.process?.pid
            this.logger.warn('main', 'CLUSTER-WORKER-DISCONNECT', `Worker ${pid ?? '?'} disconnected`)
        })
    }

    private runWorker(runStartTimeFromMaster?: number): void {
        void this.logger.info('main', 'CLUSTER-WORKER-START', `Worker spawned | PID: ${process.pid}`)

        process.on('message', async ({ chunk, runStartTime }: { chunk: Account[]; runStartTime: number }) => {
            try {
                const stats = await this.runTasks(chunk, runStartTime ?? runStartTimeFromMaster ?? Date.now())
                if (process.send) process.send({ __stats: stats })
                await flushAllWebhooks()
                process.exit(0)
            } catch (error) {
                this.logger.error(
                    'main',
                    'CLUSTER-WORKER-ERROR',
                    `Worker task crash: ${error instanceof Error ? error.message : String(error)}`
                )
                await flushAllWebhooks()
                process.exit(1)
            }
        })
    }

    private async runTasks(accounts: Account[], runStartTime: number): Promise<AccountStats[]> {
        this.runId = `run_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
        const accountStats: AccountStats[] = []

        this.sessionStartTime = runStartTime || Date.now()
        this.sessionTotalAccounts = accounts.length
        this.sessionCompletedAccounts = 0
        this.sessionActiveAccountEmail = ''
        this.hasLoggedShutdownSummary = false
        DataSaverManager.getInstance().resetSessionStats()

        // Start dynamic outbound local proxy if enabled
        if (this.config.useDynamicWifiProxy) {
            this.localProxy = new DynamicOutboundProxy(0, this.logger)
            await this.localProxy.start()
            this.localProxyPort = this.localProxy.getPort()
            this.logger.info('main', 'PROXY', `Started dynamic outbound local proxy on port ${this.localProxyPort}`)
        } else {
            this.localProxyPort = 0
            this.logger.info('main', 'PROXY', 'Dynamic outbound proxy is disabled. Using default network routing.')
        }

        this.updateDashboardGlobal({
            useDynamicWifiProxy: !!this.config.useDynamicWifiProxy,
            proxyMode: !!this.localProxyPort
        })

        let currentIpAddress = await this.getCurrentIP(this.localProxyPort || undefined)
        this.logger.info('main', 'NETWORK', `Current Active IP: [ ${currentIpAddress} ]`)
        this.updateDashboardGlobal({ currentIP: currentIpAddress })

        // Determine execution mode & staggered offset
        const execMode = this.config.executionMode === 'dual' ? 'dual' : 'sequential'
        const staggeredOffsetSec =
            typeof this.config.staggeredOffsetSeconds === 'number'
                ? this.config.staggeredOffsetSeconds
                : 45

        this.updateDashboardGlobal({
            useDynamicWifiProxy: !!this.config.useDynamicWifiProxy,
            proxyMode: !!this.localProxyPort,
            executionMode: execMode,
            staggeredOffsetSeconds: staggeredOffsetSec
        })

        // Pembagian antrean akun per-batch (chunk size = 2)
        const batches: Account[][] = chunkArrayBySize(accounts, 2)

        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            if (this.stopRequested) {
                this.logger.warn('main', 'C2-CONTROL', 'Execution stopped/paused by user request.')
                break
            }

            // Reset Circuit Breaker for the new batch
            this.batchCircuitBreakerTriggered = false

            const batch = batches[batchIndex]
            if (!batch || batch.length === 0) continue

            this.logger.info(
                'main',
                'BATCH-DISPATCHER',
                `Starting Batch [${batchIndex + 1}/${batches.length}] with ${batch.length} account(s): ${batch.map(a => a.email).join(', ')} (Mode: ${execMode})`
            )

            this.updateDashboardGlobal({
                currentBatch: {
                    batchIndex,
                    totalBatches: batches.length,
                    activeAccounts: batch.map(a => a.email),
                    staggerCountdown: 0
                }
            })

            let processedInBatchCount = 0

            if (execMode === 'sequential') {
                for (const account of batch) {
                    if (this.stopRequested) break
                    const isDualMode = this.config?.executionMode === 'dual'
                    if (isDualMode && this.isCircuitBreakerTriggered()) break

                    this.searchCooldownActive = false
                    this.batchCircuitBreakerTriggered = false
                    this.activeAccount = account
                    this.userData.userName = this.utils.getEmailUsername(account.email)

                    // Batas waktu adaptif dinamis (12 - 25 menit) pada mode sequential
                    const dynamicDeadlineMs = calculateDynamicDeadline(100, 2 * 60 * 1000)
                    let deadlineTimeout: NodeJS.Timeout | undefined
                    const deadlinePromise = new Promise<{ kind: 'timeout' }>(resolve => {
                        deadlineTimeout = setTimeout(() => resolve({ kind: 'timeout' }), dynamicDeadlineMs)
                    })

                    try {
                        const worker = this.runAccountWorkflow(account)
                        const workerPromise = worker.then(val => ({ kind: 'completed' as const, val }))

                        const raceResult = await Promise.race([workerPromise, deadlinePromise])
                        if (deadlineTimeout) clearTimeout(deadlineTimeout)

                        if (raceResult.kind === 'timeout') {
                            this.logger.error(
                                'main',
                                'ACCOUNT-DEADLINE',
                                `[ACCOUNT-DEADLINE-EXCEEDED] Eksekusi akun ${account.email} di mode sequential melebihi batas waktu adaptif ${(dynamicDeadlineMs / 60000).toFixed(0)} menit! Melakukan pembatalan paksa dan membersihkan resource browser.`
                            )
                            try {
                                this.accountScope?.abortController.abort()
                                await this.cleanupBrowserResources()
                            } catch {}

                            // Bounded Join: tunggu hingga worker keluar maksimal 10 detik
                            await Promise.race([
                                Promise.allSettled([worker]),
                                new Promise(resolve => setTimeout(resolve, 10000))
                            ])
                        } else {
                            processedInBatchCount++
                            if (raceResult.val) {
                                accountStats.push(raceResult.val)
                            }
                        }
                    } finally {
                        if (deadlineTimeout) clearTimeout(deadlineTimeout)
                        QueryCore.resetSessionQueries()
                        this.activeAccount = null
                        this.userData.userName = ''
                    }
                }
            } else {
                // Dual-Worker Staggered Dispatcher
                const workerPromises: Promise<AccountStats | null>[] = []

                // Worker 1: t = 0s
                const acc1 = batch[0]
                if (acc1) {
                    const worker1 = this.runAccountWorkflow(acc1)
                    workerPromises.push(worker1)
                }

                // Worker 2: after staggered offset delay (default 45s)
                const acc2 = batch[1]
                if (acc2 && acc1) {
                    this.logger.info(
                        'main',
                        'STAGGERED-DISPATCHER',
                        `Worker 1 running for ${acc1.email}. Waiting staggered offset (${staggeredOffsetSec}s) before launching Worker 2...`
                    )

                    for (let sec = staggeredOffsetSec; sec > 0; sec--) {
                        if (this.stopRequested || this.isCircuitBreakerTriggered()) break
                        this.updateDashboardGlobal({
                            currentBatch: {
                                batchIndex,
                                totalBatches: batches.length,
                                activeAccounts: batch.map(a => a.email),
                                staggerCountdown: sec
                            }
                        })
                        await this.utils.wait(1000)
                    }

                    if (!this.stopRequested && !this.isCircuitBreakerTriggered()) {
                        this.updateDashboardGlobal({
                            currentBatch: {
                                batchIndex,
                                totalBatches: batches.length,
                                activeAccounts: batch.map(a => a.email),
                                staggerCountdown: 0
                            }
                        })
                        this.logger.info(
                            'main',
                            'STAGGERED-DISPATCHER',
                            `Staggered offset complete. Launching Worker 2 for ${acc2.email}...`
                        )
                        const worker2 = this.runAccountWorkflow(acc2)
                        workerPromises.push(worker2)
                    } else if (this.isCircuitBreakerTriggered()) {
                        this.logger.warn(
                            'main',
                            'CIRCUIT-BREAKER',
                            `[CIRCUIT-BREAKER] Aborting launch of Worker 2 for ${acc2.email} due to active circuit breaker on Worker 1.`
                        )
                    }
                }

                // Barrier Synchronization with Dynamic Adaptive Deadline
                const dynamicDeadlineMs = calculateDynamicDeadline(100, 2 * 60 * 1000)
                let deadlineTimeout: NodeJS.Timeout | undefined
                const deadlinePromise = new Promise<{ kind: 'timeout' }>(resolve => {
                    deadlineTimeout = setTimeout(() => resolve({ kind: 'timeout' }), dynamicDeadlineMs)
                })

                const barrierPromise = Promise.allSettled(workerPromises).then(results => ({
                    kind: 'completed' as const,
                    results
                }))

                const raceResult = await Promise.race([barrierPromise, deadlinePromise])
                if (deadlineTimeout) clearTimeout(deadlineTimeout)

                if (raceResult.kind === 'timeout') {
                    this.logger.error(
                        'main',
                        'ACCOUNT-DEADLINE',
                        `[ACCOUNT-DEADLINE-EXCEEDED] Batch [${batchIndex + 1}/${batches.length}] melebihi batas waktu adaptif ${(dynamicDeadlineMs / 60000).toFixed(0)} menit! Memutus barrier untuk mencegah zombie worker runner deadlock.`
                    )
                    for (const bot of this.activeWorkerBots) {
                        try {
                            bot.accountScope?.abortController.abort()
                            await bot.cleanupBrowserResources()
                        } catch {}
                    }
                    try {
                        this.accountScope?.abortController.abort()
                        await this.cleanupBrowserResources()
                    } catch {}

                    // Bounded Join saat timeout akun: await hingga promise eksekusi akun lama benar-benar keluar sebelum memulai akun berikutnya
                    await Promise.race([
                        Promise.allSettled(workerPromises),
                        new Promise(resolve => setTimeout(resolve, 10000))
                    ])
                } else {
                    for (const res of raceResult.results) {
                        if (res.status === 'fulfilled' && res.value) {
                            accountStats.push(res.value)
                        }
                    }
                }
                processedInBatchCount = workerPromises.length
            }

            this.updateDashboardGlobal({
                currentBatch: null
            })

            // Hook onBatchComplete: only invoked after barrier wait tuntas
            await this.onBatchComplete(batchIndex, batch, batches.length, processedInBatchCount)
        }

        if (this.config.clusters <= 1 && cluster.isPrimary) {
            const totalCollected = accountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
            const totalInitial = accountStats.reduce((sum, s) => sum + s.initialPoints, 0)
            const totalFinal = accountStats.reduce((sum, s) => sum + s.finalPoints, 0)
            const totalDuration = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)
            const totalBandwidth = accountStats.reduce((sum, s) => sum + (s.bandwidthMb ?? 0), 0).toFixed(2)
            const avgBandwidth = (
                accountStats.length > 0 ? parseFloat(totalBandwidth) / accountStats.length : 0
            ).toFixed(2)

            this.logger.info(
                'main',
                'RUN-END',
                `Completed all accounts | Accounts: ${accountStats.length} | Points: +${totalCollected} | Bandwidth: ${totalBandwidth} MB total (avg ${avgBandwidth} MB/acc) | Old: ${totalInitial} → New: ${totalFinal} | Runtime: ${totalDuration}min`,
                'green'
            )
            await flushAllWebhooks()
            if (this.localProxy) {
                await this.localProxy.stop()
            }
            this.teardownCliOperatorListener()
            process.exit(0)
        }

        if (this.localProxy) {
            await this.localProxy.stop()
        }
        this.teardownCliOperatorListener()
        return accountStats
    }

    public async runAccountWorkflow(account: Account): Promise<AccountStats | null> {
        const workerBot = new MicrosoftRewardsBot(this)
        this.activeWorkerBots.add(workerBot)
        try {
            return await workerBot.executeAccountScopeWorkflow(account)
        } finally {
            this.activeWorkerBots.delete(workerBot)
        }
    }

    public async executeAccountScopeWorkflow(account: Account): Promise<AccountStats | null> {
        let scope: AccountScope | null = null
        const accountStartTime = Date.now()
        const accountEmail = account.email

        // 0. Proactive fast-skip if account was previously quarantined / suspended
        if (AccountSessionStore.isAccountSuspended(this.config.sessionPath, accountEmail)) {
            this.logger.warn(
                'main',
                'ACCOUNT-SUSPENDED',
                `⚡ [ACCOUNT-SUSPENDED] Akun ${accountEmail} telah dikarantina (SUSPENDED). Melewati eksekusi otomatis.`
            )
            this.updateDashboardAccount(accountEmail, {
                status: 'SUSPENDED',
                error: 'Account Suspended/Banned'
            })
            return {
                email: accountEmail,
                initialPoints: 0,
                finalPoints: 0,
                collectedPoints: 0,
                duration: 0,
                bandwidthMb: 0,
                success: false,
                error: 'Account Suspended'
            }
        }

        try {
            this.resetAccountState()
            scope = await AccountScope.create({
                account,
                bot: this,
                runId: this.runId
            })
            this.accountScope = scope
            this.userData = {
                userName: this.utils.getEmailUsername(accountEmail),
                geoLocale: (account.geoLocale && account.geoLocale !== 'auto') ? account.geoLocale : 'US',
                langCode: 'en',
                initialPoints: 0,
                currentPoints: 0,
                gainedPoints: 0,
                timezoneOffset: new Date().getTimezoneOffset().toString()
            }
            this.activeAccount = account
            this.sessionActiveAccountEmail = accountEmail

            this.updateDashboardAccount(accountEmail, {
                email: accountEmail,
                status: 'Stealth Delay',
                initialPoints: 0,
                collectedPoints: 0,
                desktopProgress: '0/0',
                mobileProgress: '0/0'
            })
            const randomStartDelay = Math.floor(Math.random() * (60000 - 10000 + 1)) + 10000
            this.logger.info(
                'main',
                'STEALTH',
                `Menunggu ${(randomStartDelay / 1000).toFixed(0)} detik sebelum buka browser biar keliatan natural...`,
                'cyan'
            )
            this.updateDashboardAccount(accountEmail, { status: 'Stealth Delay' })
            await this.utils.wait(randomStartDelay)

            this.logger.info(
                'main',
                'ACCOUNT-START',
                `[ACCOUNT-START] Starting workflow for: ${accountEmail} | geoLocale: ${account.geoLocale}`
            )
            this.updateDashboardAccount(accountEmail, { status: 'Starting Browser' })
            DataSaverManager.getInstance().beginAccountQuota(accountEmail)
            this.axios = new AxiosClient(
                account.proxy,
                this.localProxyPort,
                bytes => this.trackBandwidth(bytes),
                err => {
                    void this.notifySuspectedConnectivityFailure('axios', err)
                }
            )

            let result: any = null
            try {
                result = await this.Main(account, scope)
            } catch (error) {
                if (error instanceof AccountSuspendedError || (error as any)?.name === 'AccountSuspendedError') {
                    throw error
                }
                const errMsg = error instanceof Error ? error.message : String(error)
                void this.logger.error(
                    true,
                    'FLOW',
                    `Mobile flow failed for ${accountEmail}: ${errMsg}`
                )
                const lowerErr = errMsg.toLowerCase()
                if (lowerErr.includes('locked') || lowerErr.includes('suspended') || lowerErr.includes('banned')) {
                    this.triggerCircuitBreaker(`Account security penalty detected on ${accountEmail}: ${errMsg}`)
                }
                void Database.getInstance().recordAccountError({
                    email: accountEmail,
                    errorType: 'WORKFLOW_ERROR',
                    errorMessage: errMsg,
                    stage: 'ACCOUNT_FLOW',
                    proxy: account.proxy?.url
                })
                this.updateDashboardAccount(accountEmail, { status: 'Error', error: errMsg })
                result = undefined
            }

            const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)
            const mbConsumed = (this.bandwidthTracker.totalBytes / (1024 * 1024)).toFixed(2)

            const quotaReport = DataSaverManager.getInstance().finishAccountQuota(accountEmail)
            const bRes = quotaReport.budgetResult
            const statusColor = bRes.status === 'PASS' ? 'cyan' : 'yellow'

            if (result) {
                const collectedPoints = result.collectedPoints ?? 0
                const accountInitialPoints = result.initialPoints ?? 0
                const accountFinalPoints = accountInitialPoints + collectedPoints

                this.logger.info(
                    'main',
                    'ACCOUNT-FINISH',
                    `[ACCOUNT-FINISH] Completed workflow for: ${accountEmail} | Total: +${collectedPoints} | Old: ${accountInitialPoints} → New: ${accountFinalPoints} | Duration: ${durationSeconds}s`,
                    'green'
                )
                this.logger.info(
                    'main',
                    'DATA-SAVER',
                    `[DATA-SAVER] Quota=${bRes.consumedMb.toFixed(2)}MB budget=${bRes.budgetMb.toFixed(2)}MB usage=${bRes.percentage.toFixed(1)}% status=${bRes.status}${bRes.status === 'OVER_BUDGET' ? ` overBy=${bRes.overMb.toFixed(2)}MB` : ''}`,
                    statusColor
                )
                const bd = quotaReport.breakdown
                this.logger.info(
                    'main',
                    'DATA-SAVER',
                    `[DATA-SAVER] Breakdown: document=${(bd.document.bytes / (1024 * 1024)).toFixed(2)}MB (${bd.document.requests} req) | script=${(bd.script.bytes / (1024 * 1024)).toFixed(2)}MB (${bd.script.requests} req) | xhr/fetch=${(bd['xhr/fetch'].bytes / (1024 * 1024)).toFixed(2)}MB (${bd['xhr/fetch'].requests} req) | image=${(bd.image.bytes / (1024 * 1024)).toFixed(2)}MB (${bd.image.requests} req) | media=${(bd.media.bytes / (1024 * 1024)).toFixed(2)}MB (${bd.media.requests} req) | font=${(bd.font.bytes / (1024 * 1024)).toFixed(2)}MB (${bd.font.requests} req) | other=${(bd.other.bytes / (1024 * 1024)).toFixed(2)}MB (${bd.other.requests} req)`
                )
                this.updateDashboardAccount(accountEmail, {
                    status: 'Completed',
                    collectedPoints: collectedPoints,
                    bandwidth: `${mbConsumed} MB`
                })

                return {
                    email: accountEmail,
                    initialPoints: accountInitialPoints,
                    finalPoints: accountFinalPoints,
                    collectedPoints: collectedPoints,
                    duration: parseFloat(durationSeconds),
                    bandwidthMb: parseFloat(mbConsumed),
                    success: true
                }
            } else {
                this.logger.info(
                    'main',
                    'DATA-SAVER',
                    `[DATA-SAVER] Quota=${bRes.consumedMb.toFixed(2)}MB budget=${bRes.budgetMb.toFixed(2)}MB usage=${bRes.percentage.toFixed(1)}% status=${bRes.status}${bRes.status === 'OVER_BUDGET' ? ` overBy=${bRes.overMb.toFixed(2)}MB` : ''}`,
                    statusColor
                )
                const bd = quotaReport.breakdown
                this.logger.info(
                    'main',
                    'DATA-SAVER',
                    `[DATA-SAVER] Breakdown: document=${(bd.document.bytes / (1024 * 1024)).toFixed(2)}MB (${bd.document.requests} req) | script=${(bd.script.bytes / (1024 * 1024)).toFixed(2)}MB (${bd.script.requests} req) | xhr/fetch=${(bd['xhr/fetch'].bytes / (1024 * 1024)).toFixed(2)}MB (${bd['xhr/fetch'].requests} req) | image=${(bd.image.bytes / (1024 * 1024)).toFixed(2)}MB (${bd.image.requests} req) | media=${(bd.media.bytes / (1024 * 1024)).toFixed(2)}MB (${bd.media.requests} req) | font=${(bd.font.bytes / (1024 * 1024)).toFixed(2)}MB (${bd.font.requests} req) | other=${(bd.other.bytes / (1024 * 1024)).toFixed(2)}MB (${bd.other.requests} req)`
                )
                this.updateDashboardAccount(accountEmail, {
                    status: 'Failed',
                    error: 'Flow failed',
                    bandwidth: `${mbConsumed} MB`
                })
                return {
                    email: accountEmail,
                    initialPoints: 0,
                    finalPoints: 0,
                    collectedPoints: 0,
                    duration: parseFloat(durationSeconds),
                    bandwidthMb: parseFloat(mbConsumed),
                    success: false,
                    error: 'Flow failed'
                }
            }
        } catch (error) {
            const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)
            const isSuspended = error instanceof AccountSuspendedError || (error as any)?.name === 'AccountSuspendedError'

            if (isSuspended) {
                const errMsg = error instanceof Error ? error.message : String(error)
                this.logger.error(
                    'main',
                    'ACCOUNT-SUSPENDED',
                    `🚨 [ACCOUNT-SUSPENDED] Akun ${accountEmail} TERBUKTI DITANGGUHKAN (BANNED) oleh Microsoft!`
                )

                // 1. Quarantining session files & writing marker
                await AccountSessionStore.quarantineSuspendedAccount(this.config.sessionPath, accountEmail, errMsg).catch(qErr => {
                    this.logger.error('main', 'QUARANTINE', `Failed to quarantine session for ${accountEmail}: ${qErr}`)
                })

                // 2. Immediate dispose of open contexts
                if (scope) {
                    await AccountDisposer.dispose(scope).catch(() => {})
                }

                // 3. Log required summary
                this.logger.warn(
                    'main',
                    'ACCOUNT-FINISH',
                    `[ACCOUNT-FINISH] Dilewati secara instan akibat suspensi. | ${accountEmail} | Duration: ${durationSeconds}s`
                )

                // 4. Update status in dashboard & internal database
                void Database.getInstance().recordAccountError({
                    email: accountEmail,
                    errorType: 'ACCOUNT_SUSPENDED',
                    errorMessage: errMsg,
                    stage: 'SUSPENSION_DETECTED',
                    proxy: account.proxy?.url
                })
                this.updateDashboardAccount(accountEmail, {
                    status: 'SUSPENDED',
                    error: errMsg
                })
 
                return {
                    email: accountEmail,
                    initialPoints: 0,
                    finalPoints: 0,
                    collectedPoints: 0,
                    duration: parseFloat(durationSeconds),
                    bandwidthMb: parseFloat((this.bandwidthTracker.totalBytes / (1024 * 1024)).toFixed(2)),
                    success: false,
                    error: 'Account Suspended'
                }
            }

            const errMsg = error instanceof Error ? error.message : String(error)
            this.logger.error('main', 'ACCOUNT-ERROR', `${accountEmail}: ${errMsg}`)
            void Database.getInstance().recordAccountError({
                email: accountEmail,
                errorType: 'ACCOUNT_ERROR',
                errorMessage: errMsg,
                stage: 'ACCOUNT_PIPELINE',
                proxy: account.proxy?.url
            })
            this.updateDashboardAccount(accountEmail, {
                status: 'Failed',
                error: errMsg
            })
            return {
                email: accountEmail,
                initialPoints: 0,
                finalPoints: 0,
                collectedPoints: 0,
                duration: parseFloat(durationSeconds),
                success: false,
                error: errMsg
            }
        } finally {
            try {
                if (scope) {
                    await AccountDisposer.dispose(scope).catch(err => {
                        this.logger.error(
                            'main',
                            'ACCOUNT-DISPOSE',
                            `Disposal failed for ${accountEmail}: ${err instanceof Error ? err.message : String(err)}`
                        )
                    })
                }
                if (this.browserFactory) {
                    await this.browserFactory.recycleBrowser().catch(() => {})
                }
            } finally {
                if (this.accountScope === scope) {
                    this.accountScope = null
                    this.resetAccountState()
                }
                this.sessionCompletedAccounts++
                this.sessionActiveAccountEmail = ''
                DataSaverManager.getInstance().resetAccountQuota(accountEmail)
            }

            if (this.pendingOperatorRecovery) {
                const pending = this.pendingOperatorRecovery
                this.pendingOperatorRecovery = null
                const now = Date.now()
                if (now - pending.receivedAt <= pending.ttlMs) {
                    this.logger.info(
                        'main',
                        'NETWORK-RECOVERY',
                        `dequeued checkpoint=account-scope-disposed source=${pending.source}`
                    )
                    await this.requestNetworkRecovery('operator-request')
                } else {
                    this.logger.info(
                        'main',
                        'NETWORK-RECOVERY',
                        `discarded reason=expired receivedAt=${pending.receivedAt} ttlMs=${pending.ttlMs}`
                    )
                }
            }
        }
    }

    private async onBatchComplete(
        batchIndex: number,
        batch: Account[],
        totalBatches: number,
        processedInBatchCount?: number
    ): Promise<void> {
        if (batchIndex >= totalBatches - 1) {
            return
        }

        if (this.stopRequested) {
            this.logger.warn('main', 'IP-INTERCEPTOR', 'IP rotation skipped due to user stop request.')
            return
        }

        const actualProcessedCount = typeof processedInBatchCount === 'number' ? processedInBatchCount : batch.length
        const isManual = this.config.useDynamicWifiProxy || !this.config.useAdbIpRotation
        const oldIp = await this.getCurrentIP(this.localProxyPort || undefined)

        if (isManual) {
            this.logger.warn(
                'main',
                'IP-INTERCEPTOR',
                '=======================================================',
                'yellow'
            )
            this.logger.warn(
                'main',
                'IP-INTERCEPTOR',
                `🔥 BATCH [${batchIndex + 1}/${totalBatches}] SELESAI (${actualProcessedCount} akun diproses)! 🔥`,
                'yellow'
            )
            this.logger.warn(
                'main',
                'IP-INTERCEPTOR',
                `🚨 [MANUAL IP ROTATION] Silakan ubah IP di HP/Hotspot! Tekan ENTER di terminal atau klik "Confirm IP Rotated" di Dashboard (http://localhost:4000)...`,
                'yellow'
            )
            this.logger.warn('main', 'IP-INTERCEPTOR', `IP Saat Ini: [ ${oldIp} ]`, 'yellow')
            this.logger.warn(
                'main',
                'IP-INTERCEPTOR',
                '=======================================================',
                'yellow'
            )
            process.stdout.write('\x07')

            this.updateDashboardGlobal({
                manualIpRotationActive: true
            })

            await waitForManualIpConfirmation()

            this.updateDashboardGlobal({
                manualIpRotationActive: false
            })

            const newIp = await this.getCurrentIP(this.localProxyPort || undefined)
            this.logger.info(
                'main',
                'IP-INTERCEPTOR',
                `🚀 Konfirmasi diterima! Melanjutkan ke Batch berikutnya | IP Aktif: [ ${newIp} ]`,
                'green'
            )
            this.updateDashboardGlobal({ currentIP: newIp })
            await this.utils.wait(1000)
            return
        }

        let ipChanged = false
        while (!ipChanged) {
            if (this.stopRequested) {
                this.logger.warn('main', 'IP-INTERCEPTOR', 'IP rotation aborted due to user stop request.')
                break
            }

            this.logger.warn(
                'main',
                'IP-INTERCEPTOR',
                '=======================================================',
                'yellow'
            )
            this.logger.warn(
                'main',
                'IP-INTERCEPTOR',
                `🔥 BATCH [${batchIndex + 1}/${totalBatches}] SELESAI (${actualProcessedCount} akun diproses)! ROTASI IP AUTO (ADB AIRPLANE MODE) DIMULAI... 🔥`,
                'yellow'
            )
            this.logger.warn('main', 'IP-INTERCEPTOR', `IP Saat Ini: [ ${oldIp} ]`, 'yellow')
            this.logger.warn(
                'main',
                'IP-INTERCEPTOR',
                '=======================================================',
                'yellow'
            )

            try {
                this.logger.info('main', 'IP-INTERCEPTOR', 'ADB -> Menjalankan rotasi IP via Airplane Mode di Linux...')
                await AirplaneMode.toggle(8000, 15000)

                    const checkNewIp = await this.getCurrentIP(this.localProxyPort || undefined)

                    if (checkNewIp !== oldIp && checkNewIp !== 'UNKNOWN_IP') {
                        ipChanged = true
                        this.logger.info(
                            'main',
                            'IP-INTERCEPTOR',
                            `🚀 SUKSES! IP Baru Terdeteksi: [ ${checkNewIp} ]`,
                            'green'
                        )
                        this.updateDashboardGlobal({ currentIP: checkNewIp })
                        await this.utils.wait(3000)
                    } else {
                        this.logger.error(
                            'main',
                            'IP-INTERCEPTOR',
                            `❌ GAGAL! IP masih kembar [ ${checkNewIp} ]. Silakan periksa USB Tethering di HP...`,
                            'red'
                        )
                        process.stdout.write('\x07')
                        await this.utils.wait(3000)
                    }
                } catch (adbError) {
                    const errMsg = adbError instanceof Error ? adbError.message : String(adbError)
                    this.logger.error(
                        'main',
                        'IP-INTERCEPTOR',
                        `🚨 Jalur Jaringan Lemot/IP Glitch / Device ADB Tidak Terdeteksi: ${errMsg}`,
                        'red'
                    )
                    process.stdout.write('\x07')
                    this.logger.info(
                        'main',
                        'IP-INTERCEPTOR',
                        '📌 Pastikan device HP tercolok dan USB debugging aktif, atau ubah IP secara manual...',
                        'cyan'
                    )
                    await this.utils.wait(3000)
                }
            }
        }

    async Main(account: Account, scope?: AccountScope): Promise<{ initialPoints: number; collectedPoints: number }> {
        const accountEmail = account.email
        this.logger.info('main', 'FLOW', `Starting session for ${accountEmail}`)

        // Zero Leakage: Reset token and completed offers set for clean per-account isolation
        if (this.accountScope) {
            this.accountScope.clearDapiToken()
        }
        this.activeAccount = account
        this.workers?.completedOffersInSession?.clear()

        let mobileSession: BrowserSession | null = null
        let mobileContextClosed = false

        try {
            return await executionContext.run({ isMobile: true, account }, async () => {
                mobileSession = await this.browserFactory.createBrowser(account)
                const initialContext: BrowserContext = mobileSession.context
                this.accountScope?.setContext('mobile', initialContext)
                this.mainMobilePage = await createManagedPage({
                    context: initialContext,
                    accountScope: accountEmail,
                    purpose: 'main-mobile-owner',
                    isMobile: true,
                    deviceProfile: this.accountScope?.deviceProfile
                })
                this.accountScope?.trackPage(this.mainMobilePage)

                this.logger.info('main', 'BROWSER', `Mobile Browser started | ${accountEmail}`)

                await this.login.login(this.mainMobilePage, account)

                // Auto-enrollment sebelum penukaran token DAPI
                const enrolled = await autoEnrollRewards(this.mainMobilePage, this)
                const currentMobileUrl = this.mainMobilePage.url()
                const isStillAbout =
                    currentMobileUrl.includes('rewards.bing.com/about') ||
                    currentMobileUrl.includes('rewards.bing.com/welcome')

                if (isStillAbout && !enrolled) {
                    this.logger.warn(
                        'main',
                        'ONBOARDING',
                        `Akun masih berada di ${currentMobileUrl} (belum enrolled). Melewati penukaran token DAPI untuk mencegah HTTP 401 Unauthorized.`
                    )
                } else {
                    try {
                        this.accessToken = await this.refreshMobileAccessToken(this.mainMobilePage, accountEmail)
                    } catch (error) {
                        this.logger.error(
                            'main',
                            'FLOW',
                            `Failed to get mobile access token: ${error instanceof Error ? error.message : String(error)}`
                        )
                    }
                }

                // Immediate Execution Pipeline: begitu token mobile diterima, langsung sinkronisasi profil resmi & pasar akun sebelum menjalankan Daily Check-In & Read to Earn
                let immediateMobileExecuted = false
                let appData: AppDashboardData | null = null
                if (this.accessToken) {
                    this.logger.info(
                        'main',
                        'IMMEDIATE-PIPELINE',
                        'Mobile access token received. Resolving account market & triggering immediate Daily Check-In & Read to Earn...'
                    )

                    // 1. Ambil data profil & katalog promosi mobile resmi dari DAPI (/dapi/me)
                    try {
                        appData = await this.browser.func.getAppDashboardData().catch(() => null)
                    } catch {}

                    // 2. Resolusi negara & pasar akun secara presisi dari DAPI profile
                    const detectedCountry = (appData?.response?.profile?.attributes?.country || 'ID').toUpperCase()
                    if (account.geoLocale === 'auto') {
                        this.userData.geoLocale = detectedCountry
                    } else if (account.geoLocale) {
                        this.userData.geoLocale = account.geoLocale.toUpperCase()
                    }
                    this.logger.info(
                        'main',
                        'IMMEDIATE-PIPELINE',
                        `[GEO-RESOLVED] Pasar akun terkonfirmasi: ${this.userData.geoLocale} (profile=${detectedCountry}) | ${accountEmail}`
                    )

                    // 3. Deteksi penawaran Read to Earn resmi dari katalog promosi akun
                    let readOfferId: string | undefined = undefined
                    for (const item of (appData?.response?.promotions || [])) {
                        const attrs = item.attributes || {}
                        const offerId = (attrs.offerid ?? '').toLowerCase()
                        if (
                            attrs.type === 'msnreadearn' ||
                            offerId.includes('readarticle') ||
                            (item.name ?? '').toLowerCase().includes('readarticle')
                        ) {
                            if (attrs.offerid) {
                                readOfferId = attrs.offerid
                                ;(this as any).detectedReadArticleOfferId = attrs.offerid
                                break
                            }
                        }
                    }
                    if (readOfferId) {
                        this.logger.info(
                            'main',
                            'IMMEDIATE-PIPELINE',
                            `[READ-TO-EARN] Penawaran aktif terdeteksi di server: "${readOfferId}"`
                        )
                    }

                    // 4. Inisialisasi saldo awal dari server resmi DAPI
                    const startingPoints = Number(appData?.response?.balance ?? (appData?.response as any)?.user?.balance ?? 0)
                    if (startingPoints > 0) {
                        this.initialPoints = startingPoints
                        this.currentPoints = startingPoints
                        this.updateDashboardAccount(accountEmail, { initialPoints: startingPoints })
                        this.logger.info(
                            'main',
                            'IMMEDIATE-PIPELINE',
                            `[IMMEDIATE-PIPELINE] Saldo awal berhasil diinisialisasi via DAPI: ${startingPoints} Pts | ${accountEmail}`
                        )
                    } else if (this.currentPoints <= 0) {
                        // Fallback jika saldo dari appData belum terbaca
                        try {
                            const userRes = await this.axios.request({
                                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/user',
                                method: 'GET',
                                headers: {
                                    Authorization: `Bearer ${this.accessToken}`,
                                    'User-Agent': UserAgentManager.DEFAULT_MOBILE_UA,
                                    'x-rewards-appid': 'SAAndroid/32.5.431027001',
                                    'X-Rewards-Country': this.userData.geoLocale || 'ID',
                                    'X-Rewards-Language': 'en',
                                    'X-Rewards-ismobile': 'true'
                                },
                                validateStatus: () => true,
                                timeout: 7000
                            })
                            const fallbackBal = Number(userRes?.data?.response?.balance ?? userRes?.data?.balance ?? 0)
                            if (fallbackBal > 0) {
                                this.initialPoints = fallbackBal
                                this.currentPoints = fallbackBal
                                this.updateDashboardAccount(accountEmail, { initialPoints: fallbackBal })
                                this.logger.info(
                                    'main',
                                    'IMMEDIATE-PIPELINE',
                                    `[IMMEDIATE-PIPELINE] Saldo awal berhasil diinisialisasi via /dapi/me/user: ${fallbackBal} Pts | ${accountEmail}`
                                )
                            }
                        } catch {}
                    }
                    if (this.config.workers.doDailyCheckIn) {
                        try {
                            this.updateDashboardAccount(accountEmail, { status: 'Daily Check-in' })
                            await this.activities.doDailyCheckIn()
                        } catch (checkInErr) {
                            this.logger.warn(
                                'main',
                                'DAILY-CHECKIN',
                                `Immediate Daily Check-in failed: ${checkInErr instanceof Error ? checkInErr.message : String(checkInErr)}`
                            )
                        }
                    }

                    if (this.config.workers.doReadToEarn) {
                        try {
                            this.updateDashboardAccount(accountEmail, { status: 'Read to Earn' })
                            await this.activities.doReadToEarn()
                        } catch (readErr) {
                            this.logger.warn(
                                'main',
                                'READ-TO-EARN',
                                `Immediate Read to Earn failed: ${readErr instanceof Error ? readErr.message : String(readErr)}`
                            )
                        }
                    }
                    immediateMobileExecuted = true
                }

                // Pastikan browser owner page tetap sehat di Dashboard Rewards & sinkronisasi cookies aktif
                if (this.mainMobilePage.isClosed()) {
                    await recoverOwnerPage({
                        bot: this,
                        oldPage: this.mainMobilePage,
                        isMobile: true,
                        accountScope: accountEmail
                    })
                } else {
                    const currentUrl = this.mainMobilePage.url()
                    if (!currentUrl.includes('rewards.bing.com/dashboard') && !currentUrl.includes('rewards.bing.com')) {
                        await this.mainMobilePage
                            .goto(this.config.baseURL, { waitUntil: 'domcontentloaded', timeout: 15000 })
                            .catch(() => {})
                    }
                }
                await this.utils.wait(2000)

                if (this.mainMobilePage && !this.mainMobilePage.isClosed()) {
                    const suspension = await checkPageSuspension(this.mainMobilePage)
                    if (suspension.isSuspended) {
                        this.logger.error(
                            true,
                            'ACCOUNT-SUSPENDED',
                            `🚨 [ACCOUNT-SUSPENDED] Akun ${accountEmail} TERBUKTI DITANGGUHKAN (BANNED) oleh Microsoft!`
                        )
                        throw new AccountSuspendedError(accountEmail, suspension.reason)
                    }
                }

                this.cookies.mobile = await initialContext.cookies()
                this.fingerprint = mobileSession.fingerprint

                if (!appData) {
                    try {
                        appData = await this.browser.func.getAppDashboardData()
                    } catch (error) {
                        if (error instanceof AccountSuspendedError || (error as any)?.name === 'AccountSuspendedError') {
                            throw error
                        }
                    }
                }

                const finalDetectedCountry = (appData?.response?.profile?.attributes?.country || 'ID').toUpperCase()
                this.userData.geoLocale =
                    account.geoLocale === 'auto' ? finalDetectedCountry : account.geoLocale.toLowerCase()

                if (this.mainMobilePage) {
                    await ensureOnRewardsDashboard(this.mainMobilePage)
                }

                let data: DashboardData
                try {
                    data = await this.browser.func.getDashboardData()
                } catch (dashErr) {
                    this.logger.warn(
                        'main',
                        'GET-DASHBOARD-DATA',
                        `Gagal mengambil dashboard data via browser (${dashErr instanceof Error ? dashErr.message : String(dashErr)}), mencoba parser modern DOM (__NEXT_DATA__)...`
                    )
                    // Ekstraksi state JSON dari DOM modern (__NEXT_DATA__ di rewards.bing.com/earn)
                    let modernDomData: DashboardData | null = null
                    const targetPage = this.mainMobilePage || this.mainDesktopPage
                    if (targetPage && !targetPage.isClosed()) {
                        modernDomData = await targetPage.evaluate(() => {
                            try {
                                const nextEl = document.getElementById('__NEXT_DATA__') || document.querySelector('script[id="__NEXT_DATA__"]')
                                if (nextEl?.textContent) {
                                    const parsed = JSON.parse(nextEl.textContent)
                                    const props = parsed?.props?.pageProps
                                    if (props?.dashboard?.userStatus) return props.dashboard
                                    if (props?.userStatus) return props
                                    if (props?.state?.dashboard?.userStatus) return props.state.dashboard
                                }
                                const win = window as any
                                if (win.__NEXT_DATA__?.props?.pageProps?.dashboard?.userStatus) {
                                    return win.__NEXT_DATA__.props.pageProps.dashboard
                                }
                            } catch {}
                            return null
                        }).catch(() => null)
                    }

                    if (modernDomData && modernDomData.userStatus) {
                        data = modernDomData
                    } else {
                        this.logger.warn(
                            'main',
                            'GET-DASHBOARD-DATA',
                            `Parser modern DOM tidak menemukan data, beralih ke fallback DAPI appData...`
                        )
                        const fallbackData = appData ? this.browser.func.mapAppDataToDashboard(appData) : null
                        if (fallbackData) {
                            data = fallbackData
                        } else {
                            const availPts = appData?.response?.balance ?? this.userData.initialPoints ?? 0
                            data = {
                                userStatus: {
                                    availablePoints: availPts,
                                    counters: {
                                        pcSearch: [{ pointProgress: 0, pointProgressMax: 90 }],
                                        mobileSearch: [{ pointProgress: 0, pointProgressMax: 60 }]
                                    }
                                },
                                dailySetPromotions: {},
                                morePromotions: [],
                                punchCards: []
                            } as unknown as DashboardData
                        }
                    }
                }

                if (!this.userData.initialPoints || this.userData.initialPoints <= 0) {
                    this.userData.initialPoints = data.userStatus.availablePoints
                }
                this.userData.currentPoints = data.userStatus.availablePoints
                const initialPoints = this.userData.initialPoints ?? 0

                const pcProg = data.userStatus.counters.pcSearch?.[0]
                    ? `${data.userStatus.counters.pcSearch[0].pointProgress}/${data.userStatus.counters.pcSearch[0].pointProgressMax}`
                    : '0/0'
                const edgeProg =
                    data.userStatus.counters.pcSearch?.[1] && data.userStatus.counters.pcSearch[1].pointProgressMax > 0
                        ? ` (+${data.userStatus.counters.pcSearch[1].pointProgress}/${data.userStatus.counters.pcSearch[1].pointProgressMax} Edge)`
                        : ''
                const desktopProgress = `${pcProg}${edgeProg}`
                const mobileProgress = data.userStatus.counters.mobileSearch?.[0]
                    ? `${data.userStatus.counters.mobileSearch[0].pointProgress}/${data.userStatus.counters.mobileSearch[0].pointProgressMax}`
                    : '0/0'

                this.updateDashboardAccount(accountEmail, {
                    initialPoints,
                    desktopProgress,
                    mobileProgress,
                    status: 'Processing Tasks'
                })

                const browserEarnable = await this.browser.func.getBrowserEarnablePoints(data)
                this.logger.info(
                    'main',
                    'POINTS',
                    `Earnable today | Mobile: ${browserEarnable.mobileSearchPoints} | Desktop: ${browserEarnable.desktopSearchPoints} | Daily Set: ${browserEarnable.dailySetPoints} | More: ${browserEarnable.morePromotionsPoints} | Total: ${browserEarnable.totalEarnablePoints} | ${accountEmail}`
                )

                // Fetch DAPI app-earnable points if access token is available
                let appEarnable: any = null
                if (this.accessToken) {
                    try {
                        appEarnable = await this.browser.func.getAppEarnablePoints()
                    } catch {}
                }

                // --- 1. Fast-Path Early Exit Evaluation ---
                const now = new Date()
                const todayLocal = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
                const todayUtc = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`
                const validDates = new Set([todayLocal, todayUtc])

                const dailySetMapItems: any[] = Object.values(data?.dailySetPromotions ?? {}).flat()
                const fallbackPromos = [
                    ...(data?.promotionalItems ?? []),
                    ...(data?.morePromotions ?? []),
                    ...(data?.morePromotionsWithoutPromotionalItems ?? [])
                ].filter(x => (x?.offerId ?? '').toLowerCase().includes('dailyset'))
                const allDailySetItems = [...new Map([...dailySetMapItems, ...fallbackPromos].map(p => [p.offerId, p])).values()].filter(x => {
                    if (!x) return false
                    const offerIdLower = (x.offerId ?? '').toLowerCase()
                    if (offerIdLower.includes('locked')) return false
                    const dateMatch = (x.offerId ?? '').match(/DailySet_(\d{8})/i)
                    if (dateMatch && dateMatch[1] && !validDates.has(dateMatch[1])) return false
                    return true
                })
                const isDailySetComplete = (browserEarnable.dailySetPoints === 0) && (
                    allDailySetItems.length === 0 || allDailySetItems.every(x => x.complete || (x.pointProgressMax > 0 && (x.pointProgress ?? 0) >= x.pointProgressMax))
                )

                let isReadToEarnDone = true
                if (this.config.workers.doReadToEarn) {
                    if (appEarnable) {
                        isReadToEarnDone = appEarnable.readToEarn === 0
                    } else if (appData?.response?.promotions) {
                        const readPromo = appData.response.promotions.find(p => p.attributes?.type === 'msnreadearn' || (p.attributes?.offerid ?? '').includes('readarticle'))
                        isReadToEarnDone = readPromo ? (parseInt(readPromo.attributes?.pointmax ?? '0') <= parseInt(readPromo.attributes?.pointprogress ?? '0')) : false
                    }
                }

                let isCheckInDone = true
                if (this.config.workers.doDailyCheckIn) {
                    if (appEarnable) {
                        isCheckInDone = appEarnable.checkIn === 0
                    } else if (appData?.response?.promotions) {
                        const checkInPromo = appData.response.promotions.find(p => p.attributes?.type === 'checkin' || (p.attributes?.offerid ?? '').includes('CheckIn'))
                        const lastUpdated = checkInPromo?.attributes?.last_updated ? new Date(checkInPromo.attributes.last_updated) : null
                        isCheckInDone = Boolean(lastUpdated && (
                            (lastUpdated.getUTCFullYear() === now.getUTCFullYear() &&
                             lastUpdated.getUTCMonth() === now.getUTCMonth() &&
                             lastUpdated.getUTCDate() === now.getUTCDate()) ||
                            (lastUpdated.getFullYear() === now.getFullYear() &&
                             lastUpdated.getMonth() === now.getMonth() &&
                             lastUpdated.getDate() === now.getDate())
                        ))
                    }
                }

                const isDesktopSearchDone = browserEarnable.desktopSearchPoints === 0
                const isMobileSearchDone = browserEarnable.mobileSearchPoints === 0

                if (isDailySetComplete && isReadToEarnDone && isCheckInDone && isDesktopSearchDone && isMobileSearchDone) {
                    this.logger.info(
                        'main',
                        'FAST-PATH',
                        '⚡ [FAST-PATH] Akun sudah 100% selesai untuk hari ini. Melewati seluruh pipeline dalam hitungan detik.',
                        'green'
                    )

                    if (mobileSession?.context) {
                        try {
                            await executionContext.run({ isMobile: true, account }, async () => {
                                const isClosed = typeof (mobileSession!.context as any).isClosed === 'function'
                                    ? (mobileSession!.context as any).isClosed()
                                    : (mobileSession!.context as any).__isClosed === true
                                if (!isClosed) {
                                    await this.browser.func.closeBrowser(mobileSession!.context, accountEmail)
                                }
                            })
                        } catch {}
                        mobileContextClosed = true
                    }

                    this.updateDashboardAccount(accountEmail, {
                        status: 'Completed',
                        collectedPoints: 0
                    })

                    return { initialPoints, collectedPoints: 0 }
                }

                const accountIdentity = resolveAccountIdentity(this.activeAccount || { email: accountEmail })

                // Hook: Onboarding Detector and Observer (before doDailySet)
                const onboardingCfg = this.config.newAccountOnboarding
                const isOnboardingEnabled = onboardingCfg?.enabled && onboardingCfg.mode !== 'disabled'
                let onboardingBefore: OnboardingEvidence | null = null

                if (isOnboardingEnabled && data) {
                    onboardingBefore = this.activities.detectOnboarding(data, Date.now())
                    await this.activities.observeOnboarding(onboardingBefore, accountIdentity)
                }

                const isAppOnlyEnabled =
                    this.config.appOnlyRewards?.enabled ??
                    this.config.workers.doWindowsAppRewards ??
                    this.config.workers.doAppOnlyRewards ??
                    true

                // Hook 1: Verify pending manual quests
                if (isAppOnlyEnabled && data) {
                    await this.activities.verifyExistingManualQuests(data)
                }

                // Hook 2: Observe current App-Only promotions
                if (isAppOnlyEnabled && data) {
                    this.updateDashboardAccount(accountEmail, { status: 'App-Only Observer' })
                    await this.activities.observeAppOnlyRewards(data)
                }

                if (this.mainMobilePage) {
                    await this.workers.doClaimPendingPoints(this.mainMobilePage)
                }

                if (this.config.workers.doAppPromotions && appData) {
                    this.updateDashboardAccount(accountEmail, { status: 'App Promotions' })
                    await this.workers.doAppPromotions(appData)
                }

                if (this.config.workers.doDailySet && data && this.mainMobilePage) {
                    await ensureOnRewardsDashboard(this.mainMobilePage)
                    this.updateDashboardAccount(accountEmail, { status: 'Daily Set' })
                    await this.workers.doDailySet(data, this.mainMobilePage)
                }

                if (this.config.workers.doSpecialPromotions && data && this.mainMobilePage) {
                    this.updateDashboardAccount(accountEmail, { status: 'Special Promotions' })
                    await this.workers.doSpecialPromotions(data, this.mainMobilePage)
                }

                if (this.config.workers.doMorePromotions && data && this.mainMobilePage) {
                    this.updateDashboardAccount(accountEmail, { status: 'More Promotions' })
                    await this.workers.doMorePromotions(data, this.mainMobilePage)
                }

                if (data) {
                    await this.workers.doClaimBonusPoints(data)
                }

                if (!immediateMobileExecuted && this.config.workers.doDailyCheckIn) {
                    this.updateDashboardAccount(accountEmail, { status: 'Daily Check-in' })
                    await this.activities.doDailyCheckIn()
                }

                if (!immediateMobileExecuted && this.config.workers.doReadToEarn) {
                    this.updateDashboardAccount(accountEmail, { status: 'Read to Earn' })
                    await this.activities.doReadToEarn()
                }

                // Conditional refresh for Onboarding Verification:
                // Only refresh if onboarding is enabled, campaign was detected/active, and there are incomplete tasks to verify!
                const shouldVerifyOnboarding =
                    isOnboardingEnabled &&
                    onboardingBefore &&
                    (onboardingBefore.state === 'detected' || onboardingBefore.state === 'active') &&
                    onboardingBefore.tasks.some(t => !t.complete)

                let refreshedDashboard: DashboardData | null = null
                if (shouldVerifyOnboarding) {
                    refreshedDashboard = await this.browser.func.getDashboardData()
                    await this.activities.verifyOnboarding({
                        identity: accountIdentity,
                        before: onboardingBefore!,
                        afterDashboard: refreshedDashboard
                    })
                }

                const punchCardData = refreshedDashboard || data
                if (this.config.workers.doPunchCards && punchCardData && this.mainMobilePage) {
                    this.updateDashboardAccount(accountEmail, { status: 'Punch Cards' })
                    await this.workers.doPunchCards(punchCardData, this.mainMobilePage)
                }

                if (this.mainMobilePage) {
                    await this.workers.doClaimPendingPoints(this.mainMobilePage, true)
                }

                this.updateDashboardAccount(accountEmail, { status: 'Searching...' })
                const activeMobilePage = (this.mainMobilePage && !this.mainMobilePage.isClosed()) ? this.mainMobilePage : undefined
                const searchPoints = await this.browser.func.getSearchPoints(activeMobilePage, false, true)
                const missingSearchPoints = this.browser.func.missingSearchPoints(searchPoints)

                // update search progress before search loop
                const startPcProg = searchPoints.pcSearch?.[0]
                    ? `${searchPoints.pcSearch[0].pointProgress}/${searchPoints.pcSearch[0].pointProgressMax}`
                    : '0/0'
                const startEdgeProg =
                    searchPoints.pcSearch?.[1] && searchPoints.pcSearch[1].pointProgressMax > 0
                        ? ` (+${searchPoints.pcSearch[1].pointProgress}/${searchPoints.pcSearch[1].pointProgressMax} Edge)`
                        : ''
                const startDesktopProgress = `${startPcProg}${startEdgeProg}`
                const startMobileProgress = searchPoints.mobileSearch?.[0]
                    ? `${searchPoints.mobileSearch[0].pointProgress}/${searchPoints.mobileSearch[0].pointProgressMax}`
                    : '0/0'

                this.updateDashboardAccount(accountEmail, {
                    desktopProgress: startDesktopProgress,
                    mobileProgress: startMobileProgress
                })

                this.cookies.mobile = await initialContext.cookies()

                const { mobilePoints, desktopPoints } = await this.searchManager.doSearches(
                    data,
                    missingSearchPoints,
                    mobileSession,
                    account,
                    accountEmail,
                    scope?.abortController.signal
                )

                // Post-Search Re-Evaluation: Re-fetch dashboard data to claim punchcards completed by searches (e.g. 4-day search challenges) and any remaining pending points!
                try {
                    const postSearchData = await this.browser.func.getDashboardData().catch(() => null)
                    if (postSearchData) {
                        const activePage =
                            this.mainMobilePage && !this.mainMobilePage.isClosed()
                                ? this.mainMobilePage
                                : this.mainDesktopPage && !this.mainDesktopPage.isClosed()
                                  ? this.mainDesktopPage
                                  : null

                        if (activePage) {
                            if (this.config.workers.doDailySet) {
                                await this.workers.doDailySet(postSearchData, activePage)
                            }
                            if (this.config.workers.doSpecialPromotions) {
                                await this.workers.doSpecialPromotions(postSearchData, activePage)
                            }
                            if (this.config.workers.doMorePromotions) {
                                await this.workers.doMorePromotions(postSearchData, activePage)
                            }
                            if (this.config.workers.doPunchCards) {
                                await this.workers.doPunchCards(postSearchData, activePage)
                            }
                            await this.workers.doClaimPendingPoints(activePage)
                        }
                    }
                } catch (postError) {
                    this.logger.debug('main', 'POST-SEARCH', `Post-search claim check skipped: ${postError}`)
                }

                mobileContextClosed = true
                this.userData.gainedPoints = mobilePoints + desktopPoints

                const finalPoints = await this.browser.func.getCurrentPoints()
                const collectedPoints = finalPoints - initialPoints

                this.logger.info(
                    'main',
                    'FLOW',
                    `Collected: +${collectedPoints} | Mobile: +${mobilePoints} | Desktop: +${desktopPoints} | ${accountEmail}`
                )

                return { initialPoints, collectedPoints: collectedPoints || 0 }
            })
        } finally {
            if (this.accountScope) {
                this.accountScope.clearDapiToken()
            }
            this.workers?.completedOffersInSession?.clear()

            if (mobileSession && !mobileContextClosed) {
                try {
                    await executionContext.run({ isMobile: true, account }, async () => {
                        await this.browser.func.closeBrowser(mobileSession!.context, accountEmail)
                    })
                } catch {}
            }
        }
    }
}

export { executionContext }

async function main(): Promise<void> {
    checkNodeVersion()
    const rewardsBot = new MicrosoftRewardsBot()

    process.on('beforeExit', () => {
        void flushAllWebhooks()
    })
    process.on('SIGINT', async () => {
        rewardsBot.logSessionBandwidthSummary('SIGINT')
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGINT received, executing graceful shutdown...')
        await rewardsBot.requestShutdown('SIGINT', 10000).catch(() => {})
        process.exit(130)
    })
    process.on('SIGTERM', async () => {
        rewardsBot.logSessionBandwidthSummary('SIGTERM')
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGTERM received, executing graceful shutdown...')
        await rewardsBot.requestShutdown('SIGTERM', 10000).catch(() => {})
        process.exit(143)
    })
    process.on('uncaughtException', async error => {
        rewardsBot.logger.error('main', 'UNCAUGHT-EXCEPTION', error)
        await flushAllWebhooks()
        process.exit(1)
    })
    process.on('unhandledRejection', async reason => {
        rewardsBot.logger.error('main', 'UNHANDLED-REJECTION', reason as Error)
        await flushAllWebhooks()
        process.exit(1)
    })

    try {
        await rewardsBot.initialize()
        await rewardsBot.run()
    } catch (error) {
        rewardsBot.logger.error('main', 'MAIN-ERROR', error as Error)
    } finally {
        rewardsBot.teardownCliOperatorListener()
        await rewardsBot.manualQuestQueue.flushPendingWrites().catch(() => {})
    }
}

if (require.main === module) {
    main().catch(async error => {
        const tmpBot = new MicrosoftRewardsBot()
        tmpBot.logger.error('main', 'MAIN-ERROR', error as Error)
        await flushAllWebhooks()
        process.exit(1)
    })
}
