import type {
    NetworkRecoveryPolicy,
    NetworkRecoveryResult,
    NetworkRecoveryStage,
    NetworkRecoveryFailureReason,
    NetworkRecoveryTrigger,
    NetworkRecoveryAdapter,
    NetworkConnectivityProbe
} from './NetworkRecoveryTypes'
import { DefaultNetworkConnectivityProbe } from './NetworkConnectivityProbe'

export interface NetworkRecoveryControllerOptions {
    policy: NetworkRecoveryPolicy
    adapter: NetworkRecoveryAdapter
    probe?: NetworkConnectivityProbe
    logger?: {
        info: (msg: string) => void
        warn: (msg: string) => void
        error: (msg: string) => void
    }
}

export class NetworkRecoveryController {
    public readonly policy: NetworkRecoveryPolicy
    public readonly adapter: NetworkRecoveryAdapter
    public readonly probe: NetworkConnectivityProbe
    private readonly logger?: NetworkRecoveryControllerOptions['logger']
    private isRecovering = false

    constructor(options: NetworkRecoveryControllerOptions) {
        this.policy = options.policy
        this.adapter = options.adapter
        this.probe = options.probe || new DefaultNetworkConnectivityProbe()
        this.logger = options.logger
    }

    /**
     * Executes the bounded network recovery workflow.
     * Enforces concurrency serialization, independent probe pre-check,
     * bounded stage timeouts, total budget timeout, and tri-state restoration.
     */
    public async recover(
        trigger: NetworkRecoveryTrigger,
        outerSignal?: AbortSignal
    ): Promise<NetworkRecoveryResult> {
        const startTime = Date.now()

        if (!this.policy.enabled || this.policy.mode === 'disabled') {
            return {
                status: 'not-required',
                trigger,
                attempts: 0,
                durationMs: 0,
                finalStage: 'idle',
                airplaneModeKnowledge: this.adapter.knowledge,
                restorationAttempted: false,
                restorationSucceeded: false
            }
        }

        // Concurrency control: serialize recovery per controller
        if (this.isRecovering) {
            this.logger?.warn('[NETWORK-RECOVERY] Recovery requested while another operation is in progress; joining / failing fast')
            return {
                status: 'failed',
                trigger,
                attempts: 0,
                durationMs: Date.now() - startTime,
                finalStage: 'idle',
                failureReason: 'device-locked',
                airplaneModeKnowledge: this.adapter.knowledge,
                restorationAttempted: false,
                restorationSucceeded: false
            }
        }

        this.isRecovering = true

        // Total budget abort controller
        const budgetController = new AbortController()
        const totalBudgetTimer = setTimeout(() => {
            budgetController.abort(new Error('Total recovery budget exceeded'))
        }, this.policy.totalBudgetMs)

        const handleOuterAbort = () => {
            budgetController.abort(new Error('External cancellation requested'))
        }
        if (outerSignal?.aborted) {
            budgetController.abort(new Error('External cancellation requested'))
        } else {
            outerSignal?.addEventListener('abort', handleOuterAbort)
        }

        const activeSignal = budgetController.signal

        let stage: NetworkRecoveryStage = 'idle'
        let currentAttempt = 0
        let restorationAttempted = false
        let restorationSucceeded = false
        let failureReason: NetworkRecoveryFailureReason | undefined

        this.logger?.info(`[NETWORK-RECOVERY] start mode=${this.policy.mode} trigger=${trigger}`)

        try {
            if (activeSignal.aborted) {
                stage = 'cancelled'
                failureReason = 'cancelled'
                throw new Error('Operation cancelled')
            }

            // Rule 6: Suspected connectivity failure must first run independent bounded probe
            if (trigger === 'connectivity-failure') {
                const initiallyHealthy = await this.probe.checkConnectivity(activeSignal)
                if (initiallyHealthy) {
                    this.logger?.info('[NETWORK-RECOVERY] skipped trigger=connectivity-failure reason=connectivity-healthy')
                    return {
                        status: 'not-required',
                        trigger,
                        attempts: 0,
                        durationMs: Date.now() - startTime,
                        finalStage: 'idle',
                        airplaneModeKnowledge: this.adapter.knowledge,
                        restorationAttempted: false,
                        restorationSucceeded: false
                    }
                }
            }

            // Attempt loop bounded by maxAttempts
            for (let attempt = 1; attempt <= this.policy.maxAttempts; attempt++) {
                currentAttempt = attempt
                if (activeSignal.aborted) {
                    stage = 'cancelled'
                    failureReason = 'cancelled'
                    break
                }

                this.logger?.info(`[NETWORK-RECOVERY] stage=preflight attempt=${attempt} timeoutMs=${this.policy.commandTimeoutMs}`)
                stage = 'preflight'
                await this.adapter.preflight(activeSignal)

                this.logger?.info(`[NETWORK-RECOVERY] stage=disconnecting attempt=${attempt} timeoutMs=${this.policy.commandTimeoutMs}`)
                stage = 'disconnecting'
                await this.adapter.executeDisconnect(activeSignal)

                stage = 'waiting-disconnect'
                await this.delay(this.policy.disconnectTimeoutMs, activeSignal)

                this.logger?.info(`[NETWORK-RECOVERY] stage=reconnecting attempt=${attempt} timeoutMs=${this.policy.commandTimeoutMs}`)
                stage = 'reconnecting'
                await this.adapter.executeReconnect(activeSignal)

                stage = 'waiting-connectivity'
                await this.delay(this.policy.reconnectTimeoutMs, activeSignal)

                stage = 'verifying-connectivity'
                const probeSuccess = await this.probe.checkConnectivity(activeSignal)

                if (probeSuccess) {
                    stage = 'recovered'
                    this.logger?.info(`[NETWORK-RECOVERY] end status=recovered attempts=${attempt} durationMs=${Date.now() - startTime}`)
                    return {
                        status: 'recovered',
                        trigger,
                        attempts: attempt,
                        durationMs: Date.now() - startTime,
                        finalStage: 'recovered',
                        airplaneModeKnowledge: this.adapter.knowledge,
                        restorationAttempted: false,
                        restorationSucceeded: false
                    }
                }

                this.logger?.warn(`[NETWORK-RECOVERY] Probe unconfirmed after attempt ${attempt}/${this.policy.maxAttempts}`)
            }

            // If attempts exhausted without recovery
            stage = 'failed'
            failureReason = failureReason || 'connectivity-unavailable'
        } catch (error: any) {
            if (activeSignal.aborted || outerSignal?.aborted) {
                stage = 'cancelled'
                failureReason = 'cancelled'
            } else {
                stage = 'failed'
                failureReason = this.classifyError(error)
            }
            this.logger?.error(`[NETWORK-RECOVERY] Error during recovery stage=${stage}: ${error?.message || String(error)}`)
        } finally {
            clearTimeout(totalBudgetTimer)
            outerSignal?.removeEventListener('abort', handleOuterAbort)

            // Rule 7 & Invariant 5: Tri-state restoration guarantee
            if (this.adapter.knowledge === 'confirmed-enabled' || this.adapter.knowledge === 'possibly-enabled') {
                this.logger?.warn(`[NETWORK-RECOVERY] Radio state is ${this.adapter.knowledge}; performing bounded restoration to disable airplane mode`)
                restorationAttempted = true
                const restorationController = new AbortController()
                const restorationDeadline = setTimeout(() => {
                    restorationController.abort(new Error('Restoration timeout exceeded'))
                }, this.policy.commandTimeoutMs || 10000)
                try {
                    restorationSucceeded = await this.adapter.attemptRestoration(restorationController.signal)
                } catch (resErr: any) {
                    restorationSucceeded = false
                    this.logger?.error(`[NETWORK-RECOVERY] Restoration attempt encountered error: ${resErr?.message || String(resErr)}`)
                } finally {
                    clearTimeout(restorationDeadline)
                }
            }

            this.logger?.info(
                `[NETWORK-RECOVERY] end status=${stage} attempts=${currentAttempt} durationMs=${Date.now() - startTime} restorationAttempted=${restorationAttempted} restorationSucceeded=${restorationSucceeded}`
            )

            this.isRecovering = false
        }

        return {
            status: stage === 'cancelled' ? 'cancelled' : 'failed',
            trigger,
            attempts: currentAttempt,
            durationMs: Date.now() - startTime,
            finalStage: stage,
            failureReason,
            airplaneModeKnowledge: this.adapter.knowledge,
            restorationAttempted,
            restorationSucceeded
        }
    }

    private delay(ms: number, signal: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            if (signal.aborted) return reject(new Error('Operation cancelled'))
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', onAbort)
                resolve()
            }, ms)
            const onAbort = () => {
                clearTimeout(timer)
                signal.removeEventListener('abort', onAbort)
                reject(new Error('Operation cancelled'))
            }
            signal.addEventListener('abort', onAbort)
        })
    }

    private classifyError(error: any): NetworkRecoveryFailureReason {
        const msg = String(error?.message || '').toLowerCase()
        if (msg.includes('multiple devices')) return 'multiple-devices'
        if (msg.includes('unauthorized')) return 'device-unauthorized'
        if (msg.includes('not found') || msg.includes('no devices')) return 'device-not-found'
        if (msg.includes('timeout')) return 'command-timeout'
        if (msg.includes('operator')) return 'operator-timeout'
        if (msg.includes('locked')) return 'device-locked'
        if (msg.includes('adb') && (msg.includes('enoent') || msg.includes('not recognized'))) return 'adb-unavailable'
        return 'unknown'
    }
}
