import { Pool } from 'pg'
import { loadConfig } from './Load'

export interface AccountSummaryRecord {
    email: string
    status: string
    initial_points: number
    current_points: number
    total_gained: number
    desktop_progress: string
    mobile_progress: string
    last_run_time: Date
    is_active: boolean
    updated_at: Date
}

export interface ActivityHistoryRecord {
    id: number
    email: string
    activity_type: string
    points_earned: number
    timestamp: Date
}

export interface SystemLogRecord {
    id: number
    timestamp: Date
    level: string
    module: string
    message: string
}

export class Database {
    private static instance: Database
    private pool: Pool | null = null
    private isConnected = false

    private constructor() {}

    public static getInstance(): Database {
        if (!Database.instance) {
            Database.instance = new Database()
        }
        return Database.instance
    }

    public async initialize(): Promise<void> {
        try {
            const config = loadConfig()
            if (!config.usePostgres) {
                return
            }

            const pgConf = config.postgresConfig
            if (pgConf?.connectionString && pgConf.connectionString.trim() !== '') {
                this.pool = new Pool({
                    connectionString: pgConf.connectionString,
                    max: pgConf.maxConnections || 10
                })
            } else {
                this.pool = new Pool({
                    host: pgConf?.host || 'localhost',
                    port: pgConf?.port || 5432,
                    user: pgConf?.user || 'postgres',
                    password: pgConf?.password || 'yourpassword',
                    database: pgConf?.database || 'rewards_db',
                    max: pgConf?.maxConnections || 10,
                    idleTimeoutMillis: 30000,
                    connectionTimeoutMillis: 5000
                })
            }

            // Test connection
            const client = await this.pool.connect()
            this.isConnected = true
            client.release()

            // Run DDL Migrations
            await this.runMigrations()
        } catch (error) {
            this.isConnected = false
            const errMsg = error instanceof Error ? error.message : String(error)
            console.warn(`[DATABASE-WARN] Failed to connect to PostgreSQL. Falling back to in-memory mode: ${errMsg}`)
        }
    }

    private async runMigrations(): Promise<void> {
        if (!this.pool || !this.isConnected) return

        const ddlAccountsSummary = `
            CREATE TABLE IF NOT EXISTS accounts_summary (
                email VARCHAR(255) PRIMARY KEY,
                status VARCHAR(100) NOT NULL DEFAULT 'Pending',
                initial_points INT NOT NULL DEFAULT 0,
                current_points INT NOT NULL DEFAULT 0,
                total_gained INT NOT NULL DEFAULT 0,
                desktop_progress VARCHAR(50) DEFAULT '0/0',
                mobile_progress VARCHAR(50) DEFAULT '0/0',
                last_run_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                is_active BOOLEAN NOT NULL DEFAULT true,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `

        const ddlActivityHistory = `
            CREATE TABLE IF NOT EXISTS activity_history (
                id BIGSERIAL PRIMARY KEY,
                email VARCHAR(255) NOT NULL,
                activity_type VARCHAR(100) NOT NULL,
                points_earned INT NOT NULL DEFAULT 0,
                timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_activity_email_time ON activity_history(email, timestamp DESC);
        `

        const ddlSystemLogs = `
            CREATE TABLE IF NOT EXISTS system_logs (
                id BIGSERIAL PRIMARY KEY,
                timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                level VARCHAR(20) NOT NULL,
                module VARCHAR(100) NOT NULL,
                message TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_system_logs_level_time ON system_logs(level, timestamp DESC);
        `

        try {
            await this.pool.query(ddlAccountsSummary)
            await this.pool.query(ddlActivityHistory)
            await this.pool.query(ddlSystemLogs)
        } catch (err) {
            console.error('[DATABASE-ERROR] Failed executing DDL migrations:', err)
        }
    }

    public getIsConnected(): boolean {
        return this.isConnected
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
        if (!this.pool || !this.isConnected) return

        const query = `
            INSERT INTO accounts_summary (email, status, initial_points, current_points, total_gained, desktop_progress, mobile_progress, last_run_time, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
            ON CONFLICT (email) DO UPDATE SET
                status = COALESCE($2, accounts_summary.status),
                initial_points = CASE WHEN $3 > 0 THEN $3 ELSE accounts_summary.initial_points END,
                current_points = CASE WHEN $4 > 0 THEN $4 ELSE accounts_summary.current_points END,
                total_gained = CASE WHEN $5 > 0 THEN $5 ELSE accounts_summary.total_gained END,
                desktop_progress = COALESCE($6, accounts_summary.desktop_progress),
                mobile_progress = COALESCE($7, accounts_summary.mobile_progress),
                last_run_time = NOW(),
                updated_at = NOW();
        `

        try {
            await this.pool.query(query, [
                acc.email,
                acc.status || 'Pending',
                acc.initialPoints || 0,
                acc.currentPoints || 0,
                acc.collectedPoints || 0,
                acc.desktopProgress || '0/0',
                acc.mobileProgress || '0/0'
            ])
        } catch (err) {
            console.error(`[DATABASE-ERROR] Failed to upsert account ${acc.email}:`, err)
        }
    }

    public async recordActivity(email: string, activityType: string, pointsEarned: number): Promise<void> {
        if (!this.pool || !this.isConnected) return

        const query = `
            INSERT INTO activity_history (email, activity_type, points_earned, timestamp)
            VALUES ($1, $2, $3, NOW());
        `

        try {
            await this.pool.query(query, [email, activityType, pointsEarned])
        } catch (err) {
            console.error(`[DATABASE-ERROR] Failed to record activity for ${email}:`, err)
        }
    }

    public async insertSystemLog(level: string, moduleName: string, message: string): Promise<void> {
        if (!this.pool || !this.isConnected) return

        const query = `
            INSERT INTO system_logs (level, module, message, timestamp)
            VALUES ($1, $2, $3, NOW());
        `

        try {
            await this.pool.query(query, [level.toUpperCase(), moduleName, message])
        } catch {
            // Avoid recursive logging error
        }
    }

    public async fetchAccountsSummary(): Promise<any[]> {
        if (!this.pool || !this.isConnected) return []

        const query = `
            SELECT email, status, initial_points as "initialPoints", current_points as "currentPoints", total_gained as "collectedPoints", desktop_progress as "desktopProgress", mobile_progress as "mobileProgress", last_run_time as "lastUpdate"
            FROM accounts_summary
            ORDER BY email ASC;
        `

        try {
            const res = await this.pool.query(query)
            return res.rows
        } catch (err) {
            console.error('[DATABASE-ERROR] Failed to fetch accounts summary:', err)
            return []
        }
    }

    public async fetchRecentLogs(limit = 100): Promise<any[]> {
        if (!this.pool || !this.isConnected) return []

        const query = `
            SELECT id, timestamp, level, module, message
            FROM system_logs
            ORDER BY timestamp DESC
            LIMIT $1;
        `

        try {
            const res = await this.pool.query(query, [limit])
            return res.rows
        } catch (err) {
            console.error('[DATABASE-ERROR] Failed to fetch recent logs:', err)
            return []
        }
    }

    public async close(): Promise<void> {
        if (this.pool) {
            await this.pool.end()
            this.isConnected = false
        }
    }
}
