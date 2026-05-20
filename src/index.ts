import { AsyncLocalStorage } from 'node:async_hooks'
import cluster, { Worker } from 'cluster'
import type { BrowserContext, Cookie, Page } from 'patchright'
import readline from 'node:readline'
import axios from 'axios' // FIX RPL: Gunakan axios mentah untuk cek IP publik network utama
import pkg from '../package.json'

import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'

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

    private pointsCanCollect = 0

    private activeWorkers: number
    private exitedWorkers: number[]
    private browserFactory: Browser = new Browser(this)
    private accounts: Account[] = []
    private workers: Workers
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
            gainedPoints: 0
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

    get isMobile(): boolean {
        return getCurrentContext().isMobile
    }

    // FIX RPL: Helper function buat nembak ipify tanpa lewat proxy biar akurat dapet IP internet asli komputer
    private async getCurrentIP(): Promise<string> {
        return await axios.get('https://api.ipify.org', { timeout: 5000 })
            .then(res => res.data.trim())
            .catch(() => 'UNKNOWN_IP')
    }

    async initialize(): Promise<void> {
        this.accounts = loadAccounts()
    }

    async run(): Promise<void> {
        const totalAccounts = this.accounts.length
        const runStartTime = Date.now()

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

            worker.on('message', (msg: { __ipcLog?: IpcLog; __stats?: AccountStats[] }) => {
                if (msg.__stats) {
                    allAccountStats.push(...msg.__stats)
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

        // Ambil data IP pertama pas start script
        let currentIpAddress = await this.getCurrentIP()
        this.logger.info('main', 'NETWORK', `Current Active IP: [ ${currentIpAddress} ]`)

        for (const account of accounts) {
            const accountStartTime = Date.now()
            const accountEmail = account.email
            this.userData.userName = this.utils.getEmailUsername(accountEmail)

            try {
                this.logger.info('main', 'ACCOUNT-START', `Starting account: ${accountEmail} | geoLocale: ${account.geoLocale}`)
                this.axios = new AxiosClient(account.proxy)

                const result = await this.Main(account).catch(error => {
                    void this.logger.error(true, 'FLOW', `Mobile flow failed for ${accountEmail}: ${error instanceof Error ? error.message : String(error)}`)
                    return undefined
                })

                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)

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
                        success: true
                    })

                    this.logger.info('main', 'ACCOUNT-END', `Completed account: ${accountEmail} | Total: +${collectedPoints} | Old: ${accountInitialPoints} → New: ${accountFinalPoints} | Duration: ${durationSeconds}s`, 'green')
                } else {
                    accountStats.push({
                        email: accountEmail, initialPoints: 0, finalPoints: 0, collectedPoints: 0,
                        duration: parseFloat(durationSeconds), success: false, error: 'Flow failed'
                    })
                }
            } catch (error) {
                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)
                this.logger.error('main', 'ACCOUNT-ERROR', `${accountEmail}: ${error instanceof Error ? error.message : String(error)}`)
                accountStats.push({
                    email: accountEmail, initialPoints: 0, finalPoints: 0, collectedPoints: 0,
                    duration: parseFloat(durationSeconds), success: false, error: error instanceof Error ? error.message : String(error)
                })
            }

            processedCount++
            if (processedCount % 2 === 0 && processedCount < accounts.length) {
                let ipChanged = false
                const oldIp = currentIpAddress

                // LOOP PROTECTION: Kunci thread dan paksa user ganti IP sampai strings IP-nya beneran beda
                while (!ipChanged) {
                    this.logger.warn('main', 'IP-INTERCEPTOR', '=======================================================', 'yellow')
                    this.logger.warn('main', 'IP-INTERCEPTOR', `🔥 BATCH [${processedCount / 2}] SELESAI! SAATNYA ROTASI IP HOTSPOT! 🔥`, 'yellow')
                    this.logger.warn('main', 'IP-INTERCEPTOR', `Current IP registered: [ ${oldIp} ]`, 'yellow')
                    this.logger.warn('main', 'IP-INTERCEPTOR', '1. Nyalakan "Mode Pesawat" di HP lu selama 5 detik.', 'yellow')
                    this.logger.warn('main', 'IP-INTERCEPTOR', '2. Matikan "Mode Pesawat" & tunggu hotspot PC konek kembali.', 'yellow')
                    this.logger.warn('main', 'IP-INTERCEPTOR', '=======================================================', 'yellow')
                    
                    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
                    await new Promise<void>(resolve => rl.question('👉 Jika PC sudah dapet internet baru, pencet [ENTER] buat verifikasi...', () => resolve()))
                    rl.close()

                    this.logger.info('main', 'IP-INTERCEPTOR', 'Checking network configuration telemetry...')
                    const checkNewIp = await this.getCurrentIP()

                    if (checkNewIp !== oldIp && checkNewIp !== 'UNKNOWN_IP') {
                        currentIpAddress = checkNewIp
                        ipChanged = true
                        this.logger.info('main', 'IP-INTERCEPTOR', `🚀 IP Baru Terdeteksi: [ ${currentIpAddress} ]! Meluncur ke batch berikutnya...`, 'green')
                        await this.utils.wait(3000)
                    } else {
                        this.logger.error('main', 'IP-INTERCEPTOR', `❌ VERIFIKASI GAGAL! IP PC lu masih [ ${checkNewIp} ]. Tolong nyalakan mode pesawat HP dulu biar ganti IP!`, 'red')
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
            process.exit(0)
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

                this.cookies.mobile = await initialContext.cookies()
                this.fingerprint = mobileSession.fingerprint

                const data: DashboardData = await this.browser.func.getDashboardData()
                const appData: AppDashboardData = await this.browser.func.getAppDashboardData()
                
                this.userData.geoLocale = account.geoLocale === 'auto' ? data.userProfile.attributes.country : account.geoLocale.toLowerCase()
                
                this.userData.initialPoints = data.userStatus.availablePoints
                this.userData.currentPoints = data.userStatus.availablePoints
                const initialPoints = this.userData.initialPoints ?? 0

                const browserEarnable = await this.browser.func.getBrowserEarnablePoints()
                const appEarnable = await this.browser.func.getAppEarnablePoints()

                this.pointsCanCollect = browserEarnable.mobileSearchPoints + (appEarnable?.totalEarnablePoints ?? 0)

                this.logger.info('main', 'POINTS', `Earnable today | Mobile: ${this.pointsCanCollect} | Browser: ${browserEarnable.mobileSearchPoints} | App: ${appEarnable?.totalEarnablePoints ?? 0} | ${accountEmail} | locale: ${this.userData.geoLocale}`)

                if (this.config.workers.doAppPromotions && appData) {
                    await this.workers.doAppPromotions(appData)
                }

                if (this.config.workers.doDailySet && data && this.mainMobilePage) {
                    await this.workers.doDailySet(data, this.mainMobilePage)
                }

                if (this.config.workers.doSpecialPromotions && data && this.mainMobilePage) {
                    await this.workers.doSpecialPromotions(data, this.mainMobilePage)
                }

                if (this.config.workers.doMorePromotions && data && this.mainMobilePage) {
                    await this.workers.doMorePromotions(data, this.mainMobilePage)
                }

                if (this.config.workers.doDailyCheckIn) {
                    await this.activities.doDailyCheckIn()
                }

                if (this.config.workers.doReadToEarn) {
                    await this.activities.doReadToEarn()
                }

                if (this.config.workers.doPunchCards && data && this.mainMobilePage) {
                    await this.workers.doPunchCards(data, this.mainMobilePage)
                }

                const searchPoints = await this.browser.func.getSearchPoints()
                const missingSearchPoints = this.browser.func.missingSearchPoints(searchPoints, true)

                this.cookies.mobile = await initialContext.cookies()

                const { mobilePoints, desktopPoints } = await this.searchManager.doSearches(data, missingSearchPoints, mobileSession, account, accountEmail)

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