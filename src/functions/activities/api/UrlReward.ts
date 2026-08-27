import type { BasePromotion, PunchCard } from '../../../interface/DashboardData'
import { Workers } from '../../Workers'
import { Page } from 'patchright'

export class UrlReward extends Workers {
    private cookieHeader: string = ''
    private gainedPoints: number = 0
    private oldBalance: number = 0

    public async doUrlReward(promotion: BasePromotion, page: Page, punchCard?: PunchCard) {
        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)
        this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Processing Activity: "${promotion.title}" (Points: +${promotion.pointProgressMax})`)

        try {
            // Pastikan page berada di halaman Rewards Dashboard utama
            const currentUrl = page.url().toLowerCase()
            let targetDashboard = 'https://rewards.bing.com'
            if (punchCard && punchCard.parentPromotion?.destinationUrl) {
                targetDashboard = punchCard.parentPromotion.destinationUrl
            }

            if (!currentUrl.includes('rewards.bing.com') || (punchCard && !currentUrl.includes(targetDashboard.toLowerCase()))) {
                this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Navigating page to: ${targetDashboard}`)
                await page.goto(targetDashboard, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {})
                await this.bot.utils.wait(2000)
            }

            // Scroll perlahan di dashboard untuk trigger lazy loading seluruh kartu
            await page.mouse.wheel(0, 500).catch(() => {})
            await this.bot.utils.wait(800)
            await page.mouse.wheel(0, 500).catch(() => {})
            await this.bot.utils.wait(800)
            await page.mouse.wheel(0, -1000).catch(() => {})
            await this.bot.utils.wait(1000)

            // Buka section accordion yang tertutup jika ada
            await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button[aria-expanded="false"], .expansion-button, [data-bi-id*="expand"]'))
                buttons.forEach((btn: any) => (btn as HTMLElement).click())
            }).catch(() => {})

            const cleanTitle = (promotion.title || '').replace(/[^\w\s]/gi, ' ').trim()
            const firstKeywords = cleanTitle.split(/\s+/).slice(0, 4).join(' ')
            const firstWord = cleanTitle.split(/\s+/)[0] || ''

            const selectors = [
                `[data-bi-id*="${promotion.offerId}"]`,
                `a[href*="${promotion.offerId}"]`,
                `[id*="${promotion.offerId}"]`,
                `a:has-text("${promotion.title}")`,
                `div[role="button"]:has-text("${promotion.title}")`,
                `button:has-text("${promotion.title}")`,
                `a:has-text("${firstKeywords}")`,
                `div[role="button"]:has-text("${firstKeywords}")`,
                `button:has-text("${firstKeywords}")`,
                `.c-card:has-text("${firstKeywords}")`,
                `.p-card:has-text("${firstKeywords}")`,
                `.promo-tile:has-text("${firstKeywords}")`,
                `a:has-text("${firstWord}")`,
                `div[role="button"]:has-text("${firstWord}")`,
                `button:has-text("${firstWord}")`
            ]

            let clicked = false
            let isOnCooldown = false

            for (const sel of selectors) {
                const elements = page.locator(sel)
                const count = await elements.count().catch(() => 0)

                for (let i = 0; i < count; i++) {
                    const el = elements.nth(i)
                    if (await el.isVisible().catch(() => false)) {
                        const statusInfo = await el.evaluate((node: HTMLElement) => {
                            const txt = (node.innerText || '').toLowerCase()
                            const isTrash = txt.includes('feedback') || txt.includes('terms') || node.closest('#footer') !== null

                            const isCooldown = txt.includes('come back') ||
                                               txt.includes('check back') ||
                                               txt.includes('locked') ||
                                               node.hasAttribute('disabled') ||
                                               node.classList.contains('locked') ||
                                               node.classList.contains('disabled')

                            const hasCheckmark = node.querySelector('.mee-icon-CheckMark, [data-icon-name="CheckMark"], .c-icon-check, .complete-check, svg[aria-label*="Complete"]') !== null
                            const isCompleted = hasCheckmark ||
                                                node.getAttribute('aria-checked') === 'true' ||
                                                node.classList.contains('completed') ||
                                                node.classList.contains('complete') ||
                                                txt.includes('completed') ||
                                                txt.includes('selesai')

                            return { isTrash, isCooldown, isCompleted }
                        }).catch(() => ({ isTrash: false, isCooldown: false, isCompleted: false }))

                        if (statusInfo.isTrash) continue
                        if (statusInfo.isCompleted) {
                            this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Card "${promotion.title}" is already completed!`)
                            return
                        }

                        if (statusInfo.isCooldown) {
                            isOnCooldown = true
                            continue
                        }

                        await el.scrollIntoViewIfNeeded().catch(() => {})

                        this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Clicking Dashboard Tile: "${promotion.title}"`, 'green')

                        // Dengarkan tab baru yang terbuka saat kartu diklik
                        const newPagePromise = page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null)

                        await el.click({ force: true, timeout: 5000 }).catch(async () => {
                            await el.evaluate((node: HTMLElement) => {
                                node.click()
                                node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                            }).catch(() => {})
                        })

                        clicked = true
                        const popupPage = await newPagePromise
                        const activeTab = popupPage || page

                        await activeTab.waitForLoadState('domcontentloaded').catch(() => {})
                        await this.bot.utils.wait(2000)

                        // Selesaikan kuis / poll / trivia interaktif di dalam tab
                        for (let q = 0; q < 8; q++) {
                            const startQuizBtn = activeTab.locator('#rqStartQuiz, #rqStartQuizToken, input[type="button"][value*="Start"]').first()
                            if (await startQuizBtn.isVisible().catch(() => false)) {
                                await startQuizBtn.click({ force: true }).catch(() => {})
                                await this.bot.utils.wait(2000)
                            }

                            const quizOptions = activeTab.locator('.btOption, #btoption0, #btoption1, .rqOptions, .wk_Option, [role="radio"], button.optionBtn, .b_ans, .bt_poll, input[type="radio"]')
                            const optCount = await quizOptions.count().catch(() => 0)
                            if (optCount > 0) {
                                const randIdx = Math.floor(Math.random() * Math.min(optCount, 4))
                                await quizOptions.nth(randIdx).click({ force: true }).catch(() => {})
                                await this.bot.utils.wait(2500)
                            } else {
                                break
                            }
                        }

                        // Simulasi interaksi scroll natural
                        this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Simulating interaction & safe scroll...`)
                        await activeTab.mouse.wheel(0, 400).catch(() => {})
                        await this.bot.utils.wait(2500)
                        await activeTab.mouse.wheel(0, -200).catch(() => {})
                        await this.bot.utils.wait(2000)

                        // Waktu tunggu sinkronisasi server
                        await this.bot.utils.wait(4000)

                        if (popupPage && popupPage !== page) {
                            await popupPage.close().catch(() => {})
                        }
                        break
                    }
                }
                if (clicked) break
            }

            // JIKA TILE TIDAK DITEMUKAN DI DOM: FALLBACK DIRECT VISIT
            if (isOnCooldown && !clicked) {
                this.bot.logger.warn(this.bot.isMobile, 'URL-REWARD', `Quest [${promotion.title}] is on cooldown. Safely skipped.`, 'yellow')
            } else if (!clicked) {
                const destUrl = (promotion.destinationUrl || '').trim()
                if (destUrl && !destUrl.toLowerCase().endsWith('rewards.bing.com/dashboard')) {
                    this.bot.logger.warn(this.bot.isMobile, 'URL-REWARD', `Tile not found on dashboard, fallback visiting: "${promotion.title}"`)
                    const fallbackTab = await page.context().newPage()
                    try {
                        await fallbackTab.goto(destUrl, { waitUntil: 'domcontentloaded', timeout: 20000, referer: 'https://rewards.bing.com/' }).catch(() => {})
                        await this.bot.utils.wait(2000)

                        for (let q = 0; q < 8; q++) {
                            const startQuizBtn = fallbackTab.locator('#rqStartQuiz, #rqStartQuizToken, input[type="button"][value*="Start"]').first()
                            if (await startQuizBtn.isVisible().catch(() => false)) {
                                await startQuizBtn.click({ force: true }).catch(() => {})
                                await this.bot.utils.wait(2000)
                            }

                            const quizOptions = fallbackTab.locator('.btOption, #btoption0, #btoption1, .rqOptions, .wk_Option, [role="radio"], button.optionBtn, .b_ans, .bt_poll, input[type="radio"]')
                            const optCount = await quizOptions.count().catch(() => 0)
                            if (optCount > 0) {
                                const randIdx = Math.floor(Math.random() * Math.min(optCount, 4))
                                await quizOptions.nth(randIdx).click({ force: true }).catch(() => {})
                                await this.bot.utils.wait(2500)
                            } else {
                                break
                            }
                        }

                        await fallbackTab.mouse.wheel(0, 400).catch(() => {})
                        await this.bot.utils.wait(2500)
                        await fallbackTab.mouse.wheel(0, -200).catch(() => {})
                        await this.bot.utils.wait(2000)
                        await this.bot.utils.wait(4000)
                    } finally {
                        await fallbackTab.close().catch(() => {})
                    }
                }
            }

            // Secondary API reinforcement: Kirim juga reportactivity jika hash & requestToken tersedia
            if (promotion.hash && this.bot.requestToken) {
                try {
                    this.cookieHeader = this.bot.browser.func.buildCookieHeader(this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop, ['bing.com', 'live.com', 'microsoftonline.com'])
                    const formData = new URLSearchParams({ id: promotion.offerId, hash: promotion.hash, timeZone: this.bot.userData.timezoneOffset || '60', activityAmount: '1', __RequestVerificationToken: this.bot.requestToken })
                    await this.bot.axios.request({ url: 'https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest', method: 'POST', headers: { ...(this.bot.fingerprint?.headers ?? {}), Cookie: this.cookieHeader, Referer: 'https://rewards.bing.com/' }, data: formData }).catch(() => {})
                } catch {}
            }

            const newBalance = await this.bot.browser.func.getCurrentPoints()
            this.updatePoints(newBalance, promotion.offerId)

        } catch (err: any) {
            this.bot.logger.error(this.bot.isMobile, 'URL-REWARD', `Process failed | offerId=${promotion.offerId}`)
        }
    }

    private updatePoints(newBalance: number, offerId: string) {
        this.gainedPoints = newBalance - this.oldBalance
        if (this.gainedPoints > 0) {
            this.bot.userData.currentPoints = newBalance
            this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints
            this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Completed | offerId=${offerId} | +${this.gainedPoints} points`, 'green')
        }
    }
}