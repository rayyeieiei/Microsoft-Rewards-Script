import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import type { AccountScope } from '../AccountScope'
import {
    SessionDevice,
    StoredSessionEnvelope,
    SessionLoadResult,
    SessionSaveResult,
    PlaywrightStorageState,
    SUPPORTED_SCHEMA_VERSION,
    MAX_SESSION_FILE_SIZE_BYTES,
    isValidStorageState
} from './AccountSessionTypes'
import { SessionPathResolver } from './SessionPathResolver'

export class AccountSessionStore {
    /**
     * In-process per-target-path mutex queue.
     * Guarantees serialized writes for any individual session file in this process.
     * Queue self-heals: subsequent writes continue even if a preceding write fails.
     */
    private static readonly fileLocks = new Map<string, Promise<void>>()

    /**
     * Loads a persisted session for an account scope and device.
     * Strict 3-tier loading order:
     * 1. Persistent quarantine marker check: if present, immediately reports 'corrupted' and refuses fallback.
     * 2. Primary target file:
     *    - If valid schemaVersion 1 modern envelope -> 'loaded' with source 'modern-envelope'.
     *    - If valid raw Playwright storageState without schemaVersion -> 'loaded' with source 'previous-storage-state'.
     *    - If invalid/corrupted -> quarantines file, writes persistent marker, and reports 'corrupted'.
     *    - If unsupported schemaVersion -> reports 'unsupported-version'.
     *    - If accountId or device mismatch -> reports 'identity-mismatch'.
     * 3. Legacy cookie JSON (only if modern/raw absent and no corruption marker exists):
     *    - Reads legacy file without deleting or modifying it -> 'loaded' with source 'legacy-cookie-json'.
     * 4. Missing: all sources absent -> 'missing'.
     */
    public static async loadSession(
        scope: AccountScope,
        device: SessionDevice,
        options?: { legacyEmail?: string }
    ): Promise<SessionLoadResult> {
        const sessionDir = scope.storagePaths.sessionDir
        const accountId = scope.identity.accountId
        const primaryPath = SessionPathResolver.getModernPath(sessionDir, accountId, device)
        const markerPath = SessionPathResolver.getQuarantineMarkerPath(sessionDir, accountId, device)

        // Tier 1: Check persistent quarantine marker
        if (fs.existsSync(markerPath)) {
            try {
                const markerRaw = await fs.promises.readFile(markerPath, 'utf-8')
                const marker = JSON.parse(markerRaw)
                return {
                    status: 'corrupted',
                    reason: marker.reason || 'Session previously quarantined due to corruption',
                    path: markerPath
                }
            } catch {
                return {
                    status: 'corrupted',
                    reason: 'Session previously quarantined (marker unparseable)',
                    path: markerPath
                }
            }
        }

        // Tier 2: Inspect primary file (Modern envelope or previous raw storageState)
        if (fs.existsSync(primaryPath)) {
            try {
                const stat = await fs.promises.stat(primaryPath)
                if (stat.size > MAX_SESSION_FILE_SIZE_BYTES) {
                    await this.quarantineCorruptFile(
                        sessionDir,
                        accountId,
                        device,
                        primaryPath,
                        `Session file size (${stat.size} bytes) exceeds 10MB limit`
                    )
                    return {
                        status: 'corrupted',
                        reason: 'Session file size exceeds 10MB limit',
                        path: primaryPath
                    }
                }

                const rawContent = await fs.promises.readFile(primaryPath, 'utf-8')
                let parsed: any
                try {
                    parsed = JSON.parse(rawContent)
                } catch {
                    await this.quarantineCorruptFile(
                        sessionDir,
                        accountId,
                        device,
                        primaryPath,
                        'Session file is not valid JSON'
                    )
                    return {
                        status: 'corrupted',
                        reason: 'Session file is not valid JSON',
                        path: primaryPath
                    }
                }

                if (!parsed || typeof parsed !== 'object') {
                    await this.quarantineCorruptFile(
                        sessionDir,
                        accountId,
                        device,
                        primaryPath,
                        'Session root is not a valid JSON object'
                    )
                    return {
                        status: 'corrupted',
                        reason: 'Session root is not a valid JSON object',
                        path: primaryPath
                    }
                }

                // Check for modern envelope contract
                if (parsed.schemaVersion !== undefined) {
                    if (parsed.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
                        return {
                            status: 'unsupported-version',
                            schemaVersion: parsed.schemaVersion,
                            path: primaryPath
                        }
                    }

                    if (parsed.accountId !== accountId) {
                        return {
                            status: 'identity-mismatch',
                            expectedAccountId: accountId,
                            actualAccountId: String(parsed.accountId),
                            expectedDevice: device,
                            actualDevice: parsed.device,
                            path: primaryPath
                        }
                    }

                    if (parsed.device !== device) {
                        return {
                            status: 'identity-mismatch',
                            expectedAccountId: accountId,
                            actualAccountId: parsed.accountId,
                            expectedDevice: device,
                            actualDevice: parsed.device,
                            path: primaryPath
                        }
                    }

                    if (!isValidStorageState(parsed.storageState)) {
                        await this.quarantineCorruptFile(
                            sessionDir,
                            accountId,
                            device,
                            primaryPath,
                            'StorageState structure in envelope is invalid'
                        )
                        return {
                            status: 'corrupted',
                            reason: 'StorageState structure in envelope is invalid',
                            path: primaryPath
                        }
                    }

                    return {
                        status: 'loaded',
                        source: 'modern-envelope',
                        state: parsed.storageState,
                        savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : stat.mtimeMs,
                        path: primaryPath
                    }
                }

                // Previous raw storageState writer without envelope
                if (isValidStorageState(parsed)) {
                    return {
                        status: 'loaded',
                        source: 'previous-storage-state',
                        state: parsed,
                        savedAt: stat.mtimeMs,
                        path: primaryPath
                    }
                }

                // Neither valid envelope nor valid raw storageState
                await this.quarantineCorruptFile(
                    sessionDir,
                    accountId,
                    device,
                    primaryPath,
                    'File lacks valid schemaVersion and does not match raw storageState structure'
                )
                return {
                    status: 'corrupted',
                    reason: 'File lacks valid schemaVersion and does not match raw storageState structure',
                    path: primaryPath
                }
            } catch (err: any) {
                return {
                    status: 'io-error',
                    error: err.message || String(err),
                    path: primaryPath
                }
            }
        }

        // Tier 3: Check legacy cookie JSON (only if no modern file and no corruption marker)
        const email = options?.legacyEmail || scope.accountKey
        if (email && typeof email === 'string') {
            try {
                const legacyPath = SessionPathResolver.getLegacyPath(sessionDir, email, device)
                if (fs.existsSync(legacyPath)) {
                    const legacyStat = await fs.promises.stat(legacyPath)
                    const legacyRaw = await fs.promises.readFile(legacyPath, 'utf-8')
                    const parsedCookies = JSON.parse(legacyRaw)
                    const cookies = Array.isArray(parsedCookies)
                        ? parsedCookies
                        : Array.isArray(parsedCookies?.cookies)
                          ? parsedCookies.cookies
                          : null

                    if (cookies) {
                        const legacyState: PlaywrightStorageState = {
                            cookies,
                            origins: []
                        }
                        return {
                            status: 'loaded',
                            source: 'legacy-cookie-json',
                            state: legacyState,
                            savedAt: legacyStat.mtimeMs,
                            path: legacyPath
                        }
                    }
                }
            } catch {
                // If legacy read fails or escapes containment, fall through to missing
            }
        }

        // Tier 4: All candidate sources absent
        return {
            status: 'missing',
            path: primaryPath
        }
    }

    private static readonly LOCK_TTL_MS = 30000

    private static isPidAlive(pid: number): boolean {
        if (!pid || pid <= 0) return false
        try {
            process.kill(pid, 0)
            return true
        } catch (err: any) {
            return err?.code === 'EPERM'
        }
    }

    private static async acquireCrossProcessLock(
        lockfilePath: string,
        accountId: string,
        device: SessionDevice,
        deadlineMs = 2500
    ): Promise<boolean> {
        const deadline = Date.now() + deadlineMs
        const delays = [30, 60, 120, 250, 500]
        let attempt = 0

        while (Date.now() < deadline) {
            try {
                const handle = await fs.promises.open(lockfilePath, 'wx')
                const metadata = {
                    pid: process.pid,
                    accountId,
                    device,
                    acquiredAt: Date.now()
                }
                await handle.writeFile(JSON.stringify(metadata, null, 2), 'utf-8')
                await handle.sync()
                await handle.close()
                return true
            } catch (err: any) {
                if (err?.code !== 'EEXIST') {
                    return false
                }

                // Inspect existing lock
                try {
                    const raw = await fs.promises.readFile(lockfilePath, 'utf-8')
                    const existing = JSON.parse(raw)
                    const isAlive = typeof existing?.pid === 'number' ? this.isPidAlive(existing.pid) : false
                    const isExpired = Date.now() - (existing?.acquiredAt || 0) > this.LOCK_TTL_MS

                    if (!isAlive || isExpired) {
                        // Break stale lock from dead PID or expired TTL
                        await fs.promises.unlink(lockfilePath).catch(() => {})
                        continue
                    }
                } catch {
                    // Lockfile unparseable or transient, retry
                }

                const delay = delays[attempt % delays.length] ?? 100
                attempt++
                await new Promise(res => setTimeout(res, delay))
            }
        }
        return false
    }

    private static async releaseCrossProcessLock(lockfilePath: string): Promise<void> {
        try {
            if (fs.existsSync(lockfilePath)) {
                const raw = await fs.promises.readFile(lockfilePath, 'utf-8')
                const existing = JSON.parse(raw)
                if (existing?.pid === process.pid) {
                    await fs.promises.unlink(lockfilePath).catch(() => {})
                }
            }
        } catch {
            await fs.promises.unlink(lockfilePath).catch(() => {})
        }
    }

    /**
     * Executes action within serialized in-process mutex queue AND cross-process file lock.
     * Guarantees queue self-healing even on action failure.
     */
    public static async withTargetLock<T>(
        targetPath: string,
        accountId: string,
        device: SessionDevice,
        action: () => Promise<T>
    ): Promise<T | SessionSaveResult> {
        const currentLock = this.fileLocks.get(targetPath) || Promise.resolve()
        let releaseLock: () => void = () => {}
        const nextLock = new Promise<void>(resolve => {
            releaseLock = resolve
        })

        this.fileLocks.set(
            targetPath,
            currentLock.then(
                () => nextLock,
                () => nextLock
            )
        )

        await currentLock

        let lockfilePath: string | null = null
        let acquiredCrossProcess = false
        try {
            lockfilePath = SessionPathResolver.getLockfilePath(
                path.dirname(targetPath),
                accountId,
                device
            )

            acquiredCrossProcess = await this.acquireCrossProcessLock(
                lockfilePath,
                accountId,
                device
            )

            if (!acquiredCrossProcess) {
                return {
                    status: 'failed',
                    error: `Cross-process writer lock conflict on ${device} session (held by another process)`,
                    path: targetPath
                } as any
            }

            return await action()
        } finally {
            if (acquiredCrossProcess && lockfilePath) {
                await this.releaseCrossProcessLock(lockfilePath)
            }
            releaseLock()
            if (this.fileLocks.get(targetPath) === nextLock) {
                this.fileLocks.delete(targetPath)
            }
        }
    }

    /**
     * Extracts storageState from an active context and saves it atomically.
     * Enforces bounded execution, snapshot validation, and mutex serialization before snapshot.
     * Prevents snapshot inversion races and empty/synthetic overwriting on closed contexts.
     */
    public static async saveContextSession(
        context: any,
        scope: AccountScope,
        device: SessionDevice,
        timeoutMs: number = 3000
    ): Promise<SessionSaveResult> {
        if (!context || typeof context.storageState !== 'function') {
            return {
                status: 'skipped',
                reason: 'Context is null or does not support storageState'
            }
        }

        const sessionDir = scope.storagePaths.sessionDir
        const targetPath = SessionPathResolver.getModernPath(sessionDir, scope.identity.accountId, device)

        // Lock acquired BEFORE extracting snapshot to prevent snapshot inversion race
        const saveResult = (await this.withTargetLock(
            targetPath,
            scope.identity.accountId,
            device,
            async (): Promise<SessionSaveResult> => {
                const start = Date.now()
                let rawState: PlaywrightStorageState
                try {
                    rawState = await Promise.race([
                        context.storageState(),
                        new Promise<never>((_, reject) =>
                            setTimeout(() => reject(new Error('storageState extraction timed out')), timeoutMs)
                        )
                    ])
                } catch (err: any) {
                    const isTimeout = err?.message?.includes('timed out')
                    if (isTimeout) {
                        return {
                            status: 'timed-out',
                            durationMs: Date.now() - start,
                            path: targetPath
                        }
                    }
                    return {
                        status: 'failed',
                        error: `Failed to extract storageState from context: ${err?.message || err}`,
                        path: targetPath
                    }
                }

                if (!isValidStorageState(rawState)) {
                    return {
                        status: 'failed',
                        error: 'Extracted storage state failed structure validation',
                        path: targetPath
                    }
                }

                const snapshotTime = Date.now()

                // Monotonic sequence verification: prevent stale snapshot from overwriting newer disk session
                if (fs.existsSync(targetPath)) {
                    try {
                        const existingRaw = await fs.promises.readFile(targetPath, 'utf-8')
                        const existing = JSON.parse(existingRaw)
                        if (typeof existing.savedAt === 'number' && existing.savedAt > snapshotTime) {
                            return {
                                status: 'skipped',
                                reason: `Target session is newer (${existing.savedAt} > ${snapshotTime})`
                            }
                        }
                    } catch {}
                }

                const envelope: StoredSessionEnvelope = {
                    schemaVersion: SUPPORTED_SCHEMA_VERSION,
                    accountId: scope.identity.accountId,
                    device,
                    savedAt: snapshotTime,
                    storageState: rawState
                }

                return await this.executeAtomicFileWrite(targetPath, envelope)
            }
        )) as SessionSaveResult

        // If save succeeded, clear any existing quarantine marker for this account/device
        if (saveResult.status === 'saved') {
            const markerPath = SessionPathResolver.getQuarantineMarkerPath(
                sessionDir,
                scope.identity.accountId,
                device
            )
            try {
                if (fs.existsSync(markerPath)) {
                    await fs.promises.unlink(markerPath)
                }
            } catch {}
        }

        return saveResult
    }

    /**
     * Writes session envelope atomically to targetPath with Windows-safe replacement.
     */
    public static async saveEnvelopeAtomically(
        targetPath: string,
        envelope: StoredSessionEnvelope
    ): Promise<SessionSaveResult> {
        // Pre-validate payload before acquiring locks or writing
        if (
            !envelope ||
            envelope.schemaVersion !== SUPPORTED_SCHEMA_VERSION ||
            !envelope.accountId ||
            !envelope.device ||
            !isValidStorageState(envelope.storageState)
        ) {
            return {
                status: 'failed',
                error: 'Invalid session envelope schema',
                path: targetPath
            }
        }

        return (await this.withTargetLock(
            targetPath,
            envelope.accountId,
            envelope.device,
            () => this.executeAtomicFileWrite(targetPath, envelope)
        )) as SessionSaveResult
    }

    /**
     * Internal atomic file writer. Must be called while holding target locks.
     *
     * Guarantee Documentation:
     * - Atomic Visibility: The file replacement uses filesystem rename within the same directory volume.
     *   Concurrent readers will observe either the complete previous file or the complete new file,
     *   never an empty or partially written intermediate state.
     * - Power-Loss Durability: While fileHandle.sync() is executed prior to rename to flush file
     *   buffers, atomic visibility is distinct from power-loss durability. Power-loss resilience
     *   remains bounded by operating system write caching and underlying hardware journaling.
     */
    private static async executeAtomicFileWrite(
        targetPath: string,
        envelope: StoredSessionEnvelope
    ): Promise<SessionSaveResult> {
        const start = Date.now()

        // Validate payload before writing
        if (
            envelope.schemaVersion !== SUPPORTED_SCHEMA_VERSION ||
            !envelope.accountId ||
            !envelope.device ||
            !isValidStorageState(envelope.storageState)
        ) {
            return {
                status: 'failed',
                error: 'Invalid session envelope schema',
                path: targetPath
            }
        }

        const serialized = JSON.stringify(envelope, null, 2)
        if (Buffer.byteLength(serialized, 'utf-8') > MAX_SESSION_FILE_SIZE_BYTES) {
            return {
                status: 'failed',
                error: 'Session payload exceeds 10MB limit',
                path: targetPath
            }
        }

        try {
            const targetDir = path.dirname(targetPath)
            if (!fs.existsSync(targetDir)) {
                await fs.promises.mkdir(targetDir, { recursive: true })
            }

            // Create unique temp file with exclusive creation ('wx')
            const tempPath = `${targetPath}.tmp.${Date.now()}.${crypto.randomBytes(6).toString('hex')}`
            let handle: fs.promises.FileHandle | null = null
            try {
                handle = await fs.promises.open(tempPath, 'wx')
                await handle.writeFile(serialized, 'utf-8')
                await handle.sync()
            } finally {
                if (handle) {
                    await handle.close().catch(() => {})
                }
            }

            // Atomic rename with Windows sharing violation (EBUSY / EPERM) backoff retry
            let renamed = false
            let lastError: any = null
            const delays = [50, 100, 200, 400, 800]
            const deadline = Date.now() + 2000

            for (let attempt = 0; attempt <= delays.length; attempt++) {
                try {
                    await fs.promises.rename(tempPath, targetPath)
                    renamed = true
                    break
                } catch (err: any) {
                    lastError = err
                    const isSharingViolation = err?.code === 'EBUSY' || err?.code === 'EPERM'
                    const delay = delays[attempt]
                    if (
                        isSharingViolation &&
                        delay !== undefined &&
                        Date.now() + delay < deadline
                    ) {
                        await new Promise(res => setTimeout(res, delay))
                    } else {
                        break
                    }
                }
            }

            if (!renamed) {
                // If replacement failed, preserve original target file and delete ONLY this temp file
                await fs.promises.unlink(tempPath).catch(() => {})
                return {
                    status: 'failed',
                    error: `Atomic file replacement failed: ${lastError?.message || lastError}`,
                    path: targetPath
                }
            }

            return {
                status: 'saved',
                durationMs: Date.now() - start,
                path: targetPath
            }
        } catch (err: any) {
            return {
                status: 'failed',
                error: `Save operation encountered an error: ${err?.message || err}`,
                path: targetPath
            }
        }
    }

    /**
     * Isolates a corrupted session file into quarantine and records a persistent marker.
     * Durable Marker-First Flow:
     * 1. Write and fsync persistent marker FIRST.
     * 2. Copy corrupted file to quarantine backup.
     * 3. Only after marker is confirmed on disk, remove source from primary path.
     * If a crash or fault occurs at any point, marker prevents silent legacy fallback.
     */
    private static async quarantineCorruptFile(
        sessionDir: string,
        accountId: string,
        device: SessionDevice,
        sourcePath: string,
        reason: string
    ): Promise<void> {
        try {
            const quarantineDir = SessionPathResolver.getQuarantineDir(sessionDir)
            if (!fs.existsSync(quarantineDir)) {
                await fs.promises.mkdir(quarantineDir, { recursive: true })
            }

            const now = Date.now()
            const quarantinePath = SessionPathResolver.getQuarantinePath(
                sessionDir,
                accountId,
                device,
                now
            )
            const markerPath = SessionPathResolver.getQuarantineMarkerPath(
                sessionDir,
                accountId,
                device
            )

            // Step 1: Write and flush persistent marker to disk FIRST
            const markerData = {
                schemaVersion: SUPPORTED_SCHEMA_VERSION,
                accountId,
                device,
                corruptedAt: now,
                reason,
                quarantinedFile: quarantinePath
            }
            const markerTempPath = `${markerPath}.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`
            let markerHandle: fs.promises.FileHandle | null = null
            try {
                markerHandle = await fs.promises.open(markerTempPath, 'wx')
                await markerHandle.writeFile(JSON.stringify(markerData, null, 2), 'utf-8')
                await markerHandle.sync()
            } finally {
                if (markerHandle) {
                    await markerHandle.close().catch(() => {})
                }
            }
            await fs.promises.rename(markerTempPath, markerPath)

            // Step 2: Copy corrupt file to quarantine backup
            if (fs.existsSync(sourcePath)) {
                await fs.promises.copyFile(sourcePath, quarantinePath)
            }

            // Step 3: Remove corrupted file from primary path only after marker is durably stored
            if (fs.existsSync(sourcePath)) {
                await fs.promises.unlink(sourcePath).catch(() => {})
            }
        } catch (quarantineErr) {
            // If quarantine recording fails, preserve source in place so corruption is re-detected
        }
    }
}
