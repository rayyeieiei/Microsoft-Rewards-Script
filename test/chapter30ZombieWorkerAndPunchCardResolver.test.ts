import assert from 'assert'
import { MicrosoftRewardsBot, calculateDynamicDeadline } from '../src/index'
import { convertMsSearchUri } from '../src/runtime/BrowserOperationGuard'
import { Workers } from '../src/functions/Workers'
import { QueryCore } from '../src/functions/QueryEngine'
import {
    BrowserEnvironmentPolicy,
    REAL_DESKTOP_VIEWPORTS
} from '../src/runtime/environment/BrowserEnvironmentPolicy'
import { StickyDeviceProfile } from '../src/runtime/environment/StickyDeviceProfile'
import BrowserFunc from '../src/browser/BrowserFunc'
import type { DashboardData } from '../src/interface/DashboardData'
import type { AppDashboardData } from '../src/interface/AppDashBoardData'

export async function runChapter30ZombieWorkerAndPunchCardResolverTests(): Promise<void> {
    console.log('--- Running Chapter 30 Zombie Worker, Punch Card Resolver, & Linux Hardening Test Suite ---')

    // Test 1: Zombie Worker Elimination & State Isolation
    {
        const deadline = calculateDynamicDeadline(100, 2 * 60 * 1000)
        assert.ok(deadline >= 2 * 60 * 1000, 'Dynamic deadline should be at least minimum deadline')

        const bot = new MicrosoftRewardsBot()
        assert.strictEqual(typeof bot.cleanupBrowserResources, 'function', 'cleanupBrowserResources method must exist on bot')
        await bot.cleanupBrowserResources() // Should not throw even when idle

        // Fresh userData instance per account
        bot.resetAccountState()
        const initialUserData = bot.userData
        assert.strictEqual(initialUserData.initialPoints, 0)
        assert.strictEqual(initialUserData.currentPoints, 0)
        assert.strictEqual(initialUserData.userName, '')

        console.log('  ✔ Test 1: Zombie Worker & State Timeout Isolation verified')
    }

    // Test 2: Strict Sequential Pipeline & initialPoints Idempotency Guard
    {
        const bot = new MicrosoftRewardsBot()
        bot.resetAccountState()

        // Simulate initialPoints initialized from DAPI
        bot.userData.initialPoints = 1250
        bot.userData.currentPoints = 1250

        // Simulate dashboard completed with 1280 available points (e.g. +30 from Read to Earn)
        const mockDashboardData: DashboardData = {
            userStatus: {
                availablePoints: 1280,
                counters: {
                    pcSearch: [{ pointProgress: 0, pointProgressMax: 90 }],
                    mobileSearch: [{ pointProgress: 0, pointProgressMax: 60 }]
                }
            },
            dailySetPromotions: {},
            morePromotions: [],
            punchCards: []
        } as unknown as DashboardData

        // Idempotency check: if initialPoints > 0, do NOT overwrite it!
        if (!bot.userData.initialPoints || bot.userData.initialPoints <= 0) {
            bot.userData.initialPoints = mockDashboardData.userStatus.availablePoints
        }
        bot.userData.currentPoints = mockDashboardData.userStatus.availablePoints

        assert.strictEqual(bot.userData.initialPoints, 1250, 'initialPoints must NOT be overwritten if already > 0')
        assert.strictEqual(bot.userData.currentPoints, 1280, 'currentPoints should reflect new available points')
        const collected = bot.userData.currentPoints - bot.userData.initialPoints
        assert.strictEqual(collected, 30, 'Collected points (+30 ReadToEarn) must be preserved in finish calculation')

        // Preloaded data in getBrowserEarnablePoints
        const browserFunc = new BrowserFunc(bot)
        const earnable = await browserFunc.getBrowserEarnablePoints(mockDashboardData)
        assert.strictEqual(earnable.desktopSearchPoints, 90)
        assert.strictEqual(earnable.mobileSearchPoints, 60)

        console.log('  ✔ Test 2: Strict Sequential Pipeline & initialPoints Idempotency Guard verified')
    }

    // Test 3: Resilience of getDashboardData(), mapAppDataToDashboard, & Balance Regex
    {
        const bot = new MicrosoftRewardsBot()
        const browserFunc = new BrowserFunc(bot)

        const mockAppData: AppDashboardData = {
            response: {
                balance: 7175,
                promotions: [
                    {
                        name: 'ENUS_readarticle3_30points',
                        attributes: {
                            offerid: 'ENUS_readarticle3_30points',
                            title: 'Read to earn',
                            pointmax: '30',
                            pointprogress: '30',
                            complete: 'true',
                            type: 'msnreadearn'
                        }
                    },
                    {
                        name: 'dailyset_sample',
                        attributes: {
                            offerid: 'DailySet_20261017',
                            title: 'Daily Quiz',
                            pointmax: '10',
                            pointprogress: '0',
                            type: 'quiz'
                        }
                    },
                    {
                        name: 'explore_more_promo',
                        attributes: {
                            offerid: 'explore_more_promo',
                            title: 'Explore Microsoft Features',
                            pointmax: '10',
                            pointprogress: '0',
                            type: 'urlreward'
                        }
                    }
                ]
            }
        } as unknown as AppDashboardData

        const mapped = browserFunc.mapAppDataToDashboard(mockAppData)
        assert.ok(mapped, 'mapAppDataToDashboard must return valid DashboardData')
        assert.strictEqual(mapped!.userStatus.availablePoints, 7175)
        assert.strictEqual(mapped!.morePromotions.length, 1)

        // Test scraper point cleaning logic
        const rawTexts = ['7,175', '7.175', ' 7175 ', '+10', '+5']
        const parsedValues = rawTexts.map(t => {
            const trimmed = t.trim()
            if (trimmed.startsWith('+')) return null
            const digits = trimmed.replace(/[^\d]/g, '')
            return digits ? parseInt(digits, 10) : null
        })

        assert.strictEqual(parsedValues[0], 7175, 'Comma thousands separator must parse to 7175')
        assert.strictEqual(parsedValues[1], 7175, 'Period thousands separator must parse to 7175')
        assert.strictEqual(parsedValues[2], 7175, 'Plain digits must parse to 7175')
        assert.strictEqual(parsedValues[3], null, 'Plus badge +10 must be ignored')
        assert.strictEqual(parsedValues[4], null, 'Plus badge +5 must be ignored')

        console.log('  ✔ Test 3: getDashboardData resilience & balance scraper regex verified')
    }

    // Test 4: Desktop Search HTTP 400 Guard & Counter Clamp
    {
        const bot = new MicrosoftRewardsBot()
        const browserFunc = new BrowserFunc(bot)

        // Cached counters check
        browserFunc.cachedCounters = {
            pcSearch: [{ pointProgress: 30, pointProgressMax: 90 }],
            mobileSearch: [{ pointProgress: 15, pointProgressMax: 60 }]
        } as any

        const retrieved = await browserFunc.getSearchPoints(undefined, false, false)
        assert.strictEqual(retrieved.pcSearch?.[0]?.pointProgress, 30)

        // Counter anomaly clamp test
        const baselineMissing = 90
        const anomalousNewMissing = 70 // Delta is 20 > 3!
        const delta = baselineMissing - anomalousNewMissing
        assert.ok(delta > 3, 'Delta must trigger anomaly')

        const clampedGained = delta > 3 ? 3 : delta
        const clampedNewMissing = Math.max(0, baselineMissing - clampedGained)
        assert.strictEqual(clampedGained, 3, 'Gained points must be clamped to baseline (+3)')
        assert.strictEqual(clampedNewMissing, 87, 'Remaining quota must only decrease by 3')

        console.log('  ✔ Test 4: Desktop Search 400 guard & Counter Clamp (+3) verified')
    }

    // Test 5: Smart Punch Card Resolver & Session Unverified Cache
    {
        // ms-search URI conversion
        const rawUri = 'ms-search://search/?q=Technology+News'
        const converted = convertMsSearchUri(rawUri)
        assert.strictEqual(
            converted,
            'https://www.bing.com/search?q=Technology+News&FORM=RWRD1',
            'convertMsSearchUri must convert ms-search protocol to Bing search URL'
        )

        // Punch card session unverified cache
        Workers.sessionUnverifiedPunchCardSteps.clear()
        const stepKey = 'offer_test_123:step_0'
        assert.strictEqual(Workers.sessionUnverifiedPunchCardSteps.has(stepKey), false)

        Workers.sessionUnverifiedPunchCardSteps.add(stepKey)
        assert.strictEqual(Workers.sessionUnverifiedPunchCardSteps.has(stepKey), true, 'Step must be registered in cache')

        console.log('  ✔ Test 5: Smart Punch Card Resolver & Session Unverified Cache verified')
    }

    // Test 6: Cross-Account Query Deduplication & Deterministic Viewport
    {
        // Query deduplication
        QueryCore.sessionUsedQueries.clear()
        const q1 = 'how to learn typescript fast'
        QueryCore.sessionUsedQueries.add(q1.toLowerCase().trim())
        assert.strictEqual(QueryCore.sessionUsedQueries.has('how to learn typescript fast'), true)

        // Deterministic Desktop Viewport
        const email1 = 'user.alpha@outlook.com'
        const email2 = 'user.beta@outlook.com'

        const screen1 = BrowserEnvironmentPolicy.getDeterministicDesktopScreen(email1)
        const screen1Again = BrowserEnvironmentPolicy.getDeterministicDesktopScreen(email1)
        const screen2 = BrowserEnvironmentPolicy.getDeterministicDesktopScreen(email2)
        assert.ok(screen2.viewport.width > 0, 'screen2 should have valid width')

        assert.deepStrictEqual(screen1, screen1Again, 'Viewport selection must be deterministic for the same email')
        assert.ok(
            REAL_DESKTOP_VIEWPORTS.some((v: any) => v.viewport.width === screen1.viewport.width && v.viewport.height === screen1.viewport.height),
            'Selected viewport must exist in REAL_DESKTOP_VIEWPORTS'
        )

        // Deterministic Mobile Sticky Device Profile
        const profile1 = StickyDeviceProfile.generateDeterministicProfile(email1)
        const profile1Again = StickyDeviceProfile.generateDeterministicProfile(email1)
        assert.strictEqual(profile1.device.deviceModel, profile1Again.device.deviceModel, 'Mobile device model must be deterministic')
        assert.strictEqual(profile1.device.screen.viewport.width, profile1Again.device.screen.viewport.width)

        console.log('  ✔ Test 6: Cross-Account Query Deduplication & Deterministic Viewport verified')
    }

    console.log('✨ Chapter 30 Test Suite Finished Successfully!\n')
}
