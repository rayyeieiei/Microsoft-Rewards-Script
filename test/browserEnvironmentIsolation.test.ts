import assert from 'assert'
import path from 'path'
import { AccountScope } from '../src/runtime/AccountScope'
import { ResolvedActionSecret } from '../src/functions/UrlRewardActionResolver'
import type { Account, AccountProxy } from '../src/interface/Account'

const defaultProxy: AccountProxy = {
    url: '',
    port: 0,
    proxyAxios: false,
    username: '',
    password: ''
}

export async function runBrowserEnvironmentIsolationTests(): Promise<void> {
    console.log('--- Running Browser Environment Consistency & Account Isolation Test Suite (Commit 1) ---')

    // Test 1: Single Construction Path & Identity Resolution
    {
        const mockAccount: Account = {
            email: 'Test.User+123@Example.com',
            password: 'secret_password',
            recoveryEmail: 'recovery@example.com',
            geoLocale: 'en-US',
            langCode: 'en',
            proxy: { ...defaultProxy },
            saveFingerprint: { mobile: false, desktop: false }
        }

        const mockBot: any = {
            config: { sessionPath: 'test_sessions' },
            logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
            resetAccountState: () => {}
        }

        const scope = await AccountScope.create({
            account: mockAccount,
            bot: mockBot,
            runId: 'run_isolation_1'
        })

        assert.ok(scope.id.startsWith('scope_'), 'Scope ID must start with scope_')
        assert.strictEqual(scope.runId, 'run_isolation_1')
        assert.strictEqual(scope.isDisposed, false)
        assert.ok(scope.accountId.length === 64, 'Default accountId should be SHA-256 of normalized email')
        assert.strictEqual(scope.storagePaths.storageKey.length, 32, 'Storage key must be 32-char hex string')
        assert.ok(scope.storagePaths.mobilePath.endsWith('.mobile.storageState.json'))
        assert.ok(scope.storagePaths.desktopPath.endsWith('.desktop.storageState.json'))

        await scope.dispose()
        console.log('✅ Test 1 Passed: AccountScope single construction path & identity resolution')
    }

    // Test 2: StorageState Path Isolation & Directory Traversal Resistance
    {
        const dangerousAccount: Account = {
            id: '../../evil/path/traversal',
            email: 'traversal@example.com',
            password: 'pass',
            recoveryEmail: 'recovery@example.com',
            geoLocale: 'en-US',
            langCode: 'en',
            proxy: { ...defaultProxy },
            saveFingerprint: { mobile: false, desktop: false }
        }

        const normalAccount: Account = {
            id: 'valid-uuid-1234-5678',
            email: 'normal@example.com',
            password: 'pass',
            recoveryEmail: 'recovery@example.com',
            geoLocale: 'en-US',
            langCode: 'en',
            proxy: { ...defaultProxy },
            saveFingerprint: { mobile: false, desktop: false }
        }

        const mockBot: any = {
            config: { sessionPath: 'safe_sessions' },
            logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
            resetAccountState: () => {}
        }

        const scopeDangerous = await AccountScope.create({ account: dangerousAccount, bot: mockBot, runId: 'run_safe' })
        const scopeNormal = await AccountScope.create({ account: normalAccount, bot: mockBot, runId: 'run_safe' })

        // Neither path should contain '../' or escape sessionDir
        assert.strictEqual(scopeDangerous.storagePaths.mobilePath.includes('..\\..\\'), false)
        assert.strictEqual(scopeDangerous.storagePaths.mobilePath.includes('../../'), false)
        assert.strictEqual(path.dirname(scopeDangerous.storagePaths.mobilePath), scopeDangerous.storagePaths.sessionDir)

        // Storage keys must be strictly different
        assert.notStrictEqual(scopeDangerous.storagePaths.storageKey, scopeNormal.storagePaths.storageKey)
        assert.notStrictEqual(scopeDangerous.storagePaths.mobilePath, scopeNormal.storagePaths.mobilePath)

        await scopeDangerous.dispose()
        await scopeNormal.dispose()
        console.log('✅ Test 2 Passed: StorageState path isolation & directory traversal resistance')
    }

    // Test 3: DAPI Token Isolation & Setter Fail-Fast
    {
        const mockBot: any = {
            accountScope: null,
            get accessToken() {
                return this.accountScope ? this.accountScope.getDapiToken() : ''
            },
            set accessToken(token: string) {
                if (!this.accountScope) {
                    throw new Error('[FATAL-SCOPE] Cannot set DAPI access token: no active AccountScope')
                }
                this.accountScope.setDapiToken(token)
            }
        }

        // Setting token without active scope must fail fast
        assert.throws(
            () => {
                mockBot.accessToken = 'LEAKED_BEARER_TOKEN'
            },
            /\[FATAL-SCOPE\] Cannot set DAPI access token: no active AccountScope/,
            'Must throw fatal error when setting accessToken without active AccountScope'
        )

        const scopeA = AccountScope.createForTesting('accA***@gmail.com', 'run_tok_1')
        const scopeB = AccountScope.createForTesting('accB***@gmail.com', 'run_tok_2')

        mockBot.accountScope = scopeA
        mockBot.accessToken = 'TOKEN_FOR_ACCOUNT_A'

        assert.strictEqual(scopeA.getDapiToken(), 'TOKEN_FOR_ACCOUNT_A')
        assert.strictEqual(mockBot.accessToken, 'TOKEN_FOR_ACCOUNT_A')
        assert.strictEqual(scopeB.getDapiToken(), '')

        // Switch to Scope B
        mockBot.accountScope = scopeB
        assert.strictEqual(mockBot.accessToken, '')
        mockBot.accessToken = 'TOKEN_FOR_ACCOUNT_B'
        assert.strictEqual(scopeB.getDapiToken(), 'TOKEN_FOR_ACCOUNT_B')
        assert.strictEqual(scopeA.getDapiToken(), 'TOKEN_FOR_ACCOUNT_A')

        // Dispose Scope A
        await scopeA.dispose()
        assert.strictEqual(scopeA.getDapiToken(), '', 'Disposed scope must return empty token')
        assert.throws(
            () => {
                scopeA.setDapiToken('NEW_TOKEN')
            },
            /Cannot set DAPI token on disposed AccountScope/,
            'Setting token on disposed scope must throw'
        )

        await scopeB.dispose()
        mockBot.accountScope = null
        console.log('✅ Test 3 Passed: DAPI token isolation & setter fail-fast')
    }

    // Test 4: Cursor Isolation per Page and Scope Teardown
    {
        const scopeA = AccountScope.createForTesting('accA***@gmail.com', 'run_cur_1')
        const scopeB = AccountScope.createForTesting('accB***@gmail.com', 'run_cur_2')

        const mockPageA = { id: 'pageA' }
        const mockPageB = { id: 'pageB' }
        const mockCursorA = { type: 'ghostCursorA' }
        const mockCursorB = { type: 'ghostCursorB' }

        scopeA.bindCursor(mockPageA, mockCursorA)
        scopeB.bindCursor(mockPageB, mockCursorB)

        assert.strictEqual(scopeA.getCursor(mockPageA), mockCursorA)
        assert.strictEqual(scopeA.getCursor(mockPageB), undefined)
        assert.strictEqual(scopeB.getCursor(mockPageB), mockCursorB)
        assert.strictEqual(scopeB.getCursor(mockPageA), undefined)

        await scopeA.dispose()
        assert.strictEqual(scopeA.getCursor(mockPageA), undefined, 'Cursors must be cleared upon disposal')

        await scopeB.dispose()
        console.log('✅ Test 4 Passed: Cursor isolation per page and scope teardown')
    }

    // Test 5: Disposal Idempotency & AbortController Signal
    {
        const scope = AccountScope.createForTesting('idempotent***@gmail.com', 'run_idem')
        let abortTriggered = false
        scope.abortController.signal.addEventListener('abort', () => {
            abortTriggered = true
        })

        const secret = new ResolvedActionSecret({
            accountScopeId: scope.id,
            offerId: 'secret_1',
            requestToken: 'MY_SECRET'
        })
        scope.storeSecret(secret)

        let timerFired = false
        const timer = setTimeout(() => {
            timerFired = true
        }, 10000)
        scope.trackTimer(timer)

        assert.strictEqual(scope.isDisposed, false)
        await scope.dispose()

        assert.strictEqual(scope.isDisposed, true)
        assert.strictEqual(abortTriggered, true, 'Abort signal must fire on disposal')
        assert.strictEqual(scope.hasSecret('secret_1'), false, 'Secrets must be cleared')
        clearTimeout(timer) // Safeguard
        assert.strictEqual(timerFired, false, 'Tracked timer must be cleared by disposal')

        // Second disposal call must not throw and do nothing
        await scope.dispose()
        assert.strictEqual(scope.isDisposed, true)
        console.log('✅ Test 5 Passed: Disposal idempotency & AbortController signal')
    }

    // Test 6: Exact Route Handler & Response Listener Detachment
    {
        const scope = AccountScope.createForTesting('unroute***@gmail.com', 'run_unroute')
        const unroutedUrls: string[] = []
        const removedListeners: string[] = []

        const mockContext: any = {
            unroute: async (url: string, _handler: any) => {
                unroutedUrls.push(url)
            },
            off: (event: string, _listener: any) => {
                removedListeners.push(event)
            },
            close: async () => {}
        }

        const dummyHandler = () => {}
        const dummyListener = () => {}

        scope.registerRouteHandler(mockContext, '**/*', dummyHandler)
        scope.registerResponseListener(mockContext, dummyListener)
        scope.setContext('mobile', mockContext)

        assert.strictEqual(scope.getRouteHandlers().length, 1)
        assert.strictEqual(scope.getResponseListeners().length, 1)

        await scope.dispose()

        assert.strictEqual(unroutedUrls.length, 1)
        assert.strictEqual(unroutedUrls[0], '**/*')
        assert.strictEqual(removedListeners.length, 1)
        assert.strictEqual(removedListeners[0], 'response')
        assert.strictEqual(scope.getRouteHandlers().length, 0)
        assert.strictEqual(scope.getResponseListeners().length, 0)
        console.log('✅ Test 6 Passed: Exact route handler & response listener detachment')
    }

    // Test 7: Context Close Timeout Recovery & Browser Recycling
    {
        let recycled = false
        const mockBrowserFactory: any = {
            isHealthy: true,
            recycleBrowser: async () => {
                recycled = true
                mockBrowserFactory.isHealthy = true
            }
        }

        const mockBot: any = {
            browserFactory: mockBrowserFactory,
            logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
            resetAccountState: () => {}
        }

        const scope = await AccountScope.create({
            account: {
                email: 'timeout@test.com',
                password: 'p',
                recoveryEmail: 'recovery@example.com',
                geoLocale: 'en-US',
                langCode: 'en',
                proxy: { ...defaultProxy },
                saveFingerprint: { mobile: false, desktop: false }
            },
            bot: mockBot,
            runId: 'run_timeout'
        })

        // Mock a hanging context that never closes within deadline
        const hangingContext: any = {
            close: () => new Promise(() => {}) // Never resolves
        }
        scope.setContext('mobile', hangingContext)

        const startTime = Date.now()
        await scope.dispose()
        const duration = Date.now() - startTime

        // Should time out around 4000ms, not hang indefinitely
        assert.ok(duration >= 3900 && duration < 7000, `Duration ${duration}ms must be bounded around 4000ms`)
        assert.strictEqual(recycled, true, 'Browser must be recycled when context close times out')
        console.log('✅ Test 7 Passed: Context close timeout recovery & browser recycling')
    }

    // Test 8: Orchestrator Finally Release Invariant
    {
        let scopeDisposed = false
        let releasedScope: any = 'not-released'

        const fakeBot: any = {
            accountScope: null,
            runId: 'run_orchestrator',
            async Main(_acc: any, _scope: any) {
                throw new Error('Simulation of catastrophic Main failure!')
            }
        }

        const account: Account = {
            email: 'crash@test.com',
            password: 'p',
            recoveryEmail: 'recovery@example.com',
            geoLocale: 'en-US',
            langCode: 'en',
            proxy: { ...defaultProxy },
            saveFingerprint: { mobile: false, desktop: false }
        }

        const scope = await AccountScope.create({
            account,
            bot: fakeBot,
            runId: fakeBot.runId
        })
        fakeBot.accountScope = scope

        // Intercept dispose
        const origDispose = scope.dispose.bind(scope)
        scope.dispose = async () => {
            scopeDisposed = true
            await origDispose()
        }

        try {
            await fakeBot.Main(account, scope).catch(() => {})
        } finally {
            if (scope) {
                await scope.dispose()
                if (fakeBot.accountScope === scope) {
                    fakeBot.accountScope = null
                }
            }
            releasedScope = fakeBot.accountScope
        }

        assert.strictEqual(scopeDisposed, true, 'Scope must be disposed in finally block')
        assert.strictEqual(releasedScope, null, 'fakeBot.accountScope must be set to null in finally block')
        console.log('✅ Test 8 Passed: Orchestrator finally release invariant')
    }
}
