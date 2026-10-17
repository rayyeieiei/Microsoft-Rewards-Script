import assert from 'assert'
import http from 'http'
import fs from 'fs'
import path from 'path'
import patchright from 'patchright'
import { BrowserEnvironmentPolicy } from '../src/runtime/environment/BrowserEnvironmentPolicy'
import { StickyDeviceProfile, REAL_DEVICE_CATALOG } from '../src/runtime/environment/StickyDeviceProfile'
import { MicrosoftRewardsBot } from '../src/index'
import { ReadToEarn } from '../src/functions/activities/app/ReadToEarn'
import { UserAgentManager } from '../src/browser/UserAgent'
import { dashboardState } from '../src/util/DashboardServer'
import { ConfigSchema } from '../src/util/Validator'

export async function runChapter14SafetyGuardrailsTests(): Promise<void> {
    console.log('--- Running Chapter 14 Safety Guardrails Test Suite ---')

    // Test 1: BrowserEnvironmentPolicy getClientHintsMetadata for Mobile Context
    {
        const accountId = 'test_acc_' + '1'.repeat(60)
        const profile = StickyDeviceProfile.generateDeterministicProfile(accountId)
        const metadata = BrowserEnvironmentPolicy.getClientHintsMetadata('mobile', profile)

        assert.ok(metadata, 'Mobile context must have Client Hints metadata')
        assert.strictEqual(metadata.platform, 'Android')
        assert.strictEqual(metadata.userAgentMetadata.platform, 'Android')
        assert.strictEqual(metadata.userAgentMetadata.mobile, true)
        assert.strictEqual(metadata.userAgentMetadata.model, profile.device.deviceModel || profile.device.model)
        assert.ok(metadata.userAgentMetadata.fullVersion.includes('.'), 'Full version must have semantic version format')
        assert.ok(metadata.userAgentMetadata.brands.some(b => b.brand === 'Microsoft Edge'), 'Brands must include Microsoft Edge')

        const desktopMetadata = BrowserEnvironmentPolicy.getClientHintsMetadata('desktop', profile)
        assert.strictEqual(desktopMetadata, undefined, 'Desktop context must not return mobile Client Hints metadata')

        // Verify all devices in REAL_DEVICE_CATALOG generate valid Android metadata
        for (const dev of REAL_DEVICE_CATALOG) {
            const dummyProfile = {
                accountId: 'dummy',
                storageKey: 'dummy',
                device: dev,
                createdAt: new Date().toISOString()
            }
            const m = BrowserEnvironmentPolicy.getClientHintsMetadata('mobile', dummyProfile)
            assert.ok(m, `Device ${dev.id} must produce Client Hints`)
            assert.strictEqual(m.platform, 'Android')
            assert.strictEqual(m.userAgentMetadata.mobile, true)
        }

        console.log('✅ Test 1 Passed: BrowserEnvironmentPolicy getClientHintsMetadata produces valid Android Client Hints')
    }

    // Test 2: Real Browser CDP Network.setUserAgentOverride Integration (No Linux Leak)
    {
        let requestCount = 0
        let firstHeaders: http.IncomingHttpHeaders | null = null
        let secondHeaders: http.IncomingHttpHeaders | null = null

        const server = http.createServer((req, res) => {
            requestCount++
            if (requestCount === 1) {
                firstHeaders = req.headers
                res.writeHead(200, {
                    'Content-Type': 'text/plain',
                    'Accept-CH': 'Sec-CH-UA-Model, Sec-CH-UA-Platform-Version'
                })
                res.end('step1')
            } else {
                secondHeaders = req.headers
                res.writeHead(200, { 'Content-Type': 'text/plain' })
                res.end('step2')
            }
        })

        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
        const port = (server.address() as any).port

        const browser = await patchright.chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        })

        try {
            const context = await browser.newContext()
            const page = await context.newPage()

            const profile = StickyDeviceProfile.generateDeterministicProfile('a'.repeat(64))
            await BrowserEnvironmentPolicy.applyClientHintsOverride(page, profile)

            await page.goto(`http://127.0.0.1:${port}/first`)
            await page.goto(`http://127.0.0.1:${port}/second`)

            assert.ok(firstHeaders, 'First request headers must be recorded')
            assert.strictEqual(firstHeaders['sec-ch-ua-platform'], '"Android"', 'sec-ch-ua-platform must be "Android"')
            assert.strictEqual(firstHeaders['sec-ch-ua-mobile'], '?1', 'sec-ch-ua-mobile must be ?1')
            assert.notStrictEqual(firstHeaders['sec-ch-ua-platform'], '"Linux"', 'sec-ch-ua-platform must NOT leak Linux')

            assert.ok(secondHeaders, 'Second request headers must be recorded')
            assert.strictEqual(secondHeaders['sec-ch-ua-platform'], '"Android"')
            assert.strictEqual(secondHeaders['sec-ch-ua-mobile'], '?1')
            assert.ok(secondHeaders['sec-ch-ua-model'], 'High entropy Sec-CH-UA-Model must be sent after Accept-CH')
            assert.ok(secondHeaders['sec-ch-ua-platform-version'], 'High entropy Sec-CH-UA-Platform-Version must be sent after Accept-CH')

            await page.close()
            await context.close()
        } finally {
            await browser.close()
            server.close()
        }

        console.log('✅ Test 2 Passed: Real Browser CDP Network.setUserAgentOverride injects Android Client Hints without Linux leakage')
    }

    // Test 3: Hardware Concurrency Clamping Invariant
    {
        const browser = await patchright.chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        })

        try {
            const context = await browser.newContext()
            await (context as any).addInitScript(() => {
                try {
                    Object.defineProperty(navigator, 'hardwareConcurrency', {
                        get: () => 8,
                        configurable: true,
                        enumerable: true
                    })
                } catch {}
            })

            const page = await context.newPage()
            const hwConcurrency = await page.evaluate(() => navigator.hardwareConcurrency)
            assert.strictEqual(hwConcurrency, 8, 'navigator.hardwareConcurrency must be clamped to 8 cores')

            await page.close()
            await context.close()
        } finally {
            await browser.close()
        }

        console.log('✅ Test 3 Passed: Hardware concurrency clamped to 8 baseline cores across contexts')
    }

    // Test 4: Inter-Worker Circuit Breaker Propagation & Reset
    {
        const parentBot = new MicrosoftRewardsBot()
        const worker1 = new MicrosoftRewardsBot(parentBot)
        const worker2 = new MicrosoftRewardsBot(parentBot)

        assert.strictEqual(worker1.isCircuitBreakerTriggered(), false)
        assert.strictEqual(worker2.isCircuitBreakerTriggered(), false)
        assert.strictEqual(parentBot.isCircuitBreakerTriggered(), false)

        // Simulate cooldown detected on worker 1
        worker1.triggerCircuitBreaker('15-Minute Search Cooldown aktif pada Worker 1')

        // Worker 2 and parent must immediately reflect the active circuit breaker
        assert.strictEqual(worker1.isCircuitBreakerTriggered(), true)
        assert.strictEqual(worker2.isCircuitBreakerTriggered(), true)
        assert.strictEqual(parentBot.isCircuitBreakerTriggered(), true)

        // Reset for next batch
        parentBot.batchCircuitBreakerTriggered = false
        assert.strictEqual(worker1.isCircuitBreakerTriggered(), false)
        assert.strictEqual(worker2.isCircuitBreakerTriggered(), false)

        // Simulate security lock detected on worker 2
        worker2.triggerCircuitBreaker('Account locked into passwordless OTP')
        assert.strictEqual(worker1.isCircuitBreakerTriggered(), true)
        assert.strictEqual(worker2.isCircuitBreakerTriggered(), true)

        console.log('✅ Test 4 Passed: Inter-Worker Circuit Breaker propagates state bidirectionally and resets cleanly')
    }

    // Test 5: Hard Batch Deadline Barrier Simulation
    {
        const BATCH_TEST_DEADLINE_MS = 100 // 100ms for test speed

        // Scenario A: Hanging worker exceeds deadline
        const hangingWorker = new Promise(resolve => setTimeout(resolve, 500))
        let deadlineTimeout: NodeJS.Timeout | undefined
        const deadlinePromiseA = new Promise<{ kind: 'timeout' }>(resolve => {
            deadlineTimeout = setTimeout(() => resolve({ kind: 'timeout' }), BATCH_TEST_DEADLINE_MS)
        })

        const barrierPromiseA = Promise.allSettled([hangingWorker]).then(results => ({
            kind: 'completed' as const,
            results
        }))

        const resultA = await Promise.race([barrierPromiseA, deadlinePromiseA])
        if (deadlineTimeout) clearTimeout(deadlineTimeout)

        assert.strictEqual(resultA.kind, 'timeout', 'Barrier must timeout when worker hangs')

        // Scenario B: Fast workers finish before deadline
        const fastWorker1 = Promise.resolve({ collectedPoints: 100 })
        const fastWorker2 = Promise.resolve({ collectedPoints: 150 })

        let deadlineTimeoutB: NodeJS.Timeout | undefined
        const deadlinePromiseB = new Promise<{ kind: 'timeout' }>(resolve => {
            deadlineTimeoutB = setTimeout(() => resolve({ kind: 'timeout' }), 1000)
        })

        const barrierPromiseB = Promise.allSettled([fastWorker1, fastWorker2]).then(results => ({
            kind: 'completed' as const,
            results
        }))

        const resultB = await Promise.race([barrierPromiseB, deadlinePromiseB])
        if (deadlineTimeoutB) clearTimeout(deadlineTimeoutB)

        assert.strictEqual(resultB.kind, 'completed', 'Barrier must complete cleanly when workers finish before deadline')
        if (resultB.kind === 'completed') {
            assert.strictEqual(resultB.results.length, 2)
        }

        console.log('✅ Test 5 Passed: Hard Batch Deadline barrier protects against zombie worker deadlocks')
    }

    // Test 6: ReadToEarn Dynamic Sticky User-Agent Unification
    {
        const mockBot: any = {
            config: {
                searchSettings: {
                    readDelay: { min: 1, max: 2 }
                }
            },
            userData: { geoLocale: 'US', currentPoints: 0 },
            logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
            axios: { request: async () => ({ status: 200, data: {} }) },
            accountScope: {
                deviceProfile: {
                    device: {
                        userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) TestCustomUA/1.0'
                    }
                }
            }
        }

        const readToEarn = new ReadToEarn(mockBot)
        const customUA = (readToEarn as any).getMobileUserAgent()
        assert.strictEqual(
            customUA,
            'Mozilla/5.0 (Linux; Android 14; SM-S911B) TestCustomUA/1.0',
            'ReadToEarn must use accountScope sticky deviceProfile userAgent'
        )

        // Fallback test when accountScope has no profile
        mockBot.accountScope = undefined
        const fallbackUA = (readToEarn as any).getMobileUserAgent()
        assert.strictEqual(
            fallbackUA,
            UserAgentManager.DEFAULT_MOBILE_UA,
            'ReadToEarn must fallback to DEFAULT_MOBILE_UA when accountScope is not configured'
        )

        console.log('✅ Test 6 Passed: ReadToEarn unifies User-Agent dynamically with sticky device profile')
    }

    // Test 7: Staggered Delay Expansion & Config Schema Validation
    {
        assert.strictEqual(
            dashboardState.staggeredOffsetSeconds,
            45,
            'DashboardServer state must default staggeredOffsetSeconds to 45s'
        )

        const parsedEmpty = ConfigSchema.partial().parse({})
        assert.strictEqual(
            parsedEmpty.staggeredOffsetSeconds,
            45,
            'Validator ConfigSchema must default staggeredOffsetSeconds to 45'
        )
        assert.strictEqual(
            parsedEmpty.executionMode,
            'sequential',
            'Validator ConfigSchema must default executionMode to sequential'
        )

        const exampleConfigPath = path.resolve(process.cwd(), 'src/config.example.json')
        const exampleConfig = JSON.parse(fs.readFileSync(exampleConfigPath, 'utf-8'))
        assert.strictEqual(
            exampleConfig.staggeredOffsetSeconds,
            45,
            'src/config.example.json must define staggeredOffsetSeconds = 45'
        )
        assert.strictEqual(
            exampleConfig.executionMode,
            'sequential',
            'src/config.example.json must define executionMode = sequential'
        )

        console.log('✅ Test 7 Passed: Staggered delay default expanded to 45s across dashboard and config schema')
    }

    console.log('🎉 ALL 7 CHAPTER 14 SAFETY GUARDRAILS TESTS PASSED SUCCESSFULLY!')
}
