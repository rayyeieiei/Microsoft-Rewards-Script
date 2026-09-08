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
import { resolveAppOnlyPolicy } from '../src/functions/activities/appOnly/AppOnlyPolicy'
import { validateAccounts } from '../src/util/Validator'

export async function runAppOnlyObserverTests() {
    console.log('--- Running App-Only Observer & Verifier Test Suite ---')

    const classifier = new AppOnlyQuestClassifier()

    // Test 9: App-Only verifier is called exactly once per account run
    {
        const indexSrc = fs.readFileSync(path.resolve('src/index.ts'), 'utf8')
        const windowsAppSrc = fs.readFileSync(path.resolve('src/functions/activities/app/WindowsAppRewards.ts'), 'utf8')

        // 1. Verify orchestrator index.ts invokes the verifier before doDailySet
        const hasVerifierCall =
            indexSrc.includes('verifyExistingManualQuests') || indexSrc.includes('verifyAppOnlyRewards')
        assert.ok(hasVerifierCall, 'index.ts must invoke manual quest verifier')

        const hasObserverCall = indexSrc.includes('observeAppOnlyRewards(data)')
        assert.ok(hasObserverCall, 'index.ts must invoke observeAppOnlyRewards')

        // 2. Verify WindowsAppRewards.doWindowsAppRewards() does NOT have redundant internal this.verifier.verify call
        const doWindowsAppRewardsMatch = windowsAppSrc.match(/async doWindowsAppRewards\([^)]*\)\s*:[^{]*\{([\s\S]*?)\n\s*return decisions/i)
        const observerBody = doWindowsAppRewardsMatch?.[1] ?? ''
        assert.ok(doWindowsAppRewardsMatch, 'doWindowsAppRewards method must exist in WindowsAppRewards.ts')
        assert.strictEqual(
            observerBody.includes('this.verifier.verify('),
            false,
            'WindowsAppRewards.doWindowsAppRewards() must NOT invoke this.verifier.verify internally (prevent duplicate verifier runs)'
        )
        console.log('✅ Test 9 Passed: App-Only verifier is called exactly once per account run without duplicate calls')
    }

    // Account policy override validation
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
        assert.strictEqual(validated[0]?.appOnlyPolicy, 'manual-handoff')

        const resAccountOverride = resolveAppOnlyPolicy(validated[0]?.appOnlyPolicy, 'skip')
        assert.strictEqual(resAccountOverride.policy, 'manual-handoff')
        assert.strictEqual(resAccountOverride.source, 'account-override')

        const resGlobalDefault = resolveAppOnlyPolicy(undefined, 'notify')
        assert.strictEqual(resGlobalDefault.policy, 'notify')
        assert.strictEqual(resGlobalDefault.source, 'global-default')

        const resFallback = resolveAppOnlyPolicy(undefined, undefined)
        assert.strictEqual(resFallback.policy, 'skip')
        assert.strictEqual(resFallback.source, 'fallback')
        console.log('✅ App-Only Policy precedence resolved correctly')
    }

    // Negative Capability Cache isolation between accounts
    {
        const store = new InMemoryCapabilityStore()
        const cache = new AppOnlyCapabilityCache(store)
        const offerId = 'offer_cache_boundary'

        await cache.recordLocked('userA@test.com', offerId, 'app-only', 'high', 24)
        const userARecord = await cache.getRecord('userA@test.com', offerId)
        const userBRecord = await cache.getRecord('userB@test.com', offerId)

        assert.notStrictEqual(userARecord, null, 'User A should hit cache')
        assert.strictEqual(userBRecord, null, 'User B must not share User A cache')
        console.log('✅ App-Only Cache is strictly isolated per account')
    }

    // Repeated observer call produces negative-capability cache hit
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
        await observer.observe(testPromo, {
            policy: 'notify',
            cacheTtlHours: 24,
            onNotification: async () => {
                notifyCount++
            }
        })
        assert.strictEqual(notifyCount, 1, 'First call triggers notification')

        const decisions2 = await observer.observe(testPromo, {
            policy: 'notify',
            cacheTtlHours: 24,
            onNotification: async () => {
                notifyCount++
            }
        })
        assert.strictEqual(notifyCount, 1, 'Second call hits cache and does not notify again')
        assert.strictEqual(decisions2[0]?.action, 'skip')
        assert.strictEqual(decisions2[0]?.reason, 'cached-negative-capability')
        console.log('✅ Repeated observer call yields negative capability cache hit')
    }

    // Manual queue deduplication
    {
        const testQueueFile = path.resolve('scratch_manual_queue_test_split.json')
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

        // Duplicate enqueue must update, not duplicate
        queue.enqueue({ ...record, expectedPoints: 20 })
        assert.strictEqual(queue.getPendingForAccount('manual@test.com').length, 1)

        queue.updateState('manual@test.com', 'offer_manual_1', 'verified-complete', 10)
        assert.strictEqual(queue.getPendingForAccount('manual@test.com').length, 0)

        try {
            if (fs.existsSync(testQueueFile)) fs.unlinkSync(testQueueFile)
        } catch {}
        console.log('✅ Manual queue deduplicates records properly')
    }

    // Sanitized queue snapshot for /api/status
    {
        const testQueueFile = path.resolve('scratch_manual_queue_test_split2.json')
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
        assert.strictEqual(jsonStr.includes('password'), false)
        assert.strictEqual(jsonStr.includes('token'), false)
        assert.strictEqual(jsonStr.includes('cookie'), false)

        try {
            if (fs.existsSync(testQueueFile)) fs.unlinkSync(testQueueFile)
        } catch {}
        console.log('✅ Sanitized snapshot redacts credentials and full email')
    }
}

if (require.main === module) {
    runAppOnlyObserverTests().catch(err => {
        console.error(err)
        process.exit(1)
    })
}
