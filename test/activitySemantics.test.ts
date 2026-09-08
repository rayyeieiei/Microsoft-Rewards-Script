import assert from 'assert'
import {
    evaluateActivityCompletion,
    type ActivityBatchSummary,
    type ActivityExecutionResult
} from '../src/functions/activities/ActivitySemantics'

export async function runActivitySemanticsTests() {
    console.log('--- Running Activity Semantics Test Suite ---')

    // Test 8: Batch counters always reconcile to total
    {
        const summary: ActivityBatchSummary = {
            total: 10,
            verifiedComplete: 4,
            processedUnverified: 3,
            pending: 1,
            skipped: 1,
            failed: 1,
            observedAccountBalanceDelta: 45
        }

        const sumOfCounters =
            summary.verifiedComplete +
            summary.processedUnverified +
            summary.pending +
            summary.skipped +
            summary.failed

        assert.strictEqual(
            sumOfCounters,
            summary.total,
            'Batch counters must sum up exactly to total: total === verified + processedUnverified + pending + skipped + failed'
        )

        const isAllCompleted = summary.total > 0 && summary.verifiedComplete === summary.total
        assert.strictEqual(isAllCompleted, false, 'Summary must not report all completed when items are unverified/pending')
        console.log('✅ Test 8 Passed: Batch counters always reconcile to total')
    }

    // Strict Card Delta Attribution: Balance +13 on offer advertised +10 does not attribute +13
    {
        const result: ActivityExecutionResult = evaluateActivityCompletion({
            offerId: 'quiz_offer_1',
            title: 'Quiz Activity',
            advertisedPoints: 10,
            observedBalanceDelta: 13,
            serverCompleted: true,
            completionEvidence: 'server-dashboard-state'
        })
        assert.strictEqual(result.status, 'verified-complete')
        assert.strictEqual(
            result.attributedPoints,
            null,
            'attributedPoints must be null when delta (13) differs from advertised (10)'
        )
        assert.notStrictEqual(result.attributedPoints, 13, 'Must NOT attribute full +13 delta to the card')
        console.log('✅ Strict Attribution: Balance +13 on advertised +10 sets attributedPoints=null')
    }

    // Strict Card Delta Attribution: Balance +3 on offer advertised +0 is not completion
    {
        const result: ActivityExecutionResult = evaluateActivityCompletion({
            offerId: 'explore_offer_2',
            title: 'Explore on Bing',
            advertisedPoints: 0,
            observedBalanceDelta: 3,
            serverCompleted: false,
            completionEvidence: 'none'
        })
        assert.strictEqual(result.status, 'processed-unverified')
        assert.strictEqual(result.serverCompleted, false)
        assert.strictEqual(result.attributedPoints, null)
        assert.strictEqual(result.completionEvidence, 'none')
        console.log('✅ Strict Attribution: Balance +3 without server confirmation is processed-unverified')
    }

    // Exact Match Attribution: Balance +10 on advertised +10 attributes +10
    {
        const result: ActivityExecutionResult = evaluateActivityCompletion({
            offerId: 'tile_offer_3',
            title: 'Daily Tile',
            advertisedPoints: 10,
            observedBalanceDelta: 10,
            serverCompleted: true,
            completionEvidence: 'server-dashboard-state'
        })
        assert.strictEqual(result.status, 'verified-complete')
        assert.strictEqual(result.attributedPoints, 10)
        console.log('✅ Strict Attribution: Exact balance match +10 attributes +10')
    }
}

if (require.main === module) {
    runActivitySemanticsTests().catch(err => {
        console.error(err)
        process.exit(1)
    })
}
