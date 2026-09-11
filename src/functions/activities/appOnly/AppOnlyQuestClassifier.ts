import { AppOnlyQuest } from './AppOnlyTypes'
import { redactAccountKey } from '../../../util/Redaction'

export interface AppOnlyClassificationInput {
    accountId?: string
    displayAccount?: string
    accountKey?: string
    offerId: string
    title?: string
    description?: string
    destinationUrl?: string
    expectedPoints?: number
    complete?: boolean | string
    isLocked?: boolean | string
    isDisabled?: boolean | string
    availableFrom?: string
    expiresAt?: string
    attributes?: Record<string, unknown>
    exclusiveLockedFeature?: unknown
    exclusiveLockedFeatureStatus?: unknown
    exclusiveLockedFeatureCategory?: unknown
    promotionType?: string
    promotionSubtype?: string
    pointProgress?: number
    pointProgressMax?: number
}

export class AppOnlyQuestClassifier {
    /**
     * Pure functional classification without network requests or external side-effects.
     */
    public classify(input: AppOnlyClassificationInput, now = new Date()): AppOnlyQuest {
        const accountId = input.accountId || (input.accountKey ? redactAccountKey(input.accountKey) : 'anonymous')
        const displayAccount = input.displayAccount || redactAccountKey(input.accountKey || 'anonymous')
        const offerId = (input.offerId || '').trim()
        const title = (input.title || '').trim()
        const expectedPoints = Number(input.expectedPoints ?? input.pointProgressMax ?? 10)
        const observedAt = now.toISOString()

        const isComplete =
            this.normalizeBoolean(input.complete) ||
            (typeof input.pointProgress === 'number' &&
                typeof input.pointProgressMax === 'number' &&
                input.pointProgressMax > 0 &&
                input.pointProgress >= input.pointProgressMax)

        // 1. Prioritas 1: Completed
        if (isComplete) {
            return {
                accountId,
                displayAccount,
                offerId,
                title,
                expectedPoints,
                destinationUrl: input.destinationUrl,
                expiresAt: input.expiresAt,
                complete: true,
                locked: false,
                lockReason: 'completed',
                confidence: 'high',
                observedAt
            }
        }

        // 2. Prioritas 2: Future-dated (availableFrom > now)
        if (input.availableFrom) {
            const availDate = new Date(input.availableFrom)
            if (!isNaN(availDate.getTime()) && availDate.getTime() > now.getTime()) {
                return {
                    accountId,
                displayAccount,
                    offerId,
                    title,
                    expectedPoints,
                    destinationUrl: input.destinationUrl,
                    expiresAt: input.expiresAt,
                    complete: false,
                    locked: true,
                    lockReason: 'future-dated',
                    confidence: 'high',
                    observedAt
                }
            }
        }

        // 3. Prioritas 3: Cooldown
        const isCooldown = this.detectCooldown(input)
        if (isCooldown) {
            return {
                accountId,
                displayAccount,
                offerId,
                title,
                expectedPoints,
                destinationUrl: input.destinationUrl,
                expiresAt: input.expiresAt,
                complete: false,
                locked: true,
                lockReason: 'cooldown',
                confidence: 'high',
                observedAt
            }
        }

        // 4. Prioritas 4: Explicit Structured Metadata (High Confidence App-Only)
        const hasExplicitAppCategory = this.hasExplicitAppOnlyCategory(input)
        const isLockedAttr = this.isMarkedLocked(input)

        if (hasExplicitAppCategory) {
            return {
                accountId,
                displayAccount,
                offerId,
                title,
                expectedPoints,
                destinationUrl: input.destinationUrl,
                expiresAt: input.expiresAt,
                complete: false,
                locked: true,
                lockReason: 'app-only',
                confidence: 'high',
                observedAt
            }
        }

        // 5. Prioritas 5: Localized Text Pattern fallback (Medium Confidence App-Only)
        const hasAppOnlyText = this.hasAppOnlyTitlePattern(title, input.description)
        if (hasAppOnlyText) {
            return {
                accountId,
                displayAccount,
                offerId,
                title,
                expectedPoints,
                destinationUrl: input.destinationUrl,
                expiresAt: input.expiresAt,
                complete: false,
                locked: true,
                lockReason: 'app-only',
                confidence: 'medium',
                observedAt
            }
        }

        // 6. Prioritas 6: Secondary indicators (rnoreward=1)
        const hasRnoRewardParam = this.hasRnoReward(input.destinationUrl)
        if (hasRnoRewardParam && isLockedAttr) {
            // rnoreward alone does not prove app-only, but with locked attribute it indicates restricted reward
            return {
                accountId,
                displayAccount,
                offerId,
                title,
                expectedPoints,
                destinationUrl: input.destinationUrl,
                expiresAt: input.expiresAt,
                complete: false,
                locked: true,
                lockReason: 'app-only',
                confidence: 'low',
                observedAt
            }
        }

        // 7. Prioritas 7: Generic Locked (Unknown reason)
        if (isLockedAttr) {
            return {
                accountId,
                displayAccount,
                offerId,
                title,
                expectedPoints,
                destinationUrl: input.destinationUrl,
                expiresAt: input.expiresAt,
                complete: false,
                locked: true,
                lockReason: 'unknown',
                confidence: 'low',
                observedAt
            }
        }

        // Normal unlocked / pending task
        return {
            accountId,
            displayAccount,
            offerId,
            title,
            expectedPoints,
            destinationUrl: input.destinationUrl,
            expiresAt: input.expiresAt,
            complete: false,
            locked: false,
            lockReason: 'unknown',
            confidence: 'low',
            observedAt
        }
    }

    private normalizeBoolean(val: unknown): boolean {
        if (typeof val === 'boolean') return val
        if (typeof val === 'string') {
            const lower = val.trim().toLowerCase()
            return lower === 'true' || lower === '1' || lower === 'complete' || lower === 'completed'
        }
        if (typeof val === 'number') return val === 1
        return false
    }

    private isMarkedLocked(input: AppOnlyClassificationInput): boolean {
        if (this.normalizeBoolean(input.isLocked)) return true
        if (this.normalizeBoolean(input.isDisabled)) return true

        const statusStr = String(input.exclusiveLockedFeatureStatus ?? '')
            .trim()
            .toLowerCase()
        if (statusStr === 'locked') return true

        const attr = input.attributes
        if (attr) {
            if (this.normalizeBoolean(attr.isLocked)) return true
            if (this.normalizeBoolean(attr.isDisabled)) return true
            const isUnlockedStr = String(attr.is_unlocked ?? '')
                .trim()
                .toLowerCase()
            if (isUnlockedStr === 'false' || isUnlockedStr === '0') return true
            const exclusiveStatus = String(attr.exclusiveLockedFeatureStatus ?? '')
                .trim()
                .toLowerCase()
            if (exclusiveStatus === 'locked') return true
        }

        return false
    }

    private hasExplicitAppOnlyCategory(input: AppOnlyClassificationInput): boolean {
        const cat = String(input.exclusiveLockedFeatureCategory ?? '')
            .trim()
            .toLowerCase()
        const feat = String(input.exclusiveLockedFeature ?? '')
            .trim()
            .toLowerCase()
        if (cat === 'rewardsapp' || feat === 'rewardsapp') return true

        const attr = input.attributes
        if (attr) {
            const attrCat = String(attr.exclusiveLockedFeatureCategory ?? '')
                .trim()
                .toLowerCase()
            const criteria = String(attr.locked_category_criteria ?? '')
                .trim()
                .toLowerCase()
            if (attrCat === 'rewardsapp' || criteria === 'rewardsapp') return true
        }

        return false
    }

    private hasAppOnlyTitlePattern(title?: string, description?: string): boolean {
        const target = `${title || ''} ${description || ''}`.toLowerCase()
        return (
            target.includes('(rewards app only)') ||
            target.includes('rewards app only') ||
            target.includes('rewards-app-only') ||
            target.includes('bing app only') ||
            target.includes('start app only')
        )
    }

    private hasRnoReward(url?: string): boolean {
        if (!url) return false
        return /[?&]rnoreward=1(&|$)/i.test(url)
    }

    private detectCooldown(input: AppOnlyClassificationInput): boolean {
        const attr = input.attributes
        if (attr) {
            if (this.normalizeBoolean(attr.is_cooldown) || this.normalizeBoolean(attr.cooldown)) {
                return true
            }
            if (typeof attr.cooldown_end_time === 'string' && attr.cooldown_end_time.trim().length > 0) {
                return true
            }
        }
        const subType = String(input.promotionSubtype || '').toLowerCase()
        if (subType.includes('cooldown')) return true
        return false
    }
}
