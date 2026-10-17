import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../index'

export class Onboarding {
    constructor(private bot: MicrosoftRewardsBot) {}

    /**
     * Memeriksa apakah URL peramban adalah rewards.bing.com/about atau /welcome
     * dan melakukan auto-enrollment secara otomatis sebelum penukaran token DAPI.
     */
    async ensureRewardsEnrolled(page: Page): Promise<boolean> {
        try {
            if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
                return false
            }

            const currentUrl = page.url()
            if (!currentUrl.includes('rewards.bing.com/about') && !currentUrl.includes('rewards.bing.com/welcome')) {
                return true
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'ONBOARDING',
                `🛡️ Terdeteksi akun belum terdaftar di Rewards (URL: ${currentUrl}). Menjalankan auto-enrollment sebelum token DAPI...`,
                'yellow'
            )

            const joinSelectors = [
                'a:has-text("Join now")',
                'button:has-text("Join now")',
                'a:has-text("Sign up for free")',
                'a:has-text("Gabung sekarang")',
                '#start-earning-rewards-link',
                'a[href*="signup"]',
                'a[href*="createuser"]',
                'button:has-text("Sign up for free")'
            ]

            let clicked = false
            for (const selector of joinSelectors) {
                const btn = page.locator(selector).first()
                if (await btn.count() > 0 && await btn.isVisible().catch(() => false)) {
                    this.bot.logger.info(this.bot.isMobile, 'ONBOARDING', `Mengklik tombol pendaftaran: ${selector}`)
                    await btn.click({ timeout: 5000 }).catch(async () => {
                        await this.bot.browser.utils.ghostClick(page, selector)
                    })
                    clicked = true
                    break
                }
            }

            if (!clicked) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'ONBOARDING',
                    'Tombol Join now tidak ditemukan secara langsung, mencoba navigasi langsung ke pendaftaran...'
                )
                await page
                    .goto('https://rewards.bing.com/createuser?idru=%2F&userScenarioId=anonsignin', {
                        waitUntil: 'domcontentloaded',
                        timeout: 10000
                    })
                    .catch(() => {})
            }

            // Tunggu navigasi hingga URL berubah menjadi rewards.bing.com/ atau rewards.bing.com/dashboard (timeout 8000ms)
            const enrolled = await page
                .waitForURL(
                    url => {
                        const u = url.toString()
                        return (
                            (u.includes('rewards.bing.com') || u.includes('rewards.bing.com/dashboard')) &&
                            !u.includes('/about') &&
                            !u.includes('/welcome')
                        )
                    },
                    { timeout: 8000 }
                )
                .then(() => true)
                .catch(() => false)

            if (!enrolled) {
                const postUrl = page.url()
                if (postUrl.includes('/about') || postUrl.includes('/welcome')) {
                    await page.goto(this.bot.config.baseURL, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {})
                    await this.bot.utils.wait(2000)
                }
            }

            const finalUrl = page.url()
            const success =
                (finalUrl.includes('rewards.bing.com') || finalUrl.includes('rewards.bing.com/dashboard')) &&
                !finalUrl.includes('/about') &&
                !finalUrl.includes('/welcome')

            if (success) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'ONBOARDING',
                    '🎉 Pendaftaran Rewards berhasil dikonfirmasi. Melanjutkan ke penukaran token DAPI.',
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'ONBOARDING',
                    `Auto-enrollment belum sepenuhnya diverifikasi, URL saat ini: ${finalUrl}`
                )
            }

            return success
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'ONBOARDING',
                `Gagal auto-enrollment rewards: ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }
}

export async function autoEnrollRewards(page: Page, bot: MicrosoftRewardsBot): Promise<boolean> {
    return new Onboarding(bot).ensureRewardsEnrolled(page)
}
