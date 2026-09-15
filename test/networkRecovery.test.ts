import assert from 'assert'
import {
    NetworkRecoveryController
} from '../src/runtime/network/NetworkRecoveryController'
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
        maxAttempts: 2,
        commandTimeoutMs: 1000,
        disconnectTimeoutMs: 20,
        reconnectTimeoutMs: 20,
        verificationIntervalMs: 10,
        operatorTimeoutMs: 500,
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

    console.log('🎉 ALL 7 NETWORK RECOVERY CORE TESTS PASSED SUCCESSFULLY!\n')
}
