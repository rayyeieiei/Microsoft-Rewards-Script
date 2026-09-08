import type { Page, BrowserContext, Request, Response } from 'patchright'

export type BrowserOperationStage =
    | 'oauth-navigation'
    | 'oauth-return'
    | 'dashboard-navigation'
    | 'activity-navigation'
    | 'activity-interaction'
    | 'safe-scroll'
    | 'activity-page-close'
    | 'dashboard-return'
    | 'server-verification'

export type BrowserOperationStatus =
    | 'completed'
    | 'timed-out'
    | 'navigation-error'
    | 'page-closed'
    | 'aborted'
    | 'failed'

export type GuardedOperation<T> = (signal: AbortSignal, remainingMs: number) => Promise<T>

export interface BrowserOperationResult<T> {
    stage: BrowserOperationStage
    status: BrowserOperationStatus
    durationMs: number
    value?: T
    errorCode?: string
    mainDocumentFailureCode?: string
    subresourceFailureCount?: number
}

export interface RunGuardedOperationOptions<T> {
    stage: BrowserOperationStage
    timeoutMs: number
    operation: GuardedOperation<T>
    page?: Page
    logger?: any
    isMobile?: boolean
    remainingBudgetMs?: number
}

export function sanitizeDiagnosticUrl(rawUrl?: string): { origin: string; pathname: string } {
    if (!rawUrl || typeof rawUrl !== 'string') {
        return { origin: 'unknown', pathname: 'unknown' }
    }
    try {
        const parsed = new URL(rawUrl)
        return {
            origin: parsed.origin,
            pathname: parsed.pathname
        }
    } catch {
        return { origin: 'invalid', pathname: 'invalid' }
    }
}

export async function interruptibleWait(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return
    return new Promise(resolve => {
        let timer: NodeJS.Timeout
        const onAbort = () => {
            clearTimeout(timer)
            resolve()
        }
        timer = setTimeout(() => {
            if (signal) signal.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        if (signal) {
            signal.addEventListener('abort', onAbort, { once: true })
        }
    })
}

export async function runGuardedOperation<T>(options: RunGuardedOperationOptions<T>): Promise<BrowserOperationResult<T>> {
    const { stage, timeoutMs, operation, page, logger, isMobile = false, remainingBudgetMs } = options
    const effectiveTimeoutMs = remainingBudgetMs !== undefined
        ? Math.min(timeoutMs, Math.max(0, remainingBudgetMs))
        : timeoutMs

    if (logger && typeof logger.debug === 'function') {
        logger.debug(
            isMobile,
            'BROWSER-GUARD',
            `[STAGE-START] stage=${stage} timeoutMs=${effectiveTimeoutMs} remainingBudgetMs=${remainingBudgetMs ?? effectiveTimeoutMs}`
        )
    }

    if (effectiveTimeoutMs <= 0) {
        if (logger && typeof logger.warn === 'function') {
            logger.warn(
                isMobile,
                'BROWSER-GUARD',
                `[STAGE-END] stage=${stage} elapsedMs=0 status=timed-out reason=budget-exhausted`
            )
        }
        return {
            stage,
            status: 'timed-out',
            durationMs: 0,
            errorCode: 'TOTAL_BUDGET_EXHAUSTED'
        }
    }

    const abortController = new AbortController()
    const signal = abortController.signal
    const startTime = Date.now()

    let mainDocumentFailureCode: string | undefined
    let subresourceFailureCount = 0
    const failureCodes: string[] = []
    let mainDocumentStatus: string = 'none'

    let onResponse: ((response: Response) => void) | undefined
    let onRequestFailed: ((request: Request) => void) | undefined

    if (page && typeof page.on === 'function') {
        onResponse = (response: Response) => {
            try {
                const req = response.request()
                const isNav = typeof req.isNavigationRequest === 'function' ? req.isNavigationRequest() : false
                const isMainFrame = typeof req.frame === 'function' ? req.frame() === page.mainFrame() : false
                if (isNav && isMainFrame) {
                    mainDocumentStatus = String(response.status())
                }
            } catch {}
        }

        onRequestFailed = (request: Request) => {
            try {
                const isNav = typeof request.isNavigationRequest === 'function' ? request.isNavigationRequest() : false
                const isMainFrame = typeof request.frame === 'function' ? request.frame() === page.mainFrame() : false
                const errorText = request.failure()?.errorText || 'REQUEST_FAILED'

                if (isNav && isMainFrame) {
                    mainDocumentFailureCode = errorText
                } else {
                    subresourceFailureCount++
                }
                if (!failureCodes.includes(errorText)) {
                    failureCodes.push(errorText)
                }
            } catch {}
        }

        try {
            page.on('response', onResponse)
            page.on('requestfailed', onRequestFailed)
        } catch {}
    }

    let timer: NodeJS.Timeout | null = null
    const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            abortController.abort()
            reject(new Error(`STAGE_TIMEOUT: ${stage} exceeded ${effectiveTimeoutMs}ms`))
        }, effectiveTimeoutMs)
    })

    try {
        const value = await Promise.race([
            operation(signal, effectiveTimeoutMs),
            timeoutPromise
        ])

        const durationMs = Date.now() - startTime
        if (logger && typeof logger.debug === 'function') {
            logger.debug(
                isMobile,
                'BROWSER-GUARD',
                `[STAGE-END] stage=${stage} elapsedMs=${durationMs} status=completed`
            )
            if (page && (mainDocumentStatus !== 'none' || subresourceFailureCount > 0 || mainDocumentFailureCode)) {
                logger.debug(
                    isMobile,
                    'BROWSER-NET',
                    `[BROWSER-NET] stage=${stage} mainDocumentStatus=${mainDocumentStatus} failedRequests=${subresourceFailureCount + (mainDocumentFailureCode ? 1 : 0)} failureCodes=[${failureCodes.join(',')}]`
                )
            }
        }

        return {
            stage,
            status: 'completed',
            durationMs,
            value,
            mainDocumentFailureCode,
            subresourceFailureCount
        }
    } catch (error: any) {
        const durationMs = Date.now() - startTime
        const errMessage = error instanceof Error ? error.message : String(error)
        const isTimeout = errMessage.includes('STAGE_TIMEOUT') || signal.aborted
        const isPageClosed = (page && typeof page.isClosed === 'function' && page.isClosed()) ||
            errMessage.includes('Target page, context or browser has been closed')
        const isNavError = Boolean(mainDocumentFailureCode) ||
            errMessage.includes('net::') ||
            errMessage.includes('NS_ERROR') ||
            errMessage.includes('Navigation failed')

        let status: BrowserOperationStatus = 'failed'
        if (isTimeout) {
            status = 'timed-out'
        } else if (isPageClosed) {
            status = 'page-closed'
        } else if (isNavError) {
            status = 'navigation-error'
        }

        if (logger && typeof logger.warn === 'function') {
            logger.warn(
                isMobile,
                'BROWSER-GUARD',
                `[STAGE-END] stage=${stage} elapsedMs=${durationMs} status=${status} error=${errMessage}`
            )
            if (page && (mainDocumentStatus !== 'none' || subresourceFailureCount > 0 || mainDocumentFailureCode)) {
                logger.debug(
                    isMobile,
                    'BROWSER-NET',
                    `[BROWSER-NET] stage=${stage} mainDocumentStatus=${mainDocumentStatus} failedRequests=${subresourceFailureCount + (mainDocumentFailureCode ? 1 : 0)} failureCodes=[${failureCodes.join(',')}]`
                )
            }
        }

        return {
            stage,
            status,
            durationMs,
            errorCode: errMessage,
            mainDocumentFailureCode,
            subresourceFailureCount
        }
    } finally {
        if (timer) {
            clearTimeout(timer)
        }
        if (page && typeof page.off === 'function') {
            try {
                if (onResponse) page.off('response', onResponse)
                if (onRequestFailed) page.off('requestfailed', onRequestFailed)
            } catch {}
        }
    }
}

export interface SafeScrollOptions {
    maxDurationMs?: number
    maxSteps?: number
    stepDelayMs?: number
    signal?: AbortSignal
    logger?: any
    isMobile?: boolean
    scrollAmount?: number
}

export async function performBoundedSafeScroll(page: Page, options: SafeScrollOptions = {}): Promise<{ stepsCompleted: number; elapsedMs: number; interrupted: boolean }> {
    const {
        maxDurationMs = 10_000,
        maxSteps = 8,
        stepDelayMs = 750,
        signal,
        logger,
        isMobile = false,
        scrollAmount = 350
    } = options

    const startTime = Date.now()
    let stepsCompleted = 0
    let lastScrollY = -1
    let unchangedCount = 0
    let interrupted = false

    for (let step = 0; step < maxSteps; step++) {
        if (signal?.aborted) {
            interrupted = true
            break
        }
        if (typeof page.isClosed === 'function' && page.isClosed()) {
            interrupted = true
            break
        }
        if (Date.now() - startTime >= maxDurationMs) {
            break
        }

        const delta = step % 2 === 0 ? scrollAmount : -Math.floor(scrollAmount / 2)
        const currentY = await Promise.race([
            page.evaluate((d: number) => {
                window.scrollBy({ top: d, behavior: 'smooth' })
                return window.scrollY
            }, delta).catch(() => null),
            new Promise<null>(resolve => setTimeout(() => resolve(null), 2000))
        ])

        stepsCompleted++

        if (currentY === null || currentY === lastScrollY) {
            unchangedCount++
            if (unchangedCount >= 2) {
                break
            }
        } else {
            unchangedCount = 0
            lastScrollY = currentY
        }

        const remainingMs = Math.max(0, maxDurationMs - (Date.now() - startTime))
        const delay = Math.min(stepDelayMs, remainingMs)
        if (delay > 0) {
            await interruptibleWait(delay, signal)
        }
    }

    const elapsedMs = Date.now() - startTime
    if (logger && typeof logger.debug === 'function') {
        logger.debug(
            isMobile,
            'SAFE-SCROLL',
            `[SAFE-SCROLL] stepsCompleted=${stepsCompleted}/${maxSteps} elapsedMs=${elapsedMs} interrupted=${interrupted}`
        )
    }

    return { stepsCompleted, elapsedMs, interrupted }
}

export class AccountWatchdog {
    private timer: NodeJS.Timeout | null = null
    private currentStage: string = 'idle'
    private lastActivityTime: number = Date.now()
    private readonly intervalMs: number = 20_000

    constructor(
        private logger?: any,
        private isMobile: boolean = false
    ) {}

    start(initialStage: string = 'started'): void {
        this.currentStage = initialStage
        this.lastActivityTime = Date.now()
        this.stop()

        this.timer = setInterval(() => {
            const elapsed = Date.now() - this.lastActivityTime
            if (elapsed >= this.intervalMs) {
                if (this.logger && typeof this.logger.info === 'function') {
                    this.logger.info(
                        this.isMobile,
                        'ACCOUNT-WATCHDOG',
                        `[ACCOUNT-WATCHDOG] stage=${this.currentStage} elapsedMs=${elapsed} heartbeat=active recoveryPending=false`
                    )
                }
                this.lastActivityTime = Date.now()
            }
        }, this.intervalMs)

        if (this.timer.unref) {
            this.timer.unref()
        }
    }

    updateStage(stage: string): void {
        this.currentStage = stage
        this.lastActivityTime = Date.now()
    }

    heartbeat(): void {
        this.lastActivityTime = Date.now()
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
    }
}

export function promiseAny<T>(promises: Promise<T>[]): Promise<T> {
    return new Promise((resolve, reject) => {
        const errors: any[] = []
        let remaining = promises.length
        if (remaining === 0) {
            return reject(new Error('All promises were rejected'))
        }
        for (const p of promises) {
            Promise.resolve(p).then(
                val => resolve(val),
                err => {
                    errors.push(err)
                    remaining--
                    if (remaining === 0) {
                        reject(new Error(`All promises rejected: ${errors.map(e => e?.message || String(e)).join('; ')}`))
                    }
                }
            )
        }
    })
}

export interface ManagedPageOptions {
    context: BrowserContext
    accountScope?: string
    purpose: string
    isMobile?: boolean
    defaultTimeoutMs?: number
    defaultNavTimeoutMs?: number
}

export async function createManagedPage(options: ManagedPageOptions): Promise<Page> {
    const {
        context,
        purpose,
        isMobile = false,
        defaultTimeoutMs = 15_000,
        defaultNavTimeoutMs = 20_000
    } = options

    const page = await context.newPage()
    ;(page as any).__managedMetadata = { purpose, isMobile }

    try {
        if (typeof page.setDefaultTimeout === 'function') {
            page.setDefaultTimeout(defaultTimeoutMs)
        }
        if (typeof page.setDefaultNavigationTimeout === 'function') {
            page.setDefaultNavigationTimeout(defaultNavTimeoutMs)
        }
        if (typeof page.on === 'function') {
            page.on('dialog', dialog => {
                dialog.dismiss().catch(() => {})
            })
            page.on('pageerror', () => {})
        }
    } catch {}

    return page
}

export interface OwnerPageRecoveryDependencies {
    bot: any
    oldPage?: Page | null
    isMobile: boolean
    accountScope?: string
}

const recoveryCountPerRun = new Map<string, number>()

export function resetRecoveryCount(scope?: string): void {
    if (scope) {
        recoveryCountPerRun.delete(scope)
    } else {
        recoveryCountPerRun.clear()
    }
}

export function getRecoveryCount(scope: string): number {
    return recoveryCountPerRun.get(scope) ?? 0
}

export async function recoverOwnerPage(deps: OwnerPageRecoveryDependencies): Promise<Page | null> {
    const scopeKey = deps.accountScope || 'default'
    const currentCount = recoveryCountPerRun.get(scopeKey) ?? 0

    if (currentCount >= 1) {
        if (deps.bot?.logger && typeof deps.bot.logger.warn === 'function') {
            deps.bot.logger.warn(
                deps.isMobile,
                'OWNER-RECOVERY',
                `[OWNER-RECOVERY] skipped | already recovered once for scope=${scopeKey}`
            )
        }
        return null
    }

    if (deps.bot?.logger && typeof deps.bot.logger.info === 'function') {
        deps.bot.logger.info(
            deps.isMobile,
            'OWNER-RECOVERY',
            `[OWNER-RECOVERY] start | recovering owner page for ${deps.isMobile ? 'mobile' : 'desktop'}`
        )
    }

    const oldPage = deps.oldPage
    if (oldPage && typeof oldPage.isClosed === 'function' && !oldPage.isClosed()) {
        try {
            await Promise.race([
                oldPage.evaluate(() => window.stop()).catch(() => {}),
                new Promise(resolve => setTimeout(resolve, 1000))
            ])
        } catch {}

        try {
            await oldPage.close({ runBeforeUnload: false }).catch(() => {})
        } catch {}
    }

    const context: BrowserContext | undefined = deps.isMobile
        ? deps.bot.mainMobilePage?.context?.() || deps.bot.browserFactory?.currentMobileContext || (oldPage && typeof oldPage.context === 'function' ? oldPage.context() : undefined)
        : deps.bot.mainDesktopPage?.context?.() || deps.bot.browserFactory?.currentDesktopContext || (oldPage && typeof oldPage.context === 'function' ? oldPage.context() : undefined)

    if (!context) {
        if (deps.bot?.logger && typeof deps.bot.logger.error === 'function') {
            deps.bot.logger.error(
                deps.isMobile,
                'OWNER-RECOVERY',
                `[OWNER-RECOVERY] failed | BrowserContext unavailable for replacement page`
            )
        }
        return null
    }

    const newPage = await createManagedPage({
        context,
        accountScope: deps.accountScope,
        purpose: deps.isMobile ? 'recovered-main-mobile' : 'recovered-main-desktop',
        isMobile: deps.isMobile
    })

    if (deps.isMobile) {
        deps.bot.mainMobilePage = newPage
    } else {
        deps.bot.mainDesktopPage = newPage
    }

    recoveryCountPerRun.set(scopeKey, currentCount + 1)

    const targetUrl = deps.bot.config?.baseURL || 'https://rewards.bing.com'
    await newPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})

    if (deps.bot?.logger && typeof deps.bot.logger.info === 'function') {
        deps.bot.logger.info(
            deps.isMobile,
            'OWNER-RECOVERY',
            `[OWNER-RECOVERY] completed | replacement owner page active at target`
        )
    }

    return newPage
}
