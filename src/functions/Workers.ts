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

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    public async doClaimPendingPoints(page: Page) {
        try {
            const selectors = [
                '//div[contains(., "Ready to claim")]//a[contains(., "Claim") or contains(., "Klaim")]',
                '//div[contains(., "Ready to claim")]//button',
                '//div[contains(., "Ready to claim")]',
                'a:has-text("Claim")',
                'a:has-text("Klaim")',
                'button:has-text("Claim")',
                'button:has-text("Klaim")',
                '#claimPendingPoints',
                '.claim-button',
                '[data-bi-id*="claim" i]',
                '[id*="claimReward" i]',
                '.rewards-claim-button',
                '.point-claim-button',
                'div[role="button"]:has-text("Claim")',
                'div[role="button"]:has-text("Klaim")',
                '[aria-label*="Claim reward" i]',
                '[aria-label*="Klaim" i]',
                '.p-card button:has-text("Claim")',
                '.p-card button:has-text("Klaim")'
            ]

            for (const sel of selectors) {
                const elements = page.locator(sel)
                const count = await elements.count().catch(() => 0)
                for (let i = 0; i < count; i++) {
                    const el = elements.nth(i)
                    const isVis = await el.isVisible().catch(() => false)
                    if (!isVis) continue

                    const info = await el.evaluate((node: HTMLElement) => {
                        const rawText = (node.innerText || '').trim()
                        const parentText = (node.parentElement?.innerText || '').trim()
                        const txt = rawText.toLowerCase()
                        
                        // Abaikan artikel berita MSN / Bing News / Search results / Footer / Feedback / Navigasi atas
                        const isNewsOrSearchResult = node.closest('#b_results, #ans_nws, .news, .b_algo, #news, .feed-card, [data-bi-id*="news"], article, .b_algo, nav, header') !== null
                        const isTooLong = rawText.length > 50 // Tombol klaim asli teksnya pendek (< 50 char), bukan kalimat berita
                        
                        // Ekstrak angka poin (contoh: "Ready to claim 121 Claim >", "Claim +10", "100 Poin", "50 pts")
                        const explicitPlus = rawText.match(/\+(\d+)/)?.[1] || parentText.match(/\+(\d+)/)?.[1]
                        const explicitPts = rawText.match(/\b(\d+)\s*(pts|poin|points)\b/i)?.[1] || parentText.match(/\b(\d+)\s*(pts|poin|points)\b/i)?.[1]
                        const anyDigit = rawText.match(/\b(\d+)\b/)?.[1] || parentText.match(/\b(\d+)\b/)?.[1]
                        
                        const detectedNumStr = explicitPlus || explicitPts || anyDigit || ''
                        const detectedNum = detectedNumStr ? parseInt(detectedNumStr, 10) : null
                        
                        // Jika terdeteksi 0 poin (contoh: "Ready to claim 0 Claim" / "0 points"), berarti belum ada koin yang bisa diklaim
                        const isZeroPoints = detectedNum === 0 || txt.includes('0 claim') || txt.includes('claim 0') || txt.includes('ready to claim 0')
                        
                        const isTrash = isNewsOrSearchResult || isTooLong || isZeroPoints || txt.includes('feedback') || txt.includes('terms') || txt.includes('suggest') || txt.includes('code') || node.closest('#footer') !== null
                        const isClaim = txt.includes('claim') || txt.includes('klaim') || (node.outerHTML || '').toLowerCase().includes('claim')
                        
                        const label = rawText.replace(/\s+/g, ' ').slice(0, 30)

                        return { isTrash, isClaim, ptsNum: detectedNum && detectedNum > 0 ? detectedNum : null, label }
                    }).catch(() => ({ isTrash: true, isClaim: false, ptsNum: null, label: '' }))

                    if (info.isTrash || !info.isClaim) continue

                    const ptsLabel = info.ptsNum ? ` (+${info.ptsNum} Poin)` : ''
                    this.bot.logger.info(this.bot.isMobile, 'DASHBOARD', `🎉 Nemu koin nyangkut di ${this.bot.isMobile ? 'Mobile' : 'Desktop'}${ptsLabel}! Mengeksekusi klaim siluman: "${info.label || 'Claim'}"...`, 'green')

                    const oldBalance = await this.bot.browser.func.getCurrentPoints().catch(() => 0)

                    // 1. Eksekusi Klik pada Link/Tombol Aksi di Dalam Card
                    const innerAction = el.locator('a, button, [role="button"], span:has-text("Claim"), span:has-text("Klaim")').first()
                    const hasInnerAction = (await innerAction.count().catch(() => 0)) > 0
                    const targetToClick = hasInnerAction ? innerAction : el

                    await targetToClick.scrollIntoViewIfNeeded().catch(() => {})
                    await targetToClick.click({ force: true, timeout: 5000 }).catch(async () => {
                        await targetToClick.evaluate((node: HTMLElement) => {
                            node.click()
                            node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
                            node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
                            node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                        }).catch(() => {})
                    })

                    await page.waitForTimeout(2500)

                    // 2. Cek jika membuka Drawer / Flyout / Modal Popup ("Claim All", "Got it", "OK", "Claim")
                    const subClaimButtons = page.locator('.flyout button:has-text("Claim"), .drawer button:has-text("Claim"), [role="dialog"] button:has-text("Claim"), .flyout a:has-text("Claim"), .drawer a:has-text("Claim"), button:has-text("Claim all"), button:has-text("Klaim semua"), button:has-text("Got it"), button:has-text("OK"), button:has-text("Terima")')
                    const subCount = await subClaimButtons.count().catch(() => 0)
                    for (let s = 0; s < subCount; s++) {
                        const sBtn = subClaimButtons.nth(s)
                        if (await sBtn.isVisible().catch(() => false)) {
                            await sBtn.click({ force: true }).catch(() => {})
                            await page.waitForTimeout(1500)
                        }
                    }

                    await page.waitForTimeout(3000)

                    // 3. Validasi Nyata Penambahan Saldo dari Server Microsoft
                    const newBalance = await this.bot.browser.func.getCurrentPoints().catch(() => 0)
                    const gainedPoints = newBalance - oldBalance

                    if (gainedPoints > 0) {
                        this.bot.userData.currentPoints = newBalance
                        this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
                        this.bot.logger.info(this.bot.isMobile, 'DASHBOARD', `✅ Koin nyangkut sukses diamankan! | +${gainedPoints} points | newBalance=${newBalance}`, 'green')
                        void Database.getInstance().recordActivity(this.bot.activeAccount?.email || '', 'CLAIM_PENDING_POINTS', gainedPoints)
                        break
                    } else {
                        this.bot.logger.info(this.bot.isMobile, 'DASHBOARD', `ℹ️ Klaim koin telah dieksekusi | balance=${oldBalance} poin.`)
                        break
                    }
                }
            }
        } catch (error) {
            this.bot.logger.debug(this.bot.isMobile, 'DASHBOARD', 'Tidak ada koin nyangkut yang perlu diklaim.')
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

        let activitiesUncompleted = uniqueDailySet.filter(x => {
            if (!x || x.complete || x.pointProgressMax <= 0) return false
            const offerIdLower = (x.offerId ?? '').toLowerCase()
            if (offerIdLower.includes('locked')) return false
            
            // Lewati jika tanggal DailySet bukan hari ini (kemarin kadaluarsa, besok terkunci)
            const dateMatch = (x.offerId ?? '').match(/DailySet_(\d{8})/i)
            if (dateMatch && dateMatch[1] && !validDates.has(dateMatch[1])) {
                return false
            }
            return true
        })

        // 2. Jika dari API tidak ada item uncompleted, periksa Live DOM Dashboard
        if (activitiesUncompleted.length === 0) {
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
        const punchCardChildren = (data.punchCards ?? []).flatMap(pc => [
            ...(pc.childPromotions ?? []),
            ...(pc.parentPromotion ? [pc.parentPromotion] : [])
        ]) as unknown as BasePromotion[]

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
            const isUncompleted = !x.complete || (x.pointProgressMax > 0 && (x.pointProgress ?? 0) < x.pointProgressMax)
            const hasPoints = (x.pointProgressMax ?? 0) > 0 && (x.pointProgressMax ?? 0) <= 1000
            const isImpression = (x.offerId ?? '').toLowerCase().includes('impression') || (x.offerId ?? '').toLowerCase().includes('refer_and_earn') || !(x.title ?? '').trim()
            const isWelcomeTour = (x.offerId ?? '').toLowerCase().includes('fre_offer') ||
                                  (x.offerId ?? '').toLowerCase().includes('welcometour') ||
                                  (x.title ?? '').toLowerCase().includes('take the tour')

            // Buka & kerjakan semua kartu harian/mingguan (Multi-day Starter Card 'Take the tour' dialihkan ke PunchCards)
            return isUncompleted && hasPoints && !isImpression && !isWelcomeTour
        })
    }

    public async doMorePromotions(data: DashboardData, page: Page) {
        let activitiesUncompleted = this.extractAllPromotions(data)

        // Scrape kartu bonus langsung dari Live DOM Dashboard / Earn page (untuk menangkap kartu Keep earning visual +5/+15 Pts)
        try {
            const currentUrl = page.url().toLowerCase()
            if (!currentUrl.includes('rewards.bing.com')) {
                await page.goto(this.bot.config.baseURL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
                await this.bot.utils.wait(2000)
            }

            const liveDomCards: BasePromotion[] = await page.evaluate(() => {
                const results: any[] = []
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

                    const href = el.getAttribute('href') || el.querySelector('a')?.getAttribute('href') || ''
                    const hasCheckmark = el.querySelector('.mee-icon-CheckMark, [data-icon-name="CheckMark"], .c-icon-check, .complete-check, svg[aria-label*="Complete"], [class*="check"]') !== null ||
                                         el.getAttribute('aria-checked') === 'true' ||
                                         el.classList.contains('completed') ||
                                         txt.toLowerCase().includes('completed') ||
                                         txt.toLowerCase().includes('selesai')

                    const pointsMatch = txt.match(/\+(\d+)/)
                    const points = pointsMatch && pointsMatch[1] ? parseInt(pointsMatch[1], 10) : 0

                    if (!hasCheckmark && points > 0) {
                        seenTitles.add(title.toLowerCase())
                        results.push({
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
                return results
            }).catch(() => [])

            if (liveDomCards && liveDomCards.length > 0) {
                const combined = [...activitiesUncompleted, ...liveDomCards]
                activitiesUncompleted = [...new Map(combined.map(c => [c.title.toLowerCase().trim(), c])).values()]
            }
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

        // Also check if any standalone promotion in promotionalItems/morePromotions is a PunchCard
        const standaloneCards = [
            ...(data.promotionalItems ?? []),
            ...(data.morePromotions ?? []),
            ...(data.morePromotionsWithoutPromotionalItems ?? [])
        ].filter(x => 
            x && !x.complete && 
            ((x.promotionType ?? '').toLowerCase() === 'punchcard' || (x.offerId ?? '').toLowerCase().includes('punchcard') || (x.destinationUrl ?? '').toLowerCase().includes('punchcard')) &&
            (x.pointProgressMax ?? 0) > 0
        )

        for (const promo of standaloneCards) {
            if (!punchCards.some(pc => pc.parentPromotion?.offerId === promo.offerId)) {
                punchCards.push({
                    parentPromotion: promo,
                    childPromotions: []
                } as any)
            }
        }

        const activePunchCards = punchCards.filter(x => !x.parentPromotion?.complete && (x.parentPromotion?.pointProgressMax ?? 0) > 0)

        for (const card of activePunchCards) {
            const activitiesUncompleted = (card.childPromotions ?? []).filter(x => !x.complete && x.promotionType)
            if (activitiesUncompleted.length) {
                this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `Solving ${activitiesUncompleted.length} items for: ${card.parentPromotion.title}`)
                await this.solveActivities(activitiesUncompleted, page, card) 
            } else if (card.parentPromotion && !card.parentPromotion.complete && card.parentPromotion.destinationUrl) {
                // Multi-Day Streak / 50-100 Poin Punch Card: All child items completed, executing final claim step!
                this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `Attempting final reward claim (+${card.parentPromotion.pointProgressMax}) for: ${card.parentPromotion.title}`)
                const claimActivity = card.parentPromotion as unknown as BasePromotion
                await this.bot.activities.doUrlReward(claimActivity, page, card)
            }
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
                
                await this.bot.utils.wait(this.bot.utils.randomDelay(4000, 8000))

            } catch (error) {
                this.bot.logger.error(this.bot.isMobile, 'ACTIVITY', `Error solving "${activity.title}"`)
            }
        }
    }
}