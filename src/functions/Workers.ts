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

    // METODE 1: doDailySet
    public async doDailySet(data: DashboardData, page: Page) {
        const todayKey = this.bot.utils.getFormattedDate()
        const todayData = data.dailySetPromotions[todayKey]
        const activitiesUncompleted = todayData?.filter(x => 
            !x?.complete && 
            x.pointProgressMax > 0 && 
            !(x.offerId ?? '').toLowerCase().includes('locked') // SKIP YANG LOCKED
        ) ?? []

        if (activitiesUncompleted.length) {
            this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'Started solving "Daily Set" items')
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

        // FILTER PINTAR: Skip yang sudah selesai, skip yang poinnya 0, dan SKIP YANG "LOCKED" (Level 2)
        const activitiesUncompleted = morePromotions?.filter(x => {
            const isComplete = x.complete
            const hasPoints = x.pointProgressMax > 0
            const isLocked = (x.offerId ?? '').toLowerCase().includes('locked') // Cek keyword 'locked'

            return !isComplete && hasPoints && !isLocked
        }) ?? []

        if (!activitiesUncompleted.length) {
            this.bot.logger.info(this.bot.isMobile, 'MORE-PROMOTIONS', 'All available items completed (Locked items skipped)')
            return
        }

        this.bot.logger.info(this.bot.isMobile, 'MORE-PROMOTIONS', `Started solving ${activitiesUncompleted.length} available items`)
        await this.solveActivities(activitiesUncompleted, page)
    }

    // METODE 3: doAppPromotions (YANG TADI MERAH)
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
        
        // Tambahkan keyword baru di sini biar bot lu gak pilih-pilih
        const supportedKeywords = [
            'ww_banner_optin_2x', // Double points
            'taskbar',            // Quest 100 Poin Windows (image_a3011e)
            'may_highlights',     // Monthly Punch Card
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
                    // Karena ini tipenya hybrid, kita kirim ke solveActivities biar di-handle UrlReward.ts
                    await this.solveActivities([activity as unknown as BasePromotion], page)
                } catch (error) {
                    this.bot.logger.error(this.bot.isMobile, 'SPECIAL-ACTIVITY', `Error solving "${activity.title}"`)
                }
            }
        }
   }

    public async doPunchCards(data: DashboardData, page: Page) {
        const punchCards = data.punchCards?.filter(x => !x.parentPromotion?.complete && (x.parentPromotion?.pointProgressMax ?? 0) > 0) ?? []

        for (const card of punchCards) {
            const activitiesUncompleted = card.childPromotions.filter(x => !x.complete && x.promotionType)
            if (activitiesUncompleted.length) {
                this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `Solving ${activitiesUncompleted.length} items for: ${card.parentPromotion.title}`)
                // PENTING: Kirim 'card' sebagai parameter ke-3
                await this.solveActivities(activitiesUncompleted, page, card) 
            }
        }
    }

    private async solveActivities(activities: BasePromotion[], page: Page, punchCard?: PunchCard) {
        for (const activity of activities) {
            try {
                const type = activity.promotionType?.toLowerCase() ?? ''
                const name = activity.name?.toLowerCase() ?? ''
                
                // FIX KUNING: Sekarang variabel ini dipakai di logger bawahnya
                const isTokenMissing = !this.bot.requestToken || this.bot.rewardsVersion === 'modern'

                // FIX: Tambahkan isTokenMissing di log ini
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
                        await this.bot.activities.doQuiz(activity, page)
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