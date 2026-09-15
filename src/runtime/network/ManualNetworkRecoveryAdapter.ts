import crypto from 'crypto'
import readline from 'readline'
import type {
    NetworkRecoveryAdapter,
    AirplaneModeKnowledge,
    NetworkRecoveryPolicy
} from './NetworkRecoveryTypes'

export interface ManualAdapterOptions {
    policy: NetworkRecoveryPolicy
    logger?: {
        info: (msg: string) => void
        warn: (msg: string) => void
        error: (msg: string) => void
    }
    stdin?: NodeJS.ReadableStream
}

export class ManualNetworkRecoveryAdapter implements NetworkRecoveryAdapter {
    public readonly mode = 'manual' as const
    public knowledge: AirplaneModeKnowledge = 'confirmed-disabled'
    private readonly policy: NetworkRecoveryPolicy
    private readonly logger?: {
        info: (msg: string) => void
        warn: (msg: string) => void
        error: (msg: string) => void
    }
    private readonly stdin?: NodeJS.ReadableStream

    private currentRequestId: string | null = null
    private activeResolution: {
        resolve: () => void
        reject: (err: any) => void
    } | null = null
    private activeTimer: NodeJS.Timeout | null = null
    private activeRl: readline.Interface | null = null

    constructor(options: ManualAdapterOptions) {
        this.policy = options.policy
        this.logger = options.logger
        this.stdin = options.stdin
    }

    public getCurrentRequestId(): string | null {
        return this.currentRequestId
    }

    /**
     * Resolves the pending manual recovery request via Dashboard C2 or external caller.
     * Returns true if successfully resolved, false if requestId is stale or mismatched.
     */
    public resolveManual(requestId: string, action: 'resume' | 'abort' = 'resume'): boolean {
        if (!this.currentRequestId || this.currentRequestId !== requestId || !this.activeResolution) {
            this.logger?.warn(
                `[NETWORK-MANUAL] Stale or mismatched requestId received: '${requestId}', active: '${this.currentRequestId}'`
            )
            return false
        }

        const res = this.activeResolution
        this.cleanupPending()

        if (action === 'abort') {
            this.logger?.warn(`[NETWORK-MANUAL] Manual recovery aborted by operator for request ${requestId}`)
            res.reject(new Error('Manual network recovery aborted by operator'))
        } else {
            this.logger?.info(`[NETWORK-MANUAL] Manual recovery confirmed by operator for request ${requestId}`)
            this.knowledge = 'confirmed-disabled'
            res.resolve()
        }
        return true
    }

    public async preflight(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) {
            throw new Error('Aborted by signal')
        }
        this.logger?.info('[NETWORK-MANUAL] Preflight check passed for manual network recovery')
    }

    public async executeDisconnect(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) {
            throw new Error('Aborted by signal')
        }
        this.knowledge = 'possibly-enabled'
        this.logger?.info(
            '[NETWORK-MANUAL] Please toggle network off / enable airplane mode manually if required.'
        )
    }

    public async executeReconnect(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) {
            throw new Error('Aborted by signal')
        }

        const requestId = crypto.randomBytes(8).toString('hex')
        this.currentRequestId = requestId
        const timeoutMs = this.policy.operatorTimeoutMs
        const timeoutSec = Math.round(timeoutMs / 1000)

        const promptMsg =
            `[NETWORK-MANUAL] >>> ACTION REQUIRED <<<\n` +
            `Please reconnect network or disable airplane mode.\n` +
            `Press [Enter] in console or confirm via Dashboard (Request ID: ${requestId}).\n` +
            `Waiting up to ${timeoutSec}s before timeout...`

        this.logger?.warn(promptMsg)
        if (!this.logger) {
            console.log(promptMsg)
        }

        return new Promise<void>((resolve, reject) => {
            this.activeResolution = { resolve, reject }

            // 1. Setup AbortSignal listener
            let onAbort: (() => void) | undefined
            if (signal) {
                onAbort = () => {
                    this.cleanupPending()
                    reject(new Error('Command cancelled by AbortSignal'))
                }
                if (signal.aborted) {
                    onAbort()
                    return
                }
                signal.addEventListener('abort', onAbort, { once: true })
            }

            // 2. Setup operator timeout
            this.activeTimer = setTimeout(() => {
                this.cleanupPending()
                const timeoutErr = new Error(`Manual recovery timed out after ${timeoutMs}ms`)
                ;(timeoutErr as any).code = 'ETIMEDOUT'
                this.logger?.error(`[NETWORK-MANUAL] Operator timeout reached (${timeoutMs}ms) for request ${requestId}`)
                reject(timeoutErr)
            }, timeoutMs)

            // 3. Setup CLI readline listener on stdin if available
            const input = this.stdin || (process.stdin.isTTY ? process.stdin : undefined)
            if (input) {
                try {
                    const rl = readline.createInterface({
                        input,
                        output: process.stdout,
                        terminal: false
                    })
                    this.activeRl = rl
                    rl.once('line', () => {
                        if (this.currentRequestId === requestId) {
                            this.resolveManual(requestId, 'resume')
                        }
                    })
                } catch {}
            }
        })
    }

    public async attemptRestoration(_signal?: AbortSignal): Promise<boolean> {
        this.knowledge = 'confirmed-disabled'
        this.logger?.info('[NETWORK-MANUAL] Restoration marked confirmed-disabled')
        return true
    }

    private cleanupPending(): void {
        if (this.activeTimer) {
            clearTimeout(this.activeTimer)
            this.activeTimer = null
        }
        if (this.activeRl) {
            try {
                this.activeRl.close()
            } catch {}
            this.activeRl = null
        }
        this.currentRequestId = null
        this.activeResolution = null
    }

    public async dispose(): Promise<void> {
        this.cleanupPending()
    }
}
