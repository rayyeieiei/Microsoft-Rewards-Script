import { DeviceRecoveryLock } from './DeviceRecoveryLock'

export interface DeviceLockInfo {
    pid: number
    createdAt: number
}

export class DeviceLockManager {
    private readonly lock: DeviceRecoveryLock

    constructor(customLockDir?: string) {
        this.lock = new DeviceRecoveryLock(customLockDir)
    }

    /**
     * Hashes the device serial using SHA-256 (32 hex characters).
     * Never places raw serial into the filesystem path.
     */
    public static getLockKey(serial: string): string {
        return DeviceRecoveryLock.getLockKey(serial)
    }

    /**
     * Attempts to acquire an exclusive lock file for the given device serial.
     * Includes bounded stale-PID recovery if the previous holder died.
     */
    public acquire(serial: string): boolean {
        const res = this.lock.acquire(serial)
        return res.success
    }

    /**
     * Releases the acquired lock file.
     */
    public release(): void {
        this.lock.release()
    }

    public isProcessAlive(pid: number): boolean {
        return this.lock.isProcessAlive(pid)
    }
}
