import type { Page } from 'patchright'
import { randomBytes } from 'crypto'
import { URLSearchParams } from 'url'

import type { MicrosoftRewardsBot } from '../../../index'
import { createManagedPage, sanitizeDiagnosticUrl } from '../../../runtime/BrowserOperationGuard'
import { UserAgentManager } from '../../UserAgent'

export class MobileAccessLogin {
    private clientId = '0000000040170455'
    private authUrl = 'https://login.live.com/oauth20_authorize.srf'
    private redirectUrl = 'https://login.live.com/oauth20_desktop.srf'
    private tokenUrl = 'https://login.live.com/oauth20_token.srf'
    private scope = 'service::prod.rewardsplatform.microsoft.com::MBI_SSL'
    private maxTimeout = 35_000 // 35s

    // Selectors for handling Passkey prompt during OAuth
    private readonly selectors = {
        secondaryButton: 'button[data-testid="secondaryButton"]',
        passKeyError: '[data-testid="registrationImg"]',
        passKeyVideo: '[data-testid="biometricVideo"]'
    } as const

    private readonly passkeyDismissSelectors = [
        'button:has-text("Cancel")',
        'button:has-text("Not now")',
        'button:has-text("Skip")',
        'button:has-text("Batal")',
        'button:has-text("Lain kali")',
        'a:has-text("Cancel")',
        'a:has-text("Skip for now")',
        'a:has-text("Not now")',
        'a:has-text("Batal")',
        'a:has-text("Lain kali")',
        '#idBtn_Back',
        '#iCancel',
        '[data-testid="cancel-button"]',
        'button[data-testid="secondaryButton"]'
    ]

    constructor(
        private bot: MicrosoftRewardsBot,
        private page: Page
    ) {}

    private async checkSelector(targetPage: Page, selector: string): Promise<boolean> {
        return targetPage
            .waitForSelector(selector, { state: 'visible', timeout: 200 })
            .then(() => true)
            .catch(() => false)
    }

    private async handlePasskeyPrompt(targetPage: Page): Promise<boolean> {
        try {
            if (targetPage.isClosed()) return false

            const currentUrl = targetPage.url().toLowerCase()
            const isInterruptUrl = /fido|passkey|interrupt|create/i.test(currentUrl)

            const hasPasskeyError = await this.checkSelector(targetPage, this.selectors.passKeyError)
            const hasPasskeyVideo = await this.checkSelector(targetPage, this.selectors.passKeyVideo)

            if (isInterruptUrl || hasPasskeyError || hasPasskeyVideo) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN-APP',
                    `Passkey/FIDO interrupt detected on OAuth page (url: ${targetPage.url()}), attempting auto-dismiss...`
                )

                // Try each dismiss selector actively
                for (const selector of this.passkeyDismissSelectors) {
                    try {
                        const loc = targetPage.locator(selector).first()
                        if (await loc.isVisible().catch(() => false)) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'LOGIN-APP',
                                `Clicking Passkey/FIDO dismiss element: ${selector}`
                            )
                            await loc.click({ timeout: 2000, force: true }).catch(async () => {
                                await this.bot.browser.utils.ghostClick(targetPage, selector)
                            })
                            // Berikan toleransi jeda 1 detik setelah klik agar Microsoft segera me-redirect
                            await this.bot.utils.wait(1000)
                            await targetPage.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
                            return true
                        }
                    } catch {
                        // Continue to next selector
                    }
                }

                // If on interrupt URL and element was not immediately visible, wait briefly for combined selector
                if (isInterruptUrl) {
                    const combinedSelector = this.passkeyDismissSelectors.join(', ')
                    const found = await targetPage.waitForSelector(combinedSelector, { state: 'visible', timeout: 2500 }).catch(() => null)
                    if (found) {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'LOGIN-APP',
                            'Dismissing Passkey/FIDO interrupt via combined selector match'
                        )
                        await found.click({ timeout: 2000, force: true }).catch(async () => {
                            await this.bot.browser.utils.ghostClick(targetPage, combinedSelector)
                        })
                        // Berikan toleransi jeda 1 detik setelah klik
                        await this.bot.utils.wait(1000)
                        await targetPage.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
                        return true
                    }
                }
            }
        } catch (err) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'LOGIN-APP',
                `Error handling passkey prompt: ${err instanceof Error ? err.message : String(err)}`
            )
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

            const totalStart = Date.now()
            let pollStart = Date.now()
            let code = ''
            let lastUrl = ''
            let hasReloaded = false

            while (true) {
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

                    // Auto-dismiss Passkey / FIDO / WebAuthn interrupt if detected
                    await this.handlePasskeyPrompt(oauthPage)

                    // Re-check URL immediately if handlePasskeyPrompt triggered a redirect
                    if (!oauthPage.isClosed()) {
                        const postCheckUrl = new URL(oauthPage.url())
                        if (postCheckUrl.hostname === 'login.live.com' && postCheckUrl.pathname === '/oauth20_desktop.srf') {
                            code = postCheckUrl.searchParams.get('code') || ''
                            if (code) {
                                break
                            }
                        }
                    }
                } catch (err) {
                    if (currentUrl !== lastUrl) {
                        this.bot.logger.debug(this.bot.isMobile, 'LOGIN-APP', 'Invalid URL while polling')
                        lastUrl = currentUrl
                    }
                }

                // If code not received within maxTimeout (35s), attempt 1x reload before declaring failure
                if (Date.now() - pollStart >= this.maxTimeout) {
                    if (!hasReloaded && !oauthPage.isClosed()) {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'LOGIN-APP',
                            'OAuth code not received within 35s, attempting 1x page reload before declaring failure...'
                        )
                        hasReloaded = true
                        pollStart = Date.now()
                        await oauthPage.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(err => {
                            this.bot.logger.debug(
                                this.bot.isMobile,
                                'LOGIN-APP',
                                `OAuth page reload failed: ${err instanceof Error ? err.message : String(err)}`
                            )
                        })
                        continue
                    }
                    break
                }

                await this.bot.utils.wait(1000)
            }

            if (!code) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LOGIN-APP',
                    `Timed out waiting for OAuth code after ${Math.round((Date.now() - totalStart) / 1000)}s`
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

            let response: any = null
            let exchangeError: any = null
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    response = await this.bot.axios.request({
                        url: this.tokenUrl,
                        method: 'POST',
                        timeout: 12000,
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'User-Agent': UserAgentManager.DEFAULT_MOBILE_UA,
                            'Origin': 'https://login.live.com',
                            'Referer': 'https://login.live.com/',
                            'Authorization': undefined
                        },
                        data: data.toString(),
                        'axios-retry': {
                            retries: 0
                        }
                    })
                    break
                } catch (err: any) {
                    exchangeError = err
                    if (err?.response?.status === 400) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'LOGIN-APP',
                            `OAuth token exchange returned HTTP 400 (single-use authorization code expired or invalid). Disabling retry with this authorization code.`
                        )
                        return ''
                    }
                    if (attempt < 2) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'LOGIN-APP',
                            `OAuth token exchange attempt 1 timed out or failed (${err?.message || err}). Retrying 1x...`
                        )
                        await this.bot.utils.wait(1000)
                    }
                }
            }

            if (!response && exchangeError) {
                throw exchangeError
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
        } catch (error: any) {
            if (error?.response?.status === 400) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LOGIN-APP',
                    `OAuth token exchange returned HTTP 400 (single-use authorization code expired or invalid). Disabling retry with this authorization code.`
                )
                return ''
            }
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
