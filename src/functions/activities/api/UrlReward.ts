import type { BasePromotion, PunchCard } from '../../../interface/DashboardData'
import { Workers, ensureOnRewardsDashboard } from '../../Workers'
import { Page } from 'patchright'
import { Database } from '../../../util/Database'
import {
    createManagedPage,
    runGuardedOperation,
    performBoundedSafeScroll
} from '../../../runtime/BrowserOperationGuard'

export interface ActivityUrlResolution {
    url: string
    action: 'navigate' | 'bypass-navigation'
    scheme: 'http' | 'https' | 'edge-rewritten' | 'relative-resolved' | 'bypass' | 'invalid'
    originalUrl: string
}

export {
    LOCAL_SYSTEM_PROTOCOLS,
    isLocalSystemProtocol,
    resolvePunchCardExecutionUrl,
    type PunchCardUrlResolution
} from './UrlProtocolGuard'
import { isLocalSystemProtocol } from './UrlProtocolGuard'

export function normalizeActivityUrl(
    rawUrl?: string,
    baseOrigin: string = 'https://rewards.bing.com',
    fallbackQuery?: string
): ActivityUrlResolution {
    const original = (rawUrl || '').trim()

    // 1. URL kosong atau bypass scheme seperti javascript:, anchor, atau protokol sistem lokal
    if (
        !original ||
        original.toLowerCase().startsWith('javascript:') ||
        original === '#' ||
        original.toLowerCase().startsWith('ms-search:') ||
        original.toLowerCase().startsWith('ms-windows-store:') ||
        original.toLowerCase().startsWith('intent:')
    ) {
        return {
            url: '',
            action: 'bypass-navigation',
            scheme: 'bypass',
            originalUrl: original
        }
    }

    // 1b. Promo aplikasi Bing / quest eksklusif Bing App
    if (
        original.toLowerCase().includes('bing.com/apps/rewards') ||
        original.toLowerCase().includes('form=quest1')
    ) {
        return {
            url: '',
            action: 'bypass-navigation',
            scheme: 'bypass',
            originalUrl: original
        }
    }

    // 1c. Deprecated envelope endpoint (baik absolute maupun relative)
    if (original.toLowerCase().includes('/dashboard/envelope')) {
        const fallbackSearch = fallbackQuery
            ? `https://www.bing.com/search?q=${encodeURIComponent(fallbackQuery)}`
            : 'https://www.bing.com'
        return {
            url: fallbackSearch,
            action: 'navigate',
            scheme: 'edge-rewritten',
            originalUrl: original
        }
    }

    // 2. Protocol relative URL (misal //www.bing.com)
    if (original.startsWith('//')) {
        return {
            url: `https:${original}`,
            action: 'navigate',
            scheme: 'https',
            originalUrl: original
        }
    }

    // 3. Path relatif (misal /redeem/sku/... atau /dashboard/...)
    if (original.startsWith('/')) {
        try {
            const resolved = new URL(original, baseOrigin)
            return {
                url: resolved.href,
                action: 'navigate',
                scheme: 'relative-resolved',
                originalUrl: original
            }
        } catch {
            return {
                url: `https://rewards.bing.com${original}`,
                action: 'navigate',
                scheme: 'relative-resolved',
                originalUrl: original
            }
        }
    }

    // 4. Custom desktop protocol: microsoft-edge:// atau microsoft-edge:
    if (original.toLowerCase().startsWith('microsoft-edge:') || original.toLowerCase().startsWith('microsoft-edge://')) {
        let extractedUrl = ''
        try {
            const cleanEdgeStr = original.replace(/^microsoft-edge:\/\/?/i, 'https://dummy.edge.local/')
            const parsedEdge = new URL(cleanEdgeStr)
            const targetParam = parsedEdge.searchParams.get('url')
            if (targetParam) {
                extractedUrl = targetParam.trim()
            }
        } catch {}

        if (!extractedUrl) {
            const match = original.match(/^microsoft-edge:\/?\/?(https?:\/\/.+)$/i)
            if (match && match[1]) {
                extractedUrl = match[1].trim()
            }
        }

        if (extractedUrl && (extractedUrl.startsWith('http://') || extractedUrl.startsWith('https://'))) {
            return {
                url: extractedUrl,
                action: 'navigate',
                scheme: 'edge-rewritten',
                originalUrl: original
            }
        }

        const fallbackSearch = fallbackQuery
            ? `https://www.bing.com/search?q=${encodeURIComponent(fallbackQuery)}`
            : 'https://www.bing.com'
        return {
            url: fallbackSearch,
            action: 'navigate',
            scheme: 'edge-rewritten',
            originalUrl: original
        }
    }

    // 5. Validasi skema HTTP/HTTPS standar
    try {
        const parsed = new URL(original)
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return {
                url: parsed.href,
                action: 'navigate',
                scheme: parsed.protocol === 'https:' ? 'https' : 'http',
                originalUrl: original
            }
        }
    } catch {}

    // 6. Domain tanpa protokol (misal 'www.bing.com/...')
    if (/^[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/i.test(original)) {
        try {
            const withHttps = new URL(`https://${original}`)
            return {
                url: withHttps.href,
                action: 'navigate',
                scheme: 'https',
                originalUrl: original
            }
        } catch {}
    }

    // Fallback: invalid / unknown scheme -> fallback query atau bypass
    if (fallbackQuery) {
        return {
            url: `https://www.bing.com/search?q=${encodeURIComponent(fallbackQuery)}`,
            action: 'navigate',
            scheme: 'invalid',
            originalUrl: original
        }
    }

    return {
        url: '',
        action: 'bypass-navigation',
        scheme: 'invalid',
        originalUrl: original
    }
}

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
            const offerIdLower = (promotion.offerId || '').toLowerCase()
            const isDailySet =
                offerIdLower.includes('dailyset') ||
                offerIdLower.includes('child') ||
                (promotion.name || '').toLowerCase().includes('dailyset') ||
                (promotion.title || '').toLowerCase().includes('daily set')

            let targetDashboard = 'https://rewards.bing.com/earn'
            if (punchCard && punchCard.parentPromotion?.destinationUrl) {
                const parentDest = punchCard.parentPromotion.destinationUrl.trim()
                if (
                    !parentDest.toLowerCase().includes('/dashboard/envelope') &&
                    !isLocalSystemProtocol(parentDest)
                ) {
                    targetDashboard = parentDest
                }
            }

            // 1. Coba cari kartu di dashboard untuk mengambil URL terlengkap & trigger event klik
            try {
                const currentUrl = page.url().toLowerCase()

                if (isDailySet) {
                    const isDashboardLoaded = currentUrl.includes('rewards.bing.com/earn') || currentUrl.includes('rewards.bing.com/dashboard')
                    if (currentUrl.includes('/about') || !isDashboardLoaded) {
                        await ensureOnRewardsDashboard(page)
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
                        if (
                            targetDashboard.toLowerCase().includes('/dashboard/envelope') ||
                            isLocalSystemProtocol(targetDashboard)
                        ) {
                            this.bot.logger.warn(
                                this.bot.isMobile,
                                'URL-REWARD',
                                `[URI-GUARD] Intercepted invalid protocol or deprecated envelope in targetDashboard "${targetDashboard}". Falling back to safe dashboard.`
                            )
                            targetDashboard = 'https://rewards.bing.com/earn'
                        }
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
                    `#daily-sets [data-bi-id*="${promotion.offerId}"]`,
                    `#daily-sets a[href*="${promotion.offerId}"]`,
                    `#daily-sets a:has-text("${promotion.title}")`,
                    `#daily-sets div[role="button"]:has-text("${promotion.title}")`,
                    `#daily-sets button:has-text("${promotion.title}")`,
                    `#daily-sets .c-card:has-text("${firstKeywords}")`,
                    `[data-bi-area*="DailySet"] [data-bi-id*="${promotion.offerId}"]`,
                    `[data-bi-area*="DailySet"] a[href*="${promotion.offerId}"]`,
                    `[data-bi-area*="DailySet"] a:has-text("${promotion.title}")`,
                    `[data-bi-area*="DailySet"] div[role="button"]:has-text("${promotion.title}")`,
                    `[data-bi-area*="DailySet"] button:has-text("${promotion.title}")`,
                    `[data-bi-area*="DailySet"] .c-card:has-text("${firstKeywords}")`,
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
                                        '.mee-icon-CheckMark, [data-icon-name="CheckMark"], .c-glyph.f-checkmark, .c-icon-check, .complete-check, svg[aria-label*="Complete"], [class*="check"]'
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

                        if (statusInfo.href) {
                            const resHref = normalizeActivityUrl(statusInfo.href, targetDashboard, promotion.title)
                            if (resHref.action === 'navigate' && resHref.url) {
                                targetUrl = resHref.url
                            }
                        }

                        // Trigger click di dashboard
                        await el.scrollIntoViewIfNeeded().catch(() => {})
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

            // 2. Normalisasi URL aktivitas sebelum navigasi
            const resolution = normalizeActivityUrl(targetUrl, targetDashboard, promotion.title)
            targetUrl = resolution.url

            if (remainingMs() <= 0) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `[ACTIVITY-TIMEOUT] title="${promotion.title}" stage=total-budget recovery=cleanup-and-continue`
                )
                return
            }

            if (resolution.action === 'bypass-navigation') {
                if (isLocalSystemProtocol(resolution.originalUrl)) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'URL-REWARD',
                        `[URI-GUARD] Intercepted local system protocol "${resolution.originalUrl}". Gracefully bypassing navigation with simulated dwell time.`
                    )
                    await this.bot.utils.wait(Math.floor(Math.random() * 1500) + 1500)
                }
                return
            }

            if (isLocalSystemProtocol(targetUrl)) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `[URI-GUARD] Intercepted local system protocol "${targetUrl}". Gracefully bypassing navigation with simulated dwell time.`
                )
                await this.bot.utils.wait(Math.floor(Math.random() * 1500) + 1500)
                return
            }

            if (resolution.action === 'navigate' && targetUrl) {
                this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Opening Activity URL: "${promotion.title}"`)
                const tab = await createManagedPage({
                    context: page.context(),
                    purpose: 'url-reward-tab',
                    isMobile: this.bot.isMobile
                })

                try {
                const navResult = await runGuardedOperation({
                    stage: 'activity-navigation',
                    timeoutMs: 30000,
                    remainingBudgetMs: remainingMs(),
                    page: tab,
                    logger: this.bot.logger,
                    isMobile: this.bot.isMobile,
                    operation: async (_signal, timeout) => {
                        if (isLocalSystemProtocol(targetUrl)) {
                            this.bot.logger.warn(
                                this.bot.isMobile,
                                'URL-REWARD',
                                `[URI-GUARD] Intercepted local system protocol "${targetUrl}" prior to tab.goto. Gracefully bypassing.`
                            )
                            await this.bot.utils.wait(1500)
                            return
                        }
                        const response = await tab.goto(targetUrl, {
                            waitUntil: 'domcontentloaded',
                            timeout: Math.max(1000, timeout),
                            referer: 'https://rewards.bing.com/'
                        }).catch(err => {
                            throw err
                        })
                        if (response && response.status() === 404) {
                            this.bot.logger.warn(
                                this.bot.isMobile,
                                'URL-REWARD',
                                `[FAST-BAILOUT] Document returned HTTP 404 for "${targetUrl}". Bailing out immediately.`
                            )
                            throw new Error('HTTP_404_FAST_BAILOUT')
                        }
                    }
                })

                if (navResult.status === 'completed' && remainingMs() > 2000) {
                    await this.bot.utils.wait(Math.min(2000, remainingMs()))

                    // Selesaikan kuis / poll / trivia interaktif jika ada di halaman
                    await runGuardedOperation({
                        stage: 'activity-interaction',
                        timeoutMs: Math.min(30000, remainingMs()),
                        remainingBudgetMs: remainingMs(),
                        page: tab,
                        logger: this.bot.logger,
                        isMobile: this.bot.isMobile,
                        operation: async (signal) => {
                            const isExpectedQuiz = Boolean((promotion as any).isQuiz || this.isQuizPromotion(promotion))
                            const startQuizSelector =
                                '#rqStartQuiz, #rqStartQuizToken, input[value*="Start"], button:has-text("Start"), div[role="button"]:has-text("Start"), .btOption'
                            const quizOptionsSelector =
                                '[id^="rqAnswerOption"], .btOption, [id^="btoption"], .rqOptions, .wk_Option, [role="radio"], button.optionBtn, .bt_poll, input[type="radio"], .rqOption, .rq_button, [data-option]'
                            const quizContainerSelector = `${startQuizSelector}, ${quizOptionsSelector}, #rqNextQuestion`

                            // Toleransi tunggu rendering DOM kuis (dipangkas ke 1.5s untuk non-quiz / promo biasa)
                            try {
                                await tab.waitForSelector(quizContainerSelector, {
                                    state: 'attached',
                                    timeout: isExpectedQuiz ? 3000 : 1500
                                })
                            } catch {
                                // Timeout tercapai tanpa elemen kuis terdeteksi
                            }

                            // Fast-bailout untuk non-quiz / promo biasa
                            if (!isExpectedQuiz) {
                                const hasAnyQuizEl = await tab.$(quizContainerSelector).catch(() => null)
                                if (!hasAnyQuizEl) {
                                    this.bot.logger.debug(
                                        this.bot.isMobile,
                                        'URL-REWARD',
                                        'Fast-bailout: promo non-kuis tanpa elemen kuis interaktif.'
                                    )
                                    return
                                }
                            }

                            for (let q = 0; q < 10; q++) {
                                if (signal.aborted || (typeof tab.isClosed === 'function' && tab.isClosed())) break

                                const startQuizBtn = tab.locator(startQuizSelector).first()
                                let hasStartBtn = await startQuizBtn.isVisible().catch(() => false)
                                if (!hasStartBtn && isExpectedQuiz && q === 0) {
                                    hasStartBtn = await startQuizBtn
                                        .waitFor({ state: 'visible', timeout: 3000 })
                                        .then(() => true)
                                        .catch(() => false)
                                }
                                if (hasStartBtn) {
                                    this.bot.logger.info(
                                        this.bot.isMobile,
                                        'URL-REWARD',
                                        'Found start quiz button, clicking...'
                                    )
                                    await startQuizBtn.click({ force: true }).catch(() => {})
                                    await this.bot.utils.wait(1500)
                                }

                                const quizOptions = tab.locator(quizOptionsSelector)
                                const optCount = await quizOptions.count().catch(() => 0)
                                if (optCount > 0) {
                                    const randIdx = Math.floor(Math.random() * Math.min(optCount, 4))
                                    await quizOptions
                                        .nth(randIdx)
                                        .click({ force: true })
                                        .catch(() => {})
                                    await this.bot.utils.wait(1500)

                                    // Dukungan navigasi tombol lanjut #rqNextQuestion untuk kuis multi-pertanyaan
                                    const nextBtn = tab
                                        .locator(
                                            '#rqNextQuestion, input#rqNextQuestion, input[value*="Next"], button:has-text("Next"), [id*="nextQuestion"]'
                                        )
                                        .first()
                                    if (await nextBtn.isVisible().catch(() => false)) {
                                        this.bot.logger.debug(
                                            this.bot.isMobile,
                                            'URL-REWARD',
                                            'Clicking next question button (#rqNextQuestion)'
                                        )
                                        await nextBtn.click({ force: true }).catch(() => {})
                                        await this.bot.utils.wait(1500)
                                    }
                                } else {
                                    // Cek apakah ada tombol next yang perlu diklik sebelum menyerah
                                    const nextBtn = tab
                                        .locator(
                                            '#rqNextQuestion, input#rqNextQuestion, input[value*="Next"], button:has-text("Next"), [id*="nextQuestion"]'
                                        )
                                        .first()
                                    if (await nextBtn.isVisible().catch(() => false)) {
                                        await nextBtn.click({ force: true }).catch(() => {})
                                        await this.bot.utils.wait(1500)
                                        continue
                                    }

                                    // Jika pada pertanyaan pertama tidak ada tombol start maupun opsi kuis, keluar
                                    if (q === 0 && !hasStartBtn) {
                                        break
                                    }
                                    break
                                }
                            }

                            // Deteksi dan trigger tombol aksi sub-task Punch Card (hanya jika kartu punchcard)
                            if (punchCard) {
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
                        }
                    })
                }

                // Simulasi interaksi scroll natural & human-like movement (dipangkas ke 3 langkah / 2s)
                if (remainingMs() > 2000 && !tab.isClosed()) {
                    this.bot.logger.info(this.bot.isMobile, 'URL-REWARD', `Simulating interaction & safe scroll...`)
                    await runGuardedOperation({
                        stage: 'safe-scroll',
                        timeoutMs: 4000,
                        remainingBudgetMs: remainingMs(),
                        page: tab,
                        logger: this.bot.logger,
                        isMobile: this.bot.isMobile,
                        operation: async (signal) => {
                            await performBoundedSafeScroll(tab, {
                                maxDurationMs: 2000,
                                maxSteps: 3,
                                stepDelayMs: 650,
                                signal,
                                logger: this.bot.logger,
                                isMobile: this.bot.isMobile
                            })
                        }
                    })
                }

                // Eliminasi stall: batas timeout maksimal 3000ms untuk semua wait pasca scroll
                if (!tab.isClosed()) {
                    await tab.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {})
                }

                // Jeda tunggu aman telemetri (/fd/ls/ & bat.bing.com) (maksimal 3000ms)
                const rawDwell = this.bot.utils.randomDelay(2000, 3000)
                const dwellTime = Math.min(rawDwell, Math.min(3000, Math.max(0, remainingMs() - 2000)))
                if (dwellTime > 0) {
                    await this.bot.utils.wait(dwellTime)
                }
            } finally {
                if (tab && !tab.isClosed()) {
                    await runGuardedOperation({
                        stage: 'activity-page-close',
                        timeoutMs: 5000,
                        remainingBudgetMs: Math.max(5000, remainingMs()),
                        page: tab,
                        logger: this.bot.logger,
                        isMobile: this.bot.isMobile,
                        operation: async () => {
                            // Bungkus transisi penutupan halaman ke dalam timer penjaga (hard cap 5000ms)
                            // Jika dalam 5000ms halaman belum tertutup, paksa await tab.close({ runBeforeUnload: false }) dan lanjutkan workflow
                            let closeDone = false
                            const closePromise = tab
                                .close({ runBeforeUnload: false })
                                .then(() => {
                                    closeDone = true
                                })
                                .catch(() => {})

                            let timer: NodeJS.Timeout | null = null
                            const hardCapPromise = new Promise<void>(resolve => {
                                timer = setTimeout(async () => {
                                    if (!closeDone && tab && !tab.isClosed()) {
                                        this.bot.logger.warn(
                                            this.bot.isMobile,
                                            'URL-REWARD',
                                            'Timer penjaga hard cap 5000ms terpicu saat menutup activity tab. Memaksa page.close()...'
                                        )
                                        await tab.close({ runBeforeUnload: false }).catch(() => {})
                                    }
                                    resolve()
                                }, 5000)
                            })

                            await Promise.race([closePromise, hardCapPromise]).finally(() => {
                                if (timer) clearTimeout(timer)
                            })
                        }
                    }).catch(async () => {
                        if (tab && !tab.isClosed()) {
                            await tab.close({ runBeforeUnload: false }).catch(() => {})
                        }
                    })
                }
            }
            } else {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `Bypassing tab navigation for "${promotion.title}" (action=${resolution.action}, scheme=${resolution.scheme})`
                )
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

            const isPunchCard =
                Boolean(punchCard) ||
                (promotion.promotionType ?? '').toLowerCase() === 'punchcard' ||
                offerIdLower.includes('punchcard')

            let livePoints = this.oldBalance
            let realServerDelta = 0

            if (remainingMs() > 2000) {
                const verifyResult = await runGuardedOperation({
                    stage: 'server-verification',
                    timeoutMs: Math.min(30000, remainingMs()),
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

                    const isDesktopAppActivation =
                        (promotion.offerId ?? '').toLowerCase().includes('eligibility_edgebarchrome') ||
                        (promotion.offerId ?? '').toLowerCase().includes('activation_banner') ||
                        (promotion.name ?? '').toLowerCase().includes('eligibility_edgebarchrome') ||
                        (promotion.name ?? '').toLowerCase().includes('activation_banner')

                    if (isDesktopAppActivation && realServerDelta === 0) {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'URL-REWARD',
                            `[DESKTOP-ACTIVATION] Kartu "${promotion.title}" (${promotion.offerId}) ditandai sebagai promosi khusus aplikasi/desktop. Melewati reload dashboard berulang saat delta saldo 0.`
                        )
                    }

                    // Jika delta bernilai 0, lakukan reload/re-evaluate dashboard 1x untuk sinkronisasi beacon Microsoft
                    if (realServerDelta === 0 && !isDesktopAppActivation && remainingMs() > 8000 && page && !page.isClosed()) {
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'URL-REWARD',
                            `Initial balance delta is 0 for "${promotion.title}", performing 1x dashboard reload & re-evaluation...`
                        )
                        const reloadUrl = isDailySet ? 'https://rewards.bing.com/earn' : targetDashboard
                        if (isDailySet) {
                            await ensureOnRewardsDashboard(page)
                        } else if (!isLocalSystemProtocol(reloadUrl)) {
                            await page
                                .goto(reloadUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
                                .catch(() => {})
                        }
                        // Jeda hidrasi DOM pasca-reload (6000ms - 8000ms) sebelum membaca status centang atau API saldo
                        await this.bot.utils.wait(this.bot.utils.randomDelay(6000, 8000))
                        const recheckPts = await this.bot.browser.func.getCurrentPoints(page)
                        if (typeof recheckPts === 'number' && recheckPts > livePoints) {
                            livePoints = recheckPts
                            realServerDelta = Math.max(0, livePoints - this.oldBalance)
                        }

                        // Verifikasi bukti sekunder: cek status tanda centang pada DOM dashboard
                        if (realServerDelta === 0) {
                            try {
                                const cleanTitle = (promotion.title || '').replace(/[^\w\s]/gi, ' ').trim().toLowerCase()
                                const firstKeywords = cleanTitle.split(/\s+/).slice(0, 4).join(' ')
                                const isDomCompleted = await page.evaluate(
                                    ({ offerId, cleanTitle, firstKeywords }) => {
                                        // Cari elemen kartu target di dalam #daily-sets, [data-bi-area*="DailySet"], atau tile yang memuat judul kartu
                                        const dailyContainers = Array.from(
                                            document.querySelectorAll(
                                                '#daily-sets, [data-bi-area*="DailySet"], section#dailyset, .daily-set, .daily-sets, [id*="daily-set"]'
                                            )
                                        )
                                        const candidates: Element[] = []
                                        if (dailyContainers.length > 0) {
                                            for (const c of dailyContainers) {
                                                candidates.push(
                                                    ...Array.from(
                                                        c.querySelectorAll(
                                                            '[data-bi-id], a, [role="button"], .c-card, .p-card, [class*="card"], [class*="tile"], div:has(> [class*="title"])'
                                                        )
                                                    )
                                                )
                                            }
                                        }
                                        candidates.push(
                                            ...Array.from(
                                                document.querySelectorAll(
                                                    '[data-bi-id], a, [role="button"], .c-card, .p-card, .promo-tile, [class*="tile"]'
                                                )
                                            )
                                        )

                                        for (const el of candidates) {
                                            const id = (
                                                el.getAttribute('data-bi-id') ||
                                                el.getAttribute('id') ||
                                                el.getAttribute('href') ||
                                                ''
                                            ).toLowerCase()
                                            const txt = (el.textContent || '').toLowerCase()
                                            const matchesOffer = Boolean(offerId && id.includes(offerId.toLowerCase()))
                                            const matchesTitle = Boolean(
                                                cleanTitle &&
                                                    (txt.includes(cleanTitle) ||
                                                        (firstKeywords && txt.includes(firstKeywords)))
                                            )
                                            if (matchesOffer || matchesTitle) {
                                                const containerEl =
                                                    el.closest(
                                                        '.c-card, .p-card, [role="button"], a, [class*="card"], [class*="tile"]'
                                                    ) || el
                                                const hasCheck =
                                                    containerEl.querySelector(
                                                        '.mee-icon-CheckMark, [data-icon-name="CheckMark"], .c-glyph.f-checkmark, .c-icon-check, .complete-check, svg[aria-label*="Complete"], [class*="check"]'
                                                    ) !== null ||
                                                    el.querySelector(
                                                        '.mee-icon-CheckMark, [data-icon-name="CheckMark"], .c-glyph.f-checkmark, .c-icon-check, .complete-check, svg[aria-label*="Complete"], [class*="check"]'
                                                    ) !== null
                                                if (
                                                    hasCheck ||
                                                    containerEl.getAttribute('aria-checked') === 'true' ||
                                                    containerEl.classList.contains('completed') ||
                                                    containerEl.classList.contains('complete') ||
                                                    el.getAttribute('aria-checked') === 'true' ||
                                                    el.classList.contains('completed') ||
                                                    el.classList.contains('complete') ||
                                                    txt.includes('completed') ||
                                                    txt.includes('selesai')
                                                ) {
                                                    return true
                                                }
                                            }
                                        }
                                        return false
                                    },
                                    { offerId: promotion.offerId || '', cleanTitle, firstKeywords }
                                ).catch(() => false)

                                if (isDomCompleted) {
                                    this.bot.logger.info(
                                        this.bot.isMobile,
                                        'URL-REWARD',
                                        `Dashboard DOM confirmed checkmark for "${promotion.title}" (+${promotion.pointProgressMax} pts)`
                                    )
                                    const earnedPoints = Number(promotion.pointProgressMax ?? 10)
                                    realServerDelta = earnedPoints
                                    livePoints = (this.bot.userData.currentPoints ?? this.oldBalance) + earnedPoints
                                    // Sinkronisasi eksplisit saldo global
                                    this.bot.userData.currentPoints = livePoints
                                }
                            } catch {}
                        }
                    }

                    // Two-Tier Fallback Reinforcement jika delta saldo masih 0
                    if (realServerDelta === 0 && remainingMs() > 4000) {
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'URL-REWARD',
                            `[FALLBACK-REINFORCEMENT] Starting two-tier reinforcement for "${promotion.title}" (offerId=${promotion.offerId})...`
                        )

                        const activeCookies = (this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop) || []
                        const bingCookies = this.bot.browser.func.buildCookieHeader(activeCookies, [
                            'bing.com',
                            'live.com',
                            'microsoftonline.com'
                        ])

                        // Tier 1: Panggil POST https://rewards.bing.com/api/reportactivity jika actionData/hash tersedia
                        const actionHash = promotion.hash || (promotion.attributes as any)?.actionData || (promotion as any).action
                        if (actionHash && this.bot.requestToken) {
                            try {
                                this.bot.logger.debug(
                                    this.bot.isMobile,
                                    'URL-REWARD',
                                    `[FALLBACK-REINFORCEMENT] Tier 1: Dispatching api/reportactivity for offerId=${promotion.offerId}`
                                )
                                const formData = new URLSearchParams({
                                    id: promotion.offerId,
                                    hash: String(actionHash),
                                    timeZone: this.bot.userData.timezoneOffset || '60',
                                    activityAmount: '1',
                                    __RequestVerificationToken: this.bot.requestToken
                                })
                                await this.bot.axios.request({
                                    url: 'https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest',
                                    method: 'POST',
                                    timeout: 5000,
                                    headers: {
                                        ...(this.bot.fingerprint?.headers ?? {}),
                                        Cookie: bingCookies,
                                        Referer: 'https://rewards.bing.com/',
                                        'Content-Type': 'application/x-www-form-urlencoded'
                                    },
                                    data: formData.toString()
                                }).catch(() => {})
                            } catch {}
                        }

                        // Tier 2: Universal secondary reinforcement ReportActivity?ajaxreq=1
                        try {
                            this.bot.logger.debug(
                                this.bot.isMobile,
                                'URL-REWARD',
                                `[FALLBACK-REINFORCEMENT] Tier 2: Dispatching bingqa/ReportActivity?ajaxreq=1 for offerId=${promotion.offerId}`
                            )
                            const jsonData = {
                                UserId: null,
                                TimeZoneOffset: -60,
                                OfferId: promotion.offerId,
                                ActivityCount: 1,
                                QuestionIndex: '-1'
                            }
                            await this.bot.axios.request({
                                url: 'https://www.bing.com/bingqa/ReportActivity?ajaxreq=1',
                                method: 'POST',
                                timeout: 5000,
                                headers: {
                                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                                    Cookie: bingCookies,
                                    Referer: 'https://rewards.bing.com/',
                                    ...(this.bot.fingerprint?.headers ?? {})
                                },
                                data: JSON.stringify(jsonData)
                            }).catch(() => {})
                        } catch {}

                        // Jeda hidrasi (2500ms - 3500ms)
                        await this.bot.utils.wait(this.bot.utils.randomDelay(2500, 3500))

                        // Evaluasi akhir status kartu dan saldo terbaru
                        const postReinforcePts = await this.bot.browser.func.getCurrentPoints(page).catch(() => null)
                        if (typeof postReinforcePts === 'number' && postReinforcePts > livePoints) {
                            livePoints = postReinforcePts
                            realServerDelta = Math.max(0, livePoints - this.oldBalance)
                            this.bot.userData.currentPoints = livePoints
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'URL-REWARD',
                                `[FALLBACK-REINFORCEMENT] Successfully earned points via reinforcement for "${promotion.title}" (+${realServerDelta} pts)!`,
                                'green'
                            )
                        }
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
            let finalBalance = this.bot.userData.currentPoints ?? this.oldBalance

            if (realServerDelta > 0) {
                // Server nyata bertambah
                calculatedDelta = realServerDelta
                finalBalance = livePoints
            } else {
                // Nol poin palsu: jika server Microsoft tidak menambah saldo, tetapkan 0 poin
                calculatedDelta = 0
                finalBalance = this.bot.userData.currentPoints ?? this.oldBalance
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

        this.bot.userData.currentPoints = Math.max(this.bot.userData.currentPoints ?? 0, newBalance)

        // 1. Tentukan hak poin untuk kartu aktif saat ini
        let cardAttributedPoints = 0
        if (typeof pointsEarned === 'number' && pointsEarned > 0) {
            cardAttributedPoints = pointsEarned
        } else if (observedBalanceDelta === advertisedPoints && advertisedPoints > 0) {
            cardAttributedPoints = advertisedPoints
        } else if (observedBalanceDelta > advertisedPoints && advertisedPoints > 0) {
            // Delta melebihi hak kartu (lonjakan saldo tertunda) -> kartu aktif mengambil hak maksimalnya
            cardAttributedPoints = advertisedPoints
        } else if (observedBalanceDelta > 0) {
            cardAttributedPoints = Math.min(observedBalanceDelta, advertisedPoints)
        } else {
            cardAttributedPoints = 0
        }

        this.gainedPoints = cardAttributedPoints

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

        // 2. Rekonsiliasi surplus saldo dengan Pending Attribution Ledger (Delayed Attribution)
        let surplusDelta = Math.max(0, observedBalanceDelta - cardAttributedPoints)
        const pendingQueue = this.bot.workers?.pendingAttributionQueue
        if (surplusDelta > 0 && pendingQueue && pendingQueue.length > 0) {
            this.bot.logger.info(
                this.bot.isMobile,
                'RECONCILIATION',
                `[DELAYED-POINTS] Detected balance surplus (+${surplusDelta} pts). Reconciling against ${pendingQueue.length} pending activities...`,
                'green'
            )
            while (surplusDelta > 0 && pendingQueue.length > 0) {
                const pendingItem = pendingQueue[0]
                if (!pendingItem) {
                    break
                }
                const pointsToAttribute = Math.min(surplusDelta, pendingItem.advertisedPoints)

                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + pointsToAttribute
                void Database.getInstance().recordActivity(
                    this.bot.activeAccount?.email || '',
                    pendingItem.category || 'DAILY_SET',
                    pointsToAttribute
                )

                this.bot.logger.info(
                    this.bot.isMobile,
                    'RECONCILIATION',
                    `✅ Reconciled delayed points: "${pendingItem.title}" +${pointsToAttribute} pts | Remaining surplus: +${surplusDelta - pointsToAttribute}`,
                    'green'
                )

                surplusDelta -= pointsToAttribute
                if (pointsToAttribute >= pendingItem.advertisedPoints) {
                    pendingQueue.shift()
                } else {
                    pendingItem.advertisedPoints -= pointsToAttribute
                }
            }
        }
    }
}
