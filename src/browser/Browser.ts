import fs from 'fs'
import rebrowser, { BrowserContext } from 'patchright'
import type { MicrosoftRewardsBot } from '../index'
import { loadSessionData } from '../util/Load'
import { BrowserEnvironmentPolicy } from '../runtime/environment/BrowserEnvironmentPolicy'
import { AccountSessionStore } from '../runtime/session/AccountSessionStore'
import { SessionPathResolver } from '../runtime/session/SessionPathResolver'
import type { Account, AccountProxy } from '../interface/Account'

export interface BrowserCreationResult {
    context: BrowserContext
    fingerprint?: any
}

class Browser {
    private readonly bot: MicrosoftRewardsBot
    public isHealthy = true
    private currentBrowser: any = null

    private static readonly BROWSER_ARGS = [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--mute-audio',
        '--disable-setuid-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-web-authentication-ui',
        '--disable-external-intent-requests',
        '--disable-features=WebAuthentication,PasswordManagerOnboarding,PasswordManager,EnablePasswordsAccountStorage,Passkeys,WebAuthenticationProxy,U2F,Translate,OptimizationHints,MediaRouter',
        '--disable-save-password-bubble',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-domain-reliability',
        '--disable-sync',
        '--dns-prefetch-disable',
        '--disable-client-side-phishing-detection',
        '--disable-default-apps',
        '--disable-breakpad',
        '--disable-component-extensions-with-background-pages'
    ] as const

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    public getCurrentBrowserProcess(): any {
        return this.currentBrowser
    }

    public async recycleBrowser(): Promise<void> {
        this.isHealthy = false
        if (this.currentBrowser) {
            try {
                await Promise.race([
                    this.currentBrowser.close(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Browser recycle timeout')), 5000)
                    )
                ])
            } catch {
                try {
                    const proc = this.currentBrowser.process?.()
                    if (proc && !proc.killed && typeof proc.kill === 'function') {
                        proc.kill('SIGKILL')
                    } else if (proc?.pid) {
                        process.kill(proc.pid, 'SIGKILL')
                    }
                } catch {}
            } finally {
                this.currentBrowser = null
                this.isHealthy = true
            }
        } else {
            this.isHealthy = true
        }
    }

    private resolveEdgeExecutablePath(): string | undefined {
        if (this.bot.config.browserPath && fs.existsSync(this.bot.config.browserPath)) {
            return this.bot.config.browserPath
        }

        const candidatePaths: string[] = [
            '/usr/bin/microsoft-edge',
            '/usr/bin/microsoft-edge-stable',
            '/opt/microsoft/msedge/msedge',
            '/opt/microsoft/msedge/microsoft-edge',
            '/var/lib/flatpak/exports/bin/com.microsoft.Edge',
            '/snap/bin/edge'
        ]

        for (const candidate of candidatePaths) {
            try {
                if (fs.existsSync(candidate)) {
                    return candidate
                }
            } catch {}
        }
        return undefined
    }

    async createBrowser(account: Account): Promise<BrowserCreationResult> {
        let browser: any

        try {
            let proxyConfig: any = undefined
            if (account.proxy.url) {
                proxyConfig = {
                    server: this.formatProxyServer(account.proxy),
                    ...(account.proxy.username &&
                        account.proxy.password && {
                            username: account.proxy.username,
                            password: account.proxy.password
                        })
                }
            } else if (this.bot.localProxyPort) {
                proxyConfig = {
                    server: `http://127.0.0.1:${this.bot.localProxyPort}`
                }
            }

            const edgeExecutable = this.resolveEdgeExecutablePath()
            const edgeChannel = this.bot.config.browserChannel || this.bot.config.channel || 'msedge'

            const launchOptions: any = {
                headless: this.bot.config.headless === true,
                channel: edgeChannel,
                args: [...Browser.BROWSER_ARGS],
                proxy: proxyConfig
            }

            if (this.bot.config.browserPath && fs.existsSync(this.bot.config.browserPath)) {
                launchOptions.executablePath = this.bot.config.browserPath
                delete launchOptions.channel
            }

            try {
                browser = await rebrowser.chromium.launch(launchOptions)
            } catch (primaryLaunchError: any) {
                // Defensive fallback: if launching with channel failed, try with direct Linux Edge binary
                if (edgeExecutable && fs.existsSync(edgeExecutable) && launchOptions.channel) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'BROWSER',
                        `Channel '${edgeChannel}' launch failed (${primaryLaunchError?.message}), falling back to executablePath: ${edgeExecutable}`
                    )
                    delete launchOptions.channel
                    launchOptions.executablePath = edgeExecutable
                    browser = await rebrowser.chromium.launch(launchOptions)
                } else {
                    throw primaryLaunchError
                }
            }

            this.currentBrowser = browser
            this.isHealthy = true

            this.bot.logger.info(this.bot.isMobile, 'BROWSER', 'Browser launched successfully')
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error)
            this.bot.logger.error(this.bot.isMobile, 'BROWSER', `Launch failed: ${errorMessage}`)
            throw error
        }

        try {
            const scope = this.bot.accountScope
            let storageStateForContext: any = undefined
            let cleanCookies: any[] = []

            if (scope) {
                const sessionResult = await AccountSessionStore.loadSession(
                    scope,
                    this.bot.isMobile ? 'mobile' : 'desktop',
                    { legacyEmail: account.email }
                )

                if (sessionResult.status === 'loaded') {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'BROWSER',
                        `Session loaded from ${sessionResult.source}`
                    )
                    cleanCookies = (sessionResult.state.cookies || []).filter(c => {
                        const name = (c.name || '').toLowerCase()
                        const val = c.value || ''
                        if (name === 'ak_bmsc' || name === 'bm_sv' || name === 'ai_session') return false
                        if (name === 'usrloc' && val.includes('BLOCK=')) return false
                        if (name === '_rwbf' && (val.includes('c=MY') || val.includes('c=US'))) return false
                        return true
                    })
                    storageStateForContext = {
                        cookies: cleanCookies,
                        origins: sessionResult.state.origins || []
                    }
                } else if (sessionResult.status === 'corrupted') {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'BROWSER',
                        `Account session is corrupted (${sessionResult.reason}). Starting clean context.`
                    )
                } else if (sessionResult.status === 'identity-mismatch') {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'BROWSER',
                        `Session identity mismatch (expected: ${sessionResult.expectedAccountId}, actual: ${sessionResult.actualAccountId}). Starting clean context.`
                    )
                } else if (sessionResult.status === 'unsupported-version') {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'BROWSER',
                        `Unsupported session schema version ${sessionResult.schemaVersion}. Starting clean context.`
                    )
                }
            } else {
                const sessionData = await loadSessionData(
                    this.bot.config.sessionPath,
                    account.email,
                    account.saveFingerprint,
                    this.bot.isMobile
                )
                cleanCookies = (sessionData.cookies || []).filter(c => {
                    const name = (c.name || '').toLowerCase()
                    const val = c.value || ''
                    if (name === 'ak_bmsc' || name === 'bm_sv' || name === 'ai_session') return false
                    if (name === 'usrloc' && val.includes('BLOCK=')) return false
                    if (name === '_rwbf' && (val.includes('c=MY') || val.includes('c=US'))) return false
                    return true
                })
                storageStateForContext = {
                    cookies: cleanCookies,
                    origins: []
                }
            }

            // Resolve clean environment profile & context options (strict TLS, zero synthetic spoofing)
            const profile = BrowserEnvironmentPolicy.resolveProfile(
                this.bot.isMobile ? 'mobile' : 'desktop',
                undefined,
                this.bot.isMobile ? scope?.deviceProfile : undefined,
                account?.email
            )
            const contextOptions = BrowserEnvironmentPolicy.toContextOptions(profile)
            if (storageStateForContext) {
                // Filter origins agar HANYA meloloskan origin http: dan https: yang valid (buang chrome-error://, about:blank, atau origin rusak)
                if (Array.isArray(storageStateForContext.origins)) {
                    storageStateForContext.origins = storageStateForContext.origins.filter((o: any) => {
                        try {
                            if (!o || typeof o.origin !== 'string' || !o.origin.trim()) return false
                            const u = new URL(o.origin)
                            return u.protocol === 'http:' || u.protocol === 'https:'
                        } catch {
                            return false
                        }
                    })
                }
                contextOptions.storageState = storageStateForContext
            }

            let context: any
            try {
                context = await browser.newContext(contextOptions)
            } catch (ctxError: any) {
                const errStr = String(ctxError?.message || ctxError)
                const isStorageStateError =
                    Boolean(contextOptions.storageState) &&
                    (errStr.includes('storage state') ||
                     errStr.includes('storageState') ||
                     errStr.includes('Target page, context or browser has been closed'))

                if (isStorageStateError) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'BROWSER',
                        `⚠️ Inisialisasi storageState gagal (${errStr}). Memindahkan sesi korup ke karantina dan fallback ke clean context...`,
                        'yellow'
                    )
                    if (scope) {
                        const device = this.bot.isMobile ? 'mobile' : 'desktop'
                        const modernPath = SessionPathResolver.getModernPath(
                            scope.storagePaths.sessionDir,
                            scope.identity.accountId,
                            device
                        )
                        await AccountSessionStore.quarantineCorruptFile(
                            scope.storagePaths.sessionDir,
                            scope.identity.accountId,
                            device,
                            modernPath,
                            `browser.newContext failed: ${errStr}`
                        ).catch(() => {})
                    }
                    delete contextOptions.storageState
                    context = await browser.newContext(contextOptions)
                } else {
                    throw ctxError
                }
            }

            context.setDefaultTimeout(this.bot.utils.stringToNumber(this.bot.config?.globalTimeout ?? 30000))

            // Hardware Concurrency Clamping & WebDriver Stealth (Standardize baseline across all contexts)
            await (context as any)
                .addInitScript(() => {
                    try {
                        Object.defineProperty(navigator, 'hardwareConcurrency', {
                            get: () => 8,
                            configurable: true,
                            enumerable: true
                        })
                    } catch {}

                    try {
                        Object.defineProperty(navigator, 'webdriver', {
                            get: () => false,
                            configurable: true
                        })
                    } catch {}
                })
                .catch(() => {})

            // Mobile & Desktop Stealth: Anti-Fingerprint Leak (Mask platform, WebGL vendor/renderer, and apply CDP Client Hints)
            if (this.bot.isMobile) {
                await BrowserEnvironmentPolicy.applyMobileStealth(context, scope?.deviceProfile)
            } else {
                await BrowserEnvironmentPolicy.applyDesktopStealth(context)
            }

            // ==================== ULTRA DATA SAVER (HEMAT KUOTA 80%-90%) ====================
            const routeHandler = (route: any) => {
                const req = route.request()
                const type = req.resourceType()
                const url = req.url().toLowerCase()

                // Whitelist telemetri penting & verifikasi poin: JANGAN PERNAH dibatalkan
                const isRewardsTelemetry =
                    url.includes('/fd/ls/') ||
                    url.includes('/rewards/api/') ||
                    url.includes('c.bing.com') ||
                    url.includes('rewards.bing.com') ||
                    url.includes('activityid=') ||
                    url.includes('/rewards/log') ||
                    url.includes('/fd/ls/lsp.aspx') ||
                    url.includes('rewardsapp/reportactivity')

                // 1. Blokir resource tipe berat non-telemetri (Video, Audio, Font, WebSocket)
                if (type === 'media' || type === 'font' || type === 'websocket') {
                    this.bot.trackBlockedRequest()
                    return route.abort().catch(() => {})
                }

                // 2. Blokir gambar secara absolut (termasuk CDN mm.bing.net, bing.net/th, th.bing.com, sprite /sa/simg/)
                // Hanya izinkan tracking beacon 1x1 esensial (/fd/ls/lsp.aspx)
                if (type === 'image') {
                    const isTelemetryBeacon = url.includes('/fd/ls/lsp.aspx') || url.includes('/fd/ls/')
                    if (!isTelemetryBeacon) {
                        this.bot.trackBlockedRequest()
                        return route.abort().catch(() => {})
                    }
                }

                if (isRewardsTelemetry) {
                    return route.continue().catch(() => {})
                }

                // 3. Blokir domain CDN thumbnail, gambar terkompresi, domain iklan, dan tracker eksternal (JANGAN memblokir /rp/ karena memuat JS inti Bing)
                if (
                    url.includes('bing.net/th') ||
                    url.includes('mm.bing.net') ||
                    url.includes('th.bing.com') ||
                    url.includes('bing.com/sa/simg') ||
                    url.includes('bing.com/th?id=') ||
                    url.includes('static-news.msn.com') ||
                    url.includes('assets.msn.com') ||
                    url.includes('clarity.ms') ||
                    url.includes('adnxs.com') ||
                    url.includes('doubleclick.net') ||
                    url.includes('google-analytics.com') ||
                    url.includes('googletagmanager.com') ||
                    url.includes('scorecardresearch.com') ||
                    url.includes('copilot.microsoft.com') ||
                    url.includes('sydney.bing.com') ||
                    url.includes('/as/api/') || // Bing Ad services
                    url.includes('msn.com/api/news') || // MSN newsfeed video/images payload
                    url.includes('bing.com/overlay') || // Copilot heavy overlay
                    url.includes('bing.com/videos') ||
                    url.includes('bing.com/images') ||
                    url.includes('bing.com/maps') ||
                    url.includes('bing.com/shop') ||
                    url.includes('bing.com/widget') ||
                    url.includes('tiles.virtualearth.net') ||
                    url.includes('edgeservices.bing.com') ||
                    url.includes('c.clarity.ms') ||
                    url.includes('bing.com/as/suggestions') ||
                    url.includes('nav.smartscreen.microsoft.com')
                ) {
                    this.bot.trackBlockedRequest()
                    return route.abort().catch(() => {})
                }

                // Izinkan document HTML, scripts penting Rewards, telemetri event Microsoft, XHR/Fetch API, dan CSS
                return route.continue().catch(() => {})
            }

            const responseListener = async (response: any) => {
                try {
                    const resourceType = response.request().resourceType()
                    const s = await response
                        .request()
                        .sizes()
                        .catch(() => null)
                    if (s && ((s.responseBodySize ?? 0) > 0 || (s.responseHeadersSize ?? 0) > 0)) {
                        this.bot.trackBandwidth((s.responseBodySize ?? 0) + (s.responseHeadersSize ?? 0), resourceType)
                    } else {
                        const len = response.headers()['content-length']
                        if (len) {
                            const bytes = parseInt(len, 10)
                            if (!isNaN(bytes) && bytes > 0) this.bot.trackBandwidth(bytes, resourceType)
                        }
                    }
                } catch {}
            }

            await (context as unknown as BrowserContext).route('**/*', routeHandler)
            ;(context as unknown as BrowserContext).on('response', responseListener)

            // Register handlers with exact references on active AccountScope for precise unrouting
            if (this.bot.accountScope) {
                this.bot.accountScope.registerRouteHandler(context, '**/*', routeHandler)
                this.bot.accountScope.registerResponseListener(context, responseListener)
                this.bot.accountScope.setContext(this.bot.isMobile ? 'mobile' : 'desktop', context)
            }

            const screen = profile.screen
            const viewport = screen ? `${screen.viewport.width}x${screen.viewport.height}` : 'unknown'
            this.bot.logger.info(
                this.bot.isMobile,
                'BROWSER',
                `Browser context created with native environment | viewport=${viewport} mobile=${this.bot.isMobile}`
            )

            return { context: context as unknown as BrowserContext }
        } catch (error) {
            if (browser) {
                await browser.close().catch(() => {})
            }
            throw error
        }
    }

    private formatProxyServer(proxy: AccountProxy): string {
        try {
            const urlObj = new URL(proxy.url)
            const protocol = urlObj.protocol.replace(':', '')
            return `${protocol}://${urlObj.hostname}:${proxy.port}`
        } catch {
            return `${proxy.url}:${proxy.port}`
        }
    }
}

export default Browser
