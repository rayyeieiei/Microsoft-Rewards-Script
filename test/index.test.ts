import { runPunchCardTests } from './punchCards.test'
import { runPunchCardExecutionTests } from './punchCardExecution.test'
import { runActivitySemanticsTests } from './activitySemantics.test'
import { runAppOnlyObserverTests } from './appOnlyObserver.test'
import { runRedactionTests } from './redaction.test'
import { runDataSaverTests } from './dataSaver.test'
import { runBrowserOperationGuardTests } from './browserOperationGuard.test'

async function runAll() {
    console.log('🧪 Starting Full Test Suite Execution...\n')

    await runPunchCardTests()
    console.log('')

    await runPunchCardExecutionTests()
    console.log('')

    await runActivitySemanticsTests()
    console.log('')

    await runAppOnlyObserverTests()
    console.log('')

    await runRedactionTests()
    console.log('')

    await runDataSaverTests()
    console.log('')

    await runBrowserOperationGuardTests()
    console.log('')

    console.log('🎉 ALL TESTS IN SUITE PASSED SUCCESSFULLY!')
}

runAll().catch(err => {
    console.error('❌ Test execution failed:', err)
    process.exit(1)
})
