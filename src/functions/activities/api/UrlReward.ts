import type { BasePromotion, PunchCard } from '../../../interface/DashboardData'
import { Workers } from '../../Workers'
import { Page } from 'patchright'
import { Database } from '../../../util/Database'
import {
    createManagedPage,
    runGuardedOperation,
    performBoundedSafeScroll
} from '../../../runtime/BrowserOperationGuard'

export class UrlReward extends Workers {
    private cookieHeader: string = ''
    private gainedPoints: number = 0
    private oldBalance: number = 0

    public async doUrlReward(promotion: BasePromotion, page: Page, punchCard?: PunchCard) {
        const URL_REWARD_TOTAL_BUDGET_MS = 70_000
        const deadlineAt = Date.now() + URL_REWARD_TOTAL_BUDGET_MS
        const remainingMs = () => Math.max(0, deadlineAt - Date.now())

        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)
        this.bot.logger.info(
            this.bot.isMobile,
            'URL-REWARD',
            `Processing Activity: "${promotion.title}" (Points: +${promotion.pointProgressMax})`
        )

        // Safe diagnostic metadata logging (zero secrets, zero tokens, zero query strings)
        if (punchCard) {
            let destinationOrigin = 'none'
            let destinationPath = 'none'
            try {
                if (promotion.destinationUrl) {
                    const parsed = new URL(promotion.destinationUrl)
                    destinationOrigin = parsed.origin
                    destinationPath = parsed.pathname
                }
            } catch {}

            const childTokenPresent = Boolean(promotion.hash || (promotion.attributes as any)?.actionData)
            const parentTokenPresent = Boolean(punchCard.parentPromotion?.hash || (punchCard.parentPromotion?.attributes as any)?.actionData)
            const bootstrapActionPresent = false
            const childKeys = JSON.stringify(Object.keys(promotion || {}))
            const actionKeys = JSON.stringify(Object.keys(promotion.attributes || {}))
            const parentOfferId = punchCard.parentPromotion?.offerId || (punchCard as any).offerId || 'unknown'
            const childOfferId = promotion.offerId || 'unknown'

            this.bot.logger.debug(
                this.bot.isMobile,
                'PUNCHCARD-META',
                `[PUNCHCARD-META] parentOfferId=${parentOfferId} childOfferId=${childOfferId} childType=urlreward childTokenPresent=${childTokenPresent} parentTokenPresent=${parentTokenPresent} bootstrapActionPresent=${bootstrapActionPresent} destinationOrigin=${destinationOrigin} destinationPath=${destinationPath}`
            )
            this.bot.logger.debug(
                this.bot.isMobile,
                'PUNCHCARD-META',
                `[PUNCHCARD-META] childKeys=${childKeys}`
            )
            this.bot.logger.debug(
                this.bot.isMobile,
                'PUNCHCARD-META',
                `[PUNCHCARD-META] actionKeys=${actionKeys}`
            )
        } else {
            const requestTokenPresent = Boolean(this.bot.requestToken)
            const actionDataPresent = Boolean(promotion.hash || (promotion.attributes as any)?.actionData)
            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD-META',
                `[URL-REWARD-META] source=normal-promotion requestTokenPresent=${requestTokenPresent} actionDataPresent=${actionDataPresent}`
            )
        }

        try {
            let targetUrl = (promotion.destinationUrl || '').trim()

            // 1. Coba cari kartu di dashboard untuk mengambil URL terlengkap & trigger event klik
            try {
                const currentUrl = page.url().toLowerCase()
                const isDailySet =
                    (promotion.offerId || '').toLowerCase().includes('dailyset') ||
                    (promotion.offerId || '').toLowerCase().includes('child') ||
                    (promotion.name || '').toLowerCase().includes('dailyset')

                let targetDashboard = isDailySet ? 'https://rewards.bing.com' : 'https://rewards.bing.com/earn'
                if (punchCard && punchCard.parentPromotion?.destinationUrl) {
                    targetDashboard = punchCard.parentPromotion.destinationUrl
                }

                if (isDailySet) {
                    if (
                        !currentUrl.endsWith('rewards.bing.com/') &&
                        !currentUrl.endsWith('rewards.bing.com') &&
                        !currentUrl.includes('/dashboard')
                    ) {
                        await page
                            .goto('https://rewards.bing.com', { waitUntil: 'domcontentloaded', timeout: 15000 })
                            .catch(() => {})
                        await this.bot.utils.wait(1500)
                    }
                } else {
                    if (!punchCard) {
                        if (!currentUrl.includes('/earn')) {
                            await page
                                .goto('https://rewards.bing.com/earn', {
                                    waitUntil: 'domcontentloaded',
                                    timeout: 15000
                                })
                                .catch(() => {})
                            await this.bot.utils.wait(1500)
                        }
                    } else if (!currentUrl.includes('rewards.bing.com')) {
                        await page
                            .goto(targetDashboard, { waitUntil: 'domcontentloaded', timeout: 15000 })
                            .catch(() => {})
                        await this.bot.utils.wait(1500)
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
                        const statusInfo = await el
                            .evaluate((node: HTMLElement) => {
                                const txt = (node.innerText || '').toLowerCase()
                                const hasCheckmark =
                                    node.querySelector(
                                        '.mee-icon-CheckMark, [data-icon-name="CheckMark"], .c-icon-check, .complete-check, svg[aria-label*="Complete"]'
                                    ) !== null
                                const isCompleted =
                                    hasCheckmark ||
                                    node.getAttribute('aria-checked') === 'true' ||
                                    node.classList.contains('completed') ||
                                    node.classList.contains('complete') ||
                                    txt.includes('completed') ||
                                    txt.includes('selesai')
                                const href =
                                    node.getAttribute('href') ||
                                    (node.querySelector('a') ? node.querySelector('a')?.getAttribute('href') : null)
                                return { isCompleted, href }
                            })
                            .catch(() => ({ isCompleted: false, href: null }))

                        if (statusInfo.isCompleted) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'URL-REWARD',
                                `Card "${promotion.title}" is already completed!`
                            )
                            if (promotion.offerId) this.bot.workers.completedOffersInSession.add(promotion.offerId)
                            if (promotion.title)
                                this.bot.workers.completedOffersInSession.add(promotion.title.toLowerCase().trim())
                            return
                        }

                        if (statusInfo.href && statusInfo.href.startsWith('http')) {
                            targetUrl = statusInfo.href
                        }

                        // Trigger click di dashboard
                        await el
                            .evaluate((node: HTMLElement) => {
                                node.click()
                                node.dispatchEvent(
                                    new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
                                )
                            })
                            .catch(() => {})

                        this.bot.logger.info(
                            this.bot.isMobile,
                            'URL-REWARD',
                            `Dashboard Tile Triggered: "${promotion.title}"`,
                            'green'
                        )
                        break
                    }
                }
            } catch {}

            // 2. Kunjungi halaman pencarian / artikel tujuan di tab baru untuk trigger telemetri pencarian
            if (!targetUrl || targetUrl === '' || targetUrl.toLowerCase().endsWith('rewards.bing.com/dashboard')) {
                targetUrl =
                    promotion.destinationUrl || `https://www.bing.com/search?q=${encodeURIComponent(promotion.title)}`
            }

            if (remainingMs() <= 0) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `[ACTIVITY-TIMEOUT] title="${promotion.title}" stage=total-budget recovery=cleanup-and-continue`
                )
                return
            }

            this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Opening Activity URL: "${promotion.title}"`)
            const tab = await createManagedPage({
                context: page.context(),
                purpose: 'url-reward-tab',
                isMobile: this.bot.isMobile
            })

            try {
                const navResult = await runGuardedOperation({
                    stage: 'activity-navigation',
                    timeoutMs: 20000,
                    remainingBudgetMs: remainingMs(),
                    page: tab,
                    logger: this.bot.logger,
                    isMobile: this.bot.isMobile,
                    operation: async (_signal, timeout) => {
                        await tab.goto(targetUrl, {
                            waitUntil: 'domcontentloaded',
                            timeout: Math.max(1000, timeout),
                            referer: 'https://rewards.bing.com/'
                        })
                    }
                })

                if (navResult.status === 'completed' && remainingMs() > 2000) {
                    await this.bot.utils.wait(Math.min(2000, remainingMs()))

                    // Selesaikan kuis / poll / trivia interaktif jika ada di halaman
                    await runGuardedOperation({
                        stage: 'activity-interaction',
                        timeoutMs: 10000,
                        remainingBudgetMs: remainingMs(),
                        page: tab,
                        logger: this.bot.logger,
                        isMobile: this.bot.isMobile,
                        operation: async (signal) => {
                            for (let q = 0; q < 8; q++) {
                                if (signal.aborted || (typeof tab.isClosed === 'function' && tab.isClosed())) break

                                const startQuizBtn = tab
                                    .locator(
                                        '#rqStartQuiz, #rqStartQuizToken, input[type="button"][value*="Start"], button:has-text("Start"), div[role="button"]:has-text("Start")'
                                    )
                                    .first()
                                if (await startQuizBtn.isVisible().catch(() => false)) {
                                    await startQuizBtn.click({ force: true }).catch(() => {})
                                    await this.bot.utils.wait(1500)
                                }

                                const quizOptions = tab.locator(
                                    '.btOption, #btoption0, #btoption1, .rqOptions, .wk_Option, [role="radio"], button.optionBtn, .b_ans, .bt_poll, input[type="radio"], div[class*="option"], div[id*="choice"], .rqOption, .b_cards'
                                )
                                const optCount = await quizOptions.count().catch(() => 0)
                                if (optCount > 0) {
                                    const randIdx = Math.floor(Math.random() * Math.min(optCount, 4))
                                    await quizOptions
                                        .nth(randIdx)
                                        .click({ force: true })
                                        .catch(() => {})
                                    await this.bot.utils.wait(2000)
                                } else {
                                    break
                                }
                            }

                            // Deteksi dan trigger tombol aksi sub-task Punch Card
                            const actionButtonSelectors = [
                                'a:has-text("Shop the look")',
                                'button:has-text("Shop the look")',
                                'div[role="button"]:has-text("Shop the look")',
                                'a:has-text("Shop now")',
                                'button:has-text("Shop now")',
                                'a:has-text("Explore")',
                                'button:has-text("Explore")',
                                '.punchcard-step a',
                                '[data-bi-area*="punchcard"] a',
                                '[data-bi-id*="shop"]'
                            ]

                            for (const actionSel of actionButtonSelectors) {
                                if (signal.aborted || (typeof tab.isClosed === 'function' && tab.isClosed())) break
                                const actBtn = tab.locator(actionSel).first()
                                if (await actBtn.isVisible().catch(() => false)) {
                                    this.bot.logger.debug(
                                        this.bot.isMobile,
                                        'URL-REWARD',
                                        `Triggering punchcard action button: ${actionSel}`
                                    )
                                    await actBtn.click({ force: true }).catch(() => {})
                                    await this.bot.utils.wait(1500)
                                    break
                                }
                            }
                        }
                    })
                }

                // Simulasi interaksi scroll natural & human-like movement
                if (remainingMs() > 2000 && !tab.isClosed()) {
                    this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Simulating interaction & safe scroll...`)
                    await runGuardedOperation({
                        stage: 'safe-scroll',
                        timeoutMs: 12000,
                        remainingBudgetMs: remainingMs(),
                        page: tab,
                        logger: this.bot.logger,
                        isMobile: this.bot.isMobile,
                        operation: async (signal) => {
                            await performBoundedSafeScroll(tab, {
                                maxDurationMs: 10000,
                                maxSteps: 8,
                                stepDelayMs: 750,
                                signal,
                                logger: this.bot.logger,
                                isMobile: this.bot.isMobile
                            })
                        }
                    })
                }

                // Jeda tunggu aman telemetri (/fd/ls/ & bat.bing.com)
                const rawDwell = punchCard
                    ? this.bot.utils.randomDelay(5000, 7000)
                    : this.bot.utils.randomDelay(3500, 5000)
                const dwellTime = Math.min(rawDwell, Math.max(0, remainingMs() - 2000))
                if (dwellTime > 0) {
                    await this.bot.utils.wait(dwellTime)
                }
            } finally {
                if (tab && !tab.isClosed()) {
                    await runGuardedOperation({
                        stage: 'activity-page-close',
                        timeoutMs: 5000,
                        remainingBudgetMs: remainingMs(),
                        page: tab,
                        logger: this.bot.logger,
                        isMobile: this.bot.isMobile,
                        operation: async () => {
                            await tab.close({ runBeforeUnload: false }).catch(() => {})
                        }
                    })
                }
            }

            // 3. Secondary API reinforcement jika token/hash tersedia
            if (promotion.hash && this.bot.requestToken && remainingMs() > 2000) {
                try {
                    this.cookieHeader = this.bot.browser.func.buildCookieHeader(
                        this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop,
                        ['bing.com', 'live.com', 'microsoftonline.com']
                    )
                    const formData = new URLSearchParams({
                        id: promotion.offerId,
                        hash: promotion.hash,
                        timeZone: this.bot.userData.timezoneOffset || '60',
                        activityAmount: '1',
                        __RequestVerificationToken: this.bot.requestToken
                    })
                    await this.bot.axios
                        .request({
                            url: 'https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest',
                            method: 'POST',
                            timeout: 5000,
                            headers: {
                                ...(this.bot.fingerprint?.headers ?? {}),
                                Cookie: this.cookieHeader,
                                Referer: 'https://rewards.bing.com/'
                            },
                            data: formData
                        })
                        .catch(() => {})
                } catch {}
            }

            // Sync fresh cookies & check updated balance
            if (remainingMs() > 1000) {
                await this.bot.utils.wait(Math.min(1500, remainingMs()))
            }
            let cookieTimer: NodeJS.Timeout
            const cookieTimeoutPromise = new Promise<any[]>(resolve => {
                cookieTimer = setTimeout(() => resolve([]), 3000)
            })
            const freshCookies = await Promise.race([
                page.context().cookies(),
                cookieTimeoutPromise
            ]).finally(() => clearTimeout(cookieTimer)).catch(() => [])

            if (freshCookies && freshCookies.length > 0) {
                if (this.bot.isMobile) {
                    this.bot.cookies.mobile = freshCookies
                } else {
                    this.bot.cookies.desktop = freshCookies
                }
            }

            const offerIdLower = (promotion.offerId || '').toLowerCase()
            const isPunchCard =
                Boolean(punchCard) ||
                (promotion.promotionType ?? '').toLowerCase() === 'punchcard' ||
                offerIdLower.includes('punchcard')

            let livePoints = this.oldBalance
            let realServerDelta = 0

            if (remainingMs() > 2000) {
                const verifyResult = await runGuardedOperation({
                    stage: 'server-verification',
                    timeoutMs: 15000,
                    remainingBudgetMs: remainingMs(),
                    page,
                    logger: this.bot.logger,
                    isMobile: this.bot.isMobile,
                    operation: async () => {
                        const pts = await this.bot.browser.func.getCurrentPoints(page)
                        return pts
                    }
                })

                if (typeof verifyResult.value === 'number') {
                    livePoints = verifyResult.value
                    realServerDelta = Math.max(0, livePoints - this.oldBalance)

                    if (realServerDelta === 0 && remainingMs() > 2500) {
                        await this.bot.utils.wait(1500)
                        const recheckPts = await this.bot.browser.func.getCurrentPoints(page)
                        livePoints = recheckPts
                        realServerDelta = Math.max(0, livePoints - this.oldBalance)
                    }
                }
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `[ACTIVITY-TIMEOUT] title="${promotion.title}" stage=server-verification recovery=verification-unavailable`
                )
            }

            let calculatedDelta = 0
            let finalBalance = this.oldBalance

            if (realServerDelta > 0) {
                // Server nyata bertambah
                calculatedDelta = realServerDelta
                finalBalance = livePoints
            } else {
                // Nol poin palsu: jika server Microsoft tidak menambah saldo, tetapkan 0 poin
                calculatedDelta = 0
                finalBalance = this.oldBalance
            }

            this.updatePoints(
                finalBalance,
                promotion.offerId,
                promotion.title,
                calculatedDelta,
                isPunchCard,
                promotion.pointProgressMax
            )
        } catch (err: any) {
            this.bot.logger.error(this.bot.isMobile, 'URL-REWARD', `Process failed | offerId=${promotion.offerId}`)
        }
    }

    private updatePoints(
        newBalance: number,
        offerId: string,
        title?: string,
        pointsEarned?: number,
        isPunchCard?: boolean,
        advertisedMax?: number
    ) {
        const advertisedPoints = Number(advertisedMax ?? 10)
        const observedBalanceDelta = Math.max(0, newBalance - this.oldBalance)
        const displayTitle = title ? `"${title}"` : `offerId=${offerId}`
        const isDailySet =
            (offerId || '').toLowerCase().includes('dailyset') || (title || '').toLowerCase().includes('daily set')
        const tag = isPunchCard ? 'PUNCHCARD' : isDailySet ? 'DAILY-SET' : 'KEEP-EARNING'

        this.bot.userData.currentPoints = newBalance

        // Strict attribution: if delta != advertised, attributedPoints is unknown (null/0 card points)
        if (typeof pointsEarned === 'number' && pointsEarned > 0) {
            this.gainedPoints = pointsEarned
        } else if (observedBalanceDelta === advertisedPoints && advertisedPoints > 0) {
            this.gainedPoints = advertisedPoints
        } else {
            this.gainedPoints = 0
        }

        if (this.gainedPoints > 0) {
            this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints
            void Database.getInstance().recordActivity(
                this.bot.activeAccount?.email || '',
                isDailySet ? 'DAILY_SET' : 'PROMOTIONS',
                this.gainedPoints
            )
            this.bot.logger.info(
                this.bot.isMobile,
                tag,
                `[ACTIVITY] Verified complete: ${displayTitle} | advertisedPoints=${advertisedPoints} observedBalanceDelta=${observedBalanceDelta} attributedPoints=+${this.gainedPoints} | currentBalance=${newBalance}`,
                'green'
            )
        } else {
            if (observedBalanceDelta > 0) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    tag,
                    `[ACTIVITY] Processed: ${displayTitle} | advertisedPoints=${advertisedPoints} observedBalanceDelta=${observedBalanceDelta} serverCompleted=false attributedPoints=unknown | currentBalance=${newBalance}`,
                    'yellow'
                )
            } else if (isPunchCard) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    tag,
                    `[ACTIVITY] Step Processed: ${displayTitle} | advertisedPoints=${advertisedPoints} observedBalanceDelta=0 (progress in multi-day card) | currentBalance=${newBalance}`,
                    'green'
                )
            } else {
                this.bot.logger.info(
                    this.bot.isMobile,
                    tag,
                    `[ACTIVITY] Processed: ${displayTitle} | advertisedPoints=${advertisedPoints} observedBalanceDelta=0 serverCompleted=false | currentBalance=${newBalance}`,
                    'yellow'
                )
            }
        }
    }
}
