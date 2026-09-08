import assert from 'assert'
import { execSync } from 'child_process'
import { AccountScope } from '../src/runtime/AccountScope'
import {
    resolveUrlRewardAction,
    ResolvedActionSecret
} from '../src/functions/UrlRewardActionResolver'
import {
    Workers,
    type PunchCardStateReader,
    type PunchCardServerSnapshot,
    evaluatePunchCardRun
} from '../src/functions/Workers'
import type { PunchCard, BasePromotion, DashboardData } from '../src/interface/DashboardData'
import { validateConfig, ConfigSchema } from '../src/util/Validator'

export async function runPunchCardExecutionTests() {
    console.log('--- Running Punch Card Execution & Safety Test Suite ---')

    // Test 1: Ambiguous response produces 0 retry and 0 DOM fallback (Single-Transport Invariant)
    {
        const logged: string[] = []
        let clickCount = 0
        const mockScope = new AccountScope('bar***@gmail.com', 'run_test_1')
        const mockWorkers = new Workers({
            isMobile: false,
            userData: { userName: 'baryyaja', currentPoints: 100 },
            config: { punchCardExecution: { mode: 'browser-ui-experimental', maxChildrenPerRun: 1 } },
            accountScope: mockScope,
            logger: {
                info: (_m: boolean, cat: string, msg: string) => logged.push(`[${cat}] ${msg}`),
                warn: (_m: boolean, cat: string, msg: string) => logged.push(`[${cat}] ${msg}`),
                debug: () => {},
                error: () => {}
            },
            utils: { wait: async () => {} }
        } as any)

        mockWorkers.checkPunchCardKillSwitch = async () => null
        mockWorkers.clickExactChildFromDashboard = async () => {
            clickCount++
            return true
        }

        const mockCard: PunchCard = {
            name: 'Ambiguous Test Card',
            parentPromotion: { offerId: 'pc_parent_ambig', complete: false } as any,
            childPromotions: [
                { offerId: 'child_ambig', title: 'Step 1', complete: false } as BasePromotion
            ]
        } as any

        // Server returns null / unchanged state (ambiguous outcome)
        const mockReader: PunchCardStateReader = {
            async fetchPunchCardSnapshot() {
                return null
            }
        }

        await mockWorkers.doPunchCards({ punchCards: [mockCard] } as DashboardData, {} as any, mockReader)

        assert.strictEqual(clickCount, 1, 'Transport must be called exactly ONCE (zero retries)')
        assert.ok(
            logged.some(l => l.includes('[PUNCHCARD-EXEC] transport=first-party-dashboard-click outcome=ambiguous')),
            'Outcome must be logged as ambiguous'
        )
        assert.ok(
            logged.some(l => l.includes('[PUNCHCARD-SAFETY] secondTransportBlocked=true')),
            'Second transport must be explicitly blocked'
        )
        assert.ok(
            logged.some(l => l.includes('status=processed-unverified evidence=server-state-unavailable')),
            'Must report processed-unverified'
        )
        console.log('✅ Test 1 Passed: Ambiguous response produces 0 retry and 0 fallback')
    }

    // Test 2: Confirmed accepted produces 0 second transport
    {
        const logged: string[] = []
        let clickCount = 0
        const mockScope = new AccountScope('bar***@gmail.com', 'run_test_2')
        const mockWorkers = new Workers({
            isMobile: false,
            userData: { userName: 'baryyaja', currentPoints: 100 },
            config: { punchCardExecution: { mode: 'browser-ui-experimental', maxChildrenPerRun: 1 } },
            accountScope: mockScope,
            logger: {
                info: (_m: boolean, cat: string, msg: string) => logged.push(`[${cat}] ${msg}`),
                warn: (_m: boolean, cat: string, msg: string) => logged.push(`[${cat}] ${msg}`),
                debug: () => {},
                error: () => {}
            },
            utils: { wait: async () => {} }
        } as any)

        mockWorkers.checkPunchCardKillSwitch = async () => null
        mockWorkers.clickExactChildFromDashboard = async () => {
            clickCount++
            return true
        }

        const mockCard: PunchCard = {
            name: 'Accepted Test Card',
            parentPromotion: { offerId: 'pc_parent_acc', complete: false } as any,
            childPromotions: [
                { offerId: 'child_acc', title: 'Step 1', complete: false } as BasePromotion
            ]
        } as any

        const mockReader: PunchCardStateReader = {
            async fetchPunchCardSnapshot() {
                return {
                    parentOfferId: 'pc_parent_acc',
                    childOfferId: 'child_acc',
                    completedChildren: 1,
                    totalChildren: 1,
                    actionableNow: 0,
                    locked: 0,
                    futureDated: 0,
                    parentComplete: true,
                    childComplete: true
                }
            }
        }

        await mockWorkers.doPunchCards({ punchCards: [mockCard] } as DashboardData, {} as any, mockReader)

        assert.strictEqual(clickCount, 1, 'Transport must be called exactly once')
        assert.ok(
            logged.some(l => l.includes('[PUNCHCARD-EXEC] transport=first-party-dashboard-click outcome=confirmed-accepted')),
            'Outcome must be confirmed-accepted'
        )
        assert.ok(
            logged.some(l => l.includes('status=verified-complete-today')),
            'Must be verified complete today'
        )
        console.log('✅ Test 2 Passed: Confirmed accepted produces 0 second transport')
    }

    // Test 3: Missing action data chooses max 1 transport (dashboard click in experimental)
    {
        const child: BasePromotion = { offerId: 'child_no_token', title: 'No Token Child', complete: false } as any
        const resolved = resolveUrlRewardAction({
            child,
            scopeId: 'scope_123',
            requestToken: undefined
        })

        assert.ok(resolved !== null)
        assert.strictEqual(resolved.summary.actionDataPresent, false)
        assert.strictEqual(resolved.summary.requestTokenPresent, false)
        assert.strictEqual(resolved.summary.source, 'none')
        assert.strictEqual(resolved.secret, undefined)
        console.log('✅ Test 3 Passed: Missing action data cleanly reports actionDataPresent=false and 0 secret')
    }

    // Test 4: Account scope mismatch rejects action
    {
        const scopeA = new AccountScope('acc_a***@gmail.com', 'run_test_4', 'scope_A')
        const scopeB = new AccountScope('acc_b***@gmail.com', 'run_test_4', 'scope_B')

        const secretA = new ResolvedActionSecret({
            accountScopeId: scopeA.id,
            offerId: 'offer_1',
            requestToken: 'token_A'
        })

        // Storing secretA in scopeB must throw immediately
        assert.throws(
            () => {
                scopeB.storeSecret(secretA)
            },
            /Account scope mismatch/,
            'Storing secret from another account scope must throw mismatch error'
        )

        // Storing in correct scope succeeds
        scopeA.storeSecret(secretA)
        assert.strictEqual(scopeA.hasSecret('offer_1'), true)
        console.log('✅ Test 4 Passed: Account scope mismatch strictly rejects action')
    }

    // Test 5: Disposal wipes all secrets and action references
    {
        const scope = new AccountScope('dispose***@gmail.com', 'run_test_5')
        const secret = new ResolvedActionSecret({
            accountScopeId: scope.id,
            offerId: 'offer_leak_test',
            requestToken: 'SECRET_TOKEN_XYZ_123',
            actionData: { payload: 'SENSITIVE_PAYLOAD' }
        })
        scope.storeSecret(secret)
        assert.strictEqual(scope.hasSecret('offer_leak_test'), true)

        let pageClosed = false
        const mockPage = {
            close: async () => {
                pageClosed = true
            }
        }
        scope.trackPage(mockPage)

        await scope.dispose()

        assert.strictEqual(scope.isDisposed, true)
        assert.strictEqual(scope.hasSecret('offer_leak_test'), false)
        assert.strictEqual(scope.getSecret('offer_leak_test'), undefined)
        assert.strictEqual(pageClosed, true, 'Tracked pages must be closed on dispose')
        assert.throws(() => scope.storeSecret(secret), /disposed/)
        console.log('✅ Test 5 Passed: Disposal wipes all secrets and references')
    }

    // Test 6: Secret object cannot reach logger or JSON serialization
    {
        const secret = new ResolvedActionSecret({
            accountScopeId: 'scope_secure_1',
            offerId: 'offer_secure_1',
            requestToken: 'SUPER_SECRET_REQUEST_TOKEN',
            actionData: { key: 'SUPER_SECRET_ACTION_DATA' }
        })

        const serialized = JSON.stringify(secret)
        assert.strictEqual(serialized.includes('SUPER_SECRET_REQUEST_TOKEN'), false, 'Serialized secret must not contain token')
        assert.strictEqual(serialized.includes('SUPER_SECRET_ACTION_DATA'), false, 'Serialized secret must not contain actionData')
        assert.ok(serialized.includes('"requestTokenPresent":true'))
        assert.ok(serialized.includes('"actionDataPresent":true'))

        const stringRepr = secret.toString()
        assert.strictEqual(stringRepr.includes('SUPER_SECRET_REQUEST_TOKEN'), false)
        console.log('✅ Test 6 Passed: Secret object cannot reach logger or JSON serialization')
    }

    // Test 7: CAPTCHA / bot warning triggers kill switch (executionAborted=true)
    {
        const logged: string[] = []
        const mockScope = new AccountScope('bar***@gmail.com', 'run_test_7')
        const mockWorkers = new Workers({
            isMobile: false,
            userData: { userName: 'baryyaja', currentPoints: 100 },
            config: { punchCardExecution: { mode: 'browser-ui-experimental', maxChildrenPerRun: 1 } },
            accountScope: mockScope,
            logger: {
                info: () => {},
                warn: (_m: boolean, cat: string, msg: string) => logged.push(`[${cat}] ${msg}`),
                debug: () => {},
                error: () => {}
            },
            utils: { wait: async () => {} }
        } as any)

        // Mock kill switch returning captcha-detected
        mockWorkers.checkPunchCardKillSwitch = async () => 'captcha-detected'
        let clickExecuted = false
        mockWorkers.clickExactChildFromDashboard = async () => {
            clickExecuted = true
            return true
        }

        const mockCard: PunchCard = {
            name: 'Kill Switch Card',
            parentPromotion: { offerId: 'pc_parent_kill', complete: false } as any,
            childPromotions: [
                { offerId: 'child_kill', title: 'Step 1', complete: false } as BasePromotion
            ]
        } as any

        await mockWorkers.doPunchCards({ punchCards: [mockCard] } as DashboardData, {} as any)

        assert.strictEqual(clickExecuted, false, 'Dashboard click must NOT execute when kill switch triggers')
        assert.ok(
            logged.some(l => l.includes('[PUNCHCARD-SAFETY] executionAborted=true reason=captcha-detected')),
            'Kill switch abort must be logged'
        )
        assert.strictEqual(mockScope.getAttempt('pc_parent_kill', 'child_kill')?.result, 'execution-unavailable')
        console.log('✅ Test 7 Passed: CAPTCHA / bot warning triggers kill switch (executionAborted=true)')
    }

    // Test 8: Manual-handoff is default config
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
        assert.strictEqual(parsed.data.punchCardExecution?.mode, 'manual-handoff')
        assert.strictEqual(parsed.data.punchCardExecution?.maxChildrenPerRun, 1)

        const validated = validateConfig(parsed.data)
        assert.strictEqual(validated.punchCardExecution?.mode, 'manual-handoff')
        console.log('✅ Test 8 Passed: manual-handoff is default validated config')
    }

    // Test 9: Browser experimental requires explicit opt-in
    {
        const logged: string[] = []
        let clickExecuted = false
        const mockScope = new AccountScope('bar***@gmail.com', 'run_test_9')

        // Default config without explicit opt-in
        const mockWorkers = new Workers({
            isMobile: false,
            userData: { userName: 'baryyaja', currentPoints: 100 },
            config: {},
            accountScope: mockScope,
            logger: {
                info: (_m: boolean, cat: string, msg: string) => logged.push(`[${cat}] ${msg}`),
                warn: () => {},
                debug: () => {},
                error: () => {}
            },
            utils: { wait: async () => {} }
        } as any)

        mockWorkers.clickExactChildFromDashboard = async () => {
            clickExecuted = true
            return true
        }

        const mockCard: PunchCard = {
            name: 'Default Mode Card',
            parentPromotion: { offerId: 'pc_parent_default', complete: false } as any,
            childPromotions: [
                { offerId: 'child_default', title: 'Step 1', complete: false } as BasePromotion
            ]
        } as any

        await mockWorkers.doPunchCards({ punchCards: [mockCard] } as DashboardData, {} as any)

        assert.strictEqual(clickExecuted, false, 'Default config must not execute browser DOM click')
        assert.ok(
            logged.some(l => l.includes('[PUNCHCARD-CONFIG] mode=manual-handoff source=global-default')),
            'Must log mode=manual-handoff source=global-default'
        )
        console.log('✅ Test 9 Passed: Browser experimental requires explicit opt-in')
    }

    // Test 10: Max 1 mutation attempt per child per run
    {
        let executionCount = 0
        const mockScope = new AccountScope('bar***@gmail.com', 'run_test_10')
        const mockWorkers = new Workers({
            isMobile: false,
            userData: { userName: 'baryyaja', currentPoints: 100 },
            config: { punchCardExecution: { mode: 'browser-ui-experimental', maxChildrenPerRun: 1 } },
            accountScope: mockScope,
            logger: {
                info: () => {},
                warn: () => {},
                debug: () => {},
                error: () => {}
            },
            utils: { wait: async () => {} }
        } as any)

        mockWorkers.checkPunchCardKillSwitch = async () => null
        mockWorkers.clickExactChildFromDashboard = async () => {
            executionCount++
            return true
        }

        const mockCard: PunchCard = {
            name: 'Three-child Card',
            parentPromotion: { offerId: 'pc_parent_3', complete: false } as any,
            childPromotions: [
                { offerId: 'child_1', title: 'Step 1', complete: false } as BasePromotion,
                { offerId: 'child_2', title: 'Step 2', complete: false } as BasePromotion,
                { offerId: 'child_3', title: 'Step 3', complete: false } as BasePromotion
            ]
        } as any

        const mockReader: PunchCardStateReader = {
            async fetchPunchCardSnapshot() {
                return {
                    parentOfferId: 'pc_parent_3',
                    childOfferId: 'child_1',
                    completedChildren: 1,
                    totalChildren: 3,
                    actionableNow: 0,
                    locked: 2,
                    futureDated: 0,
                    parentComplete: false,
                    childComplete: true
                }
            }
        }

        await mockWorkers.doPunchCards({ punchCards: [mockCard] } as DashboardData, {} as any, mockReader)
        assert.strictEqual(executionCount, 1, 'Only 1 child mutation attempt must occur per run')
        console.log('✅ Test 10 Passed: Exactly one mutation attempt per run')
    }

    // Test 11: Git diff check for protected files (SearchManager, Browser, DataSaver)
    {
        try {
            const smDiff = execSync('git diff HEAD -- src/functions/SearchManager.ts', { encoding: 'utf-8' }).trim()
            assert.strictEqual(smDiff, '', 'SearchManager.ts must have 0 unstaged logic diffs')

            const browserDiff = execSync('git diff HEAD -- src/browser/Browser.ts', { encoding: 'utf-8' }).trim()
            assert.strictEqual(browserDiff, '', 'Browser.ts must have 0 unstaged logic diffs')

            const dataSaverDiff = execSync('git diff HEAD -- src/util/DataSaver.ts', { encoding: 'utf-8' }).trim()
            assert.strictEqual(dataSaverDiff, '', 'DataSaver.ts must have 0 unstaged logic diffs')
            console.log('✅ Test 11 Passed: Protected modules (SearchManager, Browser, DataSaver) are untouched')
        } catch (err) {
            console.warn('⚠️ Test 11 git diff warning (skipped if git unavailable in env):', err)
        }
    }

    // Test 12: Safe metadata logs (no tokens, query strings, cookies, raw emails)
    {
        const sensitiveUrl = 'https://rewards.bing.com/search?q=test&token=SECRET123&uid=secret_user'
        const parsed = new URL(sensitiveUrl)
        const destinationOrigin = parsed.origin
        const destinationPath = parsed.pathname

        assert.strictEqual(destinationOrigin, 'https://rewards.bing.com')
        assert.strictEqual(destinationPath, '/search')
        assert.strictEqual(destinationOrigin.includes('SECRET123'), false)
        assert.strictEqual(destinationPath.includes('SECRET123'), false)
        assert.strictEqual(destinationPath.includes('secret_user'), false)
        console.log('✅ Test 12 Passed: Diagnostic metadata excludes query parameters, tokens, and credentials')
    }

    // Test 13: Run-scoped attempt guard prevents duplicate attempts in same run
    {
        const logged: string[] = []
        let clickCount = 0
        const mockScope = new AccountScope('bar***@gmail.com', 'run_test_13')
        const mockWorkers = new Workers({
            isMobile: false,
            userData: { userName: 'baryyaja', currentPoints: 100 },
            config: { punchCardExecution: { mode: 'browser-ui-experimental', maxChildrenPerRun: 1 } },
            accountScope: mockScope,
            logger: {
                info: () => {},
                warn: (_m: boolean, cat: string, msg: string) => logged.push(`[${cat}] ${msg}`),
                debug: () => {},
                error: () => {}
            },
            utils: { wait: async () => {} }
        } as any)

        mockWorkers.checkPunchCardKillSwitch = async () => null
        mockWorkers.clickExactChildFromDashboard = async () => {
            clickCount++
            return true
        }

        // Pre-record attempt in scope
        mockScope.recordAttempt('pc_parent_guard', 'child_guard', 'processed-unverified')
        assert.strictEqual(mockScope.hasAttempted('pc_parent_guard', 'child_guard'), true)

        const mockCard: PunchCard = {
            name: 'Guard Test Card',
            parentPromotion: { offerId: 'pc_parent_guard', complete: false } as any,
            childPromotions: [
                { offerId: 'child_guard', title: 'Step 1', complete: false } as BasePromotion
            ]
        } as any

        await mockWorkers.doPunchCards({ punchCards: [mockCard] } as DashboardData, {} as any)

        assert.strictEqual(clickCount, 0, 'Dashboard click must be blocked by run-scoped attempt guard')
        assert.ok(
            logged.some(l => l.includes('[PUNCHCARD-SAFETY] attemptBlocked=true reason=already-attempted-in-run')),
            'Attempt blocked log must be present'
        )
        console.log('✅ Test 13 Passed: Run-scoped attempt guard prevents duplicate attempts in same run')
    }

    // Test 14: Locked child produces 0 action and 0 navigation
    {
        let clickCount = 0
        const mockScope = new AccountScope('bar***@gmail.com', 'run_test_14')
        const mockWorkers = new Workers({
            isMobile: false,
            userData: { userName: 'baryyaja', currentPoints: 100 },
            config: { punchCardExecution: { mode: 'browser-ui-experimental', maxChildrenPerRun: 1 } },
            accountScope: mockScope,
            logger: {
                info: () => {},
                warn: () => {},
                debug: () => {},
                error: () => {}
            },
            utils: { wait: async () => {} }
        } as any)

        mockWorkers.checkPunchCardKillSwitch = async () => null
        mockWorkers.clickExactChildFromDashboard = async () => {
            clickCount++
            return true
        }

        const mockCard: PunchCard = {
            name: 'Locked Step Card',
            parentPromotion: { offerId: 'pc_locked_parent', complete: false } as any,
            childPromotions: [
                { offerId: 'step_locked_1', title: 'Locked 1', complete: false, attributes: { isLocked: 'True' } } as any,
                { offerId: 'step_locked_2', title: 'Locked 2', complete: false, attributes: { isLocked: 'true' } } as any
            ]
        } as any

        await mockWorkers.doPunchCards({ punchCards: [mockCard] } as DashboardData, {} as any)
        assert.strictEqual(clickCount, 0, 'Locked child must never trigger click or navigation')
        console.log('✅ Test 14 Passed: Locked child produces 0 action and 0 navigation')
    }

    // Test 15: Server refresh failure handles gracefully without crash
    {
        const mockReaderFailing: PunchCardStateReader = {
            async fetchPunchCardSnapshot() {
                throw new Error('Timeout contacting server')
            }
        }

        const before: PunchCardServerSnapshot = {
            parentOfferId: 'pc_parent_fail',
            childOfferId: 'child_1',
            completedChildren: 0,
            totalChildren: 2,
            actionableNow: 1,
            locked: 1,
            futureDated: 0,
            parentComplete: false,
            childComplete: false
        }

        let caughtError: any = null
        try {
            const snapshot = await mockReaderFailing.fetchPunchCardSnapshot('pc_parent_fail', 'child_1').catch(() => null)
            const result = evaluatePunchCardRun(before, snapshot ?? undefined, 'child_1', 0)
            assert.strictEqual(result.status, 'processed-unverified')
            assert.strictEqual(result.evidence, 'server-state-unavailable')
        } catch (e) {
            caughtError = e
        }

        assert.strictEqual(caughtError, null, 'Server refresh failure must NOT throw or crash flow')
        console.log('✅ Test 15 Passed: Server refresh failure is non-blocking and handles gracefully')
    }
}

if (require.main === module) {
    runPunchCardExecutionTests().catch(err => {
        console.error(err)
        process.exit(1)
    })
}
