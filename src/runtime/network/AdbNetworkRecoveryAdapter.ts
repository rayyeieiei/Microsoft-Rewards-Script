import { execFile } from 'child_process'
import type {
    NetworkRecoveryAdapter,
    AirplaneModeKnowledge,
    NetworkRecoveryPolicy
} from './NetworkRecoveryTypes'
import { DeviceLockManager } from './DeviceLockManager'

export type SubprocessRunner = (
    file: string,
    args: string[],
    options: { timeout: number; maxBuffer: number; signal?: AbortSignal }
) => Promise<{ stdout: string; stderr: string }>

const SERIAL_ALLOWLIST = /^[a-zA-Z0-9._:-]+$/

export interface AdbDeviceEntry {
    serial: string
    status: 'device' | 'unauthorized' | 'offline' | string
}

export type AdbPreflightStatus =
    | 'ready'
    | 'adb-unavailable'
    | 'device-not-found'
    | 'multiple-devices'
    | 'unauthorized'
    | 'offline'
    | 'timed-out'

export interface AdbPreflightResult {
    status: AdbPreflightStatus
    deviceCount: number
    serialConfigured: boolean
    error?: string
}

export interface AdbAdapterOptions {
    policy: NetworkRecoveryPolicy
    adbBinary?: string
    runner?: SubprocessRunner
    lockManager?: DeviceLockManager
}

export class AdbNetworkRecoveryAdapter implements NetworkRecoveryAdapter {
    public readonly mode = 'adb' as const
    public knowledge: AirplaneModeKnowledge = 'confirmed-disabled'
    private readonly policy: NetworkRecoveryPolicy
    private readonly adbBinary: string
    private readonly runner: SubprocessRunner
    private readonly lockManager: DeviceLockManager
    private resolvedSerial: string | null = null
    private activeSubprocessCount = 0

    constructor(options: AdbAdapterOptions) {
        this.policy = options.policy
        this.adbBinary = options.adbBinary || 'adb'
        this.runner = options.runner || AdbNetworkRecoveryAdapter.defaultRunner
        this.lockManager = options.lockManager || new DeviceLockManager()

        if (this.policy.adbSerial) {
            this.validateSerial(this.policy.adbSerial)
            this.resolvedSerial = this.policy.adbSerial.trim()
        }
    }

    private validateSerial(serial: string): void {
        if (!SERIAL_ALLOWLIST.test(serial.trim())) {
            throw new Error(`[ADB-SECURITY] adbSerial contains invalid characters: '${serial}'`)
        }
    }

    public static defaultRunner: SubprocessRunner = (file, args, options) => {
        return new Promise((resolve, reject) => {
            let settled = false
            const child = execFile(
                file,
                args,
                {
                    shell: false,
                    timeout: options.timeout,
                    maxBuffer: options.maxBuffer,
                    signal: options.signal
                },
                (error, stdout, stderr) => {
                    if (settled) return
                    settled = true
                    if (error) {
                        if ((error as any).killed || error.signal === 'SIGTERM') {
                            const timeoutErr = new Error(`Command timed out after ${options.timeout}ms`)
                            ;(timeoutErr as any).code = 'ETIMEDOUT'
                            return reject(timeoutErr)
                        }
                        return reject(error)
                    }
                    resolve({ stdout: stdout || '', stderr: stderr || '' })
                }
            )

            // Ensure child process terminates if abort signal fires
            if (options.signal) {
                const onAbort = () => {
                    if (!settled) {
                        settled = true
                        try {
                            child.kill('SIGTERM')
                        } catch {}
                        reject(new Error('Command cancelled by AbortSignal'))
                    }
                }
                options.signal.addEventListener('abort', onAbort, { once: true })
            }
        })
    }

    private async runAdb(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
        const fullArgs = this.resolvedSerial ? ['-s', this.resolvedSerial, ...args] : args
        this.activeSubprocessCount++
        try {
            return await this.runner(this.adbBinary, fullArgs, {
                timeout: this.policy.commandTimeoutMs,
                maxBuffer: 64 * 1024,
                signal
            })
        } finally {
            this.activeSubprocessCount--
        }
    }

    /**
     * Bounded, non-mutating preflight check for startup diagnostics.
     * Executes `adb version` and `adb devices -l` without toggling airplane mode
     * or acquiring exclusive device locks.
     */
    public async checkPreflightStatus(signal?: AbortSignal): Promise<AdbPreflightResult> {
        const serialConfigured = Boolean(this.policy.adbSerial && this.policy.adbSerial.trim().length > 0)
        const timeoutMs = this.policy.preflightTimeoutMs || this.policy.commandTimeoutMs
        let versionOut: { stdout: string; stderr: string }
        try {
            versionOut = await this.runner(this.adbBinary, ['version'], {
                timeout: timeoutMs,
                maxBuffer: 64 * 1024,
                signal
            })
        } catch (err: any) {
            const isTimeout = String(err?.message || '').toLowerCase().includes('timeout')
            return {
                status: isTimeout ? 'timed-out' : 'adb-unavailable',
                deviceCount: 0,
                serialConfigured,
                error: err?.message || String(err)
            }
        }

        if (!versionOut.stdout.includes('Android Debug Bridge')) {
            return {
                status: 'adb-unavailable',
                deviceCount: 0,
                serialConfigured,
                error: 'ADB executable did not return valid version string'
            }
        }

        let devicesOut: { stdout: string; stderr: string }
        try {
            devicesOut = await this.runner(this.adbBinary, ['devices', '-l'], {
                timeout: timeoutMs,
                maxBuffer: 64 * 1024,
                signal
            })
        } catch (err: any) {
            const isTimeout = String(err?.message || '').toLowerCase().includes('timeout')
            return {
                status: isTimeout ? 'timed-out' : 'adb-unavailable',
                deviceCount: 0,
                serialConfigured,
                error: err?.message || String(err)
            }
        }

        const devices = this.parseDevices(devicesOut.stdout)
        const deviceCount = devices.length

        if (deviceCount === 0) {
            return {
                status: 'device-not-found',
                deviceCount: 0,
                serialConfigured
            }
        }

        // Check unauthorized/offline
        for (const dev of devices) {
            if (dev.status === 'unauthorized') {
                return {
                    status: 'unauthorized',
                    deviceCount,
                    serialConfigured
                }
            }
            if (dev.status === 'offline') {
                return {
                    status: 'offline',
                    deviceCount,
                    serialConfigured
                }
            }
        }

        // Multi-device handling
        if (!serialConfigured) {
            if (deviceCount > 1) {
                return {
                    status: 'multiple-devices',
                    deviceCount,
                    serialConfigured
                }
            }
        } else {
            const configuredSerial = this.policy.adbSerial!.trim()
            const found = devices.find(d => d.serial === configuredSerial)
            if (!found) {
                return {
                    status: 'device-not-found',
                    deviceCount,
                    serialConfigured,
                    error: `Configured serial not found`
                }
            }
        }

        return {
            status: 'ready',
            deviceCount,
            serialConfigured
        }
    }

    /**
     * Preflight check: verifies adb presence, enumerates devices, validates authorization,
     * checks single device constraint, and acquires device file lock.
     */
    public async preflight(signal?: AbortSignal): Promise<void> {
        let versionOut: { stdout: string; stderr: string }
        try {
            versionOut = await this.runner(this.adbBinary, ['version'], {
                timeout: this.policy.commandTimeoutMs,
                maxBuffer: 64 * 1024,
                signal
            })
        } catch (err: any) {
            throw new Error(`ADB binary unavailable or failed preflight: ${err?.message || String(err)}`)
        }

        if (!versionOut.stdout.includes('Android Debug Bridge')) {
            throw new Error('ADB executable did not return valid version string')
        }

        // List connected devices
        const devicesOut = await this.runner(this.adbBinary, ['devices'], {
            timeout: this.policy.commandTimeoutMs,
            maxBuffer: 64 * 1024,
            signal
        })

        const devices = this.parseDevices(devicesOut.stdout)
        if (devices.length === 0) {
            throw new Error('Device not found: no ADB devices attached')
        }

        // Check unauthorized/offline
        for (const dev of devices) {
            if (dev.status === 'unauthorized') {
                throw new Error(`Device unauthorized: check phone screen for USB debugging authorization`)
            }
            if (dev.status === 'offline') {
                throw new Error(`Device offline: device connection is in offline state`)
            }
        }

        // Multi-device handling
        if (!this.resolvedSerial) {
            if (devices.length > 1) {
                throw new Error(
                    `Multiple devices attached (${devices.length}). Explicit adbSerial must be configured to prevent targeting wrong device.`
                )
            }
            this.resolvedSerial = devices[0]!.serial
        } else {
            const found = devices.find(d => d.serial === this.resolvedSerial)
            if (!found) {
                throw new Error(`Device not found: configured adbSerial '${this.resolvedSerial}' is not attached`)
            }
        }

        // Acquire exclusive device lock
        const locked = this.lockManager.acquire(this.resolvedSerial)
        if (!locked) {
            throw new Error('Device locked: another process currently holds an active lock for this device')
        }
    }

    public parseDevices(output: string): AdbDeviceEntry[] {
        const lines = output.split(/\r?\n/)
        const result: AdbDeviceEntry[] = []
        for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('List of devices')) continue
            const parts = trimmed.split(/\s+/)
            if (parts.length >= 2) {
                result.push({
                    serial: parts[0]!,
                    status: parts[1]!
                })
            }
        }
        return result
    }

    public async executeDisconnect(signal?: AbortSignal): Promise<void> {
        this.knowledge = 'possibly-enabled'
        try {
            await this.runAdb(['shell', 'cmd', 'connectivity', 'airplane-mode', 'enable'], signal)
            this.knowledge = 'confirmed-enabled'
        } catch (error) {
            // Fallback command
            try {
                await this.runAdb(['shell', 'settings', 'put', 'global', 'airplane_mode_on', '1'], signal)
                await this.runAdb(
                    ['shell', 'am', 'broadcast', '-a', 'android.intent.action.AIRPLANE_MODE', '--ez', 'state', 'true'],
                    signal
                )
                this.knowledge = 'confirmed-enabled'
            } catch {
                // Settle knowledge as possibly-enabled on failure
                throw error
            }
        }
    }

    public async executeReconnect(signal?: AbortSignal): Promise<void> {
        this.knowledge = 'possibly-enabled'
        try {
            await this.runAdb(['shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'], signal)
            this.knowledge = 'confirmed-disabled'
        } catch (error) {
            // Fallback command
            try {
                await this.runAdb(['shell', 'settings', 'put', 'global', 'airplane_mode_on', '0'], signal)
                await this.runAdb(
                    ['shell', 'am', 'broadcast', '-a', 'android.intent.action.AIRPLANE_MODE', '--ez', 'state', 'false'],
                    signal
                )
                this.knowledge = 'confirmed-disabled'
            } catch {
                throw error
            }
        }

        // Reassert USB tethering only if explicitly enabled in policy (Rule 8)
        if (this.policy.reassertUsbTethering) {
            try {
                await this.runAdb(['shell', 'cmd', 'tethering', 'tether', 'usb'], signal).catch(() => {})
                await this.runAdb(['shell', 'svc', 'usb', 'setFunctions', 'rndis'], signal).catch(() => {})
            } catch {}
        }
    }

    /**
     * Best-effort single bounded restoration attempt.
     */
    public async attemptRestoration(signal?: AbortSignal): Promise<boolean> {
        try {
            await this.runAdb(['shell', 'cmd', 'connectivity', 'airplane-mode', 'disable'], signal)
            this.knowledge = 'confirmed-disabled'
            return true
        } catch {
            try {
                await this.runAdb(['shell', 'settings', 'put', 'global', 'airplane_mode_on', '0'], signal)
                this.knowledge = 'confirmed-disabled'
                return true
            } catch {
                return false
            }
        }
    }

    public async dispose(): Promise<void> {
        // Invariant: Do not release device lock while any ADB subprocess is still running
        const deadline = Date.now() + (this.policy.commandTimeoutMs || 5000)
        while (this.activeSubprocessCount > 0 && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 25))
        }
        this.lockManager.release()
    }
}
