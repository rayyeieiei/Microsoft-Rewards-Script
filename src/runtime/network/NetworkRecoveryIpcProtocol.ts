import type { NetworkRecoveryTrigger, NetworkRecoveryResult } from './NetworkRecoveryTypes'

export interface NetworkRecoveryIpcRequest {
    __networkRecoveryRequest: {
        correlationId: string
        trigger: NetworkRecoveryTrigger
    }
}

export interface NetworkRecoveryIpcResponse {
    __networkRecoveryResponse: {
        correlationId: string
        result: NetworkRecoveryResult
    }
}
