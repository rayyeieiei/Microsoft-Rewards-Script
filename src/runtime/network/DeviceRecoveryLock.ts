import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

export interface DeviceLockMetadata {
    pid: number
    ownerToken: string
    acquiredAt: number
}

export type DeviceRecoveryLockStatus = 'acquired' | 'device-busy'

export interface DeviceRecoveryLockAcquireResult {
    success: boolean
    status: DeviceRecoveryLockStatus
    release: () => void
    ownerToken?: string
}

export class DeviceRecoveryLock {
    private readonly lockDir: string
    private activeLockPath: string | null = null
    private activeOwnerToken: string | null = null
    private cleanupHandlerAttached = false

    constructor(customLockDir?: string) {
        this.lockDir = customLockDir || path.join(process.cwd(), '.device_locks')
    }

    /**
     * Computes hashed lock key without exposing raw device serial in filesystem.
     * Uses 'global-adb-recovery' if deviceIdentity is not yet specified.
     */
    public static getLockKey(deviceIdentity?: string): string {
        if (!deviceIdentity || deviceIdentity.trim().length === 0) {
            return 'global-adb-recovery'
        }
        return crypto.createHash('sha256').update(deviceIdentity.trim()).digest('hex').slice(0, 32)
    }

    /**
     * Atomically acquires an exclusive lock file.
     * Never steals lock from an active process regardless of TTL.
     * Reclaims stale lock only when the recorded owner PID is confirmed dead.
     */
    public acquire(deviceIdentity?: string): DeviceRecoveryLockAcquireResult {
        if (!fs.existsSync(this.lockDir)) {
            try {
                fs.mkdirSync(this.lockDir, { recursive: true })
            } catch {}
        }

        const lockKey = DeviceRecoveryLock.getLockKey(deviceIdentity)
        const lockPath = path.join(this.lockDir, `${lockKey}.lock`)

        // Inspect existing lock
        if (fs.existsSync(lockPath)) {
            try {
                const content = fs.readFileSync(lockPath, 'utf-8')
                const metadata: Partial<DeviceLockMetadata> = JSON.parse(content)
                const pid = metadata.pid
                const isAlive = typeof pid === 'number' && this.isProcessAlive(pid)

                if (isAlive && pid !== process.pid) {
                    // Contender cannot steal lock from active owner regardless of elapsed time/TTL
                    return {
                        success: false,
                        status: 'device-busy',
                        release: () => {}
                    }
                }

                // Stale PID recovery: safe to unlink only if process is confirmed dead
                if (!isAlive) {
                    try {
                        fs.unlinkSync(lockPath)
                    } catch {}
                }
            } catch {
                // If corrupted content, safe to unlink
                try {
                    fs.unlinkSync(lockPath)
                } catch {}
            }
        }

        try {
            const ownerToken = crypto.randomUUID()
            const metadata: DeviceLockMetadata = {
                pid: process.pid,
                ownerToken,
                acquiredAt: Date.now()
            }
            // Exclusive atomic file creation
            const fd = fs.openSync(lockPath, 'wx')
            try {
                fs.writeSync(fd, JSON.stringify(metadata), undefined, 'utf-8')
            } finally {
                fs.closeSync(fd)
            }

            this.activeLockPath = lockPath
            this.activeOwnerToken = ownerToken
            this.attachExitCleanup()

            const release = () => {
                this.releasePath(lockPath, ownerToken)
            }

            return {
                success: true,
                status: 'acquired',
                release,
                ownerToken
            }
        } catch {
            return {
                success: false,
                status: 'device-busy',
                release: () => {}
            }
        }
    }

    public release(): void {
        if (this.activeLockPath) {
            this.releasePath(this.activeLockPath, this.activeOwnerToken || undefined)
            this.activeLockPath = null
            this.activeOwnerToken = null
        }
    }

    private releasePath(targetPath: string, expectedOwnerToken?: string): void {
        try {
            if (fs.existsSync(targetPath)) {
                const content = fs.readFileSync(targetPath, 'utf-8')
                const metadata: Partial<DeviceLockMetadata> = JSON.parse(content)
                // Only unlink if this process owns the lock AND ownerToken matches if specified
                const pidMatches = metadata.pid === process.pid
                const tokenMatches =
                    !expectedOwnerToken || !metadata.ownerToken || metadata.ownerToken === expectedOwnerToken
                if (pidMatches && tokenMatches) {
                    fs.unlinkSync(targetPath)
                }
            }
        } catch {}
        if (this.activeLockPath === targetPath) {
            this.activeLockPath = null
            this.activeOwnerToken = null
        }
    }

    public isProcessAlive(pid: number): boolean {
        if (!pid || pid <= 0) return false
        try {
            process.kill(pid, 0)
            return true
        } catch (err: any) {
            return err.code === 'EPERM'
        }
    }

    private attachExitCleanup(): void {
        if (this.cleanupHandlerAttached) return
        this.cleanupHandlerAttached = true
        const cleanup = () => {
            this.release()
        }
        process.on('exit', cleanup)
        process.on('SIGINT', cleanup)
        process.on('SIGTERM', cleanup)
    }
}
