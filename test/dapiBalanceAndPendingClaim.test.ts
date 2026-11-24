import assert from 'assert'
import { MicrosoftRewardsBot } from '../src/index'
import { DailyCheckIn } from '../src/functions/activities/app/DailyCheckIn'
import { Workers } from '../src/functions/Workers'
import { AccountScope } from '../src/runtime/AccountScope'

export async function runDapiBalanceAndPendingClaimTests() {
    console.log('--- Running DAPI Balance Initialization, Check-In Idempotency, & Pending Coin Claim Test Suite ---')

    // Test 1: MicrosoftRewardsBot currentPoints & initialPoints accessors
    {
        const bot = new MicrosoftRewardsBot()
        assert.strictEqual(bot.currentPoints, 0, 'Initial bot.currentPoints should be 0')
        assert.strictEqual(bot.initialPoints, 0, 'Initial bot.initialPoints should be 0')

        bot.currentPoints = 2139
        assert.strictEqual(bot.userData.currentPoints, 2139, 'Setting bot.currentPoints should update bot.userData.currentPoints')
        assert.strictEqual(bot.currentPoints, 2139, 'bot.currentPoints should return 2139')

        bot.initialPoints = 2129
        assert.strictEqual(bot.userData.initialPoints, 2129, 'Setting bot.initialPoints should update bot.userData.initialPoints')
        assert.strictEqual(bot.initialPoints, 2129, 'bot.initialPoints should return 2129')

        console.log('✅ Test 1 Passed: MicrosoftRewardsBot currentPoints and initialPoints accessors verified')
    }

    // Test 2: Robust point extraction regex for pending coin cards
    {
        const cases = [
            { text: 'Ready to claim 195', expected: '195' },
            { text: 'Ready to claim +195', expected: '195' },
            { text: 'Ready to claim 195 Pts', expected: '195' },
            { text: '+195 claim', expected: '195' },
            { text: '195 koin', expected: '195' },
            { text: 'Siap diklaim 195', expected: '195' },
            { text: 'Claim 195 points', expected: '195' },
            { text: 'Ready to claim\n+195\nClaim', expected: '195' },
            { text: 'Ready to claim\n195\nClaim', expected: '195' }
        ]

        const cardRegex = /ready to claim|\+\d+\s*claim|[0-9]+\s*koin|(?:claim|klaim)\s*\+?\d+|siap diklaim/i

        for (const tc of cases) {
            assert.strictEqual(cardRegex.test(tc.text), true, `Card regex should match text: "${tc.text}"`)
            const ptsMatch =
                tc.text.match(/(?:ready to claim|siap diklaim)[\s\S]*?(\d+)/i) ||
                tc.text.match(/\+(\d+)\s*(?:claim|klaim)/i) ||
                tc.text.match(/(\d+)\s*(?:koin|pts|points)/i) ||
                tc.text.match(/(?:claim|klaim)[\s\S]*?(\d+)/i) ||
                tc.text.match(/(\d+)/)
            const extracted = ptsMatch ? ptsMatch[1] : '0'
            assert.strictEqual(extracted, tc.expected, `Extracted points for "${tc.text.replace(/\n/g, ' ')}" should be "${tc.expected}"`)
        }

        console.log('✅ Test 2 Passed: Flexible regex matching and point extraction verified across all formats')
    }

    // Test 3: DailyCheckIn avoids fake delta (+2139) when oldBalance === 0
    {
        const bot = new MicrosoftRewardsBot()
        bot.accountScope = AccountScope.createForTesting('test@outlook.com', 'run_test_3')
        bot.accessToken = 'mock-dapi-token'
        bot.userData.currentPoints = 0
        bot.userData.initialPoints = 0
        bot.activeAccount = { email: 'test@outlook.com' } as any

        let logMessages: string[] = []
        bot.logger = {
            info: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(msg) },
            warn: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(String(msg)) },
            error: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(String(msg)) },
            debug: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(String(msg)) }
        } as any

        // Mock axios: DAPI returns balance 2139
        bot.axios = {
            request: async (config: any) => {
                if (config.url.includes('/activities')) {
                    return {
                        status: 200,
                        data: {
                            response: {
                                balance: 2139
                            }
                        }
                    }
                }
                // DAPI me/promotions endpoint
                return {
                    status: 200,
                    data: {
                        response: {
                            balance: 2129,
                            promotions: [
                                {
                                    attributes: {
                                        offerid: 'Gamification_Sapphire_DailyCheckIn',
                                        type: 'checkin',
                                        progress: '1',
                                        last_updated: '2026-01-01T00:00:00Z', // Old date, not today
                                        day_2_points: '10'
                                    }
                                }
                            ]
                        }
                    }
                }
            }
        } as any

        const dailyCheckIn = new DailyCheckIn(bot)
        await dailyCheckIn.doDailyCheckIn()

        // Verify gainedPoints is 10, NOT 2139!
        assert.strictEqual(bot.userData.gainedPoints, 10, 'gainedPoints should be 10, not 2139!')
        assert.strictEqual(bot.userData.currentPoints, 2139, 'currentPoints should be 2139')
        assert.strictEqual(bot.userData.initialPoints, 2129, 'initialPoints should be 2129')

        const completedLog = logMessages.find(m => m.includes('Completed Daily Check-In'))
        assert.ok(completedLog, 'Completed Daily Check-In log should be emitted')
        assert.ok(completedLog?.includes('gainedPoints=+10'), `Log should report +10, got: ${completedLog}`)

        console.log('✅ Test 3 Passed: DailyCheckIn prevents abnormal delta points when initial balance is zero')
    }

    // Test 4: DailyCheckIn idempotency check skips already-claimed today
    {
        const bot = new MicrosoftRewardsBot()
        bot.accountScope = AccountScope.createForTesting('test@outlook.com', 'run_test_4')
        bot.accessToken = 'mock-dapi-token'
        bot.userData.currentPoints = 2139
        bot.userData.initialPoints = 2129
        bot.activeAccount = { email: 'test@outlook.com' } as any

        let logMessages: string[] = []
        bot.logger = {
            info: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(msg) },
            warn: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(String(msg)) },
            error: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(String(msg)) },
            debug: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(String(msg)) }
        } as any

        const now = new Date()
        let submitCalled = false

        bot.axios = {
            request: async (config: any) => {
                if (config.url.includes('/activities')) {
                    submitCalled = true
                    return { status: 200, data: {} }
                }
                return {
                    status: 200,
                    data: {
                        response: {
                            balance: 2139,
                            promotions: [
                                {
                                    attributes: {
                                        offerid: 'Gamification_Sapphire_DailyCheckIn',
                                        type: 'checkin',
                                        last_updated: now.toISOString(), // Claimed today!
                                        day_2_points: '10'
                                    }
                                }
                            ]
                        }
                    }
                }
            }
        } as any

        const dailyCheckIn = new DailyCheckIn(bot)
        await dailyCheckIn.doDailyCheckIn()

        assert.strictEqual(submitCalled, false, 'submitDaily should NOT be called if already claimed today')
        const skipLog = logMessages.find(m => m.includes('[DAILY-CHECK-IN] Daily Check-In untuk hari ini sudah selesai diklaim. Melewati.'))
        assert.ok(skipLog, 'Skip log for already claimed today must be emitted')

        console.log('✅ Test 4 Passed: DailyCheckIn idempotency pre-check cleanly skips already claimed activity')
    }

    // Test 5: Workers multi-tier claim fallback & robust locator
    {
        const bot = new MicrosoftRewardsBot()
        bot.userData.currentPoints = 1000
        let logMessages: string[] = []
        bot.logger = {
            info: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(msg) },
            warn: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(String(msg)) },
            error: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(String(msg)) },
            debug: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(String(msg)) }
        } as any

        let clickedTier3 = false
        let cardVisible = true

        const mockCard = {
            isVisible: async () => cardVisible,
            innerText: async () => 'Ready to claim 195',
            locator: (selector: string) => {
                return {
                    filter: (_opt: any) => ({
                        first: () => ({
                            isVisible: async () => false, // Tier 1 not found
                            click: async () => {}
                        })
                    }),
                    first: () => ({
                        isVisible: async () => false, // Tier 2 not found
                        click: async () => {}
                    })
                }
            },
            click: async (_opts: any) => {
                clickedTier3 = true
                cardVisible = false
            }
        }

        const mockPage = {
            isClosed: () => false,
            locator: (_sel: string) => ({
                filter: (_opt: any) => ({
                    count: async () => 1,
                    nth: (_i: number) => mockCard
                }),
                count: async () => 0,
                first: () => ({
                    isVisible: async () => false,
                    click: async () => {}
                })
            })
        } as any

        bot.browser = {
            func: {
                getCurrentPoints: async () => 1195
            }
        } as any

        bot.utils = {
            wait: async (_ms: number) => {}
        } as any

        const workers = new Workers(bot)
        await workers.doClaimPendingPoints(mockPage)

        assert.strictEqual(clickedTier3, true, 'Tier 3 container click should be executed as fallback')
        assert.strictEqual(bot.userData.currentPoints, 1195, 'Account balance should be updated to 1195')
        assert.strictEqual(bot.userData.gainedPoints, 195, 'gainedPoints should be +195')

        const detectedLog = logMessages.find(m => m.includes('Terdeteksi koin pending: 195 Pts'))
        assert.ok(detectedLog, `Log should detect 195 Pts, found: ${logMessages.join(', ')}`)

        console.log('✅ Test 5 Passed: Workers pending coin multi-tier locator and container click verified')
    }

    // Test 6: Workers in-browser DOM evaluate and multi-claim verification
    {
        const bot = new MicrosoftRewardsBot()
        bot.userData.currentPoints = 3000
        let logMessages: string[] = []
        bot.logger = {
            info: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(msg) },
            warn: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(String(msg)) },
            error: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(String(msg)) },
            debug: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(String(msg)) }
        } as any

        let evaluateCalled = false
        const mockPage = {
            isClosed: () => false,
            url: () => 'https://rewards.bing.com/earn',
            evaluate: async (fn: any) => {
                evaluateCalled = true
                return { count: 2, label: 'Ready to claim, Klaim +10' }
            },
            locator: (_sel: string) => ({
                filter: (_opt: any) => ({
                    count: async () => 0,
                    nth: () => ({})
                }),
                count: async () => 0,
                first: () => ({
                    isVisible: async () => false,
                    click: async () => {}
                })
            })
        } as any

        bot.browser = {
            func: {
                getCurrentPoints: async () => 3050
            }
        } as any

        bot.utils = {
            wait: async (_ms: number) => {}
        } as any

        const workers = new Workers(bot)
        await workers.doClaimPendingPoints(mockPage)

        assert.strictEqual(evaluateCalled, true, 'page.evaluate should be called for DOM scan')
        assert.strictEqual(bot.userData.currentPoints, 3050, 'Account balance should be updated to 3050')
        assert.strictEqual(bot.userData.gainedPoints, 50, 'gainedPoints should be +50')

        const detectedLog = logMessages.find(m => m.includes('Koin nyangkut terdeteksi ("Ready to claim, Klaim +10")'))
        assert.ok(detectedLog, `Log should detect labels, found: ${logMessages.join(', ')}`)

        console.log('✅ Test 6 Passed: Workers in-browser DOM evaluate and multi-claim verified')
    }

    // Test 7: Detailed discovery of pending points (reads pending points in detail first before claiming)
    {
        const bot = new MicrosoftRewardsBot()
        bot.userData.currentPoints = 2000
        let logMessages: string[] = []
        bot.logger = {
            info: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(msg) },
            warn: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(String(msg)) },
            error: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(String(msg)) },
            debug: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(String(msg)) }
        } as any

        let evaluateCalled = false
        const mockPage = {
            isClosed: () => false,
            url: () => 'https://rewards.bing.com/earn',
            evaluate: async (fn: any) => {
                evaluateCalled = true
                return {
                    items: [
                        {
                            title: 'Streak Bonus Activity',
                            points: 12,
                            actionText: 'Claim >',
                            source: 'Dashboard Card'
                        }
                    ],
                    count: 1,
                    label: 'Claim >'
                }
            },
            locator: (_sel: string) => ({
                filter: (_opt: any) => ({
                    count: async () => 0,
                    nth: () => ({})
                }),
                count: async () => 0,
                first: () => ({
                    isVisible: async () => false,
                    click: async () => {}
                })
            })
        } as any

        bot.browser = {
            func: {
                getCurrentPoints: async () => 2012
            }
        } as any

        bot.utils = {
            wait: async (_ms: number) => {}
        } as any

        const workers = new Workers(bot)
        await workers.doClaimPendingPoints(mockPage)

        assert.strictEqual(evaluateCalled, true, 'page.evaluate should be called for DOM scan')
        assert.strictEqual(bot.userData.currentPoints, 2012, 'Account balance should be updated to 2012')
        assert.strictEqual(bot.userData.gainedPoints, 12, 'gainedPoints should be +12')

        const detailedScanLog = logMessages.find(m => m.includes('📌 Ditemukan 1 item pending point terperinci:'))
        assert.ok(detailedScanLog, `Log should detect detailed scan item list, found: ${logMessages.join(', ')}`)

        const itemLog = logMessages.find(m => m.includes('"Streak Bonus Activity" | Poin: 12 Pts | Status/Aksi: "Claim >"'))
        assert.ok(itemLog, `Log should detail the specific item, found: ${logMessages.join(', ')}`)

        console.log('✅ Test 7 Passed: Detailed pending points discovery and precision claim execution verified')
    }

    // Test 8: Immediate pass-through when claim points is 0 (no stuck / no retry)
    {
        const bot = new MicrosoftRewardsBot()
        bot.userData.currentPoints = 3210
        let logMessages: string[] = []
        bot.logger = {
            info: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(msg) },
            warn: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(String(msg)) },
            error: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(String(msg)) },
            debug: (_isMobile: any, _tag: string, msg: string) => { logMessages.push(String(msg)) }
        } as any

        const mockPage = {
            isClosed: () => false,
            url: () => 'https://rewards.bing.com/earn',
            evaluate: async (fn: any) => ({
                items: [],
                count: 0,
                label: ''
            }),
            locator: (_sel: string) => ({
                filter: (_opt: any) => ({
                    count: async () => 0,
                    nth: () => ({})
                }),
                count: async () => 0,
                first: () => ({
                    isVisible: async () => false,
                    click: async () => {}
                })
            })
        } as any

        const workers = new Workers(bot)
        await workers.doClaimPendingPoints(mockPage)

        const zeroPassLog = logMessages.find(m => m.includes('Tidak ada koin pending yang nyangkut (0 Pts). Langsung lanjut ke task berikutnya.'))
        assert.ok(zeroPassLog, `Should immediately proceed when 0 Pts, found: ${logMessages.join(', ')}`)
        assert.strictEqual(logMessages.filter(m => m.includes('CLAIM-RETRY')).length, 0, 'Must NOT trigger any retry loop')

        console.log('✅ Test 8 Passed: 0 Pts pending claim cleanly and immediately advances to next task')
    }

    console.log('🎉 ALL 8 DAPI BALANCE & PENDING CLAIM TESTS PASSED SUCCESSFULLY!\n')
}
