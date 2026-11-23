import assert from 'assert'
import { PauseCoordinator, PauseCheckpointContext } from '../src/runtime/control/PauseCoordinator'

export async function runPauseCoordinatorTests() {
    console.log('--- Testing PauseCoordinator Cooperative Hot-Pause & Hand-off ---')

    // Test 1: Instantiation & Initial State
    {
        const coordinator = new PauseCoordinator()
        assert.strictEqual(coordinator.isPaused(), false, 'Should initially not be paused')
        assert.strictEqual(coordinator.isPauseRequested(), false, 'Should initially have no pause request')
        assert.strictEqual(coordinator.isInspecting('test@example.com'), false, 'Should initially not be inspecting')
        assert.strictEqual(coordinator.getPausedDurationMs(), 0, 'Initial paused duration should be 0')
        console.log('✅ Test 1 Passed: Initial state verified')
    }

    // Test 2: Normal execution when no pause requested passes through checkPoint immediately
    {
        const coordinator = new PauseCoordinator()
        let sessionSaved = false
        const context: PauseCheckpointContext = {
            saveSession: async () => { sessionSaved = true }
        }

        const start = Date.now()
        await coordinator.checkPoint('search_query_1', context)
        const elapsed = Date.now() - start

        assert.strictEqual(sessionSaved, false, 'saveSession should not be called when pause was not requested')
        assert.strictEqual(coordinator.isPaused(), false, 'Should remain unpaused')
        assert.ok(elapsed < 50, 'checkPoint should return immediately when unpaused')
        console.log('✅ Test 2 Passed: Non-paused checkPoint pass-through verified')
    }

    // Test 3: Cooperative Pause Request & Checkpoint Barrier Hand-off
    {
        const coordinator = new PauseCoordinator()
        const targetEmail = 'user1@outlook.com'
        let sessionSaved = false
        let sessionReloaded = false
        let pauseListenerFired = false
        let resumeListenerFired = false
        let recordedPausedMs = 0

        coordinator.onPause((email, stage) => {
            if (email === targetEmail && stage === 'search_mobile_3') {
                pauseListenerFired = true
            }
        })

        coordinator.onResume((email, durationMs) => {
            if (email === targetEmail) {
                resumeListenerFired = true
                recordedPausedMs = durationMs
            }
        })

        // Request pause asynchronously
        const pausePromise = coordinator.requestPause(targetEmail, 5000)
        assert.strictEqual(coordinator.isPauseRequested(targetEmail), true, 'Pause should be requested')
        assert.strictEqual(coordinator.isPauseRequested('other@domain.com'), false, 'Other account should not report pause requested')

        coordinator.setInspecting(targetEmail, true)
        assert.strictEqual(coordinator.isInspecting(targetEmail), true, 'Inspecting state should be true')

        // Simulate bot reaching checkpoint
        let checkpointExited = false
        const checkpointPromise = coordinator.checkPoint('search_mobile_3', {
            saveSession: async () => {
                sessionSaved = true
            },
            reloadSession: async () => {
                sessionReloaded = true
            }
        }).then(() => {
            checkpointExited = true
        })

        // Give event loop tick to let checkpoint park
        await new Promise(r => setTimeout(r, 60))

        const pauseReqResult = await pausePromise
        assert.strictEqual(pauseReqResult, true, 'requestPause should resolve true once parked')
        assert.strictEqual(sessionSaved, true, 'saveSession should have executed on checkpoint arrival')
        assert.strictEqual(coordinator.isPaused(), true, 'Coordinator should report paused')
        assert.strictEqual(pauseListenerFired, true, 'onPause listener should have fired')
        assert.strictEqual(checkpointExited, false, 'Runner should still be parked at checkpoint')

        // Simulate user manual inspection duration
        await new Promise(r => setTimeout(r, 100))

        // Simulate closing manual browser -> resume
        coordinator.resume(targetEmail)
        await checkpointPromise

        assert.strictEqual(checkpointExited, true, 'checkPoint should unpark after resume')
        assert.strictEqual(sessionReloaded, true, 'reloadSession should have executed on resume')
        assert.strictEqual(coordinator.isPaused(), false, 'Coordinator should no longer report paused')
        assert.strictEqual(coordinator.isInspecting(targetEmail), false, 'Inspecting set should be cleared for target')
        assert.strictEqual(resumeListenerFired, true, 'onResume listener should have fired')
        assert.ok(recordedPausedMs >= 90, `Recorded paused ms (${recordedPausedMs}) should reflect inspection duration`)
        assert.ok(coordinator.getPausedDurationMs() >= 90, `getPausedDurationMs (${coordinator.getPausedDurationMs()}) should match`)
        console.log('✅ Test 3 Passed: Cooperative Pause & Resume lifecycle verified')
    }

    // Test 4: Timeout fallback when bot never reaches checkpoint
    {
        const coordinator = new PauseCoordinator()
        const targetEmail = 'stuck@outlook.com'
        const start = Date.now()
        const pauseReq = await coordinator.requestPause(targetEmail, 150)
        const elapsed = Date.now() - start

        assert.strictEqual(pauseReq, false, 'requestPause should resolve false on timeout')
        assert.ok(elapsed >= 140, 'Should have waited for timeout')
        coordinator.reset()
        console.log('✅ Test 4 Passed: Timeout handling verified')
    }

    // Test 5: Listener unhooking and Reset
    {
        const coordinator = new PauseCoordinator()
        let callCount = 0
        const unhook = coordinator.onPause(() => { callCount++ })
        unhook()

        await coordinator.requestPause('test@email.com', 50)
        coordinator.reset()

        assert.strictEqual(callCount, 0, 'Unhooked listener should not be called')
        assert.strictEqual(coordinator.isPaused(), false, 'Reset should clear paused state')
        assert.strictEqual(coordinator.isPauseRequested(), false, 'Reset should clear requested state')
        console.log('✅ Test 5 Passed: Listener unhooking and reset verified')
    }

    console.log('🎉 ALL PauseCoordinator tests passed successfully!\n')
}

if (require.main === module) {
    runPauseCoordinatorTests().catch(err => {
        console.error('❌ PauseCoordinator test failed:', err)
        process.exit(1)
    })
}
