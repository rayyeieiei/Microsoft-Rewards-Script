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
import { runChapter13LinuxSynchronizationTests } from './chapter13LinuxSynchronization.test'
import { runChapter14SafetyGuardrailsTests } from './chapter14SafetyGuardrails.test'
import { runChapter15UrlRewardAndLoggingTests } from './chapter15UrlRewardAndLogging.test'
import { runChapter16SequentialRunnerAndLoggingTests } from './chapter16SequentialRunnerAndLogging.test'
import { runAccountSuspensionGuardTests } from './accountSuspensionGuard.test'
import { runChapter29SigintBandwidthTelemetryTests } from './chapter29SigintBandwidthTelemetry.test'
import { runDapiBalanceAndPendingClaimTests } from './dapiBalanceAndPendingClaim.test'
import { runPunchCardUrlResolutionTests } from './punchCardUrlResolution.test'
import { runChapter30ZombieWorkerAndPunchCardResolverTests } from './chapter30ZombieWorkerAndPunchCardResolver.test'
import { runPauseCoordinatorTests } from './pauseCoordinator.test'

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

    await runChapter13LinuxSynchronizationTests()
    console.log('')

    await runChapter14SafetyGuardrailsTests()
    console.log('')

    await runChapter15UrlRewardAndLoggingTests()
    console.log('')

    await runChapter16SequentialRunnerAndLoggingTests()
    console.log('')

    await runAccountSuspensionGuardTests()
    console.log('')

    await runChapter29SigintBandwidthTelemetryTests()
    console.log('')

    await runDapiBalanceAndPendingClaimTests()
    console.log('')

    await runPunchCardUrlResolutionTests()
    console.log('')

    await runChapter30ZombieWorkerAndPunchCardResolverTests()
    console.log('')

    await runPauseCoordinatorTests()
    console.log('')

    console.log('🎉 ALL TESTS IN SUITE PASSED SUCCESSFULLY!')
}

runAll().catch(err => {
    console.error('❌ Test execution failed:', err)
    process.exit(1)
})
