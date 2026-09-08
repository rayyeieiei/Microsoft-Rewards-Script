import type { UrlRewardActionSource } from './activities/ActivitySemantics'
import type { BasePromotion, PunchCard, DashboardData } from '../interface/DashboardData'

export interface ActionMetadataSummary {
    offerId: string
    source: UrlRewardActionSource
    requestTokenPresent: boolean
    actionDataPresent: boolean
}

export class ResolvedActionSecret {
    public readonly accountScopeId: string
    public readonly offerId: string
    public readonly requestToken?: string
    public readonly actionData?: unknown

    constructor(params: {
        accountScopeId: string
        offerId: string
        requestToken?: string
        actionData?: unknown
    }) {
        this.accountScopeId = params.accountScopeId
        this.offerId = params.offerId
        this.requestToken = params.requestToken
        this.actionData = params.actionData
    }

    public toJSON() {
        return {
            accountScopeId: this.accountScopeId,
            offerId: this.offerId,
            requestTokenPresent: Boolean(this.requestToken),
            actionDataPresent: Boolean(this.actionData)
        }
    }

    public toString(): string {
        return `[ResolvedActionSecret offerId=${this.offerId} scopeId=${this.accountScopeId}]`
    }
}

export interface ResolvedUrlRewardAction {
    summary: ActionMetadataSummary
    secret?: ResolvedActionSecret
}

export interface ResolveUrlRewardActionParams {
    parent?: PunchCard | BasePromotion
    child: BasePromotion
    dashboardData?: DashboardData
    scopeId: string
    requestToken?: string
    bootstrapActionMap?: Record<string, unknown>
}

/**
 * Pure resolver separating public semantic action summary from account-isolated secrets.
 * Resolution Priority:
 * 1. Child-promotion attributes/action data
 * 2. Bootstrap-action-map matching exact child offerId
 * 3. Fresh dashboard matching parent & child offerId
 * 4. None / no-mutation
 */
export function resolveUrlRewardAction(
    params: ResolveUrlRewardActionParams
): ResolvedUrlRewardAction | null {
    const { parent, child, dashboardData, scopeId, requestToken, bootstrapActionMap } = params
    if (!child || !child.offerId) {
        return null
    }

    const offerId = child.offerId
    const childAttr = (child.attributes || {}) as Record<string, unknown>

    // 1. Child-promotion explicit action data
    const childActionData = childAttr.actionData || (child as any).action || (child as any).hash
    if (childActionData) {
        return {
            summary: {
                offerId,
                source: 'child-promotion',
                requestTokenPresent: Boolean(requestToken),
                actionDataPresent: true
            },
            secret: new ResolvedActionSecret({
                accountScopeId: scopeId,
                offerId,
                requestToken,
                actionData: childActionData
            })
        }
    }

    // 2. Bootstrap action map matching exact child offerId
    if (bootstrapActionMap && bootstrapActionMap[offerId]) {
        return {
            summary: {
                offerId,
                source: 'bootstrap-action-map',
                requestTokenPresent: Boolean(requestToken),
                actionDataPresent: true
            },
            secret: new ResolvedActionSecret({
                accountScopeId: scopeId,
                offerId,
                requestToken,
                actionData: bootstrapActionMap[offerId]
            })
        }
    }

    // 3. Fresh dashboard data matching parent and child offerId
    if (dashboardData && dashboardData.punchCards) {
        for (const card of dashboardData.punchCards) {
            const parentOffer = (card.parentPromotion?.offerId || (card as any).offerId || '')
            const targetParentOffer = parent ? ((parent as any).offerId || (parent as any).parentPromotion?.offerId || '') : ''
            if (!targetParentOffer || parentOffer === targetParentOffer) {
                const foundChild = (card.childPromotions || []).find(c => c.offerId === offerId)
                if (foundChild) {
                    const foundAttr = (foundChild.attributes || {}) as unknown as Record<string, unknown>
                    const foundAction = foundAttr.actionData || (foundChild as any).action || (foundChild as any).hash
                    if (foundAction) {
                        return {
                            summary: {
                                offerId,
                                source: 'fresh-dashboard',
                                requestTokenPresent: Boolean(requestToken),
                                actionDataPresent: true
                            },
                            secret: new ResolvedActionSecret({
                                accountScopeId: scopeId,
                                offerId,
                                requestToken,
                                actionData: foundAction
                            })
                        }
                    }
                }
            }
        }
    }

    // 4. None / action data missing
    return {
        summary: {
            offerId,
            source: 'none',
            requestTokenPresent: Boolean(requestToken),
            actionDataPresent: false
        }
    }
}
