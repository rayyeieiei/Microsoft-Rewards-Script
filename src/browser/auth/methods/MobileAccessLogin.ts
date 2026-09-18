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
    private tokenUrl = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token'
    private scope = 'service::prod.rewardsplatform.microsoft.com::MBI_SSL'
    private maxTimeout = 180_000 // 3min

    // Selectors for handling Passkey prompt during OAuth
    private readonly selectors = {
        secondaryButton: 'button[data-testid="secondaryButton"]',
        passKeyError: '[data-testid="registrationImg"]',
        passKeyVideo: '[data-testid="biometricVideo"]'
    } as const

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

    private async handlePasskeyPrompt(targetPage: Page): Promise<void> {
        try {
            // Handle Passkey prompt - click secondary button to skip
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

                    // Handle Passkey prompt if it appears
                    await this.handlePasskeyPrompt(oauthPage)
                } catch (err) {
                    if (currentUrl !== lastUrl) {
                        this.bot.logger.debug(this.bot.isMobile, 'LOGIN-APP', 'Invalid URL while polling')
                        lastUrl = currentUrl
                    }
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

            const response = await this.bot.axios.request({
                url: this.tokenUrl,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': UserAgentManager.DEFAULT_MOBILE_UA,
                    'Origin': 'https://login.live.com',
                    'Referer': 'https://login.live.com/'
                },
                data: data.toString()
            })

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
