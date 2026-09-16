import type { NetworkConnectivityProbe, NetworkRecoveryResult } from './NetworkRecoveryTypes'
import { DefaultNetworkConnectivityProbe } from './NetworkConnectivityProbe'

export type ConnectivityFailureSource =
    | 'account-auth'
    | 'dashboard-fetch'
    | 'owner-page'
    | 'query-provider'
    | 'telemetry'
    | 'data-saver'
    | 'axios'
    | 'unknown'

export interface ConnectivityFailureReporterOptions {
    failureWindowMs?: number
    minimumEvidenceThreshold?: number
    cooldownMs?: number
    probe?: NetworkConnectivityProbe
    onEscalate?: () => Promise<NetworkRecoveryResult>
    logger?: {
        info: (msg: string) => void
        warn: (msg: string) => void
        error: (msg: string) => void
    }
}

export class ConnectivityFailureReporter {
    private readonly failureWindowMs: number
    private readonly minimumEvidenceThreshold: number
    private readonly cooldownMs: number
    private readonly probe: NetworkConnectivityProbe
    private readonly onEscalate?: () => Promise<NetworkRecoveryResult>
    private readonly logger?: ConnectivityFailureReporterOptions['logger']

    private evidenceTimestamps: number[] = []
    private lastRecoveryTimestamp = 0
    private isEvaluating = false

    constructor(options: ConnectivityFailureReporterOptions = {}) {
        this.failureWindowMs = options.failureWindowMs ?? 10000
        this.minimumEvidenceThreshold = options.minimumEvidenceThreshold ?? 2
        this.cooldownMs = options.cooldownMs ?? 120000
        this.probe = options.probe || new DefaultNetworkConnectivityProbe()
        this.onEscalate = options.onEscalate
        this.logger = options.logger
    }

    /**
     * Determines whether an error represents an ignorable non-transport or filtered condition.
     */
    public shouldIgnoreError(source: ConnectivityFailureSource, error?: any): boolean {
        // Source-based filtering: query-provider, telemetry, and data-saver cannot trigger network recovery
        if (source === 'query-provider' || source === 'telemetry' || source === 'data-saver') {
            return true
        }

        if (!error) return false

        // Filter HTTP 4xx / 5xx responses
        if (error.response?.status || (typeof error.status === 'number' && error.status >= 400)) {
            return true
        }

        const msg = String(error.message || error).toLowerCase()

        // Filter activity timeouts, interaction timeouts, and navigation stage timeouts
        if (msg.includes('stage_timeout') || msg.includes('selector') || msg.includes('waiting for') || msg.includes('navigation timeout')) {
            return true
        }

        // Filter net::ERR_ABORTED and user cancellations
        if (msg.includes('net::err_aborted') || msg.includes('aborted') || msg.includes('canceled') || msg.includes('cancelled')) {
            return true
        }

        // Filter Data Saver blocks
        if (msg.includes('data-saver') || msg.includes('quota') || msg.includes('over_budget')) {
            return true
        }

        // Filter Wikipedia / query-provider mentions
        if (msg.includes('wikipedia') || msg.includes('suggestqueries') || msg.includes('query-provider')) {
            return true
        }

        return false
    }

    /**
     * Records a suspected transport failure. Filters out irrelevant errors, maintains a sliding
     * window, enforces cooldown and thresholds, and checks an independent probe before escalating.
     */
    public async reportFailure(
        source: ConnectivityFailureSource,
        error?: any
    ): Promise<NetworkRecoveryResult | null> {
        if (this.shouldIgnoreError(source, error)) {
            return {
                status: 'not-required',
                trigger: 'connectivity-failure',
                attempts: 0,
                durationMs: 0,
                finalStage: 'idle',
                airplaneModeKnowledge: 'confirmed-disabled',
                restorationAttempted: false,
                restorationSucceeded: false
            }
        }

        const now = Date.now()

        // Check cooldown
        if (now - this.lastRecoveryTimestamp < this.cooldownMs) {
            this.logger?.info(`[NETWORK-RECOVERY] skipped trigger=connectivity-failure reason=cooldown-active remainingMs=${this.cooldownMs - (now - this.lastRecoveryTimestamp)}`)
            return {
                status: 'not-required',
                trigger: 'connectivity-failure',
                attempts: 0,
                durationMs: 0,
                finalStage: 'idle',
                airplaneModeKnowledge: 'confirmed-disabled',
                restorationAttempted: false,
                restorationSucceeded: false
            }
        }

        // Maintain sliding window
        this.evidenceTimestamps = this.evidenceTimestamps.filter(t => now - t <= this.failureWindowMs)
        this.evidenceTimestamps.push(now)

        if (this.evidenceTimestamps.length < this.minimumEvidenceThreshold) {
            this.logger?.info(`[NETWORK-RECOVERY] failure observed count=${this.evidenceTimestamps.length}/${this.minimumEvidenceThreshold} source=${source}`)
            return null
        }

        // Single-flight evaluation guard
        if (this.isEvaluating) {
            this.logger?.info('[NETWORK-RECOVERY] probe/escalation already evaluating; skipping duplicate check')
            return null
        }

        this.isEvaluating = true
        try {
            // Rule 6: Independent single-flight probe pre-check
            const isHealthy = await this.probe.checkConnectivity()
            if (isHealthy) {
                this.logger?.info('[NETWORK-RECOVERY] skipped trigger=connectivity-failure reason=connectivity-healthy')
                this.evidenceTimestamps = []
                return {
                    status: 'not-required',
                    trigger: 'connectivity-failure',
                    attempts: 0,
                    durationMs: 0,
                    finalStage: 'idle',
                    airplaneModeKnowledge: 'confirmed-disabled',
                    restorationAttempted: false,
                    restorationSucceeded: false
                }
            }

            // Connectivity confirmed down; escalate to recovery handler
            this.lastRecoveryTimestamp = Date.now()
            this.evidenceTimestamps = []

            if (this.onEscalate) {
                return await this.onEscalate()
            }

            return null
        } finally {
            this.isEvaluating = false
        }
    }

    public reset(): void {
        this.evidenceTimestamps = []
        this.lastRecoveryTimestamp = 0
        this.isEvaluating = false
    }

    public getEvidenceCount(): number {
        const now = Date.now()
        this.evidenceTimestamps = this.evidenceTimestamps.filter(t => now - t <= this.failureWindowMs)
        return this.evidenceTimestamps.length
    }
}
