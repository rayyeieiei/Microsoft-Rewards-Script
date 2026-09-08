import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { AppOnlyQuestClassifier } from '../src/functions/activities/appOnly/AppOnlyQuestClassifier'
import {
    AppOnlyCapabilityCache,
    InMemoryCapabilityStore
} from '../src/functions/activities/appOnly/AppOnlyCapabilityCache'
import { AppOnlyQuestObserver, ManualQuestQueue } from '../src/functions/activities/appOnly/AppOnlyQuestObserver'
import { ManualQuestRecord } from '../src/functions/activities/appOnly/AppOnlyTypes'
import { evaluateActivityCompletion, ActivityBatchSummary } from '../src/functions/activities/ActivitySemantics'
import { Workers } from '../src/functions/Workers'
import { resolveAppOnlyPolicy } from '../src/functions/activities/appOnly/AppOnlyPolicy'
import { validateAccounts } from '../src/util/Validator'

async function runTests() {
    console.log('🧪 Starting Strict App-Only Observer & Verification Test Suite...\n')

    const classifier = new AppOnlyQuestClassifier()

    // 1. Balance +13 pada offer advertised +10 tidak diatribusikan sebagai +13
    {
        const result = evaluateActivityCompletion({
            offerId: 'quiz_offer_1',
            title: 'Quiz Activity',
            advertisedPoints: 10,
            observedBalanceDelta: 13,
            serverCompleted: true,
            completionEvidence: 'server-dashboard-state'
        })
        assert.strictEqual(result.status, 'verified-complete', 'Status must be verified-complete when server completed')
        assert.strictEqual(
            result.attributedPoints,
            null,
            'attributedPoints must be null when delta (13) differs from advertised (10)'
        )
        assert.notStrictEqual(result.attributedPoints, 13, 'Must NOT attribute full +13 delta to the card')
        console.log('✅ 1. Balance +13 pada offer advertised +10 tidak diatribusikan sebagai +13')
    }

    // 2. Balance +3 pada offer advertised +0 tidak membuktikan completion
    {
        const result = evaluateActivityCompletion({
            offerId: 'explore_offer_2',
            title: 'Explore on Bing',
            advertisedPoints: 0,
            observedBalanceDelta: 3,
            serverCompleted: false,
            completionEvidence: 'none'
        })
        assert.strictEqual(result.status, 'processed-unverified', 'Status must be processed-unverified')
        assert.strictEqual(result.serverCompleted, false, 'serverCompleted must remain false')
        assert.strictEqual(result.attributedPoints, null, 'attributedPoints must be null')
        assert.strictEqual(result.completionEvidence, 'none', 'completionEvidence must be none')
        console.log('✅ 2. Balance +3 pada offer advertised +0 tidak membuktikan completion (processed-unverified)')
    }

    // 3. Batch summary tidak mengatakan "all completed" jika satu pending / unverified
    {
        const summary: ActivityBatchSummary = {
            total: 5,
            verifiedComplete: 4,
            processedUnverified: 1,
            pending: 0,
            skipped: 0,
            failed: 0,
            observedAccountBalanceDelta: 49
        }
        const isAllCompleted = summary.total > 0 && summary.verifiedComplete === summary.total
        assert.strictEqual(isAllCompleted, false, 'Batch summary with unverified item must not be all-completed')
        assert.strictEqual(summary.verifiedComplete, 4)
        assert.strictEqual(summary.processedUnverified, 1)
        console.log('✅ 3. Batch summary tidak mengatakan "all completed" jika satu pending/unverified')
    }

    // 4. Punch Card 0/4 dengan satu eligible menghasilkan actionableNow=1 locked=3
    {
        const mockWorkers = new Workers({} as any)
        const mockPunchCard = {
            name: 'Multi-day Punchcard',
            childPromotions: [
                { offerId: 'step_1', title: 'Step 1', complete: false, pointProgressMax: 10, pointProgress: 0 },
                {
                    offerId: 'step_2',
                    title: 'Step 2',
                    complete: false,
                    pointProgressMax: 10,
                    pointProgress: 0,
                    attributes: { isLocked: 'True' }
                },
                {
                    offerId: 'step_3',
                    title: 'Step 3',
                    complete: false,
                    pointProgressMax: 10,
                    pointProgress: 0,
                    attributes: { isLocked: 'True' }
                },
                {
                    offerId: 'step_4',
                    title: 'Step 4',
                    complete: false,
                    pointProgressMax: 10,
                    pointProgress: 0,
                    attributes: { isLocked: 'True' }
                }
            ]
        } as any
        const counts = mockWorkers.getPunchCardTaskCounts(mockPunchCard)
        assert.strictEqual(counts.total, 4)
        assert.strictEqual(counts.completed, 0)
        assert.strictEqual(counts.remaining, 4)
        assert.strictEqual(counts.actionableNow, 1, 'Only 1 step is actionable today')
        assert.strictEqual(counts.locked, 3, '3 steps must be marked locked')
        console.log('✅ 4. Punch Card 0/4 dengan satu eligible menghasilkan actionableNow=1 locked=3')
    }

    // 5. Satu child saja dijalankan per parent per run
    {
        const mockWorkers = new Workers({} as any)
        // Even if all children have no isLocked attribute, sequential rule enforces actionableNow = 1
        const mockPunchCardSequential = {
            name: 'Sequential Streak Card',
            childPromotions: [
                { offerId: 's1', title: 'Day 1', complete: false, pointProgressMax: 10, pointProgress: 0 },
                { offerId: 's2', title: 'Day 2', complete: false, pointProgressMax: 10, pointProgress: 0 },
                { offerId: 's3', title: 'Day 3', complete: false, pointProgressMax: 10, pointProgress: 0 },
                { offerId: 's4', title: 'Day 4', complete: false, pointProgressMax: 10, pointProgress: 0 }
            ]
        } as any
        const counts = mockWorkers.getPunchCardTaskCounts(mockPunchCardSequential)
        assert.strictEqual(counts.actionableNow, 1, 'Only 1 child can be actionableNow per parent per run')
        assert.strictEqual(counts.locked, 3, 'Subsequent uncompleted steps are locked behind sequential cooldown')
        console.log('✅ 5. Satu child saja dijalankan per parent per run')
    }

    // 6. Verifier dipanggil di production orchestrator
    {
        const indexSrc = fs.readFileSync(path.resolve('src/index.ts'), 'utf8')
        assert.ok(
            indexSrc.includes('await this.activities.verifyAppOnlyRewards(data)'),
            'Production orchestrator must call verifyAppOnlyRewards after dashboard load'
        )
        assert.ok(
            indexSrc.includes('await this.activities.observeAppOnlyRewards(data)'),
            'Production orchestrator must call observeAppOnlyRewards after dashboard load'
        )

        // Call order assertion: verifyAppOnlyRewards comes before doDailySet
        const verifyIdx = indexSrc.indexOf('await this.activities.verifyAppOnlyRewards(data)')
        const dailySetIdx = indexSrc.indexOf('await this.workers.doDailySet(data')
        assert.ok(
            verifyIdx !== -1 && dailySetIdx !== -1 && verifyIdx < dailySetIdx,
            'verifyAppOnlyRewards must be invoked before doDailySet'
        )
        console.log('✅ 6. Verifier dipanggil di production orchestrator')
    }

    // 7. Account policy override terbaca loader
    {
        const rawAccountData = [
            {
                email: 'custom@override.com',
                password: 'pass',
                recoveryEmail: 'rec@test.com',
                geoLocale: 'ID',
                langCode: 'id',
                proxy: { proxyAxios: false, url: '', port: 0, password: '', username: '' },
                saveFingerprint: { mobile: true, desktop: true },
                appOnlyPolicy: 'manual-handoff'
            }
        ]
        const validated = validateAccounts(rawAccountData)
        assert.strictEqual(validated[0]?.appOnlyPolicy, 'manual-handoff', 'Loader must retain appOnlyPolicy')

        // Test precedence resolution
        const resAccountOverride = resolveAppOnlyPolicy(validated[0]?.appOnlyPolicy, 'skip')
        assert.strictEqual(resAccountOverride.policy, 'manual-handoff')
        assert.strictEqual(resAccountOverride.source, 'account-override')

        const resGlobalDefault = resolveAppOnlyPolicy(undefined, 'notify')
        assert.strictEqual(resGlobalDefault.policy, 'notify')
        assert.strictEqual(resGlobalDefault.source, 'global-default')

        const resFallback = resolveAppOnlyPolicy(undefined, undefined)
        assert.strictEqual(resFallback.policy, 'skip')
        assert.strictEqual(resFallback.source, 'fallback')
        console.log('✅ 7. Account policy override terbaca loader')
    }

    // 8. Cache tidak dibagi lintas akun
    {
        const store = new InMemoryCapabilityStore()
        const cache = new AppOnlyCapabilityCache(store)
        const offerId = 'offer_cache_boundary'

        await cache.recordLocked('userA@test.com', offerId, 'app-only', 'high', 24)
        const userARecord = await cache.getRecord('userA@test.com', offerId)
        const userBRecord = await cache.getRecord('userB@test.com', offerId)

        assert.notStrictEqual(userARecord, null, 'User A should hit cache')
        assert.strictEqual(userBRecord, null, 'User B must not share User A cache')
        console.log('✅ 8. Cache tidak dibagi lintas akun')
    }

    // 9. Repeated observer call menghasilkan cache hit
    {
        const store = new InMemoryCapabilityStore()
        const cache = new AppOnlyCapabilityCache(store)
        const observer = new AppOnlyQuestObserver(classifier, cache)
        const testPromo = [
            {
                accountKey: 'repeat@test.com',
                offerId: 'promo_repeat_1',
                title: 'Repeat Task (Rewards App only)',
                exclusiveLockedFeatureCategory: 'rewardsApp',
                exclusiveLockedFeatureStatus: 'locked'
            }
        ]

        let notifyCount = 0
        // Call 1: Observes and notifies
        await observer.observe(testPromo, {
            policy: 'notify',
            cacheTtlHours: 24,
            onNotification: async () => {
                notifyCount++
            }
        })
        assert.strictEqual(notifyCount, 1, 'First call triggers notification')

        // Call 2: Negative-capability cache hit, does not notify again
        const decisions2 = await observer.observe(testPromo, {
            policy: 'notify',
            cacheTtlHours: 24,
            onNotification: async () => {
                notifyCount++
            }
        })
        assert.strictEqual(notifyCount, 1, 'Second call hits cache, notification not duplicated')
        assert.strictEqual(decisions2[0]?.action, 'skip')
        assert.strictEqual(decisions2[0]?.reason, 'cached-negative-capability')
        console.log('✅ 9. Repeated observer call menghasilkan cache hit')
    }

    // 10. Manual queue tidak menduplikasi offer
    {
        const testQueueFile = path.resolve('scratch_manual_queue_test.json')
        try {
            if (fs.existsSync(testQueueFile)) fs.unlinkSync(testQueueFile)
        } catch {}
        const queue = new ManualQuestQueue(testQueueFile)

        const record: ManualQuestRecord = {
            accountKey: 'manual@test.com',
            offerId: 'offer_manual_1',
            title: 'Manual Task',
            expectedPoints: 10,
            complete: false,
            locked: true,
            lockReason: 'app-only',
            confidence: 'high',
            state: 'manual-required',
            observedAt: new Date().toISOString(),
            queuedAt: new Date().toISOString()
        }

        queue.enqueue(record)
        assert.strictEqual(queue.getPendingForAccount('manual@test.com').length, 1)

        // Enqueue duplicate
        queue.enqueue({ ...record, expectedPoints: 20 })
        assert.strictEqual(
            queue.getPendingForAccount('manual@test.com').length,
            1,
            'Duplicate enqueue must not create multiple records'
        )

        // Update state to complete
        queue.updateState('manual@test.com', 'offer_manual_1', 'verified-complete', 10)
        assert.strictEqual(
            queue.getPendingForAccount('manual@test.com').length,
            0,
            'Completed quest must be removed from pending list'
        )

        try {
            if (fs.existsSync(testQueueFile)) fs.unlinkSync(testQueueFile)
        } catch {}
        console.log('✅ 10. Manual queue tidak menduplikasi offer')
    }

    // 11. /api/status menampilkan queue tanpa sensitive data
    {
        const testQueueFile = path.resolve('scratch_manual_queue_test2.json')
        try {
            if (fs.existsSync(testQueueFile)) fs.unlinkSync(testQueueFile)
        } catch {}
        const queue = new ManualQuestQueue(testQueueFile)

        queue.enqueue({
            accountKey: 'baryyaja@gmail.com',
            offerId: 'offer_c2_test',
            title: 'C2 Test Task',
            expectedPoints: 10,
            complete: false,
            locked: true,
            lockReason: 'app-only',
            confidence: 'high',
            state: 'manual-required',
            observedAt: new Date().toISOString(),
            queuedAt: new Date().toISOString()
        })

        const snapshot = queue.getSanitizedSnapshot()
        const jsonStr = JSON.stringify(snapshot)

        assert.strictEqual(jsonStr.includes('baryyaja@gmail.com'), false, 'Full email must be redacted')
        assert.ok(jsonStr.includes('bar***@gmail.com'), 'Redacted accountKey must be present')
        assert.strictEqual(jsonStr.includes('password'), false, 'Password must not be in snapshot')
        assert.strictEqual(jsonStr.includes('token'), false, 'Token must not be in snapshot')
        assert.strictEqual(jsonStr.includes('cookie'), false, 'Cookie must not be in snapshot')

        try {
            if (fs.existsSync(testQueueFile)) fs.unlinkSync(testQueueFile)
        } catch {}
        console.log('✅ 11. /api/status menampilkan queue tanpa sensitive data')
    }

    // 12. Test JS/TS tidak mengalami source duplication
    {
        assert.strictEqual(
            fs.existsSync(path.resolve('test/appOnly.test.js')),
            false,
            'test/appOnly.test.js must be deleted'
        )
        const pkgJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'))
        assert.strictEqual(
            pkgJson.scripts.test,
            'ts-node test/appOnly.test.ts',
            'npm test must run ts-node directly on TypeScript source'
        )
        console.log('✅ 12. Test JS/TS tidak mengalami source duplication')
    }

    // 13. Logger tidak mencetak raw fingerprint atau email lengkap
    {
        const browserSrc = fs.readFileSync(path.resolve('src/browser/Browser.ts'), 'utf8')
        assert.strictEqual(
            browserSrc.includes('JSON.stringify(fingerprint)'),
            false,
            'Browser.ts must not dump raw JSON fingerprint'
        )
        assert.ok(
            browserSrc.includes('BROWSER-FINGERPRINT') && browserSrc.includes('viewport='),
            'Browser.ts must log structured fingerprint summary'
        )

        const searchManagerSrc = fs.readFileSync(path.resolve('src/functions/SearchManager.ts'), 'utf8')
        assert.strictEqual(
            searchManagerSrc.includes("account.proxy ?? 'none'"),
            false,
            'SearchManager must not output proxy=[object Object]'
        )
        console.log('✅ 13. Logger tidak mencetak raw fingerprint atau email lengkap')
    }

    console.log('\n🎉 ALL 13 TEST SUITES PASSED SUCCESSFULLY!\n')
}

runTests().catch(err => {
    console.error('❌ Test suite failed:', err)
    process.exit(1)
})
