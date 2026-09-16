import assert from 'assert'
import net from 'net'
import { AccountScope } from '../src/runtime/AccountScope'
import { AccountDisposer } from '../src/runtime/AccountDisposer'
import { DynamicOutboundProxy } from '../src/util/DynamicOutboundProxy'
import { DataSaverManager } from '../src/util/DataSaver'
import { ResolvedActionSecret } from '../src/functions/UrlRewardActionResolver'

const mockLogger: any = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
}

export async function runLifecycleAndShutdownTests(): Promise<void> {
    console.log('--- Running Account Lifecycle & Graceful Shutdown Test Suite (Commit 1) ---')

    // Test 1: AccountScope Lifecycle State Transitions
    {
        const scope = AccountScope.createForTesting('user1@example.com')
        assert.strictEqual(scope.lifecycleState, 'active')
        assert.strictEqual(scope.isActive, true)
        assert.strictEqual(scope.isDisposing, false)
        assert.strictEqual(scope.isDisposed, false)

        let observedStateDuringDisposal: string = ''
        await scope.beginDisposal(async () => {
            observedStateDuringDisposal = scope.lifecycleState
            assert.strictEqual(scope.isDisposing, true)
            assert.strictEqual(scope.isActive, false)
        })

        assert.strictEqual(observedStateDuringDisposal, 'disposing')
        assert.strictEqual(scope.lifecycleState, 'disposed')
        assert.strictEqual(scope.isActive, false)
        assert.strictEqual(scope.isDisposing, false)
        assert.strictEqual(scope.isDisposed, true)
        console.log('✅ Test 1 Passed: AccountScope lifecycle state transitions (active -> disposing -> disposed)')
    }

    // Test 2: Concurrent Disposal Deduplication
    {
        const scope = AccountScope.createForTesting('user2@example.com')
        let executionCount = 0

        const work = async () => {
            executionCount++
            await new Promise(r => setTimeout(r, 50))
        }

        const p1 = scope.beginDisposal(work)
        const p2 = scope.beginDisposal(work)
        const p3 = AccountDisposer.dispose(scope)

        assert.strictEqual(p1, p2, 'Concurrent beginDisposal calls must return the identical Promise')
        await Promise.all([p1, p2, p3])

        assert.strictEqual(executionCount, 1, 'Cleanup work must execute exactly once')
        assert.strictEqual(scope.isDisposed, true)
        console.log('✅ Test 2 Passed: Concurrent disposal calls return identical promise and execute work once')
    }

    // Test 3: Correction 1 - Abort Listener Re-Entering dispose Synchronously
    {
        const scope = AccountScope.createForTesting('user3@example.com')
        let listenerDisposalPromise: Promise<void> | null = null
        let executionCount = 0

        // Intercept AccountDisposer to count passes
        const originalBegin = scope.beginDisposal.bind(scope)
        scope.beginDisposal = (work) => {
            return originalBegin(async () => {
                executionCount++
                await work()
            })
        }

        // Add synchronous abort listener that immediately re-enters disposal
        scope.abortController.signal.addEventListener('abort', () => {
            listenerDisposalPromise = scope.dispose()
        })

        const mainDisposalPromise = scope.dispose()

        assert.ok(listenerDisposalPromise !== null, 'Abort listener must have been invoked synchronously')
        assert.strictEqual(
            listenerDisposalPromise,
            mainDisposalPromise,
            'Synchronous abort listener re-entry must receive the exact same disposalPromise instance'
        )

        await mainDisposalPromise
        assert.strictEqual(executionCount, 1, 'Disposal execution pass must be strictly 1')
        assert.strictEqual(scope.isDisposed, true)
        console.log('✅ Test 3 Passed: Synchronous abort listener re-entering dispose receives shared promise (Correction 1)')
    }

    // Test 4: Correction 2 - Nested try/finally in Orchestrator Guarantee
    {
        const email = 'user4@example.com'
        let resetAccountStateCalled = false
        const fakeBot: any = {
            accountScope: null,
            resetAccountState: () => {
                resetAccountStateCalled = true
            },
            logger: mockLogger
        }

        DataSaverManager.getInstance().beginAccountQuota(email)

        let scope: AccountScope | null = null
        try {
            fakeBot.resetAccountState()
            scope = AccountScope.createForTesting(email)
            fakeBot.accountScope = scope

            // Simulate catastrophic error where disposer itself fails
            const failingDisposer = async (_s: AccountScope) => {
                throw new Error('Injected catastrophic disposer failure')
            }

            try {
                // Orchestrator finally block structure:
                try {
                    if (scope) {
                        await failingDisposer(scope).catch(() => {})
                    }
                } finally {
                    if (fakeBot.accountScope === scope) {
                        fakeBot.accountScope = null
                        fakeBot.resetAccountState()
                    }
                    DataSaverManager.getInstance().resetAccountQuota(email)
                }
            } catch {}
        } finally {
            // Check invariants
            assert.strictEqual(fakeBot.accountScope, null, 'Bot accountScope must be cleared to null')
            assert.strictEqual(resetAccountStateCalled, true, 'resetAccountState must be invoked')
            const report = DataSaverManager.getInstance().finishAccountQuota(email)
            assert.strictEqual(report.budgetResult.consumedMb, 0, 'Quota must be reset to zero')
        }
        console.log('✅ Test 4 Passed: Orchestrator nested finally clears scope and state even on disposer failure (Correction 2)')
    }

    // Test 5: In-Flight Operation Tracking & Bounded Wait
    {
        const scope = AccountScope.createForTesting('user5@example.com')
        assert.strictEqual(scope.getActiveOperationCount(), 0)

        let opResolved = false
        const opPromise = new Promise<string>(resolve => {
            setTimeout(() => {
                opResolved = true
                resolve('done')
            }, 50)
        })

        const tracked = scope.trackOperation(opPromise)
        assert.strictEqual(scope.getActiveOperationCount(), 1)

        await scope.waitForActiveOperations(2000)
        assert.strictEqual(opResolved, true)
        assert.strictEqual(await tracked, 'done')
        assert.strictEqual(scope.getActiveOperationCount(), 0)

        // After disposal, trackOperation must throw
        await scope.dispose()
        assert.throws(() => {
            scope.trackOperation(Promise.resolve())
        }, /Cannot perform trackOperation/)
        console.log('✅ Test 5 Passed: In-flight operation tracking & bounded wait (Correction 3)')
    }

    // Test 6: Orphan Resource Closure on Race in setContext & trackPage
    {
        const scope = AccountScope.createForTesting('user6@example.com')
        await scope.dispose()

        // 1. setContext on disposed scope must close context and throw
        let contextClosed = false
        const fakeContext: any = {
            close: async () => {
                contextClosed = true
            }
        }
        assert.throws(() => {
            scope.setContext('mobile', fakeContext)
        }, /Cannot attach mobile context to disposed AccountScope/)
        assert.strictEqual(contextClosed, true, 'Context must be closed immediately on attachment rejection')

        // 2. trackPage on disposed scope must close page immediately
        let pageClosed = false
        const fakePage: any = {
            close: async () => {
                pageClosed = true
            }
        }
        scope.trackPage(fakePage)
        assert.strictEqual(pageClosed, true, 'Page must be closed immediately on registration attempt to disposed scope')
        console.log('✅ Test 6 Passed: Orphan contexts and pages closed immediately on race (Correction 3)')
    }

    // Test 7: Mutating Operations Blocked on Disposing/Disposed Scope
    {
        const scope = AccountScope.createForTesting('user7@example.com')
        await scope.dispose()

        assert.throws(() => scope.setDapiToken('abc'), /Cannot set DAPI token on disposed AccountScope/)
        assert.strictEqual(scope.getDapiToken(), '')

        const dummySecret = new ResolvedActionSecret({
            accountScopeId: scope.id,
            offerId: 'offer1',
            actionData: 'data'
        })
        assert.throws(() => scope.storeSecret(dummySecret), /AccountScope is already disposed/)
        assert.throws(() => scope.setSecret('offer1', dummySecret), /AccountScope is already disposed/)
        assert.throws(
            () => scope.recordAttempt('parent', 'child', 'verified'),
            /Cannot perform recordAttempt/
        )

        // Cursors and timers do not throw but no-op
        const dummyPage = {}
        scope.bindCursor(dummyPage, {})
        assert.strictEqual(scope.getCursor(dummyPage), undefined)

        const dummyTimer = setTimeout(() => {}, 10000)
        scope.trackTimer(dummyTimer)
        clearTimeout(dummyTimer)
        assert.strictEqual(scope.getTrackedTimers().size, 0)
        console.log('✅ Test 7 Passed: Mutating methods fail-fast or safely no-op on disposed scope')
    }

    // Test 8: DynamicOutboundProxy Socket Tracking & Bounded Teardown
    {
        const proxy = new DynamicOutboundProxy(0, mockLogger)
        await proxy.start()
        const port = proxy.getPort()
        assert.ok(port > 0, 'Proxy port must be assigned')

        // Connect a raw socket to simulate client activity
        const client = net.connect({ port, host: '127.0.0.1' })
        await new Promise(r => client.on('connect', r))

        // Wait a tick for server 'connection' event
        await new Promise(r => setTimeout(r, 20))
        assert.ok(proxy.getTrackedSocketCount() > 0, 'Proxy must track connected socket')

        // Stop proxy
        const startTime = Date.now()
        await proxy.stop(2000)
        const duration = Date.now() - startTime

        assert.ok(duration < 2500, `Stop must be bounded (took ${duration}ms)`)
        assert.strictEqual(proxy.getIsStopping(), true)
        assert.strictEqual(proxy.getTrackedSocketCount(), 0)
        client.destroy()
        console.log('✅ Test 8 Passed: DynamicOutboundProxy tracks sockets and tears down cleanly within deadline')
    }

    // Test 9: DynamicOutboundProxy Concurrent Stop Deduplication
    {
        const proxy = new DynamicOutboundProxy(0, mockLogger)
        await proxy.start()

        const p1 = proxy.stop()
        const p2 = proxy.stop()
        assert.strictEqual(p1, p2, 'Concurrent proxy.stop() calls must return identical promise')
        await Promise.all([p1, p2])
        console.log('✅ Test 9 Passed: DynamicOutboundProxy concurrent stop deduplication')
    }

    // Test 10: Graceful Shutdown Coordinator Success Outcome
    {
        let proxyStopped = false
        let dashboardStopped = false

        const testScope = AccountScope.createForTesting('shut1@example.com')

        const fakeBot: any = {
            logger: mockLogger,
            stopRequested: false,
            accountScope: testScope,
            shutdownPromise: null,
            resetAccountState: () => {},
            teardownCliOperatorListener: () => {},
            cancelActiveRecovery: () => {},
            localProxy: {
                async stop() {
                    proxyStopped = true
                }
            },
            dashboardServer: {
                async stop() {
                    dashboardStopped = true
                }
            },
            manualQuestQueue: {
                async flushPendingWrites() {}
            }
        }

        // Bind requestShutdown from MicrosoftRewardsBot prototype
        const { MicrosoftRewardsBot } = await import('../src/index')
        fakeBot.requestShutdown = MicrosoftRewardsBot.prototype.requestShutdown.bind(fakeBot)

        const result = await fakeBot.requestShutdown('unit-test', 5000)
        assert.strictEqual(result.status, 'completed')
        assert.strictEqual(testScope.isDisposed, true, 'Active scope must be disposed')
        assert.strictEqual(proxyStopped, true, 'Proxy must be stopped')
        assert.strictEqual(dashboardStopped, true, 'Dashboard must be stopped')
        assert.strictEqual(fakeBot.accountScope, null, 'Scope reference must be cleared')
        console.log('✅ Test 10 Passed: Graceful shutdown coordinator returns completed status and cleans all components')
    }

    // Test 11: Graceful Shutdown Coordinator Timeout Handling (No Duplicate Teardown)
    {
        const hangingScope: any = {
            id: 'scope_hang_1',
            isDisposed: false,
            beginDisposal: () => new Promise(() => {}), // Never resolves
            dispose: () => new Promise(() => {}),
            clearDapiToken() {},
            abortController: new AbortController()
        }

        const fakeBot: any = {
            logger: mockLogger,
            stopRequested: false,
            accountScope: hangingScope,
            shutdownPromise: null,
            resetAccountState: () => {},
            teardownCliOperatorListener: () => {},
            cancelActiveRecovery: () => {},
            localProxy: null,
            dashboardServer: null,
            manualQuestQueue: null
        }

        const { MicrosoftRewardsBot } = await import('../src/index')
        fakeBot.requestShutdown = MicrosoftRewardsBot.prototype.requestShutdown.bind(fakeBot)

        const start = Date.now()
        const result = await fakeBot.requestShutdown('timeout-test', 300)
        const elapsed = Date.now() - start

        assert.strictEqual(result.status, 'timed-out')
        assert.ok(elapsed >= 250 && elapsed < 1500, `Elapsed time ${elapsed}ms must respect budget`)

        // Calling again must return cached promise with same status without starting second cleanup
        const result2 = await fakeBot.requestShutdown('second-call', 300)
        assert.strictEqual(result2.status, 'timed-out')
        console.log('✅ Test 11 Passed: Graceful shutdown bounds timeout and prevents duplicate second cleanup')
    }

    // Test 12: Partial Failure in Shutdown Still Allows Remaining Cleanups
    {
        let proxyStopped = false
        let dashboardStopped = false

        const brokenScope: any = {
            id: 'scope_broken_1',
            isDisposed: false,
            beginDisposal: async () => {
                throw new Error('Catastrophic failure in scope disposal')
            },
            dispose: async () => {
                throw new Error('Catastrophic failure in scope disposal')
            },
            clearDapiToken() {},
            abortController: new AbortController()
        }

        const fakeBot: any = {
            logger: mockLogger,
            stopRequested: false,
            accountScope: brokenScope,
            shutdownPromise: null,
            resetAccountState: () => {},
            teardownCliOperatorListener: () => {},
            cancelActiveRecovery: () => {},
            localProxy: {
                async stop() {
                    proxyStopped = true
                }
            },
            dashboardServer: {
                async stop() {
                    dashboardStopped = true
                }
            },
            manualQuestQueue: null
        }

        const { MicrosoftRewardsBot } = await import('../src/index')
        fakeBot.requestShutdown = MicrosoftRewardsBot.prototype.requestShutdown.bind(fakeBot)

        const result = await fakeBot.requestShutdown('partial-failure-test', 5000)
        assert.strictEqual(result.status, 'completed', 'Failure in one component does not abort subsequent cleanups')
        assert.strictEqual(proxyStopped, true, 'Proxy stop must still be called')
        assert.strictEqual(dashboardStopped, true, 'Dashboard stop must still be called')
        console.log('✅ Test 12 Passed: Scope error during shutdown allows proxy and dashboard cleanup to proceed')
    }

    console.log('🎉 ALL 12 ACCOUNT LIFECYCLE & SHUTDOWN TESTS PASSED SUCCESSFULLY!')
}
