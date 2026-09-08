const assert = require('assert')
const fs = require('fs')
const path = require('path')

const { AppOnlyQuestClassifier } = require('../dist/functions/activities/appOnly/AppOnlyQuestClassifier')
const {
    AppOnlyCapabilityCache,
    InMemoryCapabilityStore
} = require('../dist/functions/activities/appOnly/AppOnlyCapabilityCache')
const { AppOnlyQuestObserver, ManualQuestQueue } = require('../dist/functions/activities/appOnly/AppOnlyQuestObserver')
const { AppOnlyQuestVerifier } = require('../dist/functions/activities/appOnly/AppOnlyQuestVerifier')
const { WindowsAppRewards } = require('../dist/functions/activities/app/WindowsAppRewards')
const { redactAccountKey } = require('../dist/functions/activities/appOnly/AppOnlyTypes')

async function runTests() {
    console.log('🧪 Starting App-Only Observer Flow Test Suite...\n')

    const classifier = new AppOnlyQuestClassifier()

    // 1. Explicit App-Only + locked → app-only/high
    {
        const quest = classifier.classify({
            accountKey: 'testuser@example.com',
            offerId: 'offer_app_explicit',
            title: 'Shop your way to Namaste',
            exclusiveLockedFeatureCategory: 'rewardsApp',
            exclusiveLockedFeatureStatus: 'locked'
        })
        assert.strictEqual(quest.lockReason, 'app-only', 'Fixture 1 failed: lockReason must be app-only')
        assert.strictEqual(quest.confidence, 'high', 'Fixture 1 failed: confidence must be high')
        assert.strictEqual(quest.locked, true, 'Fixture 1 failed: quest must be locked')
        console.log('✅ 1. Explicit App-Only + locked -> app-only/high')
    }

    // 2. Localized title `(Rewards App only)` without metadata → app-only/medium
    {
        const quest = classifier.classify({
            accountKey: 'testuser@example.com',
            offerId: 'offer_app_text',
            title: 'Moon miracles (Rewards App only)',
            isLocked: true
        })
        assert.strictEqual(quest.lockReason, 'app-only', 'Fixture 2 failed: lockReason must be app-only')
        assert.strictEqual(quest.confidence, 'medium', 'Fixture 2 failed: confidence must be medium')
        assert.strictEqual(quest.locked, true, 'Fixture 2 failed: quest must be locked')
        console.log('✅ 2. Localized title (Rewards App only) without metadata -> app-only/medium')
    }

    // 3. Generic locked task → unknown
    {
        const quest = classifier.classify({
            accountKey: 'testuser@example.com',
            offerId: 'offer_generic_locked',
            title: 'Generic Locked Quest',
            isLocked: true
        })
        assert.strictEqual(quest.lockReason, 'unknown', 'Fixture 3 failed: lockReason must be unknown')
        assert.strictEqual(quest.locked, true, 'Fixture 3 failed: quest must be locked')
        console.log('✅ 3. Generic locked task -> unknown')
    }

    // 4. Future task → future-dated
    {
        const futureDate = new Date(Date.now() + 86400000).toISOString()
        const quest = classifier.classify({
            accountKey: 'testuser@example.com',
            offerId: 'offer_future',
            title: 'Future Promotion',
            availableFrom: futureDate
        })
        assert.strictEqual(quest.lockReason, 'future-dated', 'Fixture 4 failed: lockReason must be future-dated')
        assert.strictEqual(quest.locked, true, 'Fixture 4 failed: quest must be locked')
        console.log('✅ 4. Future task -> future-dated')
    }

    // 5. Cooldown child → cooldown
    {
        const quest = classifier.classify({
            accountKey: 'testuser@example.com',
            offerId: 'offer_cooldown',
            title: 'Cooldown Quest',
            attributes: { is_cooldown: true }
        })
        assert.strictEqual(quest.lockReason, 'cooldown', 'Fixture 5 failed: lockReason must be cooldown')
        assert.strictEqual(quest.locked, true, 'Fixture 5 failed: quest must be locked')
        console.log('✅ 5. Cooldown child -> cooldown')
    }

    // 6. Completed App-Only → completed
    {
        const quest = classifier.classify({
            accountKey: 'testuser@example.com',
            offerId: 'offer_completed',
            title: 'Completed Quest (Rewards App only)',
            complete: true,
            exclusiveLockedFeatureCategory: 'rewardsApp'
        })
        assert.strictEqual(quest.complete, true, 'Fixture 6 failed: complete must be true')
        assert.strictEqual(quest.lockReason, 'completed', 'Fixture 6 failed: lockReason must be completed')
        assert.strictEqual(quest.locked, false, 'Fixture 6 failed: completed quest is not locked')
        console.log('✅ 6. Completed App-Only -> completed')
    }

    // 7. Destination rnoreward=1 without other markers → never automatic high confidence
    {
        const quest = classifier.classify({
            accountKey: 'testuser@example.com',
            offerId: 'offer_rnoreward',
            title: 'Some Quest',
            destinationUrl: 'https://www.bing.com/search?q=Test&rnoreward=1',
            isLocked: true
        })
        assert.notStrictEqual(quest.confidence, 'high', 'Fixture 7 failed: rnoreward alone must not be high confidence')
        console.log('✅ 7. Destination rnoreward=1 without markers -> confidence is not high')
    }

    // 8. 5 App-Only and 3 normal promotions → only 5 are skipped
    {
        const promos = [
            // 5 App-Only
            {
                accountKey: 'test@example.com',
                offerId: 'app1',
                title: 'App 1',
                exclusiveLockedFeatureCategory: 'rewardsApp'
            },
            { accountKey: 'test@example.com', offerId: 'app2', title: 'App 2 (Rewards App only)' },
            {
                accountKey: 'test@example.com',
                offerId: 'app3',
                title: 'App 3',
                exclusiveLockedFeatureCategory: 'rewardsApp'
            },
            { accountKey: 'test@example.com', offerId: 'app4', title: 'App 4 (Rewards App only)' },
            {
                accountKey: 'test@example.com',
                offerId: 'app5',
                title: 'App 5',
                exclusiveLockedFeatureCategory: 'rewardsApp'
            },
            // 3 Normal Promotions
            { accountKey: 'test@example.com', offerId: 'norm1', title: 'Normal 1', isLocked: false },
            { accountKey: 'test@example.com', offerId: 'norm2', title: 'Normal 2', isLocked: false },
            { accountKey: 'test@example.com', offerId: 'norm3', title: 'Normal 3', isLocked: false }
        ]

        const observer = new AppOnlyQuestObserver()
        const decisions = await observer.observe(promos, { policy: 'skip', cacheTtlHours: 24 })

        const skipped = decisions.filter(d => d.action === 'skip')
        const ignored = decisions.filter(d => d.action === 'ignore')

        assert.strictEqual(skipped.length, 5, 'Fixture 8 failed: exactly 5 app-only cards must be skipped')
        assert.strictEqual(ignored.length, 3, 'Fixture 8 failed: 3 normal cards must not be skipped')
        console.log('✅ 8. Heterogeneous batch (5 App-Only + 3 Normal) -> only 5 skipped, normal cards preserved')
    }

    // 9. Account A cached locked → Account B with same offer does NOT get cache hit
    {
        const store = new InMemoryCapabilityStore()
        const cache = new AppOnlyCapabilityCache(store)

        const accA = 'userA@domain.com'
        const accB = 'userB@domain.com'
        const offer = 'shared_offer_123'

        await cache.recordLocked(accA, offer, 'app-only', 'high', 24)

        const hitA = await cache.getRecord(accA, offer)
        const hitB = await cache.getRecord(accB, offer)

        assert.notStrictEqual(hitA, null, 'Fixture 9 failed: Account A must have cache hit')
        assert.strictEqual(hitB, null, 'Fixture 9 failed: Account B must NOT have cache hit')
        console.log('✅ 9. Cache strict isolation between Account A and Account B verified')
    }

    // 10. Verifier does NOT mark completion from simulated HTTP 200 or DOM interaction
    {
        const queue = new ManualQuestQueue()
        queue.clear()
        const verifier = new AppOnlyQuestVerifier(queue)

        const accKey = 'operator@domain.com'
        const offerId = 'manual_test_offer'

        queue.enqueue({
            accountKey: redactAccountKey(accKey),
            offerId,
            title: 'Manual Task',
            expectedPoints: 10,
            complete: false,
            locked: true,
            lockReason: 'app-only',
            confidence: 'high',
            observedAt: new Date().toISOString(),
            state: 'manual-required',
            queuedAt: new Date().toISOString()
        })

        // Server payload still returns complete: false
        const serverPromos = [
            {
                accountKey: accKey,
                offerId,
                title: 'Manual Task',
                complete: false,
                pointProgress: 0,
                pointProgressMax: 10
            }
        ]

        const results = await verifier.verify(serverPromos, { accountKey: accKey })
        assert.strictEqual(
            results[0]?.complete,
            false,
            'Fixture 10 failed: verifier must not mark completion when server complete is false'
        )
        assert.strictEqual(
            queue.getPendingForAccount(redactAccountKey(accKey))[0]?.state,
            'manual-required',
            'Fixture 10 failed: state must remain manual-required'
        )
        console.log('✅ 10. Verifier rejects non-server completion (DOM/HTTP 200 without server balance/progress)')
    }

    // 11. Verifier marks completion when dashboard server confirms
    {
        const queue = new ManualQuestQueue()
        queue.clear()
        const cache = new AppOnlyCapabilityCache(new InMemoryCapabilityStore())
        const verifier = new AppOnlyQuestVerifier(queue, cache)

        const accKey = 'operator@domain.com'
        const offerId = 'verified_offer'

        // Record locked in cache
        await cache.recordLocked(redactAccountKey(accKey), offerId, 'app-only', 'high', 24)

        queue.enqueue({
            accountKey: redactAccountKey(accKey),
            offerId,
            title: 'Verified Task',
            expectedPoints: 10,
            complete: false,
            locked: true,
            lockReason: 'app-only',
            confidence: 'high',
            observedAt: new Date().toISOString(),
            state: 'manual-required',
            queuedAt: new Date().toISOString()
        })

        // Server payload confirms complete: true
        const serverPromos = [
            {
                accountKey: accKey,
                offerId,
                title: 'Verified Task',
                complete: true,
                pointProgress: 10,
                pointProgressMax: 10
            }
        ]

        const results = await verifier.verify(serverPromos, {
            accountKey: accKey,
            previousBalance: 1000,
            currentBalance: 1010
        })

        assert.strictEqual(results[0]?.complete, true, 'Fixture 11 failed: verifier must mark complete')
        assert.strictEqual(results[0]?.balanceDelta, 10, 'Fixture 11 failed: delta must be 10')

        // Negative cache must be cleared
        const cachedAfter = await cache.getRecord(redactAccountKey(accKey), offerId)
        assert.strictEqual(cachedAfter, null, 'Fixture 11 failed: negative cache must be invalidated upon completion')
        console.log('✅ 11. Verifier confirms completion on server confirmation and clears negative cache')
    }

    // 12. Policy skip, notify, and manual-handoff are non-blocking
    {
        const observer = new AppOnlyQuestObserver()
        const promo = [
            {
                accountKey: 'flow@test.com',
                offerId: 'policy_test',
                title: 'Policy Test (Rewards App only)'
            }
        ]

        let notified = false
        let queued = false

        // Test skip
        const startSkip = Date.now()
        await observer.observe(promo, { policy: 'skip', cacheTtlHours: 24 })
        assert.ok(Date.now() - startSkip < 500, 'Skip policy must complete immediately')

        // Test notify
        const startNotify = Date.now()
        await observer.observe(promo, {
            policy: 'notify',
            cacheTtlHours: 24,
            onNotification: async () => {
                notified = true
            }
        })
        assert.ok(Date.now() - startNotify < 500, 'Notify policy must complete immediately')
        assert.strictEqual(notified, true, 'onNotification callback must be invoked')

        // Test manual-handoff
        const startManual = Date.now()
        await observer.observe(promo, {
            policy: 'manual-handoff',
            cacheTtlHours: 24,
            onManualRequired: async () => {
                queued = true
            }
        })
        assert.ok(Date.now() - startManual < 500, 'Manual-handoff policy must complete immediately')
        assert.strictEqual(queued, true, 'onManualRequired callback must be invoked')

        console.log('✅ 12. Policies (skip, notify, manual-handoff) operate non-blocking (<500ms)')
    }

    // 13. Regression Assertions: Verify no DAPI POST or browser automation in WindowsAppRewards
    {
        const proto = WindowsAppRewards.prototype
        assert.strictEqual(typeof proto.doWindowsAppRewards, 'function', 'doWindowsAppRewards entrypoint must exist')

        // Verify WindowsAppRewards source code does not contain banned live spoofing keywords
        const srcCode = fs.readFileSync(path.resolve('src/functions/activities/app/WindowsAppRewards.ts'), 'utf8')

        assert.strictEqual(
            srcCode.includes('prod.rewardsplatform.microsoft.com/dapi/me/activities'),
            false,
            'Regression failed: WindowsAppRewards must NOT contain DAPI POST endpoint'
        )
        assert.strictEqual(
            srcCode.includes('tab.goto'),
            false,
            'Regression failed: WindowsAppRewards must NOT navigate tabs via Playwright'
        )
        assert.strictEqual(
            srcCode.includes('context.newPage'),
            false,
            'Regression failed: WindowsAppRewards must NOT spawn browser pages'
        )
        assert.strictEqual(
            srcCode.includes('rnoreward=1'),
            false,
            'Regression failed: WindowsAppRewards must NOT manipulate rnoreward query parameters'
        )
        assert.strictEqual(
            srcCode.includes('EmbeddedBrowserWebView/1.0'),
            false,
            'Regression failed: WindowsAppRewards must NOT spoof WebView2 UA'
        )

        console.log(
            '✅ 13. Regression assertions passed: Zero DAPI POST, zero browser tab navigation, zero UA spoofing'
        )
    }

    console.log('\n🎉 ALL 13 TEST SUITES PASSED SUCCESSFULLY!\n')
}

runTests().catch(err => {
    console.error('❌ Test suite failed:', err)
    process.exit(1)
})
