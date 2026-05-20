import type { MicrosoftRewardsBot } from '../index'
import type { Page } from 'patchright'

import { DailyCheckIn } from './activities/app/DailyCheckIn'
import { ReadToEarn } from './activities/app/ReadToEarn'
import { AppReward } from './activities/app/AppReward'
import { UrlReward } from './activities/api/UrlReward'
import { Quiz } from './activities/api/Quiz'
import { FindClippy } from './activities/api/FindClippy'
import { DoubleSearchPoints } from './activities/api/DoubleSearchPoints'
import { SearchOnBing } from './activities/browser/SearchOnBing'
import { Search } from './activities/browser/Search'

// FIX: Tambahkan PunchCard di baris import ini
import type { BasePromotion, DashboardData, FindClippyPromotion, PurplePromotionalItem, PunchCard } from '../interface/DashboardData'
import type { Promotion } from '../interface/AppDashBoardData'

export default class Activities {
    constructor(private bot: MicrosoftRewardsBot) {}

    doSearch = async (data: DashboardData, page: Page, isMobile: boolean) => await new Search(this.bot).doSearch(data, page, isMobile)
    
    doSearchOnBing = async (promotion: BasePromotion, page: Page) => await new SearchOnBing(this.bot).doSearchOnBing(promotion, page)

    // FIX: Tambahkan punchCard?: PunchCard agar sinkron dengan Workers.ts dan UrlReward.ts
    doUrlReward = async (promotion: BasePromotion, page: Page, punchCard?: PunchCard) => {
        await new UrlReward(this.bot).doUrlReward(promotion, page, punchCard)
    }

    // SINKRONISASI: Menyiapkan quiz untuk masa depan jika ingin dibuat Hybrid juga
    doQuiz = async (promotion: BasePromotion, page: Page) => {
        await new Quiz(this.bot).doQuiz(promotion) 
    }

    doFindClippy = async (promotion: FindClippyPromotion) => await new FindClippy(this.bot).doFindClippy(promotion)

    doDoubleSearchPoints = async (promotion: PurplePromotionalItem) => await new DoubleSearchPoints(this.bot).doDoubleSearchPoints(promotion)

    doAppReward = async (promotion: Promotion) => await new AppReward(this.bot).doAppReward(promotion)

    doReadToEarn = async () => await new ReadToEarn(this.bot).doReadToEarn()

    doDailyCheckIn = async () => await new DailyCheckIn(this.bot).doDailyCheckIn()
}