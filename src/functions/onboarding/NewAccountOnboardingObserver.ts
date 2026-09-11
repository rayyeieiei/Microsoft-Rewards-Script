import { AccountIdentity } from '../../runtime/identity/AccountIdentity'
import { ManualQuestQueue } from '../../runtime/manual/ManualQuestQueue'
import { ManualQuestRecord } from '../../runtime/manual/ManualQuestTypes'
import { OnboardingEvidence } from './NewAccountOnboardingTypes'

export interface OnboardingObserverOptions {
    queue: ManualQuestQueue
    mode?: 'disabled' | 'observe-only' | 'observe-and-handoff'
    logger?: {
        info: (msg: string) => void
        warn: (msg: string) => void
        debug: (msg: string) => void
    }
}

export class NewAccountOnboardingObserver {
    private queue: ManualQuestQueue
    private mode: 'disabled' | 'observe-only' | 'observe-and-handoff'
    private logger?: OnboardingObserverOptions['logger']

    constructor(options: OnboardingObserverOptions) {
        this.queue = options.queue
        this.mode = options.mode || 'observe-only'
        this.logger = options.logger
    }

    public async observe(evidence: OnboardingEvidence, identity: AccountIdentity, nowMs = Date.now()): Promise<void> {
        if (this.mode === 'disabled' || evidence.state === 'not-detected') {
            return
        }

        const nowIso = new Date(nowMs).toISOString()

        // 1. Detection Log
        this.logger?.info?.(
            `[ONBOARDING-DETECT] state=${evidence.state} confidence=${evidence.confidence} tasks=${evidence.tasks.length} evidence=${evidence.evidence.join(',') || 'none'}`
        )

        let manualCount = 0
        let verifiedCount = 0
        let passiveCount = 0
        let unsupportedCount = 0

        for (const task of evidence.tasks) {
            // 2. Task Classification Log
            this.logger?.info?.(
                `[ONBOARDING-TASK] offerId=${task.offerId} kind=${task.taskKind} handling=${task.handling} complete=${task.complete}`
            )

            if (task.complete) {
                verifiedCount++
            } else if (task.handling === 'manual-required') {
                manualCount++
            } else if (task.handling === 'passive-only') {
                passiveCount++
            } else {
                unsupportedCount++
            }

            // Enqueue Policy:
            // - observe-only: never queues
            // - medium-confidence (title-only): never queues
            // - high-confidence (structured) AND observe-and-handoff AND manual-required: enqueues
            const shouldEnqueue =
                this.mode === 'observe-and-handoff' &&
                evidence.confidence === 'high' &&
                task.handling === 'manual-required' &&
                !task.complete

            if (shouldEnqueue) {
                const record: ManualQuestRecord = {
                    accountId: identity.accountId,
                    displayAccount: identity.displayAccount,
                    questKind: 'new-account-onboarding',
                    offerId: task.offerId,
                    title: task.title,
                    expectedPoints: task.advertisedPoints,
                    destination: task.destination,
                    expiresAt: task.expiresAt,
                    complete: false,
                    locked: task.isLocked,
                    lockReason: 'onboarding-manual',
                    confidence: evidence.confidence,
                    state: 'manual-required',
                    observedAt: nowIso,
                    queuedAt: nowIso
                }
                await this.queue.enqueue(record)
            }
        }

        // 3. Summary Log
        this.logger?.info?.(
            `[ONBOARDING] total=${evidence.tasks.length} verified=${verifiedCount} manualRequired=${manualCount} passive=${passiveCount} unsupported=${unsupportedCount}`
        )
    }
}
