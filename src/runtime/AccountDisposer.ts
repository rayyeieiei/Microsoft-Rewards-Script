import fs from 'fs'
import path from 'path'
import type { AccountScope } from './AccountScope'
import { ResolvedActionSecret } from '../functions/UrlRewardActionResolver'

const CONTEXT_CLOSE_TIMEOUT_MS = 4000
const STORAGE_SAVE_TIMEOUT_MS = 2000

export interface CleanupStepResult {
    step: string
    status: 'ok' | 'failed' | 'timed-out'
    error?: string
    durationMs: number
}

export class AccountDisposer {
    /**
     * Executes the strict 10-step disposal sequence for an AccountScope.
     * Guarantees zero residual state, clean context/page teardown,
     * bounded timeout recovery, and memory wipe.
     * Uses scope.beginDisposal() for atomic, race-safe execution.
     */
    public static dispose(scope: AccountScope): Promise<void> {
        if (scope.isDisposed) {
            return Promise.resolve()
        }
        return scope.beginDisposal(() => AccountDisposer.disposeOnce(scope))
    }

    private static async disposeOnce(scope: AccountScope): Promise<void> {
        // 1. Cooperative pause and wait for active in-flight operations
        try {
            await scope.waitForActiveOperations(1500)
        } catch {}

        await new Promise(resolve => setTimeout(resolve, 20))

        // 2. Detach exact route handlers and response listeners BEFORE closing context
        const routeHandlers = scope.getRouteHandlers()
        for (const rh of routeHandlers) {
            try {
                if (rh.context && typeof rh.context.unroute === 'function') {
                    await rh.context.unroute(rh.url, rh.handler)
                }
            } catch {}
        }

        const responseListeners = scope.getResponseListeners()
        for (const rl of responseListeners) {
            try {
                if (rl.context) {
                    if (typeof rl.context.off === 'function') {
                        rl.context.off('response', rl.listener)
                    } else if (typeof rl.context.removeListener === 'function') {
                        rl.context.removeListener('response', rl.listener)
                    }
                }
            } catch {}
        }
        scope.clearRouteHandlersAndListeners()

        // 3. Dispose ghost cursor references
        scope.clearCursors()

        // 4. Persist storageState bounded/atomic if contexts are open and valid
        const storagePaths = scope.storagePaths
        if (storagePaths) {
            const mobileCtx = scope.getContext('mobile')
            if (mobileCtx) {
                await AccountDisposer.saveStorageStateSafely(
                    mobileCtx,
                    storagePaths.mobilePath,
                    STORAGE_SAVE_TIMEOUT_MS
                )
            }
            const desktopCtx = scope.getContext('desktop')
            if (desktopCtx) {
                await AccountDisposer.saveStorageStateSafely(
                    desktopCtx,
                    storagePaths.desktopPath,
                    STORAGE_SAVE_TIMEOUT_MS
                )
            }
        }

        // 5. Close pages with bounded timeout (e.g. 1000ms per page)
        const trackedPages = scope.getTrackedPages()
        for (const p of trackedPages) {
            try {
                if (p && typeof p.close === 'function') {
                    const isClosed = typeof p.isClosed === 'function' ? p.isClosed() : false
                    if (!isClosed) {
                        await Promise.race([
                            p.close(),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('page close timeout')), 1000))
                        ]).catch(() => {})
                    }
                }
            } catch {}
        }
        scope.clearTrackedPages()

        // 6. Close contexts with bounded timeout (CONTEXT_CLOSE_TIMEOUT_MS)
        const contextsToClose = [scope.getContext('mobile'), scope.getContext('desktop')].filter(Boolean)
        let timeoutOccurred = false

        for (const ctx of contextsToClose) {
            try {
                await Promise.race([
                    ctx.close(),
                    new Promise((_, reject) =>
                        setTimeout(() => {
                            reject(new Error('Context close timeout'))
                        }, CONTEXT_CLOSE_TIMEOUT_MS)
                    )
                ])
            } catch {
                timeoutOccurred = true
                if (scope.bot) {
                    scope.bot.logger.warn(
                        'main',
                        'ACCOUNT-DISPOSER',
                        'Context close timed out or failed; marking browser unhealthy for recycling'
                    )
                    if (scope.bot.browserFactory) {
                        scope.bot.browserFactory.isHealthy = false
                    }
                }
            }
        }

        // 7. Recycle browser if context close timed out
        if (timeoutOccurred && scope.bot?.browserFactory) {
            try {
                await scope.bot.browserFactory.recycleBrowser()
            } catch (recycleErr) {
                scope.bot.logger.error(
                    'main',
                    'ACCOUNT-DISPOSER',
                    `Browser recycling failed: ${recycleErr instanceof Error ? recycleErr.message : String(recycleErr)}`
                )
            }
        }

        // 8. Clear DAPI token, secrets, and tracked timers
        scope.clearDapiToken()

        // Wipe secrets to prevent memory retention
        const secrets = scope.getSecrets()
        for (const [key] of secrets) {
            scope.setSecret(key, new ResolvedActionSecret({ accountScopeId: '', offerId: '' }))
        }
        scope.clearSecrets()

        // Clear tracked timers
        const timers = scope.getTrackedTimers()
        for (const t of timers) {
            try {
                clearTimeout(t)
            } catch {}
        }
        scope.clearTrackedTimers()

        // Clear attempt records
        scope.clearAttemptRecords()

        // 9. Mark disposed
        scope.markDisposed()
    }

    private static async saveStorageStateSafely(
        context: any,
        targetPath: string,
        timeoutMs: number
    ): Promise<void> {
        if (!context || typeof context.storageState !== 'function') return
        try {
            const state = await Promise.race([
                context.storageState(),
                new Promise<null>((_, reject) =>
                    setTimeout(() => reject(new Error('storageState timeout')), timeoutMs)
                )
            ])
            if (state) {
                const dir = path.dirname(targetPath)
                if (!fs.existsSync(dir)) {
                    await fs.promises.mkdir(dir, { recursive: true })
                }
                const tmpPath = `${targetPath}.tmp.${Date.now()}`
                await fs.promises.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8')
                await fs.promises.rename(tmpPath, targetPath)
            }
        } catch {
            // Context already closed or timed out; safe to skip
        }
    }
}
