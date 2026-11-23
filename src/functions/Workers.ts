import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../index'
import { AccountSuspendedError, checkPageSuspension, isSuspensionContent } from '../browser/auth/SuspensionDetector'

export { AccountSuspendedError }
import type { DashboardData, PunchCard, BasePromotion, FindClippyPromotion } from '../interface/DashboardData'
import type { AppDashboardData } from '../interface/AppDashBoardData'
import type { PunchCardExecutionMode } from '../interface/Config'
import { Database } from '../util/Database'
import { resolveUrlRewardAction } from './UrlRewardActionResolver'
import { ManualQuestQueue } from '../runtime/manual/ManualQuestQueue'
import { resolveAccountIdentity } from '../runtime/identity/AccountIdentity'
import {
    ActivityExecutionResult,
    ActivityBatchSummary,
    PunchCardTaskCounts,
    PunchCardServerSnapshot,
    PunchCardStateReader,
    evaluatePunchCardRun
} from './activities/ActivitySemantics'
import { isLocalSystemProtocol, resolvePunchCardExecutionUrl } from './activities/api/UrlProtocolGuard'
export { isLocalSystemProtocol, resolvePunchCardExecutionUrl }
import { performBoundedSafeScroll } from '../runtime/BrowserOperationGuard'

export async function ensureOnRewardsDashboard(page: Page): Promise<void> {
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return
    try {
        const currentUrl = typeof page.url === 'function' ? page.url().toLowerCase() : ''
        const isOnValidRewards = currentUrl.includes('rewards.bing.com/earn') || currentUrl.includes('rewards.bing.com/dashboard')
        if (currentUrl.includes('/about') || !isOnValidRewards) {
            // Arahkan ke /earn yang stabil dan tidak memantul ke /about
            await page
                .goto('https://rewards.bing.com/earn', { waitUntil: 'domcontentloaded', timeout: 15000 })
                .catch(() => {})

            const afterNavUrl = typeof page.url === 'function' ? page.url().toLowerCase() : ''
            if (afterNavUrl.includes('/about')) {
                // Fallback kedua: coba /dashboard jika /earn terpental
                await page
                    .goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 })
                    .catch(() => {})
            }

            await page
                .waitForSelector(
                    '#daily-sets, [data-bi-area*="DailySet"], #dailyset, .daily-set, [id*="dashboard"], [class*="dashboard"], .c-card, [class*="card"]',
                    { timeout: 4000 }
                )
                .catch(() => {})
        }
    } catch {}
}

export function isQuizPromotion(activity: Partial<BasePromotion> | Record<string, any>): boolean {
    if (!activity) return false

    const type = String(activity.promotionType ?? '').toLowerCase()
    const subType = String(activity.promotionSubtype ?? '').toLowerCase()
    const title = String(activity.title ?? '').toLowerCase().trim()
    const name = String(activity.name ?? '').toLowerCase()
    const destUrl = String(activity.destinationUrl ?? '').toLowerCase()
    const points = Number(activity.pointProgressMax ?? 0)
    const maxQuestions = Number((activity.attributes as any)?.maxQuestions ?? 0)

    // 1. Tipe eksplisit atau nama aktivitas kuis
    if (type === 'quiz' || type.includes('trivia') || type.includes('poll') || type.includes('survey')) return true
    if (subType.includes('quiz') || subType.includes('trivia') || subType.includes('poll')) return true
    if (name.includes('quiz') || name.includes('trivia') || name.includes('poll')) return true

    // 2. Nilai poin khas kuis Bing (15, 30, 40, 50 poin) atau atribut multi-pertanyaan
    if ([15, 30, 40, 50].includes(points) || maxQuestions > 1) return true

    // 3. Kata kunci pertanyaan kuis pada judul
    const questionPrefixes = ['how many', 'which', 'what', 'who', 'where', 'when', 'why', 'can you', 'do you know']
    if (
        questionPrefixes.some(prefix => title.startsWith(prefix)) ||
        title.includes('?') ||
        title.includes('trivia') ||
        title.includes('test your knowledge') ||
        title.includes('quiz')
    ) {
        return true
    }

    // 4. Ciri khas query string kuis Bing
    if (destUrl.includes('filters=btepokey') || destUrl.includes('rwds_quiz') || destUrl.includes('openquiz')) {
        return true
    }

    return false
}

export class Workers {
    public static sessionUnverifiedPunchCardSteps: Set<string> = new Set<string>()
    public bot: MicrosoftRewardsBot
    public completedOffersInSession: Set<string> = new Set<string>()
    public pendingAttributionQueue: Array<{
        offerId: string
        title: string
        advertisedPoints: number
        timestamp: number
        category: string
    }> = []

    public isQuizPromotion(activity: Partial<BasePromotion> | Record<string, any>): boolean {
        return isQuizPromotion(activity)
    }

    public pass1FoundCoins: boolean = false
    public hadBrowserActivitiesSincePass1: boolean = false

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    public async checkAccountSuspended(page: Page, email?: string): Promise<boolean> {
        if (!page || typeof page.isClosed !== 'function' || page.isClosed()) return false
        const accEmail = email || this.bot?.activeAccount?.email || 'unknown'
        const suspension = await checkPageSuspension(page)
        if (suspension.isSuspended) {
            this.bot?.logger?.error?.(
                this.bot.isMobile,
                'ACCOUNT-SUSPENDED',
                `🚨 [ACCOUNT-SUSPENDED] Akun ${accEmail} TERBUKTI DITANGGUHKAN (BANNED) oleh Microsoft!`
            )
            throw new AccountSuspendedError(accEmail, suspension.reason)
        }
        return false
    }

    public async verifyDapiSuspension(error: any, page?: Page, email?: string): Promise<void> {
        const status = error?.response?.status || error?.status
        if (status === 403 || status === 401) {
            const targetPage = page || this.bot?.mainMobilePage || this.bot?.mainDesktopPage
            const accountEmail = email || this.bot?.activeAccount?.email || 'unknown'
            if (targetPage && typeof targetPage.isClosed === 'function' && !targetPage.isClosed()) {
                const content = await targetPage.content().catch(() => '')
                const url = typeof targetPage.url === 'function' ? targetPage.url() || '' : ''
                if (isSuspensionContent(content, url)) {
                    this.bot?.logger?.error?.(
                        this.bot.isMobile,
                        'ACCOUNT-SUSPENDED',
                        `🚨 [ACCOUNT-SUSPENDED] Akun ${accountEmail} TERBUKTI DITANGGUHKAN (BANNED) oleh Microsoft!`
                    )
                    throw new AccountSuspendedError(accountEmail, 'DAPI returned 401/403 and suspension banner confirmed in page')
                }
            }
        }
    }

    public async doClaimPendingPoints(page: Page, isRecheck: boolean = false): Promise<void> {
        if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return
        await this.checkAccountSuspended(page)

        try {
            // 1. Pastikan browser berada di Dashboard Rewards resmi
            await ensureOnRewardsDashboard(page)

            // 2. Hydrate lazy-loaded elements dengan scrolling jika berjalan di real browser
            if (typeof page.evaluate === 'function') {
                await page.evaluate(() => {
                    try {
                        window.scrollTo({ top: document.body.scrollHeight / 3, behavior: 'instant' })
                        window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })
                        window.scrollTo({ top: 0, behavior: 'instant' })
                    } catch {}
                }).catch(() => {})
                await this.bot.utils.wait(500)
            }

            const prefix = isRecheck ? '[RE-CHECK] ' : ''
            this.bot.logger.info(
                this.bot.isMobile,
                'DASHBOARD',
                `${prefix}Scanning Rewards dashboard for pending coins / "Ready to claim" cards...`
            )

            let clicked = false
            let textFound = ''

            // 3. Multi-tier in-browser DOM scan via page.evaluate
            if (typeof page.evaluate === 'function') {
                try {
                    const domResult = await page.evaluate(() => {
                        let count = 0
                        const foundLabels: string[] = []

                        const triggerClick = (el: HTMLElement) => {
                            try {
                                el.focus?.()
                                el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
                                el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
                                el.click()
                                return true
                            } catch {
                                return false
                            }
                        }

                        // A. Check for "Ready to claim" / "Siap diklaim" card containers
                        const allEls = Array.from(document.querySelectorAll('*'))
                        for (const el of allEls) {
                            const txt = (el.textContent || '').trim().toLowerCase()
                            if ((txt.includes('ready to claim') || txt.includes('siap diklaim')) && txt.length < 800) {
                                if (el.closest('header, nav, footer, #footer, #b_results, #ans_nws, article.news')) continue
                                const btn = (el.querySelector('button, a, [role="button"], [class*="claim"], [id*="claim"]') || el) as HTMLElement
                                if (btn && triggerClick(btn)) {
                                    count++
                                    foundLabels.push('Ready to claim')
                                }
                            }
                        }

                        // B. Direct buttons/links with claim keywords
                        const claimCandidates = Array.from(document.querySelectorAll('button, a, [role="button"], [class*="claim"], [id*="claim"], [data-bi-id*="claim"]'))
                        for (const c of claimCandidates) {
                            const cTxt = (c.textContent || '').trim().toLowerCase()
                            if (!cTxt || cTxt.length > 50) continue
                            if (c.closest('header, nav, footer, #footer, #b_results, #ans_nws')) continue
                            if (cTxt.includes('terms') || cTxt.includes('feedback') || cTxt.includes('privacy') || cTxt.includes('suggest')) continue

                            const isClaimBtn = /^(?:claim|klaim)(?:\s*(?:all|semua|points|poin|now|sekarang|\+\d+|\d+|>))?$/i.test(cTxt) ||
                                /(?:claim|klaim)\s*\+?\d+/i.test(cTxt) ||
                                /\+\d+\s*(?:claim|klaim)/i.test(cTxt) ||
                                cTxt.includes('ready to claim') ||
                                cTxt.includes('siap diklaim')

                            if (isClaimBtn) {
                                const htmlEl = c as HTMLElement
                                const rect = htmlEl.getBoundingClientRect()
                                if (rect.width > 0 && rect.height > 0) {
                                    if (triggerClick(htmlEl)) {
                                        count++
                                        foundLabels.push(cTxt)
                                    }
                                }
                            }
                        }

                        // C. Dismiss / Confirm modal flyout dialog if opened
                        const modalBtns = Array.from(document.querySelectorAll('.flyout button, .drawer button, [role="dialog"] button, [class*="modal"] button, [class*="drawer"] button, .ms-Panel button, [class*="flyout"] button'))
                        for (const mb of modalBtns) {
                            const mt = (mb.textContent || '').trim().toLowerCase()
                            if (['claim all', 'klaim semua', 'claim', 'klaim', 'got it', 'ok', 'terima', 'done', 'close', 'tutup'].includes(mt)) {
                                triggerClick(mb as HTMLElement)
                                break
                            }
                        }

                        return { count, label: foundLabels.join(', ') }
                    })

                    if (domResult && domResult.count > 0) {
                        clicked = true
                        textFound = domResult.label
                    }
                } catch {}
            }

            // 4. Deteksi kontainer kartu dengan pencarian berbasis Playwright locator (kompatibel dengan Mock Test 5 & dynamic DOM)
            const cardRegex = /ready to claim|\+\d+\s*claim|[0-9]+\s*koin|(?:claim|klaim)\s*\+?\d+|siap diklaim/i
            const cardCandidates = page
                .locator('div, section, article, [class*="card"], [class*="tile"], [class*="item"], [role="region"], li, a')
                .filter({ hasText: cardRegex })

            const cardCount = await cardCandidates.count().catch(() => 0)

            for (let i = 0; i < cardCount; i++) {
                const card = cardCandidates.nth(i)
                const isCardVis = await card.isVisible().catch(() => false)
                if (!isCardVis) continue

                const cardTxt = (await card.innerText().catch(() => '')).trim()
                if (!cardTxt || cardTxt.length > 1500) continue
                if (cardTxt.length < 50 && (cardTxt.startsWith('Available points') || cardTxt.startsWith('Poin yang tersedia'))) {
                    continue
                }
                if (!cardRegex.test(cardTxt)) continue

                // Ambil nilai poin yang tertera di dalam teks kartu (misal: "195") untuk dicatat di log
                let claimedPoints = '0'
                const ptsMatch =
                    cardTxt.match(/(?:ready to claim|siap diklaim)[\s\S]*?(\d+)/i) ||
                    cardTxt.match(/\+(\d+)\s*(?:claim|klaim)/i) ||
                    cardTxt.match(/(\d+)\s*(?:koin|pts|points)/i) ||
                    cardTxt.match(/(?:claim|klaim)[\s\S]*?(\d+)/i) ||
                    cardTxt.match(/(\d+)/)

                if (ptsMatch && ptsMatch[1]) {
                    claimedPoints = ptsMatch[1]
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'DASHBOARD',
                    `[DASHBOARD] 🎉 Terdeteksi koin pending: ${claimedPoints} Pts. Mengeksekusi klaim...`,
                    'green'
                )

                let clickExecuted = false

                // Multi-tier locator:
                // 1. Tier 1: card.locator('button, a, [role="button"]').filter({ hasText: /claim|klaim|>/i }).first()
                const tier1Btn = card.locator('button, a, [role="button"]').filter({ hasText: /claim|klaim|>/i }).first()
                if (await tier1Btn.isVisible().catch(() => false)) {
                    await tier1Btn.click({ timeout: 5000 }).catch(async () => {
                        await tier1Btn.evaluate((b: HTMLElement) => {
                            b.click()
                            b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                        }).catch(() => {})
                    })
                    clickExecuted = true
                }

                // 2. Tier 2: card.locator('[class*="claim"], [class*="action"], [id*="claim"]').first()
                if (!clickExecuted) {
                    const tier2Btn = card.locator('[class*="claim"], [class*="action"], [id*="claim"]').first()
                    if (await tier2Btn.isVisible().catch(() => false)) {
                        await tier2Btn.click({ timeout: 5000 }).catch(async () => {
                            await tier2Btn.evaluate((b: HTMLElement) => {
                                b.click()
                                b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                            }).catch(() => {})
                        })
                        clickExecuted = true
                    }
                }

                // 3. Tier 3: card.click({ force: true })
                if (!clickExecuted) {
                    await card.click({ force: true, timeout: 5000 }).catch(async () => {
                        await card.evaluate((b: HTMLElement) => {
                            b.click()
                            b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                        }).catch(() => {})
                    })
                    clickExecuted = true
                }

                if (clickExecuted) {
                    await this.bot.utils.wait(1500)
                    clicked = true
                    textFound = textFound ? `${textFound}, ${claimedPoints} Pts` : `${claimedPoints} Pts`
                }
            }

            // 5. Evaluasi tombol claim langsung di DOM jika belum menemukan dari kartu
            if (!clicked) {
                const directBtns = page.locator(
                    'button:has-text("Claim"), [role="button"]:has-text("Claim"), button.c-action-trigger, button:has-text("Klaim"), [role="button"]:has-text("Klaim")'
                )
                const directCount = await directBtns.count().catch(() => 0)
                for (let j = 0; j < directCount; j++) {
                    const btn = directBtns.nth(j)
                    if (await btn.isVisible().catch(() => false)) {
                        const bTxt = (await btn.innerText().catch(() => '')).trim().toLowerCase()
                        if (bTxt.includes('available') || bTxt.includes('tersedia')) continue
                        const isClaimBtn = /^(?:claim|klaim)(?:\s*(?:all|semua|points|poin|now|sekarang|\+\d+|\d+|>))?$/i.test(bTxt) ||
                            /(?:claim|klaim)\s*\+?\d+/i.test(bTxt) ||
                            /\+\d+\s*(?:claim|klaim)/i.test(bTxt) ||
                            bTxt.includes('claim') ||
                            bTxt.includes('klaim') ||
                            bTxt.includes('siap diklaim') ||
                            bTxt.includes('ready to claim')

                        if (isClaimBtn) {
                            await btn.click({ timeout: 5000 }).catch(async () => {
                                await btn.evaluate((b: HTMLElement) => b.click()).catch(() => {})
                            })
                            await this.bot.utils.wait(1500)
                            clicked = true
                            textFound = textFound ? `${textFound}, ${bTxt}` : bTxt
                            break
                        }
                    }
                }
            }

            // 6. Direct browser endpoint trigger /api/claimallpointsasync
            if (typeof page.evaluate === 'function') {
                await page.evaluate(async () => {
                    try {
                        await fetch('/api/claimallpointsasync', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                                'X-Requested-With': 'XMLHttpRequest'
                            },
                            body: 'timeZone=' + (new Date().getTimezoneOffset())
                        }).catch(() => {})
                    } catch {}
                }).catch(() => {})
            }

            // 7. Coba tutup panel/modal jika ada
            const closeBtn = page.locator(
                'button[aria-label*="close" i], button[aria-label*="tutup" i], button.ms-Panel-closeButton, [data-icon-name="Cancel"], [aria-label="Close"]'
            ).first()
            if (await closeBtn.isVisible().catch(() => false)) {
                await closeBtn.click().catch(() => {})
            }

            if (!clicked) {
                if (!isRecheck) {
                    this.pass1FoundCoins = false
                }
                this.bot.logger.info(
                    this.bot.isMobile,
                    'DASHBOARD',
                    `${prefix}✅ Pengecekan koin selesai: Tidak ada koin nyangkut (0 pending claims).`
                )
                return
            }

            if (!isRecheck) {
                this.pass1FoundCoins = true
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'DASHBOARD',
                `${prefix}🎉 Koin nyangkut terdeteksi ("${textFound}"). Klaim instan berhasil dieksekusi!`,
                'green'
            )

            await this.bot.utils.wait(800)

            const oldBalance = Number(this.bot.userData.currentPoints ?? 0)
            const newBalance = await this.bot.browser.func.getCurrentPoints(page).catch(() => oldBalance)
            const gainedPoints = Math.max(0, newBalance - oldBalance)

            if (gainedPoints > 0) {
                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
                this.bot.logger.info(
                    this.bot.isMobile,
                    'DASHBOARD',
                    `${prefix}✅ Koin nyangkut sukses diamankan! | +${gainedPoints} points | newBalance=${this.bot.userData.currentPoints}`,
                    'green'
                )
                void Database.getInstance().recordActivity(
                    this.bot.activeAccount?.email || '',
                    'CLAIM_PENDING_POINTS',
                    gainedPoints
                )
            } else {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'DASHBOARD',
                    `${prefix}🎯 Klaim instan selesai (${newBalance} pts).`,
                    'green'
                )
            }

            // Final verify: apakah masih ada koin pending / card nyangkut yang tersisa?
            const remainingCardCount = await page
                .locator('div, section, article, [class*="card"], [class*="tile"], [class*="item"], [role="region"], li, a')
                .filter({ hasText: cardRegex })
                .count()
                .catch(() => 0)

            const remainingDirectBtns = await page
                .locator('button:has-text("Claim"), [role="button"]:has-text("Claim"), button.c-action-trigger, button:has-text("Klaim"), [role="button"]:has-text("Klaim")')
                .count()
                .catch(() => 0)

            const finalVerify = {
                isClean: remainingCardCount === 0 && remainingDirectBtns === 0
            }

            if (finalVerify.isClean === false && !isRecheck) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'DASHBOARD',
                    `[CLAIM-RETRY] Terdeteksi koin pending masih belum bersih (isClean=false). Menunggu 2500ms untuk 1x retry klaim ulang...`,
                    'yellow'
                )
                await this.bot.utils.wait(2500)
                return await this.doClaimPendingPoints(page, true)
            }
        } catch {
            this.bot.logger.debug(this.bot.isMobile, 'DASHBOARD', 'Pengecekan koin nyangkut selesai.')
        }
    }

    public async doDailySet(data: DashboardData, page: Page) {
        this.hadBrowserActivitiesSincePass1 = true
        if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return
        await this.checkAccountSuspended(page)
        await ensureOnRewardsDashboard(page)

        // 1. Ambil dari seluruh tanggal di dailySetPromotions (API)
        const dailySetMapItems: BasePromotion[] = Object.values(data.dailySetPromotions ?? {}).flat() as BasePromotion[]

        const fallbackPromos = [
            ...(data.promotionalItems ?? []),
            ...(data.morePromotions ?? []),
            ...(data.morePromotionsWithoutPromotionalItems ?? [])
        ].filter(x => (x?.offerId ?? '').toLowerCase().includes('dailyset')) as BasePromotion[]

        const combined = [...dailySetMapItems, ...fallbackPromos].filter(Boolean)
        let uniqueDailySet = [...new Map(combined.map(p => [p.offerId, p])).values()]

        // Filter tanggal hari ini (Lokal & UTC) & abaikan preview misi hari esok serta misi kadaluarsa kemarin
        const now = new Date()
        const todayLocal = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
        const todayUtc = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`
        const validDates = new Set([todayLocal, todayUtc])

        // Filter item Daily Set khusus untuk hari ini dari API
        const todayDailySetItems = uniqueDailySet.filter(x => {
            if (!x) return false
            const offerIdLower = (x.offerId ?? '').toLowerCase()
            if (offerIdLower.includes('locked')) return false

            // Lewati jika tanggal DailySet bukan hari ini (kemarin kadaluarsa, besok terkunci)
            const dateMatch = (x.offerId ?? '').match(/DailySet_(\d{8})/i)
            if (dateMatch && dateMatch[1] && !validDates.has(dateMatch[1])) {
                return false
            }
            return true
        })

        // Kunci uniqueDailySet hanya pada katalog hari ini (3 kartu) agar tidak melaporkan 9 item (preview besok/kemarin)
        uniqueDailySet = todayDailySetItems

        let activitiesUncompleted = todayDailySetItems.filter(x => {
            if (!x || x.complete || (x.pointProgressMax > 0 && (x.pointProgress ?? 0) >= x.pointProgressMax))
                return false
            return true
        })

        // 1. Jika API menemukan item Daily Set untuk hari ini dan semuanya sudah berstatus complete,
        // pastikan tidak ada desinkronisasi dengan kartu aktif di Flyout Drawer (Streak vs Quest Discrepancy Guard)
        if (todayDailySetItems.length > 0 && activitiesUncompleted.length === 0) {
            let hasUnfinishedFlyoutCards = false
            if (page && !page.isClosed()) {
                try {
                    const isDrawerVisible = await this.openDailySetStreakFlyout(page).catch(() => false)

                    if (isDrawerVisible) {
                        const plusCardsCount = await page
                            .evaluate(() => {
                                const containers = Array.from(
                                    document.querySelectorAll(
                                        '[role="dialog"], aside, [class*="flyout"], [class*="drawer"], [class*="panel"], [class*="ms-Panel"], [class*="ms-Layer"], [class*="modal"]'
                                    )
                                )
                                let count = 0
                                for (const c of containers) {
                                    const txt = (c.textContent || '').toLowerCase()
                                    if (txt.includes('daily set streak') || txt.includes('complete all 3') || txt.includes('complete all')) {
                                        const cards = c.querySelectorAll('button, a, [role="button"], [class*="card"], [class*="tile"]')
                                        for (const card of Array.from(cards)) {
                                            if (/\+\d+/.test(card.textContent || '')) count++
                                        }
                                    }
                                }
                                return count
                            })
                            .catch(() => 0)

                        if (plusCardsCount > 0) {
                            hasUnfinishedFlyoutCards = true
                        }
                    }
                } catch {}
            }

            if (!hasUnfinishedFlyoutCards) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'DAILY-SET',
                    `Daily Set already completed for today! (${todayDailySetItems.length}/${todayDailySetItems.length} verified on server)`,
                    'green'
                )
                return
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'DAILY-SET',
                    '⚠️ [STREAK-DISCREPANCY] Status streak API tercatat selesai, namun kartu di Flyout Drawer masih memiliki poin aktif (+10). Membatalkan fast-bailout & mengeksekusi kartu!',
                    'yellow'
                )
                activitiesUncompleted = todayDailySetItems
            }
        }

        // 2. Fallback: HANYA jika dari API sama sekali tidak ditemukan item Daily Set hari ini, periksa Live DOM Dashboard
        if (todayDailySetItems.length === 0 && activitiesUncompleted.length === 0) {
            try {
                const currentUrl = page.url().toLowerCase()
                const isDashboardLoaded = currentUrl.includes('rewards.bing.com/earn') || currentUrl.includes('rewards.bing.com/dashboard')
                if (currentUrl.includes('/about') || !isDashboardLoaded) {
                    await ensureOnRewardsDashboard(page)
                    await this.bot.utils.wait(2000)
                }

                const liveDailySetCards: BasePromotion[] = await page
                    .evaluate(() => {
                        const results: any[] = []

                        // 1. Cari elemen heading / teks "Daily set"
                        const allElements = Array.from(document.querySelectorAll('*'))
                        let dailySetSection: HTMLElement | null = null

                        for (const el of allElements) {
                            const directText = Array.from(el.childNodes)
                                .filter(n => n.nodeType === Node.TEXT_NODE)
                                .map(n => n.textContent?.trim())
                                .join(' ')
                                .toLowerCase()

                            if (directText === 'daily set' || directText.startsWith('daily set')) {
                                dailySetSection = (el.closest('section') ||
                                    el.closest('[class*="section"]') ||
                                    el.parentElement?.parentElement ||
                                    el.parentElement) as HTMLElement
                                break
                            }
                        }

                        if (!dailySetSection) {
                            dailySetSection = document.querySelector(
                                '#dailyset, [data-bi-area*="DailySet"], .daily-set, [id*="daily-set"]'
                            ) as HTMLElement
                        }

                        if (!dailySetSection) return results

                        // 2. Ekstrak kartu-kartu di dalam section Daily Set
                        const candidateCards = Array.from(
                            dailySetSection.querySelectorAll(
                                'a, [role="button"], .c-card, .p-card, [class*="card"], div:has(> [class*="title"]), div:has(> [class*="heading"])'
                            )
                        )

                        const seenTitles = new Set<string>()

                        for (const rawEl of candidateCards) {
                            const el = rawEl as HTMLElement
                            const txt = (el.innerText || el.textContent || '').trim()
                            if (!txt) continue

                            if (txt.toLowerCase().startsWith('daily set')) continue

                            const titleEl = el.querySelector(
                                'h3, h4, h5, .title, .c-heading, [class*="title"], [class*="heading"]'
                            )
                            const rawTitle = (titleEl?.textContent || el.getAttribute('aria-label') || '').trim()

                            const lines = txt
                                .split('\n')
                                .map(l => l.trim())
                                .filter(Boolean)
                            const title = rawTitle || lines[0] || ''

                            if (!title || title.length > 60 || seenTitles.has(title.toLowerCase())) continue

                            const href =
                                el.getAttribute('href') ||
                                el.querySelector('a')?.getAttribute('href') ||
                                'https://rewards.bing.com'

                            const hasCheckmark =
                                el.querySelector(
                                    '.mee-icon-CheckMark, [data-icon-name="CheckMark"], .c-icon-check, .complete-check, svg[aria-label*="Complete"], [class*="check"]'
                                ) !== null ||
                                el.getAttribute('aria-checked') === 'true' ||
                                el.classList.contains('completed') ||
                                txt.toLowerCase().includes('completed') ||
                                txt.toLowerCase().includes('selesai')

                            const pointsMatch = txt.match(/\+(\d+)/)
                            const points = pointsMatch && pointsMatch[1] ? parseInt(pointsMatch[1], 10) : 10

                            if (!hasCheckmark && points > 0) {
                                seenTitles.add(title.toLowerCase())
                                let extractedOfferId =
                                    el.getAttribute('data-offer-id') ||
                                    el.getAttribute('data-bi-id') ||
                                    el.querySelector('[data-offer-id]')?.getAttribute('data-offer-id') ||
                                    el.querySelector('[data-bi-id]')?.getAttribute('data-bi-id') ||
                                    ''

                                if (!extractedOfferId && href) {
                                    try {
                                        const urlObj = new URL(href.startsWith('http') ? href : `https://rewards.bing.com${href}`)
                                        extractedOfferId =
                                            urlObj.searchParams.get('offerId') ||
                                            urlObj.searchParams.get('id') ||
                                            urlObj.searchParams.get('offerid') ||
                                            urlObj.searchParams.get('rwds_quiz') ||
                                            ''
                                    } catch {}
                                }

                                const invalidIds = new Set(['', 'root', 'main', 'app', 'content', 'header', 'footer', 'dailyset', 'daily-set'])
                                if (invalidIds.has(extractedOfferId.toLowerCase().trim()) || extractedOfferId.trim().length < 3) {
                                    extractedOfferId = ''
                                }

                                const finalOfferId = extractedOfferId ? extractedOfferId.trim() : `dom_dailyset_${title.replace(/[^\w]/g, '_').toLowerCase()}`
                                const isQuizType =
                                    title.toLowerCase().includes('?') ||
                                    txt.toLowerCase().includes('test your knowledge') ||
                                    txt.toLowerCase().includes('quiz')
                                const isPuzzleType = title.toLowerCase().includes('puzzle') || txt.toLowerCase().includes('puzzle')

                                results.push({
                                    title,
                                    destinationUrl: href.startsWith('http') ? href : 'https://rewards.bing.com',
                                    pointProgressMax: points,
                                    pointProgress: 0,
                                    complete: false,
                                    offerId: finalOfferId,
                                    promotionType: isQuizType ? 'quiz' : (isPuzzleType ? 'puzzle' : 'urlreward'),
                                    isQuiz: isQuizType,
                                    isPuzzle: isPuzzleType
                                } as any)
                            }
                        }
                        return results
                    })
                    .catch(() => [])

                if (liveDailySetCards.length > 0) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'DAILY-SET',
                        `[LIVE-DOM] Ditemukan ${liveDailySetCards.length} kartu Daily Set aktif langsung dari halaman web!`,
                        'green'
                    )
                    activitiesUncompleted = liveDailySetCards
                    uniqueDailySet = [...uniqueDailySet, ...liveDailySetCards]
                }
            } catch {}
        }

        if (uniqueDailySet.length === 0) {
            const currentGeo = (this.bot.userData.geoLocale || 'auto').toUpperCase()
            const activeIpCountry = ((this.bot as any).currentActiveIpCountry || '').toUpperCase()
            if (currentGeo === 'ID' || activeIpCountry === 'ID') {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'DAILY-SET',
                    'ℹ️ [GEO-ADAPTIVE] Regional Indonesia (ID) tidak memiliki katalog "Daily Set" (Streak 3 kartu). Misi harian dipusatkan di "Keep earning", Daily Check-In, dan Read to Earn.',
                    'cyan'
                )
            }
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'TASK-DETECT',
            `[TASK-DETECT] Daily Set items found: ${uniqueDailySet.length} / uncompleted: ${activitiesUncompleted.length}`
        )

        if (activitiesUncompleted.length) {
            const startBalance = Number(this.bot.userData.currentPoints ?? 0)
            this.bot.logger.info(
                this.bot.isMobile,
                'DAILY-SET',
                `Started solving ${activitiesUncompleted.length} "Daily Set" items (All Valid Variants Checked) | currentPoints=${startBalance}`
            )

            // 1. Simpan execution result sementara per offerId
            const executionMap = new Map<string, ActivityExecutionResult>()
            for (const act of activitiesUncompleted) {
                const key = act.offerId || act.title
                executionMap.set(key, {
                    offerId: act.offerId,
                    title: act.title,
                    status: 'pending',
                    advertisedPoints: Number(act.pointProgressMax ?? 10),
                    observedBalanceDelta: 0,
                    attributedPoints: null,
                    serverCompleted: false,
                    completionEvidence: 'none'
                })
            }

            // Pastikan halaman dashboard dalam kondisi bersih dan bebas overlay sebelum eksekusi kartu
            if (page && !page.isClosed()) {
                await ensureOnRewardsDashboard(page)
                await this.bot.utils.wait(1000)
            }

            // 2. Coba selesaikan via Modern Flyout Drawer (prioritas pertama untuk modern UI rewards.bing.com/earn)
            await this.solveModernDailySetFlyout(page, activitiesUncompleted, executionMap)

            // Selesaikan kartu yang masih belum berstatus verified-complete melalui solver fallback
            const remainingToSolve = activitiesUncompleted.filter(act => {
                const key = act.offerId || act.title
                return executionMap.get(key)?.status !== 'verified-complete'
            })

            if (remainingToSolve.length > 0) {
                await this.solveActivities(remainingToSolve, page)
            }

            // 3. Ambil SATU server snapshot setelah batch
            await this.bot.utils.wait(2000)
            const refreshedData: DashboardData | null = await this.bot.browser.func.getDashboardData().catch(() => null)
            const updatedBalance =
                refreshedData?.userStatus?.availablePoints ??
                (await this.bot.browser.func.getCurrentPoints().catch(() => startBalance))
            const observedBalanceDelta = Math.max(0, updatedBalance - startBalance)

            // 4. Reconcile seluruh result berdasarkan exact offerId
            const freshItems: BasePromotion[] = refreshedData?.dailySetPromotions
                ? (Object.values(refreshedData.dailySetPromotions).flat() as BasePromotion[])
                : []
            const fallbackFresh: BasePromotion[] = refreshedData
                ? ([...(refreshedData.promotionalItems ?? []), ...(refreshedData.morePromotions ?? [])].filter(x =>
                      (x?.offerId ?? '').toLowerCase().includes('dailyset')
                  ) as BasePromotion[])
                : []
            const allFreshDailySet = [...freshItems, ...fallbackFresh]

            // Evaluasi status centang hijau langsung dari DOM dashboard (Pastikan page context berada di rewards.bing.com)
            let domCheckmarkMap: Record<string, boolean> = {}
            if (page && !page.isClosed()) {
                try {
                    const curUrl = page.url().toLowerCase()
                    const isDashboardLoaded = curUrl.includes('rewards.bing.com/earn') || curUrl.includes('rewards.bing.com/dashboard')
                    if (curUrl.includes('/about') || !isDashboardLoaded) {
                        await ensureOnRewardsDashboard(page)
                        await this.bot.utils.wait(1500)
                    }
                    domCheckmarkMap = await page.evaluate(() => {
                        const statusMap: Record<string, boolean> = {}
                        const dailyContainers = Array.from(
                            document.querySelectorAll(
                                '#daily-sets, [data-bi-area*="DailySet"], section#dailyset, .daily-set, .daily-sets, [id*="daily-set"], [role="dialog"], aside, [class*="flyout"], [class*="drawer"]'
                            )
                        )
                        const candidateCards: Element[] = []
                        if (dailyContainers.length > 0) {
                            for (const c of dailyContainers) {
                                candidateCards.push(
                                    ...Array.from(
                                        c.querySelectorAll('.c-card, .p-card, a, [role="button"], [class*="card"], [class*="tile"], div:has(> [class*="title"]), div:has(> [class*="heading"])')
                                    )
                                )
                            }
                        }
                        if (candidateCards.length === 0) {
                            candidateCards.push(
                                ...Array.from(
                                    document.querySelectorAll('#daily-sets .c-card, #daily-sets .p-card, [data-bi-area*="DailySet"] .c-card, .c-card, .p-card, a, [role="button"], [class*="card"]')
                                )
                            )
                        }

                        for (const card of candidateCards) {
                            const titleEl = card.querySelector('h3, h4, h5, .title, .c-heading, [class*="title"], [class*="heading"]')
                            const rawTitle = (titleEl?.textContent || card.getAttribute('aria-label') || '').trim().toLowerCase()
                            const lines = (card.textContent || '').split('\n').map(l => l.trim().toLowerCase()).filter(Boolean)
                            const title = rawTitle || lines[0] || ''

                            // Abaikan kartu ringkasan streak ("Daily Set Streak", "Bing Search Streak") agar centang streak tidak disalahartikan sebagai selesai misi
                            if (title.includes('streak') || title === 'daily set streak' || title === 'bing search streak') {
                                continue
                            }

                            const hasCheck =
                                card.querySelector(
                                    '.mee-icon-CheckMark, [data-icon-name="CheckMark"], .c-glyph.f-checkmark, .c-icon-check, .complete-check, svg[aria-label*="Complete"], [class*="check"]'
                                ) !== null ||
                                card.classList.contains('completed') ||
                                card.classList.contains('complete') ||
                                card.getAttribute('aria-checked') === 'true' ||
                                (card.textContent || '').toLowerCase().includes('completed') ||
                                (card.textContent || '').toLowerCase().includes('selesai')
                            if (title) statusMap[title] = hasCheck
                        }
                        return statusMap
                    }).catch(() => ({} as Record<string, boolean>))
                } catch {}
            }

            for (const [key, result] of executionMap.entries()) {
                const freshMatch = allFreshDailySet.find(
                    f =>
                        f &&
                        (f.offerId === result.offerId ||
                            (f.title && f.title.toLowerCase().trim() === result.title.toLowerCase().trim()))
                )
                const isServerComplete = Boolean(
                    freshMatch &&
                    (freshMatch.complete === true ||
                        (freshMatch.pointProgressMax > 0 &&
                            (freshMatch.pointProgress ?? 0) >= freshMatch.pointProgressMax))
                )

                // Cek DOM checkmark sekunder jika server API belum merefleksikan complete: true
                const titleKey = (result.title || '').toLowerCase().trim()
                const isDomComplete = Boolean(
                    domCheckmarkMap[titleKey] ||
                    Object.entries(domCheckmarkMap).some(([k, v]) => v && (k.includes(titleKey) || titleKey.includes(k)))
                )

                if (isServerComplete || isDomComplete) {
                    const evidence = isServerComplete ? 'server-dashboard-state' : 'dom-checkmark'
                    if (isDomComplete && !isServerComplete) {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'DAILY-SET',
                            `Dashboard DOM confirmed checkmark for "${result.title}" (+${result.advertisedPoints} pts)`,
                            'green'
                        )
                    }

                    const attributed =
                        observedBalanceDelta === result.advertisedPoints && result.advertisedPoints > 0
                            ? result.advertisedPoints
                            : null

                    executionMap.set(key, {
                        ...result,
                        status: 'verified-complete',
                        serverCompleted: true,
                        completionEvidence: evidence,
                        observedBalanceDelta,
                        attributedPoints: attributed
                    })

                    // Jika diverifikasi via DOM namun saldo instan belum bertambah (delayed eventual consistency),
                    // daftarkan ke pending attribution ledger
                    if (attributed === null && result.advertisedPoints > 0) {
                        this.pendingAttributionQueue.push({
                            offerId: result.offerId || key,
                            title: result.title,
                            advertisedPoints: result.advertisedPoints,
                            timestamp: Date.now(),
                            category: 'DAILY_SET'
                        })
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'DAILY-SET',
                            `Enqueued "${result.title}" (+${result.advertisedPoints} pts) into pending attribution ledger (waiting for server sync)`
                        )
                    }
                } else {
                    executionMap.set(key, {
                        ...result,
                        status: 'processed-unverified',
                        serverCompleted: false,
                        completionEvidence: 'none',
                        observedBalanceDelta,
                        attributedPoints: null
                    })
                }
            }

            // Auto-Retry 1x khusus untuk item yang berstatus 'processed-unverified'
            const unverifiedItems = activitiesUncompleted.filter(act => {
                const key = act.offerId || act.title
                return executionMap.get(key)?.status === 'processed-unverified'
            })

            let finalUpdatedBalance = updatedBalance
            let finalObservedDelta = observedBalanceDelta

            if (unverifiedItems.length > 0 && page && !page.isClosed()) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'DAILY-SET',
                    `[AUTO-RETRY] Ditemukan ${unverifiedItems.length} item Daily Set berstatus 'processed-unverified'. Menjalankan 1x auto-retry...`,
                    'yellow'
                )
                await this.bot.utils.wait(2000)
                await ensureOnRewardsDashboard(page)
                // Coba auto-retry via Flyout Drawer terlebih dahulu
                await this.solveModernDailySetFlyout(page, unverifiedItems, executionMap)
                const stillUnverified = unverifiedItems.filter(act => {
                    const key = act.offerId || act.title
                    return executionMap.get(key)?.status !== 'verified-complete'
                })
                if (stillUnverified.length > 0) {
                    await this.solveActivities(stillUnverified, page)
                }

                // Re-fetch snapshot setelah auto-retry
                await this.bot.utils.wait(2000)
                const retryRefreshedData: DashboardData | null = await this.bot.browser.func.getDashboardData().catch(() => null)
                if (retryRefreshedData?.userStatus?.availablePoints) {
                    finalUpdatedBalance = Math.max(
                        finalUpdatedBalance,
                        retryRefreshedData.userStatus.availablePoints
                    )
                }
                finalObservedDelta = Math.max(0, finalUpdatedBalance - startBalance)

                const retryFreshItems: BasePromotion[] = retryRefreshedData?.dailySetPromotions
                    ? (Object.values(retryRefreshedData.dailySetPromotions).flat() as BasePromotion[])
                    : []
                const retryFallbackFresh: BasePromotion[] = retryRefreshedData
                    ? ([...(retryRefreshedData.promotionalItems ?? []), ...(retryRefreshedData.morePromotions ?? [])].filter(x =>
                          (x?.offerId ?? '').toLowerCase().includes('dailyset')
                      ) as BasePromotion[])
                    : []
                const retryAllFresh = [...retryFreshItems, ...retryFallbackFresh]

                let retryDomCheckmarkMap: Record<string, boolean> = {}
                try {
                    await ensureOnRewardsDashboard(page)
                    retryDomCheckmarkMap = await page.evaluate(() => {
                        const statusMap: Record<string, boolean> = {}
                        const dailyContainers = Array.from(
                            document.querySelectorAll(
                                '#daily-sets, [data-bi-area*="DailySet"], section#dailyset, .daily-set, .daily-sets, [id*="daily-set"], [role="dialog"], aside, [class*="flyout"], [class*="drawer"]'
                            )
                        )
                        const candidateCards: Element[] = []
                        if (dailyContainers.length > 0) {
                            for (const c of dailyContainers) {
                                candidateCards.push(
                                    ...Array.from(
                                        c.querySelectorAll('.c-card, .p-card, a, [role="button"], [class*="card"], [class*="tile"], div:has(> [class*="title"]), div:has(> [class*="heading"])')
                                    )
                                )
                            }
                        }
                        if (candidateCards.length === 0) {
                            candidateCards.push(
                                ...Array.from(
                                    document.querySelectorAll('#daily-sets .c-card, #daily-sets .p-card, [data-bi-area*="DailySet"] .c-card, .c-card, .p-card, a, [role="button"], [class*="card"]')
                                )
                            )
                        }

                        for (const card of candidateCards) {
                            const titleEl = card.querySelector('h3, h4, h5, .title, .c-heading, [class*="title"], [class*="heading"]')
                            const rawTitle = (titleEl?.textContent || card.getAttribute('aria-label') || '').trim().toLowerCase()
                            const lines = (card.textContent || '').split('\n').map(l => l.trim().toLowerCase()).filter(Boolean)
                            const title = rawTitle || lines[0] || ''

                            // Abaikan kartu ringkasan streak agar tidak salah teridentifikasi
                            if (title.includes('streak') || title === 'daily set streak' || title === 'bing search streak') {
                                continue
                            }

                            const hasCheck =
                                card.querySelector(
                                    '.mee-icon-CheckMark, [data-icon-name="CheckMark"], .c-glyph.f-checkmark, .c-icon-check, .complete-check, svg[aria-label*="Complete"], [class*="check"]'
                                ) !== null ||
                                card.classList.contains('completed') ||
                                card.classList.contains('complete') ||
                                card.getAttribute('aria-checked') === 'true' ||
                                (card.textContent || '').toLowerCase().includes('completed') ||
                                (card.textContent || '').toLowerCase().includes('selesai')
                            if (title) statusMap[title] = hasCheck
                        }
                        return statusMap
                    }).catch(() => ({} as Record<string, boolean>))
                } catch {}

                for (const act of unverifiedItems) {
                    const key = act.offerId || act.title
                    const existingResult = executionMap.get(key)
                    if (!existingResult) continue

                    const freshMatch = retryAllFresh.find(
                        f =>
                            f &&
                            (f.offerId === existingResult.offerId ||
                                (f.title && f.title.toLowerCase().trim() === existingResult.title.toLowerCase().trim()))
                    )
                    const isServerComplete = Boolean(
                        freshMatch &&
                        (freshMatch.complete === true ||
                            (freshMatch.pointProgressMax > 0 &&
                                (freshMatch.pointProgress ?? 0) >= freshMatch.pointProgressMax))
                    )
                    const titleKey = (existingResult.title || '').toLowerCase().trim()
                    const isDomComplete = Boolean(
                        retryDomCheckmarkMap[titleKey] ||
                        Object.entries(retryDomCheckmarkMap).some(([k, v]) => v && (k.includes(titleKey) || titleKey.includes(k)))
                    )

                    if (isServerComplete || isDomComplete) {
                        const evidence = isServerComplete ? 'server-dashboard-state' : 'dom-checkmark'
                        const attributed =
                            finalObservedDelta === existingResult.advertisedPoints && existingResult.advertisedPoints > 0
                                ? existingResult.advertisedPoints
                                : null

                        executionMap.set(key, {
                            ...existingResult,
                            status: 'verified-complete',
                            serverCompleted: true,
                            completionEvidence: evidence,
                            observedBalanceDelta: finalObservedDelta,
                            attributedPoints: attributed
                        })
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'DAILY-SET',
                            `[AUTO-RETRY] Berhasil memverifikasi "${existingResult.title}" pasca-retry! (evidence=${evidence})`,
                            'green'
                        )
                    }
                }
            }

            // 5. Buat summary dari hasil reconciliation
            const allResults = Array.from(executionMap.values())
            const summary: ActivityBatchSummary = {
                total: allResults.length,
                verifiedComplete: allResults.filter(r => r.status === 'verified-complete').length,
                processedUnverified: allResults.filter(r => r.status === 'processed-unverified').length,
                pending: allResults.filter(r => r.status === 'pending').length,
                skipped: allResults.filter(r => r.status === 'skipped').length,
                failed: allResults.filter(r => r.status === 'failed').length,
                observedAccountBalanceDelta: finalObservedDelta
            }

            this.bot.userData.currentPoints = Math.max(
                Number(this.bot.userData.currentPoints ?? 0),
                finalUpdatedBalance
            )

            const advertisedTotal = allResults.reduce((sum, r) => sum + r.advertisedPoints, 0)
            this.bot.logger.info(
                this.bot.isMobile,
                'DAILY-SET',
                `[DAILY-SET] Batch reconciliation | advertisedTotal=${advertisedTotal} observedAccountBalanceDelta=${finalObservedDelta} verified=${summary.verifiedComplete}/${summary.total}`
            )

            this.bot.logger.info(
                this.bot.isMobile,
                'DAILY-SET',
                `[DAILY-SET] Finished processing | total=${summary.total} verified=${summary.verifiedComplete} processedUnverified=${summary.processedUnverified} pending=${summary.pending} skipped=${summary.skipped} failed=${summary.failed} observedBalanceDelta=${summary.observedAccountBalanceDelta}`
            )

            if (summary.total > 0 && summary.verifiedComplete === summary.total) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'DAILY-SET',
                    `🎉 All Daily Set items completed! | verified=${summary.verifiedComplete}/${summary.total} | observedBalanceDelta=+${finalObservedDelta} | oldBalance=${startBalance} | newBalance=${finalUpdatedBalance}`,
                    'green'
                )
            }
        }
    }

    public extractAllPromotions(data: DashboardData): BasePromotion[] {
        const punchCards = data.punchCards ?? []
        const punchCardParentOfferIds = new Set(
            punchCards.map(pc => (pc.parentPromotion?.offerId || '').toLowerCase()).filter(Boolean)
        )
        const punchCardParentTitles = new Set(
            punchCards.map(pc => (pc.parentPromotion?.title || pc.name || '').toLowerCase().trim()).filter(Boolean)
        )

        // Hanya sertakan child item yang valid (TIDAK menyertakan parent punch card)
        const punchCardChildren = punchCards.flatMap(pc => pc.childPromotions ?? []) as unknown as BasePromotion[]

        const rawPromotions = [
            ...(data.morePromotions ?? []),
            ...(data.morePromotionsWithoutPromotionalItems ?? []),
            ...(data.promotionalItems ?? []),
            ...(data.promotionalItem ? [data.promotionalItem] : []),
            ...(data.componentImpressionPromotions ?? []),
            ...punchCardChildren,
            ...((data.welcomeTour as any)?.promotions ?? []),
            ...((data.userInterests as any)?.promotions ?? [])
        ] as unknown as BasePromotion[]

        const uniquePromos = [
            ...new Map(
                rawPromotions
                    .filter(p => Boolean(p && (p.offerId || p.title)))
                    .map(p => [p.offerId || p.title, p] as const)
            ).values()
        ]

        return uniquePromos.filter(x => {
            const offerIdLower = (x.offerId ?? '').toLowerCase()
            const titleLower = (x.title ?? '').toLowerCase().trim()
            const promoTypeLower = (x.promotionType ?? '').toLowerCase()
            const destUrlLower = (x.destinationUrl ?? '').toLowerCase()

            const isUncompleted = !x.complete || (x.pointProgressMax > 0 && (x.pointProgress ?? 0) < x.pointProgressMax)
            const hasPoints = (x.pointProgressMax ?? 0) > 0 && (x.pointProgressMax ?? 0) <= 1000
            const isImpression =
                offerIdLower.includes('impression') || offerIdLower.includes('refer_and_earn') || !titleLower

            // Filter out Punch Cards / Multi-day Parent Trackers dari More Promotions
            const isPunchCard =
                promoTypeLower === 'punchcard' ||
                offerIdLower.includes('punchcard') ||
                destUrlLower.includes('punchcard') ||
                punchCardParentOfferIds.has(offerIdLower) ||
                punchCardParentTitles.has(titleLower) ||
                Boolean(
                    (x.attributes as any)?.days || (x.attributes as any)?.daysearned || (x.attributes as any)?.totaldays
                )

            const isWelcomeTour =
                offerIdLower.includes('fre_offer') ||
                offerIdLower.includes('welcometour') ||
                titleLower.includes('take the tour')

            const isAppOnly =
                titleLower.includes('rewards app only') ||
                titleLower.includes('app only') ||
                titleLower.includes('sapphire') ||
                offerIdLower.includes('sapphire') ||
                offerIdLower.includes('rewardsapp') ||
                offerIdLower.includes('app_only') ||
                offerIdLower.includes('appoffer') ||
                (x as any).exclusiveLockedFeatureCategory === 'rewardsApp' ||
                (x as any).exclusiveLockedFeatureStatus === 'locked' ||
                (x.attributes as any)?.locked_category_criteria === 'rewardsApp' ||
                (x.attributes as any)?.is_unlocked === 'False'

            return isUncompleted && hasPoints && !isImpression && !isPunchCard && !isWelcomeTour && !isAppOnly
        })
    }

    public extractAppOnlyPromotions(data: DashboardData): BasePromotion[] {
        const rawPromos = [
            ...(data.morePromotions ?? []),
            ...(data.morePromotionsWithoutPromotionalItems ?? []),
            ...(data.promotionalItems ?? []),
            ...(data.promotionalItem ? [data.promotionalItem] : [])
        ] as unknown as BasePromotion[]

        const unique = [
            ...new Map(
                rawPromos.filter(p => Boolean(p && (p.offerId || p.title))).map(p => [p.offerId || p.title, p] as const)
            ).values()
        ]

        return unique.filter(x => {
            const titleLower = (x.title ?? '').toLowerCase().trim()
            const offerIdLower = (x.offerId ?? '').toLowerCase().trim()

            const isInternalInfo =
                offerIdLower.endsWith('_info') ||
                offerIdLower.includes('sapphire_appnewbonus_') ||
                offerIdLower.includes('addwidget') ||
                offerIdLower.includes('notification') ||
                titleLower.includes('add widget') ||
                titleLower.includes('enable notification')
            if (isInternalInfo) return false

            const isDesktopActivation =
                offerIdLower.includes('eligibility_edgebarchrome') ||
                offerIdLower.includes('activation_banner')

            const isAppOnly =
                isDesktopActivation ||
                titleLower.includes('rewards app only') ||
                titleLower.includes('app only') ||
                titleLower.includes('bing app') ||
                offerIdLower.includes('rewardsapp') ||
                offerIdLower.includes('app_only') ||
                offerIdLower.includes('appoffer') ||
                (x as any).exclusiveLockedFeatureCategory === 'rewardsApp' ||
                (x as any).exclusiveLockedFeatureStatus === 'locked' ||
                (x.attributes as any)?.locked_category_criteria === 'rewardsApp' ||
                (x.attributes as any)?.is_unlocked === 'False'

            const pointMax =
                (x.pointProgressMax ?? 0) ||
                parseInt(String((x.attributes as any)?.max || (x.attributes as any)?.points || '10'), 10) ||
                10
            if (!x.pointProgressMax || x.pointProgressMax <= 0) {
                x.pointProgressMax = pointMax
            }

            return isAppOnly && pointMax > 0
        })
    }

    public async doMorePromotions(data: DashboardData, page: Page) {
        this.hadBrowserActivitiesSincePass1 = true
        if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return
        await this.checkAccountSuspended(page)

        const appOnlyPromos = this.extractAppOnlyPromotions(data)
        const appOnlyTitles = new Set(appOnlyPromos.map(p => (p.title || '').toLowerCase().trim()).filter(Boolean))
        const appOnlyOfferIds = new Set(appOnlyPromos.map(p => (p.offerId || '').toLowerCase().trim()).filter(Boolean))

        let activitiesUncompleted = this.extractAllPromotions(data).filter(c => {
            const t = (c.title || '').toLowerCase().trim()
            const oid = (c.offerId || '').toLowerCase().trim()
            return !appOnlyTitles.has(t) && !appOnlyOfferIds.has(oid)
        })

        // Scrape kartu bonus langsung dari Live DOM Dashboard / Earn page (untuk menangkap kartu Keep earning visual +5/+15 Pts)
        try {
            const currentUrl = page.url().toLowerCase()
            if (!currentUrl.includes('rewards.bing.com')) {
                await page
                    .goto(this.bot.config.baseURL, { waitUntil: 'domcontentloaded', timeout: 15000 })
                    .catch(() => {})
                await this.bot.utils.wait(2000)
            }

            const { uncompletedCards, completedTitles } = await page
                .evaluate(() => {
                    const uncompletedCards: any[] = []
                    const completedTitles: string[] = []
                    const seenTitles = new Set<string>()

                    // Cari semua kartu di halaman di luar section Daily Set
                    const allElements = Array.from(
                        document.querySelectorAll(
                            'a, [role="button"], .c-card, .p-card, [class*="card"], [data-bi-id], [data-bi-area*="MorePromotions"], [data-bi-area*="Keep earning"]'
                        )
                    )

                    for (const rawEl of allElements) {
                        const el = rawEl as HTMLElement
                        const txt = (el.innerText || el.textContent || '').trim()
                        if (!txt) continue

                        // Abaikan jika berada di dalam container Daily Set
                        if (el.closest('#dailyset, [data-bi-area*="DailySet"], .daily-set, [id*="daily-set"]')) continue

                        const titleEl = el.querySelector(
                            'h3, h4, h5, .title, .c-heading, [class*="title"], [class*="heading"]'
                        )
                        const rawTitle = (titleEl?.textContent || el.getAttribute('aria-label') || '').trim()

                        const lines = txt
                            .split('\n')
                            .map(l => l.trim())
                            .filter(Boolean)
                        const title = rawTitle || (lines[0] && lines[0].length < 60 ? lines[0] : '')

                        if (!title || title.length > 70 || seenTitles.has(title.toLowerCase())) continue

                        // Abaikan navigasi header / footer / telemetry
                        const isSystemNav =
                            title.toLowerCase().includes('daily set') ||
                            title.toLowerCase().includes('rewards') ||
                            title.toLowerCase().includes('sign in') ||
                            title.toLowerCase().includes('level') ||
                            title.toLowerCase().includes('streak') ||
                            title.toLowerCase().includes('feedback') ||
                            title.toLowerCase().includes('terms')

                        if (isSystemNav) continue
                        seenTitles.add(title.toLowerCase())

                        const href = el.getAttribute('href') || el.querySelector('a')?.getAttribute('href') || ''
                        const hasCheckmark =
                            el.querySelector(
                                '.mee-icon-CheckMark, [data-icon-name="CheckMark"], .c-icon-check, .complete-check, svg[aria-label*="Complete"], [class*="check"]'
                            ) !== null ||
                            el.getAttribute('aria-checked') === 'true' ||
                            el.classList.contains('completed') ||
                            el.classList.contains('complete') ||
                            txt.toLowerCase().includes('completed') ||
                            txt.toLowerCase().includes('selesai')

                        const pointsMatch = txt.match(/\+(\d+)/)
                        const points = pointsMatch && pointsMatch[1] ? parseInt(pointsMatch[1], 10) : 0

                        // Abaikan Punch Card multi-day / kartu 50 poin bulanan dari scraper Keep Earning DOM
                        const isPunchCardTile =
                            points >= 50 ||
                            txt.toLowerCase().includes('punch card') ||
                            txt.toLowerCase().includes('highlight') ||
                            txt.toLowerCase().includes('tour') ||
                            txt.toLowerCase().includes('day ') ||
                            href.toLowerCase().includes('punchcard')

                        const containerSection = el.closest(
                            'section, [class*="section"], [class*="container"]'
                        ) as HTMLElement | null
                        const sectionText = (
                            containerSection?.innerText ||
                            containerSection?.textContent ||
                            ''
                        ).toLowerCase()
                        const isAppOnlySection =
                            sectionText.includes('rewards app only') ||
                            sectionText.includes('app only') ||
                            el.closest('[data-bi-area*="RewardsApp"], [id*="rewardsapp"]') !== null

                        const isAppOnly =
                            isAppOnlySection ||
                            txt.toLowerCase().includes('rewards app only') ||
                            txt.toLowerCase().includes('app only') ||
                            title.toLowerCase().includes('rewards app only') ||
                            title.toLowerCase().includes('app only') ||
                            href.toLowerCase().includes('rewardsapp')

                        const isMarketingPromo =
                            title.toLowerCase().includes('referral') ||
                            title.toLowerCase().includes('refer ') ||
                            title.toLowerCase().includes('search bar') ||
                            title.toLowerCase().includes('sweater weather') ||
                            title.toLowerCase().includes('wallpaper') ||
                            title.toLowerCase().includes('donate') ||
                            href.startsWith('microsoft-edge:') ||
                            href.includes('images/create')

                        const isQuizHeuristic =
                            title.toLowerCase().includes('?') ||
                            txt.toLowerCase().includes('quiz') ||
                            [15, 30, 40, 50].includes(points) ||
                            ['how many', 'which', 'what', 'who', 'where', 'when', 'why'].some(p =>
                                title.toLowerCase().trim().startsWith(p)
                            ) ||
                            (href &&
                                (href.toLowerCase().includes('filters=btepokey') ||
                                    href.toLowerCase().includes('rwds_quiz') ||
                                    href.toLowerCase().includes('openquiz')))

                        if (hasCheckmark) {
                            completedTitles.push(title.toLowerCase().trim())
                        } else if (points > 0 && !isPunchCardTile && !isAppOnly && !isMarketingPromo) {
                            let extractedOfferId =
                                el.getAttribute('data-offer-id') ||
                                el.getAttribute('data-bi-id') ||
                                el.querySelector('[data-offer-id]')?.getAttribute('data-offer-id') ||
                                el.querySelector('[data-bi-id]')?.getAttribute('data-bi-id') ||
                                ''

                            if (!extractedOfferId && href) {
                                try {
                                    const urlObj = new URL(href.startsWith('http') ? href : `https://rewards.bing.com${href}`)
                                    extractedOfferId =
                                        urlObj.searchParams.get('offerId') ||
                                        urlObj.searchParams.get('id') ||
                                        urlObj.searchParams.get('offerid') ||
                                        urlObj.searchParams.get('rwds_quiz') ||
                                        ''
                                } catch {}
                            }

                            const invalidOfferIds = new Set(['', 'root', 'main', 'app', 'content', 'header', 'footer', 'dailyset', 'daily-set', 'morepromotions', 'keep-earning'])
                            if (invalidOfferIds.has(extractedOfferId.toLowerCase().trim()) || extractedOfferId.trim().length < 3) {
                                extractedOfferId = ''
                            }

                            const finalOfferId = extractedOfferId ? extractedOfferId.trim() : `dom_bonus_${title.replace(/[^\w]/g, '_').toLowerCase()}`
                            const isPuzzle = title.toLowerCase().includes('puzzle') || txt.toLowerCase().includes('puzzle')

                            uncompletedCards.push({
                                title,
                                destinationUrl: href && href.startsWith('http') ? href : 'https://rewards.bing.com',
                                pointProgressMax: points,
                                pointProgress: 0,
                                complete: false,
                                offerId: finalOfferId,
                                promotionType: isQuizHeuristic ? 'quiz' : (isPuzzle ? 'puzzle' : 'urlreward'),
                                isQuiz: isQuizHeuristic,
                                isPuzzle: isPuzzle
                            } as any)
                        }
                    }
                    return { uncompletedCards, completedTitles }
                })
                .catch(() => ({ uncompletedCards: [], completedTitles: [] }))

            const completedSet = new Set(completedTitles.map(t => t.toLowerCase().trim()))

            // Filter out kartu yang sudah bercentang hijau di live DOM atau sudah tuntas di sesi
            activitiesUncompleted = activitiesUncompleted.filter(c => {
                const t = (c.title || '').toLowerCase().trim()
                const oid = (c.offerId || '').toLowerCase().trim()
                if (completedSet.has(t)) return false
                if (this.completedOffersInSession.has(t) || this.completedOffersInSession.has(oid)) return false
                return true
            })

            if (uncompletedCards && uncompletedCards.length > 0) {
                for (const card of uncompletedCards) {
                    if (this.isQuizPromotion(card)) {
                        card.promotionType = 'quiz'
                        ;(card as any).isQuiz = true
                    }
                }
                const filteredDom = uncompletedCards.filter(c => {
                    const t = (c.title || '').toLowerCase().trim()
                    const oid = (c.offerId || '').toLowerCase().trim()
                    return !appOnlyTitles.has(t) && !appOnlyOfferIds.has(oid)
                })
                const combined = [...activitiesUncompleted, ...filteredDom]
                activitiesUncompleted = [...new Map(combined.map(c => [c.title.toLowerCase().trim(), c])).values()]
            }

            activitiesUncompleted = activitiesUncompleted.filter(c => {
                const t = (c.title || '').toLowerCase().trim()
                const oid = (c.offerId || '').toLowerCase().trim()
                return !completedSet.has(t) && !appOnlyTitles.has(t) && !appOnlyOfferIds.has(oid)
            })
        } catch {}

        this.bot.logger.info(
            this.bot.isMobile,
            'TASK-DETECT',
            `[TASK-DETECT] "Keep earning" & More Promotions found: ${activitiesUncompleted.length} uncompleted bonus cards`
        )

        if (!activitiesUncompleted.length) {
            this.bot.logger.info(this.bot.isMobile, 'KEEP-EARNING', 'All "Keep earning" & bonus items completed!')
            return
        }

        for (const card of activitiesUncompleted) {
            this.bot.logger.info(
                this.bot.isMobile,
                'KEEP-EARNING',
                `[KEEP-EARNING] Found uncompleted bonus card: "${card.title}" (+${card.pointProgressMax} Pts)`,
                'green'
            )
        }

        const startBonusBalance = Number(this.bot.userData.currentPoints ?? 0)
        this.bot.logger.info(
            this.bot.isMobile,
            'KEEP-EARNING',
            `Started solving ${activitiesUncompleted.length} "Keep earning" bonus cards (including +15 Weekly Cards & Punchcards)... | currentPoints=${startBonusBalance}`
        )

        // 1. Simpan execution result sementara per offerId
        const executionMap = new Map<string, ActivityExecutionResult>()
        for (const act of activitiesUncompleted) {
            const key = act.offerId || act.title
            executionMap.set(key, {
                offerId: act.offerId,
                title: act.title,
                status: 'pending',
                advertisedPoints: Number(act.pointProgressMax ?? 10),
                observedBalanceDelta: 0,
                attributedPoints: null,
                serverCompleted: false,
                completionEvidence: 'none'
            })
        }

        // 2. Selesaikan batch seperti flow lama
        await this.solveActivities(activitiesUncompleted, page)

        // 3. Ambil SATU server snapshot setelah batch
        await this.bot.utils.wait(2000)
        const refreshedData: DashboardData | null = await this.bot.browser.func.getDashboardData().catch(() => null)
        const updatedBonusBalance =
            refreshedData?.userStatus?.availablePoints ??
            (await this.bot.browser.func.getCurrentPoints().catch(() => startBonusBalance))
        const bonusGained = Math.max(0, updatedBonusBalance - startBonusBalance)

        // 4. Reconcile seluruh result berdasarkan exact offerId
        const allFreshPromos = refreshedData ? this.extractAllPromotions(refreshedData) : []

        // Evaluasi status centang hijau langsung dari DOM dashboard jika API server belum merefleksikan
        let domCompletedSet = new Set<string>()
        if (page && !page.isClosed()) {
            try {
                const domStatus = await page.evaluate(() => {
                    const finished: string[] = []
                    const cards = Array.from(
                        document.querySelectorAll(
                            '.c-card, .p-card, a, [role="button"], [class*="card"], [class*="tile"], [data-bi-id]'
                        )
                    )
                    for (const c of cards) {
                        const hasCheck =
                            c.querySelector(
                                '.mee-icon-CheckMark, [data-icon-name="CheckMark"], .c-glyph.f-checkmark, .c-icon-check, .complete-check, svg[aria-label*="Complete"], [class*="check"]'
                            ) !== null ||
                            c.classList.contains('completed') ||
                            c.classList.contains('complete') ||
                            c.getAttribute('aria-checked') === 'true' ||
                            (c.textContent || '').toLowerCase().includes('completed') ||
                            (c.textContent || '').toLowerCase().includes('selesai')
                        if (hasCheck) {
                            const tEl = c.querySelector(
                                'h3, h4, h5, .title, .c-heading, [class*="title"], [class*="heading"]'
                            )
                            const rawT = (tEl?.textContent || c.getAttribute('aria-label') || '').trim().toLowerCase()
                            const lines = (c.textContent || '').split('\n').map(l => l.trim().toLowerCase()).filter(Boolean)
                            const t = rawT || lines[0] || ''
                            if (t) finished.push(t)
                        }
                    }
                    return finished
                }).catch(() => [])
                domCompletedSet = new Set(domStatus.map(s => s.toLowerCase().trim()))
            } catch {}
        }

        let remainingAttributedDelta = bonusGained

        for (const [key, result] of executionMap.entries()) {
            const freshMatch = allFreshPromos.find(
                f =>
                    f &&
                    (f.offerId === result.offerId ||
                        (f.title && f.title.toLowerCase().trim() === result.title.toLowerCase().trim()))
            )
            const isServerComplete = Boolean(
                freshMatch &&
                (freshMatch.complete === true ||
                    (freshMatch.pointProgressMax > 0 && (freshMatch.pointProgress ?? 0) >= freshMatch.pointProgressMax))
            )
            const hasDomCheck = domCompletedSet.has(result.title.toLowerCase().trim())
            const hasSessionComplete =
                this.completedOffersInSession.has(result.offerId) ||
                this.completedOffersInSession.has(result.title.toLowerCase().trim())

            if (isServerComplete || hasDomCheck) {
                const attributed =
                    bonusGained > 0 && result.advertisedPoints > 0
                        ? Math.min(result.advertisedPoints, remainingAttributedDelta)
                        : result.advertisedPoints
                if (remainingAttributedDelta > 0 && attributed) remainingAttributedDelta -= attributed
                executionMap.set(key, {
                    ...result,
                    status: 'verified-complete',
                    serverCompleted: true,
                    completionEvidence: isServerComplete ? 'server-dashboard-state' : 'dom-checkmark',
                    observedBalanceDelta: bonusGained,
                    attributedPoints: attributed
                })
            } else if (bonusGained > 0 && hasSessionComplete && remainingAttributedDelta > 0) {
                // Delayed Attribution Window: Saldo server terbukti bertambah selama batch, atribusikan ke kartu yang sukses diproses
                const attributed = Math.min(result.advertisedPoints, remainingAttributedDelta)
                remainingAttributedDelta -= attributed
                executionMap.set(key, {
                    ...result,
                    status: 'verified-complete',
                    serverCompleted: true,
                    completionEvidence: 'server-dashboard-state',
                    observedBalanceDelta: bonusGained,
                    attributedPoints: attributed
                })
            } else {
                executionMap.set(key, {
                    ...result,
                    status: 'processed-unverified',
                    serverCompleted: false,
                    completionEvidence: 'none',
                    observedBalanceDelta: bonusGained,
                    attributedPoints: null
                })
            }
        }

        // 5. Buat summary dari hasil reconciliation
        const allResults = Array.from(executionMap.values())
        const summary: ActivityBatchSummary = {
            total: allResults.length,
            verifiedComplete: allResults.filter(r => r.status === 'verified-complete').length,
            processedUnverified: allResults.filter(r => r.status === 'processed-unverified').length,
            pending: allResults.filter(r => r.status === 'pending').length,
            skipped: allResults.filter(r => r.status === 'skipped').length,
            failed: allResults.filter(r => r.status === 'failed').length,
            observedAccountBalanceDelta: bonusGained
        }

        this.bot.userData.currentPoints = updatedBonusBalance

        const advertisedTotal = allResults.reduce((sum, r) => sum + r.advertisedPoints, 0)
        this.bot.logger.info(
            this.bot.isMobile,
            'KEEP-EARNING',
            `[KEEP-EARNING] Batch reconciliation | advertisedTotal=${advertisedTotal} observedAccountBalanceDelta=${bonusGained} verified=${summary.verifiedComplete}/${summary.total}`
        )

        this.bot.logger.info(
            this.bot.isMobile,
            'KEEP-EARNING',
            `[KEEP-EARNING] Finished processing | total=${summary.total} verified=${summary.verifiedComplete} processedUnverified=${summary.processedUnverified} pending=${summary.pending} skipped=${summary.skipped} failed=${summary.failed} observedBalanceDelta=${summary.observedAccountBalanceDelta}`
        )

        if (summary.total > 0 && summary.verifiedComplete === summary.total) {
            this.bot.logger.info(
                this.bot.isMobile,
                'KEEP-EARNING',
                `🎉 All "Keep earning" bonus cards completed! | verified=${summary.verifiedComplete}/${summary.total} | observedBalanceDelta=+${bonusGained} | oldBalance=${startBonusBalance} | newBalance=${updatedBonusBalance}`,
                'green'
            )
        }
    }

    public async doAppPromotions(data: AppDashboardData) {
        const appRewards = data.response.promotions.filter(x => {
            if (x.attributes['complete']?.toLowerCase() !== 'false') return false
            if (!x.attributes['offerid']) return false
            if (!x.attributes['type'] || x.attributes['type'] !== 'sapphire') return false
            return true
        })

        if (appRewards.length) {
            for (const reward of appRewards) {
                await this.bot.activities.doAppReward(reward)
                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
            }
            this.bot.logger.info(this.bot.isMobile, 'APP-PROMOTIONS', 'All "App Promotions" items have been completed')
        }
    }

    public async doSpecialPromotions(data: DashboardData, page: Page) {
        this.hadBrowserActivitiesSincePass1 = true
        // Tangkap SEMUA item promosi khusus, global evergreen, & side quests valid (filter banner impression palsu)
        const allSpecials: BasePromotion[] = [
            ...(data.promotionalItems ?? []),
            ...(data.promotionalItem ? [data.promotionalItem] : [])
        ].filter(Boolean) as BasePromotion[]

        const uniqueSpecials = [...new Map(allSpecials.map(p => [p.offerId, p])).values()]

        const uncompleted = uniqueSpecials.filter(x => {
            const offerIdLower = (x.offerId ?? '').toLowerCase()
            const isDesktopActivation =
                offerIdLower.includes('eligibility_edgebarchrome') ||
                offerIdLower.includes('activation_banner')

            if (isDesktopActivation) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SPECIAL-ACTIVITY',
                    `[PROMO-FILTER] Menandai kartu "${x.title}" (${x.offerId}) sebagai kartu khusus aplikasi/desktop non-mobile.`
                )
                if (this.bot.isMobile) {
                    return false
                }
            }

            return (
                !x.complete &&
                x.pointProgressMax > 0 &&
                x.pointProgressMax <= 500 &&
                !offerIdLower.includes('locked') &&
                !offerIdLower.includes('impression') &&
                !offerIdLower.includes('refer_and_earn') &&
                (x.title ?? '').trim() !== ''
            )
        })

        if (uncompleted.length > 0) {
            this.bot.logger.info(
                this.bot.isMobile,
                'SPECIAL-ACTIVITY',
                `Found ${uncompleted.length} special/global promotion items (including Evergreen & Side Quests)! Solving now...`
            )

            for (const activity of uncompleted) {
                try {
                    await this.solveActivities([activity], page)
                } catch (error) {
                    this.bot.logger.error(this.bot.isMobile, 'SPECIAL-ACTIVITY', `Error solving "${activity.title}"`)
                }
            }
        }
    }

    // 💉 SUNTIKAN STAR BONUS 2100 YANG SEMPET ILANG
    public async doClaimBonusPoints(data: DashboardData) {
        const pointsActivity = data.pointClaimBannerPromotion
        if (!pointsActivity) return

        if (pointsActivity.complete) {
            this.bot.logger.info(this.bot.isMobile, 'CLAIM-BONUS-POINTS', `Bonus points have already been claimed`)
            return
        }

        await this.bot.activities.doClaimBonusPoints()
        this.bot.logger.info(this.bot.isMobile, 'CLAIM-BONUS-POINTS', `🎉 Star Bonus points claimed!`, 'green')
    }

    private punchCardStateReader?: PunchCardStateReader

    public setPunchCardStateReader(reader: PunchCardStateReader) {
        this.punchCardStateReader = reader
    }

    public getPunchCardStateReader(): PunchCardStateReader {
        if (!this.punchCardStateReader) {
            this.punchCardStateReader = new ProductionPunchCardStateReader(this.bot.browser?.func)
        }
        return this.punchCardStateReader
    }

    public async doPunchCards(data: DashboardData, page: Page, readerOverride?: PunchCardStateReader) {
        this.hadBrowserActivitiesSincePass1 = true
        if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return
        await this.checkAccountSuspended(page)

        const punchCards: PunchCard[] = [...(data.punchCards ?? [])]

        // Periksa juga apakah ada kartu di promotionalItems/morePromotions yang merupakan PunchCard
        const standaloneCards = [
            ...(data.promotionalItems ?? []),
            ...(data.morePromotions ?? []),
            ...(data.morePromotionsWithoutPromotionalItems ?? [])
        ].filter(
            x =>
                x &&
                ((x.promotionType ?? '').toLowerCase() === 'punchcard' ||
                    (x.offerId ?? '').toLowerCase().includes('punchcard') ||
                    (x.destinationUrl ?? '').toLowerCase().includes('punchcard')) &&
                (x.pointProgressMax ?? 0) > 0
        )

        for (const promo of standaloneCards) {
            if (!punchCards.some(pc => pc.parentPromotion?.offerId === promo.offerId)) {
                punchCards.push({
                    name: promo.name || promo.offerId,
                    parentPromotion: promo,
                    childPromotions: []
                } as any)
            }
        }

        if (punchCards.length === 0) {
            return
        }

        const stateReader = readerOverride || this.getPunchCardStateReader()

        this.bot.logger.info(
            this.bot.isMobile,
            'PUNCHCARD',
            `[TASK-DETECT] Found ${punchCards.length} Punch Card(s) in account status`
        )

        for (const card of punchCards) {
            const title = card.parentPromotion?.title || card.name || 'Punch Card'
            const offerId = card.parentPromotion?.offerId || card.name || ''

            const progress = this.getPunchCardProgressDetails(card)
            const beforeSnapshot = createPunchCardSnapshot(card)

            this.bot.logger.info(
                this.bot.isMobile,
                'PUNCHCARD',
                `[PUNCHCARD] Evaluated punchcard: "${title}" | Current Active: Step ${Math.min(progress.maxStep, progress.currentStep + 1)}/${progress.maxStep}`
            )

            if (beforeSnapshot.parentComplete || progress.isCompleted) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'PUNCHCARD',
                    `"${title}" | Progress: ${progress.progressStr} | Points: ${progress.pointsStr} | Status: Already Completed 🎉`,
                    'green'
                )
                try {
                    const identity = resolveAccountIdentity(
                        this.bot.activeAccount || { email: this.bot.userData.userName || 'unknown' }
                    )
                    const queue = (this.bot as any).manualQuestQueue as ManualQuestQueue | undefined
                    if (queue && offerId) {
                        await queue.updateState(identity.accountId, 'punch-card', offerId, 'verified-complete')
                    }
                } catch {}
                continue
            }

            // Sync already-complete child steps with manual quest queue
            try {
                const identity = resolveAccountIdentity(
                    this.bot.activeAccount || { email: this.bot.userData.userName || 'unknown' }
                )
                const queue = (this.bot as any).manualQuestQueue as ManualQuestQueue | undefined
                if (queue && Array.isArray(card.childPromotions)) {
                    for (const child of card.childPromotions) {
                        if (isChildComplete(child) && child.offerId) {
                            await queue.updateState(identity.accountId, 'punch-card', child.offerId, 'verified-complete')
                        }
                    }
                }
            } catch {}

            const counts = this.getPunchCardTaskCounts(card)

            this.bot.logger.info(
                this.bot.isMobile,
                'PUNCHCARD',
                `"${title}" | Progress: ${counts.completed}/${counts.total} Tasks | remaining=${counts.remaining} actionableNow=${counts.actionableNow} locked=${counts.locked}`,
                'cyan'
            )

            if (counts.actionableNow === 0) {
                if (counts.locked > 0 || counts.futureDated > 0) {
                    const lockedChild = (card.childPromotions ?? []).find(
                        c => isChildLocked(c) || isChildFutureDated(c) || isChildInCooldown(c)
                    )
                    const lockedChildAttr = (lockedChild?.attributes ?? {}) as Record<string, any>
                    const nextEligibleAt =
                        lockedChildAttr.nextEligibleAt ||
                        lockedChildAttr.startDate ||
                        lockedChildAttr.availableAt
                    if (nextEligibleAt) {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'PUNCHCARD',
                            `[PUNCHCARD] Next step is server-locked; eligible at ${nextEligibleAt}`,
                            'yellow'
                        )
                    } else {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'PUNCHCARD',
                            `[PUNCHCARD] Next step is server-locked; eligibility time unavailable`,
                            'yellow'
                        )
                    }
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD',
                        `[PUNCHCARD] Progress: ${counts.completed}/${counts.total} Tasks | remaining=${counts.remaining} actionableNow=0 locked=${counts.locked} status=waiting-cooldown executionCount=0`,
                        'cyan'
                    )
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD',
                        `[PUNCHCARD] Result | title="${title}" status=waiting-cooldown evidence=state-unchanged`,
                        'yellow'
                    )
                } else {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD',
                        `[PUNCHCARD] Result | title="${title}" status=no-actionable-child evidence=state-unchanged`,
                        'yellow'
                    )
                }
                continue
            }

            const children = card.childPromotions ?? []
            if (children.length > 0) {
                // Guardrail: Maksimal satu child per parent per run
                const activeChild = children.find(
                    c =>
                        !isChildComplete(c) &&
                        !isChildLocked(c) &&
                        !isChildDisabled(c) &&
                        !isChildFutureDated(c) &&
                        !isChildInCooldown(c)
                )

                if (activeChild) {
                    const targetChildOfferId = activeChild.offerId
                    const stepTitle = activeChild.title || activeChild.name || `Step ${counts.completed + 1}`
                    const stepNum = counts.completed + 1
                    const taskTag = `(${stepNum}/${counts.total} Tasks)`

                    const childKey = targetChildOfferId ? `${offerId}:${targetChildOfferId}` : `${offerId}:${stepTitle}`
                    if (
                        Workers.sessionUnverifiedPunchCardSteps.has(childKey) ||
                        Workers.sessionUnverifiedPunchCardSteps.has(`${offerId}:${stepTitle}`) ||
                        (targetChildOfferId && Workers.sessionUnverifiedPunchCardSteps.has(targetChildOfferId))
                    ) {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'PUNCHCARD',
                            `[PUNCHCARD-CACHE] Melewati langkah "${stepTitle}" (tercatat gagal verifikasi pada sesi ini)`
                        )
                        break
                    }

                    const childBeforeSnapshot = createPunchCardSnapshot(card, targetChildOfferId)

                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD',
                        `[PUNCHCARD] Active step detected: "${title}" -> "${stepTitle}" ${taskTag}`
                    )
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD',
                        `[PUNCHCARD] Before snapshot | parentOfferId=${offerId} childOfferId=${targetChildOfferId} completed=${childBeforeSnapshot.completedChildren}/${childBeforeSnapshot.totalChildren}`
                    )

                    const configuredMode =
                        (this.bot.config as any)?.punchCard?.mode ||
                        this.bot.config?.punchCardExecution?.mode

                    const executionMode: PunchCardExecutionMode =
                        (configuredMode as PunchCardExecutionMode) || 'manual-handoff'

                    const source = (this.bot.config as any)?.punchCard?.mode
                        ? 'config'
                        : this.bot.config?.punchCardExecution?.mode
                          ? 'config'
                          : 'global-default'

                    if (executionMode === 'manual-handoff') {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'PUNCHCARD-CONFIG',
                            `[PUNCHCARD-CONFIG] mode=manual-handoff source=${source}`
                        )
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'PUNCHCARD',
                            `[PUNCHCARD] Queued for manual handoff | offerId=${targetChildOfferId} title="${stepTitle}"`
                        )
                        try {
                            const identity = resolveAccountIdentity(
                                this.bot.activeAccount || { email: this.bot.userData.userName || 'unknown' }
                            )
                            const queue = (this.bot as any).manualQuestQueue as ManualQuestQueue | undefined
                            if (queue) {
                                await queue.enqueue({
                                    accountId: identity.accountId,
                                    displayAccount: identity.displayAccount,
                                    questKind: 'punch-card',
                                    offerId: targetChildOfferId,
                                    title: stepTitle,
                                    expectedPoints: activeChild.pointProgressMax ?? 10,
                                    complete: false,
                                    locked: false,
                                    lockReason: 'unknown',
                                    confidence: 'high',
                                    observedAt: new Date().toISOString(),
                                    state: 'manual-required',
                                    queuedAt: new Date().toISOString()
                                })
                            }
                        } catch {}

                        this.bot.logger.info(
                            this.bot.isMobile,
                            'PUNCHCARD',
                            `[PUNCHCARD] Step processed but completion remains unverified. ${taskTag}`,
                            'yellow'
                        )
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'PUNCHCARD',
                            `[PUNCHCARD] Result | title="${title}" status=processed-unverified evidence=state-unchanged`,
                            'yellow'
                        )
                        continue
                    }

                    if (executionMode === 'observer') {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'PUNCHCARD-CONFIG',
                            `[PUNCHCARD-CONFIG] mode=observer source=${source}`
                        )
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'PUNCHCARD',
                            `[PUNCHCARD] Result | title="${title}" status=processed-unverified evidence=state-unchanged`,
                            'yellow'
                        )
                        continue
                    }

                    // Mode is auto or browser-ui-experimental (auto-solve / explicit opt-in)
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD-CONFIG',
                        `[PUNCHCARD-CONFIG] mode=${executionMode} source=${source}`
                    )
                    // 1. Kill switch check
                    const killReason = await this.checkPunchCardKillSwitch(page)
                    if (killReason) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'PUNCHCARD-SAFETY',
                            `[PUNCHCARD-SAFETY] executionAborted=true reason=${killReason}`
                        )
                        this.bot.accountScope?.recordAttempt(offerId, targetChildOfferId, 'execution-unavailable')
                        continue
                    }

                    // 2. Run-scoped attempt guard
                    if (this.bot.accountScope?.hasAttempted(offerId, targetChildOfferId)) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'PUNCHCARD-SAFETY',
                            `[PUNCHCARD-SAFETY] attemptBlocked=true reason=already-attempted-in-run parentOfferId=${offerId} childOfferId=${targetChildOfferId}`
                        )
                        continue
                    }

                    // 3. Resolve action context
                    const currentScope = this.bot.accountScope
                    if (!currentScope || currentScope.isDisposed) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'PUNCHCARD-SAFETY',
                            `[PUNCHCARD-SAFETY] executionAborted=true reason=scope-unavailable`
                        )
                        continue
                    }

                    const resolvedAction = resolveUrlRewardAction({
                        parent: card,
                        child: activeChild,
                        dashboardData: data,
                        scopeId: currentScope.id,
                        requestToken: this.bot.requestToken
                    })

                    if (resolvedAction?.secret) {
                        if (resolvedAction.secret.accountScopeId !== currentScope.id) {
                            this.bot.logger.error(
                                this.bot.isMobile,
                                'PUNCHCARD-SAFETY',
                                `[PUNCHCARD-SAFETY] executionAborted=true reason=account-scope-mismatch`
                            )
                            currentScope.recordAttempt(offerId, targetChildOfferId, 'execution-unavailable')
                            continue
                        }
                        currentScope.storeSecret(resolvedAction.secret)
                    }

                    // 4. Single-transport execution: first-party dashboard click
                    const childUrlResolution = resolvePunchCardExecutionUrl(
                        activeChild.destinationUrl,
                        stepTitle,
                        targetChildOfferId
                    )
                    if (childUrlResolution.action === 'skip-app') {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'PUNCHCARD-GUARD',
                            `[PUNCHCARD-GUARD] Langkah "${stepTitle}" adalah quest eksklusif aplikasi Bing App. Dimasukkan ke Manual Quest Queue.`
                        )
                        try {
                            const identity = resolveAccountIdentity(
                                this.bot.activeAccount || { email: this.bot.userData.userName || 'unknown' }
                            )
                            const queue = (this.bot as any).manualQuestQueue as ManualQuestQueue | undefined
                            if (queue && targetChildOfferId) {
                                await queue.enqueue({
                                    accountId: identity.accountId,
                                    displayAccount: identity.displayAccount,
                                    questKind: 'punch-card',
                                    offerId: targetChildOfferId,
                                    title: `${title}: ${stepTitle}`,
                                    expectedPoints: activeChild.pointProgressMax ?? 10,
                                    complete: false,
                                    locked: false,
                                    lockReason: 'app-exclusive',
                                    confidence: 'high',
                                    observedAt: new Date().toISOString(),
                                    state: 'manual-required',
                                    queuedAt: new Date().toISOString()
                                })
                            }
                        } catch {}
                        currentScope.recordAttempt(offerId, targetChildOfferId, 'processed-unverified')
                        continue
                    }

                    const balanceBefore = Number(this.bot.userData.currentPoints ?? 0)
                    await this.clickExactChildFromDashboard(page, card, activeChild)

                    // Refresh exact parent/child server state with propagation delay
                    await this.bot.utils.wait(2000)
                    const afterSnapshot = await stateReader.fetchPunchCardSnapshot(offerId, targetChildOfferId)

                    const balanceAfter = Number(this.bot.userData.currentPoints ?? 0)
                    const observedBalanceDelta = Math.max(0, balanceAfter - balanceBefore)
                    const runResult = evaluatePunchCardRun(
                        childBeforeSnapshot,
                        afterSnapshot ?? undefined,
                        targetChildOfferId,
                        observedBalanceDelta
                    )

                    if (runResult.status === 'verified-complete-today') {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'PUNCHCARD-EXEC',
                            `[PUNCHCARD-EXEC] transport=first-party-dashboard-click outcome=confirmed-accepted`
                        )
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'PUNCHCARD',
                            `[PUNCHCARD] Step "${stepTitle}" completed successfully. ${taskTag}`,
                            'green'
                        )
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'PUNCHCARD',
                            `[PUNCHCARD] Result | title="${title}" status=verified-complete-today evidence=${runResult.evidence} nextAction=wait-for-server-unlock`,
                            'green'
                        )
                        currentScope.recordAttempt(offerId, targetChildOfferId, 'verified')
                        if (targetChildOfferId) this.completedOffersInSession.add(targetChildOfferId)
                        if (stepTitle) this.completedOffersInSession.add(stepTitle.toLowerCase().trim())
                        if (runResult.after?.parentComplete) {
                            if (offerId) this.completedOffersInSession.add(offerId)
                            this.completedOffersInSession.add(title.toLowerCase().trim())
                        }
                        try {
                            const identity = resolveAccountIdentity(
                                this.bot.activeAccount || { email: this.bot.userData.userName || 'unknown' }
                            )
                            const queue = (this.bot as any).manualQuestQueue as ManualQuestQueue | undefined
                            if (queue) {
                                if (targetChildOfferId) {
                                    await queue.updateState(identity.accountId, 'punch-card', targetChildOfferId, 'verified-complete', observedBalanceDelta)
                                }
                                if (runResult.after?.parentComplete && offerId) {
                                    await queue.updateState(identity.accountId, 'punch-card', offerId, 'verified-complete', observedBalanceDelta)
                                }
                            }
                        } catch {}
                    } else {
                        // Ambiguous / unchanged outcome -> ZERO second transport!
                        const childKey = targetChildOfferId ? `${offerId}:${targetChildOfferId}` : `${offerId}:${stepTitle}`
                        Workers.sessionUnverifiedPunchCardSteps.add(childKey)
                        Workers.sessionUnverifiedPunchCardSteps.add(`${offerId}:${stepTitle}`)
                        if (targetChildOfferId) {
                            Workers.sessionUnverifiedPunchCardSteps.add(targetChildOfferId)
                        }
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'PUNCHCARD-EXEC',
                            `[PUNCHCARD-EXEC] transport=first-party-dashboard-click outcome=ambiguous`
                        )
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'PUNCHCARD-SAFETY',
                            `[PUNCHCARD-SAFETY] secondTransportBlocked=true`
                        )
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'PUNCHCARD',
                            `[PUNCHCARD] Step processed but completion remains unverified. ${taskTag}`,
                            'yellow'
                        )
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'PUNCHCARD',
                            `[PUNCHCARD] Result | title="${title}" status=processed-unverified evidence=${runResult.evidence}`,
                            'yellow'
                        )
                        currentScope.recordAttempt(offerId, targetChildOfferId, 'processed-unverified')
                    }
                }
            } else if (card.parentPromotion?.destinationUrl) {
                const stepTitle = 'Daily Step'
                const taskTag = `(1/1 Tasks)`

                const parentKey = offerId || title
                if (
                    Workers.sessionUnverifiedPunchCardSteps.has(`${parentKey}:${stepTitle}`) ||
                    (offerId && Workers.sessionUnverifiedPunchCardSteps.has(offerId)) ||
                    Workers.sessionUnverifiedPunchCardSteps.has(title)
                ) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD',
                        `[PUNCHCARD-CACHE] Melewati langkah "${title}" (tercatat gagal verifikasi pada sesi ini)`
                    )
                    break
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'PUNCHCARD',
                    `[PUNCHCARD] Active step detected: "${title}" -> "${stepTitle}" ${taskTag}`
                )
                this.bot.logger.info(
                    this.bot.isMobile,
                    'PUNCHCARD',
                    `[PUNCHCARD] Before snapshot | parentOfferId=${offerId} completed=${beforeSnapshot.completedChildren}/${beforeSnapshot.totalChildren}`
                )

                const configuredMode =
                    (this.bot.config as any)?.punchCard?.mode ||
                    this.bot.config?.punchCardExecution?.mode

                const executionMode: PunchCardExecutionMode =
                    (configuredMode as PunchCardExecutionMode) || 'manual-handoff'

                const source = (this.bot.config as any)?.punchCard?.mode
                    ? 'config'
                    : this.bot.config?.punchCardExecution?.mode
                      ? 'config'
                      : 'global-default'

                if (executionMode === 'manual-handoff') {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD-CONFIG',
                        `[PUNCHCARD-CONFIG] mode=manual-handoff source=${source}`
                    )
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD',
                        `[PUNCHCARD] Queued for manual handoff | offerId=${offerId} title="${stepTitle}"`
                    )
                    try {
                        const identity = resolveAccountIdentity(
                            this.bot.activeAccount || { email: this.bot.userData.userName || 'unknown' }
                        )
                        const queue = (this.bot as any).manualQuestQueue as ManualQuestQueue | undefined
                        if (queue) {
                            await queue.enqueue({
                                accountId: identity.accountId,
                                displayAccount: identity.displayAccount,
                                questKind: 'punch-card',
                                offerId,
                                title: stepTitle,
                                expectedPoints: card.parentPromotion.pointProgressMax ?? 10,
                                complete: false,
                                locked: false,
                                lockReason: 'unknown',
                                confidence: 'high',
                                observedAt: new Date().toISOString(),
                                state: 'manual-required',
                                queuedAt: new Date().toISOString()
                            })
                        }
                    } catch {}

                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD',
                        `[PUNCHCARD] Step processed but completion remains unverified. ${taskTag}`,
                        'yellow'
                    )
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD',
                        `[PUNCHCARD] Result | title="${title}" status=processed-unverified evidence=state-unchanged`,
                        'yellow'
                    )
                    continue
                }

                if (executionMode === 'observer') {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD-CONFIG',
                        `[PUNCHCARD-CONFIG] mode=observer source=${source}`
                    )
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD',
                        `[PUNCHCARD] Result | title="${title}" status=processed-unverified evidence=state-unchanged`,
                        'yellow'
                    )
                    continue
                }

                // Mode is auto or browser-ui-experimental (auto-solve / explicit opt-in)
                this.bot.logger.info(
                    this.bot.isMobile,
                    'PUNCHCARD-CONFIG',
                    `[PUNCHCARD-CONFIG] mode=${executionMode} source=${source}`
                )
                const killReason = await this.checkPunchCardKillSwitch(page)
                if (killReason) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'PUNCHCARD-SAFETY',
                        `[PUNCHCARD-SAFETY] executionAborted=true reason=${killReason}`
                    )
                    this.bot.accountScope?.recordAttempt(offerId, offerId, 'execution-unavailable')
                    continue
                }

                if (this.bot.accountScope?.hasAttempted(offerId, offerId)) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'PUNCHCARD-SAFETY',
                        `[PUNCHCARD-SAFETY] attemptBlocked=true reason=already-attempted-in-run parentOfferId=${offerId} childOfferId=${offerId}`
                    )
                    continue
                }

                const currentScope = this.bot.accountScope
                const parentResolution = resolvePunchCardExecutionUrl(
                    card.parentPromotion.destinationUrl,
                    title,
                    offerId
                )
                if (parentResolution.action === 'skip-app') {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'PUNCHCARD-GUARD',
                        `[PUNCHCARD-GUARD] Langkah "${title}" adalah quest eksklusif aplikasi Bing App. Melewati navigasi browser.`
                    )
                    currentScope?.recordAttempt(offerId, offerId, 'processed-unverified')
                    continue
                }

                const balanceBefore = Number(this.bot.userData.currentPoints ?? 0)
                const claimActivity = card.parentPromotion as unknown as BasePromotion
                await this.bot.activities.doUrlReward(claimActivity, page, card)

                await this.bot.utils.wait(2000)
                const afterSnapshot = await stateReader.fetchPunchCardSnapshot(offerId)

                const balanceAfter = Number(this.bot.userData.currentPoints ?? 0)
                const observedBalanceDelta = Math.max(0, balanceAfter - balanceBefore)
                const runResult = evaluatePunchCardRun(
                    beforeSnapshot,
                    afterSnapshot ?? undefined,
                    undefined,
                    observedBalanceDelta
                )

                if (runResult.status === 'verified-complete-today') {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD-EXEC',
                        `[PUNCHCARD-EXEC] transport=existing-action-handler outcome=confirmed-accepted`
                    )
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD',
                        `[PUNCHCARD] Step "${stepTitle}" completed successfully. ${taskTag}`,
                        'green'
                    )
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD',
                        `[PUNCHCARD] Result | title="${title}" status=verified-complete-today evidence=${runResult.evidence}`,
                        'green'
                    )
                    currentScope?.recordAttempt(offerId, offerId, 'verified')
                    if (offerId) this.completedOffersInSession.add(offerId)
                    if (stepTitle) this.completedOffersInSession.add(stepTitle.toLowerCase().trim())
                } else {
                    const parentKey = offerId || title
                    Workers.sessionUnverifiedPunchCardSteps.add(`${parentKey}:${stepTitle}`)
                    if (offerId) {
                        Workers.sessionUnverifiedPunchCardSteps.add(offerId)
                    }
                    if (title) {
                        Workers.sessionUnverifiedPunchCardSteps.add(title)
                    }
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD-EXEC',
                        `[PUNCHCARD-EXEC] transport=existing-action-handler outcome=ambiguous`
                    )
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'PUNCHCARD-SAFETY',
                        `[PUNCHCARD-SAFETY] secondTransportBlocked=true`
                    )
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD',
                        `[PUNCHCARD] Step processed but completion remains unverified. ${taskTag}`,
                        'yellow'
                    )
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD',
                        `[PUNCHCARD] Result | title="${title}" status=processed-unverified evidence=${runResult.evidence}`,
                        'yellow'
                    )
                    currentScope?.recordAttempt(offerId, offerId, 'processed-unverified')
                }
            }
        }
    }

    public getPunchCardTaskCounts(card: PunchCard): PunchCardTaskCounts {
        const children = card.childPromotions ?? []
        const total = children.length
        if (total === 0) {
            const parent = card.parentPromotion
            const isComp = Boolean(
                parent?.complete === true ||
                String(parent?.complete).toLowerCase() === 'true' ||
                ((parent?.pointProgressMax ?? 0) > 0 && (parent?.pointProgress ?? 0) >= (parent?.pointProgressMax ?? 0))
            )
            return {
                total: 1,
                completed: isComp ? 1 : 0,
                remaining: isComp ? 0 : 1,
                actionableNow: isComp ? 0 : 1,
                locked: 0,
                futureDated: 0,
                disabled: 0
            }
        }

        let completed = 0
        let locked = 0
        let futureDated = 0
        let disabled = 0
        const eligibleChildren: BasePromotion[] = []

        const now = Date.now()

        for (const c of children) {
            if (!c) continue
            const isComp = isChildComplete(c)

            if (isComp) {
                completed++
                continue
            }

            const isDis = isChildDisabled(c)
            if (isDis) {
                disabled++
                continue
            }

            const isLock = isChildLocked(c)
            const isFut = isChildFutureDated(c, now) || isChildInCooldown(c)

            if (isLock) {
                locked++
            } else if (isFut) {
                futureDated++
            } else {
                eligibleChildren.push(c)
            }
        }

        const remaining = total - completed
        const actionableNow = eligibleChildren.length > 0 ? 1 : 0

        if (eligibleChildren.length > 1) {
            locked += eligibleChildren.length - 1
        }

        return {
            total,
            completed,
            remaining,
            actionableNow,
            locked,
            futureDated,
            disabled
        }
    }

    public getPunchCardProgressDetails(card: PunchCard): {
        isCompleted: boolean
        isCompletedToday: boolean
        progressStr: string
        currentStep: number
        maxStep: number
        pointsStr: string
        percent: number
    } {
        const parent = card.parentPromotion
        const children = card.childPromotions ?? []
        const attr = (parent?.attributes ?? {}) as Record<string, any>

        // 1. Hitung total task sebenarnya dari children jika ada!
        const totalChildrenCount = children.length
        const completedChildrenCount = children.filter(
            c => c.complete || (c.pointProgressMax > 0 && c.pointProgress >= c.pointProgressMax)
        ).length

        let maxStep = 0
        let currentStep = 0

        // Prioritas UTAMA: Jika card memiliki children, maxStep adalah JUMLAH CHILDREN (contoh: 4 tasks), BUKAN total poin kartu!
        if (totalChildrenCount > 0) {
            maxStep = totalChildrenCount
            currentStep = completedChildrenCount
        } else {
            const actProg = Number(parent?.activityProgress ?? 0)
            const actProgMax = Number(parent?.activityProgressMax ?? 0)

            const rawDays = attr['days'] || attr['totaldays'] || ''
            const rawDaysEarned = attr['daysearned'] || attr['progress'] || attr['completeddays'] || ''

            const daysMax = rawDays ? parseInt(String(rawDays), 10) : 0
            const daysEarned = rawDaysEarned ? parseInt(String(rawDaysEarned), 10) : 0

            if (daysMax > 0 && daysMax <= 10) {
                maxStep = daysMax
                currentStep = daysEarned
            } else if (actProgMax > 0 && actProgMax <= 10) {
                maxStep = actProgMax
                currentStep = actProg
            } else {
                maxStep = 1
                currentStep = parent?.complete ? 1 : 0
            }
        }

        // 2. Hitung poin
        const ptProg = Number(parent?.pointProgress ?? 0)
        const ptProgMax = Number(parent?.pointProgressMax ?? 0)
        const pointsStr = `${ptProg}/${ptProgMax} Pts`

        // 3. Status ketuntasan
        const isParentComplete = Boolean(parent?.complete)
        const isAllChildrenComplete = totalChildrenCount > 0 && completedChildrenCount >= totalChildrenCount
        const isMaxStepReached = maxStep > 0 && currentStep >= maxStep
        const isPointsMaxReached = ptProgMax > 0 && ptProg >= ptProgMax

        const isCompleted = isParentComplete || isMaxStepReached || (isPointsMaxReached && isAllChildrenComplete)

        // Periksa apakah hari ini sudah dikerjakan
        const uncompletedChildren = children.filter(
            c => !c.complete && (!c.pointProgressMax || c.pointProgress < c.pointProgressMax)
        )
        const isCompletedToday = isCompleted || (totalChildrenCount > 0 && uncompletedChildren.length === 0)

        const percent = maxStep > 0 ? Math.min(100, Math.round((currentStep / maxStep) * 100)) : isCompleted ? 100 : 0
        const progressStr = `${currentStep}/${maxStep} Tasks [${percent}%]`

        return {
            isCompleted,
            isCompletedToday,
            progressStr,
            currentStep,
            maxStep,
            pointsStr,
            percent
        }
    }

    private async solveActivities(activities: BasePromotion[], page: Page, punchCard?: PunchCard) {
        for (const activity of activities) {
            try {
                const type = (activity.promotionType ?? '').toLowerCase()
                const name = (activity.name ?? '').toLowerCase()
                const offerId = (activity.offerId ?? '').toLowerCase()
                const isQuiz = this.isQuizPromotion(activity)
                ;(activity as any).isQuiz = isQuiz

                const isTokenMissing = !this.bot.requestToken || this.bot.rewardsVersion === 'modern'

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'ACTIVITY',
                    `Processing | title="${activity.title}" | type=${type} | isQuiz=${isQuiz} | tokenMissing=${isTokenMissing}`
                )

                // Jangan lempar offerId sintetis (dom_...) ke loop API ReportActivity di Quiz.ts
                const isSyntheticDom = offerId.startsWith('dom_')

                if (
                    !isTokenMissing &&
                    !isSyntheticDom &&
                    (type === 'quiz' || type.includes('trivia') || type.includes('poll') || type.includes('survey')) &&
                    !offerId.includes('dailyset')
                ) {
                    await this.bot.activities.doQuiz(activity)
                } else if (type === 'findclippy') {
                    await this.bot.activities.doFindClippy(activity as unknown as FindClippyPromotion)
                } else if (name.includes('exploreonbing')) {
                    await this.bot.activities.doSearchOnBing(activity, page)
                } else {
                    // Default fallback: Selesaikan via Hybrid UrlReward solver (mencakup Daily Set URL, side quests 15 poin, explore cards, promo links, punchcard items, serta web quiz & puzzle DOM)
                    if (isQuiz) {
                        ;(activity as any).isQuiz = true
                    }
                    if (type === 'puzzle' || (activity.title || '').toLowerCase().includes('puzzle')) {
                        ;(activity as any).isPuzzle = true
                    }
                    await this.bot.activities.doUrlReward(activity, page, punchCard)
                }

                if (activity.offerId) this.completedOffersInSession.add(activity.offerId)
                if (activity.title) this.completedOffersInSession.add(activity.title.toLowerCase().trim())

                await this.bot.utils.wait(this.bot.utils.randomDelay(4000, 8000))
            } catch (error) {
                this.bot.logger.error(this.bot.isMobile, 'ACTIVITY', `Error solving "${activity.title}"`)
            }
        }
    }

    public async checkPunchCardKillSwitch(page: Page): Promise<string | null> {
        if (!page || page.isClosed()) return 'page-closed'
        if (!this.bot.accountScope || this.bot.accountScope.isDisposed) return 'scope-unavailable'
        if (!this.bot.userData.userName) return 'auth-mismatch'

        const pageUrl = (page.url() || '').toLowerCase()
        if (pageUrl.includes('/login') || pageUrl.includes('/error') || pageUrl.includes('/challenge')) {
            return 'dashboard-unavailable'
        }

        const captchaCount = await page
            .locator(
                '.g-recaptcha, #challenge-stage, #cf-please-wait, iframe[src*="captcha"], iframe[src*="challenge"], #recaptcha'
            )
            .count()
            .catch(() => 0)
        if (captchaCount > 0) return 'captcha-detected'

        const bodyText = await page
            .evaluate(() => (document.body ? document.body.innerText.toLowerCase() : ''))
            .catch(() => '')
        if (
            bodyText.includes('suspicious activity') ||
            bodyText.includes('unusual activity') ||
            bodyText.includes('account restricted') ||
            bodyText.includes('bot detected') ||
            bodyText.includes('bot warning')
        ) {
            return 'bot-warning-detected'
        }

        return null
    }

    public async clickExactChildFromDashboard(
        page: Page,
        card: PunchCard,
        child: BasePromotion
    ): Promise<boolean> {
        if (!page || page.isClosed()) return false

        let targetDashboard = (card.parentPromotion?.destinationUrl || 'https://rewards.bing.com').trim()
        if (
            targetDashboard.toLowerCase().includes('/dashboard/envelope') ||
            isLocalSystemProtocol(targetDashboard)
        ) {
            targetDashboard = 'https://rewards.bing.com'
        }
        const currentUrl = page.url().toLowerCase()
        if (!currentUrl.includes('rewards.bing.com')) {
            await page
                .goto(targetDashboard, { waitUntil: 'domcontentloaded', timeout: 15000 })
                .catch(() => {})
            await this.bot.utils.wait(1500)
        }

        const childTitle = child.title || child.name || 'Punch Card Step'
        const childDest = (child.destinationUrl || '').trim()
        const resolved = resolvePunchCardExecutionUrl(childDest, childTitle, child.offerId)

        if (resolved.action === 'skip-app') {
            this.bot.logger.warn(
                this.bot.isMobile,
                'PUNCHCARD-GUARD',
                `[PUNCHCARD-GUARD] Langkah "${childTitle}" adalah quest eksklusif aplikasi Bing App. Melewati navigasi browser.`
            )
            return false
        }

        const safeOfferId = (child.offerId || '').replace(/["\\]/g, '\\$&')
        const selectors: string[] = []
        if (safeOfferId) {
            selectors.push(`[data-offer-id="${safeOfferId}"]`)
            selectors.push(`[data-bi-id*="${safeOfferId}"]`)
            selectors.push(`[id*="${safeOfferId}"]`)
            selectors.push(`a[href*="${safeOfferId}"]`)
        }
        if (
            child.destinationUrl &&
            !child.destinationUrl.toLowerCase().includes('/dashboard/envelope') &&
            !isLocalSystemProtocol(child.destinationUrl)
        ) {
            try {
                const parsed = new URL(child.destinationUrl)
                const safePath = parsed.pathname.replace(/["\\]/g, '\\$&')
                if (safePath && safePath !== '/') {
                    selectors.push(`a[href*="${safePath}"]`)
                }
            } catch {}
        }
        if (child.title) {
            const cleanTitle = child.title.replace(/[^\w\s]/gi, ' ').trim()
            selectors.push(`a:has-text("${cleanTitle}")`)
            selectors.push(`button:has-text("${cleanTitle}")`)
            selectors.push(`div[role="button"]:has-text("${cleanTitle}")`)
        }

        for (const sel of selectors) {
            const el = page.locator(sel).first()
            if (await el.isVisible().catch(() => false)) {
                const popupPromise = page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null)
                await el.click({ timeout: 5000 }).catch(async () => {
                    await el.evaluate((node: HTMLElement) => node.click()).catch(() => {})
                })
                const popup = await popupPromise
                if (popup) {
                    this.bot.accountScope?.trackPage(popup)
                    await this.bot.utils.wait(3000)
                    await popup.close().catch(() => {})
                    this.bot.accountScope?.untrackPage(popup)
                } else {
                    await this.bot.utils.wait(2000)
                }
                return true
            }
        }

        // Jika selector elemen tidak ditemukan di halaman dashboard, langsung eksekusi navigasi ke resolved URL
        if (resolved.url) {
            try {
                const logLabel = resolved.action === 'search' ? '[PUNCHCARD-SEARCH]' : '[PUNCHCARD-AUTO]'
                this.bot.logger.info(
                    this.bot.isMobile,
                    'PUNCHCARD',
                    `${logLabel} Navigasi langsung ke langkah aktif (${resolved.action}): ${resolved.url}`
                )
                const newPage = await page.context().newPage()
                this.bot.accountScope?.trackPage(newPage)
                await newPage.goto(resolved.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
                await this.bot.utils.wait(3000)
                await newPage.close().catch(() => {})
                this.bot.accountScope?.untrackPage(newPage)
                return true
            } catch (err) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'PUNCHCARD',
                    `[PUNCHCARD-AUTO] Direct step navigation failed: ${err}`
                )
            }
        }
        return false
    }

    /**
     * Buka Flyout Drawer "Daily Set Streak" di dashboard rewards.bing.com/earn
     */
    public async openDailySetStreakFlyout(page: Page): Promise<boolean> {
        if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return false

        try {
            // 1. Cek apakah drawer sudah terbuka
            const isAlreadyOpen = await page
                .evaluate(() => {
                    const containers = Array.from(
                        document.querySelectorAll(
                            '[role="dialog"], aside, [class*="flyout"], [class*="drawer"], [class*="panel"], [class*="ms-Panel"], [class*="ms-Layer"], [class*="modal"]'
                        )
                    )
                    for (const c of containers) {
                        const text = (c.textContent || '').toLowerCase()
                        if (
                            text.includes('daily set streak') ||
                            text.includes('complete all 3') ||
                            text.includes('complete all')
                        ) {
                            const rect = c.getBoundingClientRect()
                            if (rect.width > 50 && rect.height > 50) return true
                        }
                    }
                    return false
                })
                .catch(() => false)

            if (isAlreadyOpen) return true

            // 2. Klik kartu "Daily Set Streak" menggunakan DOM traversal presisi (menghindari matching root container)
            const clicked = await page
                .evaluate(() => {
                    const all = Array.from(
                        document.querySelectorAll(
                            'h1, h2, h3, h4, h5, p, span, div, a, button, [role="button"]'
                        )
                    )
                    for (const el of all) {
                        if (el.children.length > 2) continue
                        const txt = (el.textContent || '').trim()
                        if (
                            txt === 'Daily Set Streak' ||
                            (/^Daily Set Streak/i.test(txt) && txt.length < 35) ||
                            (/^Activity:\s*\d+\/\d+/i.test(txt) && txt.length < 25)
                        ) {
                            const clickable = (el.closest(
                                'button, a, [role="button"], [class*="card"], [class*="tile"], [class*="item"]'
                            ) || el) as HTMLElement
                            clickable.scrollIntoView({ block: 'center', behavior: 'instant' })
                            clickable.focus()
                            clickable.click()
                            clickable.dispatchEvent(
                                new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
                            )
                            return true
                        }
                    }
                    return false
                })
                .catch(() => false)

            // Playwright locator fallback jika DOM traversal tidak menemukan
            if (!clicked) {
                const streakCard = page
                    .locator('button, a, [role="button"], [class*="card"], [class*="tile"]')
                    .filter({ hasText: /^Daily Set Streak/i })
                    .first()
                if (await streakCard.isVisible().catch(() => false)) {
                    await streakCard.click().catch(() => {})
                }
            }

            await this.bot.utils.wait(2000)

            // 3. Verifikasi apakah drawer sekarang terbuka
            const isOpenNow = await page
                .evaluate(() => {
                    const containers = Array.from(
                        document.querySelectorAll(
                            '[role="dialog"], aside, [class*="flyout"], [class*="drawer"], [class*="panel"], [class*="ms-Panel"], [class*="ms-Layer"], [class*="modal"]'
                        )
                    )
                    for (const c of containers) {
                        const text = (c.textContent || '').toLowerCase()
                        if (
                            text.includes('daily set streak') ||
                            text.includes('complete all 3') ||
                            text.includes('complete all')
                        ) {
                            const rect = c.getBoundingClientRect()
                            if (rect.width > 50 && rect.height > 50) return true
                        }
                    }
                    const closeBtn = document.querySelector(
                        'button[aria-label*="Close" i], button[title*="Close" i], [aria-label*="close" i], .ms-Dialog-button--close'
                    )
                    if (closeBtn) {
                        const parent = closeBtn.closest('div, aside, section')
                        if (parent && parent !== document.body) {
                            const pt = (parent.textContent || '').toLowerCase()
                            if (pt.includes('daily set') || pt.includes('streak') || pt.includes('complete all')) return true
                        }
                    }
                    return false
                })
                .catch(() => false)

            return isOpenNow
        } catch {
            return false
        }
    }

    /**
     * Selesaikan kartu Daily Set langsung via Modern Flyout Drawer (rewards.bing.com/earn)
     */
    public async solveModernDailySetFlyout(
        page: Page,
        activities: BasePromotion[],
        executionMap: Map<string, ActivityExecutionResult>
    ): Promise<boolean> {
        if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return false

        try {
            await ensureOnRewardsDashboard(page)
            await this.bot.utils.wait(1500)

            this.bot.logger.info(
                this.bot.isMobile,
                'DAILY-SET',
                'Membuka Flyout Drawer "Daily Set Streak" langsung dari dashboard...',
                'cyan'
            )

            const isDrawerOpen = await this.openDailySetStreakFlyout(page)

            // Cek jika kartu aktivitas sudah langsung terlihat di halaman (bisa berupa layout statis / responsive)
            const hasVisibleCards = await page
                .evaluate((titles: string[]) => {
                    for (const t of titles) {
                        if (!t) continue
                        const all = Array.from(document.querySelectorAll('*'))
                        for (const el of all) {
                            if (el.children.length > 2) continue
                            if ((el.textContent || '').toLowerCase().includes(t.toLowerCase())) {
                                const rect = el.getBoundingClientRect()
                                if (rect.width > 0 && rect.height > 0) return true
                            }
                        }
                    }
                    return false
                }, activities.map(a => a.title).filter(Boolean))
                .catch(() => false)

            if (!isDrawerOpen && !hasVisibleCards) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'DAILY-SET',
                    'Flyout Drawer tidak terdeteksi di dashboard. Melanjutkan ke runner aktivitas standar.'
                )
                return false
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'DAILY-SET',
                '🎯 Flyout Drawer "Daily Set Streak" aktif! Memproses kartu aktivitas...',
                'green'
            )

            // Eksekusi tiap kartu di dalam drawer
            for (const activity of activities) {
                const key = activity.offerId || activity.title
                if (executionMap.get(key)?.status === 'verified-complete') continue

                // 1. Evaluasi status kartu sebelum diklik
                const cardCheck = await page
                    .evaluate((targetTitle: string) => {
                        const cleanTarget = targetTitle.toLowerCase().replace(/[^\w\s]/g, ' ').trim()
                        const targetWords = cleanTarget.split(/\s+/).filter(w => w.length > 2)
                        const all = Array.from(
                            document.querySelectorAll('h1, h2, h3, h4, h5, p, span, div, a, button, [role="button"]')
                        )

                        let foundEl: HTMLElement | null = null
                        for (const el of all) {
                            if (el.children.length > 2) continue
                            const txt = (el.textContent || '').toLowerCase().replace(/[^\w\s]/g, ' ').trim()
                            if (txt.includes(cleanTarget) || (targetWords.length > 0 && targetWords.every(w => txt.includes(w)))) {
                                foundEl = el as HTMLElement
                                break
                            }
                        }
                        if (!foundEl && targetWords.length > 0) {
                            const firstTwo = targetWords.slice(0, 2).join(' ')
                            for (const el of all) {
                                if (el.children.length > 2) continue
                                if ((el.textContent || '').toLowerCase().includes(firstTwo)) {
                                    foundEl = el as HTMLElement
                                    break
                                }
                            }
                        }

                        if (!foundEl) return { found: false, isComplete: false, points: 10 }

                        const card = (foundEl.closest(
                            'button, a, [role="button"], [class*="card"], [class*="tile"], [class*="item"], div'
                        ) || foundEl) as HTMLElement
                        const txt = (card.innerText || card.textContent || '').toLowerCase()
                        const hasCheck =
                            card.querySelector(
                                '.mee-icon-CheckMark, [data-icon-name="CheckMark"], svg[aria-label*="Complete"], [class*="check"]'
                            ) !== null ||
                            card.classList.contains('completed') ||
                            card.classList.contains('complete') ||
                            card.getAttribute('aria-checked') === 'true'
                        const ptMatch = txt.match(/\+(\d+)/)
                        const points = ptMatch && ptMatch[1] ? parseInt(ptMatch[1], 10) : 10
                        const isComplete = hasCheck || (!ptMatch && (txt.includes('complete') || txt.includes('selesai')))

                        return { found: true, isComplete, points }
                    }, activity.title)
                    .catch(() => ({ found: false, isComplete: false, points: 10 }))

                if (cardCheck.isComplete) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'DAILY-SET',
                        `Kartu "${activity.title}" sudah tercentang selesai di Flyout Drawer.`,
                        'green'
                    )
                    executionMap.set(key, {
                        offerId: activity.offerId,
                        title: activity.title,
                        status: 'verified-complete',
                        advertisedPoints: cardCheck.points,
                        observedBalanceDelta: cardCheck.points,
                        attributedPoints: cardCheck.points,
                        serverCompleted: true,
                        completionEvidence: 'dom-checkmark'
                    })
                    continue
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'DAILY-SET',
                    `[FLYOUT-EXEC] Mengklik "${activity.title}" (+${cardCheck.points} pts) langsung dari Flyout Drawer...`
                )

                const balanceBefore = Number(this.bot.userData.currentPoints ?? 0)
                const popupPromise = page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null)

                // 2. Klik kartu di DOM
                const clickSuccess = await page
                    .evaluate((targetTitle: string) => {
                        const cleanTarget = targetTitle.toLowerCase().replace(/[^\w\s]/g, ' ').trim()
                        const targetWords = cleanTarget.split(/\s+/).filter(w => w.length > 2)
                        const all = Array.from(
                            document.querySelectorAll('h1, h2, h3, h4, h5, p, span, div, a, button, [role="button"]')
                        )

                        let foundEl: HTMLElement | null = null
                        for (const el of all) {
                            if (el.children.length > 2) continue
                            const txt = (el.textContent || '').toLowerCase().replace(/[^\w\s]/g, ' ').trim()
                            if (txt.includes(cleanTarget) || (targetWords.length > 0 && targetWords.every(w => txt.includes(w)))) {
                                foundEl = el as HTMLElement
                                break
                            }
                        }
                        if (!foundEl && targetWords.length > 0) {
                            const firstTwo = targetWords.slice(0, 2).join(' ')
                            for (const el of all) {
                                if (el.children.length > 2) continue
                                if ((el.textContent || '').toLowerCase().includes(firstTwo)) {
                                    foundEl = el as HTMLElement
                                    break
                                }
                            }
                        }
                        if (!foundEl) return false

                        const card = (foundEl.closest(
                            'button, a, [role="button"], [class*="card"], [class*="tile"], [class*="item"], div'
                        ) || foundEl) as HTMLElement
                        const actionBtn = (card.querySelector(
                            'button, a, [role="button"], [class*="button"], [class*="action"], svg'
                        ) || card) as HTMLElement
                        actionBtn.scrollIntoView({ block: 'center', behavior: 'instant' })
                        actionBtn.focus()
                        actionBtn.click()
                        actionBtn.dispatchEvent(
                            new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
                        )
                        return true
                    }, activity.title)
                    .catch(() => false)

                // Playwright locator fallback jika DOM traversal tidak menemukan
                if (!clickSuccess) {
                    const cleanTitle = (activity.title || '').replace(/[^\w\s]/g, ' ').trim()
                    const firstWord = cleanTitle.split(/\s+/)[0] || ''
                    const cardEl = page
                        .locator('[role="dialog"], aside, [class*="flyout"], [class*="drawer"], [class*="panel"], body')
                        .locator('button, a, [role="button"], [class*="card"]')
                        .filter({ hasText: firstWord })
                        .first()
                    if (await cardEl.isVisible().catch(() => false)) {
                        await cardEl.click().catch(() => {})
                    }
                }

                const popup = await popupPromise

                if (popup) {
                    this.bot.accountScope?.trackPage(popup)
                    try {
                        await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
                        await this.bot.utils.wait(2000)

                        const isQuiz = Boolean((activity as any).isQuiz || this.isQuizPromotion(activity))
                        const isPuzzle = Boolean(
                            (activity as any).isPuzzle ||
                            (activity.title || '').toLowerCase().includes('puzzle')
                        )

                        if (isQuiz) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'DAILY-SET',
                                `[FLYOUT-QUIZ] Menjalankan solver kuis interaktif untuk "${activity.title}"...`
                            )
                            await this.solveInteractiveQuizOnTab(popup)
                        } else if (isPuzzle) {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'DAILY-SET',
                                `[FLYOUT-PUZZLE] Menjalankan simulasi puzzle untuk "${activity.title}"...`
                            )
                            await this.solvePuzzleOnTab(popup)
                        } else {
                            this.bot.logger.info(
                                this.bot.isMobile,
                                'DAILY-SET',
                                `[FLYOUT-VISIT] Menjalankan simulasi aman & dwell time untuk "${activity.title}"...`
                            )
                            await performBoundedSafeScroll(popup, {
                                maxDurationMs: 2500,
                                maxSteps: 3,
                                stepDelayMs: 600,
                                logger: this.bot.logger,
                                isMobile: this.bot.isMobile
                            }).catch(() => {})
                            await this.bot.utils.wait(this.bot.utils.randomDelay(3000, 4500))
                        }
                    } finally {
                        await popup.close().catch(() => {})
                        this.bot.accountScope?.untrackPage(popup)
                    }
                } else {
                    // Cek jika halaman utama berpindah URL
                    const curUrl = page.url().toLowerCase()
                    if (!curUrl.includes('rewards.bing.com/earn') && !curUrl.includes('rewards.bing.com/dashboard')) {
                        const isQuiz = Boolean((activity as any).isQuiz || this.isQuizPromotion(activity))
                        if (isQuiz) {
                            await this.solveInteractiveQuizOnTab(page)
                        } else {
                            await performBoundedSafeScroll(page, {
                                maxDurationMs: 2500,
                                maxSteps: 3,
                                stepDelayMs: 600,
                                logger: this.bot.logger,
                                isMobile: this.bot.isMobile
                            }).catch(() => {})
                            await this.bot.utils.wait(2500)
                        }
                        await ensureOnRewardsDashboard(page)
                        await this.bot.utils.wait(1500)
                        // Buka kembali flyout drawer jika tertutup setelah navigasi ulang
                        await this.openDailySetStreakFlyout(page).catch(() => false)
                    } else {
                        await this.bot.utils.wait(2500)
                    }
                }

                // 3. Verifikasi centang selesai pasca-eksekusi
                await this.bot.utils.wait(2000)
                const isNowDone = await page
                    .evaluate((targetTitle: string) => {
                        const cleanTarget = targetTitle.toLowerCase().replace(/[^\w\s]/g, ' ').trim()
                        const targetWords = cleanTarget.split(/\s+/).filter(w => w.length > 2)
                        const all = Array.from(
                            document.querySelectorAll('h1, h2, h3, h4, h5, p, span, div, a, button, [role="button"]')
                        )

                        let foundEl: HTMLElement | null = null
                        for (const el of all) {
                            if (el.children.length > 2) continue
                            const txt = (el.textContent || '').toLowerCase().replace(/[^\w\s]/g, ' ').trim()
                            if (txt.includes(cleanTarget) || (targetWords.length > 0 && targetWords.every(w => txt.includes(w)))) {
                                foundEl = el as HTMLElement
                                break
                            }
                        }
                        if (!foundEl && targetWords.length > 0) {
                            const firstTwo = targetWords.slice(0, 2).join(' ')
                            for (const el of all) {
                                if (el.children.length > 2) continue
                                if ((el.textContent || '').toLowerCase().includes(firstTwo)) {
                                    foundEl = el as HTMLElement
                                    break
                                }
                            }
                        }
                        if (!foundEl) return false

                        const card = (foundEl.closest(
                            'button, a, [role="button"], [class*="card"], [class*="tile"], [class*="item"], div'
                        ) || foundEl) as HTMLElement
                        const txt = (card.innerText || card.textContent || '').toLowerCase()
                        const hasCheck =
                            card.querySelector(
                                '.mee-icon-CheckMark, [data-icon-name="CheckMark"], svg[aria-label*="Complete"], [class*="check"]'
                            ) !== null ||
                            card.classList.contains('completed') ||
                            card.classList.contains('complete') ||
                            card.getAttribute('aria-checked') === 'true'
                        const ptMatch = txt.match(/\+(\d+)/)
                        return hasCheck || (!ptMatch && (txt.includes('complete') || txt.includes('selesai')))
                    }, activity.title)
                    .catch(() => false)

                const balanceAfter = await this.bot.browser.func.getCurrentPoints().catch(() => balanceBefore)
                const delta = Math.max(0, balanceAfter - balanceBefore)

                if (isNowDone || delta > 0) {
                    const gained = delta > 0 ? delta : cardCheck.points
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'DAILY-SET',
                        `[FLYOUT-SUCCESS] ✅ Kartu "${activity.title}" (+${gained} pts) berhasil diverifikasi selesai di Flyout! (evidence=${isNowDone ? 'dom-checkmark' : 'balance-delta'})`,
                        'green'
                    )
                    this.bot.userData.currentPoints = balanceAfter
                    executionMap.set(key, {
                        offerId: activity.offerId,
                        title: activity.title,
                        status: 'verified-complete',
                        advertisedPoints: cardCheck.points,
                        observedBalanceDelta: gained,
                        attributedPoints: gained,
                        serverCompleted: true,
                        completionEvidence: isNowDone ? 'dom-checkmark' : 'server-dashboard-state'
                    })
                } else {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'DAILY-SET',
                        `[FLYOUT-WARN] Kartu "${activity.title}" belum menampilkan centang pasca klik.`
                    )
                }

                await this.bot.utils.wait(1500)
            }

            // Tutup drawer agar tidak menghalangi elemen dashboard lainnya
            await page
                .evaluate(() => {
                    const closeBtn = document.querySelector(
                        'button[aria-label*="Close" i], button[title*="Close" i], [aria-label*="close" i], .ms-Dialog-button--close'
                    ) as HTMLElement
                    if (closeBtn) closeBtn.click()
                })
                .catch(() => {})

            return true
        } catch (err) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'DAILY-SET',
                `Terjadi kendala pada solveModernDailySetFlyout: ${err instanceof Error ? err.message : String(err)}. Melanjutkan ke fallback standard.`
            )
            return false
        }
    }

    public async solveInteractiveQuizOnTab(tab: Page): Promise<void> {
        if (!tab || (typeof tab.isClosed === 'function' && tab.isClosed())) return

        const startQuizSelector =
            '#rqStartQuiz, #rqStartQuizToken, input[value*="Start" i], button:has-text("Start"), div[role="button"]:has-text("Start"), button:has-text("Mulai"), div[role="button"]:has-text("Mulai"), .btOption, [data-bi-name="startQuiz"], [id*="StartQuiz"], input[value*="playing" i], a.rq_button'
        const quizOptionsSelector =
            '[id^="rqAnswerOption"], .btOption, [id^="btoption"], .rqOptions, .wk_Option, [role="radio"], button.optionBtn, .bt_poll, input[type="radio"], .rqOption, .rq_button, [data-option], .rq-option, [data-option-id], .quiz-option, .c-card__content [role="button"], div[class*="option"]:not([class*="disabled"]), button[class*="option"], div[role="radio"], button[role="radio"]'
        const nextBtnSelector =
            '#rqNextQuestion, input#rqNextQuestion, input[value*="Next" i], button:has-text("Next"), button:has-text("Berikutnya"), [id*="nextQuestion"], [data-bi-name="nextQuestion"]'

        try {
            await tab.waitForSelector(`${startQuizSelector}, ${quizOptionsSelector}`, {
                state: 'attached',
                timeout: 5000
            }).catch(() => {})
        } catch {}

        // Tunggu hidrasi widget jika belum langsung terlihat
        for (let waitAttempt = 0; waitAttempt < 3; waitAttempt++) {
            if (typeof tab.isClosed === 'function' && tab.isClosed()) return
            const hasStart = await tab.locator(startQuizSelector).first().isVisible().catch(() => false)
            const optCount = await tab.locator(quizOptionsSelector).count().catch(() => 0)
            if (hasStart || optCount > 0) break
            await this.bot.utils.wait(1500)
        }

        for (let q = 0; q < 12; q++) {
            if (typeof tab.isClosed === 'function' && tab.isClosed()) break

            const startBtn = tab.locator(startQuizSelector).first()
            if (await startBtn.isVisible().catch(() => false)) {
                this.bot.logger.info(this.bot.isMobile, 'DAILY-SET-QUIZ', 'Menekan tombol mulai kuis...')
                await startBtn.click({ force: true }).catch(() => {})
                await this.bot.utils.wait(2000)
            }

            const quizOptions = tab.locator(quizOptionsSelector)
            const optCount = await quizOptions.count().catch(() => 0)

            if (optCount > 0) {
                let clicked = false
                const randIdx = Math.floor(Math.random() * Math.min(optCount, 4))
                const targetOpt = quizOptions.nth(randIdx)
                if (await targetOpt.isVisible().catch(() => false)) {
                    await targetOpt.scrollIntoViewIfNeeded().catch(() => {})
                    await targetOpt.click({ force: true }).catch(() => {})
                    clicked = true
                } else {
                    for (let i = 0; i < Math.min(optCount, 6); i++) {
                        const opt = quizOptions.nth(i)
                        if (await opt.isVisible().catch(() => false)) {
                            await opt.scrollIntoViewIfNeeded().catch(() => {})
                            await opt.click({ force: true }).catch(() => {})
                            clicked = true
                            break
                        }
                    }
                }

                if (clicked) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'DAILY-SET-QUIZ',
                        `[QUIZ-CLICK] Mengklik opsi jawaban (pertanyaan ${q + 1})`
                    )
                    await this.bot.utils.wait(1500)
                }

                const nextBtn = tab.locator(nextBtnSelector).first()
                if (await nextBtn.isVisible().catch(() => false)) {
                    await nextBtn.click({ force: true }).catch(() => {})
                    await this.bot.utils.wait(1500)
                }
            } else {
                const nextBtn = tab.locator(nextBtnSelector).first()
                if (await nextBtn.isVisible().catch(() => false)) {
                    await nextBtn.click({ force: true }).catch(() => {})
                    await this.bot.utils.wait(1500)
                    continue
                }
                // Jika optCount === 0 pada q === 0, tunggu hidrasi sekali lagi sebelum menyerah
                if (q === 0) {
                    await this.bot.utils.wait(2000)
                    const recheckOpt = await quizOptions.count().catch(() => 0)
                    if (recheckOpt > 0) continue
                }
                break
            }
        }
        await this.bot.utils.wait(1500)
    }

    public async solvePuzzleOnTab(tab: Page): Promise<void> {
        if (!tab || (typeof tab.isClosed === 'function' && tab.isClosed())) return
        const puzzleSelector =
            '#puzzle, .puzzle, [id*="puzzle"], [class*="puzzle"], .slide-tile, .puzzle-piece, #overlay, canvas, .game-canvas, #gameContainer'
        try {
            await tab.waitForSelector(puzzleSelector, { state: 'attached', timeout: 3500 }).catch(() => {})
            const puzzleEl = tab.locator(puzzleSelector).first()
            if (await puzzleEl.isVisible().catch(() => false)) {
                await puzzleEl.scrollIntoViewIfNeeded().catch(() => {})
                await puzzleEl.click({ force: true }).catch(() => {})
            }
            await this.bot.utils.wait(this.bot.utils.randomDelay(3000, 4500))
        } catch {}
    }
}

export function isChildComplete(c: BasePromotion): boolean {
    if (!c) return false
    return Boolean(
        c.complete === true ||
        String(c.complete).toLowerCase() === 'true' ||
        ((c.pointProgressMax ?? 0) > 0 && (c.pointProgress ?? 0) >= (c.pointProgressMax ?? 0))
    )
}

export function isChildLocked(c: BasePromotion): boolean {
    if (!c) return false
    const attr = (c.attributes || {}) as Record<string, any>
    return Boolean(
        attr.isLocked === 'True' ||
        attr.isLocked === 'true' ||
        attr.isLocked === true ||
        (c as any).isLocked === true ||
        (c as any).exclusiveLockedFeatureStatus === 'locked' ||
        attr.locked_category_criteria === 'rewardsApp' ||
        attr.is_unlocked === 'False'
    )
}

export function isChildDisabled(c: BasePromotion): boolean {
    if (!c) return false
    const attr = (c.attributes || {}) as Record<string, any>
    return Boolean(
        attr.disabled === 'True' ||
        attr.disabled === 'true' ||
        attr.disabled === true ||
        (c as any).disabled === true
    )
}

export function isChildFutureDated(c: BasePromotion, now: number = Date.now()): boolean {
    if (!c) return false
    const attr = (c.attributes || {}) as Record<string, any>
    return Boolean(
        attr.isFutureDated === 'True' ||
        attr.isFutureDated === true ||
        (attr.startDate && new Date(attr.startDate).getTime() > now)
    )
}

export function isChildInCooldown(c: BasePromotion): boolean {
    if (!c) return false
    const attr = (c.attributes || {}) as Record<string, any>
    return Boolean(
        (attr.cooldown && String(attr.cooldown).toLowerCase() === 'true') ||
        attr.inCooldown === true ||
        String(attr.inCooldown).toLowerCase() === 'true'
    )
}

export function createPunchCardSnapshot(
    card: PunchCard,
    targetChildOfferId?: string
): PunchCardServerSnapshot {
    const parent = card.parentPromotion
    const parentOfferId = parent?.offerId || card.name || ''
    const parentComplete = Boolean(
        parent?.complete === true ||
        String(parent?.complete).toLowerCase() === 'true' ||
        ((parent?.pointProgressMax ?? 0) > 0 && (parent?.pointProgress ?? 0) >= (parent?.pointProgressMax ?? 0))
    )

    const children = card.childPromotions ?? []
    const totalChildren = children.length > 0 ? children.length : 1

    let completedChildren = 0
    let locked = 0
    let futureDated = 0
    let actionableNow = 0
    let targetChildComplete: boolean | undefined = undefined
    let targetChildLocked: boolean | undefined = undefined

    const now = Date.now()

    if (children.length === 0) {
        if (parentComplete) {
            completedChildren = 1
        } else {
            actionableNow = 1
        }
    } else {
        const eligibleChildren: BasePromotion[] = []
        for (const c of children) {
            if (!c) continue
            const isComp = isChildComplete(c)
            const isDis = isChildDisabled(c)
            const isLock = isChildLocked(c)
            const isFut = isChildFutureDated(c, now) || isChildInCooldown(c)

            if (targetChildOfferId && c.offerId === targetChildOfferId) {
                targetChildComplete = isComp
                targetChildLocked = isLock
            }

            if (isComp) {
                completedChildren++
            } else if (isDis) {
                // disabled
            } else if (isLock) {
                locked++
            } else if (isFut) {
                futureDated++
            } else {
                eligibleChildren.push(c)
            }
        }
        actionableNow = eligibleChildren.length > 0 ? 1 : 0
        if (eligibleChildren.length > 1) {
            locked += eligibleChildren.length - 1
        }
    }

    return {
        parentOfferId,
        childOfferId: targetChildOfferId,
        completedChildren,
        totalChildren,
        actionableNow,
        locked,
        futureDated,
        parentComplete,
        childComplete: targetChildComplete,
        childLocked: targetChildLocked
    }
}

export function findMatchingPunchCard(
    data: DashboardData | null | undefined,
    parentOfferId: string
): PunchCard | null {
    if (!data) return null
    if (data.punchCards) {
        const found = data.punchCards.find(
            p =>
                (p.parentPromotion?.offerId && p.parentPromotion.offerId === parentOfferId) ||
                (p.name && p.name.toLowerCase().trim() === parentOfferId.toLowerCase().trim())
        )
        if (found) return found
    }
    const standalone = [
        ...(data.promotionalItems ?? []),
        ...(data.morePromotions ?? []),
        ...(data.morePromotionsWithoutPromotionalItems ?? [])
    ].find(
        x =>
            x &&
            (x.offerId === parentOfferId ||
                (x.name && x.name.toLowerCase().trim() === parentOfferId.toLowerCase().trim()))
    )
    if (standalone) {
        return {
            name: standalone.name || standalone.offerId,
            parentPromotion: standalone,
            childPromotions: []
        } as unknown as PunchCard
    }
    return null
}

export class ProductionPunchCardStateReader implements PunchCardStateReader {
    constructor(private browserFunc?: { getDashboardData: () => Promise<DashboardData> }) {}

    async fetchPunchCardSnapshot(
        parentOfferId: string,
        targetChildOfferId?: string
    ): Promise<PunchCardServerSnapshot | null> {
        if (!this.browserFunc?.getDashboardData) return null
        try {
            const freshData = await this.browserFunc.getDashboardData()
            const matchingPc = findMatchingPunchCard(freshData, parentOfferId)
            if (!matchingPc) return null
            return createPunchCardSnapshot(matchingPc, targetChildOfferId)
        } catch {
            return null
        }
    }
}

export {
    type PunchCardStateReader,
    type PunchCardServerSnapshot,
    evaluatePunchCardRun
}
