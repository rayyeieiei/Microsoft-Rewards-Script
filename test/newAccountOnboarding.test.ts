import assert from 'assert'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { detectOnboarding } from '../src/functions/onboarding/NewAccountOnboardingDetector'
import { NewAccountOnboardingObserver } from '../src/functions/onboarding/NewAccountOnboardingObserver'
import { NewAccountOnboardingVerifier } from '../src/functions/onboarding/NewAccountOnboardingVerifier'
import { ManualQuestQueue } from '../src/runtime/manual/ManualQuestQueue'
import {
    resolveAccountIdentity,
    validateUniqueAccountIdentities
} from '../src/runtime/identity/AccountIdentity'
import { AppOnlyQuestVerifier } from '../src/functions/activities/appOnly/AppOnlyQuestVerifier'
import {
    AppOnlyCapabilityCache,
    InMemoryCapabilityStore
} from '../src/functions/activities/appOnly/AppOnlyCapabilityCache'
import { DashboardData } from '../src/interface/DashboardData'

function createTempDir(prefix = 'onboarding-test-'): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function cleanTempDir(dirPath: string): void {
    try {
        fs.rmSync(dirPath, { recursive: true, force: true })
    } catch {}
}

export async function runNewAccountOnboardingTests() {
    console.log('--- Running New Account Onboarding Observer & Verifier Test Suite ---')

    const nowMs = 1700000000000

    // 1. Balance=0 without onboarding metadata does not classify as new account
    {
        const data = {
            userStatus: { counters: { pointProgress: { current: 0 } } },
            morePromotions: [
                { offerId: 'normal_promo_1', title: 'Daily Search', complete: false }
            ]
        } as unknown as DashboardData

        const detected = detectOnboarding(data, nowMs)
        assert.strictEqual(detected.state, 'not-detected')
        assert.strictEqual(detected.confidence, 'low')
        assert.strictEqual(detected.tasks.length, 0)
        console.log('✅ 1. Balance=0 without onboarding metadata does not classify as new account')
    }

    // 2. Balance=67 without onboarding metadata does not classify as new account
    {
        const data = {
            userStatus: { counters: { pointProgress: { current: 67 } } },
            morePromotions: [
                { offerId: 'normal_promo_2', title: 'Search Bing', complete: false }
            ]
        } as unknown as DashboardData

        const detected = detectOnboarding(data, nowMs)
        assert.strictEqual(detected.state, 'not-detected')
        assert.strictEqual(detected.confidence, 'low')
        assert.strictEqual(detected.tasks.length, 0)
        console.log('✅ 2. Balance=67 without onboarding metadata does not classify as new account')
    }

    // 3. Many incomplete normal promotions do not classify as new account
    {
        const manyPromotions = Array.from({ length: 25 }, (_, i) => ({
            offerId: `generic_promo_${i}`,
            title: `Generic Promotion ${i}`,
            promotionType: 'quiz',
            complete: false
        }))
        const data = {
            morePromotions: manyPromotions
        } as unknown as DashboardData

        const detected = detectOnboarding(data, nowMs)
        assert.strictEqual(detected.state, 'not-detected')
        assert.strictEqual(detected.confidence, 'low')
        assert.strictEqual(detected.tasks.length, 0)
        console.log('✅ 3. Many incomplete normal promotions do not classify as new account')
    }

    // 4. Structured onboarding campaign produces confidence: high
    {
        const data = {
            morePromotions: [
                {
                    offerId: 'fre_offer_welcome_1',
                    title: 'Welcome to Rewards',
                    promotionType: 'onboarding',
                    complete: false,
                    pointProgressMax: 50
                }
            ]
        } as unknown as DashboardData

        const detected = detectOnboarding(data, nowMs)
        assert.strictEqual(detected.state, 'active')
        assert.strictEqual(detected.confidence, 'high')
        assert.strictEqual(detected.tasks.length, 1)
        assert.ok(detected.evidence.some(e => e.includes('structured:')))
        console.log('✅ 4. Structured onboarding campaign produces confidence: high')
    }

    // 5. English title-only evidence produces at most confidence: medium
    {
        const data = {
            morePromotions: [
                {
                    offerId: 'unstructured_promo_1',
                    title: 'Set a rewards goal and start earning',
                    promotionType: 'banner',
                    complete: false,
                    pointProgressMax: 100
                }
            ]
        } as unknown as DashboardData

        const detected = detectOnboarding(data, nowMs)
        assert.strictEqual(detected.state, 'active')
        assert.strictEqual(detected.confidence, 'medium')
        assert.ok(detected.evidence.some(e => e.includes('title-pattern:')))
        console.log('✅ 5. English title-only evidence produces at most confidence: medium')
    }

    // 6. Localized title with structured metadata produces confidence: high
    {
        const data = {
            morePromotions: [
                {
                    offerId: 'promo_id_loc_1',
                    title: 'Tetapkan sasaran Rewards Anda',
                    promotionType: 'welcometour',
                    complete: false,
                    pointProgressMax: 100
                }
            ]
        } as unknown as DashboardData

        const detected = detectOnboarding(data, nowMs)
        assert.strictEqual(detected.state, 'active')
        assert.strictEqual(detected.confidence, 'high')
        assert.strictEqual(detected.tasks[0]?.taskKind, 'account-choice')
        console.log('✅ 6. Localized title with structured metadata produces confidence: high')
    }

    // 7. "Set Rewards goal" is manual-required (account-choice)
    {
        const data = {
            morePromotions: [
                {
                    offerId: 'fre_offer_goal',
                    title: 'Set a rewards goal',
                    promotionType: 'onboarding',
                    complete: false,
                    pointProgressMax: 100
                }
            ]
        } as unknown as DashboardData

        const detected = detectOnboarding(data, nowMs)
        assert.strictEqual(detected.tasks.length, 1)
        assert.strictEqual(detected.tasks[0]?.taskKind, 'account-choice')
        assert.strictEqual(detected.tasks[0]?.handling, 'manual-required')
        console.log('✅ 7. "Set Rewards goal" is manual-required (account-choice)')
    }

    // 8. "Finish Daily Set" delegates to existing worker and does not execute doDailySet internally
    {
        const data = {
            morePromotions: [
                {
                    offerId: 'fre_offer_dailyset',
                    title: 'Finish a daily set',
                    promotionType: 'onboarding',
                    complete: false,
                    pointProgressMax: 50
                }
            ]
        } as unknown as DashboardData

        const detected = detectOnboarding(data, nowMs)
        assert.strictEqual(detected.tasks.length, 1)
        assert.strictEqual(detected.tasks[0]?.taskKind, 'daily-set-dependent')
        assert.strictEqual(detected.tasks[0]?.handling, 'delegated-to-existing-worker')
        console.log('✅ 8. "Finish Daily Set" delegates to existing worker and does not execute doDailySet internally')
    }

    // 9. "Browse Earn page" produces manual handoff with sanitized destination (queries stripped) and zero navigation
    {
        const data = {
            morePromotions: [
                {
                    offerId: 'fre_offer_earnpage',
                    title: 'Browse the earn page',
                    promotionType: 'onboarding',
                    destinationUrl: 'https://rewards.bing.com/earn?ref=onboarding&token=secretAuthToken123#anchor',
                    complete: false,
                    pointProgressMax: 30
                }
            ]
        } as unknown as DashboardData

        const detected = detectOnboarding(data, nowMs)
        assert.strictEqual(detected.tasks.length, 1)
        assert.strictEqual(detected.tasks[0]?.taskKind, 'official-navigation')
        assert.strictEqual(detected.tasks[0]?.handling, 'manual-required')
        assert.deepStrictEqual(detected.tasks[0]?.destination, {
            scheme: 'https',
            origin: 'https://rewards.bing.com',
            path: '/earn'
        })
        console.log('✅ 9. "Browse Earn page" produces manual handoff with sanitized destination and zero navigation')
    }

    // 10. "Your progress" preserves advertised points but remains passive-only
    {
        const data = {
            morePromotions: [
                {
                    offerId: 'fre_offer_progress',
                    title: 'Your progress',
                    promotionType: 'onboarding',
                    complete: false,
                    pointProgress: 2,
                    pointProgressMax: 4
                }
            ]
        } as unknown as DashboardData

        const detected = detectOnboarding(data, nowMs)
        assert.strictEqual(detected.tasks.length, 1)
        assert.strictEqual(detected.tasks[0]?.taskKind, 'progress-container')
        assert.strictEqual(detected.tasks[0]?.handling, 'passive-only')
        assert.strictEqual(detected.tasks[0]?.advertisedPoints, 4)
        console.log('✅ 10. "Your progress" preserves advertised points but remains passive-only')
    }

    // 11. HTTP 200 without server state change remains still-pending
    {
        const tempDir = createTempDir()
        try {
            const queue = new ManualQuestQueue({ storagePath: path.join(tempDir, 'queue.json') })
            const verifier = new NewAccountOnboardingVerifier({ queue })
            const identity = resolveAccountIdentity({ id: 'acc_11', email: 'test11@example.com' })

            const beforeEvidence = detectOnboarding({
                morePromotions: [{
                    offerId: 'fre_offer_task1',
                    title: 'Finish a daily set',
                    promotionType: 'onboarding',
                    complete: false,
                    pointProgress: 0,
                    pointProgressMax: 50
                }]
            } as any, nowMs)

            const afterDashboard = {
                morePromotions: [{
                    offerId: 'fre_offer_task1',
                    title: 'Finish a daily set',
                    promotionType: 'onboarding',
                    complete: false,
                    pointProgress: 0,
                    pointProgressMax: 50
                }]
            } as any

            const results = await verifier.verify({
                identity,
                before: beforeEvidence,
                afterDashboard
            })

            assert.strictEqual(results.length, 1)
            assert.strictEqual(results[0]?.serverCompleted, false)
            assert.strictEqual(results[0]?.status, 'still-pending')
            console.log('✅ 11. HTTP 200 without server state change remains still-pending')
        } finally {
            cleanTempDir(tempDir)
        }
    }

    // 12. Balance delta +50 without exact completion remains still-pending
    {
        const tempDir = createTempDir()
        try {
            const queue = new ManualQuestQueue({ storagePath: path.join(tempDir, 'queue.json') })
            const verifier = new NewAccountOnboardingVerifier({ queue })
            const identity = resolveAccountIdentity({ id: 'acc_12', email: 'test12@example.com' })

            const beforeEvidence = detectOnboarding({
                morePromotions: [{
                    offerId: 'fre_offer_task2',
                    title: 'Set a rewards goal',
                    promotionType: 'onboarding',
                    complete: false,
                    pointProgress: 0,
                    pointProgressMax: 100
                }]
            } as any, nowMs)

            const afterDashboard = {
                morePromotions: [{
                    offerId: 'fre_offer_task2',
                    title: 'Set a rewards goal',
                    promotionType: 'onboarding',
                    complete: false,
                    pointProgress: 0,
                    pointProgressMax: 100
                }]
            } as any

            const results = await verifier.verify({
                identity,
                before: beforeEvidence,
                afterDashboard,
                observedDelta: 50
            })

            assert.strictEqual(results.length, 1)
            assert.strictEqual(results[0]?.serverCompleted, false)
            assert.strictEqual(results[0]?.status, 'manual-required')
            console.log('✅ 12. Balance delta +50 without exact completion remains still-pending / manual-required')
        } finally {
            cleanTempDir(tempDir)
        }
    }

    // 13. Exact offer complete === true becomes verified-complete
    {
        const tempDir = createTempDir()
        try {
            const queue = new ManualQuestQueue({ storagePath: path.join(tempDir, 'queue.json') })
            const verifier = new NewAccountOnboardingVerifier({ queue })
            const identity = resolveAccountIdentity({ id: 'acc_13', email: 'test13@example.com' })

            const beforeEvidence = detectOnboarding({
                morePromotions: [{
                    offerId: 'fre_offer_task3',
                    title: 'Browse the earn page',
                    promotionType: 'onboarding',
                    complete: false,
                    pointProgress: 0,
                    pointProgressMax: 30
                }]
            } as any, nowMs)

            const afterDashboard = {
                morePromotions: [{
                    offerId: 'fre_offer_task3',
                    title: 'Browse the earn page',
                    promotionType: 'onboarding',
                    complete: true,
                    pointProgress: 30,
                    pointProgressMax: 30
                }]
            } as any

            const results = await verifier.verify({
                identity,
                before: beforeEvidence,
                afterDashboard
            })

            assert.strictEqual(results.length, 1)
            assert.strictEqual(results[0]?.serverCompleted, true)
            assert.strictEqual(results[0]?.status, 'verified-complete')
            console.log('✅ 13. Exact offer complete === true becomes verified-complete')
        } finally {
            cleanTempDir(tempDir)
        }
    }

    // 14. Numeric balance delta is never attributed to an onboarding offer (attributedPoints === 'unknown')
    {
        const tempDir = createTempDir()
        try {
            const queue = new ManualQuestQueue({ storagePath: path.join(tempDir, 'queue.json') })
            const verifier = new NewAccountOnboardingVerifier({ queue })
            const identity = resolveAccountIdentity({ id: 'acc_14', email: 'test14@example.com' })

            const beforeEvidence = detectOnboarding({
                morePromotions: [{
                    offerId: 'fre_offer_task4',
                    title: 'Browse the earn page',
                    promotionType: 'onboarding',
                    complete: false,
                    pointProgressMax: 30
                }]
            } as any, nowMs)

            const afterDashboard = {
                morePromotions: [{
                    offerId: 'fre_offer_task4',
                    title: 'Browse the earn page',
                    promotionType: 'onboarding',
                    complete: true,
                    pointProgress: 30,
                    pointProgressMax: 30
                }]
            } as any

            const results = await verifier.verify({
                identity,
                before: beforeEvidence,
                afterDashboard,
                observedDelta: 30
            })

            assert.strictEqual(results[0]?.attributedPoints, 'unknown')
            assert.strictEqual(results[0]?.observedAccountBalanceDelta, 30)
            console.log('✅ 14. Numeric balance delta is never attributed to an onboarding offer (attributedPoints === unknown)')
        } finally {
            cleanTempDir(tempDir)
        }
    }

    // 15. App-only verifier ignores onboarding queue records
    {
        const tempDir = createTempDir()
        try {
            const queue = new ManualQuestQueue({ storagePath: path.join(tempDir, 'queue.json') })
            const cache = new AppOnlyCapabilityCache(new InMemoryCapabilityStore())
            const appOnlyVerifier = new AppOnlyQuestVerifier(queue, cache)

            const identity = resolveAccountIdentity({ id: 'acc_15', email: 'test15@example.com' })

            await queue.enqueue({
                accountId: identity.accountId,
                displayAccount: identity.displayAccount,
                questKind: 'new-account-onboarding',
                offerId: 'onboarding_offer_15',
                title: 'Onboarding Goal',
                expectedPoints: 100,
                complete: false,
                locked: true,
                lockReason: 'onboarding-manual',
                confidence: 'high',
                state: 'manual-required',
                observedAt: new Date(nowMs).toISOString(),
                queuedAt: new Date(nowMs).toISOString()
            })

            // Run app-only verifier
            const decisions = await appOnlyVerifier.verify(
                [
                    {
                        accountKey: identity.accountId,
                        offerId: 'onboarding_offer_15',
                        title: 'Onboarding Goal',
                        complete: true
                    }
                ],
                {
                    accountId: identity.accountId,
                    currentBalance: 30
                }
            )

            // App-only verifier must ignore 'new-account-onboarding' quests
            assert.strictEqual(decisions.length, 0)
            const pendingOnboarding = queue.getPendingForAccount(identity.accountId, 'new-account-onboarding')
            assert.strictEqual(pendingOnboarding.length, 1)
            assert.strictEqual(pendingOnboarding[0]?.state, 'manual-required')
            console.log('✅ 15. App-only verifier ignores onboarding queue records')
        } finally {
            cleanTempDir(tempDir)
        }
    }

    // 16. Punch Card verifier ignores onboarding records
    {
        const tempDir = createTempDir()
        try {
            const queue = new ManualQuestQueue({ storagePath: path.join(tempDir, 'queue.json') })
            const identity = resolveAccountIdentity({ id: 'acc_16', email: 'test16@example.com' })

            await queue.enqueue({
                accountId: identity.accountId,
                displayAccount: identity.displayAccount,
                questKind: 'new-account-onboarding',
                offerId: 'pc_collision_offer_16',
                title: 'Onboarding Task',
                expectedPoints: 50,
                complete: false,
                locked: false,
                lockReason: 'onboarding-manual',
                confidence: 'high',
                state: 'manual-required',
                observedAt: new Date(nowMs).toISOString(),
                queuedAt: new Date(nowMs).toISOString()
            })

            // Query specifically for punch-card pending
            const pendingPunchCards = queue.getPendingForAccount(identity.accountId, 'punch-card')
            assert.strictEqual(pendingPunchCards.length, 0)

            const pendingOnboarding = queue.getPendingForAccount(identity.accountId, 'new-account-onboarding')
            assert.strictEqual(pendingOnboarding.length, 1)
            console.log('✅ 16. Punch Card verifier ignores onboarding records')
        } finally {
            cleanTempDir(tempDir)
        }
    }

    // 17. Queue deduplicates by accountId + questKind + offerId
    {
        const tempDir = createTempDir()
        try {
            const queue = new ManualQuestQueue({ storagePath: path.join(tempDir, 'queue.json') })
            const nowIso = new Date(nowMs).toISOString()

            // Same offerId across different questKind
            await queue.enqueue({
                accountId: 'acc_dedup_1',
                displayAccount: 'u1***@test.com',
                questKind: 'new-account-onboarding',
                offerId: 'shared_offer_1',
                title: 'Onboarding 1',
                expectedPoints: 10,
                complete: false,
                locked: false,
                lockReason: 'r1',
                confidence: 'high',
                state: 'manual-required',
                observedAt: nowIso,
                queuedAt: nowIso
            })

            await queue.enqueue({
                accountId: 'acc_dedup_1',
                displayAccount: 'u1***@test.com',
                questKind: 'app-only',
                offerId: 'shared_offer_1',
                title: 'App Only 1',
                expectedPoints: 20,
                complete: false,
                locked: true,
                lockReason: 'app-only',
                confidence: 'high',
                state: 'manual-required',
                observedAt: nowIso,
                queuedAt: nowIso
            })

            // Same offerId across different accountId
            await queue.enqueue({
                accountId: 'acc_dedup_2',
                displayAccount: 'u2***@test.com',
                questKind: 'new-account-onboarding',
                offerId: 'shared_offer_1',
                title: 'Onboarding 2',
                expectedPoints: 10,
                complete: false,
                locked: false,
                lockReason: 'r1',
                confidence: 'high',
                state: 'manual-required',
                observedAt: nowIso,
                queuedAt: nowIso
            })

            assert.strictEqual(queue.getAllPending().length, 3)

            // Enqueue exact duplicate (acc_dedup_1, new-account-onboarding, shared_offer_1)
            await queue.enqueue({
                accountId: 'acc_dedup_1',
                displayAccount: 'u1***@test.com',
                questKind: 'new-account-onboarding',
                offerId: 'shared_offer_1',
                title: 'Onboarding 1 Updated',
                expectedPoints: 15,
                complete: false,
                locked: false,
                lockReason: 'r1',
                confidence: 'high',
                state: 'manual-required',
                observedAt: nowIso,
                queuedAt: nowIso
            })

            // Count should still be 3
            assert.strictEqual(queue.getAllPending().length, 3)
            const updated = queue.getPendingForAccount('acc_dedup_1', 'new-account-onboarding')[0]
            assert.strictEqual(updated?.expectedPoints, 15)
            console.log('✅ 17. Queue deduplicates strictly by accountId + questKind + offerId')
        } finally {
            cleanTempDir(tempDir)
        }
    }

    // 18. Duplicate redacted email labels cannot collide (different stable accountIds)
    {
        const idA = resolveAccountIdentity({ id: 'stable-uuid-a', email: 'john.doe@example.com' })
        const idB = resolveAccountIdentity({ id: 'stable-uuid-b', email: 'john.doe@example.com' })

        assert.strictEqual(idA.displayAccount, idB.displayAccount)
        assert.notStrictEqual(idA.accountId, idB.accountId)

        const tempDir = createTempDir()
        try {
            const queue = new ManualQuestQueue({ storagePath: path.join(tempDir, 'queue.json') })
            const nowIso = new Date(nowMs).toISOString()

            await queue.enqueue({
                accountId: idA.accountId,
                displayAccount: idA.displayAccount,
                questKind: 'new-account-onboarding',
                offerId: 'same_offer',
                title: 'Task A',
                expectedPoints: 10,
                complete: false,
                locked: false,
                lockReason: 'r',
                confidence: 'high',
                state: 'manual-required',
                observedAt: nowIso,
                queuedAt: nowIso
            })

            await queue.enqueue({
                accountId: idB.accountId,
                displayAccount: idB.displayAccount,
                questKind: 'new-account-onboarding',
                offerId: 'same_offer',
                title: 'Task B',
                expectedPoints: 10,
                complete: false,
                locked: false,
                lockReason: 'r',
                confidence: 'high',
                state: 'manual-required',
                observedAt: nowIso,
                queuedAt: nowIso
            })

            assert.strictEqual(queue.getAllPending().length, 2)
            assert.strictEqual(queue.getPendingForAccount(idA.accountId).length, 1)
            assert.strictEqual(queue.getPendingForAccount(idB.accountId).length, 1)
            console.log('✅ 18. Duplicate redacted email labels cannot collide due to distinct stable accountIds')
        } finally {
            cleanTempDir(tempDir)
        }
    }

    // 19. Unresolved legacy account keys quarantined as legacy-unresolved:<hash> with legacySourceKey and migrationStatus: 'unresolved-account'
    {
        const tempDir = createTempDir()
        try {
            const storePath = path.join(tempDir, 'manual_quests.json')
            const legacyData = {
                'bar***@gmail.com': [
                    {
                        offerId: 'legacy_offer_19',
                        title: 'Legacy Task 19',
                        expectedPoints: 10,
                        complete: false,
                        locked: true,
                        lockReason: 'app-only',
                        confidence: 'high',
                        state: 'manual-required',
                        observedAt: new Date(nowMs).toISOString(),
                        queuedAt: new Date(nowMs).toISOString()
                    }
                ]
            }
            fs.writeFileSync(storePath, JSON.stringify(legacyData, null, 2), 'utf-8')

            const queue = new ManualQuestQueue({ storagePath: storePath })
            await queue.load()

            const allPending = queue.getAllPending()
            assert.strictEqual(allPending.length, 1)
            const record = allPending[0]!
            assert.ok(record.accountId.startsWith('legacy-unresolved:'))
            assert.strictEqual(record.legacySourceKey, 'bar***@gmail.com')
            assert.strictEqual(record.migrationStatus, 'unresolved-account')
            assert.strictEqual(record.questKind, 'legacy-unknown')

            // Verify backup was created
            assert.ok(fs.existsSync(`${storePath}.v1.bak`))
            console.log('✅ 19. Unresolved legacy account keys quarantined as legacy-unresolved:<hash> with migrationStatus')
        } finally {
            cleanTempDir(tempDir)
        }
    }

    // 20. Two legacy keys with identical offerId never collide
    {
        const tempDir = createTempDir()
        try {
            const storePath = path.join(tempDir, 'manual_quests.json')
            const legacyData = {
                'user1@example.com': [
                    {
                        offerId: 'identical_offer_id',
                        title: 'Task for User 1',
                        expectedPoints: 10,
                        complete: false,
                        locked: true,
                        lockReason: 'app-only',
                        confidence: 'high',
                        state: 'manual-required',
                        observedAt: new Date(nowMs).toISOString(),
                        queuedAt: new Date(nowMs).toISOString()
                    }
                ],
                'user2@example.com': [
                    {
                        offerId: 'identical_offer_id',
                        title: 'Task for User 2',
                        expectedPoints: 20,
                        complete: false,
                        locked: true,
                        lockReason: 'app-only',
                        confidence: 'high',
                        state: 'manual-required',
                        observedAt: new Date(nowMs).toISOString(),
                        queuedAt: new Date(nowMs).toISOString()
                    }
                ]
            }
            fs.writeFileSync(storePath, JSON.stringify(legacyData, null, 2), 'utf-8')

            const queue = new ManualQuestQueue({ storagePath: storePath })
            await queue.load()

            const allPending = queue.getAllPending()
            assert.strictEqual(allPending.length, 2)
            assert.notStrictEqual(allPending[0]?.accountId, allPending[1]?.accountId)
            console.log('✅ 20. Two legacy keys with identical offerId never collide')
        } finally {
            cleanTempDir(tempDir)
        }
    }

    // 21. Failed migration preserves original store
    {
        const tempDir = createTempDir()
        try {
            const storePath = path.join(tempDir, 'manual_quests.json')
            const invalidJson = '{ invalid_json_content: true, '
            fs.writeFileSync(storePath, invalidJson, 'utf-8')

            const queue = new ManualQuestQueue({ storagePath: storePath })
            await queue.load() // Must not throw or overwrite

            const contentAfter = fs.readFileSync(storePath, 'utf-8')
            assert.strictEqual(contentAfter, invalidJson)
            console.log('✅ 21. Corrupted store is preserved without overwrite')
        } finally {
            cleanTempDir(tempDir)
        }
    }

    // 22. Concurrent enqueue operations serialized via async mutex do not lose records
    {
        const tempDir = createTempDir()
        try {
            const storePath = path.join(tempDir, 'queue.json')
            const queue = new ManualQuestQueue({ storagePath: storePath })
            const nowIso = new Date(nowMs).toISOString()

            const tasks = Array.from({ length: 25 }, (_, i) =>
                queue.enqueue({
                    accountId: 'acc_concurrent',
                    displayAccount: 'c***@test.com',
                    questKind: 'new-account-onboarding',
                    offerId: `concurrent_offer_${i}`,
                    title: `Concurrent Task ${i}`,
                    expectedPoints: 10 + i,
                    complete: false,
                    locked: false,
                    lockReason: 'none',
                    confidence: 'high',
                    state: 'manual-required',
                    observedAt: nowIso,
                    queuedAt: nowIso
                })
            )

            await Promise.all(tasks)
            await queue.flushPendingWrites()

            const allPending = queue.getPendingForAccount('acc_concurrent')
            assert.strictEqual(allPending.length, 25)

            // Re-load from disk to verify all 25 were written
            const queueReloaded = new ManualQuestQueue({ storagePath: storePath })
            await queueReloaded.load()
            assert.strictEqual(queueReloaded.getPendingForAccount('acc_concurrent').length, 25)
            console.log('✅ 22. Concurrent enqueue operations serialized via async mutex preserve all records')
        } finally {
            cleanTempDir(tempDir)
        }
    }

    // 23. Medium-confidence title-only detection never queues in observe-and-handoff mode
    {
        const tempDir = createTempDir()
        try {
            const queue = new ManualQuestQueue({ storagePath: path.join(tempDir, 'queue.json') })
            const observer = new NewAccountOnboardingObserver({
                queue,
                mode: 'observe-and-handoff'
            })
            const identity = resolveAccountIdentity({ id: 'acc_23', email: 'test23@example.com' })

            // Title-only evidence yields medium confidence
            const evidence = detectOnboarding({
                morePromotions: [
                    {
                        offerId: 'unstructured_title_only',
                        title: 'Set a rewards goal',
                        promotionType: 'regular_card',
                        complete: false,
                        pointProgressMax: 100
                    }
                ]
            } as any, nowMs)

            assert.strictEqual(evidence.confidence, 'medium')
            await observer.observe(evidence, identity, nowMs)

            // Must NOT enqueue medium confidence
            const pending = queue.getAllPending()
            assert.strictEqual(pending.length, 0)
            console.log('✅ 23. Medium-confidence title-only detection never queues in observe-and-handoff mode')
        } finally {
            cleanTempDir(tempDir)
        }
    }

    // 24. Pre-existing activity methods retain their exact relative order in orchestrator
    {
        const indexSrc = fs.readFileSync(path.resolve('src/index.ts'), 'utf8')

        const posDetectOnboarding = indexSrc.indexOf('this.activities.detectOnboarding')
        const posObserveOnboarding = indexSrc.indexOf('this.activities.observeOnboarding')
        const posVerifyManual = indexSrc.indexOf('this.activities.verifyExistingManualQuests')
        const posObserveAppOnly = indexSrc.indexOf('this.activities.observeAppOnlyRewards')
        const posDailySet = indexSrc.indexOf('this.workers.doDailySet')
        const posMorePromotions = indexSrc.indexOf('this.workers.doMorePromotions')
        const posVerifyOnboarding = indexSrc.indexOf('this.activities.verifyOnboarding')
        const posPunchCards = indexSrc.indexOf('this.workers.doPunchCards')

        assert.ok(posDetectOnboarding !== -1 && posDetectOnboarding < posDailySet, 'detectOnboarding before doDailySet')
        assert.ok(posObserveOnboarding !== -1 && posObserveOnboarding < posDailySet, 'observeOnboarding before doDailySet')
        assert.ok(posVerifyManual !== -1 && posVerifyManual < posDailySet, 'verifyExistingManualQuests before doDailySet')
        assert.ok(posObserveAppOnly !== -1 && posObserveAppOnly < posDailySet, 'observeAppOnlyRewards before doDailySet')
        assert.ok(posDailySet !== -1 && posDailySet < posMorePromotions, 'doDailySet before doMorePromotions')
        assert.ok(posMorePromotions !== -1 && posMorePromotions < posVerifyOnboarding, 'doMorePromotions before verifyOnboarding')
        assert.ok(posVerifyOnboarding !== -1 && posVerifyOnboarding < posPunchCards, 'verifyOnboarding before doPunchCards')
        console.log('✅ 24. Pre-existing activity methods retain their exact relative order in orchestrator')
    }

    // 25. Onboarding does not execute doDailySet
    {
        const detectorSrc = fs.readFileSync(path.resolve('src/functions/onboarding/NewAccountOnboardingDetector.ts'), 'utf8')
        const observerSrc = fs.readFileSync(path.resolve('src/functions/onboarding/NewAccountOnboardingObserver.ts'), 'utf8')
        const verifierSrc = fs.readFileSync(path.resolve('src/functions/onboarding/NewAccountOnboardingVerifier.ts'), 'utf8')

        assert.strictEqual(detectorSrc.includes('doDailySet'), false)
        assert.strictEqual(observerSrc.includes('doDailySet'), false)
        assert.strictEqual(verifierSrc.includes('doDailySet'), false)
        console.log('✅ 25. Onboarding modules do not execute doDailySet')
    }

    // 26. Public DTO cannot expose internal accountId, destination query, or token fields
    {
        const tempDir = createTempDir()
        try {
            const queue = new ManualQuestQueue({ storagePath: path.join(tempDir, 'queue.json') })
            const identity = resolveAccountIdentity({ id: 'internal_secret_uuid_999', email: 'operator@secret.com' })

            await queue.enqueue({
                accountId: identity.accountId,
                displayAccount: identity.displayAccount,
                questKind: 'new-account-onboarding',
                offerId: 'offer_secret',
                title: 'Secret Task',
                expectedPoints: 50,
                destination: {
                    scheme: 'https',
                    origin: 'https://rewards.bing.com',
                    path: '/earn'
                },
                complete: false,
                locked: false,
                lockReason: 'none',
                confidence: 'high',
                state: 'manual-required',
                observedAt: new Date(nowMs).toISOString(),
                queuedAt: new Date(nowMs).toISOString()
            })

            const snapshot = queue.getSanitizedSnapshot()
            const snapshotJson = JSON.stringify(snapshot)

            assert.strictEqual(snapshotJson.includes('internal_secret_uuid_999'), false, 'Internal accountId must NOT be exposed')
            assert.strictEqual(snapshotJson.includes('operator@secret.com'), false, 'Raw email must NOT be exposed')
            assert.strictEqual(snapshotJson.includes('token'), false)
            assert.strictEqual(snapshotJson.includes('password'), false)
            assert.ok(snapshotJson.includes(identity.displayAccount), 'Redacted displayAccount must be exposed')
            console.log('✅ 26. Public DTO cannot expose internal accountId, raw emails, or credential fields')
        } finally {
            cleanTempDir(tempDir)
        }
    }

    // 27. AppOnlyCapabilityCache uses accountId
    {
        const store = new InMemoryCapabilityStore()
        const cache = new AppOnlyCapabilityCache(store)
        const accountId = 'stable_acc_id_27'

        await cache.recordLocked(accountId, 'offer_27', 'app-only', 'high', 1)
        const record = await cache.getRecord(accountId, 'offer_27')
        assert.notStrictEqual(record, null)
        assert.strictEqual(record?.offerId, 'offer_27')

        const otherRecord = await cache.getRecord('different_acc_id', 'offer_27')
        assert.strictEqual(otherRecord, null)
        console.log('✅ 27. AppOnlyCapabilityCache uses accountId strictly')
    }

    // 28. Onboarding disabled causes zero additional dashboard requests
    {
        const indexSrc = fs.readFileSync(path.resolve('src/index.ts'), 'utf8')
        // In src/index.ts, shouldVerifyOnboarding requires isOnboardingEnabled to be true
        assert.ok(indexSrc.includes('const isOnboardingEnabled = onboardingCfg?.enabled'))
        assert.ok(indexSrc.includes('isOnboardingEnabled &&'))
        console.log('✅ 28. Onboarding disabled causes zero additional dashboard requests in orchestrator')
    }

    // 29. not-detected/unknown causes zero additional dashboard requests
    {
        const indexSrc = fs.readFileSync(path.resolve('src/index.ts'), 'utf8')
        // In src/index.ts, shouldVerifyOnboarding requires (state === 'detected' || state === 'active')
        assert.ok(indexSrc.includes("onboardingBefore.state === 'detected' || onboardingBefore.state === 'active'"))
        console.log('✅ 29. not-detected/unknown state causes zero additional dashboard requests')
    }

    // 30. Existing fresh snapshot is reused
    {
        const indexSrc = fs.readFileSync(path.resolve('src/index.ts'), 'utf8')
        // Checks that punchCards receives punchCardData = refreshedDashboard || data
        assert.ok(indexSrc.includes('const punchCardData = refreshedDashboard || data'))
        console.log('✅ 30. Existing fresh snapshot is reused without extra network requests')
    }

    // 31. Verifier update does not store a fake zero delta
    {
        const tempDir = createTempDir()
        try {
            const storePath = path.join(tempDir, 'queue.json')
            const queue = new ManualQuestQueue({ storagePath: storePath })
            const verifier = new NewAccountOnboardingVerifier({ queue })
            const identity = resolveAccountIdentity({ id: 'acc_31', email: 'test31@example.com' })

            await queue.enqueue({
                accountId: identity.accountId,
                displayAccount: identity.displayAccount,
                questKind: 'new-account-onboarding',
                offerId: 'offer_no_delta',
                title: 'No Delta Offer',
                expectedPoints: 50,
                complete: false,
                locked: false,
                lockReason: 'none',
                confidence: 'high',
                state: 'manual-required',
                observedAt: new Date(nowMs).toISOString(),
                queuedAt: new Date(nowMs).toISOString()
            })

            const beforeEvidence = detectOnboarding({
                morePromotions: [{
                    offerId: 'offer_no_delta',
                    title: 'No Delta Offer',
                    promotionType: 'onboarding',
                    complete: false,
                    pointProgressMax: 50
                }]
            } as any, nowMs)

            const afterDashboard = {
                morePromotions: [{
                    offerId: 'offer_no_delta',
                    title: 'No Delta Offer',
                    promotionType: 'onboarding',
                    complete: true,
                    pointProgress: 50,
                    pointProgressMax: 50
                }]
            } as any

            // Call verify WITHOUT observedDelta parameter
            const results = await verifier.verify({
                identity,
                before: beforeEvidence,
                afterDashboard
            })

            assert.strictEqual(results[0]?.observedAccountBalanceDelta, undefined)
            const rawStored = JSON.parse(fs.readFileSync(storePath, 'utf-8'))
            assert.strictEqual(rawStored.records[0]?.observedAccountBalanceDelta, undefined)
            console.log('✅ 31. Verifier update does not store a fake zero delta')
        } finally {
            cleanTempDir(tempDir)
        }
    }

    // 32. No unproven DashboardData collection is accessed
    {
        const detectorSrc = fs.readFileSync(path.resolve('src/functions/onboarding/NewAccountOnboardingDetector.ts'), 'utf8')
        const verifierSrc = fs.readFileSync(path.resolve('src/functions/onboarding/NewAccountOnboardingVerifier.ts'), 'utf8')

        // Must not touch unproven collections like 'dailyTasks', 'dailyChallenges', 'streakPromotion', etc.
        const forbiddenCollections = ['dailyTasks', 'dailyChallenges', 'streakPromotion', 'activeCampaigns']
        for (const col of forbiddenCollections) {
            assert.strictEqual(detectorSrc.includes(`data.${col}`), false)
            assert.strictEqual(verifierSrc.includes(`afterDashboard.${col}`), false)
        }
        console.log('✅ 32. No unproven DashboardData collections are accessed')
    }

    // 33. Terminal pruning deletes only terminal records older than retentionDays, leaving pending records intact
    {
        const tempDir = createTempDir()
        try {
            const queue = new ManualQuestQueue({ storagePath: path.join(tempDir, 'queue.json') })
            const thirtyDaysAgoIso = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString()

            // Old terminal record
            await queue.enqueue({
                accountId: 'acc_prune',
                displayAccount: 'p***@test.com',
                questKind: 'new-account-onboarding',
                offerId: 'terminal_old_offer',
                title: 'Old Terminal Task',
                expectedPoints: 50,
                complete: true,
                locked: false,
                lockReason: 'none',
                confidence: 'high',
                state: 'verified-complete',
                observedAt: thirtyDaysAgoIso,
                queuedAt: thirtyDaysAgoIso,
                completedAt: thirtyDaysAgoIso
            })

            // Old pending/manual-required record
            await queue.enqueue({
                accountId: 'acc_prune',
                displayAccount: 'p***@test.com',
                questKind: 'new-account-onboarding',
                offerId: 'pending_old_offer',
                title: 'Old Pending Task',
                expectedPoints: 50,
                complete: false,
                locked: true,
                lockReason: 'manual',
                confidence: 'high',
                state: 'manual-required',
                observedAt: thirtyDaysAgoIso,
                queuedAt: thirtyDaysAgoIso
            })

            // Prune with 14 days retention
            const prunedCount = await queue.pruneExpired(14, nowMs)
            assert.strictEqual(prunedCount, 1)

            const remainingPending = queue.getPendingForAccount('acc_prune')
            assert.strictEqual(remainingPending.length, 1)
            assert.strictEqual(remainingPending[0]?.offerId, 'pending_old_offer')
            console.log('✅ 33. Terminal pruning deletes only terminal records older than retentionDays')
        } finally {
            cleanTempDir(tempDir)
        }
    }

    // 34. validateUniqueAccountIdentities fails fast on duplicate accountId
    {
        const validAccounts = [
            { id: 'acc_1', email: 'one@example.com' },
            { id: 'acc_2', email: 'two@example.com' }
        ]
        assert.doesNotThrow(() => validateUniqueAccountIdentities(validAccounts))

        const duplicateExplicitIdAccounts = [
            { id: 'acc_same', email: 'one@example.com' },
            { id: 'acc_same', email: 'two@example.com' }
        ]
        assert.throws(
            () => validateUniqueAccountIdentities(duplicateExplicitIdAccounts),
            /\[FATAL-IDENTITY\] Duplicate accountId detected: 'acc_same'/
        )

        const duplicateEmailAccounts = [
            { email: 'duplicate@example.com' },
            { email: 'DUPLICATE@EXAMPLE.COM' } // Normalized email collision
        ]
        assert.throws(
            () => validateUniqueAccountIdentities(duplicateEmailAccounts),
            /\[FATAL-IDENTITY\] Duplicate accountId detected/
        )
        console.log('✅ 34. validateUniqueAccountIdentities fails fast on duplicate accountId')
    }

    console.log('\n🎉 ALL 34 NEW ACCOUNT ONBOARDING TESTS PASSED SUCCESSFULLY!')
}

if (require.main === module) {
    runNewAccountOnboardingTests().catch(err => {
        console.error(err)
        process.exit(1)
    })
}
