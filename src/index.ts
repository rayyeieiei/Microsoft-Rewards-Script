import { AsyncLocalStorage } from 'node:async_hooks'
import cluster, { Worker } from 'cluster'
import type { BrowserContext, Cookie, Page } from 'patchright'
import axios from 'axios'
import pkg from '../package.json'
import dns from 'node:dns/promises' // 🚀 UNTUK CEK KONEKSI HEMAT KUOTA

import Browser from './browser/Browser'
import BrowserFunc from './browser/BrowserFunc'
import BrowserUtils from './browser/BrowserUtils'

import { IpcLog, Logger } from './logging/Logger'
import Utils from './util/Utils'
import { loadAccounts, loadConfig } from './util/Load'
import { checkNodeVersion } from './util/Validator'

import { Login } from './browser/auth/Login'
import { Workers } from './functions/Workers'
import Activities from './functions/Activities'
import { SearchManager } from './functions/SearchManager'
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
    registerManualQuestProvider
} from './util/DashboardServer'
import { ManualQuestQueue } from './runtime/manual/ManualQuestQueue'
import { resolveAccountIdentity, validateUniqueAccountIdentities } from './runtime/identity/AccountIdentity'
import { OnboardingEvidence } from './functions/onboarding/NewAccountOnboardingTypes'
import { redactAccountKey } from './util/Redaction'
import { DataSaverManager, mapResourceTypeToCategory } from './util/DataSaver'
import { Database } from './util/Database'
import { AccountScope } from './runtime/AccountScope'
import { AccountDisposer } from './runtime/AccountDisposer'
import { createManagedPage, recoverOwnerPage } from './runtime/BrowserOperationGuard'
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

    public mainMobilePage!: Page
    public mainDesktopPage!: Page
    public userData: UserData
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
    public cookies: { mobile: Cookie[]; desktop: Cookie[] }
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

    private activeWorkers: number
    private exitedWorkers: number[]
    public browserFactory: Browser = new Browser(this)
    private login = new Login(this)
    private searchManager: SearchManager
    public axios!: AxiosClient

    public bandwidthTracker = {
        totalBytes: 0,
        blockedRequests: 0
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

    constructor() {
        this.userData = {
            userName: '',
            geoLocale: 'US',
            langCode: 'en',
            initialPoints: 0,
            currentPoints: 0,
            gainedPoints: 0,
            timezoneOffset: new Date().getTimezoneOffset().toString()
        }
        this.logger = new Logger(this)
        this.cookies = { mobile: [], desktop: [] }
        this.utils = new Utils()
        this.workers = new Workers(this)
        this.searchManager = new SearchManager(this)
        this.browser = {
            func: new BrowserFunc(this),
            utils: new BrowserUtils(this)
        }
        this.config = loadConfig()
        this.manualQuestQueue = new ManualQuestQueue({
            storagePath: `${process.cwd()}/browser/manual_quests.json`,
            logger: {
                info: msg => this.logger.info(this.isMobile, 'QUEUE', msg),
                warn: msg => this.logger.warn(this.isMobile, 'QUEUE', msg),
                debug: msg => this.logger.debug(this.isMobile, 'QUEUE', msg)
            }
        })
        this.activities = new Activities(this)
        this.activeWorkers = this.config.clusters
        this.exitedWorkers = []
    }

    public resetAccountState() {
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
        if (this.shutdownPromise || this.stopRequested) {
            this.logger.warn(
                'main',
                'NETWORK-RECOVERY',
                `Recovery rejected: shutdown in progress | trigger=${trigger}`
            )
            return {
                status: 'cancelled',
                trigger,
                attempts: 0,
                durationMs: 0,
                finalStage: 'cancelled',
                failureReason: 'cancelled',
                airplaneModeKnowledge: 'confirmed-disabled',
                restorationAttempted: false,
                restorationSucceeded: false
            }
        }

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

    public async requestShutdown(reason: string = 'manual', budgetMs: number = 10000): Promise<ShutdownResult> {
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

    // 🛡️ MODUL IP CHECKER: AMAN JALUR DNS + SUPER HEMAT DATA PAS DITINGGAL TIDUR
    private async getCurrentIP(localProxyPort?: number): Promise<string> {
        try {
            if (this.localProxy) {
                await this.localProxy.ensureWifiConnected()
            }
            await dns.lookup('bing.com')
            const config: any = { timeout: 5000 }
            if (localProxyPort) {
                config.httpAgent = new HttpProxyAgent(`http://127.0.0.1:${localProxyPort}`)
                config.httpsAgent = new HttpsProxyAgent(`http://127.0.0.1:${localProxyPort}`)
            }
            const res = await axios.get('https://ident.me', config)
            return res.data.trim()
        } catch {
            return 'UNKNOWN_IP'
        }
    }

    async initialize(): Promise<void> {
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
        await Database.getInstance().initialize()

        // 1. Runtime Build Provenance
        const buildMeta = resolveBuildMetadata()
        this.logger.info(
            'main',
            'RUNTIME-BUILD',
            `commit=${buildMeta.commit} builtAt=${buildMeta.builtAt} entrypoint=${buildMeta.entrypoint}`
        )

        // 2. ADB IP Rotation configuration status (legacy)
        const legacyConfigDetected = Boolean(this.config.useAdbIpRotation)
        if (legacyConfigDetected) {
            this.logger.warn(
                'main',
                'LEGACY-CONFIG',
                '⚠️ useAdbIpRotation (batch rotation per account count) has been removed. Use networkRecovery configuration instead.',
                'yellow'
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

            registerManualQuestProvider(() => this.manualQuestQueue.getSanitizedSnapshot())

            // Update initial dashboard state
            this.updateDashboardGlobal({
                useDynamicWifiProxy: !!this.config.useDynamicWifiProxy,
                useAdbIpRotation: !!this.config.useAdbIpRotation,
                useGhostCursor: this.config.useGhostCursor ?? true,
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
                    this.stopRequested = true
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
                        this.logger.error('main', 'C2-CONTROL', `Account with email ${redactAccountKey(cmd.email)} not found!`)
                        return
                    }

                    this.logger.info(
                        'main',
                        'C2-CONTROL',
                        `Starting execution for single account: ${redactAccountKey(targetAcc.email)}...`
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
                            `Execution failed for ${redactAccountKey(targetAcc.email)}: ${errMsg}`
                        )
                    } finally {
                        this.isRunning = false
                        this.updateDashboardGlobal({ isRunning: false, startTime: 0 })
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
        let processedCount = 0

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

        for (const account of accounts) {
            if (this.stopRequested) {
                this.logger.warn('main', 'C2-CONTROL', 'Execution stopped/paused by user request.')
                break
            }
            let scope: AccountScope | null = null
            const accountStartTime = Date.now()
            const accountEmail = account.email
            try {
                this.resetAccountState()
                scope = await AccountScope.create({
                    account,
                    bot: this,
                    runId: this.runId
                })
                this.accountScope = scope
                this.userData.userName = this.utils.getEmailUsername(accountEmail)
                this.activeAccount = account

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
                    `[ACCOUNT-START] Starting workflow for: ${redactAccountKey(accountEmail)} | geoLocale: ${account.geoLocale}`
                )
                this.updateDashboardAccount(accountEmail, { status: 'Starting Browser' })
                DataSaverManager.getInstance().beginAccountQuota(accountEmail)
                this.axios = new AxiosClient(
                    account.proxy,
                    this.localProxyPort,
                    bytes => this.trackBandwidth(bytes),
                    err => { void this.notifySuspectedConnectivityFailure('axios', err) }
                )

                const result = await this.Main(account, scope).catch(error => {
                    const errMsg = error instanceof Error ? error.message : String(error)
                    void this.logger.error(
                        true,
                        'FLOW',
                        `Mobile flow failed for ${redactAccountKey(accountEmail)}: ${errMsg}`
                    )
                    this.updateDashboardAccount(accountEmail, { status: 'Error', error: errMsg })
                    return undefined
                })

                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)
                const mbConsumed = (this.bandwidthTracker.totalBytes / (1024 * 1024)).toFixed(2)

                const quotaReport = DataSaverManager.getInstance().finishAccountQuota(accountEmail)
                const bRes = quotaReport.budgetResult
                const statusColor = bRes.status === 'PASS' ? 'cyan' : 'yellow'

                if (result) {
                    const collectedPoints = result.collectedPoints ?? 0
                    const accountInitialPoints = result.initialPoints ?? 0
                    const accountFinalPoints = accountInitialPoints + collectedPoints

                    accountStats.push({
                        email: accountEmail,
                        initialPoints: accountInitialPoints,
                        finalPoints: accountFinalPoints,
                        collectedPoints: collectedPoints,
                        duration: parseFloat(durationSeconds),
                        bandwidthMb: parseFloat(mbConsumed),
                        success: true
                    })

                    this.logger.info(
                        'main',
                        'ACCOUNT-FINISH',
                        `[ACCOUNT-FINISH] Completed workflow for: ${redactAccountKey(accountEmail)} | Total: +${collectedPoints} | Old: ${accountInitialPoints} → New: ${accountFinalPoints} | Duration: ${durationSeconds}s`,
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
                    accountStats.push({
                        email: accountEmail,
                        initialPoints: 0,
                        finalPoints: 0,
                        collectedPoints: 0,
                        duration: parseFloat(durationSeconds),
                        bandwidthMb: parseFloat(mbConsumed),
                        success: false,
                        error: 'Flow failed'
                    })
                    this.updateDashboardAccount(accountEmail, {
                        status: 'Failed',
                        error: 'Flow failed',
                        bandwidth: `${mbConsumed} MB`
                    })
                }
            } catch (error) {
                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)
                const errMsg = error instanceof Error ? error.message : String(error)
                this.logger.error('main', 'ACCOUNT-ERROR', `${redactAccountKey(accountEmail)}: ${errMsg}`)
                accountStats.push({
                    email: accountEmail,
                    initialPoints: 0,
                    finalPoints: 0,
                    collectedPoints: 0,
                    duration: parseFloat(durationSeconds),
                    success: false,
                    error: errMsg
                })
                this.updateDashboardAccount(accountEmail, {
                    status: 'Failed',
                    error: errMsg
                })
            } finally {
                try {
                    if (scope) {
                        await AccountDisposer.dispose(scope).catch(err => {
                            this.logger.error(
                                'main',
                                'ACCOUNT-DISPOSE',
                                `Disposal failed for ${redactAccountKey(accountEmail)}: ${err instanceof Error ? err.message : String(err)}`
                            )
                        })
                    }
                } finally {
                    if (this.accountScope === scope) {
                        this.accountScope = null
                        this.resetAccountState()
                    }
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

            processedCount++
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

    async Main(account: Account, scope?: AccountScope): Promise<{ initialPoints: number; collectedPoints: number }> {
        const accountEmail = account.email
        this.logger.info('main', 'FLOW', `Starting session for ${redactAccountKey(accountEmail)}`)

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
                    isMobile: true
                })
                this.accountScope?.trackPage(this.mainMobilePage)

                this.logger.info('main', 'BROWSER', `Mobile Browser started | ${redactAccountKey(accountEmail)}`)

                await this.login.login(this.mainMobilePage, account)

                try {
                    this.accessToken = await this.login.getAppAccessToken(this.mainMobilePage, accountEmail)
                } catch (error) {
                    this.logger.error(
                        'main',
                        'FLOW',
                        `Failed to get mobile access token: ${error instanceof Error ? error.message : String(error)}`
                    )
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

                this.cookies.mobile = await initialContext.cookies()
                this.fingerprint = mobileSession.fingerprint

                let appData: AppDashboardData | null = null
                try {
                    appData = await this.browser.func.getAppDashboardData()
                } catch {}

                const detectedCountry = (appData?.response?.profile?.attributes?.country || 'ID').toUpperCase()
                this.userData.geoLocale =
                    account.geoLocale === 'auto' ? detectedCountry : account.geoLocale.toLowerCase()

                const data: DashboardData = await this.browser.func.getDashboardData()

                this.userData.initialPoints = data.userStatus.availablePoints
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

                const browserEarnable = await this.browser.func.getBrowserEarnablePoints()
                this.logger.info(
                    'main',
                    'POINTS',
                    `Earnable today | Mobile: ${browserEarnable.mobileSearchPoints} | Desktop: ${browserEarnable.desktopSearchPoints} | Daily Set: ${browserEarnable.dailySetPoints} | More: ${browserEarnable.morePromotionsPoints} | Total: ${browserEarnable.totalEarnablePoints} | ${redactAccountKey(accountEmail)}`
                )

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

                if (this.config.workers.doDailyCheckIn) {
                    this.updateDashboardAccount(accountEmail, { status: 'Daily Check-in' })
                    await this.activities.doDailyCheckIn()
                }

                if (this.config.workers.doReadToEarn) {
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
                const searchPoints = await this.browser.func.getSearchPoints()
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
                    accountEmail
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
                    `Collected: +${collectedPoints} | Mobile: +${mobilePoints} | Desktop: +${desktopPoints} | ${redactAccountKey(accountEmail)}`
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
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGINT received, executing graceful shutdown...')
        await rewardsBot.requestShutdown('SIGINT', 10000).catch(() => {})
        process.exit(130)
    })
    process.on('SIGTERM', async () => {
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
