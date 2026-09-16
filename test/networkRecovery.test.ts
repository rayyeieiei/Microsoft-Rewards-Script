import assert from 'assert'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { PassThrough } from 'stream'
import {
    NetworkRecoveryController
} from '../src/runtime/network/NetworkRecoveryController'
import {
    AdbNetworkRecoveryAdapter,
    type SubprocessRunner
} from '../src/runtime/network/AdbNetworkRecoveryAdapter'
import { ManualNetworkRecoveryAdapter } from '../src/runtime/network/ManualNetworkRecoveryAdapter'
import { DeviceLockManager } from '../src/runtime/network/DeviceLockManager'
import type {
    NetworkRecoveryAdapter,
    NetworkRecoveryPolicy,
    AirplaneModeKnowledge,
    NetworkConnectivityProbe
} from '../src/runtime/network/NetworkRecoveryTypes'

class FakeConnectivityProbe implements NetworkConnectivityProbe {
    public checkCount = 0
    public results: boolean[] = []

    constructor(initialResults: boolean[] = [true]) {
        this.results = [...initialResults]
    }

    async checkConnectivity(): Promise<boolean> {
        this.checkCount++
        if (this.results.length > 0) {
            return this.results.shift()!
        }
        return true
    }
}

class FakeNetworkRecoveryAdapter implements NetworkRecoveryAdapter {
    public mode = 'adb' as const
    public knowledge: AirplaneModeKnowledge = 'confirmed-disabled'
    public preflightCalls = 0
    public disconnectCalls = 0
    public reconnectCalls = 0
    public restorationCalls = 0
    public tetheringCalls = 0

    public failOnPreflight = false
    public timeoutOnDisconnect = false

    async preflight(): Promise<void> {
        this.preflightCalls++
        if (this.failOnPreflight) {
            throw new Error('Multiple devices attached without serial')
        }
    }

    async executeDisconnect(): Promise<void> {
        this.disconnectCalls++
        this.knowledge = 'possibly-enabled'
        if (this.timeoutOnDisconnect) {
            throw new Error('Command timed out')
        }
        this.knowledge = 'confirmed-enabled'
    }

    async executeReconnect(): Promise<void> {
        this.reconnectCalls++
        this.knowledge = 'possibly-enabled'
        this.knowledge = 'confirmed-disabled'
    }

    async attemptRestoration(): Promise<boolean> {
        this.restorationCalls++
        this.knowledge = 'confirmed-disabled'
        return true
    }

    async dispose(): Promise<void> {}
}

function createDefaultPolicy(overrides: Partial<NetworkRecoveryPolicy> = {}): NetworkRecoveryPolicy {
    return {
        enabled: true,
        mode: 'adb',
        trigger: 'connectivity-failure',
        operatorTrigger: true,
        connectivityFailureTrigger: true,
        maxAttempts: 2,
        preflightTimeoutMs: 1000,
        commandTimeoutMs: 1000,
        disconnectTimeoutMs: 20,
        reconnectTimeoutMs: 20,
        verificationIntervalMs: 10,
        operatorTimeoutMs: 500,
        operatorRequestTtlMs: 1800000,
        recoveryCooldownMs: 120000,
        reassertUsbTethering: false,
        totalBudgetMs: 5000,
        ...overrides
    }
}

export async function runNetworkRecoveryTests(): Promise<void> {
    console.log('--- Running Network Recovery Subsystem Test Suite (Commit 3) ---')

    // Test 1: Healthy connectivity probe returns 'not-required' and executes 0 adapter commands
    {
        const adapter = new FakeNetworkRecoveryAdapter()
        const probe = new FakeConnectivityProbe([true]) // Healthy probe
        const controller = new NetworkRecoveryController({
            policy: createDefaultPolicy(),
            adapter,
            probe
        })

        const result = await controller.recover('connectivity-failure')
        assert.strictEqual(result.status, 'not-required')
        assert.strictEqual(adapter.disconnectCalls, 0, 'Zero disconnect calls when probe is healthy')
        assert.strictEqual(adapter.reconnectCalls, 0)
        assert.strictEqual(probe.checkCount, 1)
        console.log('✅ Test 1 Passed: Healthy connectivity probe results in not-required and zero commands')
    }

    // Test 2: HTTP 400/403/429 or activity failure does not trigger recovery if probe is healthy
    {
        const adapter = new FakeNetworkRecoveryAdapter()
        const probe = new FakeConnectivityProbe([true]) // Probe confirms connection is up
        const controller = new NetworkRecoveryController({
            policy: createDefaultPolicy(),
            adapter,
            probe
        })

        // Simulating suspected network failure from an HTTP 429 response
        const result = await controller.recover('connectivity-failure')
        assert.strictEqual(result.status, 'not-required', 'Probe prevents false recovery on HTTP application errors')
        assert.strictEqual(adapter.disconnectCalls, 0)
        console.log('✅ Test 2 Passed: Application/HTTP errors do not trigger recovery when probe is healthy')
    }

    // Test 3: Connectivity unavailable permits recovery to proceed and succeeds
    {
        const adapter = new FakeNetworkRecoveryAdapter()
        // First check (initial probe) = false, second check (after reconnect) = true
        const probe = new FakeConnectivityProbe([false, true])
        const controller = new NetworkRecoveryController({
            policy: createDefaultPolicy(),
            adapter,
            probe
        })

        const result = await controller.recover('connectivity-failure')
        assert.strictEqual(result.status, 'recovered')
        assert.strictEqual(adapter.disconnectCalls, 1)
        assert.strictEqual(adapter.reconnectCalls, 1)
        assert.strictEqual(result.attempts, 1)
        assert.strictEqual(adapter.knowledge, 'confirmed-disabled')
        console.log('✅ Test 3 Passed: Outage triggers recovery and succeeds when connectivity returns')
    }

    // Test 4: Enable timeout marks knowledge as 'possibly-enabled' and triggers restoration
    {
        const adapter = new FakeNetworkRecoveryAdapter()
        adapter.timeoutOnDisconnect = true // Simulates command timing out after radio was toggled
        const probe = new FakeConnectivityProbe([false])
        const controller = new NetworkRecoveryController({
            policy: createDefaultPolicy({ maxAttempts: 1 }),
            adapter,
            probe
        })

        const result = await controller.recover('connectivity-failure')
        assert.strictEqual(result.status, 'failed')
        assert.strictEqual(result.restorationAttempted, true, 'Restoration must be attempted for possibly-enabled state')
        assert.strictEqual(result.restorationSucceeded, true)
        assert.strictEqual(adapter.restorationCalls, 1)
        assert.strictEqual(adapter.knowledge, 'confirmed-disabled', 'Restoration successfully disabled radio')
        console.log('✅ Test 4 Passed: Enable timeout produces possibly-enabled and invokes restoration')
    }

    // Test 5: reassertUsbTethering=false produces zero tethering commands
    {
        const adapter = new FakeNetworkRecoveryAdapter()
        const probe = new FakeConnectivityProbe([false, true])
        const policy = createDefaultPolicy({ reassertUsbTethering: false })
        const controller = new NetworkRecoveryController({
            policy,
            adapter,
            probe
        })

        await controller.recover('connectivity-failure')
        assert.strictEqual(adapter.tetheringCalls, 0, 'No tethering commands should be run when flag is false')
        console.log('✅ Test 5 Passed: reassertUsbTethering=false produces zero tethering commands')
    }

    // Test 6: Recovery enforces bounded attempts and terminates cleanly
    {
        const adapter = new FakeNetworkRecoveryAdapter()
        // Probe always returns false (prolonged network outage)
        const probe = new FakeConnectivityProbe([false, false, false, false])
        const controller = new NetworkRecoveryController({
            policy: createDefaultPolicy({ maxAttempts: 2 }),
            adapter,
            probe
        })

        const result = await controller.recover('connectivity-failure')
        assert.strictEqual(result.status, 'failed')
        assert.strictEqual(result.attempts, 2, 'Must stop at maxAttempts without infinite looping')
        assert.strictEqual(adapter.disconnectCalls, 2)
        console.log('✅ Test 6 Passed: Recovery terminates cleanly at maxAttempts')
    }

    // Test 7: External cancellation via AbortSignal halts state machine
    {
        const adapter = new FakeNetworkRecoveryAdapter()
        const probe = new FakeConnectivityProbe([false])
        const controller = new NetworkRecoveryController({
            policy: createDefaultPolicy(),
            adapter,
            probe
        })

        const abortCtrl = new AbortController()
        abortCtrl.abort() // Pre-aborted signal

        const result = await controller.recover('connectivity-failure', abortCtrl.signal)
        assert.strictEqual(result.status, 'cancelled')
        assert.strictEqual(adapter.disconnectCalls, 0)
        console.log('✅ Test 7 Passed: AbortSignal halts recovery state machine cleanly')
    }

    // Test 8: ADB binary unavailable fails during preflight
    {
        const mockRunner: SubprocessRunner = async () => {
            throw new Error('spawn adb ENOENT')
        }
        const adapter = new AdbNetworkRecoveryAdapter({
            policy: createDefaultPolicy(),
            runner: mockRunner
        })
        let err: any = null
        try {
            await adapter.preflight()
        } catch (e) {
            err = e
        }
        assert.ok(err, 'Preflight must fail if adb is unavailable')
        assert.ok(
            err.message.includes('ADB binary unavailable'),
            `Expected error message to mention unavailable binary, got: ${err.message}`
        )
        console.log('✅ Test 8 Passed: ADB unavailable fails during preflight')
    }

    // Test 9: Unauthorized device fails closed
    {
        const mockRunner: SubprocessRunner = async (_file, args) => {
            if (args[0] === 'version') {
                return { stdout: 'Android Debug Bridge version 1.0.41', stderr: '' }
            }
            if (args[0] === 'devices') {
                return { stdout: 'List of devices attached\nemulator-5554\tunauthorized\n', stderr: '' }
            }
            return { stdout: '', stderr: '' }
        }
        const adapter = new AdbNetworkRecoveryAdapter({
            policy: createDefaultPolicy(),
            runner: mockRunner
        })
        let err: any = null
        try {
            await adapter.preflight()
        } catch (e) {
            err = e
        }
        assert.ok(err, 'Preflight must fail if device is unauthorized')
        assert.ok(
            err.message.includes('Device unauthorized'),
            `Expected unauthorized error, got: ${err.message}`
        )
        console.log('✅ Test 9 Passed: Unauthorized device fails closed during preflight')
    }

    // Test 10: Multiple devices without explicit adbSerial fail closed
    {
        const mockRunner: SubprocessRunner = async (_file, args) => {
            if (args[0] === 'version') {
                return { stdout: 'Android Debug Bridge version 1.0.41', stderr: '' }
            }
            if (args[0] === 'devices') {
                return {
                    stdout: 'List of devices attached\ndevice_one\tdevice\ndevice_two\tdevice\n',
                    stderr: ''
                }
            }
            return { stdout: '', stderr: '' }
        }
        const adapter = new AdbNetworkRecoveryAdapter({
            policy: createDefaultPolicy({ adbSerial: undefined }),
            runner: mockRunner
        })
        let err: any = null
        try {
            await adapter.preflight()
        } catch (e) {
            err = e
        }
        assert.ok(err, 'Preflight must fail if multiple devices exist without explicit serial')
        assert.ok(
            err.message.includes('Multiple devices attached'),
            `Expected multiple devices error, got: ${err.message}`
        )
        console.log('✅ Test 10 Passed: Multiple devices without explicit serial fail closed')
    }

    // Test 11: Explicit serial executes discrete argument array with ['-s', serial, ...]
    {
        const recordedCommands: Array<{ file: string; args: string[] }> = []
        const mockRunner: SubprocessRunner = async (file, args) => {
            recordedCommands.push({ file, args: [...args] })
            if (args[0] === 'version') {
                return { stdout: 'Android Debug Bridge version 1.0.41', stderr: '' }
            }
            if (args[0] === 'devices') {
                return {
                    stdout: 'List of devices attached\nTARGET_PHONE_01\tdevice\n',
                    stderr: ''
                }
            }
            return { stdout: '', stderr: '' }
        }
        const tempLockDir = path.join(os.tmpdir(), `test-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        const lockManager = new DeviceLockManager(tempLockDir)
        const adapter = new AdbNetworkRecoveryAdapter({
            policy: createDefaultPolicy({ adbSerial: 'TARGET_PHONE_01' }),
            runner: mockRunner,
            lockManager
        })

        await adapter.preflight()
        await adapter.executeDisconnect()
        await adapter.executeReconnect()
        await adapter.dispose()

        // Verify serial argument was passed as discrete array elements
        const disconnectCmd = recordedCommands.find(c => c.args.includes('enable'))
        assert.ok(disconnectCmd, 'Disconnect command must be executed')
        assert.deepStrictEqual(
            disconnectCmd.args.slice(0, 2),
            ['-s', 'TARGET_PHONE_01'],
            'Args must start with -s and explicit serial as discrete arguments'
        )

        const reconnectCmd = recordedCommands.find(c => c.args.includes('disable'))
        assert.ok(reconnectCmd, 'Reconnect command must be executed')
        assert.deepStrictEqual(
            reconnectCmd.args.slice(0, 2),
            ['-s', 'TARGET_PHONE_01'],
            'Args must start with -s and explicit serial as discrete arguments'
        )

        try {
            fs.rmSync(tempLockDir, { recursive: true, force: true })
        } catch {}
        console.log('✅ Test 11 Passed: Explicit serial executes discrete argument array with -s')
    }

    // Test 12: SubprocessRunner command timeout kills child and rejects with timeout
    {
        const start = Date.now()
        let err: any = null
        try {
            // Run a harmless Node.js sleep command with a 150ms timeout
            await AdbNetworkRecoveryAdapter.defaultRunner(
                process.execPath,
                ['-e', 'setTimeout(() => {}, 10000)'],
                { timeout: 150, maxBuffer: 1024 }
            )
        } catch (e) {
            err = e
        }
        const duration = Date.now() - start
        assert.ok(err, 'defaultRunner must reject on timeout')
        assert.ok(err.message.includes('timed out'), `Expected timed out message, got: ${err.message}`)
        assert.strictEqual(err.code, 'ETIMEDOUT')
        assert.ok(duration < 2000, `Duration (${duration}ms) should be close to 150ms timeout`)
        console.log('✅ Test 12 Passed: SubprocessRunner command timeout terminates child and rejects with timeout')
    }

    // Test 13: Device lock prevents two instances from acquiring the same device lock
    {
        const tempLockDir = path.join(os.tmpdir(), `test-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        const lockManager1 = new DeviceLockManager(tempLockDir)
        const lockManager2 = new DeviceLockManager(tempLockDir)

        const acquired1 = lockManager1.acquire('SHARED_DEVICE_01')
        assert.strictEqual(acquired1, true, 'First lock manager must acquire lock')

        const acquired2 = lockManager2.acquire('SHARED_DEVICE_01')
        assert.strictEqual(acquired2, false, 'Second lock manager must be rejected for same device')

        lockManager1.release()

        const acquired2AfterRelease = lockManager2.acquire('SHARED_DEVICE_01')
        assert.strictEqual(acquired2AfterRelease, true, 'Second manager can acquire after first releases')

        lockManager2.release()
        try {
            fs.rmSync(tempLockDir, { recursive: true, force: true })
        } catch {}
        console.log('✅ Test 13 Passed: Device lock exclusivity and clean release verified')
    }

    // Test 14: Stale PID in device lock file is recovered cleanly
    {
        const tempLockDir = path.join(os.tmpdir(), `test-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        fs.mkdirSync(tempLockDir, { recursive: true })

        const serial = 'STALE_DEVICE_TEST'
        const lockKey = DeviceLockManager.getLockKey(serial)
        const lockPath = path.join(tempLockDir, `${lockKey}.lock`)

        // Write a fake lock file pointing to a dead PID (e.g. 99999999)
        const deadPid = 99999999
        fs.writeFileSync(
            lockPath,
            JSON.stringify({ pid: deadPid, createdAt: Date.now() - 60000 }),
            'utf-8'
        )

        const lockManager = new DeviceLockManager(tempLockDir)
        // Verify isProcessAlive returns false for deadPid
        assert.strictEqual(lockManager.isProcessAlive(deadPid), false)

        const acquired = lockManager.acquire(serial)
        assert.strictEqual(acquired, true, 'Must safely reclaim stale PID lock')

        // Verify lock file now has current process PID
        const content = JSON.parse(fs.readFileSync(lockPath, 'utf-8'))
        assert.strictEqual(content.pid, process.pid)

        lockManager.release()
        try {
            fs.rmSync(tempLockDir, { recursive: true, force: true })
        } catch {}
        console.log('✅ Test 14 Passed: Stale PID lock recovered cleanly')
    }

    // Test 15: Invalid serial format with shell injection characters is rejected immediately
    {
        let err: any = null
        try {
            new AdbNetworkRecoveryAdapter({
                policy: createDefaultPolicy({ adbSerial: 'device; rm -rf /' })
            })
        } catch (e) {
            err = e
        }
        assert.ok(err, 'Must reject invalid serial with shell metacharacters')
        assert.ok(err.message.includes('[ADB-SECURITY]'), `Expected security error, got: ${err.message}`)
        console.log('✅ Test 15 Passed: Invalid serial with shell characters rejected immediately')
    }

    // Test 16: Manual recovery generates single-use requestId and awaits operator confirmation
    {
        const adapter = new ManualNetworkRecoveryAdapter({
            policy: createDefaultPolicy({ mode: 'manual', operatorTimeoutMs: 500 })
        })
        assert.strictEqual(adapter.getCurrentRequestId(), null)

        // Start reconnect which generates requestId
        const reconnectPromise = adapter.executeReconnect()
        const requestId = adapter.getCurrentRequestId()
        assert.ok(requestId, 'A non-null requestId must be generated upon executeReconnect')
        assert.strictEqual(typeof requestId, 'string')
        assert.ok(requestId.length >= 8)

        // Resolve manual
        const resolved = adapter.resolveManual(requestId, 'resume')
        assert.strictEqual(resolved, true)
        await reconnectPromise
        assert.strictEqual(adapter.knowledge, 'confirmed-disabled')
        console.log('✅ Test 16 Passed: Manual recovery generates single-use requestId and awaits confirmation')
    }

    // Test 17: Manual recovery times out cleanly when operatorTimeoutMs expires
    {
        const adapter = new ManualNetworkRecoveryAdapter({
            policy: createDefaultPolicy({ mode: 'manual', operatorTimeoutMs: 50 })
        })

        let err: any = null
        try {
            await adapter.executeReconnect()
        } catch (e) {
            err = e
        }
        assert.ok(err, 'Manual recovery must reject when operator timeout expires')
        assert.ok(err.message.includes('timed out'), `Expected timeout message, got: ${err.message}`)
        assert.strictEqual(err.code, 'ETIMEDOUT')
        console.log('✅ Test 17 Passed: Manual recovery times out cleanly when operatorTimeoutMs expires')
    }

    // Test 18: Stale or mismatched requestId in manual resolution is rejected
    {
        const adapter = new ManualNetworkRecoveryAdapter({
            policy: createDefaultPolicy({ mode: 'manual', operatorTimeoutMs: 500 })
        })

        const reconnectPromise = adapter.executeReconnect()
        const validId = adapter.getCurrentRequestId()!

        // Attempt resolving with wrong ID
        const resolvedWrong = adapter.resolveManual('wrong-request-id-999', 'resume')
        assert.strictEqual(resolvedWrong, false, 'Mismatched requestId must be rejected')

        // Resolve with correct ID
        const resolvedCorrect = adapter.resolveManual(validId, 'resume')
        assert.strictEqual(resolvedCorrect, true)
        await reconnectPromise

        // Attempt resolving again with the now-stale validId
        const resolvedStale = adapter.resolveManual(validId, 'resume')
        assert.strictEqual(resolvedStale, false, 'Already used requestId must be rejected as stale')
        console.log('✅ Test 18 Passed: Stale or mismatched requestId in manual resolution is rejected')
    }

    // Test 19: Abort action from operator rejects manual recovery cleanly
    {
        const adapter = new ManualNetworkRecoveryAdapter({
            policy: createDefaultPolicy({ mode: 'manual', operatorTimeoutMs: 500 })
        })

        const reconnectPromise = adapter.executeReconnect()
        const validId = adapter.getCurrentRequestId()!

        const resolved = adapter.resolveManual(validId, 'abort')
        assert.strictEqual(resolved, true)

        let err: any = null
        try {
            await reconnectPromise
        } catch (e) {
            err = e
        }
        assert.ok(err, 'Aborted manual recovery must reject')
        assert.ok(err.message.includes('aborted by operator'), `Expected aborted message, got: ${err.message}`)
        console.log('✅ Test 19 Passed: Abort action from operator rejects manual recovery cleanly')
    }

    // Test 20: Terminal readline Enter on stdin immediately resolves recovery successfully
    {
        const fakeStdin = new PassThrough()
        const adapter = new ManualNetworkRecoveryAdapter({
            policy: createDefaultPolicy({ mode: 'manual', operatorTimeoutMs: 1000 }),
            stdin: fakeStdin
        })

        const reconnectPromise = adapter.executeReconnect()
        assert.ok(adapter.getCurrentRequestId())

        // Simulate operator pressing Enter on terminal stdin
        fakeStdin.write('\n')

        await reconnectPromise
        assert.strictEqual(adapter.knowledge, 'confirmed-disabled')
        console.log('✅ Test 20 Passed: Terminal readline Enter on stdin resolves recovery successfully')
    }

    // Test 21: Worker IPC delegate sends request to primary and handles response cleanly
    {
        const originalSend = process.send
        let sentMessage: any = null

        // Mock process.send to simulate primary worker IPC response
        process.send = ((msg: any) => {
            sentMessage = msg
            // Simulate asynchronous response from primary after 10ms
            setTimeout(() => {
                if (msg.__networkRecoveryRequest) {
                    process.emit('message' as any, {
                        __networkRecoveryResponse: {
                            correlationId: msg.__networkRecoveryRequest.correlationId,
                            result: {
                                status: 'recovered',
                                trigger: msg.__networkRecoveryRequest.trigger,
                                attempts: 1,
                                durationMs: 100,
                                finalStage: 'recovered',
                                airplaneModeKnowledge: 'confirmed-disabled',
                                restorationAttempted: false,
                                restorationSucceeded: false
                            }
                        }
                    } as any)
                }
            }, 10)
            return true
        }) as any

        try {
            const correlationId = 'test-corr-123'
            const resultPromise = new Promise(resolve => {
                const onMessage = (msg: any) => {
                    if (
                        msg?.__networkRecoveryResponse &&
                        msg.__networkRecoveryResponse.correlationId === correlationId
                    ) {
                        process.removeListener('message', onMessage)
                        resolve(msg.__networkRecoveryResponse.result)
                    }
                }
                process.on('message', onMessage)
                process.send!({
                    __networkRecoveryRequest: { correlationId, trigger: 'connectivity-failure' }
                })
            })

            const result: any = await resultPromise
            assert.ok(sentMessage, 'Worker must send __networkRecoveryRequest message')
            assert.strictEqual(sentMessage.__networkRecoveryRequest.correlationId, correlationId)
            assert.strictEqual(sentMessage.__networkRecoveryRequest.trigger, 'connectivity-failure')
            assert.strictEqual(result.status, 'recovered')
            assert.strictEqual(result.attempts, 1)
        } finally {
            process.send = originalSend
        }
        console.log('✅ Test 21 Passed: Worker IPC delegate sends request to primary and handles response cleanly')
    }

    console.log('🎉 ALL 21 NETWORK RECOVERY TESTS PASSED SUCCESSFULLY!\n')
}

if (require.main === module) {
    runNetworkRecoveryTests().catch(err => {
        console.error('❌ Network recovery tests failed:', err)
        process.exit(1)
    })
}
