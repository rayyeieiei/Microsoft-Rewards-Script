import type { Page } from 'patchright'
import type { DashboardData } from '../../../interface/DashboardData'
import { Workers } from '../../Workers'
import { AppOnlyQuestObserver } from '../appOnly/AppOnlyQuestObserver'
import { AppOnlyQuestVerifier } from '../appOnly/AppOnlyQuestVerifier'
import { AppOnlyClassificationInput } from '../appOnly/AppOnlyQuestClassifier'
import { AppOnlyDecision, AppOnlyPolicy, ManualQuestRecord, redactAccountKey } from '../appOnly/AppOnlyTypes'
import { logEmitter } from '../../../util/DashboardServer'

export interface WindowsAppRewardResult {
    status: 'manual-required' | 'skipped' | 'already-complete'
    offerId: string
    reason: string
}

/**
 * WindowsAppRewards (Refactored to Observer Flow)
 *
 * NOTE: Live DAPI POST and Playwright/WebView2 DOM spoofing have been completely removed.
 * This class now acts as a non-blocking observer that classifies App-Only quests,
 * applies configured policy (skip / notify / manual-handoff), maintains a negative-capability cache,
 * and verifies completion passively via server dashboard data.
 */
export class WindowsAppRewards extends Workers {
    private observer: AppOnlyQuestObserver
    private verifier: AppOnlyQuestVerifier

    constructor(bot: any) {
        super(bot)
        this.observer = new AppOnlyQuestObserver()
        this.verifier = new AppOnlyQuestVerifier()
    }

    /**
     * Backward-compatible entry point for observing App-Only quests.
     * Guaranteed non-blocking and safe for parallel searching.
     */
    public async doWindowsAppRewards(data: DashboardData, page?: Page): Promise<WindowsAppRewardResult[]> {
        const rawEmail = this.bot.activeAccount?.email || 'unknown'
        const safeAccountKey = redactAccountKey(rawEmail)

        this.bot.logger.debug(
            this.bot.isMobile,
            'APP-ONLY',
            `[WINDOWS-APP] Processing App-Only quest observer for: ${safeAccountKey}`
        )

        // Determine effective policy: per-account override > global config > default 'skip'
        const accountPolicy = (this.bot.activeAccount as any)?.appOnlyPolicy as AppOnlyPolicy | undefined
        const globalPolicy = this.bot.config.appOnlyRewards?.defaultPolicy as AppOnlyPolicy | undefined
        const effectivePolicy: AppOnlyPolicy = accountPolicy || globalPolicy || 'skip'
        const cacheTtlHours = this.bot.config.appOnlyRewards?.cacheTtlHours ?? 24

        // 1. Extract promotions from dashboard
        let rawPromos = this.extractAppOnlyPromotions(data)

        // Optional desktop catalog discovery if initial mobile dashboard stripped promos
        if (!rawPromos.length) {
            try {
                const activeCookies = (this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop) || []
                const cookieHeader = this.bot.browser.func.buildCookieHeader(activeCookies, [
                    'bing.com',
                    'live.com',
                    'microsoftonline.com'
                ])

                const desktopRes = await this.bot.axios.request({
                    url: 'https://rewards.bing.com/api/getuserinfo?type=1',
                    method: 'GET',
                    headers: {
                        'User-Agent':
                            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
                        'sec-ch-ua-mobile': '?0',
                        'sec-ch-ua-platform': '"Windows"',
                        Cookie: cookieHeader,
                        Referer: 'https://rewards.bing.com/',
                        Origin: 'https://rewards.bing.com'
                    },
                    timeout: 8000
                })

                if (desktopRes.data) {
                    const freshAppPromos = this.extractAppOnlyPromotions(desktopRes.data)
                    if (freshAppPromos.length) {
                        rawPromos = freshAppPromos
                    }
                }
            } catch {
                // Fail-open: discovery network error must never halt flow
            }
        }

        // Map promotions to pure classification inputs
        const classificationInputs: AppOnlyClassificationInput[] = rawPromos.map((p: any) => ({
            accountKey: safeAccountKey,
            offerId: p.offerId || '',
            title: p.title || '',
            description: p.description || '',
            destinationUrl: p.destinationUrl || '',
            expectedPoints: Number(p.pointProgressMax ?? p.pointProgress ?? 10),
            complete: p.complete,
            pointProgress: p.pointProgress,
            pointProgressMax: p.pointProgressMax,
            isLocked: p.isLocked,
            attributes: p.attributes,
            exclusiveLockedFeature: p.exclusiveLockedFeature,
            exclusiveLockedFeatureStatus: p.exclusiveLockedFeatureStatus,
            exclusiveLockedFeatureCategory: p.exclusiveLockedFeatureCategory,
            promotionType: p.promotionType,
            promotionSubtype: p.promotionSubtype
        }))

        // 2. Passive verification of any previously queued manual quests
        try {
            const currentPoints = Number(this.bot.userData?.currentPoints ?? 0)
            await this.verifier.verify(classificationInputs, {
                accountKey: safeAccountKey,
                currentBalance: currentPoints,
                logger: {
                    info: msg => this.bot.logger.info(this.bot.isMobile, 'APP-ONLY-VERIFY', msg),
                    warn: msg => this.bot.logger.warn(this.bot.isMobile, 'APP-ONLY-VERIFY', msg),
                    debug: msg => this.bot.logger.debug(this.bot.isMobile, 'APP-ONLY-VERIFY', msg)
                }
            })
        } catch {
            // Passive verifier errors must fail-open
        }

        // 3. Observe promotions and execute policy (non-blocking)
        const decisions: AppOnlyDecision[] = await this.observer.observe(classificationInputs, {
            policy: effectivePolicy,
            cacheTtlHours,
            onNotification: async quest => {
                const logMsg = `[APP-ONLY-NOTIFY] Account=${safeAccountKey} | Quest="${quest.title}" (+${quest.expectedPoints} Pts) is App-Only locked`
                this.bot.logger.info(this.bot.isMobile, 'APP-ONLY', logMsg, 'yellow')
                logEmitter.emit('log', logMsg)
            },
            onManualRequired: async (record: ManualQuestRecord) => {
                const logMsg = `[APP-ONLY-MANUAL] Account=${safeAccountKey} | Queued="${record.title}" (+${record.expectedPoints} Pts) for official app manual completion`
                this.bot.logger.info(this.bot.isMobile, 'APP-ONLY', logMsg, 'cyan')
                logEmitter.emit('log', logMsg)
                logEmitter.emit('app-only-manual-required', {
                    type: 'app-only-manual-required',
                    accountKey: safeAccountKey,
                    offerId: record.offerId,
                    title: record.title,
                    expectedPoints: record.expectedPoints,
                    expiresAt: record.expiresAt,
                    state: 'manual-required'
                })
            },
            logger: {
                info: msg => this.bot.logger.info(this.bot.isMobile, 'APP-ONLY', msg),
                warn: msg => this.bot.logger.warn(this.bot.isMobile, 'APP-ONLY', msg),
                debug: msg => this.bot.logger.debug(this.bot.isMobile, 'APP-ONLY', msg)
            }
        })

        // Map decisions to backward-compatible results
        return decisions.map((d): WindowsAppRewardResult => {
            if (d.quest.complete) {
                return {
                    status: 'already-complete',
                    offerId: d.quest.offerId,
                    reason: d.reason
                }
            }
            if (d.action === 'queue-manual') {
                return {
                    status: 'manual-required',
                    offerId: d.quest.offerId,
                    reason: d.reason
                }
            }
            return {
                status: 'skipped',
                offerId: d.quest.offerId,
                reason: d.reason
            }
        })
    }
}
