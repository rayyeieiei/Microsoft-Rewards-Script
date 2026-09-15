import { z } from 'zod'
import semver from 'semver'
import pkg from '../../package.json'

import { Config } from '../interface/Config'
import { Account } from '../interface/Account'

const NumberOrString = z.union([z.number(), z.string()])

const LogFilterSchema = z.object({
    enabled: z.boolean(),
    mode: z.enum(['whitelist', 'blacklist']),
    levels: z.array(z.enum(['debug', 'info', 'warn', 'error'])).optional(),
    keywords: z.array(z.string()).optional(),
    regexPatterns: z.array(z.string()).optional()
})

const DelaySchema = z.object({
    min: NumberOrString,
    max: NumberOrString
})

const QueryEngineSchema = z.enum(['google', 'wikipedia', 'reddit', 'local'])

// Webhook
const WebhookSchema = z.object({
    discord: z
        .object({
            enabled: z.boolean(),
            url: z.string()
        })
        .optional(),
    ntfy: z
        .object({
            enabled: z.boolean().optional(),
            url: z.string(),
            topic: z.string().optional(),
            token: z.string().optional(),
            title: z.string().optional(),
            tags: z.array(z.string()).optional(),
            priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional()
        })
        .optional(),
    webhookLogFilter: LogFilterSchema
})

// App-Only Policy Schema
export const AppOnlyPolicySchema = z.enum(['skip', 'notify', 'manual-handoff'])

export const AppOnlyConfigSchema = z.object({
    enabled: z.boolean(),
    defaultPolicy: AppOnlyPolicySchema,
    cacheTtlHours: z.number().positive()
})

// Punch Card Execution Schema
export const PunchCardExecutionModeSchema = z.enum(['observer', 'manual-handoff', 'browser-ui-experimental'])

export const PunchCardExecutionConfigSchema = z.object({
    mode: PunchCardExecutionModeSchema.default('manual-handoff'),
    maxChildrenPerRun: z.number().int().positive().default(1)
})

// New Account Onboarding Schema
export const NewAccountOnboardingModeSchema = z.enum(['disabled', 'observe-only', 'observe-and-handoff'])

export const NewAccountOnboardingConfigSchema = z.object({
    enabled: z.boolean(),
    mode: NewAccountOnboardingModeSchema.default('observe-only'),
    retentionDays: z.number().int().positive().default(14)
})

export const IdentityPolicySchema = z
    .object({
        enforcementMode: z.enum(['report-only', 'block-invalid'])
    })
    .optional()

// Config
export const ConfigSchema = z.object({
    baseURL: z.string(),
    sessionPath: z.string(),
    headless: z.boolean(),
    useDynamicWifiProxy: z.boolean().optional(),
    useLocalDashboard: z.boolean().optional(),
    useAdbIpRotation: z.boolean().optional(),
    useGhostCursor: z.boolean().optional(),
    usePostgres: z.boolean().optional(),
    identityPolicy: IdentityPolicySchema,
    postgresConfig: z
        .object({
            host: z.string().optional(),
            port: z.number().optional(),
            user: z.string().optional(),
            password: z.string().optional(),
            database: z.string().optional(),
            connectionString: z.string().optional(),
            maxConnections: z.number().optional()
        })
        .optional(),
    clusters: z.number().int().nonnegative(),
    errorDiagnostics: z.boolean(),
    workers: z.object({
        doDailySet: z.boolean(),
        doSpecialPromotions: z.boolean(),
        doMorePromotions: z.boolean(),
        doPunchCards: z.boolean(),
        doAppPromotions: z.boolean(),
        doAppOnlyRewards: z.boolean().optional(),
        doWindowsAppRewards: z.boolean().optional(),
        doDesktopSearch: z.boolean(),
        doMobileSearch: z.boolean(),
        doDailyCheckIn: z.boolean(),
        doReadToEarn: z.boolean()
    }),
    appOnlyRewards: AppOnlyConfigSchema.optional(),
    punchCardExecution: PunchCardExecutionConfigSchema.optional().default({
        mode: 'manual-handoff',
        maxChildrenPerRun: 1
    }),
    newAccountOnboarding: NewAccountOnboardingConfigSchema.optional().default({
        enabled: true,
        mode: 'observe-only',
        retentionDays: 14
    }),
    loginRateLimit: z
        .object({
            delay: NumberOrString,
            maxAttempts: z.number().int().positive()
        })
        .optional(),
    searchOnBingLocalQueries: z.boolean(),
    globalTimeout: NumberOrString,
    searchSettings: z.object({
        scrollRandomResults: z.boolean(),
        clickRandomResults: z.boolean(),
        parallelSearching: z.boolean(),
        organicSearch: z
            .object({
                enabled: z.boolean(),
                ctrRate: z.number().optional(),
                dwellTimeMin: NumberOrString.optional(),
                dwellTimeMax: NumberOrString.optional(),
                maxScrollDepth: z.number().optional(),
                enableTopicalChaining: z.boolean().optional(),
                maxChainDepth: z.number().optional(),
                openInNewTab: z.boolean().optional()
            })
            .optional(),
        queryEngines: z.array(QueryEngineSchema),
        searchResultVisitTime: NumberOrString,
        searchDelay: DelaySchema,
        readDelay: DelaySchema
    }),
    debugLogs: z.boolean(),
    proxy: z.object({ queryEngine: z.boolean() }),
    consoleLogFilter: LogFilterSchema,
    webhook: WebhookSchema
})

// Account
export const AccountSchema = z.object({
    id: z.string().optional(),
    participantId: z.string().optional(),
    householdId: z.string().optional(),
    enabled: z.boolean().optional(),
    email: z.string(),
    password: z.string(),
    totpSecret: z.string().optional(),
    recoveryEmail: z.string(),
    geoLocale: z.string(),
    langCode: z.string(),
    proxy: z.object({
        proxyAxios: z.boolean(),
        url: z.string(),
        port: z.number(),
        password: z.string(),
        username: z.string()
    }),
    saveFingerprint: z.object({
        mobile: z.boolean(),
        desktop: z.boolean()
    }),
    appOnlyPolicy: AppOnlyPolicySchema.optional()
})

export function validateConfig(data: unknown): Config {
    return ConfigSchema.parse(data) as Config
}

export function validateAccounts(data: unknown): Account[] {
    return z.array(AccountSchema).parse(data)
}

export function checkNodeVersion(): void {
    try {
        const requiredVersion = pkg.engines?.node

        if (!requiredVersion) {
            console.warn('No Node.js version requirement found in package.json "engines" field.')
            return
        }

        if (!semver.satisfies(process.version, requiredVersion)) {
            console.error(`Current Node.js version ${process.version} does not satisfy requirement: ${requiredVersion}`)
            process.exit(1)
        }
    } catch (error) {
        console.error('Failed to validate Node.js version:', error)
        process.exit(1)
    }
}
