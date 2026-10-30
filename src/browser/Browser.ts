import rebrowser, { BrowserContext } from 'patchright'
import type { MicrosoftRewardsBot } from '../index'
import { loadSessionData } from '../util/Load'
import { BrowserEnvironmentPolicy } from '../runtime/environment/BrowserEnvironmentPolicy'
import { AccountSessionStore } from '../runtime/session/AccountSessionStore'
import { UserAgentManager } from './UserAgent'
import type { Account, AccountProxy } from '../interface/Account'
import type { AccountScope } from '../runtime/AccountScope'

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
                        setTimeout(() => reject(new Error('Browser recycle timeout')), 3000)
                    )
                ])
            } catch {
                try {
                    const proc = this.currentBrowser.process?.()
                    if (proc && !proc.killed && typeof proc.kill === 'function') {
                        proc.kill('SIGKILL')
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

    /**
     * Persists browser session storageState safely without throwing unhandled rejections.
     */
    public async saveSession(
        contextOrBrowser?: any,
        isMobile?: boolean,
        timeoutMs = 5000
    ): Promise<boolean> {
        try {
            const scope = this.bot.accountScope
            if (!scope) return false

            const targetDevice = (typeof isMobile === 'boolean' ? isMobile : this.bot.isMobile) ? 'mobile' : 'desktop'
            const ctx = contextOrBrowser || (targetDevice === 'mobile' ? scope.getContext('mobile') : scope.getContext('desktop'))
            if (!ctx) return false

            return await AccountSessionStore.saveSession(ctx, scope, targetDevice, timeoutMs)
        } catch (err) {
            this.bot.logger.warn(
                Boolean(isMobile),
                'BROWSER-SESSION',
                `Non-fatal error persisting session: ${err instanceof Error ? err.message : String(err)}`
            )
            return false
        }
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

            browser = await rebrowser.chromium.launch({
                headless: this.bot.config.headless === true,
                channel: this.bot.config.headless ? undefined : 'chrome',
                args: [...Browser.BROWSER_ARGS],
                proxy: proxyConfig
            } as any)

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
            const deviceProfile = this.bot.isMobile ? this.bot.accountScope?.deviceProfile : undefined
            const profile = BrowserEnvironmentPolicy.resolveProfile(
                this.bot.isMobile ? 'mobile' : 'desktop',
                undefined,
                deviceProfile,
                account.email
            )
            const contextOptions = BrowserEnvironmentPolicy.toContextOptions(profile)
            if (storageStateForContext) {
                contextOptions.storageState = storageStateForContext
            }

            const context = await browser.newContext(contextOptions)

            // Terapkan override deterministik WebGL, Device Memory & CDP Client Hints (Mobile & Desktop)
            await this.applyDeterministicOverrides(context, this.bot.isMobile, profile, deviceProfile)

            context.setDefaultTimeout(this.bot.utils.stringToNumber(this.bot.config?.globalTimeout ?? 30000))

            // ==================== ULTRA DATA SAVER (HEMAT KUOTA 80%-90%) ====================
            const routeHandler = (route: any) => {
                const req = route.request()
                const type = req.resourceType()
                const url = req.url().toLowerCase()

                // Whitelist telemetri penting & verifikasi poin (tracking pixel 1x1 & telemetry beacons): JANGAN PERNAH dibatalkan
                const isRewardsTelemetry =
                    url.includes('/fd/ls/lsp.aspx') ||
                    url.includes('/fd/ls/') ||
                    url.includes('c.bing.com/c.gif') ||
                    url.includes('c.bing.com') ||
                    url.includes('/rewards/api/') ||
                    url.includes('/rewards/log') ||
                    url.includes('activityid=')

                if (isRewardsTelemetry) {
                    return route.continue().catch(() => {})
                }

                // 1. Blokir resource tipe berat non-telemetri (Video, Audio, Font, WebSocket)
                if (type === 'media' || type === 'font' || type === 'websocket') {
                    this.bot.trackBlockedRequest()
                    return route.abort().catch(() => {})
                }

                // 2. Blokir ketat seluruh gambar di semua domain (termasuk rewards.bing.com), kecuali tracking pixel 1x1
                if (type === 'image') {
                    const isTrackingPixel = url.includes('lsp.aspx') || url.includes('c.gif')
                    if (!isTrackingPixel) {
                        this.bot.trackBlockedRequest()
                        return route.abort().catch(() => {})
                    }
                }

                // 3. Blokir domain iklan, pelacak berat Microsoft/Bing/MSN, dan tracker pihak ketiga
                if (
                    url.includes('vortex.data.microsoft.com') ||
                    url.includes('browser.pipe.aria.microsoft.com') ||
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

                // 4. Whitelist endpoint API Rewards penting & dokumen navigasi (bukan aset global)
                const isRewardsEndpoint =
                    url.includes('/api/getuserinfo') ||
                    url.includes('/rewards/api/') ||
                    (url.includes('rewards.bing.com') && (url.includes('/api/') || type === 'document' || type === 'script' || type === 'stylesheet'))

                if (isRewardsEndpoint) {
                    return route.continue().catch(() => {})
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

    async createManualBrowser(account: Account, scope: AccountScope): Promise<{ browser: any; context: any; page: any }> {
        if (process.platform === 'linux' && !process.env.DISPLAY) {
            throw new Error('Display server tidak terdeteksi. Buka terminal desktop GUI Lubuntu.')
        }

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

        let storageStateForContext: any = undefined
        const sessionResult = await AccountSessionStore.loadSession(
            scope,
            'desktop',
            { legacyEmail: account.email }
        )

        if (sessionResult.status === 'loaded') {
            const cleanCookies = (sessionResult.state.cookies || []).filter(c => {
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
        }

        const deviceProfile = scope.deviceProfile
        const profile = BrowserEnvironmentPolicy.resolveProfile(
            'desktop',
            undefined,
            deviceProfile,
            account.email
        )
        const contextOptions = BrowserEnvironmentPolicy.toContextOptions(profile)
        if (storageStateForContext) {
            contextOptions.storageState = storageStateForContext
        }

        let browser: any
        try {
            browser = await rebrowser.chromium.launch({
                headless: false,
                channel: 'chrome',
                args: [...Browser.BROWSER_ARGS],
                proxy: proxyConfig
            } as any)
        } catch {
            browser = await rebrowser.chromium.launch({
                headless: false,
                args: [...Browser.BROWSER_ARGS],
                proxy: proxyConfig
            } as any)
        }

        const context = await browser.newContext(contextOptions)
        await this.applyDeterministicOverrides(context, false, profile, deviceProfile)
        const page = await context.newPage()
        await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})

        return { browser, context, page }
    }

    private async applyDeterministicOverrides(
        context: any,
        isMobile: boolean,
        profile: any,
        deviceProfile?: any
    ): Promise<void> {
        const fakeVendor = isMobile
            ? (deviceProfile?.webglVendor || 'ARM')
            : 'Google Inc. (NVIDIA)'
        const fakeRenderer = isMobile
            ? (deviceProfile?.webglRenderer || 'Mali-G710 MP7')
            : 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'

        await context.addInitScript(({ isMobile, fakeVendor, fakeRenderer }: any) => {
            try {
                Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {
                    get: () => 8,
                    configurable: true
                })
            } catch {
                try {
                    Object.defineProperty(navigator, 'hardwareConcurrency', {
                        get: () => 8,
                        configurable: true
                    })
                } catch {}
            }

            try {
                Object.defineProperty(Navigator.prototype, 'deviceMemory', {
                    get: () => 8,
                    configurable: true
                })
            } catch {
                try {
                    Object.defineProperty(navigator, 'deviceMemory', {
                        get: () => 8,
                        configurable: true
                    })
                } catch {}
            }

            try {
                const getParameterProto = WebGLRenderingContext.prototype.getParameter
                const getParameterProto2 = typeof WebGL2RenderingContext !== 'undefined'
                    ? WebGL2RenderingContext.prototype.getParameter
                    : null

                const unmaskedVendorId = 0x9245
                const unmaskedRendererId = 0x9246
                const vendorId = 0x1f00
                const rendererId = 0x1f01

                const wrapGetParameter = function(originalFn: any) {
                    return function(this: any, param: number) {
                        if (param === unmaskedVendorId || param === vendorId) {
                            return fakeVendor
                        }
                        if (param === unmaskedRendererId || param === rendererId) {
                            return fakeRenderer
                        }
                        return originalFn.apply(this, arguments)
                    }
                }

                WebGLRenderingContext.prototype.getParameter = wrapGetParameter(getParameterProto)
                if (getParameterProto2) {
                    WebGL2RenderingContext.prototype.getParameter = wrapGetParameter(getParameterProto2)
                }
            } catch {}
        }, { isMobile, fakeVendor, fakeRenderer })

        const targetUa = profile?.userAgent || (isMobile ? UserAgentManager.DEFAULT_MOBILE_UA : UserAgentManager.DEFAULT_DESKTOP_UA)
        const brands = [
            { brand: 'Not_A Brand', version: '8' },
            { brand: 'Chromium', version: '130' },
            { brand: 'Microsoft Edge', version: '130' }
        ]
        const userAgentMetadata = isMobile
            ? {
                  brands,
                  fullVersion: '130.0.2849.68',
                  platform: 'Android',
                  platformVersion: '14.0.0',
                  architecture: 'arm',
                  model: deviceProfile?.deviceModel || 'Pixel 7',
                  mobile: true,
                  bitness: '64'
              }
            : {
                  brands,
                  fullVersion: '130.0.2849.68',
                  platform: 'Windows',
                  platformVersion: '10.0.0',
                  architecture: 'x86',
                  model: '',
                  mobile: false,
                  bitness: '64'
              }

        const overrideScript = `
        try {
            Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 8, configurable: true });
            Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 8, configurable: true });
        } catch (e) {}
        try {
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
            Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });
        } catch (e) {}
        try {
            const origGet = WebGLRenderingContext.prototype.getParameter;
            WebGLRenderingContext.prototype.getParameter = function(param) {
                if (param === 0x9245 || param === 0x1f00) return ${JSON.stringify(fakeVendor)};
                if (param === 0x9246 || param === 0x1f01) return ${JSON.stringify(fakeRenderer)};
                return origGet.apply(this, arguments);
            };
            if (typeof WebGL2RenderingContext !== 'undefined') {
                const origGet2 = WebGL2RenderingContext.prototype.getParameter;
                WebGL2RenderingContext.prototype.getParameter = function(param) {
                    if (param === 0x9245 || param === 0x1f00) return ${JSON.stringify(fakeVendor)};
                    if (param === 0x9246 || param === 0x1f01) return ${JSON.stringify(fakeRenderer)};
                    return origGet2.apply(this, arguments);
                };
            }
        } catch (e) {}
        `

        const applyCdp = async (page: any) => {
            try {
                const cdp = await context.newCDPSession(page)
                if (this.bot.accountScope) {
                    this.bot.accountScope.trackCdpSession(cdp)
                }
                await cdp.send('Page.enable')
                await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: overrideScript })
                await cdp.send('Network.setUserAgentOverride', {
                    userAgent: targetUa,
                    acceptLanguage: 'en-US,en;q=0.9',
                    platform: isMobile ? 'Android' : 'Windows',
                    userAgentMetadata
                })
            } catch {}
        }

        context.on('page', (page: any) => {
            applyCdp(page).catch(() => {})
        })
        for (const p of context.pages()) {
            applyCdp(p).catch(() => {})
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
