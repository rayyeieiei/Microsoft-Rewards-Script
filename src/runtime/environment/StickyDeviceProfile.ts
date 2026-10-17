import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { SessionPathResolver } from '../session/SessionPathResolver'
import type { ScreenProfile } from './BrowserEnvironmentTypes'

export interface RealDeviceDefinition {
    id: string
    brand: string
    model: string
    screen: ScreenProfile
    userAgent: string
    platform?: string
    platformVersion?: string
    deviceModel?: string
}

export interface StickyDeviceProfileData {
    accountId: string
    storageKey: string
    device: RealDeviceDefinition
    createdAt: string
}

export const REAL_DEVICE_CATALOG: RealDeviceDefinition[] = [
    {
        id: 'samsung-galaxy-s23',
        brand: 'Samsung',
        model: 'Galaxy S23',
        deviceModel: 'SM-S911B',
        platform: 'Android',
        platformVersion: '14.0.0',
        screen: {
            viewport: { width: 360, height: 780 },
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true
        },
        userAgent:
            'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 EdgA/128.0.2708.57'
    },
    {
        id: 'google-pixel-7',
        brand: 'Google',
        model: 'Pixel 7',
        deviceModel: 'Pixel 7',
        platform: 'Android',
        platformVersion: '14.0.0',
        screen: {
            viewport: { width: 412, height: 915 },
            deviceScaleFactor: 2.625,
            isMobile: true,
            hasTouch: true
        },
        userAgent:
            'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 EdgA/128.0.2708.57'
    },
    {
        id: 'xiaomi-13',
        brand: 'Xiaomi',
        model: 'Xiaomi 13',
        deviceModel: '2211133G',
        platform: 'Android',
        platformVersion: '13.0.0',
        screen: {
            viewport: { width: 393, height: 851 },
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true
        },
        userAgent:
            'Mozilla/5.0 (Linux; Android 13; 2211133G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 EdgA/128.0.2708.57'
    },
    {
        id: 'oneplus-11',
        brand: 'OnePlus',
        model: 'OnePlus 11',
        deviceModel: 'CPH2449',
        platform: 'Android',
        platformVersion: '14.0.0',
        screen: {
            viewport: { width: 412, height: 919 },
            deviceScaleFactor: 3.5,
            isMobile: true,
            hasTouch: true
        },
        userAgent:
            'Mozilla/5.0 (Linux; Android 14; CPH2449) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 EdgA/128.0.2708.57'
    }
]

export class StickyDeviceProfile {
    /**
     * Deterministically selects a real device profile from the catalog based on sha256(accountId).
     */
    public static generateDeterministicProfile(accountId: string): StickyDeviceProfileData {
        if (!accountId || typeof accountId !== 'string') {
            throw new Error('Invalid accountId: must be a non-empty string')
        }
        const storageKey = SessionPathResolver.getStorageKey(accountId)
        const hash = crypto.createHash('sha256').update(accountId.toLowerCase().trim()).digest('hex')
        const index = parseInt(hash.slice(0, 8), 16) % REAL_DEVICE_CATALOG.length
        const selectedDevice = (REAL_DEVICE_CATALOG[index] || REAL_DEVICE_CATALOG[0]) as RealDeviceDefinition

        return {
            accountId,
            storageKey,
            device: selectedDevice,
            createdAt: new Date().toISOString()
        }
    }

    /**
     * Resolves the POSIX path to the device profile file in sessions directory using SessionPathResolver.
     */
    public static getProfilePath(sessionDir: string, accountId: string): string {
        return SessionPathResolver.getDeviceProfilePath(sessionDir, accountId)
    }

    /**
     * Resolves (loads existing or generates and persists) sticky device profile for an accountId asynchronously.
     */
    public static async resolveDeviceProfile(
        sessionDir: string,
        accountId: string
    ): Promise<StickyDeviceProfileData> {
        const filePath = StickyDeviceProfile.getProfilePath(sessionDir, accountId)
        try {
            if (fs.existsSync(filePath)) {
                const raw = await fs.promises.readFile(filePath, 'utf-8')
                const parsed = JSON.parse(raw)
                if (parsed && parsed.device && parsed.storageKey && parsed.device.screen) {
                    return parsed
                }
            }
        } catch {
            // Recover from corrupt or partial read
        }

        const profile = StickyDeviceProfile.generateDeterministicProfile(accountId)
        try {
            const dir = path.dirname(filePath)
            if (!fs.existsSync(dir)) {
                await fs.promises.mkdir(dir, { recursive: true })
            }
            await fs.promises.writeFile(filePath, JSON.stringify(profile, null, 2), 'utf-8')
        } catch {}
        return profile
    }

    /**
     * Synchronous variant for initialization or test cases.
     */
    public static resolveDeviceProfileSync(
        sessionDir: string,
        accountId: string
    ): StickyDeviceProfileData {
        const filePath = StickyDeviceProfile.getProfilePath(sessionDir, accountId)
        try {
            if (fs.existsSync(filePath)) {
                const raw = fs.readFileSync(filePath, 'utf-8')
                const parsed = JSON.parse(raw)
                if (parsed && parsed.device && parsed.storageKey && parsed.device.screen) {
                    return parsed
                }
            }
        } catch {}

        const profile = StickyDeviceProfile.generateDeterministicProfile(accountId)
        try {
            const dir = path.dirname(filePath)
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true })
            }
            fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), 'utf-8')
        } catch {}
        return profile
    }
}
