import assert from 'assert'
import { DataSaverManager } from '../src/util/DataSaver'
import { MicrosoftRewardsBot } from '../src/index'
import { BrowserEnvironmentPolicy } from '../src/runtime/environment/BrowserEnvironmentPolicy'
import { isLocalSystemProtocol } from '../src/functions/activities/api/UrlProtocolGuard'
import { interceptLocalSystemProtocol } from '../src/functions/activities/api/PunchCard'

export async function runChapter29SigintBandwidthTelemetryTests(): Promise<void> {
    console.log('--- Running Chapter 29 SIGINT Bandwidth Telemetry & Linux Hardening Test Suite ---')

    // Test 1: DataSaverManager sessionStats retention across resetAccountQuota calls
    {
        const manager = DataSaverManager.getInstance()
        manager.resetSessionStats()
        manager.resetAll()

        // Account 1
        manager.beginAccountQuota('acc1@test.com')
        manager.recordTransferredResource('document', 5 * 1024 * 1024, 'acc1@test.com')
        manager.recordTransferredResource('image', 2 * 1024 * 1024, 'acc1@test.com')
        manager.recordTransferredResource('script', 1 * 1024 * 1024, 'acc1@test.com')
        manager.recordBlockedRequest('acc1@test.com')
        manager.recordBlockedRequest('acc1@test.com')

        const acc1StatsBefore = manager.getAccountStats('acc1@test.com')
        assert.strictEqual(acc1StatsBefore.totalBytes, 8 * 1024 * 1024)
        assert.strictEqual(acc1StatsBefore.blockedRequests, 2)

        // Reset Account 1 quota (simulating account completion)
        manager.resetAccountQuota('acc1@test.com')
        const acc1StatsAfter = manager.getAccountStats('acc1@test.com')
        assert.strictEqual(acc1StatsAfter.totalBytes, 0, 'Account stats must be cleared after resetAccountQuota')
        assert.strictEqual(acc1StatsAfter.blockedRequests, 0)

        // Session report must RETAIN Account 1 stats
        let sessionReport = manager.getSessionReport(20 * 1024 * 1024, 2)
        assert.strictEqual(sessionReport.totalBytes, 8 * 1024 * 1024, 'Session report must retain bytes after account quota reset')
        assert.strictEqual(sessionReport.blockedRequests, 2, 'Session report must retain blocked requests')
        assert.strictEqual(sessionReport.breakdownMb.document, 5)
        assert.strictEqual(sessionReport.breakdownMb.image, 2)
        assert.strictEqual(sessionReport.breakdownMb.script, 1)

        // Account 2
        manager.beginAccountQuota('acc2@test.com')
        manager.recordTransferredResource('xhr/fetch', 4 * 1024 * 1024, 'acc2@test.com')
        manager.recordBlockedRequest('acc2@test.com')
        manager.resetAccountQuota('acc2@test.com')

        // Session report must ACCUMULATE both Account 1 and Account 2
        sessionReport = manager.getSessionReport(20 * 1024 * 1024, 2)
        assert.strictEqual(sessionReport.totalBytes, 12 * 1024 * 1024, 'Session report must accumulate both accounts')
        assert.strictEqual(sessionReport.totalMb, 12)
        assert.strictEqual(sessionReport.blockedRequests, 3)
        assert.strictEqual(sessionReport.breakdownMb['xhr/fetch'], 4)
        assert.strictEqual(sessionReport.budgetMb, 40)
        assert.strictEqual(sessionReport.budgetResult.status, 'PASS')

        // Explicit resetSessionStats clears session stats
        manager.resetSessionStats()
        const clearedReport = manager.getSessionReport()
        assert.strictEqual(clearedReport.totalBytes, 0, 'resetSessionStats must reset session stats to 0')
        assert.strictEqual(clearedReport.totalMb, 0)
        assert.strictEqual(clearedReport.blockedRequests, 0)

        console.log('✅ Test 1 Passed: DataSaverManager sessionStats retention across resetAccountQuota calls verified')
    }

    // Test 2: MicrosoftRewardsBot shutdown bandwidth telemetry banner formatting & idempotency guard
    {
        const manager = DataSaverManager.getInstance()
        manager.resetSessionStats()

        // Setup mock transferred resources and blocked requests
        manager.recordTransferredResource('document', 1024 * 1024)
        manager.recordTransferredResource('script', 2 * 1024 * 1024)
        manager.recordTransferredResource('xhr/fetch', 512 * 1024)
        manager.recordBlockedRequest()
        manager.recordBlockedRequest()

        const bot = new MicrosoftRewardsBot()
        bot.sessionStartTime = Date.now() - 120000 // 2 minutes ago
        bot.sessionTotalAccounts = 4
        bot.sessionCompletedAccounts = 2
        bot.sessionActiveAccountEmail = 'active_user@outlook.com'

        const loggedLines: string[] = []
        const originalConsoleLog = console.log
        console.log = (msg: string) => {
            loggedLines.push(msg)
        }

        try {
            // First call with SIGINT
            bot.logSessionBandwidthSummary('SIGINT')

            assert.ok(loggedLines.length >= 7, 'Banner must print at least 7 formatted lines')
            assert.ok(loggedLines.some(l => l.includes('[MAIN] [SHUTDOWN] 🛑 INTERUPSI TERDETEKSI (SIGINT / Operator Stop)')))
            assert.ok(loggedLines.some(l => l.includes('Total Bandwidth Terpakai')))
            assert.ok(loggedLines.some(l => l.includes('Rincian Data: doc=')))
            assert.ok(loggedLines.some(l => l.includes('Durasi Berjalan') && l.includes('Akun Diproses: 2/4 (Aktif: active_user@outlook.com)')))
            assert.ok(loggedLines.some(l => l.includes('Request Diblokir') && l.includes('2 request hemat kuota')))

            // Second call - Idempotency guard must prevent duplicate logging
            const lineCountAfterFirst = loggedLines.length
            bot.logSessionBandwidthSummary('SIGINT')
            assert.strictEqual(
                loggedLines.length,
                lineCountAfterFirst,
                'Idempotency guard must suppress duplicate shutdown logs on repeated signals'
            )
        } finally {
            console.log = originalConsoleLog
        }

        // Test C2-STOP signal label
        const bot2 = new MicrosoftRewardsBot()
        bot2.sessionStartTime = Date.now() - 60000
        bot2.sessionTotalAccounts = 1
        bot2.sessionCompletedAccounts = 0
        bot2.sessionActiveAccountEmail = 'c2_user@outlook.com'

        const c2Lines: string[] = []
        console.log = (msg: string) => {
            c2Lines.push(msg)
        }

        try {
            bot2.logSessionBandwidthSummary('C2-STOP')
            assert.ok(c2Lines.some(l => l.includes('(C2-STOP / Operator Stop)')))
        } finally {
            console.log = originalConsoleLog
        }

        console.log('✅ Test 2 Passed: MicrosoftRewardsBot shutdown banner formatting and idempotency guard verified')
    }

    // Test 3: Linux Mobile Anti-Fingerprint Hardening
    {
        // 1. Client Hints metadata verification
        const mobileHints = BrowserEnvironmentPolicy.getClientHintsMetadata('mobile')
        assert.ok(mobileHints, 'Mobile client hints must be defined')
        assert.strictEqual(mobileHints.platform, 'Android', 'Platform must strictly report Android')
        assert.strictEqual(mobileHints.userAgentMetadata.platform, 'Android')
        assert.strictEqual(mobileHints.userAgentMetadata.mobile, true)

        // 2. applyMobileStealth script verification
        const initScripts: any[] = []
        const pageListeners: any[] = []
        const mockContext = {
            addInitScript: async (fn: any, args: any) => {
                initScripts.push({ fn, args })
            },
            on: (event: string, handler: any) => {
                if (event === 'page') pageListeners.push(handler)
            },
            pages: () => []
        }

        await BrowserEnvironmentPolicy.applyMobileStealth(mockContext)
        assert.strictEqual(initScripts.length, 1, 'applyMobileStealth must register init script')
        assert.strictEqual(initScripts[0].args.vendor, 'Qualcomm', 'Default WebGL vendor must be Qualcomm')
        assert.strictEqual(initScripts[0].args.renderer, 'Adreno (TM) 740', 'Default WebGL renderer must be Adreno (TM) 740')

        // Pixel override test
        const pixelContext = {
            addInitScript: async (fn: any, args: any) => {
                initScripts.push({ fn, args })
            },
            on: () => {},
            pages: () => []
        }
        await BrowserEnvironmentPolicy.applyMobileStealth(pixelContext, {
            accountId: 'dummy',
            storageKey: 'dummy',
            device: { id: 'google-pixel-7' } as any,
            createdAt: ''
        })
        assert.strictEqual(initScripts[1].args.vendor, 'ARM')
        assert.strictEqual(initScripts[1].args.renderer, 'Mali-G710 MC10')

        console.log('✅ Test 3 Passed: Linux mobile anti-fingerprint WebGL and platform overrides verified')
    }

    // Test 4: Local System URI Protocol Guard (ms-search:, microsoft-edge:, ms-windows-store:, intent:)
    {
        assert.strictEqual(isLocalSystemProtocol('ms-search:query=bing'), true)
        assert.strictEqual(isLocalSystemProtocol('microsoft-edge://https://rewards.bing.com'), true)
        assert.strictEqual(isLocalSystemProtocol('microsoft-edge:https://rewards.bing.com'), true)
        assert.strictEqual(isLocalSystemProtocol('ms-windows-store://pdp/?productid=9WZDNCRFHVQM'), true)
        assert.strictEqual(isLocalSystemProtocol('intent:#Intent;scheme=bing;package=com.microsoft.bing;end'), true)
        assert.strictEqual(isLocalSystemProtocol('https://www.bing.com'), false)
        assert.strictEqual(isLocalSystemProtocol('http://localhost:3000'), false)

        // interceptLocalSystemProtocol with simulated dwell-time
        let warned = false
        const mockLogger = {
            warn: (_isMobile: any, title: string, msg: string) => {
                if (title === 'PUNCHCARD' && msg.includes('[URI-GUARD]')) {
                    warned = true
                }
            }
        }

        const start = Date.now()
        const intercepted = await interceptLocalSystemProtocol(
            'ms-search:query=bing',
            mockLogger,
            false,
            50
        )
        const elapsed = Date.now() - start

        assert.strictEqual(intercepted, true, 'interceptLocalSystemProtocol must return true for local protocol')
        assert.strictEqual(warned, true, 'Logger must log warning on interception')
        assert.ok(elapsed >= 40, 'Dwell time must be executed')

        const normalUrlIntercepted = await interceptLocalSystemProtocol('https://rewards.bing.com', mockLogger)
        assert.strictEqual(normalUrlIntercepted, false, 'Standard HTTPS must not be intercepted')

        console.log('✅ Test 4 Passed: Local system URI interception and dwell-time bypass verified')
    }

    console.log('🎉 ALL CHAPTER 29 SIGINT BANDWIDTH TELEMETRY & LINUX HARDENING TESTS PASSED SUCCESSFULLY!')
}
