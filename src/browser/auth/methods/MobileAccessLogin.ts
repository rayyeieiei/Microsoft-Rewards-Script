import type { Page } from 'patchright'
import { randomBytes } from 'crypto'
import { URLSearchParams } from 'url'
import axios from 'axios'

import type { MicrosoftRewardsBot } from '../../../index'
import { createManagedPage, sanitizeDiagnosticUrl } from '../../../runtime/BrowserOperationGuard'
import { UserAgentManager } from '../../UserAgent'

export class MobileAccessLogin {
    private clientId = '0000000040170455'
    private authUrl = 'https://login.live.com/oauth20_authorize.srf'
    private redirectUrl = 'https://login.live.com/oauth20_desktop.srf'
    private tokenUrl = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token'
    private scope = 'service::prod.rewardsplatform.microsoft.com::MBI_SSL'
    public readonly maxTimeout = 45_000 // 45s (previously 180s)

    // Selectors for handling Passkey prompt during OAuth
    private readonly selectors = {
        secondaryButton: 'button[data-testid="secondaryButton"]',
        passKeyError: '[data-testid="registrationImg"]',
        passKeyVideo: '[data-testid="biometricVideo"]'
    } as const

    // Selectors for dismissing Passkey/FIDO enrollment interrupts
    public readonly passkeyDismissSelectors = [
        'button:has-text("Not now")',
        'button:has-text("Lain kali")',
        'button:has-text("Cancel")',
        'button:has-text("Batal")',
        '#idBtn_Back',
        'a:has-text("Skip")',
        '[aria-label*="cancel" i]',
        '#iCancel',
        '#iSkip',
        'button:has-text("Skip for now")',
        'button[data-testid="secondaryButton"]'
    ].join(', ')

    // Selectors for confirming OAuth consent, permissions, or "Stay signed in" prompts
    public readonly oauthConsentSelectors = [
        '#idSIButton9',
        'input[type="submit"]#idSIButton9',
        'button#idSIButton9',
        'input[type="submit"][value="Yes"]',
        'input[type="submit"][value="Accept"]',
        'input[type="submit"][value="Continue"]',
        'input[type="submit"][value="Ya"]',
        'input[type="submit"][value="Setuju"]',
        'button:has-text("Yes")',
        'button:has-text("Accept")',
        'button:has-text("Continue")',
        'button:has-text("Allow")',
        'button:has-text("Setuju")',
        'button:has-text("Lanjutkan")',
        'button:has-text("Ya")',
        'button[data-report-event="Signin_Submit"]'
    ].join(', ')

    constructor(
        private bot: MicrosoftRewardsBot,
        private page: Page
    ) {}

    public isPasskeyInterruptUrl(urlStr: string): boolean {
        if (!urlStr) return false
        const lower = urlStr.toLowerCase()
        return (
            lower.includes('/interrupt/passkey') ||
            lower.includes('/fido/create') ||
            lower.includes('/passkey/enroll')
        )
    }

    public isOAuthConsentUrl(urlStr: string): boolean {
        if (!urlStr) return false
        const lower = urlStr.toLowerCase()
        return (
            lower.includes('oauth20_authorize') ||
            lower.includes('ppsecure/post.srf') ||
            lower.includes('/consent') ||
            lower.includes('/kmsi') ||
            lower.includes('login.live.com')
        )
    }

    private async checkSelector(targetPage: Page, selector: string): Promise<boolean> {
        return targetPage
            .waitForSelector(selector, { state: 'visible', timeout: 200 })
            .then(() => true)
            .catch(() => false)
    }

    public async handlePasskeyPrompt(targetPage: Page, currentUrl?: string): Promise<void> {
        try {
            const urlToCheck = currentUrl || targetPage.url() || ''

            // 1. Deteksi interupsi berbasis URL (/interrupt/passkey, /fido/create, /passkey/enroll)
            if (this.isPasskeyInterruptUrl(urlToCheck)) {
                const dismissBtn = await targetPage
                    .waitForSelector(this.passkeyDismissSelectors, { state: 'visible', timeout: 3000 })
                    .catch(() => null)

                if (dismissBtn) {
                    await dismissBtn.click().catch(() => {})
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PASSKEY-BYPASS',
                        `🛡️ [PASSKEY-BYPASS] Mendeteksi interupsi pendaftaran Passkey/FIDO. Berhasil mengeklik 'Not now'/'Cancel'.`
                    )
                    await targetPage.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
                    return
                }
            }

            // 2. Fallback deteksi modal prompt passkey in-page
            const hasPasskeyError = await this.checkSelector(targetPage, this.selectors.passKeyError)
            const hasPasskeyVideo = await this.checkSelector(targetPage, this.selectors.passKeyVideo)
            if (hasPasskeyError || hasPasskeyVideo) {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-APP', 'Found Passkey prompt on OAuth page, skipping')
                await this.bot.browser.utils.ghostClick(targetPage, this.selectors.secondaryButton)
                await targetPage.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
            }
        } catch {
            // Ignore errors in prompt handling
        }
    }

    public async handleOAuthConsent(targetPage: Page, currentUrl?: string): Promise<boolean> {
        try {
            const urlToCheck = currentUrl || targetPage.url() || ''
            if (!this.isOAuthConsentUrl(urlToCheck)) {
                return false
            }

            // Guard: Do not auto-submit if credentials input fields are active/visible
            const hasCredentialInputs = await targetPage.evaluate(() => {
                const emailInput = document.querySelector('input[type="email"], input[name="loginfmt"]') as HTMLElement | null
                const passInput = document.querySelector('input[type="password"], input[name="passwd"]') as HTMLElement | null
                const isEmailVis = emailInput && (emailInput.offsetWidth > 0 || emailInput.offsetHeight > 0)
                const isPassVis = passInput && (passInput.offsetWidth > 0 || passInput.offsetHeight > 0)
                return Boolean(isEmailVis || isPassVis)
            }).catch(() => false)

            if (hasCredentialInputs) {
                return false
            }

            const consentBtn = await targetPage
                .waitForSelector(this.oauthConsentSelectors, { state: 'visible', timeout: 1500 })
                .catch(() => null)

            if (consentBtn) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN-APP',
                    `🛡️ [OAUTH-CONSENT] Auto-confirming OAuth consent/continue prompt on ${urlToCheck}`
                )
                await consentBtn.click().catch(() => {})
                await targetPage.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
                return true
            }
        } catch {
            // Ignore errors in consent handling
        }
        return false
    }

    async get(email: string): Promise<string> {
        let oauthPage: Page | null = null
        const ownerUrlBefore = sanitizeDiagnosticUrl(this.page.url())

        try {
            const authorizeUrl = new URL(this.authUrl)
            authorizeUrl.searchParams.append('response_type', 'code')
            authorizeUrl.searchParams.append('client_id', this.clientId)
            authorizeUrl.searchParams.append('redirect_uri', this.redirectUrl)
            authorizeUrl.searchParams.append('scope', this.scope)
            authorizeUrl.searchParams.append('state', randomBytes(16).toString('hex'))
            authorizeUrl.searchParams.append('access_type', 'offline_access')
            authorizeUrl.searchParams.append('login_hint', email)

            this.bot.logger.debug(
                this.bot.isMobile,
                'LOGIN-APP',
                `Auth URL constructed: ${authorizeUrl.origin}${authorizeUrl.pathname}`
            )

            // Isolasi proses OAuth pada halaman terkelola terpisah agar owner page tidak terganggu
            oauthPage = await createManagedPage({
                context: this.page.context(),
                purpose: 'oauth-mobile-access',
                isMobile: this.bot.isMobile
            })

            await this.bot.browser.utils.disableFido(oauthPage)

            this.bot.logger.debug(this.bot.isMobile, 'LOGIN-APP', 'Navigating to OAuth authorize URL in isolated page')

            await oauthPage.goto(authorizeUrl.href, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(err => {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN-APP',
                    `page.goto() failed: ${err instanceof Error ? err.message : String(err)}`
                )
            })

            this.bot.logger.info(this.bot.isMobile, 'LOGIN-APP', 'Waiting for mobile OAuth code...')

            const start = Date.now()
            let code = ''
            let lastUrl = ''

            while (Date.now() - start < this.maxTimeout) {
                if (oauthPage.isClosed()) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN-APP', 'OAuth page was closed prematurely')
                    break
                }

                const currentUrl = oauthPage.url()

                try {
                    const url = new URL(currentUrl)

                    if (url.hostname === 'login.live.com' && url.pathname === '/oauth20_desktop.srf') {
                        if (currentUrl !== lastUrl) {
                            const codePresent = url.searchParams.has('code')
                            const statePresent = url.searchParams.has('state')
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'LOGIN-APP',
                                `[LOGIN-APP] OAuth redirect detected | origin=${url.hostname} path=${url.pathname} codePresent=${codePresent} statePresent=${statePresent}`
                            )
                            lastUrl = currentUrl
                        }

                        code = url.searchParams.get('code') || ''
                        if (code) {
                            break
                        }
                    } else if (currentUrl !== lastUrl) {
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'LOGIN-APP',
                            `OAuth poll URL changed → ${url.origin}${url.pathname}`
                        )
                        lastUrl = currentUrl
                    }

                    // Handle Passkey prompt or interrupt if it appears
                    await this.handlePasskeyPrompt(oauthPage, currentUrl)

                    // Handle OAuth consent prompt if page is waiting on authorize/consent
                    await this.handleOAuthConsent(oauthPage, currentUrl)
                } catch (err) {
                    if (currentUrl !== lastUrl) {
                        this.bot.logger.debug(this.bot.isMobile, 'LOGIN-APP', 'Invalid URL while polling')
                        lastUrl = currentUrl
                    }
                    await this.handlePasskeyPrompt(oauthPage, currentUrl).catch(() => {})
                    await this.handleOAuthConsent(oauthPage, currentUrl).catch(() => {})
                }

                await this.bot.utils.wait(1000)
            }

            if (!code) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LOGIN-APP',
                    `Timed out waiting for OAuth code after ${Math.round((Date.now() - start) / 1000)}s`
                )

                try {
                    const finalParsed = new URL(oauthPage.url())
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'LOGIN-APP',
                        `Final page URL: ${finalParsed.origin}${finalParsed.pathname}`
                    )
                } catch {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN-APP', 'Final page URL unavailable')
                }

                return ''
            }

            const data = new URLSearchParams()
            data.append('grant_type', 'authorization_code')
            data.append('client_id', this.clientId)
            data.append('code', code)
            data.append('redirect_uri', this.redirectUrl)

            this.bot.logger.debug(this.bot.isMobile, 'LOGIN-APP', 'Exchanging OAuth code for access token')

            let response
            try {
                response = await this.bot.axios.request({
                    url: this.tokenUrl,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': UserAgentManager.DEFAULT_MOBILE_UA,
                        'Origin': 'https://login.live.com',
                        'Referer': 'https://login.live.com/',
                        'Authorization': undefined
                    },
                    data: data.toString(),
                    // @ts-ignore
                    'axios-retry': { retries: 0 }
                })
            } catch (tokenExchangeError) {
                if (axios.isAxiosError(tokenExchangeError) && tokenExchangeError.response) {
                    const status = tokenExchangeError.response.status
                    if (status === 400 || status === 401) {
                        const errorDetails =
                            typeof tokenExchangeError.response.data === 'object'
                                ? JSON.stringify(tokenExchangeError.response.data)
                                : String(tokenExchangeError.response.data)
                        this.bot.logger.error(
                            this.bot.isMobile,
                            'LOGIN-APP',
                            `[OAUTH-BURNED-CODE] Token endpoint rejected authorization code with HTTP ${status}: ${errorDetails}. Kode otorisasi bersifat single-use dan telah hangus; menghentikan proses tanpa retry.`
                        )
                    }
                }
                throw tokenExchangeError
            }

            const token = (response?.data?.access_token as string) ?? ''

            if (!token) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-APP', 'No access_token in token response')
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN-APP',
                    `Token response payload: ${JSON.stringify(response?.data)}`
                )
                return ''
            }

            this.bot.logger.info(this.bot.isMobile, 'LOGIN-APP', 'Mobile access token received')
            return token
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN-APP',
                `MobileAccess error: ${error instanceof Error ? error.stack || error.message : String(error)}`
            )
            return ''
        } finally {
            if (oauthPage && !oauthPage.isClosed()) {
                await oauthPage.close({ runBeforeUnload: false }).catch(() => {})
            }
            const ownerUrlAfter = sanitizeDiagnosticUrl(this.page.url())
            this.bot.logger.info(
                this.bot.isMobile,
                'LOGIN-APP',
                `[OAUTH-ISOLATION] Owner page URL preserved: ${ownerUrlBefore.origin}${ownerUrlBefore.pathname} === ${ownerUrlAfter.origin}${ownerUrlAfter.pathname}`
            )
        }
    }
}
