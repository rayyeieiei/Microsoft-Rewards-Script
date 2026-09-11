import { DashboardData, PunchCard } from '../../interface/DashboardData'
import { SanitizedDestination } from '../../runtime/manual/ManualQuestTypes'
import {
    OnboardingConfidence,
    OnboardingEvidence,
    OnboardingHandling,
    OnboardingState,
    OnboardingTask,
    OnboardingTaskKind
} from './NewAccountOnboardingTypes'

function sanitizeDestinationUrl(urlStr?: string): SanitizedDestination | undefined {
    if (!urlStr || typeof urlStr !== 'string') return undefined
    try {
        const parsed = new URL(urlStr)
        return {
            scheme: parsed.protocol.replace(':', ''),
            origin: parsed.origin,
            path: parsed.pathname
        }
    } catch {
        return undefined
    }
}

/**
 * Pure deterministic detector for one-time new account onboarding campaigns.
 * Traverses strictly proven collections from DashboardData schema:
 * - morePromotions
 * - morePromotionsWithoutPromotionalItems
 * - promotionalItems
 * - promotionalItem
 * - punchCards (parent + children)
 *
 * Guaranteed zero Date.now() / hidden clock dependencies.
 */
export function detectOnboarding(
    data: DashboardData | null | undefined,
    nowMs: number
): OnboardingEvidence {
    if (!data || typeof data !== 'object') {
        return {
            state: 'not-detected',
            confidence: 'low',
            detectedOfferIds: [],
            incompleteCount: 0,
            completedCount: 0,
            evidence: [],
            tasks: []
        }
    }

    // Traverse ONLY proven collections
    const rawPromotions: any[] = [
        ...(data.morePromotions ?? []),
        ...(data.morePromotionsWithoutPromotionalItems ?? []),
        ...(data.promotionalItems ?? []),
        ...(data.promotionalItem ? [data.promotionalItem] : [])
    ]

    const punchCards: PunchCard[] = data.punchCards ?? []
    const punchCardParents: any[] = punchCards.map(pc => pc.parentPromotion).filter(Boolean)
    const punchCardChildren: any[] = punchCards.flatMap(pc => pc.childPromotions ?? []).filter(Boolean)

    const allCandidates = [
        ...rawPromotions,
        ...punchCardParents,
        ...punchCardChildren
    ]

    // Deduplicate candidates by offerId
    const candidates = Array.from(
        new Map(
            allCandidates
                .filter(p => Boolean(p && (p.offerId || p.title)))
                .map(p => [p.offerId || p.title, p] as const)
        ).values()
    )

    const detectedTasks: OnboardingTask[] = []
    const evidenceTags: string[] = []
    let hasStructuredCampaign = false
    let parentOfferId: string | undefined

    for (const promo of candidates) {
        const offerId = String(promo.offerId || '').trim()
        const offerIdLower = offerId.toLowerCase()
        const title = String(promo.title || '').trim()
        const titleLower = title.toLowerCase()
        const promoTypeLower = String(promo.promotionType || '').toLowerCase()
        const categoryLower = String(promo.attributes?.category || '').toLowerCase()
        const scTitle = String(promo.attributes?.sc_title || '').toLowerCase()

        // 1. Check for Structured Metadata (Strong Evidence)
        const isStructured =
            promoTypeLower === 'onboarding' ||
            promoTypeLower === 'welcometour' ||
            categoryLower === 'onboarding' ||
            categoryLower === 'welcometour' ||
            offerIdLower.includes('fre_offer') ||
            offerIdLower.includes('welcometour') ||
            offerIdLower.includes('newaccount_onboarding')

        // 2. Check for Title Indicators (Fallback / Medium Evidence)
        const isGoalTitle =
            titleLower.includes('set a rewards goal') ||
            titleLower.includes('set a goal') ||
            titleLower.includes('tetapkan sasaran') ||
            titleLower.includes('pilih hadiah') ||
            scTitle.includes('set a goal')

        const isDailySetTitle =
            titleLower.includes('finish a daily set') ||
            titleLower.includes('complete daily set') ||
            titleLower.includes('selesaikan rangkaian harian') ||
            titleLower.includes('daily set')

        const isEarnPageTitle =
            titleLower.includes('browse the earn page') ||
            titleLower.includes('earn page') ||
            titleLower.includes('jelajahi halaman peroleh') ||
            titleLower.includes('halaman peroleh')

        const isProgressTracker =
            titleLower.includes('your progress') ||
            titleLower.includes('kemajuan anda') ||
            titleLower.includes('onboarding progress')

        const matchesTitle = isGoalTitle || isDailySetTitle || isEarnPageTitle || isProgressTracker

        if (!isStructured && !matchesTitle) {
            continue
        }

        if (isStructured) {
            hasStructuredCampaign = true
            evidenceTags.push(`structured:${offerId || promoTypeLower}`)
            if (offerIdLower.includes('parent') || offerIdLower.includes('fre_offer')) {
                parentOfferId = offerId
            }
        } else if (matchesTitle) {
            evidenceTags.push(`title-pattern:${title.slice(0, 20)}`)
        }

        // Classify Task Kind and Handling
        let taskKind: OnboardingTaskKind = 'unknown'
        let handling: OnboardingHandling = 'unsupported'

        if (isGoalTitle || offerIdLower.includes('goal')) {
            taskKind = 'account-choice'
            handling = 'manual-required'
        } else if (isDailySetTitle || offerIdLower.includes('dailyset')) {
            taskKind = 'daily-set-dependent'
            handling = 'delegated-to-existing-worker'
        } else if (isEarnPageTitle || offerIdLower.includes('earnpage')) {
            taskKind = 'official-navigation'
            handling = 'manual-required'
        } else if (isProgressTracker || offerIdLower.includes('progress')) {
            taskKind = 'progress-container'
            handling = 'passive-only'
        }

        const complete =
            promo.complete === true ||
            String(promo.complete).toLowerCase() === 'true' ||
            (typeof promo.pointProgress === 'number' &&
                typeof promo.pointProgressMax === 'number' &&
                promo.pointProgressMax > 0 &&
                promo.pointProgress >= promo.pointProgressMax)

        if (complete && handling === 'delegated-to-existing-worker') {
            handling = 'already-complete'
        }

        const advertisedPoints = Number(
            promo.pointProgressMax ?? promo.attributes?.pointProgressMax ?? promo.attributes?.points ?? 0
        )

        detectedTasks.push({
            offerId,
            parentOfferId,
            title,
            description: promo.description,
            taskKind,
            handling,
            complete,
            isLocked: Boolean(promo.isLocked),
            advertisedPoints, // Preserved as advertised by server, never forced to zero
            pointProgress: promo.pointProgress,
            pointProgressMax: promo.pointProgressMax,
            expiresAt: promo.attributes?.expiresAt || promo.attributes?.endDate,
            destination: sanitizeDestinationUrl(promo.destinationUrl || promo.attributes?.destination)
        })
    }

    if (detectedTasks.length === 0) {
        return {
            state: 'not-detected',
            confidence: 'low',
            detectedOfferIds: [],
            incompleteCount: 0,
            completedCount: 0,
            evidence: [],
            tasks: []
        }
    }

    const completedCount = detectedTasks.filter(t => t.complete).length
    const incompleteCount = detectedTasks.length - completedCount
    const state: OnboardingState = incompleteCount === 0 ? 'completed' : 'active'

    // High confidence requires structured metadata; title-only is at most medium confidence
    const confidence: OnboardingConfidence = hasStructuredCampaign ? 'high' : 'medium'

    return {
        state,
        confidence,
        detectedOfferIds: detectedTasks.map(t => t.offerId),
        incompleteCount,
        completedCount,
        evidence: Array.from(new Set(evidenceTags)),
        tasks: detectedTasks,
        parentOfferId
    }
}
