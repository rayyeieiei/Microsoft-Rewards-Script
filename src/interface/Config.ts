import { AppOnlyPolicy } from '../functions/activities/appOnly/AppOnlyTypes'

export type NumberOrString = number | string

export interface AppOnlyConfig {
    enabled: boolean
    defaultPolicy: AppOnlyPolicy
    cacheTtlHours: number
}

export type PunchCardExecutionMode = 'observer' | 'manual-handoff' | 'browser-ui-experimental'

export interface PunchCardExecutionConfig {
    mode: PunchCardExecutionMode
    maxChildrenPerRun: number
}

export type NewAccountOnboardingMode = 'disabled' | 'observe-only' | 'observe-and-handoff'

export interface NewAccountOnboardingConfig {
    enabled: boolean
    mode: NewAccountOnboardingMode
    retentionDays: number
}

export interface Config {
    baseURL: string
    sessionPath: string
    headless: boolean
    useDynamicWifiProxy?: boolean
    useLocalDashboard?: boolean
    useAdbIpRotation?: boolean
    useGhostCursor?: boolean
    usePostgres?: boolean
    postgresConfig?: PostgresConfig
    clusters: number
    errorDiagnostics: boolean
    workers: ConfigWorkers
    appOnlyRewards?: AppOnlyConfig
    punchCardExecution?: PunchCardExecutionConfig
    newAccountOnboarding?: NewAccountOnboardingConfig
    searchOnBingLocalQueries: boolean
    globalTimeout: number | string
    searchSettings: ConfigSearchSettings
    debugLogs: boolean
    proxy: ConfigProxy
    consoleLogFilter: LogFilter
    webhook: ConfigWebhook
    loginRateLimit?: {
        delay: NumberOrString
        maxAttempts: number
    }
}

export type QueryEngine = 'google' | 'wikipedia' | 'reddit' | 'local'

export interface OrganicSearchSettings {
    enabled: boolean
    ctrRate?: number
    dwellTimeMin?: number | string
    dwellTimeMax?: number | string
    maxScrollDepth?: number
    enableTopicalChaining?: boolean
    maxChainDepth?: number
    openInNewTab?: boolean
}

export interface ConfigSearchSettings {
    scrollRandomResults: boolean
    clickRandomResults: boolean
    parallelSearching: boolean
    organicSearch?: OrganicSearchSettings
    queryEngines: QueryEngine[]
    searchResultVisitTime: number | string
    searchDelay: ConfigDelay
    readDelay: ConfigDelay
}

export interface ConfigDelay {
    min: number | string
    max: number | string
}

export interface ConfigProxy {
    queryEngine: boolean
}

export interface ConfigWorkers {
    doDailySet: boolean
    doSpecialPromotions: boolean
    doMorePromotions: boolean
    doPunchCards: boolean
    doAppPromotions: boolean
    doAppOnlyRewards?: boolean
    doWindowsAppRewards?: boolean
    doDesktopSearch: boolean
    doMobileSearch: boolean
    doDailyCheckIn: boolean
    doReadToEarn: boolean
}

// Webhooks
export interface ConfigWebhook {
    discord?: WebhookDiscordConfig
    ntfy?: WebhookNtfyConfig
    webhookLogFilter: LogFilter
}

export interface LogFilter {
    enabled: boolean
    mode: 'whitelist' | 'blacklist'
    levels?: Array<'debug' | 'info' | 'warn' | 'error'>
    keywords?: string[]
    regexPatterns?: string[]
}

export interface WebhookDiscordConfig {
    enabled: boolean
    url: string
}

export interface WebhookNtfyConfig {
    enabled?: boolean
    url: string
    topic?: string
    token?: string
    title?: string
    tags?: string[]
    priority?: 1 | 2 | 3 | 4 | 5 // 5 highest (important)
}

export interface PostgresConfig {
    host?: string
    port?: number
    user?: string
    password?: string
    database?: string
    connectionString?: string
    maxConnections?: number
}
