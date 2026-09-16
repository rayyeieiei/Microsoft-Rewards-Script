import path from 'path'
import crypto from 'crypto'
import fs from 'fs'
import type { SessionDevice } from './AccountSessionTypes'

export class SessionPathResolver {
    /**
     * Resolves the base session directory.
     * If customSessionPath is absolute (e.g. test fixture), resolves directly.
     * Otherwise resolves relative to process.cwd()/browser/<customSessionPath || 'sessions'>.
     */
    public static resolveBaseDir(customSessionPath?: string): string {
        if (customSessionPath && path.isAbsolute(customSessionPath)) {
            return path.resolve(customSessionPath)
        }
        const folder = customSessionPath || 'sessions'
        return path.resolve(process.cwd(), 'browser', folder)
    }

    /**
     * Strict containment verification using path.relative (never startsWith alone).
     * Rejects:
     * - Null bytes
     * - Empty relative path (target is base dir itself)
     * - Escaping parent segments ('..')
     * - Sibling-directory prefix collisions (e.g. base: '/app/sessions', target: '/app/sessions-other/file')
     * - Absolute relative paths
     * - Symlinks/junctions escaping base directory
     */
    public static assertContained(baseDir: string, targetPath: string): void {
        if (typeof targetPath !== 'string' || typeof baseDir !== 'string') {
            throw new Error('Path containment violation: path arguments must be strings')
        }
        if (targetPath.includes('\0') || baseDir.includes('\0')) {
            throw new Error('Path containment violation: null byte detected in path')
        }

        const resolvedBase = path.resolve(baseDir)
        const resolvedTarget = path.resolve(targetPath)

        const rel = path.relative(resolvedBase, resolvedTarget)
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error('Path containment violation: path escapes session directory')
        }

        // Additional segment-level check: ensure no '..' segment exists in relative path
        const segments = rel.split(path.sep)
        if (segments.includes('..')) {
            throw new Error('Path containment violation: path traversal detected')
        }

        // Canonical symlink check if target exists
        if (fs.existsSync(resolvedTarget)) {
            try {
                const canonicalTarget = fs.realpathSync(resolvedTarget)
                const canonicalBase = fs.existsSync(resolvedBase)
                    ? fs.realpathSync(resolvedBase)
                    : resolvedBase
                const canonicalRel = path.relative(canonicalBase, canonicalTarget)
                if (
                    canonicalRel === '' ||
                    canonicalRel.startsWith('..') ||
                    path.isAbsolute(canonicalRel) ||
                    canonicalRel.split(path.sep).includes('..')
                ) {
                    throw new Error('Path containment violation: symlink target escapes session directory')
                }
            } catch (err: any) {
                if (err.message?.includes('Path containment violation')) throw err
            }
        }
    }

    /**
     * Derives stable storageKey hex from accountId.
     * Validates hex characters to prevent any traversal injection.
     */
    public static getStorageKey(accountId: string): string {
        if (!accountId || typeof accountId !== 'string') {
            throw new Error('Invalid accountId: must be a non-empty string')
        }
        return crypto.createHash('sha256').update(accountId).digest('hex').slice(0, 32)
    }

    /**
     * Resolves modern envelope storageState file path.
     */
    public static getModernPath(
        sessionDir: string,
        accountId: string,
        device: SessionDevice
    ): string {
        const storageKey = this.getStorageKey(accountId)
        const fileName = `${storageKey}.${device}.storageState.json`
        const targetPath = path.resolve(sessionDir, fileName)
        this.assertContained(sessionDir, targetPath)
        return targetPath
    }

    /**
     * Resolves previous raw storageState file path.
     * In this runtime, previous raw storageState was written to the same device-specific path.
     */
    public static getPreviousRawPath(
        sessionDir: string,
        accountId: string,
        device: SessionDevice
    ): string {
        return this.getModernPath(sessionDir, accountId, device)
    }

    /**
     * Resolves legacy cookie JSON path according to original Load.ts conventions.
     * Sanitizes email path input and strictly enforces base containment.
     */
    public static getLegacyPath(
        sessionDir: string,
        email: string,
        device: SessionDevice
    ): string {
        if (!email || typeof email !== 'string') {
            throw new Error('Invalid legacy email parameter')
        }
        const fileName = device === 'mobile' ? 'session_mobile.json' : 'session_desktop.json'
        const targetPath = path.resolve(sessionDir, email, fileName)
        this.assertContained(sessionDir, targetPath)
        return targetPath
    }

    /**
     * Resolves quarantine directory path.
     */
    public static getQuarantineDir(sessionDir: string): string {
        const quarantineDir = path.resolve(sessionDir, 'quarantine')
        this.assertContained(sessionDir, quarantineDir)
        return quarantineDir
    }

    /**
     * Resolves quarantine backup path for corrupted session data.
     */
    public static getQuarantinePath(
        sessionDir: string,
        accountId: string,
        device: SessionDevice,
        timestamp: number
    ): string {
        const storageKey = this.getStorageKey(accountId)
        const fileName = `${storageKey}.${device}.${timestamp}.corrupt.json`
        const targetPath = path.resolve(sessionDir, 'quarantine', fileName)
        this.assertContained(sessionDir, targetPath)
        return targetPath
    }

    /**
     * Resolves persistent quarantine marker path for an account and device.
     */
    public static getQuarantineMarkerPath(
        sessionDir: string,
        accountId: string,
        device: SessionDevice
    ): string {
        const storageKey = this.getStorageKey(accountId)
        const fileName = `${storageKey}.${device}.marker.json`
        const targetPath = path.resolve(sessionDir, 'quarantine', fileName)
        this.assertContained(sessionDir, targetPath)
        return targetPath
    }

    /**
     * Resolves cross-process lockfile path for an account and device.
     */
    public static getLockfilePath(
        sessionDir: string,
        accountId: string,
        device: SessionDevice
    ): string {
        const storageKey = this.getStorageKey(accountId)
        const fileName = `${storageKey}.${device}.lock`
        const targetPath = path.resolve(sessionDir, fileName)
        this.assertContained(sessionDir, targetPath)
        return targetPath
    }
}
