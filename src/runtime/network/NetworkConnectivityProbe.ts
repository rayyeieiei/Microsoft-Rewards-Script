import axios from 'axios'
import dns from 'node:dns/promises'
import type { NetworkConnectivityProbe } from './NetworkRecoveryTypes'

export interface NetworkConnectivityProbeOptions {
    probeHost?: string
    timeoutMs?: number
}

/**
 * Single-purpose, bounded connectivity probe.
 * Does NOT contact Rewards endpoints, does NOT check points, does NOT log URLs or compare IPs.
 */
export class DefaultNetworkConnectivityProbe implements NetworkConnectivityProbe {
    private readonly probeHost: string
    private readonly timeoutMs: number

    constructor(options: NetworkConnectivityProbeOptions = {}) {
        this.probeHost = options.probeHost || 'www.bing.com'
        this.timeoutMs = options.timeoutMs || 5000
    }

    public async checkConnectivity(signal?: AbortSignal): Promise<boolean> {
        if (signal?.aborted) return false

        try {
            // Stage 1: DNS resolution check
            await Promise.race([
                dns.lookup(this.probeHost),
                new Promise((_, reject) => {
                    const timer = setTimeout(() => reject(new Error('DNS probe timeout')), this.timeoutMs)
                    signal?.addEventListener('abort', () => {
                        clearTimeout(timer)
                        reject(new Error('Probe aborted'))
                    })
                })
            ])

            if (signal?.aborted) return false

            // Stage 2: Bounded HTTP HEAD request without cookies/credentials
            const response = await axios.head(`https://${this.probeHost}`, {
                timeout: this.timeoutMs,
                signal: signal as any,
                validateStatus: () => true // any HTTP status (200, 301, 404, etc.) indicates network routing is functional
            })

            return typeof response.status === 'number' && response.status > 0
        } catch {
            return false
        }
    }
}
