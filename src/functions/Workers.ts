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
                    let newBalance = await this.bot.browser.func.getCurrentPoints().catch(() => 0)
                    let gainedPoints = newBalance - oldBalance

                    // Jika saldo belum bertambah sesaat, coba reload halaman untuk sinkronisasi balance backend
                    if (gainedPoints <= 0) {
                        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
                        await page.waitForTimeout(3000)
                        newBalance = await this.bot.browser.func.getCurrentPoints().catch(() => 0)
                        gainedPoints = newBalance - oldBalance
                    }

                    if (gainedPoints > 0) {
                        this.bot.userData.currentPoints = newBalance
                        this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
                        this.bot.logger.info(this.bot.isMobile, 'DASHBOARD', `✅ Koin nyangkut sukses diamankan! | +${gainedPoints} points | newBalance=${newBalance}`, 'green')
                        void Database.getInstance().recordActivity(this.bot.activeAccount?.email || '', 'CLAIM_PENDING_POINTS', gainedPoints)
                    } else {
                        this.bot.logger.warn(this.bot.isMobile, 'DASHBOARD', `⚠️ Tombol klaim koin nyangkut telah ditekan, namun saldo belum bertambah di server (masih ${oldBalance} poin).`)
                    }
                    await page.waitForTimeout(1500)
                }
            }
        } catch (error) {
            this.bot.logger.debug(this.bot.isMobile, 'DASHBOARD', 'Tidak ada koin nyangkut yang perlu diklaim.')
        }
    }
    
    public async doDailySet(data: DashboardData, page: Page) {
        // Ambil dari seluruh tanggal di dailySetPromotions (tanpa terhalang perbedaan timezone UTC vs GMT+7)
        const dailySetMapItems: BasePromotion[] = Object.values(data.dailySetPromotions ?? {}).flat() as BasePromotion[]
        
        const fallbackPromos = [
            ...(data.promotionalItems ?? []),
            ...(data.morePromotions ?? []),
            ...(data.morePromotionsWithoutPromotionalItems ?? [])
        ].filter(x => (x?.offerId ?? '').toLowerCase().includes('dailyset')) as BasePromotion[]

        const combined = [...dailySetMapItems, ...fallbackPromos].filter(Boolean)
        const uniqueDailySet = [...new Map(combined.map(p => [p.offerId, p])).values()]

        // Filter tanggal hari ini & abaikan preview misi hari esok yang masih dikunci
        const now = new Date()
        const todayStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`

        const activitiesUncompleted = uniqueDailySet.filter(x => {
            if (!x || x.complete || x.pointProgressMax <= 0) return false
            const offerIdLower = (x.offerId ?? '').toLowerCase()
            if (offerIdLower.includes('locked')) return false
            
            // Lewati preview misi besok (contoh: Global_DailySet_20260825_Child1)
            const dateMatch = (x.offerId ?? '').match(/DailySet_(\d{8})/i)
            if (dateMatch && dateMatch[1] && dateMatch[1] > todayStr) {
                return false
            }
            return true
        })

        if (activitiesUncompleted.length) {
            this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', `Started solving ${activitiesUncompleted.length} "Daily Set" items (All Valid Variants Checked)`)
            await this.solveActivities(activitiesUncompleted, page)
        }
    }

    public async doMorePromotions(data: DashboardData, page: Page) {
        const rawPromotions = [
            ...(data.morePromotions ?? []),
            ...(data.morePromotionsWithoutPromotionalItems ?? [])
        ] as unknown as BasePromotion[]

        const uniquePromos = [...new Map(
            rawPromotions.filter(p => Boolean(p && p.offerId)).map(p => [p.offerId, p] as const)
        ).values()]

        const activitiesUncompleted = uniquePromos.filter(x => {
            const isComplete = x.complete
            const hasPoints = (x.pointProgressMax ?? 0) > 0 && (x.pointProgressMax ?? 0) <= 500
            const isLocked = (x.offerId ?? '').toLowerCase().includes('locked') 
            const isImpression = (x.offerId ?? '').toLowerCase().includes('impression') || (x.offerId ?? '').toLowerCase().includes('refer_and_earn') || !(x.title ?? '').trim()

            return !isComplete && hasPoints && !isLocked && !isImpression
        })

        if (!activitiesUncompleted.length) {
            this.bot.logger.info(this.bot.isMobile, 'MORE-PROMOTIONS', 'All available items completed (Locked items skipped)')
            return
        }

        this.bot.logger.info(this.bot.isMobile, 'MORE-PROMOTIONS', `Started solving ${activitiesUncompleted.length} available items (including Weekly Side Quests)`)
        await this.solveActivities(activitiesUncompleted, page)
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

                if (type === 'quiz' || type.includes('trivia') || type.includes('poll') || type.includes('survey') || offerId.includes('quiz')) {
                    await this.bot.activities.doQuiz(activity)
                } else if (type === 'findclippy') {
                    await this.bot.activities.doFindClippy(activity as unknown as FindClippyPromotion)
                } else if (name.includes('exploreonbing')) {
                    await this.bot.activities.doSearchOnBing(activity, page)
                } else {
                    // Default fallback: Selesaikan via Hybrid UrlReward solver (mencakup side quests 15 poin, explore cards, promo links, punchcard items)
                    await this.bot.activities.doUrlReward(activity, page, punchCard) 
                }
                
                await this.bot.utils.wait(this.bot.utils.randomDelay(4000, 8000))

            } catch (error) {
                this.bot.logger.error(this.bot.isMobile, 'ACTIVITY', `Error solving "${activity.title}"`)
            }
        }
    }
}