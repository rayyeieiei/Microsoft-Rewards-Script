import type { Account } from '../../interface/Account'
import type { MicrosoftRewardsBot } from '../../index'

export type BrowserContextKind = 'mobile' | 'desktop'

export interface ScreenProfile {
    viewport: { width: number; height: number }
    deviceScaleFactor?: number
    isMobile: boolean
    hasTouch: boolean
}

export interface BrowserEnvironmentProfile {
    schemaVersion: 1
    profileId: string
    source: 'browser-default' | 'project-config'
    contextKind: BrowserContextKind
    screen?: ScreenProfile
    locale?: string
    timezoneId?: string
    colorScheme?: 'light' | 'dark' | 'no-preference'
}

export interface EnvironmentValidationResult {
    valid: boolean
    errors: string[]
    warnings: string[]
}

export interface BrowserEnvironmentConfig {
    mobile?: Partial<ScreenProfile>
    desktop?: Partial<ScreenProfile>
    locale?: string
    timezoneId?: string
    colorScheme?: 'light' | 'dark' | 'no-preference'
}

export interface AccountScopeCreateOptions {
    account: Account
    bot: MicrosoftRewardsBot
    runId: string
    envConfig?: BrowserEnvironmentConfig
}

export interface StorageStatePaths {
    storageKey: string
    sessionDir: string
    mobilePath: string
    desktopPath: string
}
