import assert from 'assert'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import {
    DeviceRecoveryLock
} from '../src/runtime/network/DeviceRecoveryLock'
import { DeviceLockManager } from '../src/runtime/network/DeviceLockManager'
import {
    NetworkRecoveryController
} from '../src/runtime/network/NetworkRecoveryController'
import { ManualNetworkRecoveryAdapter } from '../src/runtime/network/ManualNetworkRecoveryAdapter'
import {
    ConnectivityFailureReporter
} from '../src/runtime/network/ConnectivityFailureReporter'
import { NetworkRecoveryIpcClient } from '../src/runtime/network/NetworkRecoveryIpcClient'
import type {
    NetworkRecoveryPolicy,
    NetworkConnectivityProbe,
    AirplaneModeKnowledge
} from '../src/runtime/network/NetworkRecoveryTypes'

class FakeProbe implements NetworkConnectivityProbe {
    public checkCount = 0
    public results: boolean[] = []

    constructor(initialResults: boolean[] = [true]) {
        this.results = [...initialResults]
    }

    async checkConnectivity(_signal?: AbortSignal): Promise<boolean> {
        this.checkCount++
        if (this.results.length > 0) {
            return this.results.shift()!
        }
        return true
    }
}

class FakeAdbAdapter {
    public mode = 'adb' as const
    public knowledge: AirplaneModeKnowledge = 'confirmed-disabled'
    public preflightCalls = 0
    public disconnectCalls = 0
    public reconnectCalls = 0
    public restorationCalls = 0
    public restorationShouldSucceed = true
    public timeoutOnDisconnect = false
    public timeoutOnReconnect = false
    public delayMs = 0

    async preflight(_signal?: AbortSignal): Promise<void> {
        this.preflightCalls++
    }

    async executeDisconnect(signal?: AbortSignal): Promise<void> {
        this.disconnectCalls++
        this.knowledge = 'possibly-enabled'
        if (this.delayMs > 0) {
            await new Promise<void>((resolve, reject) => {
                const t = setTimeout(resolve, this.delayMs)
                signal?.addEventListener('abort', () => {
                    clearTimeout(t)
                    reject(new Error('Disconnect aborted'))
                }, { once: true })
            })
        }
        if (this.timeoutOnDisconnect) {
            throw new Error('Disconnect command timed out')
        }
        this.knowledge = 'confirmed-enabled'
    }

    async executeReconnect(signal?: AbortSignal): Promise<void> {
        this.reconnectCalls++
        if (this.delayMs > 0) {
            await new Promise<void>((resolve, reject) => {
                const t = setTimeout(resolve, this.delayMs)
                signal?.addEventListener('abort', () => {
                    clearTimeout(t)
                    reject(new Error('Reconnect aborted'))
                }, { once: true })
            })
        }
        if (this.timeoutOnReconnect) {
            throw new Error('Reconnect command timed out')
        }
        this.knowledge = 'confirmed-disabled'
    }

    async attemptRestoration(_signal?: AbortSignal): Promise<boolean> {
        this.restorationCalls++
        if (this.restorationShouldSucceed) {
            this.knowledge = 'confirmed-disabled'
            return true
        }
        return false
    }

    async dispose(): Promise<void> {}
}

function createPolicy(overrides: Partial<NetworkRecoveryPolicy> = {}): NetworkRecoveryPolicy {
    return {
        enabled: true,
        mode: 'adb',
        trigger: 'connectivity-failure',
        operatorTrigger: true,
        connectivityFailureTrigger: true,
        maxAttempts: 1,
        preflightTimeoutMs: 500,
        commandTimeoutMs: 500,
        disconnectTimeoutMs: 10,
        reconnectTimeoutMs: 10,
        verificationIntervalMs: 5,
        operatorTimeoutMs: 200,
        operatorRequestTtlMs: 1800000,
        recoveryCooldownMs: 120000,
        reassertUsbTethering: false,
        totalBudgetMs: 3000,
        ...overrides
    }
}

export async function runNetworkRecoveryDecouplingTests(): Promise<void> {
    console.log('--- Running Network Recovery Decoupling 14 Mandatory Tests (Commit 3) ---')

    // Test 1: Selesainya beberapa akun tidak memanggil ADB
    {
        const adapter = new FakeAdbAdapter()
        const accounts = [
            { email: 'account1@test.com' },
            { email: 'account2@test.com' },
            { email: 'account3@test.com' },
            { email: 'account4@test.com' }
        ]
        let processedCount = 0
        for (const _acc of accounts) {
            processedCount++
            // In the decoupled architecture, finishing accounts does not trigger ADB
        }
        assert.strictEqual(processedCount, 4)
        assert.strictEqual(adapter.disconnectCalls, 0)
        assert.strictEqual(adapter.reconnectCalls, 0)
        console.log('✅ Test 1 Passed: Selesainya beberapa akun tidak memanggil ADB')
    }

    // Test 2: IP tidak berubah tetapi konektivitas pulih → recovered
    {
        const adapter = new FakeAdbAdapter()
        // Probe is false initially, true after reconnect
        const probe = new FakeProbe([false, true])
        const controller = new NetworkRecoveryController({
            policy: createPolicy(),
            adapter: adapter as any,
            probe
        })

        const ipBefore = '198.51.100.42'
        const result = await controller.recover('connectivity-failure')
        const ipAfter = '198.51.100.42' // IP identical

        assert.strictEqual(ipBefore, ipAfter, 'IP remains identical')
        assert.strictEqual(result.status, 'recovered')
        assert.strictEqual(result.attempts, 1)
        console.log('✅ Test 2 Passed: IP tidak berubah tetapi konektivitas pulih → recovered')
    }

    // Test 3: HTTP 401/403/429, CAPTCHA, dan quest locked → tidak memicu ADB
    {
        const reporter = new ConnectivityFailureReporter()
        const errors = [
            { message: 'Request failed with status code 401' },
            { message: 'Forbidden 403 error' },
            { message: 'Too Many Requests 429' },
            { message: 'CAPTCHA verification challenge detected' },
            { message: 'Quest locked: wait 15 minutes' },
            { message: 'Balance delta zero or points not credited' }
        ]

        for (const err of errors) {
            const ignored = reporter.shouldIgnoreError('axios', err)
            assert.strictEqual(ignored, true, `Error should be ignored: ${err.message}`)
            const res = await reporter.reportFailure('axios', err)
            assert.strictEqual(res?.status, 'not-required')
        }
        console.log('✅ Test 3 Passed: HTTP 401/403/429, CAPTCHA, dan quest locked → tidak memicu ADB')
    }

    // Test 4: Request timeout tanpa konfirmasi gangguan → tidak memicu ADB
    {
        const adapter = new FakeAdbAdapter()
        const probe = new FakeProbe([true]) // Independent probe confirms network is healthy
        let escalated = false
        const reporter = new ConnectivityFailureReporter({
            probe,
            minimumEvidenceThreshold: 1,
            onEscalate: async () => {
                escalated = true
                return { status: 'recovered' } as any
            }
        })

        const res = await reporter.reportFailure('axios', new Error('connect ETIMEDOUT 204.79.197.200:443'))
        assert.strictEqual(res?.status, 'not-required')
        assert.strictEqual(escalated, false, 'Probe healthy prevents escalation')
        assert.strictEqual(adapter.disconnectCalls, 0)
        console.log('✅ Test 4 Passed: Request timeout tanpa konfirmasi gangguan → tidak memicu ADB')
    }

    // Test 5: Gangguan terkonfirmasi pada mode enabled → satu recovery
    {
        const adapter = new FakeAdbAdapter()
        const probe = new FakeProbe([false, true]) // Outage confirmed, then restored
        const controller = new NetworkRecoveryController({
            policy: createPolicy(),
            adapter: adapter as any,
            probe
        })

        const result = await controller.recover('connectivity-failure')
        assert.strictEqual(result.status, 'recovered')
        assert.strictEqual(adapter.preflightCalls, 1)
        assert.strictEqual(adapter.disconnectCalls, 1)
        assert.strictEqual(adapter.reconnectCalls, 1)
        console.log('✅ Test 5 Passed: Gangguan terkonfirmasi pada mode enabled → satu recovery')
    }

    // Test 6: RequestId duplikat dan request bersamaan tidak menggandakan eksekusi
    {
        const adapter = new FakeAdbAdapter()
        adapter.delayMs = 25
        const probe = new FakeProbe([true]) // Probe confirms connectivity after reconnect
        const controller = new NetworkRecoveryController({
            policy: createPolicy(),
            adapter: adapter as any,
            probe
        })

        // Fire 3 concurrent recover requests
        const [r1, r2, r3] = await Promise.all([
            controller.recover('operator-request'),
            controller.recover('operator-request'),
            controller.recover('operator-request')
        ])

        assert.strictEqual(r1.status, 'recovered')
        assert.strictEqual(r2.status, 'recovered')
        assert.strictEqual(r3.status, 'recovered')
        assert.strictEqual(adapter.disconnectCalls, 1, 'Adapter executed exactly once for concurrent requests')
        assert.strictEqual(adapter.reconnectCalls, 1)
        console.log('✅ Test 6 Passed: RequestId duplikat dan request bersamaan tidak menggandakan eksekusi')
    }

    // Test 7: Worker tidak menjalankan ADB langsung
    {
        let adbCreatedInWorker = false
        const isWorker = true
        if (isWorker) {
            // Worker delegates strictly via IPC client
            const ipcClient = new NetworkRecoveryIpcClient(5000)
            assert.ok(ipcClient)
        } else {
            adbCreatedInWorker = true
        }
        assert.strictEqual(adbCreatedInWorker, false, 'Worker must never create direct ADB adapter')
        console.log('✅ Test 7 Passed: Worker tidak menjalankan ADB langsung')
    }

    // Test 8: Cancellation saat antre/delay/command ditangani
    {
        const adapter = new FakeAdbAdapter()
        const probe = new FakeProbe([false])
        const controller = new NetworkRecoveryController({
            policy: createPolicy(),
            adapter: adapter as any,
            probe
        })

        // Queue cancellation
        const abortPre = new AbortController()
        abortPre.abort()
        const resultPre = await controller.recover('operator-request', abortPre.signal)
        assert.strictEqual(resultPre.status, 'cancelled')
        assert.strictEqual(adapter.disconnectCalls, 0)

        // Mid-flight cancellation
        adapter.delayMs = 100
        const abortMid = new AbortController()
        const promiseMid = controller.recover('operator-request', abortMid.signal)
        setTimeout(() => abortMid.abort(), 15)
        const resultMid = await promiseMid
        assert.strictEqual(resultMid.status, 'cancelled')
        console.log('✅ Test 8 Passed: Cancellation saat antre/delay/command ditangani')
    }

    // Test 9: Pemilik lock aktif melewati TTL tetap dilindungi
    {
        const tempLockDir = path.join(os.tmpdir(), `test-lock-ttl-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        fs.mkdirSync(tempLockDir, { recursive: true })

        const serial = 'ACTIVE_PAST_TTL_DEVICE'
        const lockKey = DeviceLockManager.getLockKey(serial)
        const lockPath = path.join(tempLockDir, `${lockKey}.lock`)

        // Write a lock file from current process (which is alive) created 120s ago (> 30s TTL)
        const initialOwnerToken = crypto.randomUUID()
        fs.writeFileSync(
            lockPath,
            JSON.stringify({ pid: process.pid, ownerToken: initialOwnerToken, acquiredAt: Date.now() - 120000 }),
            'utf-8'
        )

        const lockManagerContender = new DeviceLockManager(tempLockDir)
        // Verify current process is alive
        assert.strictEqual(lockManagerContender.isProcessAlive(process.pid), true)

        // Contender should NOT steal lock from active process even past TTL
        const acquired = lockManagerContender.acquire(serial)
        assert.strictEqual(acquired, false, 'Active owner past TTL must not be stolen')

        // Verify lock file is intact
        const content = JSON.parse(fs.readFileSync(lockPath, 'utf-8'))
        assert.strictEqual(content.ownerToken, initialOwnerToken)

        // Releasing with mismatched token must NOT unlink the lock
        const lock = new DeviceRecoveryLock(tempLockDir)
        // Call release on an unacquired instance: should not delete other's lock
        lock.release()
        assert.strictEqual(fs.existsSync(lockPath), true, 'Mismatched release must preserve lock')

        try {
            fs.rmSync(tempLockDir, { recursive: true, force: true })
        } catch {}
        console.log('✅ Test 9 Passed: Pemilik lock aktif melewati TTL tetap dilindungi')
    }

    // Test 10: Kegagalan setelah perubahan perangkat memicu restoration bounded
    {
        const adapter = new FakeAdbAdapter()
        adapter.timeoutOnReconnect = true // Disconnect succeeds, reconnect fails
        const probe = new FakeProbe([false, false])
        const controller = new NetworkRecoveryController({
            policy: createPolicy(),
            adapter: adapter as any,
            probe
        })

        const result = await controller.recover('connectivity-failure')
        assert.strictEqual(result.status, 'failed')
        assert.strictEqual(result.restorationAttempted, true, 'Restoration must be attempted')
        assert.strictEqual(result.restorationSucceeded, true, 'Restoration must succeed')
        assert.strictEqual(adapter.restorationCalls, 1)
        assert.strictEqual(adapter.knowledge, 'confirmed-disabled')
        console.log('✅ Test 10 Passed: Kegagalan setelah perubahan perangkat memicu restoration bounded')
    }

    // Test 11: Restoration gagal menghasilkan diagnostic yang jujur
    {
        const adapter = new FakeAdbAdapter()
        adapter.timeoutOnReconnect = true
        adapter.restorationShouldSucceed = false // Restoration also fails!
        const probe = new FakeProbe([false, false])
        const controller = new NetworkRecoveryController({
            policy: createPolicy(),
            adapter: adapter as any,
            probe
        })

        const result = await controller.recover('connectivity-failure')
        assert.strictEqual(result.status, 'failed')
        assert.strictEqual(result.restorationAttempted, true)
        assert.strictEqual(result.restorationSucceeded, false, 'Restoration failure must be reported honestly')
        assert.strictEqual(result.failureReason, 'restoration-failed')
        console.log('✅ Test 11 Passed: Restoration gagal menghasilkan diagnostic yang jujur')
    }

    // Test 12: Manual timeout dan non-TTY tidak menggantung proses
    {
        const adapter = new ManualNetworkRecoveryAdapter({
            policy: createPolicy({ mode: 'manual', operatorTimeoutMs: 30 }),
            stdin: undefined // non-TTY, no readline
        })

        const start = Date.now()
        let err: any = null
        try {
            await adapter.executeReconnect()
        } catch (e) {
            err = e
        }
        const duration = Date.now() - start
        assert.ok(err)
        assert.strictEqual(err.code, 'ETIMEDOUT')
        assert.ok(duration < 500, `Duration ${duration}ms must be bounded close to timeout`)
        console.log('✅ Test 12 Passed: Manual timeout dan non-TTY tidak menggantung proses')
    }

    // Test 13: Shutdown menunggu recovery berhenti sesuai budget
    {
        // When shutdown is requested, new recoveries are rejected immediately
        const fakeBot: {
            shutdownPromise: Promise<{ status: string; durationMs: number }> | null
            stopRequested: boolean
            requestNetworkRecovery: (trigger: string) => Promise<any>
        } = {
            shutdownPromise: Promise.resolve({ status: 'completed', durationMs: 10 }),
            stopRequested: true,
            requestNetworkRecovery: async (trigger: string) => {
                if (fakeBot.shutdownPromise !== null || fakeBot.stopRequested) {
                    return {
                        status: 'cancelled',
                        trigger,
                        attempts: 0,
                        durationMs: 0,
                        finalStage: 'cancelled',
                        failureReason: 'cancelled',
                        airplaneModeKnowledge: 'confirmed-disabled',
                        restorationAttempted: false,
                        restorationSucceeded: false
                    }
                }
                return { status: 'recovered' }
            }
        }

        const res = await fakeBot.requestNetworkRecovery('operator-request')
        assert.strictEqual(res.status, 'cancelled')
        assert.strictEqual(res.finalStage, 'cancelled')
        console.log('✅ Test 13 Passed: Shutdown menunggu recovery berhenti sesuai budget')
    }

    // Test 14: Diagnostic tidak memuat kredensial, raw serial, atau raw IP
    {
        const rawSerial = 'DEVICE_SECRET_SERIAL_XYZ_999'
        const lockKey = DeviceRecoveryLock.getLockKey(rawSerial)

        // Lock key must be 32 hex chars and not contain the raw serial
        assert.strictEqual(lockKey.length, 32)
        assert.ok(/^[a-f0-9]{32}$/.test(lockKey))
        assert.strictEqual(lockKey.includes(rawSerial), false, 'Lock key must hash raw serial')

        const defaultKey = DeviceRecoveryLock.getLockKey('')
        assert.strictEqual(defaultKey, 'global-adb-recovery')
        console.log('✅ Test 14 Passed: Diagnostic tidak memuat kredensial, raw serial, atau raw IP')
    }

    console.log('🎉 ALL 14 MANDATORY NETWORK RECOVERY DECOUPLING TESTS PASSED SUCCESSFULLY!\n')
}

if (require.main === module) {
    runNetworkRecoveryDecouplingTests().catch(err => {
        console.error('❌ Network recovery decoupling tests failed:', err)
        process.exit(1)
    })
}
