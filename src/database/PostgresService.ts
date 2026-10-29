import { Database, AccountErrorRecord, AccountSummaryRecord, ActivityHistoryRecord, SystemLogRecord } from '../util/Database'

export { AccountErrorRecord, AccountSummaryRecord, ActivityHistoryRecord, SystemLogRecord }

export class PostgresService {
    private static instance: PostgresService

    public static getInstance(): PostgresService {
        if (!PostgresService.instance) {
            PostgresService.instance = new PostgresService()
        }
        return PostgresService.instance
    }

    private get db(): Database {
        return Database.getInstance()
    }

    public async initialize(): Promise<void> {
        return this.db.initialize()
    }

    public getIsConnected(): boolean {
        return this.db.getIsConnected()
    }

    public async recordAccountError(record: AccountErrorRecord): Promise<void> {
        return this.db.recordAccountError(record)
    }

    public async upsertAccountSummary(acc: {
        email: string
        status?: string
        initialPoints?: number
        currentPoints?: number
        collectedPoints?: number
        desktopProgress?: string
        mobileProgress?: string
    }): Promise<void> {
        return this.db.upsertAccountSummary(acc)
    }

    public async recordActivity(email: string, activityType: string, pointsEarned: number): Promise<void> {
        return this.db.recordActivity(email, activityType, pointsEarned)
    }

    public async insertSystemLog(level: string, moduleName: string, message: string): Promise<void> {
        return this.db.insertSystemLog(level, moduleName, message)
    }

    public async fetchAccountsSummary(): Promise<any[]> {
        return this.db.fetchAccountsSummary()
    }

    public async fetchRecentLogs(limit?: number): Promise<any[]> {
        return this.db.fetchRecentLogs(limit)
    }

    public async close(): Promise<void> {
        return this.db.close()
    }
}
