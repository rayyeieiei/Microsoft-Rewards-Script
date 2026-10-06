import { runPunchCardTests } from './punchCards.test'
import { runPunchCardExecutionTests } from './punchCardExecution.test'
import { runActivitySemanticsTests } from './activitySemantics.test'
import { runAppOnlyObserverTests } from './appOnlyObserver.test'
import { runRedactionTests } from './redaction.test'
import { runDataSaverTests } from './dataSaver.test'
import { runBrowserOperationGuardTests } from './browserOperationGuard.test'
import { runNewAccountOnboardingTests } from './newAccountOnboarding.test'
import { runBrowserEnvironmentIsolationTests } from './browserEnvironmentIsolation.test'
import { runAccountOwnershipIdentityTests } from './accountOwnershipIdentity.test'
import { runLifecycleAndShutdownTests } from './lifecycleAndShutdown.test'
import { runNetworkRecoveryTests } from './networkRecovery.test'
import { runNetworkRecoveryDiagnosticsTests } from './networkRecoveryDiagnostics.test'
import { runSessionPersistenceTests } from './sessionPersistence.test'
import { runAntiAbuseRemediationTests } from './antiAbuseRemediation.test'
import { runChapter21PunchCardAutoSolverTests } from './chapter21PunchCardAutoSolver.test'
import { runChapter22SearchAbortLoopEliminationTests } from './chapter22SearchAbortLoopElimination.test'
import { runChapter23PasskeyBypassTests } from './chapter23PasskeyBypass.test'
import { runChapter24ProtocolFilterAndFeedResilienceTests } from './chapter24ProtocolFilterAndFeedResilience.test'
import { runChapter25OAuthConsentAndBonusClaimTests } from './chapter25OAuthConsentAndBonusClaimResilience.test'
import { runChapter26ImmediateDapiExecutionAndTokenRefreshTests } from './chapter26ImmediateDapiExecutionAndTokenRefresh.test'
import { runChapter27ReadToEarnResilienceAndTokenSyncTests } from './chapter27ReadToEarnResilienceAndTokenSync.test'

async function runAll() {
    console.log('🧪 Starting Full Test Suite Execution...\n')

    await runAccountOwnershipIdentityTests()
    console.log('')

    await runNetworkRecoveryTests()
    console.log('')

    await runNetworkRecoveryDiagnosticsTests()
    console.log('')

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

    await runNewAccountOnboardingTests()
    console.log('')

    await runBrowserEnvironmentIsolationTests()
    console.log('')

    await runLifecycleAndShutdownTests()
    console.log('')

    await runSessionPersistenceTests()
    console.log('')

    await runAntiAbuseRemediationTests()
    console.log('')

    await runChapter21PunchCardAutoSolverTests()
    console.log('')

    await runChapter22SearchAbortLoopEliminationTests()
    console.log('')

    await runChapter23PasskeyBypassTests()
    console.log('')

    await runChapter24ProtocolFilterAndFeedResilienceTests()
    console.log('')

    await runChapter25OAuthConsentAndBonusClaimTests()
    console.log('')

    await runChapter26ImmediateDapiExecutionAndTokenRefreshTests()
    console.log('')

    await runChapter27ReadToEarnResilienceAndTokenSyncTests()
    console.log('')

    console.log('🎉 ALL TESTS IN SUITE PASSED SUCCESSFULLY!')
}

runAll().catch(err => {
    console.error('❌ Test execution failed:', err)
    process.exit(1)
})
