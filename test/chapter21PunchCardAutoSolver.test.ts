import assert from 'assert'
import { AccountScope } from '../src/runtime/AccountScope'
import {
    Workers,
    type PunchCardStateReader,
    isPurchaseRequirement,
    isAppExclusivePunchCard,
    unlockChild,
    isChildLocked
} from '../src/functions/Workers'
import type { PunchCard, BasePromotion, DashboardData } from '../src/interface/DashboardData'
import { validateConfig, ConfigSchema } from '../src/util/Validator'

export async function runChapter21PunchCardAutoSolverTests() {
    console.log('--- Running Chapter 21 Punch Card Auto-Solver & Sequential Step Solving Test Suite ---')

    // Test 1: Config & Schema validation for default 'auto' mode
    {
        const parsed = ConfigSchema.safeParse({
            baseURL: 'https://rewards.bing.com',
            sessionPath: './sessions',
            headless: true,
            clusters: 1,
            errorDiagnostics: false,
            workers: {
                doDailySet: true,
                doSpecialPromotions: true,
                doMorePromotions: true,
                doPunchCards: true,
                doAppPromotions: true,
                doDesktopSearch: true,
                doMobileSearch: true,
                doDailyCheckIn: true,
                doReadToEarn: true
            },
            searchOnBingLocalQueries: false,
            globalTimeout: 30000,
            searchSettings: {
                scrollRandomResults: false,
                clickRandomResults: false,
                parallelSearching: false,
                queryEngines: ['google'],
                searchResultVisitTime: 5000,
                searchDelay: { min: 1000, max: 2000 },
                readDelay: { min: 1000, max: 2000 }
            },
            debugLogs: false,
            proxy: { queryEngine: false },
            consoleLogFilter: { enabled: false, mode: 'blacklist' },
            webhook: { webhookLogFilter: { enabled: false, mode: 'blacklist' } }
        })

        assert.ok(parsed.success, 'Minimal config must pass validation')
        assert.strictEqual(parsed.data.punchCardExecution?.mode, 'auto')
        assert.strictEqual(parsed.data.punchCardExecution?.maxChildrenPerRun, 8)
        assert.strictEqual(parsed.data.punchCardExecution?.stepDelayMs, 2500)
        assert.strictEqual(parsed.data.punchCardExecution?.autoSolveQuizzes, true)

        const validated = validateConfig(parsed.data)
        assert.strictEqual(validated.punchCardExecution?.mode, 'auto')
        console.log('✅ Test 1 Passed: Mode auto, 8 max children, 2500ms delay default validated successfully')
    }

    // Test 2: Zero-Purchase Invariant helper and runtime rejection
    {
        // Unit assertions on helper
        assert.strictEqual(isPurchaseRequirement('Buy 3 Movies to earn points'), true)
        assert.strictEqual(isPurchaseRequirement('Rent a hit movie today'), true)
        assert.strictEqual(isPurchaseRequirement('Spend $20 on Games'), true)
        assert.strictEqual(isPurchaseRequirement('Donate 1,000 points to charity'), true)
        assert.strictEqual(isPurchaseRequirement('Beli game Xbox'), true)
        assert.strictEqual(isPurchaseRequirement('Five things to explore this October'), false)
        assert.strictEqual(isPurchaseRequirement('Costume season is here'), false)

        const lockedChildTest = { attributes: { isLocked: 'True' } } as unknown as BasePromotion
        assert.strictEqual(isChildLocked(lockedChildTest), true)
        unlockChild(lockedChildTest)
        assert.strictEqual(isChildLocked(lockedChildTest), false)
        assert.strictEqual((lockedChildTest.attributes as any).isLocked, undefined)

        // Runtime test: Purchase card is skipped immediately
        const logged: string[] = []
        let activityCallCount = 0
        const mockScope = AccountScope.createForTesting('user@test.com', 'run_test_purchase')
        const mockWorkers = new Workers({
            isMobile: false,
            userData: { userName: 'testuser', currentPoints: 100, gainedPoints: 0 },
            config: { punchCardExecution: { mode: 'auto', maxChildrenPerRun: 8, stepDelayMs: 10 } },
            accountScope: mockScope,
            logger: {
                info: (_m: boolean, cat: string, msg: string) => logged.push(`[${cat}] ${msg}`),
                warn: (_m: boolean, cat: string, msg: string) => logged.push(`[${cat}] ${msg}`),
                debug: () => {},
                error: () => {}
            },
            utils: { wait: async () => {} },
            activities: {
                doUrlReward: async () => {
                    activityCallCount++
                }
            }
        } as any)

        const purchaseCard: PunchCard = {
            name: 'Buy and Rent Promotion',
            parentPromotion: {
                offerId: 'pc_parent_buy_movie',
                title: 'Buy or Rent 3 Movies to get 2,500 pts',
                complete: false,
                pointProgressMax: 2500
            } as any,
            childPromotions: [
                { offerId: 'child_buy_1', title: 'Buy Movie 1', complete: false } as BasePromotion
            ]
        } as any

        await mockWorkers.doPunchCards({ punchCards: [purchaseCard] } as DashboardData, {} as any)

        assert.strictEqual(activityCallCount, 0, 'Zero activities must execute for purchase/donation cards')
        assert.ok(
            logged.some(l => l.includes('Skipped punchcard') && l.includes('Zero-Purchase Invariant')),
            'Zero-Purchase warning must be logged'
        )
        console.log('✅ Test 2 Passed: Zero-Purchase Invariant correctly rejects purchase/rent/donation offers')
    }

    // Test 3: Multi-Step Sequential Solving (October 5-Step Card Simulation)
    {
        const executedSteps: string[] = []
        const logged: string[] = []
        const mockScope = AccountScope.createForTesting('user@test.com', 'run_test_october')
        const mockWorkers = new Workers({
            isMobile: false,
            userData: { userName: 'testuser', currentPoints: 500, gainedPoints: 0 },
            config: { punchCardExecution: { mode: 'auto', maxChildrenPerRun: 8, stepDelayMs: 10 } },
            accountScope: mockScope,
            logger: {
                info: (_m: boolean, cat: string, msg: string) => logged.push(`[${cat}] ${msg}`),
                warn: (_m: boolean, cat: string, msg: string) => logged.push(`[${cat}] ${msg}`),
                debug: () => {},
                error: () => {}
            },
            utils: { wait: async () => {} },
            activities: {
                doUrlReward: async (promo: BasePromotion) => {
                    executedSteps.push(promo.offerId)
                }
            }
        } as any)

        const childPromos: BasePromotion[] = [
            { offerId: 'step_1_costume', title: 'Costumes season is here', complete: false, pointProgressMax: 10 } as any,
            { offerId: 'step_2_toys', title: 'Toys for everyone', complete: false, pointProgressMax: 10, attributes: { isLocked: 'True' } } as any,
            { offerId: 'step_3_phones', title: 'Top phone deals', complete: false, pointProgressMax: 10, attributes: { isLocked: 'True' } } as any,
            { offerId: 'step_4_deals', title: 'Mega deals', complete: false, pointProgressMax: 10, attributes: { isLocked: 'True' } } as any,
            { offerId: 'step_5_ai', title: 'AI devices', complete: false, pointProgressMax: 10, attributes: { isLocked: 'True' } } as any
        ]

        const octoberCard: PunchCard = {
            name: 'Five things to explore this October',
            parentPromotion: {
                offerId: 'ENWW_pcparent_FY27_BingMonthlyPC_Oct_punchcard',
                title: 'Five things to explore this October: costumes, toys, phones, mega deals, and AI devices',
                complete: false,
                pointProgressMax: 50
            } as any,
            childPromotions: childPromos
        } as any

        // Mock state reader simulating sequential unlocking
        let completedCount = 0
        const mockReader: PunchCardStateReader = {
            async fetchPunchCardSnapshot(_parentOfferId, targetChildOfferId) {
                completedCount++
                const isParentDone = completedCount >= 5
                return {
                    parentOfferId: 'ENWW_pcparent_FY27_BingMonthlyPC_Oct_punchcard',
                    childOfferId: targetChildOfferId,
                    completedChildren: completedCount,
                    totalChildren: 5,
                    actionableNow: isParentDone ? 0 : 1,
                    locked: Math.max(0, 4 - completedCount),
                    futureDated: 0,
                    parentComplete: isParentDone,
                    childComplete: true
                }
            }
        }

        await mockWorkers.doPunchCards({ punchCards: [octoberCard] } as DashboardData, {} as any, mockReader)

        assert.strictEqual(executedSteps.length, 5, 'All 5 sequential steps must be executed in a single run')
        assert.deepStrictEqual(executedSteps, [
            'step_1_costume',
            'step_2_toys',
            'step_3_phones',
            'step_4_deals',
            'step_5_ai'
        ])
        assert.strictEqual(mockWorkers.bot.userData.gainedPoints, 50, 'Parent completion bonus (+50 pts) must be credited')
        assert.ok(
            logged.some(l => l.includes('selesai tuntas (5/5 tasks)! Poin bonus +50 berhasil diamankan')),
            'Completion banner must be logged'
        )
        assert.ok(mockWorkers.completedOffersInSession.has('ENWW_pcparent_FY27_BingMonthlyPC_Oct_punchcard'))
        assert.ok(mockWorkers.completedOffersInSession.has('step_1_costume'))
        assert.ok(mockWorkers.completedOffersInSession.has('step_5_ai'))
        console.log('✅ Test 3 Passed: Multi-step sequential unlock successfully solved all 5 October tasks in 1 run')
    }

    // Test 4: Circuit breaker anti-loop when snapshot remains stagnant
    {
        let executionCount = 0
        const logged: string[] = []
        const mockScope = AccountScope.createForTesting('user@test.com', 'run_test_stagnant')
        const mockWorkers = new Workers({
            isMobile: false,
            userData: { userName: 'testuser', currentPoints: 100, gainedPoints: 0 },
            config: { punchCardExecution: { mode: 'auto', maxChildrenPerRun: 8, stepDelayMs: 10 } },
            accountScope: mockScope,
            logger: {
                info: () => {},
                warn: (_m: boolean, cat: string, msg: string) => logged.push(`[${cat}] ${msg}`),
                debug: () => {},
                error: () => {}
            },
            utils: { wait: async () => {} },
            activities: {
                doUrlReward: async () => {
                    executionCount++
                }
            }
        } as any)

        const stagnantCard: PunchCard = {
            name: 'Stagnant Step Card',
            parentPromotion: { offerId: 'pc_stagnant', complete: false } as any,
            childPromotions: [
                { offerId: 'child_stagnant_1', title: 'Stuck Step', complete: false } as BasePromotion
            ]
        } as any

        // Server returns unverified state each time
        const mockReader: PunchCardStateReader = {
            async fetchPunchCardSnapshot() {
                return {
                    parentOfferId: 'pc_stagnant',
                    childOfferId: 'child_stagnant_1',
                    completedChildren: 0,
                    totalChildren: 1,
                    actionableNow: 1,
                    locked: 0,
                    futureDated: 0,
                    parentComplete: false,
                    childComplete: false
                }
            }
        }

        await mockWorkers.doPunchCards({ punchCards: [stagnantCard] } as DashboardData, {} as any, mockReader)

        assert.strictEqual(executionCount, 2, 'Circuit breaker must cap unverified step attempts at exactly 2')
        assert.ok(
            logged.some(l => l.includes('Circuit breaker triggered')),
            'Circuit breaker triggered warning must be logged'
        )
        console.log('✅ Test 4 Passed: Circuit breaker terminates stagnant loops after 2 attempts')
    }

    // Test 5: Respect future-dated & scheduled task constraints
    {
        let executedSteps: string[] = []
        const logged: string[] = []
        const mockScope = AccountScope.createForTesting('user@test.com', 'run_test_futuredated')
        const mockWorkers = new Workers({
            isMobile: false,
            userData: { userName: 'testuser', currentPoints: 100, gainedPoints: 0 },
            config: { punchCardExecution: { mode: 'auto', maxChildrenPerRun: 8, stepDelayMs: 10 } },
            accountScope: mockScope,
            logger: {
                info: (_m: boolean, cat: string, msg: string) => logged.push(`[${cat}] ${msg}`),
                warn: (_m: boolean, cat: string, msg: string) => logged.push(`[${cat}] ${msg}`),
                debug: () => {},
                error: () => {}
            },
            utils: { wait: async () => {} },
            activities: {
                doUrlReward: async (promo: BasePromotion) => {
                    executedSteps.push(promo.offerId)
                }
            }
        } as any)

        const futureDatedCard: PunchCard = {
            name: 'Weekly Progressive Card',
            parentPromotion: { offerId: 'pc_weekly_progressive', complete: false } as any,
            childPromotions: [
                { offerId: 'step_1_now', title: 'Week 1 Task', complete: false } as unknown as BasePromotion,
                {
                    offerId: 'step_2_future',
                    title: 'Week 2 Task',
                    complete: false,
                    attributes: {
                        isLocked: 'True',
                        isFutureDated: 'True',
                        startDate: '2026-10-15T00:00:00Z',
                        nextEligibleAt: '2026-10-15'
                    }
                } as unknown as BasePromotion
            ]
        } as any

        const mockReader: PunchCardStateReader = {
            async fetchPunchCardSnapshot() {
                return {
                    parentOfferId: 'pc_weekly_progressive',
                    childOfferId: 'step_1_now',
                    completedChildren: 1,
                    totalChildren: 2,
                    actionableNow: 0,
                    locked: 0,
                    futureDated: 1,
                    parentComplete: false,
                    childComplete: true
                }
            }
        }

        await mockWorkers.doPunchCards({ punchCards: [futureDatedCard] } as DashboardData, {} as any, mockReader)

        assert.strictEqual(executedSteps.length, 1, 'Only step 1 should be executed; step 2 must wait for its schedule')
        assert.ok(
            logged.some(l => l.includes('Subsequent step') && l.includes('server-locked')),
            'Scheduled locked step notice must be logged'
        )
        console.log('✅ Test 5 Passed: Future-dated / server-locked steps are safely respected without hanging')
    }

    // Test 6: AbortController abort signal terminates loop immediately
    {
        let executedSteps: string[] = []
        const abortController = new AbortController()
        const mockScope = AccountScope.createForTesting('user@test.com', 'run_test_abort')
        const mockWorkers = new Workers({
            isMobile: false,
            abortController,
            userData: { userName: 'testuser', currentPoints: 100, gainedPoints: 0 },
            config: { punchCardExecution: { mode: 'auto', maxChildrenPerRun: 8, stepDelayMs: 10 } },
            accountScope: mockScope,
            logger: {
                info: () => {},
                warn: () => {},
                debug: () => {},
                error: () => {}
            },
            utils: { wait: async () => {} },
            activities: {
                doUrlReward: async (promo: BasePromotion) => {
                    executedSteps.push(promo.offerId)
                    abortController.abort() // abort on first step
                }
            }
        } as any)

        const multiCard: PunchCard = {
            name: 'Multi Step Card',
            parentPromotion: { offerId: 'pc_multi', complete: false } as any,
            childPromotions: [
                { offerId: 'step_abort_1', title: 'Step 1', complete: false } as BasePromotion,
                { offerId: 'step_abort_2', title: 'Step 2', complete: false } as BasePromotion
            ]
        } as any

        const mockReader: PunchCardStateReader = {
            async fetchPunchCardSnapshot() {
                return {
                    parentOfferId: 'pc_multi',
                    childOfferId: 'step_abort_1',
                    completedChildren: 1,
                    totalChildren: 2,
                    actionableNow: 1,
                    locked: 0,
                    futureDated: 0,
                    parentComplete: false,
                    childComplete: true
                }
            }
        }

        await mockWorkers.doPunchCards({ punchCards: [multiCard] } as DashboardData, {} as any, mockReader)

        assert.strictEqual(executedSteps.length, 1, 'Abort signal must terminate card loop immediately')
        console.log('✅ Test 6 Passed: AbortSignal stops punch card loop immediately')
    }

    // Test 7: App-Only Quests filtering (isAppExclusivePunchCard)
    {
        // Unit assertions
        assert.strictEqual(
            isAppExclusivePunchCard(
                'WW_pcparent_RewardsApp_weekly_Exclusive_Septw4_2026_punchcard',
                'Rewards App weekly Exclusive Quest'
            ),
            true
        )
        assert.strictEqual(isAppExclusivePunchCard('XboxApp_Quests_Weekly', 'Xbox Quests'), true)
        assert.strictEqual(isAppExclusivePunchCard('some_id', 'Install_RewardsApp bonus'), true)
        assert.strictEqual(
            isAppExclusivePunchCard(
                'ENWW_pcparent_FY27_BingMonthlyPC_Oct_punchcard',
                'Five things to explore this October'
            ),
            false
        )

        // Runtime test: App-exclusive punchcard skipped gracefully
        const logged: string[] = []
        let activityCallCount = 0
        const mockScope = AccountScope.createForTesting('user@test.com', 'run_test_app_exclusive')
        const mockWorkers = new Workers({
            isMobile: false,
            userData: { userName: 'testuser', currentPoints: 100, gainedPoints: 0 },
            config: { punchCardExecution: { mode: 'auto', maxChildrenPerRun: 8, stepDelayMs: 10 } },
            accountScope: mockScope,
            logger: {
                info: (_m: boolean, cat: string, msg: string) => logged.push(`[${cat}] ${msg}`),
                warn: (_m: boolean, cat: string, msg: string) => logged.push(`[${cat}] ${msg}`),
                debug: () => {},
                error: () => {}
            },
            utils: { wait: async () => {} },
            activities: {
                doUrlReward: async () => {
                    activityCallCount++
                }
            }
        } as any)

        const appCard: PunchCard = {
            name: 'Rewards App weekly Exclusive Quest',
            parentPromotion: {
                offerId: 'WW_pcparent_RewardsApp_weekly_Exclusive_Septw4_2026_punchcard',
                title: 'Rewards App weekly Exclusive Quest',
                complete: false
            } as any,
            childPromotions: [
                { offerId: 'child_app_1', title: 'App Quest 1', complete: false } as BasePromotion
            ]
        } as any

        await mockWorkers.doPunchCards({ punchCards: [appCard] } as DashboardData, {} as any)

        assert.strictEqual(activityCallCount, 0, 'Zero activities must execute for app-exclusive cards')
        assert.ok(
            logged.some(l => l.includes('Skipping app-exclusive punch card')),
            'App-exclusive punch card skipping must be logged'
        )
        console.log('✅ Test 7 Passed: App-exclusive punch cards are gracefully skipped without execution')
    }

    // Test 8: Native Envelope UI Interaction flow
    {
        const logged: string[] = []
        let visitedUrls: string[] = []
        let closedTabs = 0
        let reloadedPages = 0

        const mockPopupPage: any = {
            evaluate: async () => {},
            close: async () => {
                closedTabs++
            }
        }

        let currentMockUrl = 'https://rewards.bing.com/'
        const mockPage: any = {
            url: () => currentMockUrl,
            goto: async (url: string) => {
                currentMockUrl = url
                visitedUrls.push(url)
            },
            locator: (_sel: string) => ({
                count: async () => 1,
                nth: () => ({
                    isVisible: async () => true,
                    click: async () => {},
                    evaluate: async (fn: any) => fn({ click: () => {} })
                })
            }),
            context: () => ({
                waitForEvent: async (_event: string) => mockPopupPage
            }),
            reload: async () => {
                reloadedPages++
            },
            evaluate: async () => ({
                hasCheckmark: true,
                completedCount: 1
            })
        }

        const mockScope = AccountScope.createForTesting('user@test.com', 'run_test_envelope')
        const mockWorkers = new Workers({
            isMobile: false,
            userData: { userName: 'testuser', currentPoints: 100, gainedPoints: 0 },
            config: { punchCardExecution: { mode: 'auto', maxChildrenPerRun: 8, stepDelayMs: 10 } },
            accountScope: mockScope,
            logger: {
                info: (_m: boolean, cat: string, msg: string) => logged.push(`[${cat}] ${msg}`),
                warn: (_m: boolean, cat: string, msg: string) => logged.push(`[${cat}] ${msg}`),
                debug: () => {},
                error: () => {}
            },
            utils: { wait: async () => {} }
        } as any)

        const testCard: PunchCard = {
            name: 'Five things to explore this October',
            parentPromotion: {
                offerId: 'ENWW_pcparent_FY27_BingMonthlyPC_Oct_punchcard',
                title: 'Five things to explore this October'
            } as any,
            childPromotions: []
        } as any

        const activeChild: BasePromotion = {
            offerId: 'ENWW_pcchild1_urlreward_FY27_BingMonthlyPC_Oct_punchcard',
            title: 'Costume season is here'
        } as any

        const result = await mockWorkers.executePunchCardStepViaEnvelope(
            mockPage,
            'ENWW_pcparent_FY27_BingMonthlyPC_Oct_punchcard',
            activeChild,
            testCard,
            1
        )

        assert.strictEqual(result.usedEnvelope, true, 'Must use envelope flow')
        assert.strictEqual(result.verified, true, 'Must verify step via DOM checkmark')
        assert.ok(
            visitedUrls.some(u => u.includes('rewards.bing.com/dashboard/envelope?id=ENWW_pcparent_FY27_BingMonthlyPC_Oct_punchcard')),
            'Must navigate to envelope page'
        )
        assert.strictEqual(closedTabs, 1, 'Must close popup tab after interaction')
        assert.strictEqual(reloadedPages, 1, 'Must reload envelope page to check completion state')
        console.log('✅ Test 8 Passed: Native Envelope UI interaction successfully opens envelope, handles tab & verifies checkmark')
    }

    console.log('🎉 ALL CHAPTER 21 PUNCH CARD AUTO-SOLVER TESTS PASSED!')
}

if (require.main === module) {
    runChapter21PunchCardAutoSolverTests().catch(err => {
        console.error(err)
        process.exit(1)
    })
}
