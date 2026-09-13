import rebrowser, { BrowserContext } from 'patchright'
import type { MicrosoftRewardsBot } from '../index'
import { loadSessionData } from '../util/Load'
import { BrowserEnvironmentPolicy } from '../runtime/environment/BrowserEnvironmentPolicy'
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
        '--mute-audio',
        '--disable-setuid-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-web-authentication-ui',
        '--disable-external-intent-requests',
        '--disable-blink-features=Attestation',
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
            const sessionData = await loadSessionData(
                this.bot.config.sessionPath,
                account.email,
                account.saveFingerprint,
                this.bot.isMobile
            )

            // Resolve clean environment profile & context options (strict TLS, zero synthetic spoofing)
            const profile = BrowserEnvironmentPolicy.resolveProfile(this.bot.isMobile ? 'mobile' : 'desktop')
            const contextOptions = BrowserEnvironmentPolicy.toContextOptions(profile)

            const context = await browser.newContext(contextOptions)

            await context.addInitScript(() => {
                Object.defineProperty(navigator, 'credentials', {
                    value: {
                        create: () => Promise.reject(new Error('WebAuthn disabled')),
                        get: () => Promise.reject(new Error('WebAuthn disabled'))
                    }
                })
            })

            context.setDefaultTimeout(this.bot.utils.stringToNumber(this.bot.config?.globalTimeout ?? 30000))

            // Filter cookie usang / corrupted yang memicu Geo-Mismatch Lock atau Blokir Telemetri
            const cleanCookies = (sessionData.cookies || []).filter(c => {
                const name = (c.name || '').toLowerCase()
                const val = c.value || ''
                if (name === 'ak_bmsc' || name === 'bm_sv' || name === 'ai_session') return false
                if (name === 'usrloc' && val.includes('BLOCK=')) return false
                if (name === '_rwbf' && (val.includes('c=MY') || val.includes('c=US'))) return false
                return true
            })

            await context.addCookies(cleanCookies)

            // ==================== ULTRA DATA SAVER (HEMAT KUOTA 80%-90%) ====================
            const routeHandler = (route: any) => {
                const req = route.request()
                const type = req.resourceType()
                const url = req.url().toLowerCase()

                // 1. Blokir resource tipe berat (Gambar, Video, Audio, Font, WebSocket)
                if (type === 'image' || type === 'media' || type === 'font' || type === 'websocket') {
                    this.bot.trackBlockedRequest()
                    return route.abort().catch(() => {})
                }

                // 2. Blokir domain iklan, tracker non-Microsoft, copilot, dan aset berat non-Rewards
                if (
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
                    url.includes('bing.com/th?id=') ||
                    url.includes('tiles.virtualearth.net') ||
                    url.includes('assets.msn.com') ||
                    url.includes('edgeservices.bing.com') ||
                    url.includes('c.bing.com') ||
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
