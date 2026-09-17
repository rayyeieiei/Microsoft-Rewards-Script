import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

export interface DeviceLockMetadata {
    pid: number
    acquiredAt: number
}

export type DeviceRecoveryLockStatus = 'acquired' | 'device-busy'

export interface DeviceRecoveryLockAcquireResult {
    success: boolean
    status: DeviceRecoveryLockStatus
    release: () => void
}

export class DeviceRecoveryLock {
    private readonly lockDir: string
    private activeLockPath: string | null = null
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
                const metadata: DeviceLockMetadata = JSON.parse(content)
                const isAlive = this.isProcessAlive(metadata.pid)

                if (isAlive && metadata.pid !== process.pid) {
                    return {
                        success: false,
                        status: 'device-busy',
                        release: () => {}
                    }
                }

                // Stale PID recovery: safe to unlink if process is confirmed dead
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
            const metadata: DeviceLockMetadata = {
                pid: process.pid,
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
            this.attachExitCleanup()

            const release = () => {
                this.releasePath(lockPath)
            }

            return {
                success: true,
                status: 'acquired',
                release
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
            this.releasePath(this.activeLockPath)
            this.activeLockPath = null
        }
    }

    private releasePath(targetPath: string): void {
        try {
            if (fs.existsSync(targetPath)) {
                const content = fs.readFileSync(targetPath, 'utf-8')
                const metadata: DeviceLockMetadata = JSON.parse(content)
                // Only unlink if this process owns the lock
                if (metadata.pid === process.pid) {
                    fs.unlinkSync(targetPath)
                }
            }
        } catch {}
        if (this.activeLockPath === targetPath) {
            this.activeLockPath = null
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
