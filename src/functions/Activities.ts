import type { MicrosoftRewardsBot } from '../index'
import type { Page } from 'patchright'

import { DailyCheckIn } from './activities/app/DailyCheckIn'
import { ReadToEarn } from './activities/app/ReadToEarn'
import { AppReward } from './activities/app/AppReward'
import { WindowsAppRewards } from './activities/app/WindowsAppRewards'
import { UrlReward } from './activities/api/UrlReward'
import { Quiz } from './activities/api/Quiz'
import { FindClippy } from './activities/api/FindClippy'
import { DoubleSearchPoints } from './activities/api/DoubleSearchPoints'
import { ClaimBonusPoints } from './activities/api/ClaimBonusPoints' // 👈 SUNTIKAN STAR BONUS 2100
import { SearchOnBing } from './activities/browser/SearchOnBing'
import { Search } from './activities/browser/Search'

import type {
    BasePromotion,
    DashboardData,
    FindClippyPromotion,
    PunchCard,
    PurplePromotionalItem
} from '../interface/DashboardData'
import type { Promotion } from '../interface/AppDashBoardData'

export default class Activities {
    constructor(private bot: MicrosoftRewardsBot) {}

    doSearch = async (data: DashboardData, page: Page, isMobile: boolean) =>
        await new Search(this.bot).doSearch(data, page, isMobile)

    doSearchOnBing = async (promotion: BasePromotion, page: Page) =>
        await new SearchOnBing(this.bot).doSearchOnBing(promotion, page)

    doUrlReward = async (promotion: BasePromotion, page: Page, punchCard?: PunchCard) => {
        await new UrlReward(this.bot).doUrlReward(promotion, page, punchCard)
    }

    doQuiz = async (promotion: BasePromotion) => {
        await new Quiz(this.bot).doQuiz(promotion)
    }

    doFindClippy = async (promotion: FindClippyPromotion) => await new FindClippy(this.bot).doFindClippy(promotion)

    doDoubleSearchPoints = async (promotion: PurplePromotionalItem) =>
        await new DoubleSearchPoints(this.bot).doDoubleSearchPoints(promotion)

    doAppReward = async (promotion: Promotion) => await new AppReward(this.bot).doAppReward(promotion)

    observeAppOnlyRewards = async (data: DashboardData) =>
        await new WindowsAppRewards(this.bot).doWindowsAppRewards(data)

    verifyAppOnlyRewards = async (data: DashboardData) =>
        await new WindowsAppRewards(this.bot).verifyExistingManualQuests(data)

    doAppOnlyRewards = async (data: DashboardData, page?: Page) =>
        await new WindowsAppRewards(this.bot).doWindowsAppRewards(data, page)

    doWindowsAppRewards = async (data: DashboardData, page?: Page) =>
        await new WindowsAppRewards(this.bot).doWindowsAppRewards(data, page)

    doReadToEarn = async () => await new ReadToEarn(this.bot).doReadToEarn()

    doDailyCheckIn = async () => await new DailyCheckIn(this.bot).doDailyCheckIn()

    doClaimBonusPoints = async () => {
        await new ClaimBonusPoints(this.bot).claimBonusPoints()
    }
}
