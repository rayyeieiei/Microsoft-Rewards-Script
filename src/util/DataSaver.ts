import type { DataSaverCategory, DataSaverBudgetResult } from '../functions/activities/ActivitySemantics'
import { evaluateDataSaverBudget } from '../functions/activities/ActivitySemantics'

export interface CategoryStats {
    bytes: number
    requests: number
}

export interface AccountQuotaReport {
    accountKey: string
    consumedBytes: number
    budgetBytes: number
    budgetResult: DataSaverBudgetResult
    breakdown: Record<DataSaverCategory, CategoryStats>
    blockedRequests: number
}

function createEmptyBreakdown(): Record<DataSaverCategory, CategoryStats> {
    return {
        document: { bytes: 0, requests: 0 },
        script: { bytes: 0, requests: 0 },
        'xhr/fetch': { bytes: 0, requests: 0 },
        image: { bytes: 0, requests: 0 },
        media: { bytes: 0, requests: 0 },
        font: { bytes: 0, requests: 0 },
        other: { bytes: 0, requests: 0 }
    }
}

export function mapResourceTypeToCategory(resourceType: string): DataSaverCategory {
    const r = (resourceType || '').toLowerCase()
    if (r === 'document') return 'document'
    if (r === 'script') return 'script'
    if (r === 'xhr' || r === 'fetch') return 'xhr/fetch'
    if (r === 'image') return 'image'
    if (r === 'media') return 'media'
    if (r === 'font') return 'font'
    return 'other'
}

export class DataSaverManager {
    private static instance: DataSaverManager
    private currentAccountKey: string | null = null
    private accounts = new Map<
        string,
        {
            totalBytes: number
            blockedRequests: number
            breakdown: Record<DataSaverCategory, CategoryStats>
        }
    >()

    public static getInstance(): DataSaverManager {
        if (!DataSaverManager.instance) {
            DataSaverManager.instance = new DataSaverManager()
        }
        return DataSaverManager.instance
    }

    public beginAccountQuota(accountKey: string): void {
        this.currentAccountKey = accountKey
        if (!this.accounts.has(accountKey)) {
            this.accounts.set(accountKey, {
                totalBytes: 0,
                blockedRequests: 0,
                breakdown: createEmptyBreakdown()
            })
        }
    }

    public recordTransferredResource(
        category: DataSaverCategory,
        bytes: number,
        accountKey?: string
    ): void {
        const targetAccount = accountKey || this.currentAccountKey
        if (!targetAccount) return

        let accData = this.accounts.get(targetAccount)
        if (!accData) {
            accData = {
                totalBytes: 0,
                blockedRequests: 0,
                breakdown: createEmptyBreakdown()
            }
            this.accounts.set(targetAccount, accData)
        }

        if (bytes > 0) {
            accData.totalBytes += bytes
            accData.breakdown[category].bytes += bytes
        }
        accData.breakdown[category].requests += 1
    }

    public recordBlockedRequest(accountKey?: string): void {
        const targetAccount = accountKey || this.currentAccountKey
        if (!targetAccount) return

        let accData = this.accounts.get(targetAccount)
        if (!accData) {
            accData = {
                totalBytes: 0,
                blockedRequests: 0,
                breakdown: createEmptyBreakdown()
            }
            this.accounts.set(targetAccount, accData)
        }
        accData.blockedRequests += 1
    }

    public finishAccountQuota(accountKey: string, budgetBytes: number = 20 * 1024 * 1024): AccountQuotaReport {
        const accData = this.accounts.get(accountKey) || {
            totalBytes: 0,
            blockedRequests: 0,
            breakdown: createEmptyBreakdown()
        }

        const budgetResult = evaluateDataSaverBudget(accData.totalBytes, budgetBytes)

        return {
            accountKey,
            consumedBytes: accData.totalBytes,
            budgetBytes,
            budgetResult,
            breakdown: accData.breakdown,
            blockedRequests: accData.blockedRequests
        }
    }

    public resetAccountQuota(accountKey: string): void {
        this.accounts.delete(accountKey)
        if (this.currentAccountKey === accountKey) {
            this.currentAccountKey = null
        }
    }

    public resetAll(): void {
        this.accounts.clear()
        this.currentAccountKey = null
    }

    public getAccountStats(accountKey: string) {
        return (
            this.accounts.get(accountKey) || {
                totalBytes: 0,
                blockedRequests: 0,
                breakdown: createEmptyBreakdown()
            }
        )
    }
}
