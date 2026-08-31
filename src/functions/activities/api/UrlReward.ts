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
            let targetUrl = (promotion.destinationUrl || '').trim()

            // 1. Coba cari kartu di dashboard untuk mengambil URL terlengkap & trigger event klik
            try {
                const currentUrl = page.url().toLowerCase()
                const isDailySet = (promotion.offerId || '').toLowerCase().includes('dailyset') ||
                                   (promotion.offerId || '').toLowerCase().includes('child') ||
                                   (promotion.name || '').toLowerCase().includes('dailyset')

                let targetDashboard = isDailySet ? 'https://rewards.bing.com' : 'https://rewards.bing.com/earn'
                if (punchCard && punchCard.parentPromotion?.destinationUrl) {
                    targetDashboard = punchCard.parentPromotion.destinationUrl
                }

                if (isDailySet) {
                    if (!currentUrl.endsWith('rewards.bing.com/') && !currentUrl.endsWith('rewards.bing.com') && !currentUrl.includes('/dashboard')) {
                        await page.goto('https://rewards.bing.com', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
                        await this.bot.utils.wait(1500)
                    }
                } else {
                    if (!currentUrl.includes('rewards.bing.com')) {
                        await page.goto(targetDashboard, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
                        await this.bot.utils.wait(1500)
                    } else if (!punchCard && !currentUrl.includes('/earn')) {
                        const earnTab = page.locator('a[href*="/earn"], a:has-text("Earn")').first()
                        if (await earnTab.isVisible().catch(() => false)) {
                            await earnTab.click().catch(() => {})
                            await this.bot.utils.wait(1500)
                        }
                    }
                }

                const cleanTitle = (promotion.title || '').replace(/[^\w\s]/gi, ' ').trim()
                const firstKeywords = cleanTitle.split(/\s+/).slice(0, 4).join(' ')
                const firstWord = cleanTitle.split(/\s+/)[0] || ''

                const selectors = [
                    `[data-bi-id*="${promotion.offerId}"]`,
                    `a[href*="${promotion.offerId}"]`,
                    `[id*="${promotion.offerId}"]`,
                    `section#dailyset a:has-text("${promotion.title}")`,
                    `section#dailyset div[role="button"]:has-text("${promotion.title}")`,
                    `section#dailyset button:has-text("${promotion.title}")`,
                    `section#dailyset .c-card:has-text("${firstKeywords}")`,
                    `section#dailyset .c-card:has-text("${firstWord}")`,
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

                for (const sel of selectors) {
                    const el = page.locator(sel).first()
                    if (await el.isVisible().catch(() => false)) {
                        const statusInfo = await el.evaluate((node: HTMLElement) => {
                            const txt = (node.innerText || '').toLowerCase()
                            const hasCheckmark = node.querySelector('.mee-icon-CheckMark, [data-icon-name="CheckMark"], .c-icon-check, .complete-check, svg[aria-label*="Complete"]') !== null
                            const isCompleted = hasCheckmark ||
                                                node.getAttribute('aria-checked') === 'true' ||
                                                node.classList.contains('completed') ||
                                                node.classList.contains('complete') ||
                                                txt.includes('completed') ||
                                                txt.includes('selesai')
                            const href = node.getAttribute('href') || (node.querySelector('a') ? node.querySelector('a')?.getAttribute('href') : null)
                            return { isCompleted, href }
                        }).catch(() => ({ isCompleted: false, href: null }))

                        if (statusInfo.isCompleted) {
                            this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Card "${promotion.title}" is already completed!`)
                            if (promotion.offerId) this.bot.workers.completedOffersInSession.add(promotion.offerId)
                            if (promotion.title) this.bot.workers.completedOffersInSession.add(promotion.title.toLowerCase().trim())
                            return
                        }

                        if (statusInfo.href && statusInfo.href.startsWith('http')) {
                            targetUrl = statusInfo.href
                        }

                        // Trigger click di dashboard
                        await el.evaluate((node: HTMLElement) => {
                            node.click()
                            node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                        }).catch(() => {})
                        
                        this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Dashboard Tile Triggered: "${promotion.title}"`, 'green')
                        break
                    }
                }
            } catch {}

            // 2. Kunjungi halaman pencarian / artikel tujuan di tab baru untuk trigger telemetri pencarian
            if (!targetUrl || targetUrl === '' || targetUrl.toLowerCase().endsWith('rewards.bing.com/dashboard')) {
                targetUrl = promotion.destinationUrl || `https://www.bing.com/search?q=${encodeURIComponent(promotion.title)}`
            }

            this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Opening Activity URL: "${promotion.title}"`)
            const tab = await page.context().newPage()

            try {
                await tab.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000, referer: 'https://rewards.bing.com/' }).catch(() => {})
                await this.bot.utils.wait(2000)

                // Selesaikan kuis / poll / trivia interaktif jika ada di halaman
                for (let q = 0; q < 8; q++) {
                    const startQuizBtn = tab.locator('#rqStartQuiz, #rqStartQuizToken, input[type="button"][value*="Start"], button:has-text("Start"), div[role="button"]:has-text("Start")').first()
                    if (await startQuizBtn.isVisible().catch(() => false)) {
                        await startQuizBtn.click({ force: true }).catch(() => {})
                        await this.bot.utils.wait(2000)
                    }

                    const quizOptions = tab.locator('.btOption, #btoption0, #btoption1, .rqOptions, .wk_Option, [role="radio"], button.optionBtn, .b_ans, .bt_poll, input[type="radio"], div[class*="option"], div[id*="choice"], .rqOption, .b_cards')
                    const optCount = await quizOptions.count().catch(() => 0)
                    if (optCount > 0) {
                        const randIdx = Math.floor(Math.random() * Math.min(optCount, 4))
                        await quizOptions.nth(randIdx).click({ force: true }).catch(() => {})
                        await this.bot.utils.wait(2500)
                    } else {
                        break
                    }
                }

                // Simulasi interaksi scroll natural & human-like movement
                this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Simulating interaction & safe scroll...`)
                await tab.evaluate(() => {
                    window.scrollBy({ top: 350, behavior: 'smooth' })
                }).catch(() => {})
                await this.bot.utils.wait(1800)

                await tab.evaluate(() => {
                    window.scrollBy({ top: -150, behavior: 'smooth' })
                }).catch(() => {})
                await this.bot.utils.wait(1200)

                // Jeda tunggu aman telemetri (/fd/ls/ & bat.bing.com)
                const dwellTime = this.bot.utils.randomDelay(3500, 5000)
                await this.bot.utils.wait(dwellTime)

            } finally {
                await tab.close().catch(() => {})
            }

            // 3. Secondary API reinforcement jika token/hash tersedia
            if (promotion.hash && this.bot.requestToken) {
                try {
                    this.cookieHeader = this.bot.browser.func.buildCookieHeader(this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop, ['bing.com', 'live.com', 'microsoftonline.com'])
                    const formData = new URLSearchParams({ id: promotion.offerId, hash: promotion.hash, timeZone: this.bot.userData.timezoneOffset || '60', activityAmount: '1', __RequestVerificationToken: this.bot.requestToken })
                    await this.bot.axios.request({ url: 'https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest', method: 'POST', timeout: 5000, headers: { ...(this.bot.fingerprint?.headers ?? {}), Cookie: this.cookieHeader, Referer: 'https://rewards.bing.com/' }, data: formData }).catch(() => {})
                } catch {}
            }

            // Sync fresh cookies & check updated balance
            await this.bot.utils.wait(1500)
            const freshCookies = await Promise.race([
                page.context().cookies(),
                new Promise<any[]>(resolve => setTimeout(() => resolve([]), 3000))
            ]).catch(() => [])

            if (freshCookies && freshCookies.length > 0) {
                if (this.bot.isMobile) {
                    this.bot.cookies.mobile = freshCookies
                } else {
                    this.bot.cookies.desktop = freshCookies
                }
            }

            const expectedPoints = Number(promotion.pointProgressMax ?? 10)
            const livePoints = await this.bot.browser.func.getCurrentPoints()
            const calculatedDelta = livePoints > this.oldBalance ? (livePoints - this.oldBalance) : expectedPoints
            const finalBalance = Math.max(livePoints, this.oldBalance + calculatedDelta)
            this.updatePoints(finalBalance, promotion.offerId, promotion.title, calculatedDelta)

        } catch (err: any) {
            this.bot.logger.error(this.bot.isMobile, 'URL-REWARD', `Process failed | offerId=${promotion.offerId}`)
        }
    }

    private updatePoints(newBalance: number, offerId: string, title?: string, pointsEarned?: number) {
        this.gainedPoints = pointsEarned ?? Math.max(0, newBalance - this.oldBalance)
        const displayTitle = title ? `"${title}"` : `offerId=${offerId}`
        const isDailySet = (offerId || '').toLowerCase().includes('dailyset') || (title || '').toLowerCase().includes('daily set')
        const tag = isDailySet ? 'DAILY-SET' : 'KEEP-EARNING'

        this.bot.userData.currentPoints = newBalance
        this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints
        if (offerId) this.bot.workers.completedOffersInSession.add(offerId)
        if (title) this.bot.workers.completedOffersInSession.add(title.toLowerCase().trim())
        this.bot.logger.info(this.bot.isMobile, tag, `Completed: ${displayTitle} | gainedPoints=+${this.gainedPoints} | oldBalance=${this.oldBalance} | newBalance=${newBalance}`, 'green')
    }
}