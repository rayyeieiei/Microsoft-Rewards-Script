import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../index'
import type {
    DashboardData,
    PunchCard,
    BasePromotion,
    FindClippyPromotion
} from '../interface/DashboardData'
import type { AppDashboardData } from '../interface/AppDashBoardData'
import { Database } from '../util/Database'

export class Workers {
    public bot: MicrosoftRewardsBot
    public completedOffersInSession: Set<string> = new Set<string>()

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    public async doClaimPendingPoints(page: Page, isRecheck: boolean = false) {
        if (!page || page.isClosed()) return
        try {
            const currentUrl = page.url().toLowerCase()
            if (!currentUrl.includes('rewards.bing.com')) {
                this.bot.logger.debug(this.bot.isMobile, 'DASHBOARD', 'Navigating to Rewards dashboard to check pending claims...')
                await page.goto(this.bot.config.baseURL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
                await this.bot.utils.wait(2500)
            }

            const prefix = isRecheck ? '[RE-CHECK] ' : ''
            this.bot.logger.info(
                this.bot.isMobile,
                'DASHBOARD',
                `${prefix}Scanning Rewards dashboard for pending coins / "Ready to claim" cards...`
            )

            // 1. Deteksi spesifik kartu "Ready to claim" (Hindari kartu "Available points" dan bagian bawah)
            const cardInfo = await page.evaluate(() => {
                const allElements = Array.from(document.querySelectorAll('div, section, .card, .p-card, .c-card, [class*="card"]'))
                for (const el of allElements) {
                    const txt = (el.textContent || '').trim()
                    if ((txt.includes('Ready to claim') || txt.includes('Siap diklaim')) && !txt.includes('Available points') && txt.length < 150) {
                        const m = txt.match(/(\d+)/)
                        const pts = m && m[1] ? parseInt(m[1], 10) : 0
                        if (pts > 0 && pts < 5000) {
                            return { hasReadyCard: true, hasPanelOpen: false, pts }
                        }
                    }
                }
                const hasPanelOpen = document.body ? (document.body.innerText.includes('First search of the day') || document.body.innerText.includes('Claim points')) : false
                return { hasReadyCard: false, hasPanelOpen, pts: 0 }
            }).catch(() => ({ hasReadyCard: false, hasPanelOpen: false, pts: 0 }))

            if (!cardInfo.hasReadyCard && !cardInfo.hasPanelOpen) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'DASHBOARD',
                    `${prefix}✅ Pengecekan koin selesai: Tidak ada koin nyangkut (0 pending claims).`
                )
                return
            }

            const ptsLabel = cardInfo.pts > 0 ? ` (+${cardInfo.pts} Poin)` : ''
            this.bot.logger.info(
                this.bot.isMobile,
                'DASHBOARD',
                `${prefix}🎉 Nemu koin nyangkut di ${this.bot.isMobile ? 'Mobile' : 'Desktop'}${ptsLabel}! Mengeksekusi panel klaim...`,
                'green'
            )

            // 2. Buka Panel Slide "Claim points" JIKA belum terbuka
            const panelHeader = page.locator('text="Claim points", text="First search of the day", button:has-text("Claim points")').first()
            const isPanelAlreadyOpen = await panelHeader.isVisible().catch(() => false)

            if (!isPanelAlreadyOpen) {
                // Targetkan secara terisolasi kartu "Ready to claim" (eksklusi Available points / Redeem)
                const readyCard = page.locator('div, section, .card, .p-card, .c-card, [class*="card"]').filter({ hasText: 'Ready to claim' }).filter({ hasNotText: 'Available points' }).first()
                const claimLink = readyCard.locator('a, button, [role="button"], span').filter({ hasText: /^Claim(\s*>)?$/i }).first()

                if (await claimLink.isVisible().catch(() => false)) {
                    await claimLink.scrollIntoViewIfNeeded().catch(() => {})
                    await claimLink.click({ force: true }).catch(() => {})
                } else if (await readyCard.isVisible().catch(() => false)) {
                    await readyCard.scrollIntoViewIfNeeded().catch(() => {})
                    await readyCard.click({ force: true }).catch(() => {})
                } else {
                    await page.evaluate(() => {
                        const allElements = Array.from(document.querySelectorAll('div, section, .card, .p-card, .c-card, [class*="card"]'))
                        for (const el of allElements) {
                            const txt = (el.textContent || '').trim()
                            if ((txt.includes('Ready to claim') || txt.includes('Siap diklaim')) && !txt.includes('Available points') && txt.length < 150) {
                                const target = (el.querySelector('a, button, [role="button"]') || el) as HTMLElement
                                target.click()
                                target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                                break
                            }
                        }
                    }).catch(() => {})
                }

                await panelHeader.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
                await this.bot.utils.wait(1500)
            }

            // 3. TEKAN TOMBOL BESAR [ Claim points ] DI DALAM PANEL (Sesuai Screenshot media_1788187521263.png)
            this.bot.logger.info(this.bot.isMobile, 'DASHBOARD', `Mengeksekusi tombol "Claim points" di dalam panel...`, 'green')

            // a. Native Playwright Click pada tombol Claim points
            const modalClaimButton = page.locator('button:has-text("Claim points"), [role="button"]:has-text("Claim points"), button:has-text("Klaim poin"), div[role="button"]:has-text("Claim points")').first()
            if (await modalClaimButton.isVisible().catch(() => false)) {
                await modalClaimButton.scrollIntoViewIfNeeded().catch(() => {})
                await modalClaimButton.click({ force: true, timeout: 5000 }).catch(() => {})
            }

            // b. Fallback DOM Click Event dengan bounding rect nyata
            await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, a, div[role="button"]'))
                for (const b of btns) {
                    const txt = ((b as HTMLElement).innerText || b.textContent || '').trim().toLowerCase()
                    if (txt === 'claim points' || txt === 'klaim poin' || txt === 'claim all' || txt === 'klaim semua') {
                        (b as HTMLElement).click()
                        b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
                        b.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
                        b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                    }
                }
            }).catch(() => {})

            await this.bot.utils.wait(2500)

            // 4. Tutup Panel Modal (Klik tombol Close X)
            try {
                const closeBtn = page.locator('button[aria-label*="close" i], button[aria-label*="tutup" i], button.ms-Panel-closeButton, [data-icon-name="Cancel"], [aria-label="Close"]').first()
                if (await closeBtn.isVisible().catch(() => false)) {
                    await closeBtn.click({ force: true }).catch(() => {})
                }
            } catch {}

            await this.bot.utils.wait(1500)

            // 5. RE-CHECK VERIFIKASI AKHIR: Pastikan koin di dashboard sudah bersih
            const finalVerify = await page.evaluate(() => {
                const allElements = Array.from(document.querySelectorAll('div, section, .card, .p-card, .c-card, [class*="card"]'))
                for (const el of allElements) {
                    const txt = (el.textContent || '').trim()
                    if ((txt.includes('Ready to claim') || txt.includes('Siap diklaim')) && !txt.includes('Available points') && txt.length < 150) {
                        const m = txt.match(/(\d+)/)
                        if (m && m[1] && parseInt(m[1], 10) > 0) {
                            return { isClean: false, remaining: parseInt(m[1], 10) }
                        }
                    }
                }
                return { isClean: true }
            }).catch(() => ({ isClean: true }))

            // 6. Validasi Nyata Saldo (HANYA BERDASARKAN DELTA SERVER NYATA)
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
                void Database.getInstance().recordActivity(this.bot.activeAccount?.email || '', 'CLAIM_PENDING_POINTS', gainedPoints)
            } else if (finalVerify.isClean) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'DASHBOARD',
                    `${prefix}🎯 Re-check terverifikasi: Semua koin nyangkut sudah 100% bersih & sinkron (${oldBalance} pts).`,
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'DASHBOARD',
                    `${prefix}⚠️ Re-check mendeteksi masih ada ${(finalVerify as any).remaining} koin pending di dashboard.`
                )
            }
        } catch {
            this.bot.logger.debug(this.bot.isMobile, 'DASHBOARD', 'Pengecekan koin nyangkut selesai.')
        }
    }
    
    public async doDailySet(data: DashboardData, page: Page) {
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

        let activitiesUncompleted = todayDailySetItems.filter(x => {
            if (!x || x.complete || (x.pointProgressMax > 0 && (x.pointProgress ?? 0) >= x.pointProgressMax)) return false
            return true
        })

        // 1. Jika API menemukan item Daily Set untuk hari ini dan semuanya sudah berstatus complete, Daily Set tuntas!
        if (todayDailySetItems.length > 0 && activitiesUncompleted.length === 0) {
            this.bot.logger.info(
                this.bot.isMobile,
                'DAILY-SET',
                `Daily Set already completed for today! (${todayDailySetItems.length}/${todayDailySetItems.length} verified on server)`,
                'green'
            )
            return
        }

        // 2. Fallback: HANYA jika dari API sama sekali tidak ditemukan item Daily Set hari ini, periksa Live DOM Dashboard
        if (todayDailySetItems.length === 0 && activitiesUncompleted.length === 0) {
            try {
                const currentUrl = page.url().toLowerCase()
                if (!currentUrl.includes('rewards.bing.com')) {
                    await page.goto(this.bot.config.baseURL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
                    await this.bot.utils.wait(2000)
                }

                const liveDailySetCards: BasePromotion[] = await page.evaluate(() => {
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
                            dailySetSection = (el.closest('section') || el.closest('[class*="section"]') || el.parentElement?.parentElement || el.parentElement) as HTMLElement
                            break
                        }
                    }

                    if (!dailySetSection) {
                        dailySetSection = document.querySelector('#dailyset, [data-bi-area*="DailySet"], .daily-set, [id*="daily-set"]') as HTMLElement
                    }

                    if (!dailySetSection) return results

                    // 2. Ekstrak kartu-kartu di dalam section Daily Set
                    const candidateCards = Array.from(dailySetSection.querySelectorAll('a, [role="button"], .c-card, .p-card, [class*="card"], div:has(> [class*="title"]), div:has(> [class*="heading"])'))
                    
                    const seenTitles = new Set<string>()

                    for (const rawEl of candidateCards) {
                        const el = rawEl as HTMLElement
                        const txt = (el.innerText || el.textContent || '').trim()
                        if (!txt) continue

                        if (txt.toLowerCase().startsWith('daily set')) continue

                        const titleEl = el.querySelector('h3, h4, h5, .title, .c-heading, [class*="title"], [class*="heading"]')
                        const rawTitle = (titleEl?.textContent || el.getAttribute('aria-label') || '').trim()
                        
                        const lines = txt.split('\n').map(l => l.trim()).filter(Boolean)
                        const title = rawTitle || lines[0] || ''

                        if (!title || title.length > 60 || seenTitles.has(title.toLowerCase())) continue

                        const href = el.getAttribute('href') || el.querySelector('a')?.getAttribute('href') || 'https://rewards.bing.com'
                        
                        const hasCheckmark = el.querySelector('.mee-icon-CheckMark, [data-icon-name="CheckMark"], .c-icon-check, .complete-check, svg[aria-label*="Complete"], [class*="check"]') !== null ||
                                             el.getAttribute('aria-checked') === 'true' ||
                                             el.classList.contains('completed') ||
                                             txt.toLowerCase().includes('completed') ||
                                             txt.toLowerCase().includes('selesai')

                        const pointsMatch = txt.match(/\+(\d+)/)
                        const points = pointsMatch && pointsMatch[1] ? parseInt(pointsMatch[1], 10) : 10

                        if (!hasCheckmark && points > 0) {
                            seenTitles.add(title.toLowerCase())
                            results.push({
                                title,
                                destinationUrl: href.startsWith('http') ? href : 'https://rewards.bing.com',
                                pointProgressMax: points,
                                pointProgress: 0,
                                complete: false,
                                offerId: `dom_dailyset_${title.replace(/[^\w]/g, '_').toLowerCase()}`,
                                promotionType: title.toLowerCase().includes('?') || txt.toLowerCase().includes('test your knowledge') || txt.toLowerCase().includes('quiz') ? 'quiz' : 'urlreward'
                            })
                        }
                    }
                    return results
                }).catch(() => [])

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

        this.bot.logger.info(
            this.bot.isMobile,
            'TASK-DETECT',
            `[TASK-DETECT] Daily Set items found: ${uniqueDailySet.length} / uncompleted: ${activitiesUncompleted.length}`
        )

        if (activitiesUncompleted.length) {
            const startBalance = Number(this.bot.userData.currentPoints ?? 0)
            this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', `Started solving ${activitiesUncompleted.length} "Daily Set" items (All Valid Variants Checked) | currentPoints=${startBalance}`)
            await this.solveActivities(activitiesUncompleted, page)

            await this.bot.utils.wait(2000)
            const updatedBalance = await this.bot.browser.func.getCurrentPoints().catch(() => startBalance)
            const gained = Math.max(0, updatedBalance - startBalance)
            if (gained > 0) {
                this.bot.userData.currentPoints = updatedBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gained
                this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', `🎉 All Daily Set items completed! | gainedPoints=+${gained} | oldBalance=${startBalance} | newBalance=${updatedBalance}`, 'green')
            } else {
                this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', `All Daily Set items completed! | currentBalance=${updatedBalance}`)
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

        const uniquePromos = [...new Map(
            rawPromotions
                .filter(p => Boolean(p && (p.offerId || p.title)))
                .map(p => [p.offerId || p.title, p] as const)
        ).values()]

        return uniquePromos.filter(x => {
            const offerIdLower = (x.offerId ?? '').toLowerCase()
            const titleLower = (x.title ?? '').toLowerCase().trim()
            const promoTypeLower = (x.promotionType ?? '').toLowerCase()
            const destUrlLower = (x.destinationUrl ?? '').toLowerCase()

            const isUncompleted = !x.complete || (x.pointProgressMax > 0 && (x.pointProgress ?? 0) < x.pointProgressMax)
            const hasPoints = (x.pointProgressMax ?? 0) > 0 && (x.pointProgressMax ?? 0) <= 1000
            const isImpression = offerIdLower.includes('impression') || offerIdLower.includes('refer_and_earn') || !titleLower

            // Filter out Punch Cards / Multi-day Parent Trackers dari More Promotions
            const isPunchCard = promoTypeLower === 'punchcard' ||
                                offerIdLower.includes('punchcard') ||
                                destUrlLower.includes('punchcard') ||
                                punchCardParentOfferIds.has(offerIdLower) ||
                                punchCardParentTitles.has(titleLower) ||
                                Boolean((x.attributes as any)?.days || (x.attributes as any)?.daysearned || (x.attributes as any)?.totaldays)

            const isWelcomeTour = offerIdLower.includes('fre_offer') ||
                                  offerIdLower.includes('welcometour') ||
                                  titleLower.includes('take the tour')

            const isAppOnly = titleLower.includes('rewards app only') ||
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

        const unique = [...new Map(
            rawPromos
                .filter(p => Boolean(p && (p.offerId || p.title)))
                .map(p => [p.offerId || p.title, p] as const)
        ).values()]

        return unique.filter(x => {
            const titleLower = (x.title ?? '').toLowerCase().trim()
            const offerIdLower = (x.offerId ?? '').toLowerCase().trim()

            const isInternalInfo = offerIdLower.endsWith('_info') ||
                                  offerIdLower.includes('sapphire_appnewbonus_') ||
                                  offerIdLower.includes('addwidget') ||
                                  offerIdLower.includes('notification') ||
                                  titleLower.includes('add widget') ||
                                  titleLower.includes('enable notification')
            if (isInternalInfo) return false

            const isAppOnly = titleLower.includes('rewards app only') ||
                              titleLower.includes('app only') ||
                              titleLower.includes('bing app') ||
                              offerIdLower.includes('rewardsapp') ||
                              offerIdLower.includes('app_only') ||
                              offerIdLower.includes('appoffer') ||
                              (x as any).exclusiveLockedFeatureCategory === 'rewardsApp' ||
                              (x as any).exclusiveLockedFeatureStatus === 'locked' ||
                              (x.attributes as any)?.locked_category_criteria === 'rewardsApp' ||
                              (x.attributes as any)?.is_unlocked === 'False'

            const pointMax = (x.pointProgressMax ?? 0) || parseInt(String((x.attributes as any)?.max || (x.attributes as any)?.points || '10'), 10) || 10
            if (!x.pointProgressMax || x.pointProgressMax <= 0) {
                x.pointProgressMax = pointMax
            }

            return isAppOnly && pointMax > 0
        })
    }

    public async doMorePromotions(data: DashboardData, page: Page) {
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
                await page.goto(this.bot.config.baseURL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
                await this.bot.utils.wait(2000)
            }

            const { uncompletedCards, completedTitles } = await page.evaluate(() => {
                const uncompletedCards: any[] = []
                const completedTitles: string[] = []
                const seenTitles = new Set<string>()
                
                // Cari semua kartu di halaman di luar section Daily Set
                const allElements = Array.from(document.querySelectorAll('a, [role="button"], .c-card, .p-card, [class*="card"], [data-bi-id], [data-bi-area*="MorePromotions"], [data-bi-area*="Keep earning"]'))
                
                for (const rawEl of allElements) {
                    const el = rawEl as HTMLElement
                    const txt = (el.innerText || el.textContent || '').trim()
                    if (!txt) continue

                    // Abaikan jika berada di dalam container Daily Set
                    if (el.closest('#dailyset, [data-bi-area*="DailySet"], .daily-set, [id*="daily-set"]')) continue
                    
                    const titleEl = el.querySelector('h3, h4, h5, .title, .c-heading, [class*="title"], [class*="heading"]')
                    const rawTitle = (titleEl?.textContent || el.getAttribute('aria-label') || '').trim()
                    
                    const lines = txt.split('\n').map(l => l.trim()).filter(Boolean)
                    const title = rawTitle || (lines[0] && lines[0].length < 60 ? lines[0] : '')

                    if (!title || title.length > 70 || seenTitles.has(title.toLowerCase())) continue

                    // Abaikan navigasi header / footer / telemetry
                    const isSystemNav = title.toLowerCase().includes('daily set') ||
                                        title.toLowerCase().includes('rewards') ||
                                        title.toLowerCase().includes('sign in') ||
                                        title.toLowerCase().includes('level') ||
                                        title.toLowerCase().includes('streak') ||
                                        title.toLowerCase().includes('feedback') ||
                                        title.toLowerCase().includes('terms')

                    if (isSystemNav) continue
                    seenTitles.add(title.toLowerCase())

                    const href = el.getAttribute('href') || el.querySelector('a')?.getAttribute('href') || ''
                    const hasCheckmark = el.querySelector('.mee-icon-CheckMark, [data-icon-name="CheckMark"], .c-icon-check, .complete-check, svg[aria-label*="Complete"], [class*="check"]') !== null ||
                                         el.getAttribute('aria-checked') === 'true' ||
                                         el.classList.contains('completed') ||
                                         el.classList.contains('complete') ||
                                         txt.toLowerCase().includes('completed') ||
                                         txt.toLowerCase().includes('selesai')

                    const pointsMatch = txt.match(/\+(\d+)/)
                    const points = pointsMatch && pointsMatch[1] ? parseInt(pointsMatch[1], 10) : 0

                    // Abaikan Punch Card multi-day / kartu 50 poin bulanan dari scraper Keep Earning DOM
                    const isPunchCardTile = points >= 50 ||
                                            txt.toLowerCase().includes('punch card') ||
                                            txt.toLowerCase().includes('highlight') ||
                                            txt.toLowerCase().includes('tour') ||
                                            txt.toLowerCase().includes('day ') ||
                                            href.toLowerCase().includes('punchcard')

                    const containerSection = (el.closest('section, [class*="section"], [class*="container"]') as HTMLElement | null)
                    const sectionText = (containerSection?.innerText || containerSection?.textContent || '').toLowerCase()
                    const isAppOnlySection = sectionText.includes('rewards app only') ||
                                             sectionText.includes('app only') ||
                                             el.closest('[data-bi-area*="RewardsApp"], [id*="rewardsapp"]') !== null

                    const isAppOnly = isAppOnlySection ||
                                      txt.toLowerCase().includes('rewards app only') ||
                                      txt.toLowerCase().includes('app only') ||
                                      title.toLowerCase().includes('rewards app only') ||
                                      title.toLowerCase().includes('app only') ||
                                      href.toLowerCase().includes('rewardsapp')

                    const isMarketingPromo = title.toLowerCase().includes('referral') ||
                                             title.toLowerCase().includes('refer ') ||
                                             title.toLowerCase().includes('search bar') ||
                                             title.toLowerCase().includes('sweater weather') ||
                                             title.toLowerCase().includes('wallpaper') ||
                                             title.toLowerCase().includes('donate') ||
                                             href.startsWith('microsoft-edge:') ||
                                             href.includes('images/create')

                    if (hasCheckmark) {
                        completedTitles.push(title.toLowerCase().trim())
                    } else if (points > 0 && !isPunchCardTile && !isAppOnly && !isMarketingPromo) {
                        uncompletedCards.push({
                            title,
                            destinationUrl: href && href.startsWith('http') ? href : 'https://rewards.bing.com',
                            pointProgressMax: points,
                            pointProgress: 0,
                            complete: false,
                            offerId: `dom_bonus_${title.replace(/[^\w]/g, '_').toLowerCase()}`,
                            promotionType: title.toLowerCase().includes('?') || txt.toLowerCase().includes('quiz') ? 'quiz' : 'urlreward'
                        })
                    }
                }
                return { uncompletedCards, completedTitles }
            }).catch(() => ({ uncompletedCards: [], completedTitles: [] }))

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
        this.bot.logger.info(this.bot.isMobile, 'KEEP-EARNING', `Started solving ${activitiesUncompleted.length} "Keep earning" bonus cards (including +15 Weekly Cards & Punchcards)... | currentPoints=${startBonusBalance}`)
        await this.solveActivities(activitiesUncompleted, page)

        await this.bot.utils.wait(2000)
        const updatedBonusBalance = await this.bot.browser.func.getCurrentPoints().catch(() => startBonusBalance)
        const bonusGained = Math.max(0, updatedBonusBalance - startBonusBalance)
        if (bonusGained > 0) {
            this.bot.userData.currentPoints = updatedBonusBalance
            this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + bonusGained
            this.bot.logger.info(this.bot.isMobile, 'KEEP-EARNING', `🎉 All "Keep earning" bonus cards completed! | gainedPoints=+${bonusGained} | oldBalance=${startBonusBalance} | newBalance=${updatedBonusBalance}`, 'green')
        } else {
            this.bot.logger.info(this.bot.isMobile, 'KEEP-EARNING', `All "Keep earning" bonus cards completed! | currentBalance=${updatedBonusBalance}`)
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
        // Tangkap SEMUA item promosi khusus, global evergreen, & side quests valid (filter banner impression palsu)
        const allSpecials: BasePromotion[] = [
            ...(data.promotionalItems ?? []),
            ...(data.promotionalItem ? [data.promotionalItem] : [])
        ].filter(Boolean) as BasePromotion[]

        const uniqueSpecials = [...new Map(allSpecials.map(p => [p.offerId, p])).values()]
        
        const uncompleted = uniqueSpecials.filter(x => 
            !x.complete && 
            x.pointProgressMax > 0 && 
            x.pointProgressMax <= 500 &&
            !(x.offerId ?? '').toLowerCase().includes('locked') &&
            !(x.offerId ?? '').toLowerCase().includes('impression') &&
            !(x.offerId ?? '').toLowerCase().includes('refer_and_earn') &&
            (x.title ?? '').trim() !== ''
        )

        if (uncompleted.length > 0) {
            this.bot.logger.info(this.bot.isMobile, 'SPECIAL-ACTIVITY', `Found ${uncompleted.length} special/global promotion items (including Evergreen & Side Quests)! Solving now...`)
            
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
        if (!pointsActivity) return;

        if (pointsActivity.complete) {
            this.bot.logger.info(this.bot.isMobile, 'CLAIM-BONUS-POINTS', `Bonus points have already been claimed`)
            return
        }

        await this.bot.activities.doClaimBonusPoints()
        this.bot.logger.info(this.bot.isMobile, 'CLAIM-BONUS-POINTS', `🎉 Star Bonus points claimed!`, 'green')
    }

    public async doPunchCards(data: DashboardData, page: Page) {
        const punchCards: PunchCard[] = [...(data.punchCards ?? [])]

        // Periksa juga apakah ada kartu di promotionalItems/morePromotions yang merupakan PunchCard
        const standaloneCards = [
            ...(data.promotionalItems ?? []),
            ...(data.morePromotions ?? []),
            ...(data.morePromotionsWithoutPromotionalItems ?? [])
        ].filter(x => 
            x && 
            ((x.promotionType ?? '').toLowerCase() === 'punchcard' || (x.offerId ?? '').toLowerCase().includes('punchcard') || (x.destinationUrl ?? '').toLowerCase().includes('punchcard')) &&
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

        this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `[TASK-DETECT] Found ${punchCards.length} Punch Card(s) in account status`)

        for (const card of punchCards) {
            const title = card.parentPromotion?.title || card.name || 'Punch Card'
            const offerId = card.parentPromotion?.offerId || ''
            
            const progress = this.getPunchCardProgressDetails(card)

            this.bot.logger.info(
                this.bot.isMobile,
                'PUNCHCARD',
                `[PUNCHCARD] Evaluated punchcard: "${title}" | Current Active: Step ${Math.min(progress.maxStep, progress.currentStep + 1)}/${progress.maxStep}`
            )

            if (progress.isCompleted) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'PUNCHCARD',
                    `"${title}" | Progress: ${progress.progressStr} | Points: ${progress.pointsStr} | Status: Already Completed 🎉`,
                    'green'
                )
                continue
            }

            if (progress.isCompletedToday) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'PUNCHCARD',
                    `"${title}" | Progress: ${progress.progressStr} | Points: ${progress.pointsStr} | Status: Completed for Today ✅`,
                    'green'
                )
                continue
            }

            const children = card.childPromotions ?? []
            const uncompletedChildren = children.filter(x => {
                if (!x) return false
                if (x.complete) return false
                if (this.completedOffersInSession.has(x.offerId) || this.completedOffersInSession.has((x.title || '').toLowerCase().trim())) return false
                if (x.pointProgressMax > 0 && x.pointProgress >= x.pointProgressMax) return false
                return true
            })

            this.bot.logger.info(
                this.bot.isMobile,
                'PUNCHCARD',
                `"${title}" | Progress: ${progress.progressStr} | Points: ${progress.pointsStr} | Status: ${uncompletedChildren.length > 0 ? `${uncompletedChildren.length} active sub-task(s)` : 'Multi-day daily task in progress'}`,
                'cyan'
            )

            if (uncompletedChildren.length > 0) {
                // Hanya cari SATU step yang aktif dan tidak terkunci (locked / cooldown 24 jam)
                const activeChild = uncompletedChildren.find(c => {
                    const isLocked = (c.attributes as any)?.isLocked === 'True' ||
                                     (c.attributes as any)?.isLocked === 'true' ||
                                     (c.attributes as any)?.isLocked === true ||
                                     (c as any).isLocked === true
                    return !isLocked
                })

                if (activeChild) {
                    const stepTitle = activeChild.title || activeChild.name || `Step ${progress.currentStep + 1}`
                    const stepNum = progress.currentStep + 1
                    const taskTag = `(${stepNum}/${progress.maxStep} Tasks)`

                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD',
                        `[PUNCHCARD] Active step detected: "${title}" -> "${stepTitle}" ${taskTag}`
                    )

                    await this.solveActivities([activeChild], page, card)

                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD',
                        `[PUNCHCARD] Step "${stepTitle}" completed successfully. ${taskTag}`,
                        'green'
                    )

                    this.completedOffersInSession.add(activeChild.offerId)
                    this.completedOffersInSession.add((activeChild.title || '').toLowerCase().trim())
                    this.completedOffersInSession.add(offerId)
                    this.completedOffersInSession.add(title.toLowerCase().trim())

                    // Hentikan eksekusi step berikutnya karena masuk masa 24h cooldown
                    if (progress.maxStep > 1 && stepNum < progress.maxStep) {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'PUNCHCARD',
                            `[PUNCHCARD] Active step completed. Next step is locked (24h cooldown). Moving to next activity.`,
                            'yellow'
                        )
                    }

                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD',
                        `"${title}" | Progress: ${stepNum}/${progress.maxStep} Tasks | Status: Completed for Today ✅`,
                        'green'
                    )
                } else {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'PUNCHCARD',
                        `"${title}" | Remaining steps are locked (24h cooldown). Status: Completed for Today ✅`,
                        'green'
                    )
                }
            } else if (card.parentPromotion?.destinationUrl) {
                const stepNum = Math.min(progress.maxStep, progress.currentStep + 1)
                const taskTag = `(${stepNum}/${progress.maxStep} Tasks)`
                this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `[PUNCHCARD] Active step detected: "${title}" -> "Daily Step" ${taskTag}`)
                const claimActivity = card.parentPromotion as unknown as BasePromotion
                await this.bot.activities.doUrlReward(claimActivity, page, card)
                this.completedOffersInSession.add(offerId)
                this.completedOffersInSession.add(title.toLowerCase().trim())
                this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `[PUNCHCARD] Step "Daily Step" completed successfully. ${taskTag}`, 'green')
                this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `"${title}" | Progress: ${stepNum}/${progress.maxStep} Tasks | Status: Completed for Today ✅`, 'green')
            }
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
        const completedChildrenCount = children.filter(c => c.complete || (c.pointProgressMax > 0 && c.pointProgress >= c.pointProgressMax)).length

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
        const uncompletedChildren = children.filter(c => !c.complete && (!c.pointProgressMax || c.pointProgress < c.pointProgressMax))
        const isCompletedToday = isCompleted || (totalChildrenCount > 0 && uncompletedChildren.length === 0)

        const percent = maxStep > 0 ? Math.min(100, Math.round((currentStep / maxStep) * 100)) : (isCompleted ? 100 : 0)
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
                
                const isTokenMissing = !this.bot.requestToken || this.bot.rewardsVersion === 'modern'

                this.bot.logger.debug(this.bot.isMobile, 'ACTIVITY', `Processing | title="${activity.title}" | type=${type} | tokenMissing=${isTokenMissing}`)

                if ((type === 'quiz' || type.includes('trivia') || type.includes('poll') || type.includes('survey')) && !offerId.includes('dailyset')) {
                    await this.bot.activities.doQuiz(activity)
                } else if (type === 'findclippy') {
                    await this.bot.activities.doFindClippy(activity as unknown as FindClippyPromotion)
                } else if (name.includes('exploreonbing')) {
                    await this.bot.activities.doSearchOnBing(activity, page)
                } else {
                    // Default fallback: Selesaikan via Hybrid UrlReward solver (mencakup Daily Set URL, side quests 15 poin, explore cards, promo links, punchcard items)
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
}