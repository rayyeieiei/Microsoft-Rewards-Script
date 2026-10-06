import assert from 'assert'
import { ReadToEarn } from '../src/functions/activities/app/ReadToEarn'
import AxiosClient from '../src/util/Axios'
import { AccountScope } from '../src/runtime/AccountScope'

export async function runChapter27ReadToEarnResilienceAndTokenSyncTests() {
    console.log('\n--- Running Chapter 27 Read to Earn Resilience & Global Token Sync Test Suite ---')

    const mockLogs: string[] = []
    let tokenRefreshCalls = 0

    // Test 1: AxiosClient setAuthorizationToken and defaults synchronization
    {
        const client = new AxiosClient({ proxyAxios: false, url: '', port: 0, password: '', username: '' })
        assert.strictEqual(client.defaults.headers.common['Authorization'], undefined)

        client.setAuthorizationToken('test_token_123')
        assert.strictEqual(client.defaults.headers.common['Authorization'], 'Bearer test_token_123')

        client.setAuthorizationToken('')
        assert.strictEqual(client.defaults.headers.common['Authorization'], undefined)
        console.log('✅ Test 1 Passed: AxiosClient properly synchronizes Authorization header in defaults')
    }

    // Test 2: MSN Card Filter & Fallback Pool Size
    {
        const mockScope = AccountScope.createForTesting('test2@example.com', 'run_ch27_filter')
        const mockBot: any = {
            userData: { geoLocale: 'US' },
            logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
            accountScope: mockScope
        }
        const rte = new ReadToEarn(mockBot)

        // Verify pool size >= 25
        assert.ok(
            rte.FALLBACK_ARTICLE_POOL.length >= 25,
            `Fallback article pool must have at least 25 items, found ${rte.FALLBACK_ARTICLE_POOL.length}`
        )

        // Test isValidArticleCard filters
        assert.strictEqual(rte.isValidArticleCard({ id: 'AA12345', type: 'article' }), true)
        assert.strictEqual(rte.isValidArticleCard({ id: 'AA12345', type: 'video' }), false)
        assert.strictEqual(rte.isValidArticleCard({ id: 'AA12345', format: 'video' }), false)
        assert.strictEqual(rte.isValidArticleCard({ id: 'AA12345', contentType: 'video' }), false)
        assert.strictEqual(rte.isValidArticleCard({ id: 'AA12345', type: 'slideshow' }), false)
        assert.strictEqual(rte.isValidArticleCard({ id: 'AA12345', contentType: 'slideshow' }), false)
        assert.strictEqual(rte.isValidArticleCard({ id: 'AA12345', type: 'gallery' }), false)
        assert.strictEqual(rte.isValidArticleCard({ id: 'AA12345', type: 'ad' }), false)
        assert.strictEqual(rte.isValidArticleCard({ id: 'AA12345', isSponsored: true }), false)
        assert.strictEqual(rte.isValidArticleCard({ id: 'AA12345', adId: 'ad-999' }), false)
        assert.strictEqual(rte.isValidArticleCard({ id: 'CanonicalName-abc' }), false)
        assert.strictEqual(rte.isValidArticleCard({ id: 'AA12345', url: 'https://msn.com/en-us/news/video/vi-123' }), false)

        console.log('✅ Test 2 Passed: isValidArticleCard cleanly rejects video/slideshow/ad formats and pool has >= 25 IDs')
    }

    // Test 3: ReadToEarn Non-Abort & Ineligible Article Skipping
    {
        mockLogs.length = 0
        tokenRefreshCalls = 0
        const mockScope = AccountScope.createForTesting('test3@example.com', 'run_ch27_skip')
        mockScope.setDapiToken('valid_token')

        const requestHistory: Array<{ articleId: string; authHeader: string }> = []

        const mockBot: any = {
            isMobile: true,
            accessToken: 'valid_token',
            activeAccount: { email: 'test3@example.com' },
            accountScope: mockScope,
            userData: {
                currentPoints: 100,
                gainedPoints: 0,
                geoLocale: 'US'
            },
            config: {
                searchSettings: {
                    readDelay: { min: 1, max: 2 }
                }
            },
            logger: {
                info: (_isMobile: any, tag: string, msg: string) => mockLogs.push(`[INFO][${tag}] ${msg}`),
                warn: (_isMobile: any, tag: string, msg: string) => mockLogs.push(`[WARN][${tag}] ${msg}`),
                error: (_isMobile: any, tag: string, msg: string) => mockLogs.push(`[ERROR][${tag}] ${msg}`),
                debug: (_isMobile: any, tag: string, msg: string) => mockLogs.push(`[DEBUG][${tag}] ${msg}`)
            },
            utils: {
                wait: async () => {},
                randomDelay: () => 0
            },
            browser: {
                func: {
                    // remaining quota = 9 pts -> target 3 articles
                    getAppEarnablePoints: async () => ({ readToEarn: 9, checkIn: 0 })
                }
            },
            loginApp: {
                getAppToken: async () => {
                    tokenRefreshCalls++
                    const newToken = `refreshed_token_v${tokenRefreshCalls}`
                    mockBot.accessToken = newToken
                    return newToken
                }
            },
            axios: {
                defaults: { headers: { common: {} as Record<string, string> } },
                request: async (config: any) => {
                    const data = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
                    const articleId = data.id
                    requestHistory.push({ articleId, authHeader: config.headers?.Authorization })

                    // Article 1: Success (200)
                    if (articleId === 'ART_1') {
                        return { status: 200, data: { status: 'success' } }
                    }
                    // Article 2: Ineligible (returns 401 on original AND retried attempts)
                    if (articleId === 'ART_2') {
                        return { status: 401, data: { error: 'Ineligible format' } }
                    }
                    // Article 3: Ineligible (returns 400 Bad Request)
                    if (articleId === 'ART_3') {
                        return { status: 400, data: { error: 'Bad Request' } }
                    }
                    // Article 4: Success (200)
                    if (articleId === 'ART_4') {
                        return { status: 200, data: { status: 'success' } }
                    }
                    // Article 5: Success (200)
                    if (articleId === 'ART_5') {
                        return { status: 200, data: { status: 'success' } }
                    }

                    return { status: 200, data: { status: 'success' } }
                }
            }
        }

        const rte = new ReadToEarn(mockBot)
        // Stub fetchValidMsnArticles to return our controlled test sequence
        rte.fetchValidMsnArticles = async () => ['ART_1', 'ART_2', 'ART_3', 'ART_4', 'ART_5']

        await rte.doReadToEarn()

        // Verify that target of 3 articles was successfully fulfilled
        assert.strictEqual(mockBot.userData.gainedPoints, 9, 'Should have gained exactly 9 points (3 * 3 pts)')
        assert.strictEqual(mockBot.userData.currentPoints, 109, 'Balance should have increased by 9')

        // Verify that ineligible warning logs were generated
        const art2Warning = mockLogs.some(
            l => l.includes('⚠️ [READ-TO-EARN] Artikel ART_2 tidak memenuhi syarat poin (status 401). Melewati ke artikel berikutnya...')
        )
        const art3Warning = mockLogs.some(
            l => l.includes('⚠️ [READ-TO-EARN] Artikel ART_3 tidak memenuhi syarat poin (status 400). Melewati ke artikel berikutnya...')
        )
        assert.ok(art2Warning, 'Warning log for ineligible ART_2 must be present')
        assert.ok(art3Warning, 'Warning log for ineligible ART_3 must be present')

        // Verify complete summary log
        const completedLog = mockLogs.some(l => l.includes('Completed Read to Earn | articlesRead=3/3 | totalGained=9'))
        assert.ok(completedLog, 'Completion log must show 3/3 articles read despite skips')

        console.log('✅ Test 3 Passed: ReadToEarn skipped ineligible articles without aborting loop, reaching target')
    }

    // Test 4: Successful Token Refresh and Retry on 401
    {
        mockLogs.length = 0
        tokenRefreshCalls = 0
        const mockScope = AccountScope.createForTesting('test4@example.com', 'run_ch27_retry')
        mockScope.setDapiToken('stale_token')

        let art1CallCount = 0

        const mockBot: any = {
            isMobile: true,
            accessToken: 'stale_token',
            activeAccount: { email: 'test4@example.com' },
            accountScope: mockScope,
            userData: {
                currentPoints: 200,
                gainedPoints: 0,
                geoLocale: 'US'
            },
            config: {
                searchSettings: {
                    readDelay: { min: 1, max: 2 }
                }
            },
            logger: {
                info: (_isMobile: any, tag: string, msg: string) => mockLogs.push(`[INFO][${tag}] ${msg}`),
                warn: (_isMobile: any, tag: string, msg: string) => mockLogs.push(`[WARN][${tag}] ${msg}`),
                error: (_isMobile: any, tag: string, msg: string) => mockLogs.push(`[ERROR][${tag}] ${msg}`),
                debug: (_isMobile: any, tag: string, msg: string) => mockLogs.push(`[DEBUG][${tag}] ${msg}`)
            },
            utils: {
                wait: async () => {},
                randomDelay: () => 0
            },
            browser: {
                func: {
                    // 1 article needed
                    getAppEarnablePoints: async () => ({ readToEarn: 3, checkIn: 0 })
                }
            },
            loginApp: {
                getAppToken: async () => {
                    tokenRefreshCalls++
                    const newToken = 'freshly_refreshed_token_401'
                    mockBot.accessToken = newToken
                    return newToken
                }
            },
            axios: {
                defaults: { headers: { common: {} as Record<string, string> } },
                request: async (config: any) => {
                    art1CallCount++
                    // First call returns 401
                    if (art1CallCount === 1) {
                        assert.strictEqual(config.headers.Authorization, 'Bearer stale_token')
                        return { status: 401 }
                    }
                    // Second call with retried token returns 200 OK
                    assert.strictEqual(config.headers.Authorization, 'Bearer freshly_refreshed_token_401')
                    return { status: 200 }
                }
            }
        }

        const rte = new ReadToEarn(mockBot)
        rte.fetchValidMsnArticles = async () => ['ART_RETRY_SUCCESS']

        await rte.doReadToEarn()

        assert.strictEqual(tokenRefreshCalls, 1, 'Token refresh must have been called exactly once')
        assert.strictEqual(art1CallCount, 2, 'Article request must have been retried once')
        assert.strictEqual(mockBot.userData.gainedPoints, 3, 'Article retry should award points')
        assert.strictEqual(mockBot.axios.defaults.headers.common['Authorization'], 'Bearer freshly_refreshed_token_401')

        console.log('✅ Test 4 Passed: 401 auto-refreshed token, updated headers, and retried article successfully')
    }

    console.log('🎉 Chapter 27 Read to Earn Resilience & Global Token Sync Test Suite PASSED!')
}
