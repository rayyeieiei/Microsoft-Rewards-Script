import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../index'
import type {
    DashboardData,
    PunchCard,
    BasePromotion,
    FindClippyPromotion,
    PurplePromotionalItem
} from '../interface/DashboardData'
import type { AppDashboardData } from '../interface/AppDashBoardData'

export class Workers {
    public bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    public async doClaimPendingPoints(page: Page) {
        try {
            const selectors = [
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
                        
                        // Abaikan artikel berita MSN / Bing News / Search results / Footer / Feedback
                        const isNewsOrSearchResult = node.closest('#b_results, #ans_nws, .news, .b_algo, #news, .feed-card, [data-bi-id*="news"], article, .b_algo') !== null
                        const isTooLong = rawText.length > 40 // Tombol klaim asli teksnya pendek (< 40 char), bukan kalimat berita
                        
                        // Ekstrak angka poin (contoh: "Ready to claim 50 Claim", "Claim +10", "100 Poin", "50 pts")
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

                    await el.scrollIntoViewIfNeeded().catch(() => {})
                    await el.evaluate((node: HTMLElement) => {
                        node.click()
                        node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                    }).catch(() => {})

                    await page.waitForTimeout(3000)

                    const newBalance = await this.bot.browser.func.getCurrentPoints().catch(() => 0)
                    const gainedPoints = newBalance - oldBalance

                    if (gainedPoints > 0) {
                        this.bot.userData.currentPoints = newBalance
                        this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
                        this.bot.logger.info(this.bot.isMobile, 'DASHBOARD', `✅ Koin nyangkut sukses diamankan! | +${gainedPoints} points | newBalance=${newBalance}`, 'green')
                    } else {
                        this.bot.logger.info(this.bot.isMobile, 'DASHBOARD', `✅ Tombol koin nyangkut diklik.`)
                    }
                    await page.waitForTimeout(1500)
                }
            }
        } catch (error) {
            this.bot.logger.debug(this.bot.isMobile, 'DASHBOARD', 'Tidak ada koin nyangkut yang perlu diklaim.')
        }
    }
    
    public async doDailySet(data: DashboardData, page: Page) {
        const todayKey = this.bot.utils.getFormattedDate()
        let todayData = data.dailySetPromotions?.[todayKey] ?? []

        if (!todayData.length) {
            const allPromos = [
                ...(data.promotionalItems ?? []),
                ...(data.morePromotions ?? []),
                ...(data.morePromotionsWithoutPromotionalItems ?? [])
            ].filter(Boolean)

            todayData = allPromos.filter(x => (x.offerId ?? '').toLowerCase().includes('dailyset')) as any[]
        }

        const activitiesUncompleted = todayData?.filter(x => 
            !x?.complete && x.pointProgressMax > 0 && !(x.offerId ?? '').toLowerCase().includes('locked') 
        ) ?? []

        if (activitiesUncompleted.length) {
            this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', `Started solving ${activitiesUncompleted.length} "Daily Set" items (Dashboard Variant Bypass)`)
            await this.solveActivities(activitiesUncompleted, page)
        }
    }

    public async doMorePromotions(data: DashboardData, page: Page) {
        const morePromotions: BasePromotion[] = [
            ...new Map(
                [...(data.morePromotions ?? []), ...(data.morePromotionsWithoutPromotionalItems ?? [])]
                    .filter(Boolean).map(p => [p.offerId, p as BasePromotion] as const)
            ).values()
        ]

        const activitiesUncompleted = morePromotions?.filter(x => {
            const isComplete = x.complete
            const hasPoints = x.pointProgressMax > 0
            const isLocked = (x.offerId ?? '').toLowerCase().includes('locked') 

            return !isComplete && hasPoints && !isLocked
        }) ?? []

        if (!activitiesUncompleted.length) {
            this.bot.logger.info(this.bot.isMobile, 'MORE-PROMOTIONS', 'All available items completed (Locked items skipped)')
            return
        }

        this.bot.logger.info(this.bot.isMobile, 'MORE-PROMOTIONS', `Started solving ${activitiesUncompleted.length} available items`)
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
       const specialPromotions = [...new Map([...(data.promotionalItems ?? [])].filter(Boolean).map(p => [p.offerId, p as PurplePromotionalItem] as const)).values()]
       
       const supportedKeywords = [
           'ww_banner_optin_2x', 
           'taskbar',            
           'may_highlights',     
           'highlights'
       ]

       const uncompleted = specialPromotions?.filter(x => 
           !x.complete && 
           supportedKeywords.some(key => (x.offerId ?? '').toLowerCase().includes(key))
       ) ?? []

       if (uncompleted.length > 0) {
           this.bot.logger.info(this.bot.isMobile, 'SPECIAL-ACTIVITY', `Found ${uncompleted.length} special items! Solving now...`)
           
           for (const activity of uncompleted) {
               try {
                   await this.solveActivities([activity as unknown as BasePromotion], page)
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
                const type = activity.promotionType?.toLowerCase() ?? ''
                const name = activity.name?.toLowerCase() ?? ''
                
                const isTokenMissing = !this.bot.requestToken || this.bot.rewardsVersion === 'modern'

                this.bot.logger.debug(this.bot.isMobile, 'ACTIVITY', `Processing | title="${activity.title}" | type=${type} | tokenMissing=${isTokenMissing}`)

                switch (type) {
                case 'urlreward':
                        if (name.includes('exploreonbing')) {
                            await this.bot.activities.doSearchOnBing(activity, page)
                        } else {
                            await this.bot.activities.doUrlReward(activity, page, punchCard) 
                        }
                        break
                    case 'quiz':
                        await this.bot.activities.doQuiz(activity)
                        break
                    case 'findclippy':
                        await this.bot.activities.doFindClippy(activity as unknown as FindClippyPromotion)
                        break
                }
                
                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 10000))

            } catch (error) {
                this.bot.logger.error(this.bot.isMobile, 'ACTIVITY', `Error solving "${activity.title}"`)
            }
        }
    }
}