export type NetworkRecoveryMode = 'disabled' | 'manual' | 'adb'

export type NetworkRecoveryTrigger = 'connectivity-failure' | 'operator-request'

export type NetworkRecoveryStage =
    | 'idle'
    | 'preflight'
    | 'disconnecting'
    | 'waiting-disconnect'
    | 'reconnecting'
    | 'waiting-connectivity'
    | 'verifying-connectivity'
    | 'recovered'
    | 'failed'
    | 'cancelled'

export type NetworkRecoveryFailureReason =
    | 'adb-unavailable'
    | 'device-not-found'
    | 'multiple-devices'
    | 'device-unauthorized'
    | 'command-timeout'
    | 'disconnect-unconfirmed'
    | 'reconnect-unconfirmed'
    | 'connectivity-unavailable'
    | 'operator-timeout'
    | 'cancelled'
    | 'device-locked'
    | 'unknown'

export type AirplaneModeKnowledge =
    | 'confirmed-disabled'
    | 'confirmed-enabled'
    | 'possibly-enabled'

export interface NetworkRecoveryPolicy {
    enabled: boolean
    mode: NetworkRecoveryMode
    trigger: NetworkRecoveryTrigger
    adbSerial?: string
    maxAttempts: number
    commandTimeoutMs: number
    disconnectTimeoutMs: number
    reconnectTimeoutMs: number
    verificationIntervalMs: number
    operatorTimeoutMs: number
    reassertUsbTethering: boolean // default false
    totalBudgetMs: number
}

export interface NetworkRecoveryResult {
    status: 'recovered' | 'failed' | 'cancelled' | 'not-required'
    trigger: NetworkRecoveryTrigger
    attempts: number
    durationMs: number
    finalStage: NetworkRecoveryStage
    failureReason?: NetworkRecoveryFailureReason
    airplaneModeKnowledge: AirplaneModeKnowledge
    restorationAttempted: boolean
    restorationSucceeded: boolean
}

export interface NetworkConnectivityProbe {
    checkConnectivity(signal?: AbortSignal): Promise<boolean>
}

export interface NetworkRecoveryAdapter {
    readonly mode: NetworkRecoveryMode
    readonly knowledge: AirplaneModeKnowledge
    preflight(signal?: AbortSignal): Promise<void>
    executeDisconnect(signal?: AbortSignal): Promise<void>
    executeReconnect(signal?: AbortSignal): Promise<void>
    attemptRestoration(signal?: AbortSignal): Promise<boolean>
    dispose(): Promise<void>
}
