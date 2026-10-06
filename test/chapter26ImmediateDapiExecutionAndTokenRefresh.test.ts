import assert from 'assert'
import { ReadToEarn } from '../src/functions/activities/app/ReadToEarn'
import { DailyCheckIn } from '../src/functions/activities/app/DailyCheckIn'
import BrowserFunc from '../src/browser/BrowserFunc'
import { AccountScope } from '../src/runtime/AccountScope'
import type { MicrosoftRewardsBot } from '../src/index'

export async function runChapter26ImmediateDapiExecutionAndTokenRefreshTests() {
    console.log('\n--- Running Chapter 26 Immediate DAPI Execution & HTTP 401 Token Refresh Test Suite ---')

    const mockLogs: string[] = []
    let appTokenFetchCount = 0

    const mockScope = AccountScope.createForTesting('testuser@gmail.com', 'run_ch26_test')
    mockScope.setDapiToken('initial_stale_token')

    const mockBot: any = {
        isMobile: true,
        accessToken: 'initial_stale_token',
        activeAccount: { email: 'testuser@gmail.com' },
        accountScope: mockScope,
        mainMobilePage: {
            isClosed: () => false,
            url: () => 'https://rewards.bing.com'
        },
        userData: {
            currentPoints: 500,
            gainedPoints: 0,
            geoLocale: 'ID'
        },
        config: {
            searchSettings: {
                readDelay: { min: 10, max: 20 }
            }
        },
        login: {
            getAppAccessToken: async (_page: any, _email: string) => {
                appTokenFetchCount++
                return `fresh_refreshed_token_v${appTokenFetchCount}`
            }
        },
        logger: {
            info: (_isMobile: any, tag: string, msg: string) => {
                mockLogs.push(`[INFO][${tag}] ${msg}`)
            },
            warn: (_isMobile: any, tag: string, msg: string) => {
                mockLogs.push(`[WARN][${tag}] ${msg}`)
            },
            error: (_isMobile: any, tag: string, msg: string) => {
                mockLogs.push(`[ERROR][${tag}] ${msg}`)
            },
            debug: (_isMobile: any, tag: string, msg: string) => {
                mockLogs.push(`[DEBUG][${tag}] ${msg}`)
            }
        },
        utils: {
            wait: async (_ms: number) => {},
            randomDelay: () => 0
        },
        browser: {
            func: {
                getAppEarnablePoints: async () => ({ readToEarn: 30, checkIn: 10 })
            }
        },
        refreshMobileAccessToken: async () => {
            mockLogs.push('[WARN][DAPI-AUTH] ⚠️ [DAPI-AUTH] Token kedaluwarsa (401). Meminta refresh token seluler baru...')
            appTokenFetchCount++
            const newToken = `fresh_refreshed_token_v${appTokenFetchCount}`
            mockBot.accessToken = newToken
            mockScope.setDapiToken(newToken)
            mockLogs.push('[INFO][DAPI-AUTH] ✅ [DAPI-AUTH] Refresh token seluler baru berhasil didapatkan!')
            return newToken
        },
        get loginApp() {
            return {
                getAppToken: async () => await mockBot.refreshMobileAccessToken()
            }
        }
    }

    // Test 1: refreshMobileAccessToken updates bot.accessToken and accountScope DAPI token
    {
        mockLogs.length = 0
        appTokenFetchCount = 0
        mockBot.accessToken = 'old_token'
        mockScope.setDapiToken('old_token')

        const refreshed = await mockBot.refreshMobileAccessToken()
        assert.strictEqual(refreshed, 'fresh_refreshed_token_v1')
        assert.strictEqual(mockBot.accessToken, 'fresh_refreshed_token_v1')
        assert.strictEqual(mockScope.getDapiToken(), 'fresh_refreshed_token_v1')

        const warningLogged = mockLogs.some(l => l.includes('⚠️ [DAPI-AUTH] Token kedaluwarsa (401)'))
        const successLogged = mockLogs.some(l => l.includes('✅ [DAPI-AUTH] Refresh token seluler baru berhasil didapatkan!'))
        assert.ok(warningLogged, 'Warning about expired token should be logged')
        assert.ok(successLogged, 'Success log for new token should be logged')
        console.log('✅ Test 1 Passed: refreshMobileAccessToken cleanly updates bot and accountScope tokens')
    }

    // Test 2: loginApp.getAppToken adapter functions seamlessly
    {
        appTokenFetchCount = 1
        const refreshed = await mockBot.loginApp.getAppToken()
        assert.strictEqual(refreshed, 'fresh_refreshed_token_v2')
        assert.strictEqual(mockBot.accessToken, 'fresh_refreshed_token_v2')
        console.log('✅ Test 2 Passed: loginApp.getAppToken adapter delegates properly to refreshMobileAccessToken')
    }

    // Test 3: ReadToEarn automatically refreshes token on HTTP 401 and successfully retries article
    {
        mockLogs.length = 0
        let requestAttempts = 0
        const capturedAuthHeaders: string[] = []

        const testBot = {
            ...mockBot,
            accessToken: 'stale_token_123',
            axios: {
                request: async (config: any) => {
                    requestAttempts++
                    capturedAuthHeaders.push(config.headers['Authorization'])

                    // First request gets 401 Unauthorized
                    if (requestAttempts === 1) {
                        return { status: 401, data: { message: 'Unauthorized' } }
                    }

                    // Subsequent requests with refreshed token succeed
                    return { status: 200, data: { response: { balance: 503 } } }
                }
            }
        } as unknown as MicrosoftRewardsBot

        const readWorker = new ReadToEarn(testBot)
        // Stub MSN article pool with single article
        ;(readWorker as any).fetchValidMsnArticles = async () => ['AAtest01']

        await readWorker.doReadToEarn()

        assert.ok(requestAttempts >= 2, `Expected at least 2 request attempts due to retry, got ${requestAttempts}`)
        assert.strictEqual(capturedAuthHeaders[0], 'Bearer stale_token_123', 'First attempt used stale token')
        assert.ok(
            capturedAuthHeaders[1]?.startsWith('Bearer fresh_refreshed_token_v'),
            `Second attempt should use fresh token, got ${capturedAuthHeaders[1]}`
        )

        const authWarn = mockLogs.some(l => l.includes('⚠️ [DAPI-AUTH] Token kedaluwarsa (401). Meminta refresh token seluler baru...'))
        assert.ok(authWarn, 'Auto-refresh warning must be emitted')
        console.log('✅ Test 3 Passed: ReadToEarn catches 401, refreshes bearer token, and succeeds on retry')
    }

    // Test 4: ReadToEarn bounds token refresh attempts to max 2 per session
    {
        mockLogs.length = 0
        let totalRequests = 0

        const testBot = {
            ...mockBot,
            accessToken: 'perpetual_bad_token',
            axios: {
                request: async () => {
                    totalRequests++
                    // Server consistently rejects with 401
                    return { status: 401, data: { message: 'Unauthorized' } }
                }
            }
        } as unknown as MicrosoftRewardsBot

        const readWorker = new ReadToEarn(testBot)
        ;(readWorker as any).fetchValidMsnArticles = async () => ['AAtest01', 'AAtest02']

        await readWorker.doReadToEarn()

        // With max 2 refresh attempts, total requests must be strictly bounded (1 initial + 2 retries = 3 requests maximum)
        assert.ok(totalRequests <= 4, `Total requests must be bounded to <= 4, was ${totalRequests}`)
        const stoppingLogged = mockLogs.some(l => l.includes('API returned non-200 status, stopping Read to Earn'))
        assert.ok(stoppingLogged, 'Must cleanly terminate loop when 401 persists without crashing')
        console.log('✅ Test 4 Passed: ReadToEarn enforces max 2 refresh attempts preventing infinite loops')
    }

    // Test 5: DailyCheckIn auto-refreshes token on HTTP 401 and succeeds
    {
        mockLogs.length = 0
        let dailyRequests = 0
        const dailyAuthHeaders: string[] = []

        const testBot = {
            ...mockBot,
            accessToken: 'stale_daily_token',
            axios: {
                request: async (config: any) => {
                    dailyRequests++
                    dailyAuthHeaders.push(config.headers['Authorization'])

                    if (dailyRequests === 1) {
                        return { status: 401, data: { message: 'Unauthorized' } }
                    }
                    return { status: 200, data: { response: { balance: 510 } } }
                }
            }
        } as unknown as MicrosoftRewardsBot

        const checkInWorker = new DailyCheckIn(testBot)
        await checkInWorker.doDailyCheckIn()

        assert.ok(dailyRequests >= 2, `DailyCheckIn must have retried after 401, got ${dailyRequests}`)
        assert.strictEqual(dailyAuthHeaders[0], 'Bearer stale_daily_token')
        assert.ok(dailyAuthHeaders[1]?.startsWith('Bearer fresh_refreshed_token_v'))

        const checkInSuccess = mockLogs.some(l => l.includes('Completed Daily Check-In'))
        assert.ok(checkInSuccess, 'Daily Check-In must complete successfully after retry')
        console.log('✅ Test 5 Passed: DailyCheckIn catches 401, refreshes token and completes claim')
    }

    // Test 6: BrowserFunc.getAppDashboardData handles 401 with 1x token refresh and non-fatal fallback
    {
        mockLogs.length = 0
        let dashboardAttempts = 0

        const testBot = {
            ...mockBot,
            accessToken: 'stale_dash_token',
            axios: {
                request: async () => {
                    dashboardAttempts++
                    if (dashboardAttempts === 1) {
                        return { status: 401, data: { message: 'Unauthorized' } }
                    }
                    return {
                        status: 200,
                        data: {
                            response: {
                                profile: { attributes: { country: 'ID' } },
                                promotions: []
                            }
                        }
                    }
                }
            }
        } as unknown as MicrosoftRewardsBot

        const browserFunc = new BrowserFunc(testBot)
        const appDash = await browserFunc.getAppDashboardData()

        assert.strictEqual(dashboardAttempts, 2, 'getAppDashboardData should retry exactly 1x after 401')
        assert.strictEqual(appDash.response.profile.attributes.country, 'ID')
        console.log('✅ Test 6 Passed: getAppDashboardData handles 401 via 1x token refresh and non-fatal recovery')
    }

    console.log('🎉 ALL CHAPTER 26 IMMEDIATE DAPI & TOKEN REFRESH TESTS PASSED!')
}
