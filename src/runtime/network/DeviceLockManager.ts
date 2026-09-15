import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

export interface DeviceLockInfo {
    pid: number
    createdAt: number
}

export class DeviceLockManager {
    private readonly lockDir: string
    private currentLockPath: string | null = null

    constructor(customLockDir?: string) {
        this.lockDir = customLockDir || path.join(process.cwd(), '.device_locks')
    }

    /**
     * Hashes the device serial using SHA-256 (32 hex characters).
     * Never places raw serial into the filesystem path.
     */
    public static getLockKey(serial: string): string {
        return crypto.createHash('sha256').update(serial.trim()).digest('hex').slice(0, 32)
    }

    /**
     * Attempts to acquire an exclusive lock file for the given device serial.
     * Includes bounded stale-PID recovery if the previous holder died.
     */
    public acquire(serial: string): boolean {
        if (!fs.existsSync(this.lockDir)) {
            try {
                fs.mkdirSync(this.lockDir, { recursive: true })
            } catch {}
        }

        const lockKey = DeviceLockManager.getLockKey(serial)
        const lockPath = path.join(this.lockDir, `${lockKey}.lock`)

        // Check existing lock file
        if (fs.existsSync(lockPath)) {
            try {
                const content = fs.readFileSync(lockPath, 'utf-8')
                const info: DeviceLockInfo = JSON.parse(content)

                // Stale-PID check
                const isAlive = this.isProcessAlive(info.pid)
                if (isAlive) {
                    return false // Actively held by a live process
                }

                // If dead PID, safe to reclaim
                try {
                    fs.unlinkSync(lockPath)
                } catch {}
            } catch {
                // If corrupted lock file, remove it
                try {
                    fs.unlinkSync(lockPath)
                } catch {}
            }
        }

        try {
            const info: DeviceLockInfo = {
                pid: process.pid,
                createdAt: Date.now()
            }
            // Use 'wx' flag for atomic exclusive creation
            const fd = fs.openSync(lockPath, 'wx')
            try {
                fs.writeSync(fd, JSON.stringify(info), undefined, 'utf-8')
            } finally {
                fs.closeSync(fd)
            }
            this.currentLockPath = lockPath
            return true
        } catch {
            return false
        }
    }

    /**
     * Releases the acquired lock file.
     */
    public release(): void {
        if (this.currentLockPath && fs.existsSync(this.currentLockPath)) {
            try {
                fs.unlinkSync(this.currentLockPath)
            } catch {}
            this.currentLockPath = null
        }
    }

    public isProcessAlive(pid: number): boolean {
        try {
            process.kill(pid, 0)
            return true
        } catch (err: any) {
            return err.code === 'EPERM' // Exists but no permission -> alive
        }
    }
}
