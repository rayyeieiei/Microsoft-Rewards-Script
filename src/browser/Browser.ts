import rebrowser, { BrowserContext } from 'patchright'
import { newInjectedContext } from 'fingerprint-injector'
import { BrowserFingerprintWithHeaders, FingerprintGenerator } from 'fingerprint-generator'

import type { MicrosoftRewardsBot } from '../index'
import { loadSessionData, saveFingerprintData } from '../util/Load'
import { UserAgentManager } from './UserAgent'

import type { Account, AccountProxy } from '../interface/Account'

/* Test Stuff
https://abrahamjuliot.github.io/creepjs/
https://botcheck.luminati.io/
https://fv.pro/
https://pixelscan.net/
https://www.browserscan.net/
*/

interface BrowserCreationResult {
    context: BrowserContext
    fingerprint: BrowserFingerprintWithHeaders
}

class Browser {
    private readonly bot: MicrosoftRewardsBot
    private static readonly BROWSER_ARGS = [
        '--no-sandbox',
        '--mute-audio',
        '--disable-setuid-sandbox',
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list',
        '--ignore-ssl-errors',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-web-authentication-ui',
        '--disable-external-intent-requests',
        '--disable-blink-features=Attestation',
        '--disable-features=WebAuthentication,PasswordManagerOnboarding,PasswordManager,EnablePasswordsAccountStorage,Passkeys,WebAuthenticationProxy,U2F',
        '--disable-save-password-bubble'
    ] as const

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    async createBrowser(account: Account): Promise<BrowserCreationResult> {
        let browser: any; // Menggunakan variabel penampung utama yang bisa diakses di semua blok bawah
        
        try {
            let proxyConfig: any = undefined;
            if (account.proxy.url) {
                proxyConfig = {
                    server: this.formatProxyServer(account.proxy),
                    ...(account.proxy.username &&
                        account.proxy.password && {
                            username: account.proxy.username,
                            password: account.proxy.password
                        })
                };
            } else if (this.bot.localProxyPort) {
                proxyConfig = {
                    server: `http://127.0.0.1:${this.bot.localProxyPort}`
                };
            }

           browser = await rebrowser.chromium.launch({
                headless: this.bot.config.headless === true, // Memastikan bertipe data boolean murni
                channel: this.bot.config.headless ? undefined : 'chrome', // FIX: Jika false, paksa pakai Chrome biasa (bukan headless-shell) agar jendelanya nongol
                args: [...Browser.BROWSER_ARGS],
                proxy: proxyConfig
            } as any);

            this.bot.logger.info(this.bot.isMobile, 'BROWSER', 'Browser launched successfully')
            
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.bot.logger.error(this.bot.isMobile, 'BROWSER', `Launch failed: ${errorMessage}`);
            throw error;
        }

        try {
            const sessionData = await loadSessionData(
                this.bot.config.sessionPath,
                account.email,
                account.saveFingerprint,
                this.bot.isMobile
            );

            const fingerprint = sessionData.fingerprint ?? (await this.generateFingerprint(this.bot.isMobile));

            const context = await newInjectedContext(browser as any, {
                fingerprint,
                newContextOptions: {
                    permissions: [],
                    ignoreHTTPSErrors: true
                }
            });

            await context.addInitScript(() => {
                Object.defineProperty(navigator, 'credentials', {
                    value: {
                        create: () => Promise.reject(new Error('WebAuthn disabled')),
                        get: () => Promise.reject(new Error('WebAuthn disabled'))
                    }
                });
            });

            context.setDefaultTimeout(this.bot.utils.stringToNumber(this.bot.config?.globalTimeout ?? 30000));

            await context.addCookies(sessionData.cookies);

            // ==================== ULTRA DATA SAVER (HEMAT KUOTA 80%-90%) ====================
            await (context as unknown as BrowserContext).route('**/*', (route) => {
                const req = route.request()
                const type = req.resourceType()
                const url = req.url().toLowerCase()

                // 1. Blokir resource tipe berat (Gambar, Video, Audio, Font)
                if (type === 'image' || type === 'media' || type === 'font') {
                    return route.abort()
                }

                // 2. Blokir domain iklan dan tracker pihak ketiga yang tidak berhubungan dengan Rewards
                if (
                    url.includes('clarity.ms') ||
                    url.includes('adnxs.com') ||
                    url.includes('doubleclick.net') ||
                    url.includes('google-analytics.com') ||
                    url.includes('googletagmanager.com') ||
                    url.includes('scorecardresearch.com') ||
                    url.includes('/as/api/') || // Bing Ad services
                    url.includes('msn.com/api/news') || // MSN newsfeed video/images payload
                    url.includes('bing.com/overlay') || // Copilot heavy overlay
                    url.includes('bing.com/videos') ||
                    url.includes('bing.com/images') ||
                    url.includes('bing.com/maps')
                ) {
                    return route.abort()
                }

                // Izinkan document HTML, scripts penting Rewards, telemetri event Microsoft, XHR/Fetch API, dan CSS
                return route.continue()
            });

            if (
                (account.saveFingerprint.mobile && this.bot.isMobile) ||
                (account.saveFingerprint.desktop && !this.bot.isMobile)
            ) {
                await saveFingerprintData(this.bot.config.sessionPath, account.email, this.bot.isMobile, fingerprint);
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'BROWSER',
                `Created browser with User-Agent: "${fingerprint.fingerprint.navigator.userAgent}"`
            );
            this.bot.logger.debug(this.bot.isMobile, 'BROWSER-FINGERPRINT', JSON.stringify(fingerprint));

            return { context: context as unknown as BrowserContext, fingerprint };
        } catch (error) {
            if (browser) {
                await browser.close().catch(() => {});
            }
            throw error;
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

    async generateFingerprint(isMobile: boolean) {
        const fingerPrintData = new FingerprintGenerator().getFingerprint({
            devices: isMobile ? ['mobile'] : ['desktop'],
            operatingSystems: isMobile ? ['android', 'ios'] : ['windows', 'linux'],
            browsers: [{ name: 'edge' }]
        })

        const userAgentManager = new UserAgentManager(this.bot)
        const updatedFingerPrintData = await userAgentManager.updateFingerprintUserAgent(fingerPrintData, isMobile)

        return updatedFingerPrintData
    }
}

export default Browser