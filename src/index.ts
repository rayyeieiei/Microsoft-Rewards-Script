import { AsyncLocalStorage } from 'node:async_hooks'
import cluster, { Worker } from 'cluster'
import type { BrowserContext, Cookie, Page } from 'patchright'
import axios from 'axios'
import pkg from '../package.json'
import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'
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
    registerIpConfirmCallback
} from './util/DashboardServer'
import { Database } from './util/Database'
import readline from 'readline'

import type { Account } from './interface/Account'
import AxiosClient from './util/Axios'
import { sendDiscord, flushDiscordQueue } from './logging/Discord'
import { sendNtfy, flushNtfyQueue } from './logging/Ntfy'
import type { DashboardData } from './interface/DashboardData'
import type { AppDashboardData } from './interface/AppDashBoardData'

let manualIpConfirmResolver: (() => void) | null = null

function waitForUserConfirmation(): Promise<void> {
    return new Promise((resolve) => {
        manualIpConfirmResolver = resolve
        
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        })

        rl.question('', () => {
            rl.close()
            if (manualIpConfirmResolver) {
                const res = manualIpConfirmResolver
                manualIpConfirmResolver = null
                res()
            }
        })
    })
}

interface ExecutionContext {
    isMobile: boolean
    account: Account
}

interface BrowserSession {
    context: BrowserContext
    fingerprint: BrowserFingerprintWithHeaders
}

interface AccountStats {
    email: string
    initialPoints: number
    finalPoints: number
    collectedPoints: number
    duration: number
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
    public activities: Activities = new Activities(this)
    public browser: { func: BrowserFunc; utils: BrowserUtils }

    public mainMobilePage!: Page
    public mainDesktopPage!: Page
    public userData: UserData
    public rewardsVersion: 'legacy' | 'modern' = 'legacy'
    public accessToken = ''
    public requestToken = ''
    public cookies: { mobile: Cookie[]; desktop: Cookie[] }
    public fingerprint!: BrowserFingerprintWithHeaders
    public accounts: Account[] = [] // DIUBAH JADI PUBLIC AGAR DISCORDBOT AMAN
    public workers: Workers          // DIUBAH JADI PUBLIC AGAR SEARCHMANAGER AMAN
    public localProxy: DynamicOutboundProxy | null = null
    public localProxyPort = 0
    public activeAccount: Account | null = null
    public isRunning = false
    public stopRequested = false
    private dashboardServerActive = false

    private activeWorkers: number
    private exitedWorkers: number[]
    private browserFactory: Browser = new Browser(this)
    private login = new Login(this)
    private searchManager: SearchManager
    public axios!: AxiosClient

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
        this.rewardsVersion = 'legacy'
        this.accessToken = ''
        this.requestToken = ''
        this.cookies = { mobile: [], desktop: [] }
        this.fingerprint = undefined as any
        this.activeAccount = null
        this.mainMobilePage = undefined as any
        this.mainDesktopPage = undefined as any
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

    get isMobile(): boolean {
        return getCurrentContext().isMobile
    }

    // 🛡️ MODUL IP CHECKER: AMAN JALUR DNS + SUPER HEMAT DATA PAS DITINGGAL TIDUR
    private async getCurrentIP(localProxyPort?: number): Promise<string> {
        try {
            if (this.localProxy) {
                await this.localProxy.ensureWifiConnected()
            }
            await dns.lookup('bing.com');
            const config: any = { timeout: 5000 }
            if (localProxyPort) {
                config.httpAgent = new HttpProxyAgent(`http://127.0.0.1:${localProxyPort}`)
                config.httpsAgent = new HttpsProxyAgent(`http://127.0.0.1:${localProxyPort}`)
            }
            const res = await axios.get('https://ident.me', config);
            return res.data.trim();
        } catch {
            return 'UNKNOWN_IP';
        }
    }

    async initialize(): Promise<void> {
        this.accounts = loadAccounts()
        await Database.getInstance().initialize()
        this.updateDashboardGlobal({
            loadedAccounts: this.accounts.map(a => a.email)
        })
    }

    async run(): Promise<void> {
        const totalAccounts = this.accounts.length
        const runStartTime = Date.now()

        // Start Dashboard Server on primary process if enabled
        if (this.config.useLocalDashboard && (cluster.isPrimary || !cluster.isWorker) && !this.dashboardServerActive) {
            this.dashboardServerActive = true
            const dashboardServer = new DashboardServer(4000)
            await dashboardServer.start().catch((err) => {
                this.logger.error('main', 'DASHBOARD-ERROR', `Failed to start dashboard: ${err.message}`)
            })
            this.logger.info('main', 'DASHBOARD', `Local dashboard server started at http://localhost:4000`, 'green')

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
            registerControlCallback(async (cmd) => {
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
                        this.logger.error('main', 'C2-CONTROL', `Account with email ${cmd.email} not found!`)
                        return
                    }
                    
                    this.logger.info('main', 'C2-CONTROL', `Starting execution for single account: ${targetAcc.email}...`)
                    this.isRunning = true
                    this.stopRequested = false
                    this.updateDashboardGlobal({ isRunning: true, startTime: Date.now() })
                    
                    try {
                        await this.runTasks([targetAcc], Date.now())
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err)
                        this.logger.error('main', 'C2-CONTROL-ERROR', `Execution failed for ${targetAcc.email}: ${errMsg}`)
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

            // Register IP confirm callback
            registerIpConfirmCallback(() => {
                if (manualIpConfirmResolver) {
                    const res = manualIpConfirmResolver
                    manualIpConfirmResolver = null
                    res()
                }
            })

            // Register exit cleanup
            const stopDashboard = async () => {
                await dashboardServer.stop()
            }
            process.on('SIGINT', stopDashboard)
            process.on('SIGTERM', stopDashboard)
            process.on('exit', stopDashboard)

            this.logger.info('main', 'C2-STANDBY', 'Command & Control Active. Waiting for commands via Web UI...', 'cyan')
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

            worker.on('message', (msg: { __ipcLog?: IpcLog; __stats?: AccountStats[]; __dashboardUpdate?: { email: string; update: any }; __dashboardGlobal?: any }) => {
                if (msg.__stats) {
                    allAccountStats.push(...msg.__stats)
                }
                if (msg.__dashboardUpdate) {
                    updateDashboardAccount(msg.__dashboardUpdate.email, msg.__dashboardUpdate.update)
                }
                if (msg.__dashboardGlobal) {
                    updateDashboardGlobal(msg.__dashboardGlobal)
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
            })

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
                this.logger.error('main', 'CLUSTER-WORKER-ERROR', `Worker task crash: ${error instanceof Error ? error.message : String(error)}`)
                await flushAllWebhooks()
                process.exit(1)
            }
        })
    }

    private async runTasks(accounts: Account[], runStartTime: number): Promise<AccountStats[]> {
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
            this.resetAccountState()
            const accountStartTime = Date.now()
            const accountEmail = account.email
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

            try {
                const randomStartDelay = Math.floor(Math.random() * (60000 - 10000 + 1)) + 10000;
                this.logger.info('main', 'STEALTH', `Menunggu ${(randomStartDelay / 1000).toFixed(0)} detik sebelum buka browser biar keliatan natural...`, 'cyan')
                this.updateDashboardAccount(accountEmail, { status: 'Stealth Delay' })
                await this.utils.wait(randomStartDelay);

                this.logger.info('main', 'ACCOUNT-START', `[ACCOUNT-START] Starting workflow for: ${accountEmail} | geoLocale: ${account.geoLocale}`)
                this.updateDashboardAccount(accountEmail, { status: 'Starting Browser' })
                this.axios = new AxiosClient(account.proxy, this.localProxyPort)

                const result = await this.Main(account).catch(error => {
                    const errMsg = error instanceof Error ? error.message : String(error)
                    void this.logger.error(true, 'FLOW', `Mobile flow failed for ${accountEmail}: ${errMsg}`)
                    this.updateDashboardAccount(accountEmail, { status: 'Error', error: errMsg })
                    return undefined
                })

                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)

                if (result) {
                    const collectedPoints = result.collectedPoints ?? 0
                    const accountInitialPoints = result.initialPoints ?? 0
                    const accountFinalPoints = accountInitialPoints + collectedPoints

                    accountStats.push({
                        email: accountEmail, initialPoints: accountInitialPoints, finalPoints: accountFinalPoints,
                        collectedPoints: collectedPoints, duration: parseFloat(durationSeconds), success: true
                    })

                    this.logger.info('main', 'ACCOUNT-FINISH', `[ACCOUNT-FINISH] Completed workflow for: ${accountEmail} | Total: +${collectedPoints} | Old: ${accountInitialPoints} → New: ${accountFinalPoints} | Duration: ${durationSeconds}s`, 'green')
                    this.updateDashboardAccount(accountEmail, {
                        status: 'Completed',
                        collectedPoints: collectedPoints
                    })
                } else {
                    accountStats.push({
                        email: accountEmail, initialPoints: 0, finalPoints: 0, collectedPoints: 0,
                        duration: parseFloat(durationSeconds), success: false, error: 'Flow failed'
                    })
                    this.updateDashboardAccount(accountEmail, {
                        status: 'Failed',
                        error: 'Flow failed'
                    })
                }
            } catch (error) {
                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)
                const errMsg = error instanceof Error ? error.message : String(error)
                this.logger.error('main', 'ACCOUNT-ERROR', `${accountEmail}: ${errMsg}`)
                accountStats.push({
                    email: accountEmail, initialPoints: 0, finalPoints: 0, collectedPoints: 0,
                    duration: parseFloat(durationSeconds), success: false, error: errMsg
                })
                this.updateDashboardAccount(accountEmail, {
                    status: 'Failed',
                    error: errMsg
                })
            } finally {
                this.resetAccountState()
            }

            processedCount++
            
            // =======================================================
            // 🤖 AUTO-ROTATE DENGAN PROTECTION LOOP + DATA SAVER CLI
            // =======================================================
            if (processedCount % 2 === 0 && processedCount < accounts.length) {
                let ipChanged = false
                const oldIp = currentIpAddress
                const isManual = this.config.useDynamicWifiProxy || !this.config.useAdbIpRotation

                while (!ipChanged) {
                    if (this.stopRequested) {
                        this.logger.warn('main', 'IP-INTERCEPTOR', 'IP rotation aborted due to user stop request.')
                        break
                    }

                    this.logger.warn('main', 'IP-INTERCEPTOR', '=======================================================', 'yellow')
                    this.logger.warn('main', 'IP-INTERCEPTOR', `🔥 BATCH [${processedCount / 2}] SELESAI! ROTASI IP ${isManual ? 'MANUAL (LAN / HOTSPOT)' : 'AUTO (ADB AIRPLANE MODE)'} DIMULAI... 🔥`, 'yellow')
                    this.logger.warn('main', 'IP-INTERCEPTOR', `IP Saat Ini: [ ${oldIp} ]`, 'yellow')
                    this.logger.warn('main', 'IP-INTERCEPTOR', '=======================================================', 'yellow')

                    try {
                        if (isManual) {
                            try {
                                require('child_process').exec(`powershell -c (New-Object Media.SoundPlayer "C:\\Windows\\Media\\notify.wav").PlaySync();`);
                            } catch {}

                            this.logger.info('main', 'IP-INTERCEPTOR', '📌 SILAKAN MATIKAN & NYALAKAN MODE PESAWAT / HOTSPOT DI HP ANDA.', 'cyan')
                            this.logger.info('main', 'IP-INTERCEPTOR', '👉 Tekan [ENTER] di terminal atau klik [Confirm IP Rotated] di Web UI setelah selesai...', 'cyan')

                            await waitForUserConfirmation()

                            this.logger.info('main', 'IP-INTERCEPTOR', 'Memeriksa perubahan IP publik baru...')
                        } else {
                            const execSync = require('child_process').execSync;
                            this.logger.info('main', 'IP-INTERCEPTOR', 'ADB -> Mengaktifkan Mode Pesawat...');
                            execSync('adb shell cmd connectivity airplane-mode enable');
                            await this.utils.wait(5000);

                            this.logger.info('main', 'IP-INTERCEPTOR', 'ADB -> Mematikan Mode Pesawat (Mencari Sinyal Baru)...');
                            execSync('adb shell cmd connectivity airplane-mode disable');
                            
                            this.logger.info('main', 'IP-INTERCEPTOR', 'Menunggu 12 detik agar interface sinyal stabil...');
                            await this.utils.wait(12000);
                        }
                        
                        const checkNewIp = await this.getCurrentIP(this.localProxyPort || undefined)

                        if (checkNewIp !== oldIp && checkNewIp !== 'UNKNOWN_IP') {
                            currentIpAddress = checkNewIp
                            ipChanged = true
                            this.logger.info('main', 'IP-INTERCEPTOR', `🚀 SUKSES! IP Baru Terdeteksi: [ ${currentIpAddress} ]`, 'green')
                            this.updateDashboardGlobal({ currentIP: currentIpAddress })
                            await this.utils.wait(3000)
                        } else {
                            this.logger.error('main', 'IP-INTERCEPTOR', `❌ GAGAL! IP masih kembar [ ${checkNewIp} ]. Silakan coba matikan/nyalakan ulang hotspot...`, 'red')
                            try {
                                require('child_process').exec(`powershell -c (New-Object Media.SoundPlayer "C:\\Windows\\Media\\notify.wav").PlaySync();`);
                            } catch {}
                            await this.utils.wait(3000)
                        }
                    } catch (adbError) {
                        this.logger.error('main', 'IP-INTERCEPTOR', `🚨 Jalur Jaringan Lemot/IP Glitch: ${adbError}`, 'red')
                        await this.utils.wait(3000)
                    }
                }
            }
        }

        if (this.config.clusters <= 1 && cluster.isPrimary) {
            const totalCollected = accountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
            const totalInitial = accountStats.reduce((sum, s) => sum + s.initialPoints, 0)
            const totalFinal = accountStats.reduce((sum, s) => sum + s.finalPoints, 0)
            const totalDuration = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

            this.logger.info('main', 'RUN-END', `Completed all accounts | Accounts processed: ${accountStats.length} | Total points collected: +${totalCollected} | Old total: ${totalInitial} → New total: ${totalFinal} | Total runtime: ${totalDuration}min`, 'green')
            await flushAllWebhooks()
            if (this.localProxy) {
                await this.localProxy.stop()
            }
            process.exit(0)
        }

        if (this.localProxy) {
            await this.localProxy.stop()
        }
        return accountStats
    }

    async Main(account: Account): Promise<{ initialPoints: number; collectedPoints: number }> {
        const accountEmail = account.email
        this.logger.info('main', 'FLOW', `Starting session for ${accountEmail}`)

        let mobileSession: BrowserSession | null = null
        let mobileContextClosed = false

        try {
            return await executionContext.run({ isMobile: true, account }, async () => {
                mobileSession = await this.browserFactory.createBrowser(account)
                const initialContext: BrowserContext = mobileSession.context
                this.mainMobilePage = await initialContext.newPage()

                this.logger.info('main', 'BROWSER', `Mobile Browser started | ${accountEmail}`)

                await this.login.login(this.mainMobilePage, account)

                try {
                    this.accessToken = await this.login.getAppAccessToken(this.mainMobilePage, accountEmail)
                } catch (error) {
                    this.logger.error('main', 'FLOW', `Failed to get mobile access token: ${error instanceof Error ? error.message : String(error)}`)
                }

                // Pastikan browser sudah mendarat di Dashboard Rewards & sinkronisasi cookies aktif
                await this.mainMobilePage.goto(this.config.baseURL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
                await this.login.verifyBingSession(this.mainMobilePage)
                await this.utils.wait(2000)

                this.cookies.mobile = await initialContext.cookies()
                this.fingerprint = mobileSession.fingerprint

                let appData: AppDashboardData | null = null
                try {
                    appData = await this.browser.func.getAppDashboardData()
                } catch {}

                const detectedCountry = (appData?.response?.profile?.attributes?.country || 'ID').toUpperCase()
                this.userData.geoLocale = account.geoLocale === 'auto' ? detectedCountry : account.geoLocale.toLowerCase()

                const data: DashboardData = await this.browser.func.getDashboardData()
                
                this.userData.initialPoints = data.userStatus.availablePoints
                this.userData.currentPoints = data.userStatus.availablePoints
                const initialPoints = this.userData.initialPoints ?? 0

                const pcProg = data.userStatus.counters.pcSearch?.[0] ? `${data.userStatus.counters.pcSearch[0].pointProgress}/${data.userStatus.counters.pcSearch[0].pointProgressMax}` : '0/0'
                const edgeProg = data.userStatus.counters.pcSearch?.[1] && data.userStatus.counters.pcSearch[1].pointProgressMax > 0 ? ` (+${data.userStatus.counters.pcSearch[1].pointProgress}/${data.userStatus.counters.pcSearch[1].pointProgressMax} Edge)` : ''
                const desktopProgress = `${pcProg}${edgeProg}`
                const mobileProgress = data.userStatus.counters.mobileSearch?.[0] ? `${data.userStatus.counters.mobileSearch[0].pointProgress}/${data.userStatus.counters.mobileSearch[0].pointProgressMax}` : '0/0'

                this.updateDashboardAccount(accountEmail, {
                    initialPoints,
                    desktopProgress,
                    mobileProgress,
                    status: 'Processing Tasks'
                })

                const browserEarnable = await this.browser.func.getBrowserEarnablePoints()
                this.logger.info('main', 'POINTS', `Earnable today | Mobile: ${browserEarnable.mobileSearchPoints} | Browser: ${browserEarnable.mobileSearchPoints} | ${accountEmail}`)

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

                if (this.config.workers.doDailyCheckIn) {
                    this.updateDashboardAccount(accountEmail, { status: 'Daily Check-in' })
                    await this.activities.doDailyCheckIn()
                }

                if (this.config.workers.doReadToEarn) {
                    this.updateDashboardAccount(accountEmail, { status: 'Read to Earn' })
                    await this.activities.doReadToEarn()
                }

                if (this.config.workers.doPunchCards && data && this.mainMobilePage) {
                    this.updateDashboardAccount(accountEmail, { status: 'Punch Cards' })
                    await this.workers.doPunchCards(data, this.mainMobilePage)
                }

                this.updateDashboardAccount(accountEmail, { status: 'Searching...' })
                const searchPoints = await this.browser.func.getSearchPoints()
                const missingSearchPoints = this.browser.func.missingSearchPoints(searchPoints, true)

                // update search progress before search loop
                const startPcProg = searchPoints.pcSearch?.[0] ? `${searchPoints.pcSearch[0].pointProgress}/${searchPoints.pcSearch[0].pointProgressMax}` : '0/0'
                const startEdgeProg = searchPoints.pcSearch?.[1] && searchPoints.pcSearch[1].pointProgressMax > 0 ? ` (+${searchPoints.pcSearch[1].pointProgress}/${searchPoints.pcSearch[1].pointProgressMax} Edge)` : ''
                const startDesktopProgress = `${startPcProg}${startEdgeProg}`
                const startMobileProgress = searchPoints.mobileSearch?.[0] ? `${searchPoints.mobileSearch[0].pointProgress}/${searchPoints.mobileSearch[0].pointProgressMax}` : '0/0'

                this.updateDashboardAccount(accountEmail, {
                    desktopProgress: startDesktopProgress,
                    mobileProgress: startMobileProgress
                })

                this.cookies.mobile = await initialContext.cookies()

                const { mobilePoints, desktopPoints } = await this.searchManager.doSearches(data, missingSearchPoints, mobileSession, account, accountEmail)

                // Post-Search Re-Evaluation: Re-fetch dashboard data to claim punchcards completed by searches (e.g. 4-day search challenges) and any remaining pending points!
                try {
                    const postSearchData = await this.browser.func.getDashboardData().catch(() => null)
                    if (postSearchData) {
                        const activePage = (this.mainMobilePage && !this.mainMobilePage.isClosed()) 
                            ? this.mainMobilePage 
                            : (this.mainDesktopPage && !this.mainDesktopPage.isClosed()) 
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

                this.logger.info('main', 'FLOW', `Collected: +${collectedPoints} | Mobile: +${mobilePoints} | Desktop: +${desktopPoints} | ${accountEmail}`)

                return { initialPoints, collectedPoints: collectedPoints || 0 }
            })
        } finally {
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

    process.on('beforeExit', () => { void flushAllWebhooks() })
    process.on('SIGINT', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGINT received, flushing and exiting...')
        await flushAllWebhooks()
        process.exit(130)
    })
    process.on('SIGTERM', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', 'SIGTERM received, flushing and exiting...')
        await flushAllWebhooks()
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
    }
}

main().catch(async error => {
    const tmpBot = new MicrosoftRewardsBot()
    tmpBot.logger.error('main', 'MAIN-ERROR', error as Error)
    await flushAllWebhooks()
    process.exit(1)
})