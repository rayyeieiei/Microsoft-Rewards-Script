import assert from 'assert'
import {
    createPunchCardSnapshot,
    evaluatePunchCardRun,
    isChildComplete,
    isChildLocked,
    isChildDisabled,
    isChildFutureDated,
    isChildInCooldown,
    Workers,
    type PunchCardStateReader,
    type PunchCardServerSnapshot
} from '../src/functions/Workers'
import { AccountScope } from '../src/runtime/AccountScope'
import type { PunchCard, BasePromotion, DashboardData } from '../src/interface/DashboardData'

export async function runPunchCardTests() {
    console.log('--- Running Punch Card Test Suite ---')

    // Pure Predicate & Mapper Unit Tests
    {
        const completePromo = { complete: true } as BasePromotion
        const progressPromo = { complete: false, pointProgress: 10, pointProgressMax: 10 } as BasePromotion
        const incompletePromo = { complete: false, pointProgress: 0, pointProgressMax: 10 } as BasePromotion
        assert.strictEqual(isChildComplete(completePromo), true)
        assert.strictEqual(isChildComplete(progressPromo), true)
        assert.strictEqual(isChildComplete(incompletePromo), false)

        const lockedPromo = { complete: false, attributes: { isLocked: 'True' } } as any
        assert.strictEqual(isChildLocked(lockedPromo), true)
        assert.strictEqual(isChildLocked(incompletePromo), false)

        const disabledPromo = { complete: false, attributes: { disabled: 'True' } } as any
        assert.strictEqual(isChildDisabled(disabledPromo), true)
        assert.strictEqual(isChildDisabled(incompletePromo), false)

        const futurePromo = { complete: false, attributes: { startDate: new Date(Date.now() + 86400000).toISOString() } } as any
        assert.strictEqual(isChildFutureDated(futurePromo), true)
        assert.strictEqual(isChildFutureDated(incompletePromo), false)

        const cooldownPromo = { complete: false, attributes: { cooldown: 'true' } } as any
        assert.strictEqual(isChildInCooldown(cooldownPromo), true)
        assert.strictEqual(isChildInCooldown(incompletePromo), false)

        // Pure snapshot mapper
        const rawCard: PunchCard = {
            name: 'Raw Mapper Card',
            parentPromotion: { offerId: 'parent_map', complete: false } as any,
            childPromotions: [
                incompletePromo,
                lockedPromo,
                completePromo
            ]
        } as any
        const snapshot = createPunchCardSnapshot(rawCard)
        assert.strictEqual(snapshot.totalChildren, 3)
        assert.strictEqual(snapshot.completedChildren, 1)
        assert.strictEqual(snapshot.locked, 1)
        assert.strictEqual(snapshot.actionableNow, 1)
        console.log('✅ Pure Mapper & Predicates Verified: Child states and snapshot mapped correctly')
    }

    // Test 1: 0/4 -> 1/4 transition evaluates to verified-complete-today
    {
        const before: PunchCardServerSnapshot = {
            parentOfferId: 'pc_parent_1',
            childOfferId: 'child_1',
            completedChildren: 0,
            totalChildren: 4,
            actionableNow: 1,
            locked: 3,
            futureDated: 0,
            parentComplete: false,
            childComplete: false
        }
        const after: PunchCardServerSnapshot = {
            parentOfferId: 'pc_parent_1',
            childOfferId: 'child_1',
            completedChildren: 1,
            totalChildren: 4,
            actionableNow: 0,
            locked: 3,
            futureDated: 0,
            parentComplete: false,
            childComplete: true
        }

        const result = evaluatePunchCardRun(before, after, 'child_1', 10)
        assert.strictEqual(result.status, 'verified-complete-today')
        assert.strictEqual(result.evidence, 'exact-child-complete')
        console.log('✅ Test 1 Passed: 0/4 -> 1/4 evaluates to verified-complete-today')
    }

    // Test 2: 1/4 with actionable=0, locked=3 evaluates to waiting-cooldown with zero child execution
    {
        const before: PunchCardServerSnapshot = {
            parentOfferId: 'pc_parent_1',
            completedChildren: 1,
            totalChildren: 4,
            actionableNow: 0,
            locked: 3,
            futureDated: 0,
            parentComplete: false
        }

        const result = evaluatePunchCardRun(before)
        assert.strictEqual(result.status, 'waiting-cooldown')
        assert.strictEqual(result.evidence, 'state-unchanged')

        // Test with Workers.doPunchCards to verify zero execution
        let executionCount = 0
        const mockWorkers = new Workers({
            isMobile: false,
            userData: { currentPoints: 100 },
            logger: {
                info: () => {},
                debug: () => {},
                error: () => {}
            },
            utils: { wait: async () => {} }
        } as any)

        const mockCard: PunchCard = {
            name: 'Locked Streak Punchcard',
            parentPromotion: { offerId: 'pc_locked_parent', complete: false } as any,
            childPromotions: [
                { offerId: 'c1', title: 'Day 1', complete: true } as BasePromotion,
                { offerId: 'c2', title: 'Day 2', complete: false, attributes: { isLocked: 'True' } } as any,
                { offerId: 'c3', title: 'Day 3', complete: false, attributes: { isLocked: 'True' } } as any,
                { offerId: 'c4', title: 'Day 4', complete: false, attributes: { isLocked: 'True' } } as any
            ]
        } as any

        ;(mockWorkers as any).solveActivities = async () => {
            executionCount++
        }

        await mockWorkers.doPunchCards({ punchCards: [mockCard] } as DashboardData, {} as any)
        assert.strictEqual(executionCount, 0, 'Zero activities must be executed when waiting-cooldown')
        console.log('✅ Test 2 Passed: Waiting-cooldown evaluates properly with zero executions')
    }

    // Test 3: 0/4 -> unchanged 0/4 evaluates to processed-unverified
    {
        const before: PunchCardServerSnapshot = {
            parentOfferId: 'pc_parent_1',
            childOfferId: 'child_1',
            completedChildren: 0,
            totalChildren: 4,
            actionableNow: 1,
            locked: 3,
            futureDated: 0,
            parentComplete: false,
            childComplete: false
        }
        const after: PunchCardServerSnapshot = {
            parentOfferId: 'pc_parent_1',
            childOfferId: 'child_1',
            completedChildren: 0,
            totalChildren: 4,
            actionableNow: 1,
            locked: 3,
            futureDated: 0,
            parentComplete: false,
            childComplete: false
        }

        const result = evaluatePunchCardRun(before, after, 'child_1', 0)
        assert.strictEqual(result.status, 'processed-unverified')
        assert.strictEqual(result.evidence, 'state-unchanged')
        console.log('✅ Test 3 Passed: 0/4 -> 0/4 unchanged evaluates to processed-unverified')
    }

    // Test 4: Observed balance delta +3 alone without child completion is NOT verified complete
    {
        const before: PunchCardServerSnapshot = {
            parentOfferId: 'pc_parent_1',
            childOfferId: 'child_1',
            completedChildren: 0,
            totalChildren: 4,
            actionableNow: 1,
            locked: 3,
            futureDated: 0,
            parentComplete: false,
            childComplete: false
        }
        const after: PunchCardServerSnapshot = {
            parentOfferId: 'pc_parent_1',
            childOfferId: 'child_1',
            completedChildren: 0,
            totalChildren: 4,
            actionableNow: 1,
            locked: 3,
            futureDated: 0,
            parentComplete: false,
            childComplete: false
        }

        // Even with observedBalanceDelta = 3, server snapshot has not completed
        const result = evaluatePunchCardRun(before, after, 'child_1', 3)
        assert.strictEqual(result.status, 'processed-unverified', 'Balance delta alone must not count as completed')
        assert.strictEqual(result.evidence, 'state-unchanged')
        console.log('✅ Test 4 Passed: Balance delta +3 without server confirmation is processed-unverified')
    }

    // Test 5: State reader is called to obtain fresh server snapshot
    {
        let readerCallCount = 0
        const mockReader: PunchCardStateReader = {
            async fetchPunchCardSnapshot(parentOfferId: string, targetChildOfferId?: string) {
                readerCallCount++
                return {
                    parentOfferId,
                    childOfferId: targetChildOfferId,
                    completedChildren: 1,
                    totalChildren: 4,
                    actionableNow: 0,
                    locked: 3,
                    futureDated: 0,
                    parentComplete: false,
                    childComplete: true
                }
            }
        }

        const mockScope = new AccountScope('test***@gmail.com', 'run_test_5')
        const mockWorkers = new Workers({
            isMobile: false,
            userData: { userName: 'testuser', currentPoints: 100 },
            config: { punchCardExecution: { mode: 'browser-ui-experimental', maxChildrenPerRun: 1 } },
            accountScope: mockScope,
            logger: {
                info: () => {},
                warn: () => {},
                debug: () => {},
                error: () => {}
            },
            utils: { wait: async () => {} }
        } as any)
        mockWorkers.checkPunchCardKillSwitch = async () => null
        mockWorkers.clickExactChildFromDashboard = async () => true

        const mockCard: PunchCard = {
            name: 'State Reader Test Punchcard',
            parentPromotion: { offerId: 'pc_reader_parent', complete: false } as any,
            childPromotions: [
                { offerId: 'c1', title: 'Day 1', complete: false } as BasePromotion,
                { offerId: 'c2', title: 'Day 2', complete: false, attributes: { isLocked: 'True' } } as any
            ]
        } as any

        await mockWorkers.doPunchCards({ punchCards: [mockCard] } as DashboardData, {} as any, mockReader)
        assert.ok(readerCallCount >= 1, 'PunchCardStateReader must be invoked for fresh server snapshot')
        console.log('✅ Test 5 Passed: State reader is called to obtain fresh server snapshot')
    }

    // Test 6: Maximum one child executed per parent per run
    {
        const executedOffers: string[] = []
        const mockScope = new AccountScope('test***@gmail.com', 'run_test_6')
        const mockWorkers = new Workers({
            isMobile: false,
            userData: { userName: 'testuser', currentPoints: 100 },
            config: { punchCardExecution: { mode: 'browser-ui-experimental', maxChildrenPerRun: 1 } },
            accountScope: mockScope,
            logger: {
                info: () => {},
                warn: () => {},
                debug: () => {},
                error: () => {}
            },
            utils: { wait: async () => {} }
        } as any)
        mockWorkers.checkPunchCardKillSwitch = async () => null
        mockWorkers.clickExactChildFromDashboard = async (_page, _card, child) => {
            executedOffers.push(child.offerId)
            return true
        }

        const mockCard: PunchCard = {
            name: 'Multi-step Card',
            parentPromotion: { offerId: 'pc_multistep', complete: false } as any,
            childPromotions: [
                { offerId: 'step_1', title: 'Step 1', complete: false } as BasePromotion,
                { offerId: 'step_2', title: 'Step 2', complete: false } as BasePromotion,
                { offerId: 'step_3', title: 'Step 3', complete: false } as BasePromotion
            ]
        } as any

        const mockReader: PunchCardStateReader = {
            async fetchPunchCardSnapshot() {
                return {
                    parentOfferId: 'pc_multistep',
                    childOfferId: 'step_1',
                    completedChildren: 1,
                    totalChildren: 3,
                    actionableNow: 0,
                    locked: 2,
                    futureDated: 0,
                    parentComplete: false,
                    childComplete: true
                }
            }
        }

        await mockWorkers.doPunchCards({ punchCards: [mockCard] } as DashboardData, {} as any, mockReader)
        assert.strictEqual(executedOffers.length, 1, 'Exactly one child must be executed per parent per run')
        assert.strictEqual(executedOffers[0], 'step_1')
        console.log('✅ Test 6 Passed: Maximum one child executed per parent per run')
    }

    // Test 7: Locked child is never executed
    {
        const executedOffers: string[] = []
        const mockScope = new AccountScope('test***@gmail.com', 'run_test_7')
        const mockWorkers = new Workers({
            isMobile: false,
            userData: { userName: 'testuser', currentPoints: 100 },
            config: { punchCardExecution: { mode: 'browser-ui-experimental', maxChildrenPerRun: 1 } },
            accountScope: mockScope,
            logger: {
                info: () => {},
                warn: () => {},
                debug: () => {},
                error: () => {}
            },
            utils: { wait: async () => {} }
        } as any)
        mockWorkers.checkPunchCardKillSwitch = async () => null
        mockWorkers.clickExactChildFromDashboard = async (_page, _card, child) => {
            executedOffers.push(child.offerId)
            return true
        }

        const mockCard: PunchCard = {
            name: 'Locked Step Card',
            parentPromotion: { offerId: 'pc_locked_parent_2', complete: false } as any,
            childPromotions: [
                { offerId: 'step_locked_1', title: 'Locked 1', complete: false, attributes: { isLocked: 'True' } } as any,
                { offerId: 'step_locked_2', title: 'Locked 2', complete: false, attributes: { isLocked: true } } as any
            ]
        } as any

        await mockWorkers.doPunchCards({ punchCards: [mockCard] } as DashboardData, {} as any)
        assert.strictEqual(executedOffers.length, 0, 'Locked children must NEVER be executed')
        console.log('✅ Test 7 Passed: Locked child is never executed')
    }

    // Test 15: Server refresh failure is non-blocking and handles gracefully
    {
        const mockReaderFailing: PunchCardStateReader = {
            async fetchPunchCardSnapshot() {
                throw new Error('Network error during snapshot refresh')
            }
        }

        const before: PunchCardServerSnapshot = {
            parentOfferId: 'pc_parent_fail',
            childOfferId: 'child_1',
            completedChildren: 0,
            totalChildren: 2,
            actionableNow: 1,
            locked: 1,
            futureDated: 0,
            parentComplete: false,
            childComplete: false
        }

        let caughtError: any = null
        try {
            const snapshot = await mockReaderFailing.fetchPunchCardSnapshot('pc_parent_fail', 'child_1').catch(() => null)
            const result = evaluatePunchCardRun(before, snapshot ?? undefined, 'child_1', 0)
            assert.strictEqual(result.status, 'processed-unverified')
            assert.strictEqual(result.evidence, 'server-state-unavailable')
        } catch (e) {
            caughtError = e
        }

        assert.strictEqual(caughtError, null, 'Server refresh failure must NOT throw or crash flow')
        console.log('✅ Test 15 Passed: Server refresh failure is non-blocking and failsafe')
    }
}

if (require.main === module) {
    runPunchCardTests().catch(err => {
        console.error(err)
        process.exit(1)
    })
}
