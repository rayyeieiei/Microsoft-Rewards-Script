import type { Cookie } from 'patchright'
import fs from 'fs'
import path from 'path'

import type { Account, ConfigSaveFingerprint } from '../interface/Account'
import type { Config } from '../interface/Config'
import { validateAccounts, validateConfig } from './Validator'
import { SessionPathResolver } from '../runtime/session/SessionPathResolver'


let configCache: Config
const rateLimitCooldowns = new Map<string, number>() // Penyimpanan cooldown sementara

export function setRateLimitCooldown(sessionPath: string, durationMs: number) {
    rateLimitCooldowns.set(sessionPath, Date.now() + durationMs)
}

export function getRateLimitCooldown(sessionPath: string): number {
    const expiry = rateLimitCooldowns.get(sessionPath) || 0
    return Math.max(0, expiry - Date.now())
}

export function loadAccounts(): Account[] {
    try {
        let file = 'accounts.json'
        if (process.argv.includes('-dev')) {
            const devFile1 = path.join(process.cwd(), 'accounts.dev.json')
            const devFile2 = path.join(process.cwd(), 'account.dev.json')
            if (fs.existsSync(devFile1)) {
                file = 'accounts.dev.json'
            } else if (fs.existsSync(devFile2)) {
                file = 'account.dev.json'
            }
        }
        // 🔥 FIX: Selalu baca dari folder root project
        const accountDir = path.join(process.cwd(), file)
        const accountsData = JSON.parse(fs.readFileSync(accountDir, 'utf-8'))
        validateAccounts(accountsData)
        return accountsData
    } catch (error) { throw new Error(error as string) }
}

export function loadConfig(forceReload = false): Config {
    try {
        if (configCache && !forceReload) return configCache
        // 🔥 FIX: Selalu baca dari folder root project
        const configDir = path.join(process.cwd(), 'config.json')
        const configData = JSON.parse(fs.readFileSync(configDir, 'utf-8'))
        const validated = validateConfig(configData)
        configCache = validated
        return validated
    } catch (error) { throw new Error(error as string) }
}

export async function loadSessionData(sessionPath: string, email: string, saveFingerprint: ConfigSaveFingerprint, isMobile: boolean) {
    try {
        const baseDir = SessionPathResolver.resolveBaseDir(sessionPath)
        const cookieFile = SessionPathResolver.getLegacyPath(baseDir, email, isMobile ? 'mobile' : 'desktop')
        let cookies: Cookie[] = []
        if (fs.existsSync(cookieFile)) {
            cookies = JSON.parse(await fs.promises.readFile(cookieFile, 'utf-8'))
        }
        const fingerprintFileName = isMobile ? 'session_fingerprint_mobile.json' : 'session_fingerprint_desktop.json'
        const fingerprintFile = path.join(path.dirname(cookieFile), fingerprintFileName)
        let fingerprint: any = null
        const shouldLoadFingerprint = isMobile ? saveFingerprint.mobile : saveFingerprint.desktop
        if (shouldLoadFingerprint && fs.existsSync(fingerprintFile)) {
            fingerprint = JSON.parse(await fs.promises.readFile(fingerprintFile, 'utf-8'))
        }
        return { cookies, fingerprint }
    } catch (error) { throw new Error(error as string) }
}

export async function saveSessionData(sessionPath: string, cookies: Cookie[], email: string, isMobile: boolean): Promise<string> {
    try {
        const baseDir = SessionPathResolver.resolveBaseDir(sessionPath)
        const targetPath = SessionPathResolver.getLegacyPath(baseDir, email, isMobile ? 'mobile' : 'desktop')
        const sessionDir = path.dirname(targetPath)
        if (!fs.existsSync(sessionDir)) await fs.promises.mkdir(sessionDir, { recursive: true })
        await fs.promises.writeFile(targetPath, JSON.stringify(cookies, null, 2), 'utf-8')
        return sessionDir
    } catch (error) { throw new Error(error as string) }
}

export async function saveFingerprintData(sessionPath: string, email: string, isMobile: boolean, fingerpint: any): Promise<string> {
    try {
        // 🔥 FIX: Amanin folder penyimpanan fingerprint
        const sessionDir = path.join(process.cwd(), 'browser', sessionPath, email)
        const fingerprintFileName = isMobile ? 'session_fingerprint_mobile.json' : 'session_fingerprint_desktop.json'
        if (!fs.existsSync(sessionDir)) await fs.promises.mkdir(sessionDir, { recursive: true })
        await fs.promises.writeFile(path.join(sessionDir, fingerprintFileName), JSON.stringify(fingerpint))
        return sessionDir
    } catch (error) { throw new Error(error as string) }
}
