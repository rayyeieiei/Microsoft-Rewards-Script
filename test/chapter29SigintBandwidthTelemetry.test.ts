import assert from 'assert'
import { DataSaverManager } from '../src/util/DataSaver'
import { MicrosoftRewardsBot } from '../src/index'

export async function runChapter29SigintBandwidthTelemetryTests(): Promise<void> {
    console.log('\n--- Running Chapter 29 SIGINT Bandwidth Telemetry Test Suite ---')

    const dsm = DataSaverManager.getInstance()

    // Test 1: Global Session Accumulator Multi-Account Preservation past resetAccountQuota
    {
        dsm.resetAll()

        const mb = 1024 * 1024
        // Acc 1 consumes 5 MB
        dsm.beginAccountQuota('acc1@example.com')
        dsm.recordTransferredResource('document', 2 * mb, 'acc1@example.com')
        dsm.recordTransferredResource('script', 3 * mb, 'acc1@example.com')
        dsm.recordBlockedRequest('acc1@example.com')

        // Acc 1 finishes and resetAccountQuota is called
        dsm.finishAccountQuota('acc1@example.com')
        dsm.resetAccountQuota('acc1@example.com')

        // Verify local account map deleted acc1
        assert.strictEqual(dsm.getAccountStats('acc1@example.com').totalBytes, 0)

        // Acc 2 consumes 3 MB
        dsm.beginAccountQuota('acc2@example.com')
        dsm.recordTransferredResource('image', 2 * mb, 'acc2@example.com')
        dsm.recordTransferredResource('xhr/fetch', 1 * mb, 'acc2@example.com')
        dsm.recordBlockedRequest('acc2@example.com')

        // Global session report should preserve 5 MB (acc1) + 3 MB (acc2) = 8 MB
        const report = dsm.getSessionReport(20 * mb, 2)
        assert.strictEqual(report.totalBytes, 8 * mb)
        assert.strictEqual(report.totalMb, 8)
        assert.strictEqual(report.budgetMb, 40)
        assert.strictEqual(report.budgetResult.status, 'PASS')
        assert.strictEqual(report.blockedRequests, 2)
        assert.strictEqual(report.breakdownMb.document, 2)
        assert.strictEqual(report.breakdownMb.script, 3)
        assert.strictEqual(report.breakdownMb.image, 2)
        assert.strictEqual(report.breakdownMb['xhr/fetch'], 1)

        console.log('✅ Test 1 Passed: Global Session Accumulator preserved across resetAccountQuota')
    }

    // Test 2: In-Flight Real-Time Aggregation & Immediacy
    {
        dsm.resetAll()
        const mb = 1024 * 1024

        dsm.beginAccountQuota('in_flight@example.com')
        // Mid-navigation chunk 1: 1.5 MB
        dsm.recordTransferredResource('xhr/fetch', 1.5 * mb, 'in_flight@example.com')
        dsm.recordBlockedRequest('in_flight@example.com')

        let snap = dsm.getSessionReport()
        assert.strictEqual(snap.totalMb, 1.5)
        assert.strictEqual(snap.blockedRequests, 1)

        // Mid-navigation chunk 2: 1.0 MB
        dsm.recordTransferredResource('script', 1.0 * mb, 'in_flight@example.com')
        snap = dsm.getSessionReport()
        assert.strictEqual(snap.totalMb, 2.5)

        console.log('✅ Test 2 Passed: In-flight metrics immediately aggregated in real-time')
    }

    // Test 3: Breakdown Category Integrity & MB conversion
    {
        dsm.resetAll()
        const mb = 1024 * 1024

        dsm.recordTransferredResource('document', 1 * mb)
        dsm.recordTransferredResource('script', 2 * mb)
        dsm.recordTransferredResource('xhr/fetch', 3 * mb)
        dsm.recordTransferredResource('image', 4 * mb)
        dsm.recordTransferredResource('other', 512 * 1024) // 0.5 MB

        const report = dsm.getSessionReport()
        assert.strictEqual(report.breakdownMb.document, 1)
        assert.strictEqual(report.breakdownMb.script, 2)
        assert.strictEqual(report.breakdownMb['xhr/fetch'], 3)
        assert.strictEqual(report.breakdownMb.image, 4)
        assert.strictEqual(report.breakdownMb.other, 0.5)
        assert.strictEqual(report.totalMb, 10.5)

        console.log('✅ Test 3 Passed: All category breakdowns and MB conversions are accurate')
    }

    // Test 4: Shutdown Telemetry Invocation & Output Formatting
    {
        dsm.resetAll()
        dsm.recordTransferredResource('document', 2 * 1024 * 1024)
        dsm.recordTransferredResource('xhr/fetch', 3 * 1024 * 1024)
        dsm.recordBlockedRequest()

        const bot = new MicrosoftRewardsBot()
        bot.sessionStartTime = Date.now() - 120000 // 2 minutes ago
        bot.sessionTotalAccounts = 5
        bot.sessionCompletedAccounts = 2
        bot.sessionActiveAccountEmail = 'active@example.com'

        const loggedLines: string[] = []
        bot.logger.info = (_isMobile: any, title: string, message: string) => {
            if (title === 'SHUTDOWN') {
                loggedLines.push(message)
            }
        }

        bot.logSessionBandwidthSummary('SIGINT')

        assert.strictEqual(loggedLines.length, 7, 'Shutdown banner must produce exactly 7 lines')
        assert.ok(loggedLines.some(l => l.includes('🛑 INTERUPSI TERDETEKSI (SIGINT / Operator Stop)')))
        assert.ok(loggedLines.some(l => l.includes('📊 Total Bandwidth Terpakai : 5 MB / Budget 100 MB [Status: PASS]')))
        assert.ok(loggedLines.some(l => l.includes('📁 Rincian Data: doc=2MB | js=0MB | xhr=3MB | img=0MB | other=0MB')))
        assert.ok(loggedLines.some(l => l.includes('⏱️ Durasi Berjalan         : 2.0 menit | Akun Diproses: 2/5 (Aktif: active@example.com)')))
        assert.ok(loggedLines.some(l => l.includes('🛡️ Request Diblokir        : 1 request hemat kuota')))

        console.log('✅ Test 4 Passed: Shutdown telemetry banner correctly formatted and logged')
    }

    // Test 5: Idempotency Guard (Anti-Spam Ctrl+C)
    {
        dsm.resetAll()
        const bot = new MicrosoftRewardsBot()

        let bannerCallCount = 0
        bot.logger.info = (_isMobile: any, title: string, message: string) => {
            if (title === 'SHUTDOWN' && message.includes('INTERUPSI TERDETEKSI')) {
                bannerCallCount++
            }
        }

        // Simulate operator pressing Ctrl+C 5 times rapidly
        bot.logSessionBandwidthSummary('SIGINT')
        bot.logSessionBandwidthSummary('SIGINT')
        bot.logSessionBandwidthSummary('SIGINT')
        bot.logSessionBandwidthSummary('SIGINT')
        bot.logSessionBandwidthSummary('SIGINT')

        assert.strictEqual(bannerCallCount, 1, 'Idempotency guard must prevent repeated banner outputs')

        console.log('✅ Test 5 Passed: Idempotency guard suppresses duplicate Ctrl+C interrupt logging')
    }

    // Test 6: C2 Web UI Shutdown Hook (requestShutdown('manual') -> C2-STOP)
    {
        dsm.resetAll()
        const bot = new MicrosoftRewardsBot()
        bot.sessionTotalAccounts = 2
        bot.sessionCompletedAccounts = 1

        const loggedLines: string[] = []
        bot.logger.info = (_isMobile: any, title: string, message: string) => {
            if (title === 'SHUTDOWN') {
                loggedLines.push(message)
            }
        }

        // Web UI trigger calls requestShutdown with reason 'manual'
        await bot.requestShutdown('manual', 500)

        assert.ok(
            loggedLines.some(l => l.includes('🛑 INTERUPSI TERDETEKSI (C2-STOP / Operator Stop)')),
            'Web UI shutdown must log banner with C2-STOP signal'
        )

        // Subsequent call to logSessionBandwidthSummary must be suppressed by guard
        const lineCountBefore = loggedLines.length
        bot.logSessionBandwidthSummary('SIGINT')
        assert.strictEqual(loggedLines.length, lineCountBefore, 'Subsequent signal must be suppressed')

        console.log('✅ Test 6 Passed: C2 Web UI shutdown correctly triggers C2-STOP banner')
    }

    // Test 7: Flush & Reset Lifecycle Across Batch Runs
    {
        dsm.resetAll()
        dsm.recordTransferredResource('document', 5 * 1024 * 1024)
        assert.strictEqual(dsm.getSessionReport().totalMb, 5)

        dsm.resetSessionStats()
        const freshReport = dsm.getSessionReport()
        assert.strictEqual(freshReport.totalBytes, 0)
        assert.strictEqual(freshReport.totalMb, 0)
        assert.strictEqual(freshReport.blockedRequests, 0)
        assert.strictEqual(freshReport.breakdownMb.document, 0)

        console.log('✅ Test 7 Passed: resetSessionStats cleans all counters for new run lifecycle')
    }
}
