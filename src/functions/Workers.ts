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

    public async doClaimPendingPoints(page: Page) {
        if (!page || page.isClosed()) return
        try {
            const currentUrl = page.url().toLowerCase()
            if (!currentUrl.includes('rewards.bing.com')) {
                this.bot.logger.debug(this.bot.isMobile, 'DASHBOARD', 'Navigating to Rewards dashboard to check pending claims...')
                await page.goto(this.bot.config.baseURL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
                await this.bot.utils.wait(2500)
            }

            const claimResult = await page.evaluate(() => {
                // 1. Prioritaskan Card "Ready to claim" (seperti di screenshot dashboard modern)
                const allElements = Array.from(document.querySelectorAll('*'))
                
                for (const el of allElements) {
                    const txt = (el.textContent || '').trim().toLowerCase()
                    if (txt.includes('ready to claim') || txt.includes('siap diklaim')) {
                        // Cari target container terkecil
                        const innerCards = el.querySelectorAll('div, section, .card, .p-card, .c-card')
                        let targetContainer = el as HTMLElement
                        for (const child of Array.from(innerCards)) {
                            const childTxt = (child.textContent || '').trim().toLowerCase()
                            if ((childTxt.includes('ready to claim') || childTxt.includes('siap diklaim')) && childTxt.length < (targetContainer.textContent || '').length) {
                                targetContainer = child as HTMLElement
                            }
                        }
                        
                        const containerText = (targetContainer.innerText || targetContainer.textContent || '').trim()
                        const numMatches = containerText.match(/(\d+)/g)
                        let pts = 0
                        if (numMatches && numMatches.length > 0) {
                            for (const n of numMatches) {
                                const val = parseInt(n, 10)
                                if (val > 0 && val < 50000) {
                                    pts = val
                                    break
                                }
                            }
                        }
                        
                        // Cari tombol atau link claim di dalam kartu
                        const allBtns = Array.from(targetContainer.querySelectorAll('a, button, div[role="button"], [class*="claim"], [id*="claim"]'))
                        const activeBtn = (allBtns.find(b => {
                            const bTxt = (b.textContent || '').toLowerCase().trim()
                            return bTxt.includes('claim') || bTxt.includes('klaim') || bTxt.includes('>')
                        }) || targetContainer.querySelector('a, button, div[role="button"]') || targetContainer) as HTMLElement
                        
                        if (activeBtn) {
                            activeBtn.click()
                            activeBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
                            activeBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
                            activeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                            
                            return { clicked: true, label: `Ready to claim (${pts || 'Pending'} Pts)`, pts: pts > 0 ? pts : null }
                        }
                    }
                }

                // 2. Fallback: Cari elemen claim individual lainnya di seluruh halaman
                const candidates = Array.from(document.querySelectorAll('a, button, div[role="button"], span, .p-card, .c-card, [id*="claim"], [class*="claim"], [data-bi-id*="claim"]'))
                
                for (const rawEl of candidates) {
                    const el = rawEl as HTMLElement
                    const rawText = (el.innerText || el.textContent || '').trim()
                    if (!rawText || rawText.length > 50) continue
                    const txt = rawText.toLowerCase()
                    
                    if (el.closest('#b_results, #ans_nws, .news, .b_algo, #news, .feed-card, [data-bi-id*="news"], article, nav, header, footer')) continue
                    
                    const isClaim = txt === 'claim' || txt === 'klaim' || txt === 'claim >' || txt.includes('claim all') || txt.includes('klaim semua') || (txt.includes('claim') && !txt.includes('0 claim') && !txt.includes('unclaimed') && !txt.includes('disclaimer'))
                    if (!isClaim) continue
                    
                    if (txt.includes('feedback') || txt.includes('terms') || txt.includes('suggest') || txt.includes('code') || txt.includes('reward')) continue
                    
                    const rect = el.getBoundingClientRect()
                    if (rect.width === 0 || rect.height === 0) continue
                    
                    const style = window.getComputedStyle(el)
                    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue
                    
                    const clickTarget = (el.querySelector('a, button, [role="button"]') || el) as HTMLElement
                    clickTarget.click()
                    clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
                    clickTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
                    clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                    
                    const explicitNum = rawText.match(/(\d+)/)?.[1]
                    const detectedPts = explicitNum ? parseInt(explicitNum, 10) : null
                    
                    return { clicked: true, label: rawText.replace(/\s+/g, ' ').slice(0, 30), pts: detectedPts }
                }

                return { clicked: false, label: '', pts: null }
            }).catch(() => ({ clicked: false, label: '', pts: null }))

            if (claimResult.clicked) {
                const ptsLabel = claimResult.pts ? ` (+${claimResult.pts} Poin)` : ''
                this.bot.logger.info(this.bot.isMobile, 'DASHBOARD', `🎉 Nemu koin nyangkut di ${this.bot.isMobile ? 'Mobile' : 'Desktop'}${ptsLabel}! Mengeksekusi klaim: "${claimResult.label || 'Claim'}"...`, 'green')
                await this.bot.utils.wait(2500)
                
                // Cek apakah ada drawer / flyout / modal popup yang muncul untuk tombol "Claim All" atau "Got it"
                await page.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('.flyout button, .drawer button, [role="dialog"] button, [class*="drawer"] button, [class*="modal"] button, [class*="flyout"] button, button, a'))
                    for (const btn of btns) {
                        const t = (btn.textContent || '').toLowerCase().trim()
                        if (['claim all', 'klaim semua', 'claim', 'klaim', 'got it', 'ok', 'terima', 'done'].includes(t)) {
                            (btn as HTMLElement).click()
                            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                            break
                        }
                    }
                }).catch(() => {})
                
                await this.bot.utils.wait(2000)
                
                const oldBalance = Number(this.bot.userData.currentPoints ?? 0)
                const newBalance = await this.bot.browser.func.getCurrentPoints(page).catch(() => oldBalance)
                const gainedPoints = Math.max(0, newBalance - oldBalance)
                const finalGained = gainedPoints > 0 ? gainedPoints : (claimResult.pts ?? 0)
                
                if (finalGained > 0) {
                    this.bot.userData.currentPoints = Math.max(newBalance, oldBalance + finalGained)
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + finalGained
                    this.bot.logger.info(this.bot.isMobile, 'DASHBOARD', `✅ Koin nyangkut sukses diamankan! | +${finalGained} points | newBalance=${this.bot.userData.currentPoints}`, 'green')
                    void Database.getInstance().recordActivity(this.bot.activeAccount?.email || '', 'CLAIM_PENDING_POINTS', finalGained)
                }
            } else {
                this.bot.logger.debug(this.bot.isMobile, 'DASHBOARD', 'Tidak ada koin nyangkut yang perlu diklaim.')
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
            
            // 1. Cek apakah sudah sukses diselesaikan di fase Daily Set atau Keep Earning pada sesi ini
            const isAlreadySolvedInSession = this.completedOffersInSession.has(offerId) || this.completedOffersInSession.has(title.toLowerCase().trim())
            
            const progress = this.getPunchCardProgressDetails(card)

            if (isAlreadySolvedInSession || progress.isCompleted) {
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

            const uncompletedChildren = (card.childPromotions ?? []).filter(x => {
                if (!x) return false
                if (x.complete) return false
                if (this.completedOffersInSession.has(x.offerId) || this.completedOffersInSession.has((x.title || '').toLowerCase().trim())) return false
                if (x.pointProgressMax > 0 && x.pointProgress >= x.pointProgressMax) return false
                return true
            })

            this.bot.logger.info(
                this.bot.isMobile,
                'PUNCHCARD',
                `"${title}" | Progress: ${progress.progressStr} | Points: ${progress.pointsStr} | Status: ${uncompletedChildren.length} active sub-task(s)`,
                'cyan'
            )

            if (uncompletedChildren.length > 0) {
                this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `Solving ${uncompletedChildren.length} active sub-item(s) for: "${title}"`)
                await this.solveActivities(uncompletedChildren, page, card)
                this.completedOffersInSession.add(offerId)
                this.completedOffersInSession.add(title.toLowerCase().trim())
            } else if (card.parentPromotion?.destinationUrl) {
                // Multi-Day Streak / Final Claim Step
                this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `Attempting final reward claim (+${card.parentPromotion.pointProgressMax} Pts) for: "${title}"`)
                const claimActivity = card.parentPromotion as unknown as BasePromotion
                await this.bot.activities.doUrlReward(claimActivity, page, card)
                this.completedOffersInSession.add(offerId)
                this.completedOffersInSession.add(title.toLowerCase().trim())
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

        // 1. Hitung progres langkah / hari dari atribut
        const actProg = Number(parent?.activityProgress ?? 0)
        const actProgMax = Number(parent?.activityProgressMax ?? 0)

        const rawDays = attr['days'] || attr['max'] || attr['totaldays'] || ''
        const rawDaysEarned = attr['daysearned'] || attr['progress'] || attr['completeddays'] || ''

        const daysMax = rawDays ? parseInt(String(rawDays), 10) : 0
        const daysEarned = rawDaysEarned ? parseInt(String(rawDaysEarned), 10) : 0

        const completedChildrenCount = children.filter(c => c.complete || (c.pointProgressMax > 0 && c.pointProgress >= c.pointProgressMax)).length
        const totalChildrenCount = children.length

        let currentStep = 0
        let maxStep = 0

        if (daysMax > 0) {
            maxStep = daysMax
            currentStep = daysEarned
        } else if (actProgMax > 0) {
            maxStep = actProgMax
            currentStep = actProg
        } else if (totalChildrenCount > 0) {
            maxStep = totalChildrenCount
            currentStep = completedChildrenCount
        } else {
            maxStep = 1
            currentStep = parent?.complete ? 1 : 0
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
        const dayLabel = daysMax > 0 ? `(Day ${currentStep} of ${maxStep})` : `(Step ${currentStep} of ${maxStep})`
        const progressStr = `${currentStep}/${maxStep} Completed ${dayLabel} [${percent}%]`

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