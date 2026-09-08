import assert from 'assert'
import { evaluateDataSaverBudget } from '../src/functions/activities/ActivitySemantics'
import { DataSaverManager } from '../src/util/DataSaver'

export async function runDataSaverTests() {
    console.log('--- Running Data Saver Budget & Isolation Test Suite ---')

    // Test 12: Data Saver 21.26MB / 20.00MB generates status OVER_BUDGET
    {
        const consumedBytes = 21.26 * 1024 * 1024
        const budgetBytes = 20.0 * 1024 * 1024
        const res = evaluateDataSaverBudget(consumedBytes, budgetBytes)

        assert.strictEqual(res.status, 'OVER_BUDGET')
        assert.strictEqual(res.withinBudget, false)
        assert.strictEqual(res.consumedMb.toFixed(2), '21.26')
        assert.strictEqual(res.budgetMb.toFixed(2), '20.00')
        assert.strictEqual(res.overMb.toFixed(2), '1.26')
        assert.strictEqual(res.percentage.toFixed(1), '106.3')
        console.log('✅ Test 12 Passed: 21.26MB / 20.00MB yields OVER_BUDGET with overBy=1.26MB')
    }

    // Test 13: Data Saver 19.99MB / 20.00MB generates status PASS
    {
        const consumedBytes = 19.99 * 1024 * 1024
        const budgetBytes = 20.0 * 1024 * 1024
        const res = evaluateDataSaverBudget(consumedBytes, budgetBytes)

        assert.strictEqual(res.status, 'PASS')
        assert.strictEqual(res.withinBudget, true)
        assert.strictEqual(res.consumedMb.toFixed(2), '19.99')
        assert.strictEqual(res.budgetMb.toFixed(2), '20.00')
        assert.strictEqual(res.overBytes, 0)
        assert.strictEqual(res.overMb, 0)
        assert.strictEqual(res.percentage.toFixed(1), '99.9')
        console.log('✅ Test 13 Passed: 19.99MB / 20.00MB yields PASS with withinBudget=true')
    }

    // Test 14: Quota counter resets between accounts guaranteeing zero cross-account leakage
    {
        const manager = DataSaverManager.getInstance()
        const userA = 'userA@test.com'
        const userB = 'userB@test.com'

        // 1. Account A lifecycle
        manager.beginAccountQuota(userA)
        manager.recordTransferredResource('document', 1024 * 1024)
        manager.recordTransferredResource('script', 2 * 1024 * 1024)
        manager.recordTransferredResource('image', 500 * 1024)
        manager.recordBlockedRequest()

        const reportA = manager.finishAccountQuota(userA)
        assert.strictEqual(reportA.accountKey, userA)
        assert.strictEqual(reportA.breakdown.document.requests, 1)
        assert.strictEqual(reportA.breakdown.script.requests, 1)
        assert.strictEqual(reportA.breakdown.image.requests, 1)
        assert.strictEqual(reportA.blockedRequests, 1)
        assert.strictEqual(reportA.consumedBytes, 1024 * 1024 + 2 * 1024 * 1024 + 500 * 1024)

        manager.resetAccountQuota(userA)

        // 2. Account B lifecycle
        manager.beginAccountQuota(userB)
        const statsBInitial = manager.getAccountStats(userB)
        assert.strictEqual(statsBInitial.totalBytes, 0, 'Account B must start with 0 bytes transferred')
        assert.strictEqual(statsBInitial.blockedRequests, 0, 'Account B must start with 0 blocked requests')
        assert.strictEqual(statsBInitial.breakdown.document.bytes, 0)
        assert.strictEqual(statsBInitial.breakdown.script.bytes, 0)

        manager.recordTransferredResource('xhr/fetch', 300 * 1024)
        const reportB = manager.finishAccountQuota(userB)
        assert.strictEqual(reportB.consumedBytes, 300 * 1024)
        assert.strictEqual(reportB.breakdown['xhr/fetch'].requests, 1)
        assert.strictEqual(reportB.breakdown.document.requests, 0, 'Account B must not have any Account A document counts')

        manager.resetAccountQuota(userB)

        console.log('✅ Test 14 Passed: Quota counter resets cleanly with strict account isolation')
    }
}

if (require.main === module) {
    runDataSaverTests().catch(err => {
        console.error(err)
        process.exit(1)
    })
}
