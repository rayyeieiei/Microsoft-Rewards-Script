import crypto from 'crypto'
import type { NetworkRecoveryTrigger, NetworkRecoveryResult } from './NetworkRecoveryTypes'
import type { NetworkRecoveryIpcRequest, NetworkRecoveryIpcResponse } from './NetworkRecoveryIpcProtocol'

export class NetworkRecoveryIpcClient {
    constructor(private readonly timeoutMs: number = 65000) {}

    public requestRecovery(
        trigger: NetworkRecoveryTrigger,
        signal?: AbortSignal
    ): Promise<NetworkRecoveryResult> {
        if (signal?.aborted) {
            return Promise.resolve({
                status: 'cancelled',
                trigger,
                attempts: 0,
                durationMs: 0,
                finalStage: 'cancelled',
                failureReason: 'cancelled',
                airplaneModeKnowledge: 'confirmed-disabled',
                restorationAttempted: false,
                restorationSucceeded: false
            })
        }

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
            let onAbort: (() => void) | null = null

            const cleanup = () => {
                process.removeListener('message', onMessage)
                if (timer) {
                    clearTimeout(timer)
                    timer = null
                }
                if (signal && onAbort) {
                    signal.removeEventListener('abort', onAbort)
                    onAbort = null
                }
            }

            const onMessage = (msg: any) => {
                const response = msg as NetworkRecoveryIpcResponse
                if (
                    response?.__networkRecoveryResponse &&
                    response.__networkRecoveryResponse.correlationId === correlationId
                ) {
                    cleanup()
                    resolve(response.__networkRecoveryResponse.result)
                }
            }

            process.on('message', onMessage)

            if (signal) {
                onAbort = () => {
                    cleanup()
                    resolve({
                        status: 'cancelled',
                        trigger,
                        attempts: 0,
                        durationMs: 0,
                        finalStage: 'cancelled',
                        failureReason: 'cancelled',
                        airplaneModeKnowledge: 'confirmed-disabled',
                        restorationAttempted: false,
                        restorationSucceeded: false
                    })
                }
                signal.addEventListener('abort', onAbort, { once: true })
            }

            timer = setTimeout(() => {
                cleanup()
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
