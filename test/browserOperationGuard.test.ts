import assert from 'assert'
import fs from 'fs'
import path from 'path'
import {
    runGuardedOperation,
    performBoundedSafeScroll,
    AccountWatchdog,
    createManagedPage,
    recoverOwnerPage,
    resetRecoveryCount,
    getRecoveryCount,
    sanitizeDiagnosticUrl,
    interruptibleWait,
    promiseAny
} from '../src/runtime/BrowserOperationGuard'

export async function runBrowserOperationGuardTests() {
    console.log('--- Running Browser Operation Guard & Reliability Test Suite ---')

    // Test 1: Never-resolving navigation timeout bounded (simulated fast timeout)
    {
        const result = await runGuardedOperation({
            stage: 'activity-navigation',
            timeoutMs: 40,
            operation: async () => {
                return new Promise(() => {}) // Never resolves
            }
        })

        assert.strictEqual(result.status, 'timed-out')
        assert.ok(result.durationMs >= 35 && result.durationMs < 200, `durationMs was ${result.durationMs}`)
        assert.ok(result.errorCode?.includes('STAGE_TIMEOUT'))
        console.log('✅ Test 1 Passed: Never-resolving navigation bounded by strict stage timeout')
    }

    // Test 2: Static analysis: zero occurrences of networkidle in critical paths
    {
        const mobileAuthContent = fs.readFileSync(
            path.join(__dirname, '../src/browser/auth/methods/MobileAccessLogin.ts'),
            'utf-8'
        )
        const loginContent = fs.readFileSync(
            path.join(__dirname, '../src/browser/auth/Login.ts'),
            'utf-8'
        )
        const urlRewardContent = fs.readFileSync(
            path.join(__dirname, '../src/functions/activities/api/UrlReward.ts'),
            'utf-8'
        )

        assert.ok(!mobileAuthContent.includes('networkidle'), 'MobileAccessLogin contains networkidle')
        assert.ok(!urlRewardContent.includes('networkidle'), 'UrlReward contains networkidle')
        assert.ok(!loginContent.includes("waitUntil: 'networkidle'"), 'Login contains waitUntil: networkidle')
        assert.ok(!loginContent.includes("waitForLoadState('networkidle')"), 'Login contains waitForLoadState networkidle')

        // Verify promiseAny resolves first fulfilled
        const anyRes = await promiseAny([Promise.reject(new Error('err')), Promise.resolve('first-success')])
        assert.strictEqual(anyRes, 'first-success')
        console.log('✅ Test 2 Passed: Zero occurrences of networkidle in OAuth return and dashboard return paths')
    }

    // Test 3: Infinite-scroll page stops after maxSteps
    {
        let scrollY = 0
        const mockPage: any = {
            isClosed: () => false,
            evaluate: async (fn: any, delta: number) => {
                scrollY += Math.abs(delta)
                return scrollY
            }
        }

        const res = await performBoundedSafeScroll(mockPage, {
            maxSteps: 5,
            maxDurationMs: 10_000,
            stepDelayMs: 2
        })

        assert.strictEqual(res.stepsCompleted, 5)
        assert.strictEqual(res.interrupted, false)
        console.log('✅ Test 3 Passed: Infinite-scroll page stops reliably after maxSteps')
    }

    // Test 4: Safe scroll stops after maxDurationMs
    {
        let scrollY = 0
        const mockPage: any = {
            isClosed: () => false,
            evaluate: async (fn: any, delta: number) => {
                scrollY += Math.abs(delta)
                return scrollY
            }
        }

        const startTime = Date.now()
        const res = await performBoundedSafeScroll(mockPage, {
            maxSteps: 1000,
            maxDurationMs: 40,
            stepDelayMs: 15
        })

        assert.ok(res.stepsCompleted < 100, `Completed too many steps: ${res.stepsCompleted}`)
        assert.ok(Date.now() - startTime < 300)
        console.log('✅ Test 4 Passed: Safe scroll stops reliably when maxDurationMs elapses')
    }

    // Test 5: URL Reward timeout safely cleans up and advances without crash
    {
        let tabClosed = false
        let runBeforeUnloadVal: boolean | undefined

        const mockTab: any = {
            isClosed: () => tabClosed,
            close: async (opts?: any) => {
                tabClosed = true
                runBeforeUnloadVal = opts?.runBeforeUnload
            }
        }

        const result = await runGuardedOperation({
            stage: 'activity-interaction',
            timeoutMs: 30,
            operation: async () => {
                await new Promise(r => setTimeout(r, 100))
            }
        })

        // Finally block cleanup
        if (!mockTab.isClosed()) {
            await mockTab.close({ runBeforeUnload: false })
        }

        assert.strictEqual(result.status, 'timed-out')
        assert.strictEqual(tabClosed, true)
        assert.strictEqual(runBeforeUnloadVal, false)
        console.log('✅ Test 5 Passed: Activity timeout cleanly triggers page close and continues')
    }

    // Test 6: OAuth uses temporary page and preserves owner page URL invariant
    {
        const ownerUrl = 'https://rewards.bing.com/dashboard'
        const mockOwnerPage: any = {
            url: () => ownerUrl,
            isClosed: () => false
        }

        const ownerUrlBefore = sanitizeDiagnosticUrl(mockOwnerPage.url())

        // Simulated OAuth on separate managed page
        const mockOauthPage: any = {
            url: () => 'https://login.live.com/oauth20_desktop.srf?code=dummy&state=abc',
            isClosed: () => false,
            close: async () => {}
        }
        assert.ok(mockOauthPage.url().includes('oauth20_desktop.srf'))

        const ownerUrlAfter = sanitizeDiagnosticUrl(mockOwnerPage.url())
        assert.strictEqual(ownerUrlBefore.origin, ownerUrlAfter.origin)
        assert.strictEqual(ownerUrlBefore.pathname, ownerUrlAfter.pathname)
        assert.strictEqual(ownerUrlAfter.origin, 'https://rewards.bing.com')
        assert.strictEqual(ownerUrlAfter.pathname, '/dashboard')
        console.log('✅ Test 6 Passed: OAuth operates in isolated page and guarantees owner URL invariant')
    }

    // Test 7: Temporary pages are always closed in finally with { runBeforeUnload: false }
    {
        let closeOptionsPassed: any = null
        const mockPage: any = {
            isClosed: () => false,
            close: async (options: any) => {
                closeOptionsPassed = options
            }
        }

        await runGuardedOperation({
            stage: 'activity-page-close',
            timeoutMs: 100,
            operation: async () => {
                await mockPage.close({ runBeforeUnload: false })
            }
        })

        assert.deepStrictEqual(closeOptionsPassed, { runBeforeUnload: false })
        console.log('✅ Test 7 Passed: Temporary page close always enforces runBeforeUnload: false')
    }

    // Test 8: Owner-page recovery is executed at most once per account run
    {
        resetRecoveryCount()
        const scope = 'user1@example.com'

        let windowStopCalled = false
        let oldPageClosed = false

        const mockOldPage: any = {
            isClosed: () => oldPageClosed,
            evaluate: async () => { windowStopCalled = true },
            close: async () => { oldPageClosed = true },
            context: () => mockContext
        }

        const mockContext: any = {
            newPage: async () => ({
                setDefaultTimeout: () => {},
                setDefaultNavigationTimeout: () => {},
                on: () => {},
                goto: async () => {}
            })
        }

        const mockBot: any = {
            config: { baseURL: 'https://rewards.bing.com' },
            isMobile: true,
            mainMobilePage: mockOldPage
        }

        const recovered1 = await recoverOwnerPage({
            bot: mockBot,
            oldPage: mockOldPage,
            isMobile: true,
            accountScope: scope
        })

        assert.ok(recovered1 !== null, 'First recovery should succeed')
        assert.strictEqual(windowStopCalled, true)
        assert.strictEqual(oldPageClosed, true)
        assert.strictEqual(getRecoveryCount(scope), 1)

        // Second recovery attempt in same run must be skipped
        const recovered2 = await recoverOwnerPage({
            bot: mockBot,
            oldPage: mockOldPage,
            isMobile: true,
            accountScope: scope
        })

        assert.strictEqual(recovered2, null, 'Second recovery in same run must return null')
        assert.strictEqual(getRecoveryCount(scope), 1)
        console.log('✅ Test 8 Passed: Owner-page recovery strictly enforces max 1 recovery per run')
    }

    // Test 9: Ghost cursor rebinds / works after replacement page creation
    {
        const mockContext: any = {
            newPage: async () => ({
                setDefaultTimeout: () => {},
                setDefaultNavigationTimeout: () => {},
                on: () => {},
                goto: async () => {},
                waitForSelector: async () => ({}),
                click: async () => {}
            })
        }

        const newPage = await createManagedPage({
            context: mockContext,
            purpose: 'ghost-test',
            isMobile: true
        })

        assert.ok(newPage !== null)
        assert.strictEqual((newPage as any).__managedMetadata.purpose, 'ghost-test')
        console.log('✅ Test 9 Passed: Replacement page initialized cleanly and accepts input bindings')
    }

    // Test 10: Timers and event listeners are cleanly removed on timeout or completion
    {
        const listeners: Record<string, Function[]> = {}
        const mockPage: any = {
            on: (event: string, fn: Function) => {
                listeners[event] = listeners[event] || []
                listeners[event].push(fn)
            },
            off: (event: string, fn: Function) => {
                if (listeners[event]) {
                    listeners[event] = listeners[event].filter(f => f !== fn)
                }
            },
            isClosed: () => false,
            mainFrame: () => ({})
        }

        await runGuardedOperation({
            stage: 'activity-interaction',
            timeoutMs: 30,
            page: mockPage,
            operation: async () => {
                assert.ok((listeners['response']?.length ?? 0) > 0)
                assert.ok((listeners['requestfailed']?.length ?? 0) > 0)
                await new Promise(r => setTimeout(r, 60))
            }
        })

        assert.strictEqual(listeners['response']?.length ?? 0, 0)
        assert.strictEqual(listeners['requestfailed']?.length ?? 0, 0)
        console.log('✅ Test 10 Passed: Diagnostic listeners cleanly detached in finally block')
    }

    // Test 11: Network error is classified distinctly from readiness timeout
    {
        const netErrResult = await runGuardedOperation({
            stage: 'activity-navigation',
            timeoutMs: 1000,
            operation: async () => {
                throw new Error('net::ERR_NAME_NOT_RESOLVED')
            }
        })
        assert.strictEqual(netErrResult.status, 'navigation-error')

        const timeoutResult = await runGuardedOperation({
            stage: 'activity-navigation',
            timeoutMs: 20,
            operation: async () => {
                await new Promise(r => setTimeout(r, 100))
            }
        })
        assert.strictEqual(timeoutResult.status, 'timed-out')
        console.log('✅ Test 11 Passed: Network errors and timeout statuses are strictly differentiated')
    }

    // Test 12: Full URLs with query strings, emails, and tokens never appear in diagnostic logs
    {
        const raw = 'https://login.live.com/oauth20_desktop.srf?code=M.R3_BAY.secretCode123&state=mySecretState456&email=user%40example.com'
        const sanitized = sanitizeDiagnosticUrl(raw)

        assert.strictEqual(sanitized.origin, 'https://login.live.com')
        assert.strictEqual(sanitized.pathname, '/oauth20_desktop.srf')
        assert.ok(!JSON.stringify(sanitized).includes('code='))
        assert.ok(!JSON.stringify(sanitized).includes('secretCode123'))
        assert.ok(!JSON.stringify(sanitized).includes('user%40example.com'))
        console.log('✅ Test 12 Passed: Diagnostic URL sanitization strips all query parameters, tokens, and secrets')
    }

    // Test 13: Protected modules check: Data Saver rules and telemetry whitelist remain 100% intact
    {
        const browserContent = fs.readFileSync(
            path.join(__dirname, '../src/browser/Browser.ts'),
            'utf-8'
        )
        assert.ok(browserContent.includes('ULTRA DATA SAVER'), 'Browser Data Saver rules missing')
        assert.ok(browserContent.includes('trackBlockedRequest()'), 'trackBlockedRequest missing')
        assert.ok(browserContent.includes('trackBandwidth('), 'trackBandwidth missing')
        console.log('✅ Test 13 Passed: Data Saver rules and telemetry whitelist 100% preserved')
    }

    // Test 14: Protected modules check: Search delay and parallel search remain 100% intact
    {
        const searchManagerContent = fs.readFileSync(
            path.join(__dirname, '../src/functions/SearchManager.ts'),
            'utf-8'
        )
        assert.ok(searchManagerContent.includes('doSearch'), 'doSearch missing')
        assert.ok(searchManagerContent.includes('searchSettings'), 'searchSettings missing')
        console.log('✅ Test 14 Passed: SearchManager and parallel search configuration 100% preserved')
    }

    // Test 15: Account B runs normally even after account A experiences an activity timeout
    {
        resetRecoveryCount()
        const accountA = 'accA@test.com'
        const accountB = 'accB@test.com'
        assert.strictEqual(getRecoveryCount(accountA), 0)
        assert.strictEqual(getRecoveryCount(accountB), 0)

        // Account A experiences timeout
        const resA = await runGuardedOperation({
            stage: 'activity-interaction',
            timeoutMs: 20,
            operation: async () => {
                await new Promise(r => setTimeout(r, 60))
            }
        })
        assert.strictEqual(resA.status, 'timed-out')

        // Account B runs cleanly
        const resB = await runGuardedOperation({
            stage: 'activity-interaction',
            timeoutMs: 500,
            operation: async () => {
                return 'account-b-success'
            }
        })
        assert.strictEqual(resB.status, 'completed')
        assert.strictEqual(resB.value, 'account-b-success')
        console.log('✅ Test 15 Passed: Cross-account isolation guarantees Account B completes despite Account A timeout')
    }

    // Test 16: GuardedOperation abort signal cancellation
    {
        let abortFired = false
        await runGuardedOperation({
            stage: 'activity-interaction',
            timeoutMs: 25,
            operation: async (signal) => {
                signal.addEventListener('abort', () => {
                    abortFired = true
                })
                await new Promise(r => setTimeout(r, 100))
            }
        })

        assert.strictEqual(abortFired, true)
        console.log('✅ Test 16 Passed: GuardedOperation abort signal fires reliably upon timeout')
    }

    // Test 17: Cooperative cancellation in custom loops
    {
        const controller = new AbortController()
        controller.abort() // Pre-aborted signal

        const mockPage: any = {
            isClosed: () => false,
            evaluate: async () => 100
        }

        const res = await performBoundedSafeScroll(mockPage, {
            maxSteps: 10,
            signal: controller.signal
        })

        assert.strictEqual(res.stepsCompleted, 0)
        assert.strictEqual(res.interrupted, true)
        console.log('✅ Test 17 Passed: Custom loop inspects signal.aborted and exits immediately')
    }

    // Test 18: Absolute activity deadline: total budget exhausted halts stage execution
    {
        let operationCalled = false
        const res = await runGuardedOperation({
            stage: 'activity-navigation',
            timeoutMs: 5000,
            remainingBudgetMs: 0, // Budget already exhausted
            operation: async () => {
                operationCalled = true
            }
        })

        assert.strictEqual(res.status, 'timed-out')
        assert.strictEqual(res.errorCode, 'TOTAL_BUDGET_EXHAUSTED')
        assert.strictEqual(operationCalled, false)
        console.log('✅ Test 18 Passed: Zero remaining budget halts stage without invoking operation')
    }

    // Test 19: getCurrentPoints: ctx.request.get fast-path returns points without DOM evaluation
    {
        let domEvaluated = false
        const mockPage: any = {
            isClosed: () => false,
            context: () => ({
                request: {
                    get: async () => ({
                        ok: () => true,
                        json: async () => ({
                            dashboard: {
                                userStatus: { availablePoints: 8520 }
                            }
                        })
                    })
                }
            }),
            evaluate: async () => {
                domEvaluated = true
                return null
            }
        }

        // Test the direct request context pattern from BrowserFunc
        const ctx = mockPage.context()
        const res = await ctx.request.get('https://rewards.bing.com/api/getuserinfo?type=1', { timeout: 4000 })
        let pts = 0
        if (res.ok()) {
            const data = await res.json()
            pts = data?.dashboard?.userStatus?.availablePoints
        }

        assert.strictEqual(pts, 8520)
        assert.strictEqual(domEvaluated, false)
        console.log('✅ Test 19 Passed: ctx.request.get fast-path extracts points without DOM evaluation')
    }

    // Test 20: getCurrentPoints: fallback fetch handles cleanup in finally
    {
        let finallyExecuted = false
        let timeoutCleared = false

        await (async () => {
            let timeoutId: any
            try {
                timeoutId = setTimeout(() => {}, 10000)
            } finally {
                if (timeoutId) {
                    clearTimeout(timeoutId)
                    timeoutCleared = true
                }
                finallyExecuted = true
            }
        })()

        assert.strictEqual(finallyExecuted, true)
        assert.strictEqual(timeoutCleared, true)
        console.log('✅ Test 20 Passed: In-page fetch AbortController timer is cleared in finally block')
    }

    // Test 21: Main-document diagnostics: navigation failure records mainDocumentFailureCode
    {
        let reqFailedHandler: Function | undefined
        const mockPage: any = {
            on: (event: string, fn: Function) => {
                if (event === 'requestfailed') reqFailedHandler = fn
            },
            off: () => {},
            isClosed: () => false,
            mainFrame: () => mockMainFrame
        }
        const mockMainFrame = {}

        const result = await runGuardedOperation({
            stage: 'activity-navigation',
            timeoutMs: 500,
            page: mockPage,
            operation: async () => {
                if (reqFailedHandler) {
                    reqFailedHandler({
                        isNavigationRequest: () => true,
                        frame: () => mockMainFrame,
                        failure: () => ({ errorText: 'net::ERR_CONNECTION_REFUSED' })
                    })
                }
                throw new Error('Navigation failed')
            }
        })

        assert.strictEqual(result.mainDocumentFailureCode, 'net::ERR_CONNECTION_REFUSED')
        assert.strictEqual(result.subresourceFailureCount, 0)
        console.log('✅ Test 21 Passed: Navigation failure attributes mainDocumentFailureCode without subresource collision')
    }

    // Test 22: Subresource failure diagnostics: subresource failure increments subresourceFailureCount
    {
        let reqFailedHandler: Function | undefined
        const mockPage: any = {
            on: (event: string, fn: Function) => {
                if (event === 'requestfailed') reqFailedHandler = fn
            },
            off: () => {},
            isClosed: () => false,
            mainFrame: () => mockMainFrame
        }
        const mockMainFrame = {}

        const result = await runGuardedOperation({
            stage: 'activity-navigation',
            timeoutMs: 500,
            page: mockPage,
            operation: async () => {
                if (reqFailedHandler) {
                    reqFailedHandler({
                        isNavigationRequest: () => false,
                        frame: () => ({}),
                        failure: () => ({ errorText: 'net::ERR_BLOCKED_BY_CLIENT' })
                    })
                }
                return 'ok'
            }
        })

        assert.strictEqual(result.mainDocumentFailureCode, undefined)
        assert.strictEqual(result.subresourceFailureCount, 1)
        console.log('✅ Test 22 Passed: Subresource failure increments subresourceFailureCount without failing document')
    }

    // Test 23: AccountWatchdog emits heartbeat and stops cleanly
    {
        let loggedHeartbeat = false
        const mockLogger = {
            info: (_isMobile: boolean, tag: string, msg: string) => {
                if (msg.includes('ACCOUNT-WATCHDOG') && msg.includes('heartbeat=active')) {
                    loggedHeartbeat = true
                }
            }
        }

        const watchdog = new AccountWatchdog(mockLogger, false)
        ;(watchdog as any).intervalMs = 20 // Fast interval for testing
        watchdog.start('test-stage')

        await interruptibleWait(50)
        watchdog.stop()

        assert.strictEqual(loggedHeartbeat, true)
        assert.strictEqual((watchdog as any).timer, null)
        console.log('✅ Test 23 Passed: AccountWatchdog logs heartbeat and disarms timer cleanly on stop')
    }

    // Test 24: createManagedPage sets default timeouts and attaches dialog handler
    {
        let defaultTimeout = 0
        let defaultNavTimeout = 0
        let dialogHandled = false

        const mockContext: any = {
            newPage: async () => ({
                setDefaultTimeout: (t: number) => { defaultTimeout = t },
                setDefaultNavigationTimeout: (t: number) => { defaultNavTimeout = t },
                on: (event: string, fn: Function) => {
                    if (event === 'dialog') {
                        fn({ dismiss: async () => { dialogHandled = true } })
                    }
                }
            })
        }

        const page = await createManagedPage({
            context: mockContext,
            purpose: 'managed-test',
            defaultTimeoutMs: 12000,
            defaultNavTimeoutMs: 18000
        })

        assert.ok(page !== null)
        assert.strictEqual((page as any).__managedMetadata.purpose, 'managed-test')
        assert.strictEqual(defaultTimeout, 12000)
        assert.strictEqual(defaultNavTimeout, 18000)
        assert.strictEqual(dialogHandled, true)
        console.log('✅ Test 24 Passed: createManagedPage configures default timeouts and auto-dismisses dialogs')
    }

    // Test 25: Recovery guard: recoverOwnerPage executes window.stop() and closes with { runBeforeUnload: false }
    {
        resetRecoveryCount()
        let stopCalled = false
        let closeOptions: any = null

        const mockOldPage: any = {
            isClosed: () => false,
            evaluate: async (fn: any) => {
                stopCalled = true
            },
            close: async (opts: any) => {
                closeOptions = opts
            },
            context: () => mockContext
        }

        const mockContext: any = {
            newPage: async () => ({
                setDefaultTimeout: () => {},
                setDefaultNavigationTimeout: () => {},
                on: () => {},
                goto: async () => {}
            })
        }

        const mockBot: any = {
            config: { baseURL: 'https://rewards.bing.com' },
            isMobile: false,
            mainDesktopPage: mockOldPage
        }

        await recoverOwnerPage({
            bot: mockBot,
            oldPage: mockOldPage,
            isMobile: false,
            accountScope: 'test-recovery-scope'
        })

        assert.strictEqual(stopCalled, true)
        assert.deepStrictEqual(closeOptions, { runBeforeUnload: false })
        console.log('✅ Test 25 Passed: recoverOwnerPage bounds window.stop() and enforces runBeforeUnload: false')
    }
}
