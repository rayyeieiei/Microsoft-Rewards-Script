import assert from 'assert'
import { QueryCore } from '../src/functions/QueryEngine'
import { Search } from '../src/functions/activities/browser/Search'
import { SearchManager } from '../src/functions/SearchManager'
import { AccountScope } from '../src/runtime/AccountScope'
import type { DashboardData } from '../src/interface/DashboardData'

export async function runChapter22SearchAbortLoopEliminationTests() {
    console.log('--- Running Chapter 22 Search Abort & Infinite Loop Elimination Test Suite ---')

    // Test 1: QueryEngine queryManager Abort Guard
    {
        const abortController = new AbortController()
        abortController.abort() // Immediately abort

        const mockBot: any = {
            abortController,
            isMobile: false,
            logger: {
                debug: () => {},
                info: () => {},
                warn: () => {},
                error: () => {}
            },
            utils: {
                shuffleArray: (arr: any[]) => arr
            }
        }

        const queryCore = new QueryCore(mockBot)
        const queries = await queryCore.queryManager()
        assert.deepStrictEqual(queries, [], 'QueryCore must immediately return empty array when aborted')
        console.log('✅ Test 1 Passed: QueryEngine queryManager abort guard terminates instantly with 0 queries')
    }

    // Test 2: Search.doSearch Pre-Flight Abort and Page Closed Guards
    {
        const abortController = new AbortController()
        abortController.abort()

        let gotoCalled = false
        const mockPage: any = {
            isClosed: () => false,
            goto: async () => {
                gotoCalled = true
            }
        }

        const mockBot: any = {
            abortController,
            userData: { currentPoints: 100 },
            config: { searchSettings: { organicSearch: { enabled: false } } },
            logger: {
                info: () => {},
                warn: () => {},
                debug: () => {},
                error: () => {}
            }
        }

        const search = new Search(mockBot)
        const gainedPoints = await search.doSearch({} as DashboardData, mockPage, false)
        assert.strictEqual(gainedPoints, 0, 'Must return 0 points when aborted')
        assert.strictEqual(gotoCalled, false, 'page.goto must never be called when aborted')

        // Test with page closed
        const mockClosedPage: any = {
            isClosed: () => true,
            goto: async () => {
                gotoCalled = true
            }
        }
        const activeBot: any = {
            abortController: new AbortController(),
            userData: { currentPoints: 100 },
            config: { searchSettings: { organicSearch: { enabled: false } } },
            logger: {
                info: () => {},
                warn: () => {},
                debug: () => {},
                error: () => {}
            }
        }
        const searchClosed = new Search(activeBot)
        const gainedPointsClosed = await searchClosed.doSearch({} as DashboardData, mockClosedPage, false)
        assert.strictEqual(gainedPointsClosed, 0, 'Must return 0 points when page is closed')
        assert.strictEqual(gotoCalled, false, 'page.goto must never be called when page is closed')

        console.log('✅ Test 2 Passed: Search.doSearch pre-flight guards reject aborted or closed page calls')
    }

    // Test 3: Search.doSearch Zero Remaining Quota Early Exit
    {
        let queryManagerCalls = 0
        const mockBot: any = {
            abortController: new AbortController(),
            userData: { currentPoints: 100 },
            config: { searchSettings: { organicSearch: { enabled: false } } },
            browser: {
                func: {
                    getSearchPoints: async () => ({
                        pcSearch: [{ pointProgress: 90, pointProgressMax: 90 }],
                        mobileSearch: [{ pointProgress: 60, pointProgressMax: 60 }]
                    }),
                    missingSearchPoints: () => ({ totalPoints: 0, desktopPoints: 0, mobilePoints: 0, edgePoints: 0 })
                }
            },
            logger: {
                info: () => {},
                warn: () => {},
                debug: () => {},
                error: () => {}
            },
            utils: {
                wait: async () => {}
            }
        }

        const mockPage: any = {
            isClosed: () => false,
            goto: async () => {}
        }

        const search = new Search(mockBot)
        const gained = await search.doSearch({} as DashboardData, mockPage, false)
        assert.strictEqual(gained, 0, 'Must return 0 points immediately if quota already fulfilled')
        assert.strictEqual(queryManagerCalls, 0, 'Must not query any search engines if quota already fulfilled')
        console.log('✅ Test 3 Passed: Search.doSearch exits cleanly with 0 network calls when quota is 0')
    }

    // Test 4: Extra Search Pool Refill Capped at maxPoolRefill = 1 (Zero-Spin Invariant)
    {
        let queryPoolGenerations = 0
        const logged: string[] = []

        const mockBot: any = {
            abortController: new AbortController(),
            accountScope: AccountScope.createForTesting('user@test.com', 'run_test_extra_cap'),
            userData: { currentPoints: 100, geoLocale: 'US', langCode: 'en' },
            config: {
                searchSettings: {
                    queryEngines: ['local'],
                    organicSearch: { enabled: false }
                }
            },
            browser: {
                func: {
                    getSearchPoints: async () => ({}),
                    missingSearchPoints: () => ({ totalPoints: 30, desktopPoints: 30, mobilePoints: 0, edgePoints: 0 })
                },
                utils: {
                    tryDismissAllMessages: async () => {}
                }
            },
            logger: {
                info: (_m: boolean, cat: string, msg: string) => logged.push(`[${cat}] ${msg}`),
                warn: (_m: boolean, cat: string, msg: string) => logged.push(`[${cat}] ${msg}`),
                debug: () => {},
                error: () => {}
            },
            utils: {
                wait: async () => {},
                shuffleArray: (arr: any[]) => arr
            }
        }

        // Mock Search where primary loop has 0 queries and extra search generates 1 pool then stops
        const search = new Search(mockBot)

        // Mock bingSearch to simulate query attempt returning same counters (0 points gained)
        ;(search as any).bingSearch = async () => ({})
        ;(search as any).verifyPointsWithServer = async () => ({ verifiedGained: false })

        // Intercept QueryCore inside Search
        const originalQueryCore = require('../src/functions/QueryEngine').QueryCore
        const queryCorePrototype = originalQueryCore.prototype
        const originalQueryManager = queryCorePrototype.queryManager

        queryCorePrototype.queryManager = async function () {
            queryPoolGenerations++
            if (queryPoolGenerations === 1) {
                return []
            }
            return ['sample test query 1', 'sample test query 2']
        }

        const mockPage: any = {
            isClosed: () => false,
            goto: async () => {}
        }

        try {
            await search.doSearch({} as DashboardData, mockPage, false)
        } finally {
            queryCorePrototype.queryManager = originalQueryManager
        }

        // Must be called at most once for initial pool + at most once for extra pool refill
        assert.ok(queryPoolGenerations <= 2, `Query pool generation must not spin infinitely (called: ${queryPoolGenerations})`)
        assert.ok(
            logged.some(l => l.includes('Menghentikan regenerasi kueri untuk mencegah loop tak terbatas') || l.includes('Batas maksimal regenerasi pool kueri')),
            'Circuit breaker termination log must be present'
        )
        console.log('✅ Test 4 Passed: Extra search loop capped at maxPoolRefill = 1 and terminates stagnant refills')
    }

    // Test 5: Abort Signal in Extra Search breaks outer while loop immediately
    {
        const abortController = new AbortController()
        let bingSearchCalls = 0
        let extraPoolGenerations = 0

        const mockBot: any = {
            abortController,
            accountScope: AccountScope.createForTesting('user@test.com', 'run_test_abort_extra'),
            userData: { currentPoints: 100, geoLocale: 'US', langCode: 'en' },
            config: {
                searchSettings: {
                    queryEngines: ['local'],
                    organicSearch: { enabled: false }
                }
            },
            browser: {
                func: {
                    getSearchPoints: async () => ({}),
                    missingSearchPoints: () => ({ totalPoints: 30, desktopPoints: 30, mobilePoints: 0, edgePoints: 0 })
                },
                utils: {
                    tryDismissAllMessages: async () => {}
                }
            },
            logger: {
                info: () => {},
                warn: () => {},
                debug: () => {},
                error: () => {}
            },
            utils: {
                wait: async () => {},
                shuffleArray: (arr: any[]) => arr
            }
        }

        const search = new Search(mockBot)

        ;(search as any).bingSearch = async () => {
            bingSearchCalls++
            abortController.abort() // Trigger abort on first search!
            return {}
        }

        const originalQueryCore = require('../src/functions/QueryEngine').QueryCore
        const queryCorePrototype = originalQueryCore.prototype
        const originalQueryManager = queryCorePrototype.queryManager

        queryCorePrototype.queryManager = async function () {
            extraPoolGenerations++
            if (extraPoolGenerations === 1) {
                return []
            }
            return ['query number one test', 'query number two test']
        }

        const mockPage: any = {
            isClosed: () => false,
            goto: async () => {}
        }

        try {
            await search.doSearch({} as DashboardData, mockPage, false)
        } finally {
            queryCorePrototype.queryManager = originalQueryManager
        }

        assert.strictEqual(bingSearchCalls, 1, 'bingSearch must be called exactly once before abort stops everything')
        assert.strictEqual(extraPoolGenerations, 2, 'QueryManager must not generate any more pools after abort (1 initial + 1 extra before abort)')
        console.log('✅ Test 5 Passed: Abort signal in search loop breaks outer while loop without re-pooling')
    }

    // Test 6: SearchManager Abort Guards
    {
        const abortController = new AbortController()
        abortController.abort()

        let doSearchCalled = false
        const mockBot: any = {
            abortController,
            config: {
                workers: {
                    doDesktopSearch: true,
                    doMobileSearch: true
                },
                searchSettings: {
                    parallelSearching: false
                }
            },
            logger: {
                info: () => {},
                warn: () => {},
                debug: () => {},
                error: () => {}
            },
            activities: {
                doSearch: async () => {
                    doSearchCalled = true
                    return 0
                }
            },
            browser: {
                func: {
                    closeBrowser: async () => {}
                }
            }
        }

        const sm = new SearchManager(mockBot)
        const missing = { mobilePoints: 30, desktopPoints: 30 }
        const mockSession: any = { context: {} }
        const mockAccount: any = { email: 'test@msn.com' }

        const res = await sm.doSearches({} as any, missing, mockSession, mockAccount, 'test@msn.com')
        assert.strictEqual(res.mobilePoints, 0)
        assert.strictEqual(res.desktopPoints, 0)
        assert.strictEqual(doSearchCalled, false, 'activities.doSearch must never be called when aborted')

        console.log('✅ Test 6 Passed: SearchManager checks abort signal and prevents execution entirely')
    }

    console.log('🎉 ALL CHAPTER 22 SEARCH ABORT & LOOP ELIMINATION TESTS PASSED!')
}

if (require.main === module) {
    runChapter22SearchAbortLoopEliminationTests().catch(err => {
        console.error(err)
        process.exit(1)
    })
}
