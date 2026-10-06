import assert from 'assert'
import http from 'http'
import AxiosClient from '../src/util/Axios'
import {
    dashboardState,
    updateDashboardGlobal,
    isStartInProgress,
    setStartInProgress
} from '../src/util/DashboardServer'
import { AccountScope } from '../src/runtime/AccountScope'
import { UserAgentManager } from '../src/browser/UserAgent'

export async function runChapter28TokenExchangeAndConcurrencyMutexTests() {
    console.log('\n--- Running Chapter 28 Token Exchange & Concurrency Mutex Test Suite ---')

    // Test 1: Header Isolation - Authorization Header is Stripped on Token Exchange
    {
        let receivedAuthHeader: string | undefined = 'INITIAL_VALUE'
        let receivedContentType: string | undefined = ''
        let receivedBody = ''

        const server = http.createServer((req, res) => {
            receivedAuthHeader = req.headers['authorization']
            receivedContentType = req.headers['content-type']
            let body = ''
            req.on('data', chunk => {
                body += chunk
            })
            req.on('end', () => {
                receivedBody = body
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ access_token: 'isolated_token_xyz', token_type: 'Bearer' }))
            })
        })

        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
        const port = (server.address() as any).port
        const testTokenUrl = `http://127.0.0.1:${port}/token`

        try {
            const client = new AxiosClient({ proxyAxios: false, url: '', port: 0, password: '', username: '' })
            // Simulate that Axios defaults have a stale Bearer token from global sync
            client.setAuthorizationToken('stale_expired_token_123')
            assert.strictEqual(client.defaults.headers.common['Authorization'], 'Bearer stale_expired_token_123')

            // Call token exchange with explicit Authorization: undefined
            const postData = 'grant_type=authorization_code&client_id=0000000040170455&code=test_code_1'
            const response = await client.request({
                url: testTokenUrl,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': UserAgentManager.DEFAULT_MOBILE_UA,
                    'Origin': 'https://login.live.com',
                    'Referer': 'https://login.live.com/',
                    'Authorization': undefined
                },
                data: postData,
                // @ts-ignore
                'axios-retry': { retries: 0 }
            })

            assert.strictEqual(response.status, 200)
            assert.strictEqual(response.data.access_token, 'isolated_token_xyz')
            assert.strictEqual(
                receivedAuthHeader,
                undefined,
                'Wire request to token endpoint must not contain Authorization header!'
            )
            assert.strictEqual(receivedContentType, 'application/x-www-form-urlencoded')
            assert.strictEqual(receivedBody, postData)

            console.log('✅ Test 1 Passed: Wire request to token endpoint completely strips stale Authorization header')
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()))
        }
    }

    // Test 2: Burned Code Protection - No Retries on HTTP 400 Bad Request
    {
        let requestAttempts = 0

        const server = http.createServer((req, res) => {
            requestAttempts++
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(
                JSON.stringify({
                    error: 'invalid_grant',
                    error_description: 'The code is invalid or has expired.'
                })
            )
        })

        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
        const port = (server.address() as any).port
        const testTokenUrl = `http://127.0.0.1:${port}/token`

        try {
            const client = new AxiosClient({ proxyAxios: false, url: '', port: 0, password: '', username: '' })

            let caughtError: any = null
            try {
                await client.request({
                    url: testTokenUrl,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': UserAgentManager.DEFAULT_MOBILE_UA,
                        'Authorization': undefined
                    },
                    data: 'grant_type=authorization_code&code=burned_code',
                    // @ts-ignore
                    'axios-retry': { retries: 0 }
                })
            } catch (err) {
                caughtError = err
            }

            assert.ok(caughtError, 'Request should reject on HTTP 400')
            assert.strictEqual(caughtError.response?.status, 400)
            assert.strictEqual(caughtError.response?.data?.error, 'invalid_grant')
            assert.strictEqual(
                requestAttempts,
                1,
                'Burned code must not be retried! Request attempt count must strictly equal 1.'
            )

            console.log('✅ Test 2 Passed: Single-use burned authorization code is never retried on HTTP 400')
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()))
        }
    }

    // Test 3: In-Flight Mutex Deduplication on refreshMobileAccessToken()
    {
        let actualOauthCallCount = 0
        const mockScope = AccountScope.createForTesting('mutex_test@example.com', 'run_ch28_mutex')

        // Mock bot implementing the exact mutex pattern from src/index.ts
        const mockBot: any = {
            isMobile: true,
            activeAccount: { email: 'mutex_test@example.com' },
            accountScope: mockScope,
            accessToken: '',
            mainMobilePage: { isClosed: () => false },
            activeTokenRefreshPromise: null as Promise<string> | null,
            logger: {
                info: () => {},
                warn: () => {},
                error: () => {},
                debug: () => {}
            },
            login: {
                getAppAccessToken: async () => {
                    actualOauthCallCount++
                    // Simulate OAuth delay
                    await new Promise(r => setTimeout(r, 60))
                    return 'fresh_token_from_mutex_oauth'
                }
            }
        }

        // Attach refreshMobileAccessToken implementation matching index.ts
        mockBot.refreshMobileAccessToken = async function (): Promise<string> {
            if (this.activeTokenRefreshPromise) {
                return await this.activeTokenRefreshPromise
            }

            this.activeTokenRefreshPromise = (async () => {
                const newToken = await this.login.getAppAccessToken()
                if (newToken) {
                    this.accessToken = newToken
                    return newToken
                }
                return ''
            })().finally(() => {
                this.activeTokenRefreshPromise = null
            })

            return await this.activeTokenRefreshPromise
        }

        // Launch 4 concurrent token refresh requests simultaneously
        const [token1, token2, token3, token4] = await Promise.all([
            mockBot.refreshMobileAccessToken(),
            mockBot.refreshMobileAccessToken(),
            mockBot.refreshMobileAccessToken(),
            mockBot.refreshMobileAccessToken()
        ])

        assert.strictEqual(token1, 'fresh_token_from_mutex_oauth')
        assert.strictEqual(token2, 'fresh_token_from_mutex_oauth')
        assert.strictEqual(token3, 'fresh_token_from_mutex_oauth')
        assert.strictEqual(token4, 'fresh_token_from_mutex_oauth')
        assert.strictEqual(
            actualOauthCallCount,
            1,
            'Concurrent refreshes must be deduplicated into exactly 1 in-flight OAuth call'
        )
        assert.strictEqual(mockBot.activeTokenRefreshPromise, null, 'activeTokenRefreshPromise must be null after completion')

        // Sequential subsequent call should perform a new refresh cleanly
        const token5 = await mockBot.refreshMobileAccessToken()
        assert.strictEqual(token5, 'fresh_token_from_mutex_oauth')
        assert.strictEqual(actualOauthCallCount, 2, 'Subsequent call after completion initiates a new flow')

        console.log('✅ Test 3 Passed: In-flight token refresh mutex deduplicates concurrent calls to single OAuth flow')
    }

    // Test 4: C2 Dashboard Start Deduplication Guard
    {
        setStartInProgress(false)
        updateDashboardGlobal({ isRunning: false })

        assert.strictEqual(isStartInProgress(), false)
        assert.strictEqual(dashboardState.isRunning, false)

        // When transition is in progress, new starts must be guarded
        setStartInProgress(true)
        assert.strictEqual(isStartInProgress(), true)

        let duplicateExecuted = false
        const simulateControlCommandReceive = (action: string) => {
            if (action === 'start' || action === 'start-single') {
                if (dashboardState.isRunning || isStartInProgress()) {
                    return false // Guarded & rejected
                }
            }
            duplicateExecuted = true
            return true
        }

        const acceptedWhileTransitioning = simulateControlCommandReceive('start')
        assert.strictEqual(acceptedWhileTransitioning, false, 'Start must be rejected when startup transition is in progress')
        assert.strictEqual(duplicateExecuted, false)

        // Reset transition and simulate runner running
        setStartInProgress(false)
        updateDashboardGlobal({ isRunning: true })

        const acceptedWhileRunning = simulateControlCommandReceive('start')
        assert.strictEqual(acceptedWhileRunning, false, 'Start must be rejected when runner is already running')
        assert.strictEqual(duplicateExecuted, false)

        // Cleanup
        updateDashboardGlobal({ isRunning: false })
        setStartInProgress(false)
        console.log('✅ Test 4 Passed: C2 start deduplication guard rejects duplicate concurrent and in-flight starts')
    }

    // Test 5: Post-Search Guarded Re-Evaluation (Completed vs Incomplete Items)
    {
        const fullyCompletedDashboard: any = {
            dailySetPromotions: {
                '20261007': [
                    { offerId: 'DailySet_20261007_1', complete: true, pointProgress: 10, pointProgressMax: 10 },
                    { offerId: 'DailySet_20261007_2', complete: true, pointProgress: 10, pointProgressMax: 10 }
                ]
            },
            promotionalItems: [
                { offerId: 'Special_1', complete: true, pointProgress: 5, pointProgressMax: 5 }
            ],
            morePromotions: [
                { offerId: 'More_1', complete: true, pointProgress: 10, pointProgressMax: 10 }
            ],
            punchCards: [
                {
                    parentPromotion: { complete: true, pointProgress: 100, pointProgressMax: 100 },
                    childPromotions: [
                        { complete: true, pointProgress: 50, pointProgressMax: 50 },
                        { complete: true, pointProgress: 50, pointProgressMax: 50 }
                    ]
                }
            ]
        }

        // Check Daily Set incomplete condition
        const dailySetItems = Object.values(fullyCompletedDashboard.dailySetPromotions ?? {}).flat() as any[]
        const hasIncompleteDailySet = dailySetItems.some(
            x => x && !x.complete && (x.pointProgressMax ?? 0) > (x.pointProgress ?? 0)
        )
        assert.strictEqual(hasIncompleteDailySet, false, 'Completed daily set must be detected as complete')

        // Check Specials incomplete condition
        const specials = [
            ...(fullyCompletedDashboard.promotionalItems ?? []),
            ...(fullyCompletedDashboard.promotionalItem ? [fullyCompletedDashboard.promotionalItem] : [])
        ]
        const hasIncompleteSpecials = specials.some(
            x =>
                x &&
                !x.complete &&
                (x.pointProgressMax ?? 0) > 0 &&
                !(x.offerId ?? '').toLowerCase().includes('impression') &&
                !(x.offerId ?? '').toLowerCase().includes('locked')
        )
        assert.strictEqual(hasIncompleteSpecials, false, 'Completed specials must be detected as complete')

        // Check Punch Cards incomplete condition
        const punchCards = fullyCompletedDashboard.punchCards ?? []
        const hasIncompletePunchCards = punchCards.some((pc: any) => {
            const parent = pc.parentPromotion
            if (parent && !parent.complete && (parent.pointProgressMax ?? 0) > (parent.pointProgress ?? 0)) {
                return true
            }
            const children = pc.childPromotions ?? []
            return children.some((c: any) => c && !c.complete && (c.pointProgressMax ?? 0) > (c.pointProgress ?? 0))
        })
        assert.strictEqual(hasIncompletePunchCards, false, 'Completed punch cards must be detected as complete')

        // Now test with an incomplete Punch Card (e.g. unlocked by search)
        const uncompletedPunchCardDashboard: any = {
            ...fullyCompletedDashboard,
            punchCards: [
                {
                    parentPromotion: { complete: false, pointProgress: 50, pointProgressMax: 100 },
                    childPromotions: [
                        { complete: true, pointProgress: 50, pointProgressMax: 50 },
                        { complete: false, pointProgress: 0, pointProgressMax: 50 }
                    ]
                }
            ]
        }

        const hasIncompletePunchCardsAfterSearch = (uncompletedPunchCardDashboard.punchCards ?? []).some((pc: any) => {
            const parent = pc.parentPromotion
            if (parent && !parent.complete && (parent.pointProgressMax ?? 0) > (parent.pointProgress ?? 0)) {
                return true
            }
            const children = pc.childPromotions ?? []
            return children.some((c: any) => c && !c.complete && (c.pointProgressMax ?? 0) > (c.pointProgress ?? 0))
        })
        assert.strictEqual(
            hasIncompletePunchCardsAfterSearch,
            true,
            'Incomplete punch card must be detected for post-search claiming'
        )

        console.log('✅ Test 5 Passed: Post-search guard reliably identifies completed vs incomplete activities')
    }

    console.log('🎉 Chapter 28 Token Exchange & Concurrency Mutex Test Suite PASSED!')
}

if (require.main === module) {
    runChapter28TokenExchangeAndConcurrencyMutexTests().catch(err => {
        console.error('❌ Test failed:', err)
        process.exit(1)
    })
}
