import crypto from 'crypto'
import type { NetworkRecoveryTrigger, NetworkRecoveryResult } from './NetworkRecoveryTypes'
import type { NetworkRecoveryIpcRequest, NetworkRecoveryIpcResponse } from './NetworkRecoveryIpcProtocol'

export class NetworkRecoveryIpcClient {
    constructor(private readonly timeoutMs: number = 65000) {}

    public requestRecovery(trigger: NetworkRecoveryTrigger): Promise<NetworkRecoveryResult> {
        if (!process.send) {
            return Promise.resolve({
                status: 'failed',
                trigger,
                attempts: 0,
                durationMs: 0,
                finalStage: 'idle',
                failureReason: 'unknown',
                airplaneModeKnowledge: 'confirmed-disabled',
                restorationAttempted: false,
                restorationSucceeded: false
            })
        }

        return new Promise(resolve => {
            const correlationId = crypto.randomBytes(8).toString('hex')
            let timer: NodeJS.Timeout | null = null

            const onMessage = (msg: any) => {
                const response = msg as NetworkRecoveryIpcResponse
                if (
                    response?.__networkRecoveryResponse &&
                    response.__networkRecoveryResponse.correlationId === correlationId
                ) {
                    process.removeListener('message', onMessage)
                    if (timer) clearTimeout(timer)
                    resolve(response.__networkRecoveryResponse.result)
                }
            }

            process.on('message', onMessage)

            timer = setTimeout(() => {
                process.removeListener('message', onMessage)
                resolve({
                    status: 'failed',
                    trigger,
                    attempts: 0,
                    durationMs: this.timeoutMs,
                    finalStage: 'idle',
                    failureReason: 'operator-timeout',
                    airplaneModeKnowledge: 'confirmed-disabled',
                    restorationAttempted: false,
                    restorationSucceeded: false
                })
            }, this.timeoutMs)

            const req: NetworkRecoveryIpcRequest = {
                __networkRecoveryRequest: { correlationId, trigger }
            }
            process.send!(req)
        })
    }
}
