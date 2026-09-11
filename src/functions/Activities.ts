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
import { ClaimBonusPoints } from './activities/api/ClaimBonusPoints'
import { SearchOnBing } from './activities/browser/SearchOnBing'
import { Search } from './activities/browser/Search'

import { detectOnboarding } from './onboarding/NewAccountOnboardingDetector'
import { NewAccountOnboardingObserver } from './onboarding/NewAccountOnboardingObserver'
import { NewAccountOnboardingVerifier } from './onboarding/NewAccountOnboardingVerifier'
import { OnboardingEvidence, OnboardingVerificationResult } from './onboarding/NewAccountOnboardingTypes'
import { AccountIdentity } from '../runtime/identity/AccountIdentity'

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
        await new WindowsAppRewards(this.bot, this.bot.manualQuestQueue).doWindowsAppRewards(data)

    verifyExistingManualQuests = async (data: DashboardData) =>
        await new WindowsAppRewards(this.bot, this.bot.manualQuestQueue).verifyExistingManualQuests(data)

    verifyAppOnlyRewards = async (data: DashboardData) =>
        await this.verifyExistingManualQuests(data)

    doAppOnlyRewards = async (data: DashboardData, page?: Page) =>
        await new WindowsAppRewards(this.bot, this.bot.manualQuestQueue).doWindowsAppRewards(data, page)

    doWindowsAppRewards = async (data: DashboardData, page?: Page) =>
        await new WindowsAppRewards(this.bot, this.bot.manualQuestQueue).doWindowsAppRewards(data, page)

    doReadToEarn = async () => await new ReadToEarn(this.bot).doReadToEarn()

    doDailyCheckIn = async () => await new DailyCheckIn(this.bot).doDailyCheckIn()

    doClaimBonusPoints = async () => {
        await new ClaimBonusPoints(this.bot).claimBonusPoints()
    }

    detectOnboarding = (data: DashboardData, nowMs: number): OnboardingEvidence =>
        detectOnboarding(data, nowMs)

    observeOnboarding = async (evidence: OnboardingEvidence, identity: AccountIdentity, nowMs?: number): Promise<void> => {
        const observer = new NewAccountOnboardingObserver({
            queue: this.bot.manualQuestQueue,
            mode: this.bot.config.newAccountOnboarding?.mode || 'observe-only',
            logger: {
                info: msg => this.bot.logger.info(this.bot.isMobile, 'ONBOARDING', msg),
                warn: msg => this.bot.logger.warn(this.bot.isMobile, 'ONBOARDING', msg),
                debug: msg => this.bot.logger.debug(this.bot.isMobile, 'ONBOARDING', msg)
            }
        })
        await observer.observe(evidence, identity, nowMs)
    }

    verifyOnboarding = async (params: {
        identity: AccountIdentity
        before: OnboardingEvidence
        afterDashboard: DashboardData | null | undefined
        observedDelta?: number
    }): Promise<OnboardingVerificationResult[]> => {
        const verifier = new NewAccountOnboardingVerifier({
            queue: this.bot.manualQuestQueue,
            logger: {
                info: msg => this.bot.logger.info(this.bot.isMobile, 'ONBOARDING-VERIFY', msg),
                warn: msg => this.bot.logger.warn(this.bot.isMobile, 'ONBOARDING-VERIFY', msg),
                debug: msg => this.bot.logger.debug(this.bot.isMobile, 'ONBOARDING-VERIFY', msg)
            }
        })
        return await verifier.verify(params)
    }
}
