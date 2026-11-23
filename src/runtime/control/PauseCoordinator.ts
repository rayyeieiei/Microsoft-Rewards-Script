export interface PauseCheckpointContext {
    isMobile?: boolean
    page?: any
    scope?: any
    saveSession?: () => Promise<void>
    reloadSession?: () => Promise<void>
}

export type PauseListener = (email: string, stage: string) => void
export type ResumeListener = (email: string, pausedDurationMs: number) => void

/**
 * PauseCoordinator orchestrates cooperative checkpoints between automated bot
 * farming and interactive headful manual browser inspection.
 *
 * It provides safe hot-pause, session persistence hand-off, deadline freeze,
 * and automatic resumption without killing or corrupting the account workflow.
 */
export class PauseCoordinator {
    private pauseRequested = false
    private targetEmail: string | null = null
    private isCurrentlyPaused = false
    private pauseReadyResolver: (() => void) | null = null
    private resumeResolver: (() => void) | null = null
    private inspectingEmails: Set<string> = new Set<string>()

    private pauseStartTime = 0
    private totalPausedDurationMs = 0

    private pauseListeners: Set<PauseListener> = new Set<PauseListener>()
    private resumeListeners: Set<ResumeListener> = new Set<ResumeListener>()

    constructor(
        private logger?: {
            info: (msg: string) => void
            warn: (msg: string) => void
            debug: (msg: string) => void
        }
    ) {}

    /**
     * Request a cooperative pause on an account currently running or about to run.
     * Returns a promise that resolves when the runner parks at a checkpoint.
     */
    public async requestPause(email: string, timeoutMs: number = 20000): Promise<boolean> {
        const normalized = email.toLowerCase().trim()
        this.targetEmail = normalized
        this.pauseRequested = true

        this.logger?.info?.(`[PAUSE-COORDINATOR] Cooperative pause requested for ${normalized} (timeout: ${timeoutMs}ms)`)

        // If runner is already paused, resolve immediately
        if (this.isCurrentlyPaused) {
            return true
        }

        return new Promise<boolean>(resolve => {
            let timer: NodeJS.Timeout | undefined

            const onReady = () => {
                if (timer) clearTimeout(timer)
                this.pauseReadyResolver = null
                resolve(true)
            }

            this.pauseReadyResolver = onReady

            timer = setTimeout(() => {
                this.logger?.warn?.(`[PAUSE-COORDINATOR] Pause request timed out after ${timeoutMs}ms for ${normalized}. Proceeding with inspection handoff.`)
                this.pauseReadyResolver = null
                resolve(false)
            }, timeoutMs)
        })
    }

    /**
     * Cooperative Checkpoint.
     * Placed inside the execution loop (e.g. between queries, between activities).
     * If pause is requested for the active account, this method parks the runner,
     * flushes session to disk, and waits until resume() is invoked.
     */
    public async checkPoint(stageName: string, context?: PauseCheckpointContext): Promise<void> {
        if (!this.pauseRequested) {
            return
        }

        this.logger?.info?.(`[PAUSE-COORDINATOR] Checkpoint reached at stage: ${stageName}. Handing off to manual inspection...`)

        try {
            if (context?.saveSession) {
                await context.saveSession()
                this.logger?.debug?.(`[PAUSE-COORDINATOR] Checkpoint session synchronized to disk at ${stageName}`)
            }
        } catch (err) {
            this.logger?.warn?.(`[PAUSE-COORDINATOR] Failed to save session during pause checkpoint: ${err}`)
        }

        this.isCurrentlyPaused = true
        this.pauseStartTime = Date.now()
        const activeEmail = this.targetEmail || 'unknown'

        // Notify pause listeners (e.g. deadline freeze)
        for (const listener of this.pauseListeners) {
            try {
                listener(activeEmail, stageName)
            } catch {}
        }

        // Notify requestPause caller that we have safely reached checkpoint
        if (this.pauseReadyResolver) {
            const resolver = this.pauseReadyResolver
            this.pauseReadyResolver = null
            resolver()
        }

        // Park execution until resume() is called
        await new Promise<void>(resolve => {
            this.resumeResolver = resolve
        })

        // Resume sequence
        const pausedElapsed = Math.max(0, Date.now() - this.pauseStartTime)
        this.totalPausedDurationMs += pausedElapsed
        this.isCurrentlyPaused = false
        this.pauseRequested = false
        this.pauseStartTime = 0

        this.logger?.info?.(`[PAUSE-COORDINATOR] Resuming execution for ${activeEmail} after ${(pausedElapsed / 1000).toFixed(1)}s inspection`)

        try {
            if (context?.reloadSession) {
                await context.reloadSession()
                this.logger?.debug?.(`[PAUSE-COORDINATOR] Session reloaded into context after manual inspection`)
            }
        } catch (err) {
            this.logger?.warn?.(`[PAUSE-COORDINATOR] Failed to reload session after manual inspection: ${err}`)
        }

        // Notify resume listeners (e.g. deadline unfreeze)
        for (const listener of this.resumeListeners) {
            try {
                listener(activeEmail, pausedElapsed)
            } catch {}
        }
    }

    /**
     * Wakes up the parked runner and signals it to continue farming.
     */
    public resume(email?: string): void {
        const normalized = email ? email.toLowerCase().trim() : undefined
        if (normalized) {
            this.inspectingEmails.delete(normalized)
        } else {
            this.inspectingEmails.clear()
        }

        if (this.resumeResolver) {
            const resolver = this.resumeResolver
            this.resumeResolver = null
            resolver()
        } else {
            // In case pause was requested but runner hadn't reached checkpoint yet
            this.pauseRequested = false
            this.isCurrentlyPaused = false
            if (this.pauseReadyResolver) {
                const resolver = this.pauseReadyResolver
                this.pauseReadyResolver = null
                resolver()
            }
        }
    }

    public isPauseRequested(email?: string): boolean {
        if (!this.pauseRequested) return false
        if (!email || !this.targetEmail) return this.pauseRequested
        return this.targetEmail === email.toLowerCase().trim()
    }

    public isPaused(): boolean {
        return this.isCurrentlyPaused
    }

    public isInspecting(email: string): boolean {
        return this.inspectingEmails.has(email.toLowerCase().trim())
    }

    public setInspecting(email: string, inspecting: boolean): void {
        const normalized = email.toLowerCase().trim()
        if (inspecting) {
            this.inspectingEmails.add(normalized)
        } else {
            this.inspectingEmails.delete(normalized)
        }
    }

    public getPausedDurationMs(): number {
        const currentActivePause = this.isCurrentlyPaused && this.pauseStartTime > 0
            ? Date.now() - this.pauseStartTime
            : 0
        return this.totalPausedDurationMs + currentActivePause
    }

    public onPause(listener: PauseListener): () => void {
        this.pauseListeners.add(listener)
        return () => this.pauseListeners.delete(listener)
    }

    public onResume(listener: ResumeListener): () => void {
        this.resumeListeners.add(listener)
        return () => this.resumeListeners.delete(listener)
    }

    public reset(): void {
        this.pauseRequested = false
        this.targetEmail = null
        this.isCurrentlyPaused = false
        this.pauseReadyResolver = null
        this.resumeResolver = null
        this.inspectingEmails.clear()
        this.pauseStartTime = 0
        this.totalPausedDurationMs = 0
    }
}
