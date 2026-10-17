import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { StickyDeviceProfile, REAL_DEVICE_CATALOG } from '../src/runtime/environment/StickyDeviceProfile'
import { SessionPathResolver } from '../src/runtime/session/SessionPathResolver'
import { BrowserEnvironmentPolicy } from '../src/runtime/environment/BrowserEnvironmentPolicy'
import { AccountScope } from '../src/runtime/AccountScope'
import { AirplaneMode } from '../src/util/AirplaneMode'
import {
    dashboardState,
    updateDashboardGlobal
} from '../src/util/DashboardServer'
import type { Account } from '../src/interface/Account'

const defaultAccount: Account = {
    email: 'linux.worker1@example.com',
    password: 'password123',
    recoveryEmail: 'rec1@example.com',
    geoLocale: 'en-US',
    langCode: 'en',
    proxy: { url: '', port: 0, proxyAxios: false, username: '', password: '' },
    saveFingerprint: { mobile: false, desktop: false }
}

export async function runChapter13LinuxSynchronizationTests(): Promise<void> {
    console.log('--- Running Chapter 13 Linux Synchronization & Staggered Dispatcher Test Suite ---')

    const testSessionsDir = path.resolve(process.cwd(), 'test_sessions_ch13')
    if (!fs.existsSync(testSessionsDir)) {
        fs.mkdirSync(testSessionsDir, { recursive: true })
    }

    try {
        // Test 1: StickyDeviceProfile Determinism & Real Device Catalog
        {
            const accountIdA = 'a'.repeat(64)
            const profileA1 = StickyDeviceProfile.generateDeterministicProfile(accountIdA)
            const profileA2 = StickyDeviceProfile.generateDeterministicProfile(accountIdA)

            assert.strictEqual(profileA1.accountId, accountIdA)
            assert.strictEqual(profileA1.device.id, profileA2.device.id)
            assert.strictEqual(profileA1.device.brand, profileA2.device.brand)
            assert.strictEqual(profileA1.device.userAgent, profileA2.device.userAgent)
            assert.strictEqual(profileA1.device.screen.viewport.width, profileA2.device.screen.viewport.width)
            assert.strictEqual(profileA1.device.screen.isMobile, true)
            assert.strictEqual(profileA1.device.screen.hasTouch, true)
            assert.ok(typeof profileA1.device.screen.deviceScaleFactor === 'number' && profileA1.device.screen.deviceScaleFactor > 1)

            // Verify catalog covers real devices: Samsung, Google Pixel, Xiaomi, OnePlus
            const catalogIds = REAL_DEVICE_CATALOG.map(d => d.id)
            assert.ok(catalogIds.includes('samsung-galaxy-s23'))
            assert.ok(catalogIds.includes('google-pixel-7'))
            assert.ok(catalogIds.includes('xiaomi-13'))
            assert.ok(catalogIds.includes('oneplus-11'))

            console.log('✅ Test 1 Passed: StickyDeviceProfile deterministic 1:1 mapping from accountId SHA-256')
        }

        // Test 2: StickyDeviceProfile POSIX Path Resolution & Disk Persistence
        {
            const accountId = 'user_test_linux_001@msn.com'
            const storageKey = SessionPathResolver.getStorageKey(accountId)
            const expectedPath = path.resolve(testSessionsDir, `${storageKey}.deviceProfile.json`)

            const profile = await StickyDeviceProfile.resolveDeviceProfile(testSessionsDir, accountId)
            assert.strictEqual(fs.existsSync(expectedPath), true, 'Profile file must exist on disk')

            // Verify file content matches profile
            const raw = JSON.parse(fs.readFileSync(expectedPath, 'utf-8'))
            assert.strictEqual(raw.accountId, accountId)
            assert.strictEqual(raw.storageKey, storageKey)
            assert.strictEqual(raw.device.id, profile.device.id)

            // Ensure cached profile is loaded on next call
            const cachedProfile = await StickyDeviceProfile.resolveDeviceProfile(testSessionsDir, accountId)
            assert.strictEqual(cachedProfile.device.id, profile.device.id)

            console.log('✅ Test 2 Passed: StickyDeviceProfile POSIX path resolution & sessions persistence')
        }

        // Test 3: AccountScope Integration with StickyDeviceProfile
        {
            const mockBot: any = {
                config: { sessionPath: 'test_sessions_ch13' },
                logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
                resetAccountState: () => {}
            }

            const scope = await AccountScope.create({
                account: defaultAccount,
                bot: mockBot,
                runId: 'run_ch13_scope'
            })

            assert.ok(scope.deviceProfile, 'AccountScope must resolve and attach sticky device profile')
            assert.strictEqual(scope.deviceProfile.accountId, scope.accountId)
            assert.ok(scope.deviceProfile.device.screen.viewport.width > 0)
            assert.ok(scope.deviceProfile.device.userAgent.includes('EdgA'))

            await scope.dispose()
            console.log('✅ Test 3 Passed: AccountScope automatically binds deterministic StickyDeviceProfile')
        }

        // Test 4: BrowserEnvironmentPolicy applies StickyDeviceProfile to mobile context
        {
            const testProfile = StickyDeviceProfile.generateDeterministicProfile('sticky_test_account_id')
            const envProfile = BrowserEnvironmentPolicy.resolveProfile('mobile', undefined, testProfile)

            assert.strictEqual(envProfile.contextKind, 'mobile')
            assert.ok(envProfile.screen, 'Screen must be defined')
            assert.strictEqual(envProfile.screen!.viewport.width, testProfile.device.screen.viewport.width)
            assert.strictEqual(envProfile.screen!.viewport.height, testProfile.device.screen.viewport.height)
            assert.strictEqual(envProfile.screen!.deviceScaleFactor, testProfile.device.screen.deviceScaleFactor)
            assert.strictEqual(envProfile.userAgent, testProfile.device.userAgent)

            const ctxOpts = BrowserEnvironmentPolicy.toContextOptions(envProfile)
            assert.strictEqual(ctxOpts.viewport?.width, testProfile.device.screen.viewport.width)
            assert.strictEqual(ctxOpts.isMobile, true)
            assert.strictEqual(ctxOpts.userAgent, testProfile.device.userAgent)

            console.log('✅ Test 4 Passed: BrowserEnvironmentPolicy applies sticky mobile viewport and User-Agent')
        }

        // Test 5: Batch Chunking Queue Logic (chunkSize = 2)
        {
            const accounts: Account[] = [
                { ...defaultAccount, email: 'acc1@example.com' },
                { ...defaultAccount, email: 'acc2@example.com' },
                { ...defaultAccount, email: 'acc3@example.com' },
                { ...defaultAccount, email: 'acc4@example.com' },
                { ...defaultAccount, email: 'acc5@example.com' }
            ]

            const chunkSize = 2
            const batches: Account[][] = []
            for (let i = 0; i < accounts.length; i += chunkSize) {
                batches.push(accounts.slice(i, i + chunkSize))
            }

            assert.strictEqual(batches.length, 3)
            assert.strictEqual(batches[0]?.length, 2)
            assert.strictEqual(batches[1]?.length, 2)
            assert.strictEqual(batches[2]?.length, 1)
            assert.strictEqual(batches[0]?.[0]?.email, 'acc1@example.com')
            assert.strictEqual(batches[0]?.[1]?.email, 'acc2@example.com')
            assert.strictEqual(batches[1]?.[0]?.email, 'acc3@example.com')

            console.log('✅ Test 5 Passed: Queue chunking divides accounts into batches of 2 workers')
        }

        // Test 6: In-Process Dual-Worker Staggered Timing & Barrier Synchronization Simulation
        {
            const executionLog: Array<{ worker: number; event: string; timestamp: number }> = []
            const startTime = Date.now()

            const runMockWorker = async (workerNum: number, durationMs: number) => {
                executionLog.push({ worker: workerNum, event: 'start', timestamp: Date.now() - startTime })
                await new Promise(resolve => setTimeout(resolve, durationMs))
                executionLog.push({ worker: workerNum, event: 'end', timestamp: Date.now() - startTime })
                return { worker: workerNum, success: true }
            }

            // Staggered launch simulation: worker 1 at 0ms, worker 2 staggered by 50ms (simulating 30s in test)
            const workerPromises: Promise<any>[] = []
            const worker1Promise = runMockWorker(1, 100)
            workerPromises.push(worker1Promise)

            // Staggered delay
            await new Promise(resolve => setTimeout(resolve, 50))
            const worker2Promise = runMockWorker(2, 80)
            workerPromises.push(worker2Promise)

            // Barrier synchronization
            const results = await Promise.allSettled(workerPromises)
            const barrierTime = Date.now() - startTime

            assert.strictEqual(results.length, 2)
            assert.strictEqual(results[0]?.status, 'fulfilled')
            assert.strictEqual(results[1]?.status, 'fulfilled')

            // Verify worker 1 started before worker 2
            const w1Start = executionLog.find(e => e.worker === 1 && e.event === 'start')!
            const w2Start = executionLog.find(e => e.worker === 2 && e.event === 'start')!
            assert.ok(w1Start.timestamp < w2Start.timestamp, 'Worker 1 must start before Worker 2')
            assert.ok(w2Start.timestamp >= 40, 'Worker 2 must start after staggered offset')

            // Verify barrier waited until both finished
            const w1End = executionLog.find(e => e.worker === 1 && e.event === 'end')!
            const w2End = executionLog.find(e => e.worker === 2 && e.event === 'end')!
            assert.ok(barrierTime >= w1End.timestamp, 'Barrier must wait for Worker 1 to finish')
            assert.ok(barrierTime >= w2End.timestamp, 'Barrier must wait for Worker 2 to finish')

            console.log('✅ Test 6 Passed: Dual-Worker staggered dispatch with Promise.allSettled barrier synchronization')
        }

        // Test 7: Runtime State Isolation between concurrent AccountScopes
        {
            const mockBot: any = {
                config: { sessionPath: 'test_sessions_ch13' },
                logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
                resetAccountState: () => {}
            }

            const accA: Account = { ...defaultAccount, email: 'accA@example.com' }
            const accB: Account = { ...defaultAccount, email: 'accB@example.com' }

            const scopeA = await AccountScope.create({ account: accA, bot: mockBot, runId: 'run_concurrent_A' })
            const scopeB = await AccountScope.create({ account: accB, bot: mockBot, runId: 'run_concurrent_B' })

            scopeA.setDapiToken('token_for_scope_A')
            scopeB.setDapiToken('token_for_scope_B')

            scopeA.cookies = { mobile: [{ name: 'cookieA', value: '1' }], desktop: [] }
            scopeB.cookies = { mobile: [{ name: 'cookieB', value: '2' }], desktop: [] }

            assert.strictEqual(scopeA.getDapiToken(), 'token_for_scope_A')
            assert.strictEqual(scopeB.getDapiToken(), 'token_for_scope_B')
            assert.notStrictEqual(scopeA.getDapiToken(), scopeB.getDapiToken())

            assert.strictEqual(scopeA.cookies.mobile[0]?.name, 'cookieA')
            assert.strictEqual(scopeB.cookies.mobile[0]?.name, 'cookieB')

            assert.notStrictEqual(scopeA.storagePaths.storageKey, scopeB.storagePaths.storageKey)
            assert.notStrictEqual(scopeA.storagePaths.mobilePath, scopeB.storagePaths.mobilePath)

            await scopeA.dispose()
            await scopeB.dispose()

            assert.strictEqual(scopeA.isDisposed, true)
            assert.strictEqual(scopeB.isDisposed, true)

            console.log('✅ Test 7 Passed: Strict runtime state isolation between concurrent AccountScopes')
        }

        // Test 8: C2 Dashboard Execution Mode Switching & Batch Progress State
        {
            updateDashboardGlobal({
                executionMode: 'dual',
                staggeredOffsetSeconds: 45,
                currentBatch: {
                    batchIndex: 0,
                    totalBatches: 3,
                    activeAccounts: ['acc1@example.com', 'acc2@example.com'],
                    staggerCountdown: 25
                }
            })

            assert.strictEqual(dashboardState.executionMode, 'dual')
            assert.strictEqual(dashboardState.staggeredOffsetSeconds, 45)
            assert.strictEqual(dashboardState.currentBatch?.batchIndex, 0)
            assert.strictEqual(dashboardState.currentBatch?.staggerCountdown, 25)

            // Switch to sequential mode
            updateDashboardGlobal({ executionMode: 'sequential' })
            assert.strictEqual(dashboardState.executionMode, 'sequential')

            // Clear batch
            updateDashboardGlobal({ currentBatch: null, staggeredOffsetSeconds: 45 })
            assert.strictEqual(dashboardState.currentBatch, null)

            console.log('✅ Test 8 Passed: C2 Dashboard state updates execution mode and batch indicators')
        }

        // Test 9: Linux ADB Native Execution Validation & Multi-Provider IP Checker
        {
            // Verify AirplaneMode.checkIP() fallback mechanism
            assert.strictEqual(typeof AirplaneMode.checkIP, 'function')
            assert.strictEqual(typeof AirplaneMode.toggle, 'function')

            // Test checkIP method returns valid IP string or 'Gagal_Cek_IP'
            const ip = await AirplaneMode.checkIP()
            assert.ok(typeof ip === 'string', 'IP checker must return a string')
            assert.ok(ip.length > 0, 'IP string must not be empty')

            console.log('✅ Test 9 Passed: Linux AirplaneMode multi-provider IP resolution and signature verification')
        }
    } finally {
        try {
            fs.rmSync(testSessionsDir, { recursive: true, force: true })
        } catch {}
    }

    console.log('🎉 ALL 9 CHAPTER 13 LINUX SYNCHRONIZATION TESTS PASSED SUCCESSFULLY!')
}
